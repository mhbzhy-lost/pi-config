import { isAbsolute } from "node:path";
import { validateDAG } from "./graph.mjs";
import { validateTaskDefinitions } from "./task-definition.mjs";
import { assertPendingTaskContractsCompile, DISPATCH_VALIDATION_SENTINEL } from "./dispatch.mjs";

const LEGACY_SCHEMA_VERSIONS = new Set(["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3"]);
export const PLANNED_SCHEMA_VERSION = "planned.v1";
const SCHEMA_VERSIONS = new Set([...LEGACY_SCHEMA_VERSIONS, PLANNED_SCHEMA_VERSION]);
const SCHEMA_RANK = new Map([["goal-engine.event.v1", 1], ["goal-engine.event.v2", 2], ["goal-engine.event.v3", 3]]);

export function schemaVersionForMutation(projection, legacyTargetVersion = "goal-engine.event.v3") {
  const current = projection?.eventSchemaVersion;
  if (!current || current === PLANNED_SCHEMA_VERSION) return PLANNED_SCHEMA_VERSION;
  if (!LEGACY_SCHEMA_VERSIONS.has(current)) throw new Error(`unknown event generation: ${current}`);
  if (!LEGACY_SCHEMA_VERSIONS.has(legacyTargetVersion)) throw new Error(`invalid legacy mutation generation: ${legacyTargetVersion}`);
  return SCHEMA_RANK.get(legacyTargetVersion) >= SCHEMA_RANK.get(current) ? legacyTargetVersion : current;
}
const DISPOSITION_ACTIONS = new Set(["integrate", "discard", "preserve"]);
const TERMINAL_LIFECYCLES = new Set(["completed", "blocked", "cancelled"]);
const COMPLETED_V3_EVENTS = new Set([
  "goal.session_bound", "goal.session_detached", "goal.discovery_recorded", "goal.discovery_resolved",
  "goal.continuity_checkpointed", "goal.reopened", "goal.action_offered", "goal.action_consumed",
]);
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
    executorRunIds: new Set(),
    eventIds: new Set(),
    checkpointCount: 0,
    completionVerdict: null,
    blockedReason: null,
    nextAction: null,
    createdAt: null,
    updatedAt: null,
    eventSchemaVersion: null,
    epoch: 1,
    completionHistory: [],
    coordinationState: null,
    sessionBindings: [],
    continuity: { observations: {}, lastCheckpoint: null },
    actionOffer: null,
    pendingHumanDecision: null,
    contractHistory: [],
  };
}

// replay is only for already-persisted JSONL; new mutation candidates use strict defaults.
export function applyEvent(projection, event, { replay = false } = {}) {
  validateEnvelope(event);

  if (projection.eventIds.has(event.eventId)) {
    throw new Error(`duplicate eventId: ${event.eventId}`);
  }

  validateGoalIdentity(projection, event);
  validateGeneration(projection, event, replay);
  if (LEGACY_SCHEMA_VERSIONS.has(event.schemaVersion) && projection.eventSchemaVersion && SCHEMA_RANK.get(event.schemaVersion) < SCHEMA_RANK.get(projection.eventSchemaVersion)) {
    throw new Error(`schema downgrade from ${projection.eventSchemaVersion} is not allowed`);
  }

  const completedContinuation = projection.lifecycle === "completed"
    && (event.schemaVersion === "goal-engine.event.v3" || event.schemaVersion === PLANNED_SCHEMA_VERSION)
    && COMPLETED_V3_EVENTS.has(event.type);
  if (TERMINAL_LIFECYCLES.has(projection.lifecycle) && !completedContinuation) {
    throw new Error(`goal is terminal: ${projection.lifecycle}`);
  }

  const next = copyProjection(projection);
  if (!next.eventSchemaVersion || SCHEMA_RANK.get(event.schemaVersion) > SCHEMA_RANK.get(next.eventSchemaVersion)) {
    next.eventSchemaVersion = event.schemaVersion;
  }
  switch (event.type) {
    case "goal.created": goalCreated(next, event, replay); break;
    case "task.dispatched": taskDispatched(next, event.data, event.schemaVersion); break;
    case "task.executor_bound": taskExecutorBound(next, event.data, event.schemaVersion); break;
    case "task.settled": taskSettled(next, event.data, event.occurredAt, event.schemaVersion, replay); break;
    case "task.accepted": taskAccepted(next, event.data, event.schemaVersion); break;
    case "task.workspace_orphan_recovered": workspaceOrphanRecovered(next, event.data, event.schemaVersion); break;
    case "task.workspace_preservation_released": workspacePreservationReleased(next, event.data, event.schemaVersion); break;
    case "task.workspace_disposition_started": workspaceDispositionStarted(next, event.data, event.schemaVersion, replay); break;
    case "task.workspace_disposition_rebased": workspaceDispositionRebased(next, event.data, event.schemaVersion); break;
    case "task.workspace_disposition_applied": workspaceDispositionApplied(next, event.data, event.schemaVersion); break;
    case "task.workspace_disposed": workspaceDisposed(next, event.data, event.schemaVersion); break;
    case "goal.amended": goalAmended(next, event.data, event.schemaVersion, replay); break;
    case "goal.contract_amended": goalContractAmended(next, event.data, event.schemaVersion); break;
    case "goal.session_bound": goalSessionBound(next, event, event.schemaVersion); break;
    case "goal.session_detached": goalSessionDetached(next, event, event.schemaVersion); break;
    case "goal.discovery_recorded": goalDiscoveryRecorded(next, event, event.schemaVersion); break;
    case "goal.discovery_resolved": goalDiscoveryResolved(next, event, event.schemaVersion); break;
    case "goal.continuity_checkpointed": goalContinuityCheckpointed(next, event, event.schemaVersion); break;
    case "goal.action_offered": goalActionOffered(next, event.data, event.schemaVersion); break;
    case "goal.action_consumed": goalActionConsumed(next, event.data, event.schemaVersion); break;
    case "goal.reopened": goalReopened(next, event.data, event.schemaVersion); break;
    case "task.block_resolved": taskBlockResolved(next, event.data, event.schemaVersion); break;
    case "goal.blocked": goalBlocked(next, event.data); break;
    case "goal.completed": goalCompleted(next, event.data, event.occurredAt, projection.version + 1); break;
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

function validateGeneration(projection, event, replay) {
  if (!projection.eventSchemaVersion) {
    if (event.schemaVersion !== PLANNED_SCHEMA_VERSION && !replay) throw new Error("legacy event generations are replay-only");
    return;
  }
  if (projection.eventSchemaVersion === PLANNED_SCHEMA_VERSION || event.schemaVersion === PLANNED_SCHEMA_VERSION) {
    if (event.schemaVersion !== projection.eventSchemaVersion) throw new Error(`mixed event generations are not allowed: ${projection.eventSchemaVersion} and ${event.schemaVersion}`);
  }
}

function validateGoalIdentity(projection, event) {
  if (projection.goalId === null) {
    if (event.type !== "goal.created") throw new Error("goal.created must be first event");
    return;
  }
  if (event.goalId !== projection.goalId) throw new Error("goalId mismatch");
  if (event.type === "goal.created") throw new Error("goal already created");
}

function copyTask(task) {
  return {
    ...task,
    workspace: task.workspace ? { ...task.workspace } : null,
    ...(Object.hasOwn(task, "executorBinding") ? { executorBinding: task.executorBinding ? { ...task.executorBinding } : null } : {}),
    ...(Object.hasOwn(task, "lastExecutorProof") ? { lastExecutorProof: task.lastExecutorProof ? { ...task.lastExecutorProof } : null } : {}),
    settlement: task.settlement ? { ...task.settlement } : null,
    evidence: [...task.evidence],
    deps: [...task.deps],
    writePaths: [...(task.writePaths || [])],
    acceptance: task.acceptance ? { ...task.acceptance, criteria: structuredClone(task.acceptance.criteria), ...(task.acceptance.commands ? { commands: [...task.acceptance.commands] } : {}) } : null,
  };
}

function copyProjection(p) {
  return {
    ...p,
    scope: [...p.scope],
    nonGoals: [...p.nonGoals],
    dod: [...p.dod],
    tasks: new Map([...p.tasks].map(([k, v]) => [k, copyTask(v)])),
    executorRunIds: new Set(p.executorRunIds || []),
    eventIds: new Set(p.eventIds),
    completionHistory: (p.completionHistory || []).map((entry) => ({ ...entry })),
    sessionBindings: (p.sessionBindings || []).map((binding) => ({ ...binding })),
    continuity: {
      observations: Object.fromEntries(Object.entries(p.continuity?.observations || {}).map(([id, observation]) => [id, { ...observation, paths: [...(observation.paths || [])] }])),
      lastCheckpoint: p.continuity?.lastCheckpoint ? { ...p.continuity.lastCheckpoint, modifiedFiles: [...p.continuity.lastCheckpoint.modifiedFiles] } : null,
    },
    actionOffer: p.actionOffer ? structuredClone(p.actionOffer) : null,
    pendingHumanDecision: p.pendingHumanDecision ? structuredClone(p.pendingHumanDecision) : null,
    contractHistory: (p.contractHistory || []).map((entry) => structuredClone(entry)),
  };
}

function goalCreated(p, event, replay) {
  const { objective, scope, nonGoals, dod, tasks, taskDefs } = event.data;
  if (event.schemaVersion === PLANNED_SCHEMA_VERSION) validateTaskDefinitions(tasks, taskDefs, { planned: true });
  else if (event.schemaVersion !== "goal-engine.event.v1" && !replay) validateTaskDefinitions(tasks, taskDefs);
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
  p.coordinationState = "ready";

  for (const taskId of tasks) {
    const def = taskDefs[taskId];
    if (!def) throw new Error(`missing taskDef for ${taskId}`);
    if (!def.description) throw new Error(`taskDef ${taskId} missing description`);
    if (!Array.isArray(def.writePaths) || def.writePaths.length === 0) throw new Error(`taskDef ${taskId} missing writePaths`);
    if (!def.acceptance || !Array.isArray(def.acceptance.criteria)
      || (event.schemaVersion !== PLANNED_SCHEMA_VERSION && !Array.isArray(def.acceptance.commands))) {
      throw new Error(`taskDef ${taskId} missing acceptance${event.schemaVersion === PLANNED_SCHEMA_VERSION ? " criteria" : " (criteria + commands)"}`);
    }
    p.tasks.set(taskId, {
      description: def.description,
      deps: def.deps || [],
      writePaths: def.writePaths,
      acceptance: event.schemaVersion === PLANNED_SCHEMA_VERSION
        ? { criteria: structuredClone(def.acceptance.criteria) }
        : { criteria: def.acceptance.criteria, commands: def.acceptance.commands },
      workflow: def.workflow || "tdd",
      status: "pending",
      evidence: [],
      attempts: 0,
      lastSettledOutcome: null,
      contractHash: null,
      workspace: null,
      ...(event.schemaVersion === PLANNED_SCHEMA_VERSION ? { executorBinding: null, lastExecutorProof: null } : {}),
      acceptanceVerification: null,
      settlement: null,
    });
  }
  if (event.schemaVersion === PLANNED_SCHEMA_VERSION) assertPendingTaskContractsCompile(p, DISPATCH_VALIDATION_SENTINEL);
  else if (event.schemaVersion !== "goal-engine.event.v1" && !replay) assertPendingTaskContractsCompile(p, DISPATCH_VALIDATION_SENTINEL);
  if (event.schemaVersion !== "goal-engine.event.v1" && replay) validateDAG(p.tasks);
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
  if (schemaVersion !== "goal-engine.event.v1") {
    assertWorkspaceRedispatchable(task);
    validateWorkspace(workspace, task.attempts + 1);
    task.workspace = { ...workspace, phase: "active" };
    task.settlement = null;
  }
  task.status = "dispatched";
  task.attempts++;
  task.contractHash = contractHash;
  if (schemaVersion === PLANNED_SCHEMA_VERSION) {
    task.executorBinding = null;
    task.lastExecutorProof = null;
  }
}

function taskExecutorBound(p, data, schemaVersion) {
  requireActive(p);
  if (schemaVersion !== PLANNED_SCHEMA_VERSION) throw new Error("executor binding requires planned.v1");
  requireExactFields(data, [
    "taskId", "attempt", "runId", "contractHash", "asyncDir",
    "workspacePath", "workspaceLeaseId", "headAtDispatch",
  ], "executor binding data");
  const task = requireTask(p, data.taskId);
  if (task.status !== "dispatched") throw new Error(`task is not dispatched: ${data.taskId} (${task.status})`);
  if (task.executorBinding) throw new Error(`executor binding is already bound and immutable: ${data.taskId}`);
  if (!Number.isSafeInteger(data.attempt) || data.attempt < 1 || data.attempt !== task.attempts) {
    throw new Error("executor binding attempt mismatch");
  }
  requireNonEmptyStrings({
    runId: data.runId,
    contractHash: data.contractHash,
    asyncDir: data.asyncDir,
    workspacePath: data.workspacePath,
    workspaceLeaseId: data.workspaceLeaseId,
    headAtDispatch: data.headAtDispatch,
  }, "executor binding");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(data.runId)) throw new Error("executor binding runId is invalid");
  if (!/^[a-f0-9]{64}$/.test(data.contractHash) || data.contractHash !== task.contractHash) throw new Error("executor binding contractHash mismatch");
  if (!isAbsolute(data.asyncDir) || data.asyncDir.includes("\0")) throw new Error("executor binding asyncDir must be absolute");
  const workspace = requireWorkspace(task, data.attempt);
  if (data.workspacePath !== workspace.path) throw new Error("executor binding workspacePath mismatch");
  if (!/^[a-f0-9]{64}$/.test(data.workspaceLeaseId)) throw new Error("executor binding workspaceLeaseId mismatch");
  if (!/^[a-f0-9]{40}$/.test(data.headAtDispatch) || data.headAtDispatch !== workspace.baseCommit) throw new Error("executor binding headAtDispatch mismatch");
  if (p.executorRunIds.has(data.runId)) throw new Error(`executor runId is already bound or reused: ${data.runId}`);
  const { taskId: _taskId, ...binding } = data;
  task.executorBinding = { ...binding };
  p.executorRunIds.add(data.runId);
}

function validatedExecutorProof(task, data) {
  const binding = task.executorBinding;
  if (!binding) throw new Error("executor terminal proof requires an executor binding");
  requireExactFields(data.executorProof, ["runId", "proofId", "rootSessionId", "observedAt", "outcome"], "executor terminal proof");
  requireNonEmptyStrings({ runId: data.executorProof.runId, proofId: data.executorProof.proofId, rootSessionId: data.executorProof.rootSessionId, outcome: data.executorProof.outcome }, "executor terminal proof");
  if (data.executorProof.runId !== binding.runId) throw new Error("executor terminal proof runId mismatch");
  if (!/^[a-f0-9]{64}$/.test(data.executorProof.proofId)) throw new Error("executor terminal proofId is invalid");
  if (typeof data.executorProof.observedAt !== "number" || !Number.isFinite(data.executorProof.observedAt)) throw new Error("executor terminal observedAt is invalid");
  if (data.executorProof.outcome !== "succeeded") throw new Error("executor terminal proof is not successful");
  return { ...data.executorProof };
}

function taskSettled(p, data, occurredAt, schemaVersion, replay) {
  requireActive(p);
  const { taskId, outcome, evidence, evidenceSource, nextAction } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "dispatched") throw new Error(`task is not dispatched: ${taskId} (${task.status})`);
  if (!["succeeded", "failed", "blocked"].includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);

  validateEvidenceSource(evidenceSource, evidence);
  validateNextAction(nextAction);
  if (outcome === "succeeded") validateEvidence(evidence);
  const executorProof = schemaVersion === PLANNED_SCHEMA_VERSION ? validatedExecutorProof(task, data) : null;

  task.lastSettledOutcome = outcome;
  task.lastExecutorProof = executorProof;
  if (outcome === "succeeded") {
    if (schemaVersion !== "goal-engine.event.v1") {
      const hasAttempt = Object.hasOwn(data, "attempt");
      const hasHead = Object.hasOwn(data, "executorHead");
      if (hasAttempt !== hasHead) throw new Error("settlement identity requires both attempt and executorHead");
      if (hasAttempt) {
        if (!Number.isInteger(data.attempt) || data.attempt < 1 || typeof data.executorHead !== "string" || !data.executorHead) {
          throw new Error("invalid settlement attempt or executorHead");
        }
        const workspace = requireWorkspace(task, data.attempt);
        const executorIdentity = executorProof
          ? { executorRunId: task.executorBinding.runId, terminalProofId: executorProof.proofId }
          : {};
        task.settlement = { attempt: workspace.attempt, executorHead: data.executorHead, ...executorIdentity };
      } else if (!replay) {
        throw new Error("settlement identity requires attempt and executorHead");
      } else {
        task.settlement = null;
      }
    }
    task.status = "succeeded";
    task.evidence.push({ ...evidence, source: evidenceSource || "self_produced", ts: occurredAt });
  } else if (outcome === "failed") {
    task.settlement = null;
    task.status = "pending";
  } else {
    task.settlement = null;
    task.status = "blocked";
    task.blockedReason = data.reason || null;
  }
  p.coordinationState = coordinationStateFor(p);
}

function taskAccepted(p, data, schemaVersion) {
  requireActive(p);
  const { taskId, workspaceAttempt } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "succeeded") throw new Error(`task is not succeeded: ${taskId} (${task.status})`);
  if (schemaVersion !== "goal-engine.event.v1") {
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

function workspaceDispositionStarted(p, data, schemaVersion, replay) {
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
  if (workspace.recovery === "orphaned" && executorHead !== workspace.executorHead) {
    throw new Error("orphan recovery executorHead does not match workspace identity");
  }
  if (task.status === "succeeded") {
    const settlement = task.settlement;
    if (!settlement) {
      if (!replay) throw new Error("settlement identity is required before workspace disposition");
    } else if (settlement.attempt !== attempt || settlement.executorHead !== executorHead) {
      throw new Error("settlement identity does not match workspace disposition");
    }
  }
  if (originRef !== undefined && (typeof originRef !== "string" || !originRef)) throw new Error("originRef must be a non-empty string");
  Object.assign(workspace, { requestedAction, strategy, executorHead, originHeadBefore, ...(originRef ? { originRef, legacyOriginRef: false } : { legacyOriginRef: true }), phase: "disposing" });
}

function workspaceDispositionRebased(p, data, schemaVersion) {
  requireV2(schemaVersion);
  requireExactFields(data, [
    "taskId",
    "attempt",
    "previousOriginHeadBefore",
    "originHeadBefore",
    "originRef",
    "reason",
  ], "workspace disposition rebase data");
  const { taskId, attempt, previousOriginHeadBefore, originHeadBefore, originRef, reason } = data;
  requireNonEmptyStrings({ taskId, previousOriginHeadBefore, originHeadBefore, originRef, reason }, "workspace disposition rebase");
  const workspace = requireWorkspace(requireTask(p, taskId), attempt);
  if (workspace.phase !== "disposing" || workspace.requestedAction !== "integrate") {
    throw new Error("workspace disposition rebase requires disposing integration");
  }
  if (previousOriginHeadBefore !== workspace.originHeadBefore) {
    throw new Error("workspace disposition rebase previous origin head identity mismatch");
  }
  if (originRef !== workspace.originRef) {
    throw new Error("workspace disposition rebase origin ref identity mismatch");
  }
  if (originHeadBefore === previousOriginHeadBefore) {
    throw new Error("workspace disposition rebase must advance to a different origin head");
  }
  if (reason !== "clean-forward-origin-advance") {
    throw new Error("invalid workspace disposition rebase reason");
  }
  workspace.originHeadBefore = originHeadBefore;
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

function workspaceOrphanRecovered(p, data, schemaVersion) {
  requireV2(schemaVersion);
  requireActive(p);
  requireExactFields(data, ["taskId", "attempt", "workspace", "executorHead", "reason"], "orphan recovery data");
  const { taskId, attempt, workspace, executorHead, reason } = data;
  requireNonEmptyStrings({ taskId, executorHead, reason }, "orphan recovery");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("invalid orphan recovery attempt");
  validateRecoveryWorkspace(workspace, attempt);
  const task = requireTask(p, taskId);
  if (task.status !== "pending") throw new Error(`orphan recovery requires pending task: ${taskId}`);
  if (attempt !== task.attempts + 1) throw new Error("orphan recovery attempt must be the next candidate");
  if (!workspaceReleasedForRetry(task)) throw new Error("orphan recovery requires no workspace or a retry-released workspace");
  task.attempts = attempt;
  task.lastSettledOutcome = "failed";
  task.settlement = null;
  task.workspace = { ...workspace, executorHead, phase: "active", recovery: "orphaned" };
}

function workspacePreservationReleased(p, data, schemaVersion) {
  requireV2(schemaVersion);
  requireActive(p);
  requireExactFields(data, ["taskId", "attempt", "executorHead", "released"], "preservation release data");
  const { taskId, attempt, executorHead, released } = data;
  requireNonEmptyStrings({ taskId, executorHead }, "preservation release");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("invalid preservation release attempt");
  if (released !== true) throw new Error("preservation release requires released=true");
  const task = requireTask(p, taskId);
  const workspace = requireWorkspace(task, attempt);
  if (workspace.phase !== "disposed" || workspace.disposition !== "preserved" || workspace.released !== false
    || workspace.preservedResourcesReleased === true) throw new Error("workspace is not an unreleased preservation");
  if (workspace.executorHead !== executorHead) throw new Error("preservation release executorHead mismatch");
  workspace.preservedResourcesReleased = true;
  task.status = "pending";
  task.settlement = null;
  task.lastSettledOutcome = "failed";
  delete task.blockedReason;
}

function requireV2(schemaVersion) {
  if (schemaVersion === "goal-engine.event.v1") throw new Error("workspace disposition events require goal-engine.event.v2 or newer");
}

function requireV3(schemaVersion, eventType) {
  if (schemaVersion !== "goal-engine.event.v3" && schemaVersion !== PLANNED_SCHEMA_VERSION) {
    throw new Error(`${eventType} requires goal-engine.event.v3 or planned.v1`);
  }
}

function requireExactFields(value, fields, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error(`${label} must contain exactly: ${fields.join(", ")}`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireNonEmptyStrings(values, label) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} ${name} must be a non-empty string`);
  }
}

function validateRecoveryWorkspace(workspace, expectedAttempt) {
  requireExactFields(workspace, ["attempt", "path", "branch", "baseCommit", "originRef"], "orphan recovery workspace");
  if (workspace.attempt !== expectedAttempt) throw new Error("workspace attempt mismatch");
  requireNonEmptyStrings({ path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, originRef: workspace.originRef }, "orphan recovery workspace");
}

function validateWorkspace(workspace, expectedAttempt) {
  if (!workspace || typeof workspace !== "object") throw new Error("workspace is required for v2 dispatch");
  if (workspace.attempt !== expectedAttempt) throw new Error("workspace attempt mismatch");
  for (const field of ["path", "branch", "baseCommit"]) if (!workspace[field] || typeof workspace[field] !== "string") throw new Error(`workspace ${field} is required`);
}

function assertWorkspaceRedispatchable(task) {
  if (!task.workspace) return;
  const { phase, disposition, released, preservedResourcesReleased } = task.workspace;
  const isReleasable = phase === "disposed" && ((disposition === "discarded" && released === true)
    || (disposition === "preserved" && preservedResourcesReleased === true));
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

function goalAmended(p, data, schemaVersion, replay) {
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
    acceptance: { ...task.acceptance, criteria: structuredClone(task.acceptance.criteria), ...(task.acceptance.commands ? { commands: [...task.acceptance.commands] } : {}) },
  }]));
  for (const taskId of removeTasks || []) candidate.delete(taskId);
  for (const [taskId, def] of Object.entries(addTasks || {})) {
    if (!def.writePaths || !def.acceptance) throw new Error(`added task ${taskId} must have writePaths and acceptance`);
    candidate.set(taskId, {
      description: def.description, deps: def.deps || [], writePaths: def.writePaths, acceptance: def.acceptance,
      workflow: def.workflow || "tdd", status: "pending", evidence: [], attempts: 0,
      lastSettledOutcome: null, contractHash: null, workspace: null,
      ...(schemaVersion === PLANNED_SCHEMA_VERSION ? { executorBinding: null, lastExecutorProof: null } : {}),
      acceptanceVerification: null, settlement: null,
    });
  }
  for (const [taskId, updates] of Object.entries(updateTasks || {})) {
    const task = candidate.get(taskId);
    if (!task) throw new Error(`cannot update task scheduled for removal: ${taskId}`);
    if (updates.description) task.description = updates.description;
    if (updates.deps) task.deps = updates.deps;
    if (updates.writePaths) task.writePaths = updates.writePaths;
    if (updates.acceptance) task.acceptance = updates.acceptance;
    if (updates.workflow !== undefined) task.workflow = updates.workflow;
  }
  if (schemaVersion === PLANNED_SCHEMA_VERSION) {
    validateTaskDefinitions([...candidate.keys()], Object.fromEntries(candidate), { planned: true });
  } else if (schemaVersion !== "goal-engine.event.v1" && !replay) {
    validateTaskDefinitions([...candidate.keys()], Object.fromEntries(candidate));
  } else {
    validateDAG(candidate);
  }
  if ((schemaVersion === PLANNED_SCHEMA_VERSION) || (schemaVersion !== "goal-engine.event.v1" && !replay)) {
    const candidateProjection = { ...p, tasks: candidate };
    assertPendingTaskContractsCompile(candidateProjection, DISPATCH_VALIDATION_SENTINEL);
  }
  p.tasks = candidate;
}

function workspaceReleasedForRetry(task) {
  const workspace = task.workspace;
  return !workspace || (workspace.phase === "disposed" && ((workspace.disposition === "discarded" && workspace.released === true)
    || (workspace.disposition === "preserved" && workspace.preservedResourcesReleased === true)));
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

function goalSessionBound(p, event, schemaVersion) {
  requireV3(schemaVersion, event.type);
  const { sessionId, leafId } = event.data;
  requireNonEmptyStrings({ sessionId, leafId }, "session binding");
  const existing = p.sessionBindings[0];
  if (existing && existing.sessionId !== sessionId) throw new Error("goal owner session is immutable");
  if (existing) throw new Error("goal owner session binding is immutable");
  p.sessionBindings.push({ sessionId, leafId, state: "watching", boundAt: event.occurredAt });
  p.coordinationState = coordinationStateFor(p);
}

function goalSessionDetached(p, event, schemaVersion) {
  requireV3(schemaVersion, event.type);
  const { sessionId, reason } = event.data;
  requireNonEmptyStrings({ sessionId, reason }, "session detachment");
  const binding = p.sessionBindings.find((candidate) => candidate.sessionId === sessionId);
  if (!binding || binding.state !== "watching") throw new Error(`watching session binding not found: ${sessionId}`);
  Object.assign(binding, { state: "detached", detachedAt: event.occurredAt, reason });
  p.coordinationState = coordinationStateFor(p);
}

function goalDiscoveryRecorded(p, event, schemaVersion) {
  requireV3(schemaVersion, event.type);
  const { id, summary, paths, source, sessionId, userEntryId } = event.data;
  requireNonEmptyStrings({ id, summary, source, sessionId }, "discovery");
  if (!new Set(["user_intent", "mutation_gate", "compaction", "tool_error"]).has(source)) throw new Error(`invalid discovery source: ${source}`);
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path.trim())) throw new Error("discovery paths must be strings");
  if (userEntryId !== undefined && (typeof userEntryId !== "string" || !userEntryId.trim())) throw new Error("discovery userEntryId must be a non-empty string");
  if (Object.hasOwn(p.continuity.observations, id)) throw new Error(`discovery already exists: ${id}`);
  p.continuity.observations[id] = {
    id, summary: summary.trim(), paths: [...new Set(paths.map((path) => path.trim()))], source,
    status: "untriaged", taskId: null, sessionId, userEntryId: userEntryId || null,
    observedAt: event.occurredAt, resolvedAt: null, reason: null,
  };
  p.coordinationState = "needs_triage";
}

function goalDiscoveryResolved(p, event, schemaVersion) {
  requireV3(schemaVersion, event.type);
  const { id, disposition, taskId, reason } = event.data;
  requireNonEmptyStrings({ id, disposition, reason }, "discovery resolution");
  if (!new Set(["tasked", "out_of_scope", "duplicate", "new_goal"]).has(disposition)) throw new Error(`invalid discovery disposition: ${disposition}`);
  const observation = p.continuity.observations[id];
  if (!observation) throw new Error(`unknown discovery: ${id}`);
  if (observation.status !== "untriaged") throw new Error(`discovery is already resolved: ${id}`);
  if (disposition === "tasked") requireNonEmptyStrings({ taskId }, "tasked discovery");
  if (disposition !== "tasked" && taskId !== undefined) throw new Error(`${disposition} discovery cannot name a task`);
  Object.assign(observation, {
    status: disposition,
    taskId: disposition === "tasked" ? taskId : null,
    reason: reason.trim(),
    resolvedAt: event.occurredAt,
  });
  p.coordinationState = coordinationStateFor(p);
}

function goalContinuityCheckpointed(p, event, schemaVersion) {
  requireV3(schemaVersion, event.type);
  const { sessionId, reason, modifiedFiles, nextAction } = event.data;
  requireNonEmptyStrings({ sessionId, reason }, "continuity checkpoint");
  if (!new Set(["manual", "threshold", "overflow", "reload", "shutdown"]).has(reason)) throw new Error(`invalid checkpoint reason: ${reason}`);
  if (!Array.isArray(modifiedFiles) || modifiedFiles.some((path) => typeof path !== "string" || !path.trim())) throw new Error("checkpoint modifiedFiles must be strings");
  validateNextAction(nextAction);
  p.checkpointCount++;
  p.nextAction = nextAction;
  p.continuity.lastCheckpoint = {
    checkpointId: event.eventId,
    sessionId,
    reason,
    modifiedFiles: [...new Set(modifiedFiles.map((path) => path.trim()))],
    nextAction,
    occurredAt: event.occurredAt,
  };
}

function goalActionOffered(p, data, schemaVersion) {
  requireV3(schemaVersion, "goal.action_offered");
  requireNonEmptyStrings({
    id: data.id, nonce: data.nonce, goalId: data.goalId, sessionId: data.sessionId,
    tool: data.tool, token: data.token,
  }, "action offer");
  if (data.goalId !== p.goalId) throw new Error("action offer goalId mismatch");
  if (data.projectionVersion !== p.version + 1) throw new Error("action offer projection version mismatch");
  if (!isPlainObject(data.params)) throw new Error("action offer params must be an object");
  if (data.consumed !== false) throw new Error("new action offer must be unconsumed");
  if (!/^goal-action\.v1:[a-f0-9]{64}$/.test(data.token)) throw new Error("invalid action offer token");
  p.actionOffer = structuredClone(data);
}

function goalActionConsumed(p, data, schemaVersion) {
  requireV3(schemaVersion, "goal.action_consumed");
  const offer = p.actionOffer;
  if (!offer) throw new Error("no action offer is active");
  if (offer.consumed) throw new Error("action offer is already consumed");
  if (p.version !== offer.projectionVersion) throw new Error("action offer projection version is stale");
  requireNonEmptyStrings({ offerId: data.offerId, token: data.token, tool: data.tool, sessionId: data.sessionId }, "action consumption");
  if (data.offerId !== offer.id || data.token !== offer.token || data.tool !== offer.tool || data.sessionId !== offer.sessionId) {
    throw new Error("action consumption does not match the active offer");
  }
  offer.consumed = true;
}

function goalReopened(p, data, schemaVersion) {
  requireV3(schemaVersion, "goal.reopened");
  if (p.lifecycle !== "completed") throw new Error(`goal must be completed before reopen: ${p.lifecycle}`);
  const { reason, observationIds } = data;
  if (typeof reason !== "string" || reason.trim().length < 10) throw new Error("reopen reason must be at least 10 characters");
  if (!Array.isArray(observationIds) || observationIds.length === 0 || new Set(observationIds).size !== observationIds.length) {
    throw new Error("reopen requires unique observationIds");
  }
  for (const [taskId, task] of p.tasks) {
    if (task.status !== "accepted" && task.status !== "superseded") throw new Error(`historical task is not accepted: ${taskId} (${task.status})`);
  }
  for (const id of observationIds) {
    const observation = p.continuity.observations[id];
    if (!observation || observation.status !== "tasked" || !observation.taskId) {
      throw new Error(`reopen discovery must be resolved as tasked: ${id}`);
    }
  }
  p.lifecycle = "active";
  p.epoch++;
  p.completionVerdict = null;
  p.blockedReason = null;
  p.nextAction = null;
  p.actionOffer = null;
  p.coordinationState = "ready";
}

function goalContractAmended(p, data, schemaVersion) {
  requireV3(schemaVersion, "goal.contract_amended");
  requireActive(p);
  const { proposalHash, approval, changes } = data;
  if (typeof proposalHash !== "string" || !/^[a-f0-9]{64}$/.test(proposalHash)) throw new Error("proposalHash must be a SHA-256 hash");
  if (!isPlainObject(approval)) throw new Error("real user approval identity is required");
  requireNonEmptyStrings({ entryId: approval.entryId, sessionId: approval.sessionId, source: approval.source }, "approval");
  if (!new Set(["interactive", "rpc"]).has(approval.source)) throw new Error("approval source must be interactive or rpc");
  if (!isPlainObject(changes) || Object.keys(changes).length === 0) throw new Error("contract changes are required");
  const allowed = new Set(["objective", "scope", "nonGoals", "dod"]);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new Error("contract changes contain an unknown field");
  if (Object.hasOwn(changes, "objective") && (typeof changes.objective !== "string" || !changes.objective.trim())) throw new Error("objective must be a non-empty string");
  for (const key of ["scope", "nonGoals", "dod"]) {
    if (Object.hasOwn(changes, key) && (!Array.isArray(changes[key]) || changes[key].some((value) => typeof value !== "string" || !value.trim()))) {
      throw new Error(`${key} must be an array of non-empty strings`);
    }
  }
  const previous = { objective: p.objective, scope: [...p.scope], nonGoals: [...p.nonGoals], dod: [...p.dod] };
  if (Object.hasOwn(changes, "objective")) p.objective = changes.objective.trim();
  for (const key of ["scope", "nonGoals", "dod"]) if (Object.hasOwn(changes, key)) p[key] = [...changes[key]];
  const updated = { objective: p.objective, scope: [...p.scope], nonGoals: [...p.nonGoals], dod: [...p.dod] };
  assertPendingTaskContractsCompile(p, DISPATCH_VALIDATION_SENTINEL);
  p.contractHistory.push({ proposalHash, approval: { entryId: approval.entryId, sessionId: approval.sessionId, source: approval.source }, previous, updated });
}

function taskBlockResolved(p, data, schemaVersion) {
  requireV3(schemaVersion, "task.block_resolved");
  requireActive(p);
  const { taskId, resolution, replacementTaskId, reason } = data;
  requireNonEmptyStrings({ taskId, resolution, reason }, "blocked task resolution");
  const task = requireTask(p, taskId);
  if (task.status !== "blocked") throw new Error(`task is not blocked: ${taskId} (${task.status})`);
  if (!workspaceReleasedForRetry(task)) throw new Error(`blocked task workspace must be released before recovery: ${taskId}`);
  if (resolution === "retry") {
    if (replacementTaskId !== undefined) throw new Error("retry cannot name a replacement task");
    task.status = "pending";
    task.lastSettledOutcome = "failed";
    task.settlement = null;
    delete task.blockedReason;
  } else if (resolution === "supersede") {
    requireNonEmptyStrings({ replacementTaskId }, "superseded task");
    if (p.tasks.has(replacementTaskId)) throw new Error(`replacement task already exists: ${replacementTaskId}`);
    task.status = "superseded";
    task.supersededBy = replacementTaskId;
    task.supersededReason = reason.trim();
  } else {
    throw new Error(`invalid blocked task resolution: ${resolution}`);
  }
  p.coordinationState = coordinationStateFor(p);
}

function coordinationStateFor(p) {
  if (Object.values(p.continuity?.observations || {}).some((observation) => observation.status === "untriaged")) return "needs_triage";
  if (p.lifecycle === "completed") return p.sessionBindings.some((binding) => binding.state === "watching") ? "watching" : "quiescent";
  if ([...p.tasks.values()].some((task) => task.status === "blocked")) return "blocked";
  return "ready";
}

function goalBlocked(p, data) {
  requireActive(p);
  const { reason } = data;
  if (!reason || typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  p.lifecycle = "blocked";
  p.blockedReason = reason;
  p.coordinationState = "blocked";
}

function goalCompleted(p, data, occurredAt, eventVersion) {
  requireActive(p);
  const { verdict } = data;
  if (!["COMPLETE", "DONE_WITHOUT_EXTERNAL_VERIFICATION"].includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  for (const [taskId, task] of p.tasks) {
    if (task.status !== "accepted" && task.status !== "superseded") throw new Error(`task not accepted: ${taskId} (${task.status})`);
  }
  p.lifecycle = "completed";
  p.completionVerdict = verdict;
  p.nextAction = null;
  p.blockedReason = null;
  p.actionOffer = null;
  p.completionHistory.push({ epoch: p.epoch, verdict, completedAt: occurredAt, eventVersion });
  p.coordinationState = coordinationStateFor(p);
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
