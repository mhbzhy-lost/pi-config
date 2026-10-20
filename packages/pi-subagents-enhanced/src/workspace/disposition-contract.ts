export const DISPOSITION_PREPARE_VERSION = "workspace-disposition-prepare.v1";
export type DispositionBinding = {
  workspaceId: string; leaseId: string; rootSessionId: string;
  runId: string | null; asyncDir: string | null; queueItemId: string | null;
  queueLeaseId: string | null; queueRevision: number | null; admissionGeneration: number | null;
};
export type PreparedWorkspaceDispositionV1 = {
  schemaVersion: typeof DISPOSITION_PREPARE_VERSION; settlementId: string;
  operation: "preserve" | "discard" | "release"; reason: string | null;
  binding: DispositionBinding; authorizedRevision: number; snapshotHash: string | null;
  proofHash: string | null; executorHead: string; phase: "prepared" | "effect-committed" | "settled";
  workspaceReceiptRef: string | null; queueReceiptRef: string | null;
};
const keys = ["schemaVersion", "settlementId", "operation", "reason", "binding", "authorizedRevision", "snapshotHash", "proofHash", "executorHead", "phase", "workspaceReceiptRef", "queueReceiptRef"];
const bindingKeys = ["workspaceId", "leaseId", "rootSessionId", "runId", "asyncDir", "queueItemId", "queueLeaseId", "queueRevision", "admissionGeneration"];
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const identity = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(v) && !v.includes("..");
const nonnegative = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const exact = (v: any, fields: string[]) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));

/** 严格子格式；不扩大既有 workspace ledger 顶层字段。 */
export function isPreparedWorkspaceDisposition(value: any): value is PreparedWorkspaceDispositionV1 {
  if (!exact(value, keys) || value.schemaVersion !== DISPOSITION_PREPARE_VERSION || !identity(value.settlementId)
      || !["preserve", "discard", "release"].includes(value.operation) || !nonnegative(value.authorizedRevision)
      || !(value.snapshotHash === null || digest(value.snapshotHash)) || !(value.proofHash === null || digest(value.proofHash))
      || typeof value.executorHead !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.executorHead)
      || !["prepared", "effect-committed", "settled"].includes(value.phase)
      || !(value.operation === "preserve" ? typeof value.reason === "string" && value.reason.trim().length > 0 : value.reason === null)
      || ![value.workspaceReceiptRef, value.queueReceiptRef].every(v => v === null || identity(v))) return false;
  const b = value.binding;
  if (!exact(b, bindingKeys) || ![b.workspaceId, b.leaseId, b.rootSessionId].every(identity)
      || !(b.runId === null || identity(b.runId)) || !(b.asyncDir === null || typeof b.asyncDir === "string" && b.asyncDir.startsWith("/") && !b.asyncDir.includes("\0"))
      || (b.runId === null) !== (b.asyncDir === null)
      || !(b.queueItemId === null || identity(b.queueItemId)) || !(b.queueLeaseId === null || identity(b.queueLeaseId))
      || !(b.queueRevision === null || nonnegative(b.queueRevision)) || !(b.admissionGeneration === null || nonnegative(b.admissionGeneration))) return false;
  if (b.queueItemId === null && [b.queueLeaseId, b.queueRevision, b.admissionGeneration].some(v => v !== null)) return false;
  if (b.queueItemId !== null && (b.runId === null || b.queueRevision === null || b.admissionGeneration === null)) return false;
  return value.phase === "prepared" ? value.workspaceReceiptRef === null && value.queueReceiptRef === null
    : value.workspaceReceiptRef !== null && (value.phase !== "settled" || value.queueReceiptRef !== null);
}

export function dispositionBindingMatches(record: any, prepared: PreparedWorkspaceDispositionV1): boolean {
  const b = prepared.binding;
  return record.workspaceId === b.workspaceId && record.leaseId === b.leaseId
    && record.request.owner.kind === "standalone-subagent" && record.request.owner.rootSessionId === b.rootSessionId
    && (record.run?.runId ?? null) === b.runId && (record.run?.asyncDir ?? null) === b.asyncDir
    && (prepared.operation === "preserve" || !record.run || (record.terminalProof?.state === "observed"
      && record.terminalProof.conflict === false && record.terminalProof.proofId === prepared.proofHash
      && record.terminalProof.runId === b.runId && record.terminalProof.asyncDir === b.asyncDir
      && record.terminalProof.rootSessionId === b.rootSessionId));
}
