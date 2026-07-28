export const ATTENTION_KINDS = new Set(["need_decision", "interview_request", "progress_update"]);

function requireText(input, field) {
  if (typeof input?.[field] !== "string" || !input[field].trim() || /[\r\n]/.test(input[field]) && field !== "message") {
    throw new Error(`invalid ${field}`);
  }
}

export function createAttentionRequest(input) {
  if (!ATTENTION_KINDS.has(input?.kind)) throw new Error(`invalid attention kind: ${input?.kind}`);
  for (const field of ["requestId", "planId", "taskId", "attemptId", "runId", "createdAt"]) requireText(input, field);
  if (typeof input.message !== "string" || !input.message.trim()) throw new Error("invalid attention message");
  if (Buffer.byteLength(input.message, "utf8") > 64 * 1024) throw new Error("attention message exceeds 64 KiB");
  if (!Number.isInteger(input.projectionVersion) || input.projectionVersion < 1) throw new Error("invalid projectionVersion");
  return Object.freeze({
    requestId: input.requestId,
    planId: input.planId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    runId: input.runId,
    kind: input.kind,
    blocking: input.kind !== "progress_update",
    message: input.message,
    projectionVersion: input.projectionVersion,
    createdAt: input.createdAt,
  });
}
