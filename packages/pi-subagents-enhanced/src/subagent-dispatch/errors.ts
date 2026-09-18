declare global {
  interface Error {
    code?: string;
    detail?: unknown;
    keypath?: string;
  }
}

export class CodingDispatchContractError extends Error {
  code: string;
  detail: string;
  keypath?: string;
  constructor(code, message, detail = message, keypath?: string) {
    super(message);
    this.name = "CodingDispatchContractError";
    this.code = code;
    this.detail = String(detail);
    if (keypath !== undefined) this.keypath = String(keypath);
  }
}


export const SUBAGENT_RPC_STAGES = Object.freeze([
  "preallocate", "rpc-ping", "workflow-spawn", "child-binding", "bind-run",
]);

const RPC_DIAGNOSTIC_FIELDS = new Set([
  "taskId", "toolCallId", "stage", "rpcOperation", "causeCode", "causeMessage",
]);

function safeCauseMessage(value) {
  const text = typeof value === "string" ? value : "typed subagent RPC failed";
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(prompt|session|token|credential|authorization|capability|password|secret|api[_-]?key)\s*[:=][^,; ]*/gi, "$1=[redacted]")
    .replace(/(?:^|\s)(?:\/|[A-Za-z]:\\)[^\s,;]*/g, " [path-redacted]")
    .slice(0, 500);
}

export function sanitizeErrorRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => RPC_DIAGNOSTIC_FIELDS.has(key))
    .map(([key, value]) => [key, key === "causeMessage" ? safeCauseMessage(value) : value]));
}

export function createSubagentRpcFailureDetails({ taskId, toolCallId, stage, rpcOperation, error }) {
  return sanitizeErrorRecord({
    taskId,
    toolCallId,
    stage: SUBAGENT_RPC_STAGES.includes(stage) ? stage : "workflow-spawn",
    rpcOperation,
    causeCode: typeof error?.code === "string" ? error.code : "unknown",
    causeMessage: error instanceof Error ? error.message : String(error ?? "typed subagent RPC failed"),
  });
}
