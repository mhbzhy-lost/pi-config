const SCHEMA_VERSION = "pi-plan-event.v1";
const GATES = new Set(["deterministic", "plan-audit", "external-review", "final-completeness"]);
const TERMINAL_LIFECYCLES = new Set(["validated", "blocked", "cancelled", "interrupted"]);

export function createProjection() {
  return {
    planId: null,
    lifecycle: null,
    tasks: new Map(),
    attempts: new Map(),
    gates: new Map(),
    workspace: null,
    validatedHead: null,
    eventIds: new Set(),
  };
}

export function applyEvent(projection, event) {
  validateEnvelope(event);
  validatePlanIdentity(projection, event);

  if (projection.eventIds.has(event.eventId)) {
    throw new Error(`duplicate eventId: ${event.eventId}`);
  }
  if (TERMINAL_LIFECYCLES.has(projection.lifecycle)) {
    throw new Error(`plan is terminal: ${projection.lifecycle}`);
  }

  const next = copyProjection(projection);
  switch (event.type) {
    case "plan.created":
      createPlan(next, event);
      break;
    case "attempt.dispatch-requested":
      requestDispatch(next, event.data);
      break;
    case "attempt.bound":
      bindAttempt(next, event.data);
      break;
    case "attempt.settled":
      settleAttempt(next, event.data);
      break;
    case "task.accepted":
      acceptTask(next, event.data);
      break;
    case "workspace.head-observed":
      observeHead(next, event.data);
      break;
    case "gate.finished":
      finishGate(next, event.data);
      break;
    case "plan.validated":
      validatePlan(next, event.data);
      break;
    case "plan.blocked":
    case "plan.cancelled":
    case "plan.interrupted":
      requireNonterminalPlan(next);
      next.lifecycle = event.type.slice(5);
      break;
    default:
      throw new Error(`unsupported event type: ${event.type}`);
  }
  next.eventIds.add(event.eventId);
  return next;
}

function validateEnvelope(event) {
  if (!event || event.schemaVersion !== SCHEMA_VERSION) throw new Error("invalid schemaVersion");
  for (const field of ["eventId", "planId", "occurredAt", "type"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") {
      throw new Error(`invalid ${field}`);
    }
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new Error("invalid data");
  }
}

function validatePlanIdentity(projection, event) {
  if (projection.planId === null) {
    if (event.type !== "plan.created") throw new Error("plan.created must be first event");
    return;
  }
  if (event.planId !== projection.planId) throw new Error("different planId");
  if (event.type === "plan.created") throw new Error("plan already created");
}

function copyProjection(projection) {
  return {
    ...projection,
    tasks: new Map(projection.tasks),
    attempts: new Map(projection.attempts),
    gates: new Map(projection.gates),
    eventIds: new Set(projection.eventIds),
  };
}

function createPlan(projection, event) {
  const { workspace, tasks } = event.data;
  for (const field of ["originRoot", "worktree", "baseCommit", "headCommit", "planPath", "planHash"]) {
    if (typeof workspace?.[field] !== "string" || workspace[field].trim() === "") {
      throw new Error(`invalid workspace.${field}`);
    }
  }
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be nonempty");
  if (new Set(tasks).size !== tasks.length) throw new Error("tasks must be unique");
  for (const taskId of tasks) requireIdentity({ taskId }, "taskId");
  projection.planId = event.planId;
  projection.lifecycle = "created";
  projection.workspace = { ...workspace };
  for (const taskId of tasks) projection.tasks.set(taskId, { status: "pending" });
}

function bindAttempt(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "attemptId");
  requireIdentity(data, "taskId");
  const existing = projection.attempts.get(data.attemptId);
  if (existing?.status !== "dispatch-requested") throw new Error(`attempt is not dispatch-requested: ${data.attemptId}`);
  if (existing.taskId !== data.taskId) throw new Error(`attempt task does not match: ${data.attemptId}`);
  requireIdentity(data, "runId");
  for (const field of ["asyncDir", "sessionFile"]) {
    if (data[field] !== null && (typeof data[field] !== "string" || data[field].trim() === "")) {
      throw new Error(`invalid ${field}`);
    }
  }
  projection.attempts.set(data.attemptId, {
    ...existing,
    status: "active",
    runId: data.runId,
    asyncDir: data.asyncDir,
    sessionFile: data.sessionFile,
  });
  projection.lifecycle = "running";
}

function requestDispatch(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "attemptId");
  requireIdentity(data, "taskId");
  if (projection.attempts.has(data.attemptId)) throw new Error(`attempt already exists: ${data.attemptId}`);
  const task = projection.tasks.get(data.taskId);
  if (!task) throw new Error(`unknown task: ${data.taskId}`);
  if (task.status !== "pending") throw new Error(`task is not pending: ${data.taskId}`);
  for (const [attemptId, attempt] of projection.attempts) {
    if (["dispatch-requested", "active"].includes(attempt.status)) throw new Error(`active attempt already exists: ${attemptId}`);
  }
  validateTool(data.tool);
  projection.attempts.set(data.attemptId, { taskId: data.taskId, status: "dispatch-requested", tool: { ...data.tool } });
  projection.lifecycle = "running";
}

function settleAttempt(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "attemptId");
  if (typeof data.outcome !== "string" || data.outcome.trim() === "") throw new Error("invalid outcome");
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "active") throw new Error(`attempt is not active: ${data.attemptId}`);
  projection.attempts.set(data.attemptId, { ...attempt, status: data.outcome });
}

function acceptTask(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "taskId");
  const task = projection.tasks.get(data.taskId);
  if (!task) throw new Error(`unknown task: ${data.taskId}`);
  if (task.status !== "pending") throw new Error(`task is not pending: ${data.taskId}`);
  projection.tasks.set(data.taskId, { status: "accepted" });
}

function finishGate(projection, data) {
  requireActivePlan(projection);
  if (!GATES.has(data.type)) throw new Error(`unknown gate: ${data.type}`);
  if (!["passed", "failed", "unavailable"].includes(data.status)) throw new Error("invalid gate status");
  if (data.inputHead !== projection.workspace.headCommit) throw new Error("gate inputHead does not match headCommit");
  for (const field of ["gateId", "changeSetHash"]) requireIdentity(data, field);
  if (!Array.isArray(data.evidence)) throw new Error("invalid gate evidence");
  if (!Array.isArray(data.findings)) throw new Error("invalid gate findings");
  if (projection.gates.has(data.type)) throw new Error(`gate already finished: ${data.type}`);
  projection.gates.set(data.type, {
    type: data.type,
    status: data.status,
    inputHead: data.inputHead,
    gateId: data.gateId,
    changeSetHash: data.changeSetHash,
    evidence: data.evidence,
    findings: data.findings,
  });
  projection.lifecycle = "verifying";
}

function observeHead(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "headCommit");
  for (const attempt of projection.attempts.values()) {
    if (["dispatch-requested", "active"].includes(attempt.status)) throw new Error("active attempt prevents HEAD observation");
  }
  if (data.headCommit === projection.workspace.headCommit) throw new Error("HEAD is already observed");
  projection.workspace = { ...projection.workspace, headCommit: data.headCommit };
  projection.gates.clear();
  projection.lifecycle = "running";
}

function validatePlan(projection, data) {
  if (projection.lifecycle !== "verifying") throw new Error("plan is not verifying");
  if (data.worktreeClean !== true) throw new Error("worktree clean is required");
  for (const [taskId, task] of projection.tasks) {
    if (task.status !== "accepted") throw new Error(`task is not accepted: ${taskId}`);
  }
  for (const [attemptId, attempt] of projection.attempts) {
    if (["dispatch-requested", "active"].includes(attempt.status)) throw new Error(`active attempt: ${attemptId}`);
  }
  for (const gate of GATES) {
    const result = projection.gates.get(gate);
    if (!result) throw new Error(`missing gate: ${gate}`);
    if (result.inputHead !== projection.workspace.headCommit) {
      throw new Error(`gate did not pass current head: ${gate}`);
    }
    if (result.status !== "passed" && result.status !== "unavailable") {
      throw new Error(`gate did not pass current head: ${gate}`);
    }
  }
  projection.lifecycle = "validated";
  projection.validatedHead = projection.workspace.headCommit;
}

function requireActivePlan(projection) {
  if (!["created", "running", "verifying"].includes(projection.lifecycle)) throw new Error("plan is not active");
}

function requireNonterminalPlan(projection) {
  if (projection.lifecycle === null || TERMINAL_LIFECYCLES.has(projection.lifecycle)) throw new Error("plan is terminal");
}

function requireIdentity(data, field) {
  if (typeof data[field] !== "string" || data[field].trim() === "") throw new Error(`invalid ${field}`);
}

function validateTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error("invalid tool");
  for (const field of ["agent", "task", "cwd", "context"]) requireIdentity(tool, field);
  if (tool.context !== "fresh" || tool.async !== true || tool.clarify !== false) throw new Error("invalid tool flags");
}
