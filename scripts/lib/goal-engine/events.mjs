const SCHEMA_VERSION = "goal-engine.event.v1";
const TERMINAL_LIFECYCLES = new Set(["completed", "blocked", "cancelled"]);
const VALID_EVIDENCE_TYPES = new Set(["diff", "file", "test_output", "screenshot", "log", "external_review"]);
const VAGUE_PATTERNS = /\b(continue|proceed|next step|next|TBD|todo|keep going|carry on)\b/i;
const MIN_NEXT_ACTION_LEN = 20;

export function createProjection() {
  return {
    goalId: null,
    version: 0,
    lifecycle: null,
    objective: null,
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: new Map(),
    eventIds: new Set(),
    checkpointCount: 0,
    completionVerdict: null,
    blockedReason: null,
    nextAction: null,
    createdAt: null,
    updatedAt: null,
  };
}

export function applyEvent(projection, event) {
  validateEnvelope(event);

  if (projection.eventIds.has(event.eventId)) {
    throw new Error(`duplicate eventId: ${event.eventId}`);
  }

  validateGoalIdentity(projection, event);

  if (TERMINAL_LIFECYCLES.has(projection.lifecycle)) {
    throw new Error(`goal is terminal: ${projection.lifecycle}`);
  }

  const next = copyProjection(projection);
  switch (event.type) {
    case "goal.created": goalCreated(next, event); break;
    case "task.dispatched": taskDispatched(next, event.data); break;
    case "task.settled": taskSettled(next, event.data); break;
    case "task.accepted": taskAccepted(next, event.data); break;
    case "goal.amended": goalAmended(next, event.data); break;
    case "goal.blocked": goalBlocked(next, event.data); break;
    case "goal.completed": goalCompleted(next, event.data); break;
    case "goal.checkpoint": goalCheckpoint(next, event.data); break;
    default: throw new Error(`unsupported event type: ${event.type}`);
  }
  next.version = projection.version + 1;
  next.updatedAt = event.occurredAt;
  next.eventIds.add(event.eventId);
  return next;
}

function validateEnvelope(event) {
  if (!event || event.schemaVersion !== SCHEMA_VERSION) throw new Error("invalid schemaVersion");
  for (const field of ["eventId", "goalId", "occurredAt", "type"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) throw new Error(`invalid ${field}`);
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new Error("invalid data");
}

function validateGoalIdentity(projection, event) {
  if (projection.goalId === null) {
    if (event.type !== "goal.created") throw new Error("goal.created must be first event");
    return;
  }
  if (event.goalId !== projection.goalId) throw new Error("goalId mismatch");
  if (event.type === "goal.created") throw new Error("goal already created");
}

function copyProjection(p) {
  return {
    ...p,
    scope: [...p.scope],
    nonGoals: [...p.nonGoals],
    dod: [...p.dod],
    tasks: new Map([...p.tasks].map(([k, v]) => [k, { ...v, evidence: [...v.evidence], deps: [...v.deps], writePaths: [...(v.writePaths || [])], acceptance: v.acceptance ? { ...v.acceptance, criteria: [...v.acceptance.criteria], commands: [...v.acceptance.commands] } : null }])),
    eventIds: new Set(p.eventIds),
  };
}

function goalCreated(p, event) {
  const { objective, scope, nonGoals, dod, tasks, taskDefs } = event.data;
  if (!objective || typeof objective !== "string") throw new Error("objective is required");
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be non-empty");
  if (!taskDefs || typeof taskDefs !== "object") throw new Error("taskDefs is required");

  p.goalId = event.goalId;
  p.lifecycle = "active";
  p.objective = objective;
  p.scope = scope || [];
  p.nonGoals = nonGoals || [];
  p.dod = dod || [];
  p.createdAt = event.occurredAt;

  for (const taskId of tasks) {
    const def = taskDefs[taskId];
    if (!def) throw new Error(`missing taskDef for ${taskId}`);
    if (!def.description) throw new Error(`taskDef ${taskId} missing description`);
    if (!Array.isArray(def.writePaths) || def.writePaths.length === 0) throw new Error(`taskDef ${taskId} missing writePaths`);
    if (!def.acceptance || !Array.isArray(def.acceptance.criteria) || !Array.isArray(def.acceptance.commands)) {
      throw new Error(`taskDef ${taskId} missing acceptance (criteria + commands)`);
    }
    p.tasks.set(taskId, {
      description: def.description,
      deps: def.deps || [],
      writePaths: def.writePaths,
      acceptance: { criteria: def.acceptance.criteria, commands: def.acceptance.commands },
      workflow: def.workflow || "tdd",
      status: "pending",
      evidence: [],
      attempts: 0,
      lastSettledOutcome: null,
      contractHash: null,
    });
  }
}

function taskDispatched(p, data) {
  requireActive(p);
  const { taskId, contractHash } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "pending") throw new Error(`task is not pending: ${taskId} (${task.status})`);
  if (!contractHash || typeof contractHash !== "string") throw new Error("contractHash is required for dispatch");
  task.status = "dispatched";
  task.attempts++;
  task.contractHash = contractHash;
}

function taskSettled(p, data) {
  requireActive(p);
  const { taskId, outcome, evidence, evidenceSource, nextAction } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "dispatched") throw new Error(`task is not dispatched: ${taskId} (${task.status})`);
  if (!["succeeded", "failed", "blocked"].includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);

  validateNextAction(nextAction);
  if (outcome === "succeeded") validateEvidence(evidence);

  task.lastSettledOutcome = outcome;
  if (outcome === "succeeded") {
    task.status = "succeeded";
    task.evidence.push({ ...evidence, source: evidenceSource || "self_produced", ts: new Date().toISOString() });
  } else if (outcome === "failed") {
    task.status = "pending";
  } else {
    task.status = "blocked";
    task.blockedReason = data.reason || null;
  }
}

function taskAccepted(p, data) {
  requireActive(p);
  const { taskId } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "succeeded") throw new Error(`task is not succeeded: ${taskId} (${task.status})`);
  task.status = "accepted";
}

function goalAmended(p, data) {
  requireActive(p);
  const { addTasks, removeTasks, updateTasks, reason } = data;
  if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
    throw new Error("amendment reason must be at least 10 characters");
  }

  if (removeTasks) {
    for (const taskId of removeTasks) {
      const task = requireTask(p, taskId);
      if (task.status === "accepted") throw new Error(`cannot remove accepted task: ${taskId}`);
      p.tasks.delete(taskId);
    }
  }
  if (addTasks) {
    for (const [taskId, def] of Object.entries(addTasks)) {
      if (p.tasks.has(taskId)) throw new Error(`task already exists: ${taskId}`);
      if (!def.writePaths || !def.acceptance) throw new Error(`added task ${taskId} must have writePaths and acceptance`);
      p.tasks.set(taskId, {
        description: def.description,
        deps: def.deps || [],
        writePaths: def.writePaths,
        acceptance: def.acceptance,
        workflow: def.workflow || "tdd",
        status: "pending",
        evidence: [],
        attempts: 0,
        lastSettledOutcome: null,
        contractHash: null,
      });
    }
  }
  if (updateTasks) {
    for (const [taskId, updates] of Object.entries(updateTasks)) {
      const task = requireTask(p, taskId);
      if (updates.description) task.description = updates.description;
      if (updates.deps) task.deps = updates.deps;
      if (updates.writePaths) task.writePaths = updates.writePaths;
      if (updates.acceptance) task.acceptance = updates.acceptance;
    }
  }
}

function goalBlocked(p, data) {
  requireActive(p);
  const { reason } = data;
  if (!reason || typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  p.lifecycle = "blocked";
  p.blockedReason = reason;
}

function goalCompleted(p, data) {
  requireActive(p);
  const { verdict } = data;
  if (!["COMPLETE", "DONE_WITHOUT_EXTERNAL_VERIFICATION"].includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  for (const [taskId, task] of p.tasks) {
    if (task.status !== "accepted") throw new Error(`task not accepted: ${taskId} (${task.status})`);
  }
  p.lifecycle = "completed";
  p.completionVerdict = verdict;
}

function goalCheckpoint(p, data) {
  requireActive(p);
  const { nextAction } = data;
  validateNextAction(nextAction);
  p.checkpointCount++;
  p.nextAction = nextAction;
}

export function validateNextAction(nextAction) {
  if (!nextAction || typeof nextAction !== "string" || nextAction.trim().length < MIN_NEXT_ACTION_LEN) {
    throw new Error(`next_action must be at least ${MIN_NEXT_ACTION_LEN} characters and describe a concrete action`);
  }
  if (VAGUE_PATTERNS.test(nextAction)) {
    throw new Error("next_action must be specific — vague words (continue/proceed/next step/TBD) are rejected");
  }
}

export function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("evidence is required to settle a task as succeeded");
  }
  if (!VALID_EVIDENCE_TYPES.has(evidence.type)) {
    throw new Error(`evidence type must be one of: ${[...VALID_EVIDENCE_TYPES].join(", ")}. Got: "${evidence.type}"`);
  }
  if (!evidence.ref && !evidence.path) {
    throw new Error("evidence must include a ref (diff/log) or path (file/test_output/screenshot)");
  }
}

function requireActive(p) {
  if (p.lifecycle !== "active") throw new Error(`goal is not active: ${p.lifecycle}`);
}

function requireTask(p, taskId) {
  const task = p.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return task;
}
