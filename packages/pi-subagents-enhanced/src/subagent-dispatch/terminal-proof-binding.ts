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
  /** 跨 owner scope 复查：读取所有 scope 下绑定到该 run 的 workspace。
   * 用于区分「run 真没有 workspace」与「workspace 挂在别的 owner scope 下」。 */
  readCrossScope?: () => unknown[];
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
  if (owned.length === 0) {
    // scoped 查询为空有两种可能：(A) run 真的没有 managed workspace；(B) workspace
    // 挂在别的 owner scope 下、被 scope 过滤挡住。跨 scope 复查区分二者：命中即
    // 未解析的可信绑定，fail-closed 记债暴露，绝不静默吞没。
    // 见 docs/bugs/2026-09-30-terminal-proof-cross-owner-binding-silent.md。
    let crossScope: unknown = [];
    try { crossScope = deps.readCrossScope?.() ?? []; } catch { crossScope = []; }
    if (validBindings(crossScope) && crossScope.length > 0) return debt(deps);
    return { state: "not-applicable" as const, reason: "run owns no managed workspace" };
  }
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
