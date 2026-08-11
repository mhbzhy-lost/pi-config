const WORKFLOW_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STARTED_EVENT = "subagent:async-started";

export class WorkflowSpawnError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowSpawnError";
    this.code = code;
  }
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
  if (!nonempty(event?.asyncDir)) {
    throw new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow child start event is missing asyncDir");
  }
  return { runId: id, asyncDir: event.asyncDir };
}

export function createWorkflowChildStartCollector(events, {
  workflowKey: expectedKey,
  agent: expectedAgent,
  sessionId: expectedSessionId,
  timeoutMs,
} = {}) {
  workflowKey(expectedKey);
  if (!events || typeof events.on !== "function") throw new TypeError("workflow child collector requires an event bus");
  if (!nonempty(expectedAgent) || !nonempty(expectedSessionId)) {
    throw new TypeError("workflow child collector requires agent and session identity");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("workflow child collector timeoutMs must be a positive safe integer");
  }

  let rootRunId;
  let candidate;
  let terminalError;
  let resolveWaiting;
  let rejectWaiting;
  let timer;
  let drainingBuffered = false;
  let unsubscribe = () => {};

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const dispose = unsubscribe;
    unsubscribe = () => {};
    dispose();
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
    candidate = { ...binding, resolved: true };
    stop();
    resolveWaiting?.(binding);
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
      if (candidate.runId !== binding.runId || candidate.asyncDir !== binding.asyncDir) {
        fail(new WorkflowSpawnError("WORKFLOW_CHILD_BINDING_INVALID", "workflow child start events disagree on leaf identity"));
      }
      return;
    }
    candidate = binding;
    if (!drainingBuffered) succeed(binding);
  };
  const buffered = [];
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
