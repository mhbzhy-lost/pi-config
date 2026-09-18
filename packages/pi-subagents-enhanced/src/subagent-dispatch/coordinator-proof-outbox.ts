import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type ProofDebt = { proofId: string; runId: string; reason: string; observedAt: number };
type ProofSupersession = { sourceProofId: string; sourceRunId: string; resumedRunId: string; resumeIntentId: string; supersededAt: string };
type State = { version: 1; pending: any[]; receipts: Record<string, any>; debts: Record<string, ProofDebt>; supersessions: Record<string, ProofSupersession> };

const empty = (): State => ({ version: 1, pending: [], receipts: {}, debts: {}, supersessions: {} });

// The Root Broker sink and the coordinator daemon can hold separate instances
// of the same durable file inside one process; serializing per file keeps a
// concurrent read-modify-write from dropping a pending proof or a debt.
const fileLocks = new Map<string, Promise<unknown>>();

function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  fileLocks.set(file, next.catch(() => undefined));
  return next;
}

function proofId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("terminal proof requires a SHA-256 proofId");
  return value;
}

function runIdentity(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("terminal proof debt requires a run identity");
  return value;
}

function debtReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("terminal proof debt requires a reason");
  return value.trim().slice(0, 512);
}

export function createCoordinatorProofOutbox(directory: string) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new TypeError("terminal proof outbox requires an absolute directory");
  const file = path.join(directory, "terminal-proofs.json");
  async function read(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value?.version !== 1 || !Array.isArray(value.pending) || !value.receipts || typeof value.receipts !== "object") {
        throw new Error("terminal proof outbox is invalid");
      }
      // Files written before proof debt or supersessions existed remain readable.
      return { ...value, debts: value.debts && typeof value.debts === "object" ? value.debts : {}, supersessions: value.supersessions && typeof value.supersessions === "object" ? value.supersessions : {} };
    } catch (error: any) {
      if (error?.code === "ENOENT") return empty();
      throw error;
    }
  }
  async function write(value: State) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }
  return Object.freeze({
    directory,
    async enqueue(proof: any) {
      const id = proofId(proof?.proofId);
      return serialized(file, async () => {
        const state = await read();
        if (state.receipts[id] !== undefined) return;
        // A proof superseded by a resumed run never re-enters the queue.
        if (state.supersessions[id] !== undefined) return;
        // A proof that became deliverable supersedes its earlier debt.
        delete state.debts[id];
        if (!state.pending.some((entry) => entry.proofId === id)) state.pending.push(structuredClone(proof));
        await write(state);
      });
    },
    /** Durable, observable record that an authoritative proof could not be bound. */
    async recordDebt(debt: { proofId: unknown; runId: unknown; reason: unknown; observedAt?: number }) {
      const id = proofId(debt?.proofId);
      return serialized(file, async () => {
        const state = await read();
        // A persisted receipt wins; debt never erases a delivered proof.
        if (state.receipts[id] !== undefined) return;
        // A superseded proof is not an unresolved binding: recovery rebind
        // already replaced the run that produced it.
        if (state.supersessions[id] !== undefined) return;
        state.pending = state.pending.filter((entry) => entry.proofId !== id);
        state.debts[id] = { proofId: id, runId: runIdentity(debt.runId), reason: debtReason(debt.reason), observedAt: Number.isSafeInteger(debt.observedAt) ? debt.observedAt! : Date.now() };
        await write(state);
      });
    },
    /** recovery resume 激活后旧 run 的 terminal proof 永久失效：移出 pending、不可重入队、不计 debt，但保留可审计状态。 */
    async supersede(supersession: { sourceProofId: unknown; sourceRunId: unknown; resumedRunId: unknown; resumeIntentId: unknown }) {
      const sourceProofId = proofId(supersession?.sourceProofId);
      const sourceRunId = runIdentity(supersession.sourceRunId);
      const resumedRunId = runIdentity(supersession.resumedRunId);
      const resumeIntentId = runIdentity(supersession.resumeIntentId);
      if (sourceRunId === resumedRunId) throw new TypeError("terminal proof supersession requires a different resumed run");
      return serialized(file, async () => {
        const state = await read();
        const existing = state.supersessions[sourceProofId];
        if (existing) {
          if (existing.sourceRunId !== sourceRunId || existing.resumedRunId !== resumedRunId || existing.resumeIntentId !== resumeIntentId) {
            throw new Error("terminal proof supersession identity mismatch");
          }
          return structuredClone(existing);
        }
        const record: ProofSupersession = { sourceProofId, sourceRunId, resumedRunId, resumeIntentId, supersededAt: new Date().toISOString() };
        // 同一 source run 的其余 pending 旧 proof 一并失效，避免 replay 永久重试。
        const siblings = state.pending.filter((entry) => entry.runId === sourceRunId);
        for (const sibling of siblings) state.supersessions[proofId(sibling.proofId)] = { ...record, sourceProofId: proofId(sibling.proofId) };
        state.supersessions[sourceProofId] = record;
        state.pending = state.pending.filter((entry) => entry.runId !== sourceRunId);
        await write(state);
        return structuredClone(record);
      });
    },
    async replay(deliver: (proof: any) => Promise<unknown>) {
      return serialized(file, async () => {
        const state = await read();
        const pending = [];
        let delivered = 0;
        for (const proof of state.pending) {
          try {
            const receipt = await deliver(structuredClone(proof));
            const id = proofId(proof.proofId);
            state.receipts[id] = structuredClone(receipt);
            delete state.debts[id];
            delivered += 1;
          } catch {
            pending.push(proof);
          }
        }
        state.pending = pending;
        await write(state);
        return { delivered, pending: pending.length };
      });
    },
    async receipt(id: string) {
      return structuredClone((await read()).receipts[proofId(id)]);
    },
    async debts() {
      return Object.values((await read()).debts).map((debt) => structuredClone(debt));
    },
    async supersessions() {
      return Object.values((await read()).supersessions).map((supersession) => structuredClone(supersession));
    },
    async status(id: string) {
      const state = await read();
      const key = proofId(id);
      if (state.receipts[key] !== undefined) return { state: "delivered" as const, receipt: structuredClone(state.receipts[key]) };
      if (state.supersessions[key] !== undefined) return { state: "superseded" as const, supersession: structuredClone(state.supersessions[key]) };
      if (state.debts[key] !== undefined) return { state: "debt" as const, debt: structuredClone(state.debts[key]) };
      if (state.pending.some((entry) => entry.proofId === key)) return { state: "pending" as const };
      return { state: "unknown" as const };
    },
  });
}
