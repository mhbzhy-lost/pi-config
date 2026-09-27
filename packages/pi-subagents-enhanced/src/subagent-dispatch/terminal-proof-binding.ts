export type TerminalProofBindingDeps = {
  client: {
    listOwned: (input: { runId: string }) => Promise<unknown>;
    recordTerminalProof: (input: { workspaceId: string; ownerScope: unknown; proof: unknown }) => Promise<unknown>;
  };
  proofOutbox: {
    recordDebt: (input: { proofId: string; runId: string; reason: string }) => Promise<unknown>;
    enqueue: (input: Record<string, unknown>) => Promise<unknown>;
  };
  readLedger: () => unknown[];
  run: { runId: string; pid: number; asyncDir: string };
  proof: { runnerProcessInstanceId?: unknown };
  proofId: string;
  proofOwnerScope: unknown;
  rootSessionId: string;
  buildTerminalProof: () => Record<string, unknown>;
};

const UNAVAILABLE = "trusted run binding is unavailable";

function validBindings(value: unknown): value is Array<{ workspaceId: string }> {
  return Array.isArray(value) && value.every((entry) =>
    entry && typeof entry === "object" && typeof entry.workspaceId === "string" && entry.workspaceId.length > 0);
}

async function debt(deps: TerminalProofBindingDeps) {
  await deps.proofOutbox.recordDebt({ proofId: deps.proofId, runId: deps.run.runId, reason: UNAVAILABLE });
  return { state: "debt" as const, reason: UNAVAILABLE };
}

export async function classifyTerminalProofBinding(deps: TerminalProofBindingDeps) {
  let owned: unknown;
  try {
    owned = await deps.client.listOwned({ runId: deps.run.runId });
  } catch {
    try { owned = deps.readLedger(); } catch { return debt(deps); }
  }
  if (!validBindings(owned)) return debt(deps);
  if (owned.length === 0) return { state: "not-applicable" as const, reason: "run owns no managed workspace" };
  if (owned.length !== 1) return debt(deps);
  const workspaceId = owned[0].workspaceId;
  const proof = deps.buildTerminalProof();
  await deps.proofOutbox.enqueue({ ...proof, workspaceId, ownerScope: deps.proofOwnerScope });
  try {
    const receipt = await deps.client.recordTerminalProof({ workspaceId, ownerScope: deps.proofOwnerScope, proof });
    return { state: "delivered" as const, receipt };
  } catch (error) {
    return { state: "pending" as const, reason: error instanceof Error && error.message ? error.message : String(error) };
  }
}
