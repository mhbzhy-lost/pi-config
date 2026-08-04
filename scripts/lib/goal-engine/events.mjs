import { validateDAG } from "./graph.mjs";
import { validateTaskDefinitions } from "./task-definition.mjs";
import { assertPendingTaskContractsCompile, DISPATCH_VALIDATION_SENTINEL } from "./dispatch.mjs";

const SCHEMA_VERSIONS = new Set(["goal-engine.event.v1", "goal-engine.event.v2"]);
const DISPOSITION_ACTIONS = new Set(["integrate", "discard", "preserve"]);
const TERMINAL_LIFECYCLES = new Set(["completed", "blocked", "cancelled"]);
const VALID_EVIDENCE_TYPES = new Set(["diff", "file", "test_output", "screenshot", "log", "external_review"]);
const VALID_EVIDENCE_SOURCES = new Set(["self_produced", "pre_existing", "external"]);
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
    eventSchemaVersion: null,
  };
}

export function applyEvent(projection, event) {
  validateEnvelope(event);

  if (projection.eventIds.has(event.eventId)) {
    throw new Error(`duplicate eventId: ${event.eventId}`);
  }

  validateGoalIdentity(projection, event);
  if (projection.eventSchemaVersion === "goal-engine.event.v2" && event.schemaVersion === "goal-engine.event.v1") {
    throw new Error("schema downgrade from goal-engine.event.v2 is not allowed");
  }

  if (TERMINAL_LIFECYCLES.has(projection.lifecycle)) {
    throw new Error(`goal is terminal: ${projection.lifecycle}`);
  }

  const next = copyProjection(projection);
  if (event.schemaVersion === "goal-engine.event.v2") next.eventSchemaVersion = event.schemaVersion;
  switch (event.type) {
    case "goal.created": goalCreated(next, event); break;
    case "task.dispatched": taskDispatched(next, event.data, event.schemaVersion); break;
    case "task.settled": taskSettled(next, event.data, event.occurredAt); break;
    case "task.accepted": taskAccepted(next, event.data, event.schemaVersion); break;
    case "task.workspace_disposition_started": workspaceDispositionStarted(next, event.data, event.schemaVersion); break;
    case "task.workspace_disposition_applied": workspaceDispositionApplied(next, event.data, event.schemaVersion); break;
    case "task.workspace_disposed": workspaceDisposed(next, event.data, event.schemaVersion); break;
    case "goal.amended": goalAmended(next, event.data, event.schemaVersion); break;
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
  if (!event || !SCHEMA_VERSIONS.has(event.schemaVersion)) throw new Error("invalid schemaVersion");
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
    tasks: new Map([...p.tasks].map(([k, v]) => [k, { ...v, workspace: v.workspace ? { ...v.workspace } : null, evidence: [...v.evidence], deps: [...v.deps], writePaths: [...(v.writePaths || [])], acceptance: v.acceptance ? { ...v.acceptance, criteria: [...v.acceptance.criteria], commands: [...v.acceptance.commands] } : null }])),
    eventIds: new Set(p.eventIds),
  };
}

function goalCreated(p, event) {
  const { objective, scope, nonGoals, dod, tasks, taskDefs } = event.data;
  if (event.schemaVersion === "goal-engine.event.v2") validateTaskDefinitions(tasks, taskDefs);
  if (!objective || typeof objective !== "string") throw new Error("objective is required");
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be non-empty");
  if (!taskDefs || typeof taskDefs !== "object") throw new Error("taskDefs is required");

  p.goalId = event.goalId;
  p.eventSchemaVersion = event.schemaVersion;
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
      workspace: null,
      acceptanceVerification: null,
    });
  }
  if (event.schemaVersion === "goal-engine.event.v2") assertPendingTaskContractsCompile(p, DISPATCH_VALIDATION_SENTINEL);
}

function taskDispatched(p, data, schemaVersion) {
  requireActive(p);
  const { taskId, contractHash, workspace } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "pending") throw new Error(`task is not pending: ${taskId} (${task.status})`);
  // v1 is replay-only compatibility for historical logs that dispatched a
  // downstream task before its dependency was accepted. All newer schemas
  // retain the DAG acceptance gate.
  if (schemaVersion !== "goal-engine.event.v1") assertDepsAccepted(p, task);
  if (!contractHash || typeof contractHash !== "string") throw new Error("contractHash is required for dispatch");
  if (schemaVersion === "goal-engine.event.v2") {
    assertWorkspaceRedispatchable(task);
    validateWorkspace(workspace, task.attempts + 1);
    task.workspace = { ...workspace, phase: "active" };
  }
  task.status = "dispatched";
  task.attempts++;
  task.contractHash = contractHash;
}

function taskSettled(p, data, occurredAt) {
  requireActive(p);
  const { taskId, outcome, evidence, evidenceSource, nextAction } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "dispatched") throw new Error(`task is not dispatched: ${taskId} (${task.status})`);
  if (!["succeeded", "failed", "blocked"].includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);

  validateEvidenceSource(evidenceSource, evidence);
  validateNextAction(nextAction);
  if (outcome === "succeeded") validateEvidence(evidence);

  task.lastSettledOutcome = outcome;
  if (outcome === "succeeded") {
    task.status = "succeeded";
    task.evidence.push({ ...evidence, source: evidenceSource || "self_produced", ts: occurredAt });
  } else if (outcome === "failed") {
    task.status = "pending";
  } else {
    task.status = "blocked";
    task.blockedReason = data.reason || null;
  }
}

function taskAccepted(p, data, schemaVersion) {
  requireActive(p);
  const { taskId, workspaceAttempt } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "succeeded") throw new Error(`task is not succeeded: ${taskId} (${task.status})`);
  if (schemaVersion === "goal-engine.event.v2") {
    const workspace = task.workspace;
    if (!workspace || workspace.phase !== "disposed" || workspace.disposition !== "integrated" || workspace.released !== true) {
      throw new Error("workspace must be disposed, integrated, and released before acceptance");
    }
    if (workspaceAttempt !== workspace.attempt) throw new Error("workspace attempt mismatch");
    task.acceptanceVerification = "integrated";
  } else {
    task.acceptanceVerification = "legacy_unverified";
  }
  task.status = "accepted";
}

function workspaceDispositionStarted(p, data, schemaVersion) {
  requireV2(schemaVersion);
  const { taskId, attempt, requestedAction, strategy, executorHead, originHeadBefore, originRef } = data;
  const task = requireTask(p, taskId);
  const workspace = requireWorkspace(task, attempt);
  if (workspace.phase !== "active") throw new Error("workspace disposition already started or terminal phase");
  if (!DISPOSITION_ACTIONS.has(requestedAction)) throw new Error("invalid requested action");
  if (requestedAction === "integrate") {
    if (task.status !== "succeeded") throw new Error("integrate disposition requires succeeded task");
  } else if (!((task.status === "pending" && task.lastSettledOutcome === "failed") || task.status === "succeeded" || task.status === "blocked")) {
    throw new Error("discard and preserve dispositions require settled task");
  }
  for (const [name, value] of Object.entries({ strategy, executorHead, originHeadBefore })) if (!value || typeof value !== "string") throw new Error(`${name} is required`);
  if (originRef !== undefined && (typeof originRef !== "string" || !originRef)) throw new Error("originRef must be a non-empty string");
  Object.assign(workspace, { requestedAction, strategy, executorHead, originHeadBefore, ...(originRef ? { originRef, legacyOriginRef: false } : { legacyOriginRef: true }), phase: "disposing" });
}

function workspaceDispositionApplied(p, data, schemaVersion) {
  requireV2(schemaVersion);
  const { taskId, attempt, action, strategy, executorHead, originHead } = data;
  const workspace = requireWorkspace(requireTask(p, taskId), attempt);
  if (workspace.phase !== "disposing") throw new Error("workspace must be disposing");
  if (action !== workspace.requestedAction) throw new Error("workspace action mismatch");
  for (const [name, value] of Object.entries({ strategy, executorHead, originHead })) if (!value || typeof value !== "string") throw new Error(`${name} is required`);
  if (strategy !== workspace.strategy) throw new Error("workspace strategy mismatch");
  if (executorHead !== workspace.executorHead) throw new Error("workspace executorHead mismatch");
  Object.assign(workspace, { originHead, phase: "applied" });
  workspace.disposition = ({ integrate: "integrated", discard: "discarded", preserve: "preserved" })[action];
}

function workspaceDisposed(p, data, schemaVersion) {
  requireV2(schemaVersion);
  const { taskId, attempt, action, released } = data;
  const task = requireTask(p, taskId);
  const workspace = requireWorkspace(task, attempt);
  if (workspace.phase !== "applied") throw new Error("workspace must be applied");
  if (action !== workspace.requestedAction) throw new Error("workspace action mismatch");
  const requiresRelease = action !== "preserve";
  if (released !== requiresRelease) throw new Error(`workspace ${action} requires released=${requiresRelease}`);
  workspace.released = released;
  workspace.phase = "disposed";
  if (workspace.disposition === "discarded" && task.status === "succeeded") task.status = "pending";
}

function requireV2(schemaVersion) {
  if (schemaVersion !== "goal-engine.event.v2") throw new Error("workspace disposition events require goal-engine.event.v2");
}

function validateWorkspace(workspace, expectedAttempt) {
  if (!workspace || typeof workspace !== "object") throw new Error("workspace is required for v2 dispatch");
  if (workspace.attempt !== expectedAttempt) throw new Error("workspace attempt mismatch");
  for (const field of ["path", "branch", "baseCommit"]) if (!workspace[field] || typeof workspace[field] !== "string") throw new Error(`workspace ${field} is required`);
}

function assertWorkspaceRedispatchable(task) {
  if (!task.workspace) return;
  const { phase, disposition, released } = task.workspace;
  const isReleasable = phase === "disposed" && disposition === "discarded" && released === true;
  if (isReleasable) return;
  throw new Error(
    `workspace redispatch error: existing workspace must be disposed, discarded, and released before redispatch (phase=${phase}, disposition=${disposition}, released=${released})`,
  );
}

function requireWorkspace(task, attempt) {
  if (!task.workspace) throw new Error("workspace is required");
  if (task.workspace.attempt !== attempt) throw new Error("workspace attempt mismatch");
  return task.workspace;
}

function assertDepsAccepted(p, task) {
  const blockedDeps = [];
  for (const dep of task.deps) {
    const depTask = p.tasks.get(dep);
    if (!depTask || depTask.status !== "accepted") {
      blockedDeps.push(dep);
    }
  }
  if (blockedDeps.length > 0) {
    throw new Error(`task dependencies are not accepted: ${blockedDeps.join(", ")}`);
  }
}

function goalAmended(p, data, schemaVersion) {
  requireActive(p);
  const { addTasks, removeTasks, updateTasks, reason } = data;
  if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
    throw new Error("amendment reason must be at least 10 characters");
  }

  // v1 only replays its historical amendment semantics. New v2 amendments retain
  // the pending-and-released workspace gate established by the contract freeze.
  const removeTaskIds = removeTasks || [];
  const removedTaskIds = new Set();
  for (const taskId of removeTaskIds) {
    if (removedTaskIds.has(taskId)) throw new Error(`duplicate remove task: ${taskId}`);
    removedTaskIds.add(taskId);
  }
  for (const taskId of removedTaskIds) assertTaskRemovable(requireTask(p, taskId), taskId, schemaVersion);
  for (const taskId of Object.keys(addTasks || {})) {
    if (p.tasks.has(taskId) && !removedTaskIds.has(taskId)) throw new Error(`task already exists: ${taskId}`);
  }
  for (const taskId of Object.keys(updateTasks || {})) {
    const isReplacement = removedTaskIds.has(taskId);
    if (isReplacement && !Object.hasOwn(addTasks || {}, taskId)) {
      throw new Error(`cannot update task scheduled for removal: ${taskId}`);
    }
    const existingTask = p.tasks.get(taskId);
    if (existingTask && !isReplacement) {
      assertTaskUpdatable(existingTask, taskId, schemaVersion);
    } else if (!existingTask && !Object.hasOwn(addTasks || {}, taskId)) {
      requireTask(p, taskId);
    }
  }

  const candidate = new Map([...p.tasks].map(([taskId, task]) => [taskId, {
    ...task,
    deps: [...task.deps],
    writePaths: [...task.writePaths],
    acceptance: { ...task.acceptance, criteria: [...task.acceptance.criteria], commands: [...task.acceptance.commands] },
  }]));
  for (const taskId of removeTasks || []) candidate.delete(taskId);
  for (const [taskId, def] of Object.entries(addTasks || {})) {
    if (!def.writePaths || !def.acceptance) throw new Error(`added task ${taskId} must have writePaths and acceptance`);
    candidate.set(taskId, {
      description: def.description, deps: def.deps || [], writePaths: def.writePaths, acceptance: def.acceptance,
      workflow: def.workflow || "tdd", status: "pending", evidence: [], attempts: 0,
      lastSettledOutcome: null, contractHash: null, workspace: null, acceptanceVerification: null,
    });
  }
  for (const [taskId, updates] of Object.entries(updateTasks || {})) {
    const task = candidate.get(taskId);
    if (!task) throw new Error(`cannot update task scheduled for removal: ${taskId}`);
    if (updates.description) task.description = updates.description;
    if (updates.deps) task.deps = updates.deps;
    if (updates.writePaths) task.writePaths = updates.writePaths;
    if (updates.acceptance) task.acceptance = updates.acceptance;
  }
  if (schemaVersion === "goal-engine.event.v2") {
    validateTaskDefinitions([...candidate.keys()], Object.fromEntries(candidate));
  } else {
    validateDAG(candidate);
  }
  if (schemaVersion === "goal-engine.event.v2") {
    const candidateProjection = { ...p, tasks: candidate };
    assertPendingTaskContractsCompile(candidateProjection, DISPATCH_VALIDATION_SENTINEL);
  }
  p.tasks = candidate;
}

function workspaceReleasedForRetry(task) {
  const workspace = task.workspace;
  return !workspace || (workspace.phase === "disposed" && workspace.disposition === "discarded" && workspace.released === true);
}

function assertTaskUpdatable(task, taskId, schemaVersion) {
  if (schemaVersion === "goal-engine.event.v1") return;
  if (task.status !== "pending") throw new Error(`cannot update non-pending task: ${taskId} (${task.status})`);
  if (!workspaceReleasedForRetry(task)) throw new Error(`cannot update task with unreleased workspace: ${taskId}`);
}

function assertTaskRemovable(task, taskId, schemaVersion) {
  if (schemaVersion === "goal-engine.event.v1") {
    if (task.status === "accepted") throw new Error(`cannot remove accepted task: ${taskId}`);
    return;
  }
  if (task.status !== "pending") throw new Error(`cannot remove non-pending task: ${taskId} (${task.status})`);
  if (!workspaceReleasedForRetry(task)) throw new Error(`cannot remove task with unreleased workspace: ${taskId}`);
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

function validateEvidenceSource(source, evidence) {
  if (source === undefined) return;
  if (!VALID_EVIDENCE_SOURCES.has(source)) throw new Error(`invalid evidence source: ${source}`);
  if (source === "external" && evidence?.type !== "external_review") {
    throw new Error("external evidence source requires external_review evidence type");
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
