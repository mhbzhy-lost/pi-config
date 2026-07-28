const ID = /^[A-Za-z0-9._-]{1,160}$/;

export class ExecutionProtocolError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ExecutionProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value) {
    throw new ExecutionProtocolError("INVALID_EXECUTION_REQUEST", `${field} must be a non-empty string`, field);
  }
  return value;
}

function requiredId(value, field) {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new ExecutionProtocolError("INVALID_EXECUTION_REQUEST", `${field} must match ^[A-Za-z0-9._-]{1,160}$`, field);
  }
  return value;
}

export function normalizeExecutionSpawn(input) {
  if (!input || typeof input !== "object") {
    throw new ExecutionProtocolError("INVALID_EXECUTION_REQUEST", "Execution spawn input must be an object");
  }
  const request = {
    dispatchId: requiredId(input.dispatchId, "dispatchId"),
    attemptId: requiredId(input.attemptId, "attemptId"),
    agent: requiredString(input.agent, "agent"),
    task: requiredString(input.task, "task"),
    cwd: requiredString(input.cwd, "cwd"),
    output: requiredString(input.output, "output"),
    timeoutMs: input.timeoutMs,
  };
  if (request.agent !== "executor") {
    throw new ExecutionProtocolError("INVALID_EXECUTION_REQUEST", "Only the executor agent may be dispatched", request.agent);
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new ExecutionProtocolError("INVALID_EXECUTION_REQUEST", "timeoutMs must be a positive safe integer", request.timeoutMs);
  }
  return Object.freeze(request);
}

export function executionSpawnRpcParams(request) {
  return Object.freeze({
    agent: request.agent,
    task: request.task,
    cwd: request.cwd,
    context: "fresh",
    worktree: false,
    async: true,
    clarify: false,
    output: request.output,
    outputMode: "file-only",
    acceptance: false,
    artifacts: true,
    timeoutMs: request.timeoutMs,
  });
}

export function normalizeExecutionTarget(input) {
  if (!input || typeof input !== "object") {
    throw new ExecutionProtocolError("INVALID_EXECUTION_TARGET", "Execution target must be an object");
  }
  return Object.freeze({
    runId: requiredId(input.runId, "runId"),
    asyncDir: requiredString(input.asyncDir, "asyncDir"),
  });
}
