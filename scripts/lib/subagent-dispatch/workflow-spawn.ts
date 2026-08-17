const WORKFLOW_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STARTED_EVENT = "subagent:async-started";
const COMPLETE_EVENT = "subagent:async-complete";
const DEFAULT_CHILD_START_TIMEOUT_MS = 120_000;

export class WorkflowSpawnError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowSpawnError";
    this.code = code;
  }
}

export function childStartTimeoutMs(override, executionTimeoutMs) {
  if (override !== undefined && (!Number.isSafeInteger(override) || override <= 0)) {
    throw new TypeError("workflow child start timeout override must be a positive safe integer");
  }
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs <= 0) {
    throw new TypeError("workflow child start execution timeout must be a positive safe integer");
  }
  return override ?? Math.min(executionTimeoutMs, DEFAULT_CHILD_START_TIMEOUT_MS);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function workflowKey(value) {
  if (typeof value !== "string" || !WORKFLOW_KEY.test(value)) {
    throw new TypeError("workflow key must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
  }
  return value;
}

function checkedAcceptance(value) {
  if (!record(value) || !Array.isArray(value.criteria) || !Array.isArray(value.evidence)) {
    throw new TypeError("workflow checked acceptance requires criteria and evidence arrays");
  }
  return {
    level: "checked",
    criteria: [...value.criteria],
    evidence: [...value.evidence],
  };
}

function childControls(value) {
  if (value === undefined) return {};
  if (!record(value)) throw new TypeError("workflow child controls must be an object");
  const controls = {};
  for (const key of ["model", "output", "outputMode", "outputSchema", "skill", "reads", "progress", "acceptance"]) {
    if (value[key] !== undefined) controls[key] = value[key];
  }
  return controls;
}

export function buildWorkflowSpawn({
  workflowKey: key,
  agent,
  task,
  cwd,
  context,
  timeoutMs,
  artifacts = true,
  acceptance,
  child,
} = {}) {
  const normalizedKey = workflowKey(key);
  if (!nonempty(agent) || !nonempty(task) || !nonempty(cwd)) {
    throw new TypeError("workflow spawn requires non-empty agent, task, and cwd");
  }
  if (context !== "fresh" && context !== "fork") throw new TypeError("workflow spawn context must be fresh or fork");
  if (typeof artifacts !== "boolean") throw new TypeError("workflow spawn artifacts must be a boolean");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError("workflow spawn timeoutMs must be a positive safe integer");
  }

  const leaf = {
    agent,
    task,
    async: true,
    worktree: false,
    ...(child === undefined ? { output: false } : childControls(child)),
    ...(acceptance === undefined ? {} : { acceptance: checkedAcceptance(acceptance) }),
  };
  return {
    workflowScript: `return await runs.run(${JSON.stringify(normalizedKey)}, ${JSON.stringify(leaf)});`,
    cwd,
    context,
    async: true,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    artifacts,
    worktree: false,
    mission: false,
    chatProgress: "off",
  };
}

function childBinding(event) {
  const id = event?.runId ?? event?.id;
  if (!nonempty(id) || (event?.runId !== undefined && event?.id !== undefined && event.runId !== event.id)) {
    throw new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow child start event has an invalid runId");
  }
  if (!nonempty(event?.asyncDir) || !Number.isSafeInteger(event?.pid) || event.pid <= 0 || !nonempty(event?.sessionId) || !nonempty(event?.agent)) {
    throw new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow child start event is missing validated identity");
  }
  return { runId: id, asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid, agent: event.agent };
}

function rootCompletion(event) {
  const runId = event?.runId ?? event?.id;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  const state = typeof event?.state === "string" && event.state.trim() ? event.state.trim() : undefined;
  const error = typeof event?.error === "string" && event.error.trim() ? event.error.trim() : undefined;
  return { runId, state, error };
}

function rootFinishedError(completion) {
  return new WorkflowSpawnError(
    "WORKFLOW_CHILD_START_FAILED",
    `workflow root ${completion.runId} ${completion.state ?? "completed"} before child start${completion.error ? `: ${completion.error}` : ""}`,
  );
}

export function createWorkflowChildStartCollector(events, {
  workflowKey: expectedKey,
  agent: expectedAgent,
  sessionId: expectedSessionId,
  timeoutMs,
  onBinding,
} = {}) {
  workflowKey(expectedKey);
  if (!events || typeof events.on !== "function") throw new TypeError("workflow child collector requires an event bus");
  if (!nonempty(expectedAgent) || !nonempty(expectedSessionId)) {
    throw new TypeError("workflow child collector requires agent and session identity");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("workflow child collector timeoutMs must be a positive safe integer");
  }
  if (onBinding !== undefined && typeof onBinding !== "function") throw new TypeError("workflow child collector binding hook must be a function");

  let rootRunId;
  let candidate;
  let terminalError;
  let resolveWaiting;
  let rejectWaiting;
  let timer;
  let drainingBuffered = false;
  let unsubscribe = () => {};
  let unsubscribeComplete = () => {};

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const dispose = unsubscribe;
    const disposeComplete = unsubscribeComplete;
    unsubscribe = () => {};
    unsubscribeComplete = () => {};
    dispose();
    disposeComplete();
  };
  const fail = (error) => {
    if (terminalError || candidate?.resolved) return;
    terminalError = error;
    stop();
    rejectWaiting?.(error);
    rejectWaiting = undefined;
    resolveWaiting = undefined;
  };
  const succeed = (binding) => {
    if (terminalError || candidate?.resolved) return;
    try { onBinding?.({ runId: binding.runId, asyncDir: binding.asyncDir, sessionId: binding.sessionId, pid: binding.pid, agent: binding.agent }); } catch (error) { fail(error); return; }
    candidate = { ...binding, resolved: true };
    stop();
    resolveWaiting?.({ runId: binding.runId, asyncDir: binding.asyncDir });
    rejectWaiting = undefined;
    resolveWaiting = undefined;
  };
  const accept = (event) => {
    if (!rootRunId || terminalError || candidate?.resolved) return;
    if (event?.parentWorkflowRunId !== rootRunId) return;
    let binding;
    try {
      binding = childBinding(event);
    } catch (error) {
      fail(error);
      return;
    }
    if (candidate) {
      if (candidate.runId !== binding.runId || candidate.asyncDir !== binding.asyncDir || candidate.sessionId !== binding.sessionId || candidate.pid !== binding.pid || candidate.agent !== binding.agent) {
        fail(new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow child start events disagree on leaf identity"));
      }
      return;
    }
    candidate = binding;
    if (!drainingBuffered) succeed(binding);
  };
  const buffered = [];
  const completed = [];
  unsubscribe = events.on(STARTED_EVENT, (event) => {
    if (!record(event)
      || event.sessionId !== expectedSessionId
      || event.agent !== expectedAgent
      || event.workflowKey !== expectedKey) return;
    if (!rootRunId) {
      buffered.push(event);
      return;
    }
    accept(event);
  }) ?? (() => {});
  unsubscribeComplete = events.on(COMPLETE_EVENT, (event) => {
    const completion = rootCompletion(event);
    if (!completion || terminalError || candidate?.resolved) return;
    if (!rootRunId) {
      completed.push(completion);
      return;
    }
    if (completion.runId !== rootRunId) return;
    fail(rootFinishedError(completion));
  }) ?? (() => {});

  return Object.freeze({
    waitFor(root) {
      if (rootRunId !== undefined) {
        return Promise.reject(new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow child binding can only wait for one root run"));
      }
      if (!nonempty(root?.runId)) {
        return Promise.reject(new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow root reply is missing runId"));
      }
      rootRunId = root.runId;
      drainingBuffered = true;
      for (const event of buffered) accept(event);
      buffered.length = 0;
      drainingBuffered = false;
      if (terminalError) return Promise.reject(terminalError);
      if (candidate && !candidate.resolved) succeed(candidate);
      for (const completion of completed) {
        if (completion.runId !== rootRunId || candidate?.resolved) continue;
        fail(rootFinishedError(completion));
      }
      completed.length = 0;
      if (terminalError) return Promise.reject(terminalError);
      if (candidate?.resolved) return Promise.resolve({ runId: candidate.runId, asyncDir: candidate.asyncDir });
      return new Promise((resolve, reject) => {
        resolveWaiting = resolve;
        rejectWaiting = reject;
        timer = setTimeout(() => {
          fail(new WorkflowSpawnError("WORKFLOW_CHILD_START_TIMEOUT", "workflow child start event timed out"));
        }, timeoutMs);
      });
    },
    cancel() {
      if (terminalError || candidate?.resolved) return;
      fail(new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow child binding was cancelled"));
    },
  });
}
