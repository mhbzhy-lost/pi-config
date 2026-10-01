import { createHash } from "node:crypto";
import { DurableStorage } from "./durable-storage.ts";

export type SupervisorRequestState = "pending" | "replying" | "replied" | "expired" | "failed";
export type SupervisorRequestV1 = {
  schemaVersion: "supervisor-request.v1"; requestId: string; runId: string; rootSessionId: string;
  ownerGeneration: number; requestGeneration: number; requestDigest: string;
  createdAt: number; expiresAt: number; state: SupervisorRequestState;
};
export type SupervisorControlIntentV1 = {
  schemaVersion: "supervisor-control-intent.v1"; intentId: string; runId: string;
  rootSessionId: string; ownerGeneration: number; kind: "reply" | "steer"; payloadDigest: string;
  requestId?: string; requestGeneration?: number; liveRunEpoch?: number;
};
export type SupervisorDeliveryReceipt = {
  receiptId: string; idempotencyKey: string; kind: "reply" | "steer"; status: "queued" | "delivered" | "failed"; consumed: boolean;
  runId: string; requestId?: string; code?: string; rootSessionId?: string; ownerGeneration?: number; requestGeneration?: number;
};

// A non-workspace run has no broker owner generation; only Host session authority can fence its requests.
const UNOWNED_OWNER_GENERATION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const safeId = (v: unknown, name: string) => { if (typeof v !== "string" || !ID.test(v) || v.includes("..")) throw new Error(`${name} invalid`); return v; };
const positive = (v: unknown, name: string) => { if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${name} invalid`); return v as number; };
const digestRef = (v: unknown, name: string) => { if (typeof v !== "string" || !DIGEST.test(v)) throw new Error(`${name} invalid`); return v; };
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
export function supervisorCanonicalDigest(value: unknown): string { return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`; }
function exact(o: Record<string, any>, keys: string[], name: string) { if (Object.keys(o).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(o, k))) throw new Error(`${name} fields invalid`); }

export function parseSupervisorRequestV1(value: unknown): SupervisorRequestV1 {
  if (!isObject(value)) throw new Error("request must be object");
  exact(value, ["schemaVersion","requestId","runId","rootSessionId","ownerGeneration","requestGeneration","requestDigest","createdAt","expiresAt","state"], "request");
  if (value.schemaVersion !== "supervisor-request.v1") throw new Error("request schema unsupported");
  safeId(value.requestId,"requestId"); safeId(value.runId,"runId"); safeId(value.rootSessionId,"rootSessionId");
  positive(value.ownerGeneration,"ownerGeneration"); positive(value.requestGeneration,"requestGeneration"); digestRef(value.requestDigest,"requestDigest");
  if (!["pending","replying","replied","expired","failed"].includes(value.state) || typeof value.createdAt !== "number" || typeof value.expiresAt !== "number" || value.expiresAt < value.createdAt) throw new Error("request timing/state invalid");
  return value as SupervisorRequestV1;
}
export function parseSupervisorControlIntentV1(value: unknown): SupervisorControlIntentV1 {
  if (!isObject(value)) throw new Error("intent must be object");
  const keys = ["schemaVersion","intentId","runId","rootSessionId","ownerGeneration","kind","payloadDigest","requestId","requestGeneration","liveRunEpoch"];
  if (Object.keys(value).some(k => !keys.includes(k))) throw new Error("intent fields invalid");
  if (value.schemaVersion !== "supervisor-control-intent.v1" || !["reply","steer"].includes(value.kind)) throw new Error("intent invalid");
  safeId(value.intentId,"intentId"); safeId(value.runId,"runId"); safeId(value.rootSessionId,"rootSessionId"); positive(value.ownerGeneration,"ownerGeneration"); digestRef(value.payloadDigest,"payloadDigest");
  if (value.kind === "reply") { safeId(value.requestId,"requestId"); positive(value.requestGeneration,"requestGeneration"); }
  if (value.liveRunEpoch !== undefined) positive(value.liveRunEpoch,"liveRunEpoch");
  return value as SupervisorControlIntentV1;
}

export type SupervisorOwnerState = "owned" | "unowned" | "unavailable";
export type SupervisorRunIdentity = {
  owner: unknown;
  ownerState: SupervisorOwnerState;
  runtime: { runId?: string; ownerGeneration?: number; liveRunEpoch?: number; running?: boolean; steerable?: boolean } | undefined;
};

export type SupervisorControlPlaneOptions = {
  readOwnerReceipt?: (runId: string) => unknown | Promise<unknown>;
  readRuntime?: (runId: string) => { runId?: string; ownerGeneration?: number; liveRunEpoch?: number; running?: boolean; steerable?: boolean } | Promise<any>;
  now?: () => number; randomId?: () => string; persistenceRoot?: string; diagnosticSink?: (entry: unknown) => void;
};
export function createSupervisorControlPlane(options: SupervisorControlPlaneOptions = {}) {
  const requests = new Map<string, SupervisorRequestV1>();
  const receipts = new Map<string, SupervisorDeliveryReceipt>();
  const replyPayloads = new Set<string>();
  const now = options.now ?? (() => Date.now());
  const id = options.randomId ?? (() => `${now()}-${Math.random().toString(36).slice(2)}`);
  const storage = options.persistenceRoot ? new DurableStorage({ root: options.persistenceRoot }) : undefined;
  const loadedRoots = new Set<string>();
  const corruptRoots = new Set<string>();
  const stateKey = (root: string) => `supervisor-${createHash("sha256").update(root).digest("hex")}`;
  const persistenceError = (root: string, error: unknown) => {
    corruptRoots.add(root);
    options.diagnosticSink?.({ type: "supervisor-persistence-corrupt", rootSessionId: root, code: (error as any)?.code ?? "SUPERVISOR_PERSISTENCE_CORRUPT" });
  };
  const stateDigest = (value: unknown) => supervisorCanonicalDigest(value);
  async function loadRoot(root: string): Promise<boolean> {
    if (!storage || loadedRoots.has(root)) return !corruptRoots.has(root);
    try {
      const saved: any = await storage.read(stateKey(root));
      const value: any = saved?.value ?? { schemaVersion: "supervisor-state.v1", rootSessionId: root, requests: [], receipts: [], replyPayloads: [], stateDigest: stateDigest({ schemaVersion: "supervisor-state.v1", rootSessionId: root, requests: [], receipts: [], replyPayloads: [] }) };
      if (!isObject(value) || value.schemaVersion !== "supervisor-state.v1" || value.rootSessionId !== root || !Array.isArray(value.requests) || !Array.isArray(value.receipts) || !Array.isArray(value.replyPayloads) || typeof value.stateDigest !== "string") throw new Error("state schema invalid");
      const { stateDigest: savedDigest, ...stateBody } = value;
      if (savedDigest !== stateDigest(stateBody)) throw new Error("state digest mismatch");
      for (const raw of value.requests) {
        const request = parseSupervisorRequestV1(raw);
        if (request.rootSessionId !== root) throw new Error("request root mismatch");
        if (request.state === "pending" && now() < request.expiresAt) requests.set(`${root}:${request.runId}:${request.ownerGeneration}:${request.requestId}:${request.requestDigest}`, request);
        else if (request.state === "pending") options.diagnosticSink?.({ type: "supervisor-persistence-rejected", rootSessionId: root, requestId: request.requestId, code: "SUPERVISOR_REQUEST_EXPIRED" });
      }
      for (const raw of value.receipts) {
        if (!isObject(raw) || Object.keys(raw).some(key => !["receiptId", "idempotencyKey", "kind", "status", "consumed", "runId", "requestId", "code", "rootSessionId", "ownerGeneration", "requestGeneration", "requestDigest"].includes(key)) || typeof raw.idempotencyKey !== "string" || typeof raw.receiptId !== "string" || raw.rootSessionId !== root || typeof raw.runId !== "string" || !Number.isSafeInteger(raw.ownerGeneration) || (raw.requestGeneration !== undefined && !Number.isSafeInteger(raw.requestGeneration)) || (raw.requestDigest !== undefined && !DIGEST.test(raw.requestDigest))) throw new Error("receipt schema invalid");
        receipts.set(raw.idempotencyKey, raw as SupervisorDeliveryReceipt);
      }
      for (const raw of value.replyPayloads) {
        if (typeof raw !== "string" || !raw.startsWith(`${root}:`) || !DIGEST.test(raw.slice(raw.lastIndexOf(":") + 1))) throw new Error("reply payload schema invalid");
        replyPayloads.add(raw);
      }
      loadedRoots.add(root);
      return true;
    } catch (error) { persistenceError(root, error); return false; }
  }
  async function saveRoot(root: string) {
    if (!storage || corruptRoots.has(root)) return;
    const stateBody = { schemaVersion: "supervisor-state.v1", rootSessionId: root,
      requests: [...requests.values()].filter(request => request.rootSessionId === root),
      receipts: [...receipts.values()].filter(receipt => receipt.rootSessionId === root),
      replyPayloads: [...replyPayloads].filter(payload => payload.startsWith(`${root}:`)) };
    const value = { ...stateBody, stateDigest: stateDigest(stateBody) };
    for (let attempt = 0; attempt < 8; attempt++) {
      const prior = await storage.read(stateKey(root));
      try { await storage.write(stateKey(root), value, prior?.revision ?? 0); return; }
      catch (error) { if ((error as any)?.code !== "DURABLE_REVISION_CONFLICT") throw error; }
    }
    throw new Error("SUPERVISOR_PERSISTENCE_CONFLICT");
  }
  const blocked = (code: string, extra: Record<string, unknown> = {}) => ({ status: "blocked" as const, code, ...extra });
  // owner 读取三态：依赖缺失或抛异常一律 unavailable（无法证明非受管），
  // 只有成功查询且确认无 receipt 才是 unowned。“读不到”绝不等同于“不受管”。
  async function readOwnerState(runId: string): Promise<{ state: SupervisorOwnerState; receipt: any }> {
    if (typeof options.readOwnerReceipt !== "function") return { state: "unavailable", receipt: undefined };
    try {
      const receipt = await options.readOwnerReceipt(runId);
      return receipt ? { state: "owned", receipt } : { state: "unowned", receipt: undefined };
    } catch (error) {
      // broker 对「无当前 owner receipt」的权威回答是抛 code=unknown_run
      // （root-broker-server.ts readOwnerReceipt / authority-store.ts read），
      // 这是唯一可用来「确认非受管」的信号；其余任何失败（存储不可用、锁竞争、
      // CAS 冲突、revoked、布局不支持、无 code 的未知错误）均为「无法确认」，
      // 必须 fail-closed，绝不得当成非受管而放行。
      if ((error as any)?.code === "unknown_run") return { state: "unowned", receipt: undefined };
      return { state: "unavailable", receipt: undefined };
    }
  }
  async function registerSupervisorRequest(native: any, hostRootSessionId?: string) {
    if (!isObject(native) || typeof native.id !== "string" || typeof native.runId !== "string" || typeof native.reason !== "string") return blocked("SUPERVISOR_REQUEST_IDENTITY_UNAVAILABLE");
    const { state, receipt } = await readOwnerState(native.runId);
    if (state === "unavailable") return blocked("SUPERVISOR_OWNER_UNAVAILABLE");
    const owner: any = state === "owned" ? receipt : { runId: native.runId, rootSessionId: hostRootSessionId, ownerGeneration: UNOWNED_OWNER_GENERATION };
    if (!owner || owner.runId !== native.runId || typeof owner.rootSessionId !== "string" || !Number.isSafeInteger(owner.ownerGeneration)) return blocked("SUPERVISOR_OWNER_UNAVAILABLE");
    if (!(await loadRoot(owner.rootSessionId))) return blocked("SUPERVISOR_PERSISTENCE_CORRUPT");
    const requestId = native.id; const requestDigest = supervisorCanonicalDigest({ id: native.id, runId: native.runId, agent: native.agent, reason: native.reason, expectsReply: native.expectsReply, replyTo: native.replyTo });
    const key = `${owner.rootSessionId}:${native.runId}:${owner.ownerGeneration}:${requestId}:${requestDigest}`;
    const existing = requests.get(key); if (existing) return { status: "registered" as const, request: existing };
    const t = now();
    const request = parseSupervisorRequestV1({ schemaVersion: "supervisor-request.v1", requestId, runId: native.runId, rootSessionId: owner.rootSessionId, ownerGeneration: owner.ownerGeneration, requestGeneration: Number.isSafeInteger(native.requestGeneration) ? native.requestGeneration : 1, requestDigest, createdAt: t, expiresAt: t + 20 * 60 * 1000, state: "pending" });
    requests.set(key, request); await saveRoot(owner.rootSessionId); return { status: "registered" as const, request };
  }
  function findPending(intent: SupervisorControlIntentV1) { return [...requests.values()].find(r => r.state === "pending" && r.runId === intent.runId && r.rootSessionId === intent.rootSessionId && r.ownerGeneration === intent.ownerGeneration && r.requestId === intent.requestId && r.requestGeneration === intent.requestGeneration); }
  async function resolveSupervisorControl(intentInput: unknown, hostRootSessionId?: string) {
    let intent: SupervisorControlIntentV1; try { intent = parseSupervisorControlIntentV1(intentInput); } catch { return blocked("SUPERVISOR_INTENT_INVALID"); }
    if (!(await loadRoot(intent.rootSessionId))) return blocked("SUPERVISOR_PERSISTENCE_CORRUPT");
    const runtime: any = await options.readRuntime?.(intent.runId);
    const { state, receipt: owner } = await readOwnerState(intent.runId);
    if (state === "owned") {
      if (!owner || owner.rootSessionId !== intent.rootSessionId || owner.ownerGeneration !== intent.ownerGeneration || runtime?.ownerGeneration !== intent.ownerGeneration) return blocked("SUPERVISOR_STALE_OWNER");
    } else if (state !== "unowned" || typeof hostRootSessionId !== "string" || hostRootSessionId !== intent.rootSessionId || intent.ownerGeneration !== UNOWNED_OWNER_GENERATION) return blocked("SUPERVISOR_STALE_OWNER");
    const pending = intent.kind === "steer"
      ? [...requests.values()].find(r => r.state === "pending" && r.runId === intent.runId && r.rootSessionId === intent.rootSessionId && r.ownerGeneration === intent.ownerGeneration)
      : findPending(intent);
    const key = intent.kind === "reply" ? `${intent.requestId}:${intent.requestGeneration}:${intent.payloadDigest}` : `${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}:${intent.liveRunEpoch}`;
    const prior = receipts.get(key); if (prior) return { status: "idempotent" as const, receipt: prior };
    if (pending && intent.kind === "steer") return blocked("SUPERVISOR_REPLY_REQUIRED");
    if (!pending && intent.kind === "reply") return blocked("SUPERVISOR_REQUEST_NOT_PENDING");
    if (pending && now() >= pending.expiresAt) { pending.state = "expired"; return blocked("SUPERVISOR_REQUEST_EXPIRED"); }
    if (intent.kind === "steer" && (!runtime?.running || runtime?.steerable !== true || (intent.liveRunEpoch !== undefined && runtime.liveRunEpoch !== intent.liveRunEpoch))) return blocked("SUPERVISOR_STEER_NOT_ALLOWED");
    if (intent.kind === "steer" && replyPayloads.has(`${intent.rootSessionId}:${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}`)) return blocked("STEER_DUPLICATES_REPLY");
    return { status: "allowed" as const, intent, idempotencyKey: key, request: pending };
  }
  async function commitDelivery(input: { intent: unknown; success?: boolean; code?: string; consumed?: boolean }, hostRootSessionId?: string) {
    const intent = parseSupervisorControlIntentV1(input.intent); const decision: any = await resolveSupervisorControl(intent, hostRootSessionId);
    if (decision.status === "idempotent") {
      // A queued follow-up is not terminally delivered yet. The child may
      // later consume the same correlated payload, so allow that observation
      // to advance the existing durable receipt exactly once.
      if (input.consumed === true && decision.receipt.status === "queued") {
        decision.receipt.status = "delivered";
        decision.receipt.consumed = true;
        const request = intent.kind === "reply" ? findPending(intent) : undefined;
        if (request) request.state = "replied";
        if (intent.kind === "reply") replyPayloads.add(`${intent.rootSessionId}:${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}`);
        await saveRoot(intent.rootSessionId);
        return { status: "committed" as const, receipt: decision.receipt };
      }
      return decision;
    }
    if (decision.status !== "allowed") return decision;
    const consumed = input.consumed === true;
    const receipt: SupervisorDeliveryReceipt = { receiptId: `receipt-${id()}`, idempotencyKey: decision.idempotencyKey, kind: intent.kind, status: input.success === false ? "failed" : consumed ? "delivered" : "queued", consumed, runId: intent.runId, rootSessionId: intent.rootSessionId, ownerGeneration: intent.ownerGeneration, ...(intent.requestGeneration ? { requestGeneration: intent.requestGeneration } : {}), ...(intent.requestId ? { requestId: intent.requestId } : {}), ...(input.code ? { code: input.code } : {}) };
    receipts.set(decision.idempotencyKey, receipt);
    if (intent.kind === "reply" && decision.request) {
      decision.request.state = receipt.status === "delivered" ? "replied" : receipt.status === "failed" ? "failed" : "pending";
      if (receipt.status === "delivered") replyPayloads.add(`${intent.rootSessionId}:${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}`);
    }
    await saveRoot(intent.rootSessionId);
    return { status: "committed" as const, receipt };
  }
  async function markDeliveryConsumed(intent: unknown, hostRootSessionId?: string) {
    return commitDelivery({ intent, consumed: true }, hostRootSessionId);
  }
  return Object.freeze({ registerSupervisorRequest, resolveSupervisorControl, commitDelivery, markDeliveryConsumed,
    ready: async (rootSessionId: string) => loadRoot(rootSessionId),
    findRequestAsync: async (requestId: string, rootSessionId?: string) => { if (storage && typeof rootSessionId !== "string") return undefined; if (rootSessionId && !(await loadRoot(rootSessionId))) return undefined; return [...requests.values()].find(r => r.requestId === requestId && (!rootSessionId || r.rootSessionId === rootSessionId)); },
    identityForRun: async (runId: string): Promise<SupervisorRunIdentity> => {
      const { state, receipt } = await readOwnerState(runId);
      let runtime: SupervisorRunIdentity["runtime"];
      try { runtime = await options.readRuntime?.(runId); } catch { runtime = undefined; }
      return { owner: receipt, ownerState: state, runtime };
    },
    listPending: () => [...requests.values()].filter(r => r.state === "pending"), findRequest: (requestId: string) => [...requests.values()].find(r => r.requestId === requestId), markProgressStalled: (runId: string) => ({ status: "stalled-suspected", runId }), snapshot: () => ({ requests: [...requests.values()] }) });
}
