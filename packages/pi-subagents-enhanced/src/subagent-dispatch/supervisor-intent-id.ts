import { createHash } from "node:crypto";

/** Host 调用身份作为不透明字符串，仅内部 intent 使用版本化作用域摘要。 */
export function createSupervisorIntentId(input: {
  hostToolCallId: string;
  kind: "reply" | "steer";
  rootSessionId: string;
  runId: string;
}): string {
  if (typeof input.hostToolCallId !== "string" || input.hostToolCallId.length === 0) {
    throw Object.assign(new Error("Host tool call identity is required"), { code: "SUPERVISOR_INTENT_INVALID" });
  }
  const body = JSON.stringify(["supervisor-intent-id.v1", input.kind, input.rootSessionId, input.runId, input.hostToolCallId]);
  return `svi1-${createHash("sha256").update(body).digest("hex")}`;
}
