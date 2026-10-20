import { isPreparedWorkspaceDisposition, type PreparedWorkspaceDispositionV1 } from "./disposition-contract.ts";

/** 跨 workspace 与 queue ledger 的分阶段结算；每个副作用都可用原准备记录重放。 */
export function createWorkspaceDispositionSettlement({ workspaceService, integrationQueue, fault }: { workspaceService: any; integrationQueue: any; fault?: (event: any) => void }) {
  function inputFor(prepared: PreparedWorkspaceDispositionV1) {
    return { workspaceId: prepared.binding.workspaceId, ownerScope: { kind: "standalone-subagent", rootSessionId: prepared.binding.rootSessionId }, settlementId: prepared.settlementId };
  }
  function checkpoint(prepared: PreparedWorkspaceDispositionV1, phase: string) {
    fault?.({ operation: "settlement", phase, workspaceId: prepared.binding.workspaceId, queueItemId: prepared.binding.queueItemId ?? undefined });
  }
  function settlePrepared(candidate: PreparedWorkspaceDispositionV1) {
    if (!isPreparedWorkspaceDisposition(candidate)) throw new Error("invalid disposition preparation");
    // service 再验 durable prepare 与真实 binding；传入对象本身不构成授权。
    const input = inputFor(candidate);
    const prepared = workspaceService.readPreparedDisposition(input);
    for (const key of ["operation", "binding", "executorHead", "authorizedRevision", "proofHash", "snapshotHash", "reason"]) {
      if (JSON.stringify(prepared[key]) !== JSON.stringify(candidate[key])) throw new Error("settlement preparation identity changed");
    }
    const intent = integrationQueue.recordDispositionIntent(prepared);
    if (intent.phase === "settled") {
      return workspaceService.markDispositionSettled({ ...input, queueReceiptRef: intent.queueReceiptRef });
    }
    checkpoint(prepared, "after-coordinator-intent");
    integrationQueue.verifyDispositionBinding(prepared);
    const result = workspaceService.applyPreparedDisposition(input);
    integrationQueue.advanceDispositionIntent(prepared.settlementId, "workspace-committed");
    const queueReceipt = integrationQueue.settleDispositionQueue(prepared);
    checkpoint(prepared, "after-queue-settlement");
    checkpoint(prepared, "before-settlement-receipt");
    integrationQueue.advanceDispositionIntent(prepared.settlementId, "queue-committed");
    checkpoint(prepared, "after-settlement-receipt");
    const settled = workspaceService.markDispositionSettled({ ...input, queueReceiptRef: queueReceipt.receiptRef });
    integrationQueue.advanceDispositionIntent(prepared.settlementId, "settled");
    return settled ?? result;
  }
  function replay() {
    const byId = new Map<string, PreparedWorkspaceDispositionV1>();
    for (const intent of integrationQueue.listDispositionIntents()) if (intent.phase !== "settled") byId.set(intent.prepared.settlementId, intent.prepared);
    // workspace prepare 已 durable 而 coordinator 尚未写 intent 的窗口也必须可发现。
    for (const prepared of workspaceService.listPreparedDispositions()) byId.set(prepared.settlementId, prepared);
    const results = [];
    for (const prepared of byId.values()) results.push(settlePrepared(prepared));
    return results;
  }
  return Object.freeze({ settlePrepared, replay });
}
