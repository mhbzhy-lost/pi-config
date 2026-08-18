import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { validateDAG } from "./graph.mjs";
import { validateTaskDefinitions, taskContractHash, remediationSubjectHash } from "./task-definition.mjs";
import { assertPendingTaskContractsCompile, DISPATCH_VALIDATION_SENTINEL } from "./dispatch.mjs";
import { assertIndependentSettlementEvidence, fingerprintSettlementEvidence, normalizeSettlementEvidence } from "./settlement-evidence.mjs";
import { generationCapabilities } from "./generation-capabilities.mjs";
import { deriveInitialShape, hashRuntimeExecutionContract, normalizeRuntimeGoalInit } from "./obligation-contract.mjs";

const LEGACY_SCHEMA_VERSIONS = new Set(["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3"]);
export const PLANNED_SCHEMA_VERSION = "planned.v1";
export const RUNTIME_SCHEMA_VERSION = "goal-runtime.v1";
const SCHEMA_VERSIONS = new Set([...LEGACY_SCHEMA_VERSIONS, PLANNED_SCHEMA_VERSION, RUNTIME_SCHEMA_VERSION]);
const SCHEMA_RANK = new Map([["goal-engine.event.v1", 1], ["goal-engine.event.v2", 2], ["goal-engine.event.v3", 3]]);

export function schemaVersionForMutation(projection, legacyTargetVersion = "goal-engine.event.v3") {
  const current = projection?.eventSchemaVersion;
  if (!current || current === PLANNED_SCHEMA_VERSION) return PLANNED_SCHEMA_VERSION;
  if (current === RUNTIME_SCHEMA_VERSION) return RUNTIME_SCHEMA_VERSION;
  if (!LEGACY_SCHEMA_VERSIONS.has(current)) throw new Error(`unknown event generation: ${current}`);
  if (!LEGACY_SCHEMA_VERSIONS.has(legacyTargetVersion)) throw new Error(`invalid legacy mutation generation: ${legacyTargetVersion}`);
  return SCHEMA_RANK.get(legacyTargetVersion) >= SCHEMA_RANK.get(current) ? legacyTargetVersion : current;
}
const DISPOSITION_ACTIONS = new Set(["integrate", "discard", "preserve"]);
const TERMINAL_LIFECYCLES = new Set(["completed", "blocked", "cancelled"]);
const COMPLETED_V3_EVENTS = new Set([
  "goal.session_bound", "goal.session_detached", "goal.session_transferred", "goal.discovery_recorded", "goal.discovery_resolved",
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
    ownershipRevision: 1,
    runtimeGeneration: null,
    initialShape: null,
    executionRevision: null,
    executionContractHash: null,
    readiness: null,
    runtimeReadinessReasons: [],
    runtimeBaseHead: null,
    runtimeApproval: null,
    runtimeState: null,
    progressLedger: [],
    writePolicy: null,
    taskApplicability: new Map(),
    conditions: new Map(),
    observationRuns: new Map(),
    findings: new Map(),
    repairEpisodes: new Map(),
    repairChallenges: new Map(),
    suspension: null,
    convergenceBudget: null,
    evidenceHistory: [],
    mutationSequence: 0,
    taskMutationSequences: new Map(),
    finalReview: null,
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
  if (!next.eventSchemaVersion || (SCHEMA_RANK.has(event.schemaVersion) && SCHEMA_RANK.get(event.schemaVersion) > SCHEMA_RANK.get(next.eventSchemaVersion))) {
    next.eventSchemaVersion = event.schemaVersion;
  }
  switch (event.type) {
    case "goal.created": goalCreated(next, event, replay); break;
    case "goal.runtime_drafted": runtimeDrafted(next, event); break;
    case "goal.runtime_readiness_recorded": runtimeReadinessRecorded(next, event.data); break;
    case "goal.runtime_approval_recorded": runtimeApprovalRecorded(next, event.data); break;
    case "goal.runtime_activated": runtimeActivated(next); break;
    case "goal.runtime_suspended": runtimeSuspended(next, event.data); break;
    case "goal.runtime_resumed": runtimeResumed(next, event.data); break;
    case "condition.observation_requested": observationRequested(next, event.data); break;
    case "condition.observation_lease_allocated": observationTransition(next, event.data, "requested", "lease_allocated"); break;
    case "condition.observation_process_bound": observationTransition(next, event.data, "lease_allocated", "process_bound"); break;
    case "condition.observation_terminal": observationTransition(next, event.data, "process_bound", "terminal"); break;
    case "condition.observation_recorded": observationRecorded(next, event.data); break;
    case "condition.observation_released": observationTransition(next, event.data, "recorded", "released"); break;
    case "condition.evidence_invalidated": evidenceInvalidated(next, event.data); break;
    case "finding.recorded": findingRecorded(next, event.data); break;
    case "finding.status_changed": findingStatusChanged(next, event.data); break;
    case "repair.episode_opened": repairOpened(next, event.data); break;
    case "repair.task_linked": repairTaskLinked(next, event.data); break;
    case "repair.reverification_requested": repairReverificationRequested(next, event.data); break;
    case "repair.episode_resolved": repairResolved(next, event.data); break;
    case "repair.observation_linked": repairObservationLinked(next, event.data); break;
    case "repair.challenge_created": repairChallengeCreated(next, event.data); break;
    case "repair.user_decision_recorded": repairUserDecisionRecorded(next, event.data); break;
    case "repair.capability_consumed": repairCapabilityConsumed(next, event.data); break;
    case "repair.episode_rejected_by_user": repairRejectedByUser(next, event.data); break;
    case "repair.episode_cancel_requested": repairCancelRequested(next, event.data); break;
    case "repair.episode_cancelled": repairCancelled(next, event.data); break;
    case "task.applicability_changed": taskApplicabilityChanged(next, event.data); break;
    case "execution.amendment_proposed": amendmentProposed(next, event.data); break;
    case "execution.amendment_approved": amendmentApproved(next, event.data); break;
    case "execution.amendment_capability_consumed": amendmentCapabilityConsumed(next, event.data); break;
    case "execution.amendment_applied": amendmentApplied(next, event.data); break;
    case "goal.final_review_started": finalReviewStarted(next, event.data); break;
    case "goal.final_review_recorded": finalReviewRecorded(next, event.data); break;
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
    case "goal.session_transferred": goalSessionTransferred(next, event, event.schemaVersion); break;
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
  generationCapabilities(event.schemaVersion);
  if (!projection.eventSchemaVersion) {
    if (event.schemaVersion !== PLANNED_SCHEMA_VERSION && event.schemaVersion !== RUNTIME_SCHEMA_VERSION && !replay) throw new Error("legacy event generations are replay-only");
    return;
  }
  // Runtime is an independent persisted codec. Historical v1/v2/v3 retain their
  // rank-based upgrade replay behaviour, while planned remains isolated.
  if (projection.eventSchemaVersion === RUNTIME_SCHEMA_VERSION || event.schemaVersion === RUNTIME_SCHEMA_VERSION) {
    if (event.schemaVersion !== projection.eventSchemaVersion) throw new Error(`mixed event generations are not allowed: ${projection.eventSchemaVersion} and ${event.schemaVersion}`);
  } else if (projection.eventSchemaVersion === PLANNED_SCHEMA_VERSION || event.schemaVersion === PLANNED_SCHEMA_VERSION) {
    if (event.schemaVersion !== projection.eventSchemaVersion) throw new Error(`mixed event generations are not allowed: ${projection.eventSchemaVersion} and ${event.schemaVersion}`);
  }
}

function validateGoalIdentity(projection, event) {
  if (projection.goalId === null) {
    if (event.type !== "goal.created" && event.type !== "goal.runtime_drafted") throw new Error("goal.created must be first");
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
    ...(task.metadata ? { metadata: structuredClone(task.metadata) } : {}),
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
    ownershipRevision: p.ownershipRevision || 1,
    runtimeGeneration: p.runtimeGeneration,
    initialShape: p.initialShape,
    executionRevision: p.executionRevision,
    executionContractHash: p.executionContractHash,
    readiness: p.readiness,
    runtimeState: p.runtimeState,
    writePolicy: p.writePolicy ? structuredClone(p.writePolicy) : null,
    taskApplicability: new Map([...p.taskApplicability || []].map(([id, value]) => [id, structuredClone(value)])),
    conditions: new Map([...p.conditions || []].map(([id, value]) => [id, structuredClone(value)])),
    observationRuns: new Map([...p.observationRuns || []].map(([id, value]) => [id, structuredClone(value)])),
    findings: new Map([...p.findings || []].map(([id, value]) => [id, structuredClone(value)])),
    repairEpisodes: new Map([...p.repairEpisodes || []].map(([id, value]) => [id, structuredClone(value)])),
    repairChallenges: new Map([...p.repairChallenges || []].map(([id, value]) => [id, structuredClone(value)])),
    suspension: p.suspension ? structuredClone(p.suspension) : null,
    convergenceBudget: p.convergenceBudget ? structuredClone(p.convergenceBudget) : null,
    evidenceHistory: structuredClone(p.evidenceHistory || []),
    mutationSequence: p.mutationSequence || 0,
    taskMutationSequences: new Map([...p.taskMutationSequences || []]),
    finalReview: p.finalReview ? structuredClone(p.finalReview) : null,
    runtimeReadinessReasons: [...(p.runtimeReadinessReasons || [])],
    runtimeApproval: p.runtimeApproval ? structuredClone(p.runtimeApproval) : null,
    progressLedger: structuredClone(p.progressLedger || []),
  };
}

function runtimeOnly(p) {
  if (!generationCapabilities(p.eventSchemaVersion).conditions) throw new Error("runtime event requires goal-runtime.v1");
}
function runtimeDrafted(p, event) {
  if (p.goalId !== null) throw new Error("runtime draft must be first event");
  const data = event.data;
  if (!isPlainObject(data.runtimeInit) || typeof data.executionContractHash !== "string" || !/^[a-f0-9]{64}$/.test(data.executionContractHash) || !/^[a-f0-9]{40}$/.test(data.baseHead || "")) throw new Error("invalid runtime draft");
  const contract = data.runtimeInit;
  if (contract.execution?.schema !== RUNTIME_SCHEMA_VERSION || !Array.isArray(contract.execution.tasks) || !Array.isArray(contract.execution.conditions)) throw new Error("invalid runtime contract");
  p.goalId = event.goalId; p.eventSchemaVersion = RUNTIME_SCHEMA_VERSION; p.lifecycle = "active";
  p.objective = contract.objective; p.scope = [...(contract.scope || [])]; p.nonGoals = [...(contract.non_goals || [])]; p.dod = [...(contract.dod || [])];
  p.createdAt = event.occurredAt; p.coordinationState = "ready"; p.runtimeGeneration = RUNTIME_SCHEMA_VERSION;
  p.initialShape = deriveInitialShape(contract); p.executionRevision = 1; p.executionContractHash = data.executionContractHash; p.runtimeBaseHead = data.baseHead;
  p.readiness = "draft"; p.runtimeState = "draft";
  p.writePolicy = { allowedPaths: [...contract.execution.write_policy.allowed_paths] };
  p.convergenceBudget = structuredClone(contract.execution.budgets);
  for (const definition of contract.execution.tasks) {
    if (p.tasks.has(definition.id)) throw new Error(`duplicate runtime task: ${definition.id}`);
    p.tasks.set(definition.id, { description: definition.description, deps: [...(definition.deps || [])], writePaths: [...definition.writePaths], acceptance: { criteria: structuredClone(definition.acceptance.criteria) }, workflow: definition.workflow || "tdd", status: "pending", evidence: [], attempts: 0, lastSettledOutcome: null, contractHash: null, workspace: null, executorBinding: null, lastExecutorProof: null, acceptanceVerification: null, settlement: null });
    p.taskApplicability.set(definition.id, { revision: 1, state: "applicable", reason: null });
    p.taskMutationSequences.set(definition.id, 0);
  }
  for (const definition of contract.execution.conditions) p.conditions.set(definition.id, { definition: structuredClone(definition), conditionHash: hashCanonical(definition), status: "inactive", supportingEvidenceIds: [], lastObservationRunId: null, invalidationReason: null });
}
function runtimeReadinessRecorded(p, data) { runtimeOnly(p); requireExactFields(data, ["readiness", "reasons"], "runtime readiness"); if (!new Set(["ready", "needs_clarification", "environment_blocked", "unsafe_to_run"]).has(data.readiness) || !Array.isArray(data.reasons) || data.reasons.some((reason) => typeof reason !== "string")) throw new Error("invalid runtime readiness"); p.readiness = data.readiness; p.runtimeReadinessReasons = [...data.reasons]; if (data.readiness === "ready" && p.runtimeState === "draft") p.runtimeState = "awaiting_user_approval"; }
function runtimeApprovalRecorded(p, data) { runtimeOnly(p); requireExactFields(data, ["proposalId", "proposalHash", "executionContractHash", "baseHead", "sessionId", "userEntryId", "capabilityDigest"], "runtime approval"); const canonicalProposalHash = hashCanonical({ goalId: p.goalId, proposalId: data.proposalId, executionContractHash: data.executionContractHash, baseHead: data.baseHead, sessionId: data.sessionId }); const ownerSessionId = [...p.sessionBindings].reverse().find((binding) => binding.state !== "transferred")?.sessionId; if (p.runtimeState !== "awaiting_user_approval" || (p.sessionBindings.length > 0 && data.sessionId !== ownerSessionId) || data.executionContractHash !== p.executionContractHash || data.baseHead !== p.runtimeBaseHead || data.proposalHash !== canonicalProposalHash || !hash(data.capabilityDigest) || !data.proposalId || !data.sessionId || !data.userEntryId) throw new Error("runtime approval is out of order or not owned by the event-sourced session"); p.runtimeApproval = { ...structuredClone(data), phase: "consumed" }; p.runtimeState = "calibrating"; }
function runtimeActivated(p) { runtimeOnly(p); if (p.runtimeState !== "calibrating") throw new Error("runtime activation is out of order"); for (const [conditionId, condition] of p.conditions) { const candidates = p.evidenceHistory.filter((value) => { const run = p.observationRuns.get(value.run?.runId); return run?.conditionId === conditionId && run.cycle === 0 && ["recorded", "released"].includes(run.phase) && value.executionRevision === p.executionRevision; }); const evidence = candidates.sort((a, b) => b.sequence - a.sequence)[0]; if (!evidence || !["passed", "failed"].includes(evidence.verdict?.kind)) throw new Error("runtime activation requires decidable cycle zero calibration"); condition.status = "inactive"; condition.supportingEvidenceIds = []; } p.runtimeState = "active"; }
const SUSPENSION_INITIAL_FIELDS = ["suspensionId", "reason", "affectedTaskIds", "affectedRunIds", "requestedAt", "resourcesQuarantined"];
const SUSPENSION_CLOSURE_FIELDS = [...SUSPENSION_INITIAL_FIELDS, "terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs"];
const suspensionIdsAreCanonical = (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(id)) && new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1] < id);
const canonicalRefs = (refs, id) => Array.isArray(refs) && refs.every((ref, index) => index === 0 || refs[index - 1][id] < ref[id]);
const sameCanonical = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function validInitialSuspension(data) {
  const requestedAt = new Date(data.requestedAt);
  return typeof data.suspensionId === "string" && !!data.suspensionId
    && new Set(["interactive_steer", "follow_up", "abort", "execution_amendment", "host_pause"]).has(data.reason)
    && suspensionIdsAreCanonical(data.affectedTaskIds) && suspensionIdsAreCanonical(data.affectedRunIds)
    && typeof data.requestedAt === "string" && Number.isFinite(requestedAt.getTime()) && requestedAt.toISOString() === data.requestedAt;
}
function isFullSuspensionClosure(data) {
  return data.terminalProofRefs.length === data.affectedRunIds.length
    && data.workspaceClosureProofRefs.length === data.affectedTaskIds.length
    && data.resourceClosureProofRefs.length === data.affectedRunIds.length;
}
function validSuspensionClosure(p, previous, data) {
  if (!SUSPENSION_INITIAL_FIELDS.filter((field) => field !== "resourcesQuarantined").every((field) => sameCanonical(data[field], previous[field])) || typeof data.resourcesQuarantined !== "boolean" || (previous.resourcesQuarantined && !data.resourcesQuarantined)) return false;
  const validRefs = (refs, ids, id, fields, check) => canonicalRefs(refs, id) && refs.every((ref) => isPlainObject(ref) && Object.keys(ref).length === fields.length && fields.every((field) => Object.hasOwn(ref, field)) && ids.includes(ref[id]) && check(ref)) && new Set(refs.map((ref) => ref[id])).size === refs.length;
  const terminal = validRefs(data.terminalProofRefs, data.affectedRunIds, "runId", ["runId", "proofHash", "state"], (ref) => hash(ref.proofHash) && ref.state === "observed");
  const workspace = validRefs(data.workspaceClosureProofRefs, data.affectedTaskIds, "taskId", ["taskId", "attempt", "proofHash", "state", "disposition"], (ref) => Number.isSafeInteger(ref.attempt) && ref.attempt === p.tasks.get(ref.taskId)?.attempts && hash(ref.proofHash) && ((ref.state === "quarantined" && ref.disposition === "preserved") || (ref.state === "released" && ref.disposition === "discarded")));
  const resource = validRefs(data.resourceClosureProofRefs, data.affectedRunIds, "ownerId", ["ownerId", "proofHash", "state", "debt"], (ref) => hash(ref.proofHash) && ((ref.state === "quarantined" && ref.debt === true) || (ref.state === "released" && ref.debt === false)));
  const monotonic = (refs, oldRefs, id) => oldRefs.every((old) => refs.some((ref) => ref[id] === old[id] && sameCanonical(ref, old))) && refs.length >= oldRefs.length;
  return terminal && workspace && resource
    && monotonic(data.terminalProofRefs, previous.terminalProofRefs || [], "runId")
    && monotonic(data.workspaceClosureProofRefs, previous.workspaceClosureProofRefs || [], "taskId")
    && monotonic(data.resourceClosureProofRefs, previous.resourceClosureProofRefs || [], "ownerId")
    && (data.terminalProofRefs.length + data.workspaceClosureProofRefs.length + data.resourceClosureProofRefs.length > (previous.terminalProofRefs?.length || 0) + (previous.workspaceClosureProofRefs?.length || 0) + (previous.resourceClosureProofRefs?.length || 0) || (!Object.hasOwn(previous, "terminalProofRefs") && isFullSuspensionClosure(data)))
    && (!data.resourcesQuarantined || isFullSuspensionClosure(data));
}
function runtimeSuspended(p, data) {
  runtimeOnly(p);
  if (p.runtimeState === "active") {
    requireExactFields(data, SUSPENSION_INITIAL_FIELDS, "runtime suspension");
    if (!validInitialSuspension(data) || data.resourcesQuarantined !== false) throw new Error("invalid runtime suspension");
    p.suspension = structuredClone(data); p.runtimeState = "suspended"; p.actionOffer = null;
    return;
  }
  requireExactFields(data, SUSPENSION_CLOSURE_FIELDS, "runtime suspension closure");
  if (p.runtimeState !== "suspended" || !p.suspension || !validSuspensionClosure(p, p.suspension, data)) throw new Error("invalid runtime suspension closure");
  p.suspension = structuredClone(data);
}
function runtimeResumed(p, data) {
  runtimeOnly(p); requireExactFields(data, ["suspensionId", "closureHash"], "runtime resume");
  if (p.runtimeState !== "suspended" || !p.suspension || !isFullSuspensionClosure(p.suspension) || data.suspensionId !== p.suspension.suspensionId || data.closureHash !== suspensionClosureHash(p.suspension)) throw new Error("invalid runtime resume closure");
  p.suspension = null; p.runtimeState = "active";
}
function observationRequested(p, data) { runtimeOnly(p); requireExactFields(data, ["runId", "conditionId", "cycle", "head", "executionRevision", "executionContractHash", "conditionHash", "adapter", "worldSnapshotHash", "resourceClaimsHash"], "observation request"); const condition = p.conditions.get(data.conditionId); if (!condition || p.observationRuns.has(data.runId) || typeof data.runId !== "string" || !data.runId || !Number.isSafeInteger(data.cycle) || data.cycle < 0 || !/^[a-f0-9]{40}$/.test(data.head) || data.executionRevision !== p.executionRevision || data.executionContractHash !== p.executionContractHash || data.conditionHash !== condition.conditionHash || !hash(data.worldSnapshotHash) || !hash(data.resourceClaimsHash) || (p.runtimeState === "calibrating" ? data.cycle !== 0 || data.head !== p.runtimeBaseHead : p.runtimeState === "active" ? data.cycle < 1 : true)) throw new Error("invalid observation request"); requireExactFields(data.adapter, ["ref", "version"], "observation adapter"); if (data.adapter.ref !== condition.definition.oracle_ref || typeof data.adapter.version !== "string" || !data.adapter.version) throw new Error("invalid observation request"); const run = { runId: data.runId, conditionId: data.conditionId, cycle: data.cycle, head: data.head, executionRevision: data.executionRevision, executionContractHash: data.executionContractHash, conditionHash: data.conditionHash, adapter: structuredClone(data.adapter), worldSnapshotHash: data.worldSnapshotHash, resourceClaimsHash: data.resourceClaimsHash, phase: "requested", allocationId: null, leaseReceiptHash: null, processIdentityHash: null, terminalProofHash: null, evidenceId: null, releaseReceiptHash: null }; p.observationRuns.set(data.runId, run); condition.status = "observing"; condition.lastObservationRunId = data.runId; }
function observationTransition(p, data, from, to) { runtimeOnly(p); const fields = to === "lease_allocated" ? ["runId", "conditionId", "allocationId", "leaseReceiptHash"] : to === "process_bound" ? ["runId", "conditionId", "processIdentityHash"] : to === "terminal" ? ["runId", "conditionId", "terminalProofHash"] : ["runId", "conditionId", "releaseReceiptHash"]; requireExactFields(data, fields, "observation transition"); const run = p.observationRuns.get(data.runId); if (!run || run.conditionId !== data.conditionId || run.phase !== from) throw new Error("invalid observation phase"); if (to === "lease_allocated" && (typeof data.allocationId !== "string" || !data.allocationId || !hash(data.leaseReceiptHash))) throw new Error("invalid observation lease proof"); if (to === "process_bound" && !hash(data.processIdentityHash)) throw new Error("invalid observation process identity"); if (to === "terminal" && !hash(data.terminalProofHash)) throw new Error("invalid observation terminal proof"); if (to === "released" && !hash(data.releaseReceiptHash)) throw new Error("invalid observation release proof"); Object.assign(run, { phase: to, ...(to === "lease_allocated" ? { allocationId: data.allocationId, leaseReceiptHash: data.leaseReceiptHash } : {}), ...(to === "process_bound" ? { processIdentityHash: data.processIdentityHash } : {}), ...(to === "terminal" ? { terminalProofHash: data.terminalProofHash } : {}), ...(to === "released" ? { releaseReceiptHash: data.releaseReceiptHash } : {}) }); }
function observationRecorded(p, data) {
  runtimeOnly(p); requireExactFields(data, ["runId", "conditionId", "evidenceId", "verdict", "evidence"], "observation record");
  const run = p.observationRuns.get(data.runId), condition = p.conditions.get(data.conditionId);
  if (!run || !condition || run.conditionId !== data.conditionId || run.phase !== "terminal" || !hash(data.evidenceId)) throw new Error("invalid observation record");
  const verdict = validateObservationVerdict(data.verdict), summary = validateEvidenceSummary(data.evidence, p, condition, run);
  if (p.evidenceHistory.some((entry) => entry.evidenceId === data.evidenceId)) throw new Error("duplicate observation evidence");
  run.phase = "recorded"; run.evidenceId = data.evidenceId;
  // Cycle zero calibrates adapter/environment decidability only; it never supports product Conditions.
  if (run.cycle === 0) { condition.supportingEvidenceIds = []; condition.status = "inactive"; }
  else if (verdict.kind !== "passed") { condition.supportingEvidenceIds = []; condition.status = "blocked"; }
  else { const policy = condition.definition.stability; condition.supportingEvidenceIds = policy.mode === "single" ? [data.evidenceId] : [...condition.supportingEvidenceIds, data.evidenceId].slice(-policy.count); condition.status = policy.mode === "single" || condition.supportingEvidenceIds.length === policy.count ? "satisfied" : "observing"; }
  p.evidenceHistory.push({ ...summary, run: { runId: run.runId, state: "terminal" }, terminalProofHash: run.terminalProofHash, conditionId: run.conditionId, evidenceId: data.evidenceId, verdict, sequence: p.evidenceHistory.length + 1, mutationSequence: p.mutationSequence });
}
function validateObservationVerdict(value) {
  if (!isPlainObject(value) || typeof value.kind !== "string") throw new Error("invalid observation verdict");
  if (value.kind === "passed") requireExactFields(value, ["kind"], "passed verdict");
  else if (value.kind === "failed") { requireExactFields(value, ["kind", "failureCode", "findingFingerprint"], "failed verdict"); if (typeof value.failureCode !== "string" || !value.failureCode || !hash(value.findingFingerprint)) throw new Error("invalid failed verdict"); }
  else if (value.kind === "inconclusive") { requireExactFields(value, ["kind", "reason"], "inconclusive verdict"); if (typeof value.reason !== "string" || !value.reason) throw new Error("invalid inconclusive verdict"); }
  else if (value.kind === "infrastructure_error") { requireExactFields(value, ["kind", "reason"], "infrastructure verdict"); if (typeof value.reason !== "string" || !value.reason) throw new Error("invalid infrastructure verdict"); }
  else throw new Error("invalid observation verdict");
  return structuredClone(value);
}
function validateEvidenceSummary(value, p, condition, run) {
  requireExactFields(value, ["executionRevision", "executionContractHash", "conditionHash", "head", "adapter", "environment", "fixtures", "artifact"], "observation evidence");
  if (value.executionRevision !== p.executionRevision || value.executionContractHash !== p.executionContractHash || value.conditionHash !== condition.conditionHash || !/^[a-f0-9]{40}$/.test(value.head)) throw new Error("observation evidence identity mismatch");
  requireExactFields(value.adapter, ["ref", "version"], "observation adapter"); requireExactFields(value.environment, ["ref", "fingerprint"], "observation environment"); requireExactFields(value.artifact, ["id", "hash"], "observation artifact");
  if (value.adapter.ref !== condition.definition.oracle_ref || value.environment.ref !== condition.definition.environment_ref || ![value.adapter.version, value.environment.fingerprint, value.artifact.id].every((x) => typeof x === "string" && x) || !hash(value.artifact.hash) || !Array.isArray(value.fixtures) || value.fixtures.length !== condition.definition.fixture_refs.length) throw new Error("observation evidence identity mismatch");
  for (let i = 0; i < value.fixtures.length; i++) { const fixture = value.fixtures[i]; requireExactFields(fixture, ["ref", "fingerprint"], "observation fixture"); if (fixture.ref !== condition.definition.fixture_refs[i] || typeof fixture.fingerprint !== "string" || !fixture.fingerprint) throw new Error("observation evidence identity mismatch"); }
  if (!hash(run.terminalProofHash)) throw new Error("observation terminal proof mismatch");
  return structuredClone(value);
}
function evidenceInvalidated(p, data) { runtimeOnly(p); const condition = p.conditions.get(data.conditionId); if (!condition) throw new Error("unknown condition"); condition.status = "stale"; condition.invalidationReason = data.reason || null; }
function findingRecorded(p, data) { runtimeOnly(p); requireExactFields(data, ["findingId", "conditionId", "runId", "evidenceId", "fingerprint"], "finding record"); const run = p.observationRuns.get(data.runId), evidence = p.evidenceHistory.find((entry) => entry.run.runId === data.runId && entry.evidenceId === data.evidenceId); if (!run || run.cycle === 0 || run.phase !== "recorded" || run.evidenceId !== data.evidenceId || !p.conditions.has(data.conditionId) || data.conditionId !== run.conditionId || !data.findingId || !hash(data.fingerprint) || evidence?.conditionId !== data.conditionId || evidence.executionRevision !== p.executionRevision || evidence.verdict?.kind !== "failed" || evidence.verdict.findingFingerprint !== data.fingerprint) throw new Error("finding requires current failed ledger evidence"); if (p.findings.has(data.findingId)) throw new Error("duplicate finding"); p.findings.set(data.findingId, { findingId: data.findingId, conditionId: data.conditionId, observationRunId: data.runId, executionRevision: p.executionRevision, fingerprint: data.fingerprint, status: "open", episodeId: null }); }
function findingStatusChanged(p, data) { runtimeOnly(p); const finding = p.findings.get(data.findingId); if (!finding || !new Set(["open", "repairing", "reverification", "resolved", "rejected_by_user"]).has(data.status)) throw new Error("invalid finding status"); finding.status = data.status; }
function repairOpened(p, data) { runtimeOnly(p); requireExactFields(data, ["episodeId", "conditionId", "findingIds"], "repair episode"); if (!data.episodeId || !p.conditions.has(data.conditionId) || !Array.isArray(data.findingIds) || !data.findingIds.length || new Set(data.findingIds).size !== data.findingIds.length || p.repairEpisodes.has(data.episodeId)) throw new Error("invalid repair episode"); for (const id of data.findingIds) { const finding = p.findings.get(id); if (!finding || finding.conditionId !== data.conditionId || finding.status !== "open" || finding.episodeId !== null || finding.executionRevision !== p.executionRevision) throw new Error("invalid repair finding reference"); finding.episodeId = data.episodeId; finding.status = "repairing"; } p.repairEpisodes.set(data.episodeId, { episodeId: data.episodeId, conditionId: data.conditionId, findingIds: [...data.findingIds], remediationTaskIds: [], ownedRunIds: [], status: "active", cancellation: null, resolution: null }); }
function repairTaskLinked(p, data) { runtimeOnly(p); requireExactFields(data, ["episodeId", "taskId", "challengeId"], "repair task link"); const episode = p.repairEpisodes.get(data.episodeId), task = p.tasks.get(data.taskId); if (!episode || !task || episode.status !== "active") throw new Error("invalid repair task reference"); const meta = task.metadata; if (!meta || meta.kind !== "remediation" || meta.goalId !== p.goalId || meta.executionRevision !== p.executionRevision || meta.episodeId !== episode.episodeId || meta.conditionId !== episode.conditionId || meta.findingIds.length !== episode.findingIds.length || meta.findingIds.some((id) => !episode.findingIds.includes(id)) || meta.taskDefHash !== taskContractHash(task) || meta.subjectHash !== remediationSubjectHash({ goalId: p.goalId, executionRevision: p.executionRevision, episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds: episode.findingIds, task })) throw new Error("repair task metadata binding mismatch"); const policy = p.conditions.get(episode.conditionId)?.definition?.remediation?.policy; if (policy === "autonomous") { if (data.challengeId !== null) throw new Error("autonomous repair must not use challenge"); } else if (policy === "user-approved") { const c = p.repairChallenges.get(data.challengeId); if (!c || c.executionRevision !== p.executionRevision || c.phase !== "consumed" || c.action !== "authorize_task" || c.episodeId !== episode.episodeId || c.taskId !== data.taskId || c.taskDefHash !== meta.taskDefHash || c.subjectHash !== meta.subjectHash) throw new Error("repair task challenge binding mismatch"); c.phase = "applied"; } else throw new Error("unknown repair policy"); if (!episode.remediationTaskIds.includes(data.taskId)) episode.remediationTaskIds.push(data.taskId); episode.status = "waiting_for_tasks"; assertPendingTaskContractsCompile(p, DISPATCH_VALIDATION_SENTINEL); }
function repairReverificationRequested(p, data) { runtimeOnly(p); requireExactFields(data, ["episodeId", "conditionId", "findingIds", "remediationTaskIds", "oldStatus", "newStatus", "reason"], "repair reverification"); const episode = p.repairEpisodes.get(data.episodeId); if (!episode || episode.conditionId !== data.conditionId || episode.status !== data.oldStatus || data.newStatus !== "reverifying" || !Array.isArray(data.findingIds) || !Array.isArray(data.remediationTaskIds) || data.findingIds.length !== episode.findingIds.length || data.findingIds.some((id) => !episode.findingIds.includes(id)) || data.remediationTaskIds.length !== episode.remediationTaskIds.length || data.remediationTaskIds.some((id) => !episode.remediationTaskIds.includes(id)) || data.remediationTaskIds.some((id) => p.tasks.get(id)?.status !== "accepted") || !data.reason) throw new Error("invalid repair reverification"); episode.status = "reverifying"; for (const id of episode.findingIds) p.findings.get(id).status = "reverification"; }
function stableResolutionLedger(p, condition, refs) {
  const policy = condition?.definition?.stability;
  if (condition?.status !== "satisfied" || !Array.isArray(refs) || !policy || !isPlainObject(policy)) return false;
  const evidence = refs.map((ref) => p.evidenceHistory.find((row) => row?.run?.runId === ref.runId && row.evidenceId === ref.evidenceId));
  if (evidence.some((row) => !row || !Number.isSafeInteger(row.sequence))) return false;
  if (policy.mode === "single") return Object.keys(policy).length === 2 && policy.require_fresh_environment === true && refs.length === 1 && typeof evidence[0].environment?.fingerprint === "string" && !!evidence[0].environment.fingerprint;
  if (policy.mode !== "consecutive" || Object.keys(policy).length !== 3 || !Number.isSafeInteger(policy.count) || policy.count < 2 || policy.require_distinct_environment !== true || refs.length !== policy.count) return false;
  if (evidence.some((row, index) => index && row.sequence !== evidence[index - 1].sequence + 1)) return false;
  return new Set(evidence.map((row) => `${row.environment?.ref}\0${row.environment?.fingerprint}`)).size === evidence.length;
}
function repairResolved(p, data) { runtimeOnly(p); requireExactFields(data, ["episodeId", "conditionId", "findingIds", "oldStatus", "newStatus", "reason", "runId", "evidenceId", "supportingEvidenceRefs"], "repair resolution"); const episode = p.repairEpisodes.get(data.episodeId), condition = p.conditions.get(data.conditionId); const refs = data.supportingEvidenceRefs;
  const validRefs = Array.isArray(refs) && refs.length > 0 && refs.length === condition?.supportingEvidenceIds?.length
    && refs.every((ref, index) => isPlainObject(ref) && Object.keys(ref).length === 2 && Object.hasOwn(ref, "runId") && Object.hasOwn(ref, "evidenceId") && ref.evidenceId === condition.supportingEvidenceIds[index] && episode?.ownedRunIds.includes(ref.runId) && (() => { const run = p.observationRuns.get(ref.runId), evidence = p.evidenceHistory.find((row) => row?.run?.runId === ref.runId && row.evidenceId === ref.evidenceId); return ["recorded", "released"].includes(run?.phase) && run.conditionId === data.conditionId && run.evidenceId === ref.evidenceId && evidence?.conditionId === data.conditionId && evidence.verdict?.kind === "passed"; })())
    && new Set(refs.map((ref) => `${ref.runId}\0${ref.evidenceId}`)).size === refs.length;
  const currentRun = p.observationRuns.get(data.runId);
  if (!episode || episode.conditionId !== data.conditionId || episode.status !== data.oldStatus || episode.status !== "reverifying" || data.newStatus !== "resolved" || !data.reason || data.findingIds.length !== episode.findingIds.length || data.findingIds.some((id) => !episode.findingIds.includes(id)) || !validRefs || !stableResolutionLedger(p, condition, refs) || refs.at(-1).runId !== data.runId || refs.at(-1).evidenceId !== data.evidenceId || currentRun?.phase !== "recorded") throw new Error("invalid repair resolution"); episode.resolution = structuredClone({ runId: data.runId, evidenceId: data.evidenceId, supportingEvidenceRefs: refs }); episode.status = "resolved"; for (const id of episode.findingIds) p.findings.get(id).status = "resolved"; }
function repairObservationLinked(p, data) { runtimeOnly(p); requireExactFields(data, ["episodeId", "conditionId", "runId"], "repair observation link"); const episode = p.repairEpisodes.get(data.episodeId), run = p.observationRuns.get(data.runId); if (!episode || episode.status !== "reverifying" || episode.conditionId !== data.conditionId || !run || run.conditionId !== data.conditionId || run.phase !== "requested" || episode.ownedRunIds.includes(data.runId) || [...p.repairEpisodes.values()].some((other) => other.episodeId !== episode.episodeId && other.ownedRunIds?.includes(data.runId))) throw new Error("invalid repair observation link"); episode.ownedRunIds.push(data.runId); }
function repairChallengeCreated(p, d) { runtimeOnly(p); const fields = ["challengeId", "goalId", "executionRevision", "executionContractHash", "baseHead", "episodeId", "conditionId", "findingIds", "action", "subjectHash", "taskId", "taskDefHash", "sessionId", "requestedAt", "expiresAt", "challengeHash"], bodyFields = fields.filter((key) => key !== "challengeId" && key !== "challengeHash"); requireExactFields(d, fields, "repair challenge"); const episode = p.repairEpisodes.get(d.episodeId); const rejectSubject = hashCanonical({ goalId: p.goalId, executionRevision: p.executionRevision, episodeId: episode?.episodeId, conditionId: episode?.conditionId, findingIds: [...(episode?.findingIds || [])].sort() }); const challengeHash = hashCanonical(Object.fromEntries(bodyFields.map((key) => [key, d[key]])));
  if (!episode || p.repairChallenges.has(d.challengeId) || d.challengeId !== `repair-challenge-${challengeHash.slice(0, 32)}` || d.goalId !== p.goalId || d.executionRevision !== p.executionRevision || d.executionContractHash !== p.executionContractHash || d.conditionId !== episode.conditionId || !Array.isArray(d.findingIds) || JSON.stringify(d.findingIds) !== JSON.stringify([...episode.findingIds].sort()) || !hash(d.subjectHash) || !hash(d.challengeHash) || d.challengeHash !== challengeHash || !/^[a-f0-9]{40}$/.test(d.baseHead || "") || !d.sessionId || !Number.isFinite(d.requestedAt) || !Number.isFinite(d.expiresAt) || d.expiresAt <= d.requestedAt || (d.action === "authorize_task" ? episode.status !== "active" || !d.taskId || !hash(d.taskDefHash) : d.action !== "reject" || !["active", "waiting_for_tasks", "reverifying"].includes(episode.status) || d.subjectHash !== rejectSubject || d.taskId !== null || d.taskDefHash !== null)) throw new Error("invalid repair challenge"); p.repairChallenges.set(d.challengeId, { ...structuredClone(d), phase: "created", userEntryId: null }); }
function repairUserDecisionRecorded(p, d) { runtimeOnly(p); requireExactFields(d, ["challengeId", "challengeHash", "sessionId", "userEntryId", "userEntryHash", "branchBindingHash", "userEntryOccurredAt", "choice", "approved", "source", "recordedAt", "decisionId"], "repair user decision"); const c = p.repairChallenges.get(d.challengeId); const decision = hashCanonical({ challengeId: d.challengeId, challengeHash: d.challengeHash, sessionId: d.sessionId, userEntryId: d.userEntryId, userEntryHash: d.userEntryHash, branchBindingHash: d.branchBindingHash, choice: d.choice, approved: d.approved, source: d.source, userEntryOccurredAt: d.userEntryOccurredAt, recordedAt: d.recordedAt }); if (!c || c.phase !== "created" || c.challengeHash !== d.challengeHash || c.sessionId !== d.sessionId || [...p.repairChallenges.values()].some((x) => x.userEntryId === d.userEntryId || x.userEntryHash === d.userEntryHash) || !hash(d.userEntryHash) || !hash(d.branchBindingHash) || !hash(d.decisionId) || d.decisionId !== decision || !Number.isFinite(d.userEntryOccurredAt) || !Number.isFinite(d.recordedAt) || !(c.requestedAt < d.userEntryOccurredAt && d.userEntryOccurredAt <= d.recordedAt && d.recordedAt < c.expiresAt) || !d.userEntryId || !["approve", "reject"].includes(d.choice) || d.approved !== (d.choice === "approve") || !["interactive", "rpc"].includes(d.source)) throw new Error("invalid repair user decision"); c.phase = d.approved ? "approved" : "rejected"; Object.assign(c, structuredClone(d)); }
function repairCapabilityConsumed(p, d) { runtimeOnly(p); const fields = ["nonceDigest", "consumedAt", "challengeId", "challengeHash", "episodeId", "action", "subjectHash", "sessionId", "userEntryId", "decisionId", "executionRevision", "executionContractHash", "baseHead", "taskId", "taskDefHash", "userEntryHash", "branchBindingHash"]; requireExactFields(d, fields, "repair capability consume"); const c = p.repairChallenges.get(d.challengeId), episode = p.repairEpisodes.get(d.episodeId); const allowed = (c?.action === "authorize_task" && episode?.status === "active") || (c?.action === "reject" && ["active", "waiting_for_tasks", "reverifying"].includes(episode?.status)); if (!c || !allowed || c.executionRevision !== p.executionRevision || c.phase !== "approved" || [...p.repairChallenges.values()].some((x) => x.nonceDigest === d.nonceDigest) || !hash(d.nonceDigest) || !Number.isFinite(d.consumedAt) || c.recordedAt > d.consumedAt || d.consumedAt >= c.expiresAt || ["challengeHash", "episodeId", "action", "subjectHash", "sessionId", "userEntryId", "decisionId", "executionRevision", "executionContractHash", "baseHead", "taskId", "taskDefHash", "userEntryHash", "branchBindingHash"].some((key) => c[key] !== d[key])) throw new Error("invalid repair capability consume"); c.phase = "consumed"; c.nonceDigest = d.nonceDigest; c.consumedAt = d.consumedAt; }
function repairRejectedByUser(p, d) { runtimeOnly(p); requireExactFields(d, ["episodeId", "conditionId", "findingIds", "challengeId", "reasonCode"], "repair rejection"); const e = p.repairEpisodes.get(d.episodeId), c = p.repairChallenges.get(d.challengeId), subjectHash = hashCanonical({ goalId: p.goalId, executionRevision: p.executionRevision, episodeId: e?.episodeId, conditionId: e?.conditionId, findingIds: [...(e?.findingIds || [])].sort() }); if (!e || !c || c.executionRevision !== p.executionRevision || c.phase !== "consumed" || c.action !== "reject" || c.subjectHash !== subjectHash || c.episodeId !== e.episodeId || e.conditionId !== d.conditionId || !["active", "waiting_for_tasks", "reverifying"].includes(e.status) || d.reasonCode !== "repair_rejected" || d.findingIds.length !== e.findingIds.length || d.findingIds.some((id) => !e.findingIds.includes(id))) throw new Error("invalid repair rejection"); e.status = "resolved"; c.phase = "applied"; for (const id of e.findingIds) p.findings.get(id).status = "rejected_by_user"; }
function validCancellation(p, episode, c) { const keys = ["ownedTaskIds", "ownedRunIds", "terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs", "resourceDebt"]; if (!isPlainObject(c) || Object.keys(c).length !== keys.length || keys.some((key) => !Object.hasOwn(c, key)) || !["ownedTaskIds", "ownedRunIds", "terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs"].every((key) => Array.isArray(c[key])) || typeof c.resourceDebt !== "boolean") return false; const unique = (ids) => ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length; if (!unique(c.ownedTaskIds) || !unique(c.ownedRunIds) || c.ownedTaskIds.length !== episode.remediationTaskIds.length || c.ownedTaskIds.some((id) => !episode.remediationTaskIds.includes(id)) || c.ownedRunIds.length !== episode.ownedRunIds.length || c.ownedRunIds.some((id) => !episode.ownedRunIds.includes(id))) return false; const exactRefs = (refs, owners, key, shape, check) => refs.length === owners.length && refs.every((ref) => isPlainObject(ref) && Object.keys(ref).length === shape.length && shape.every((field) => Object.hasOwn(ref, field)) && owners.includes(ref[key]) && check(ref)) && new Set(refs.map((ref) => ref[key])).size === owners.length; const terminal = exactRefs(c.terminalProofRefs, c.ownedRunIds, "runId", ["runId", "proofHash", "phase"], (ref) => hash(ref.proofHash) && p.observationRuns.get(ref.runId)?.phase === ref.phase && ["terminal", "recorded", "released"].includes(ref.phase)); const workspace = exactRefs(c.workspaceClosureProofRefs, c.ownedTaskIds, "taskId", ["taskId", "proofHash", "disposition", "released"], (ref) => hash(ref.proofHash) && ref.released === true && (p.tasks.get(ref.taskId)?.workspace ? ["integrated", "discarded", "preserved"].includes(ref.disposition) && p.tasks.get(ref.taskId).workspace.disposition === ref.disposition && p.tasks.get(ref.taskId).workspace.released === true : p.tasks.get(ref.taskId)?.status === "pending" && p.tasks.get(ref.taskId)?.attempts === 0 && ref.disposition === "never_started")); const resource = exactRefs(c.resourceClosureProofRefs, c.ownedRunIds, "runId", ["runId", "proofHash", "state", "debt"], (ref) => hash(ref.proofHash) && typeof ref.debt === "boolean" && ["released", "quarantined"].includes(ref.state)); return terminal && workspace && resource && c.resourceDebt === c.resourceClosureProofRefs.some((ref) => ref.debt || ref.state === "quarantined"); }
function repairCancelRequested(p, data) { runtimeOnly(p); requireExactFields(data, ["episodeId", "cancellation"], "repair cancellation"); const episode = p.repairEpisodes.get(data.episodeId); if (!episode || !["active", "waiting_for_tasks", "reverifying", "blocked"].includes(episode.status) || !validCancellation(p, episode, data.cancellation)) throw new Error("invalid repair cancellation"); episode.status = "cancel_pending"; episode.cancellation = structuredClone(data.cancellation); }
function repairCancelled(p, data) { runtimeOnly(p); requireExactFields(data, ["episodeId", "cancellation"], "repair cancelled"); const episode = p.repairEpisodes.get(data.episodeId); if (!episode || episode.status !== "cancel_pending" || JSON.stringify(canonical(data.cancellation)) !== JSON.stringify(canonical(episode.cancellation)) || !validCancellation(p, episode, data.cancellation)) throw new Error("repair cancellation is out of order"); episode.status = "cancelled"; }
function taskApplicabilityChanged(p, data) { runtimeOnly(p); requireExactFields(data, ["taskId", "state", "reason"], "task applicability"); const task = p.tasks.get(data.taskId); const current = p.taskApplicability.get(data.taskId); if (!task || !current || !["applicable", "superseded", "reverify_required"].includes(data.state)) throw new Error("invalid task applicability"); p.taskApplicability.set(data.taskId, { revision: p.executionRevision, state: data.state, reason: data.reason || null }); recordRuntimeMutation(p, [data.taskId]); }
function proposalRuntimeRegistries(contract) {
  return {
    adapters: Object.fromEntries((contract?.execution?.conditions || []).map((condition) => [condition.oracle_ref, { deterministic: true }])),
    environments: Object.fromEntries((contract?.execution?.conditions || []).map((condition) => [condition.environment_ref, { available: true }])),
    fixtures: Object.fromEntries((contract?.execution?.conditions || []).flatMap((condition) => condition.fixture_refs.map((ref) => [ref, { available: true }]))),
  };
}
function canonicalIso(value) { return typeof value === "string" && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value; }
function amendmentProposed(p, data) {
  runtimeOnly(p);
  const fields = ["proposalId", "proposalHash", "changes", "changesHash", "targetExecutionContract", "targetContractHash", "baseHead", "ownerSessionId", "oldRevision", "newRevision", "goalId"];
  requireExactFields(data, fields, "amendment proposal");
  let normalizedTarget;
  try { normalizedTarget = normalizeRuntimeGoalInit(data.targetExecutionContract, proposalRuntimeRegistries(data.targetExecutionContract)); } catch { throw new Error("invalid amendment target runtime contract"); }
  const { proposalHash, ...material } = data;
  if (p.runtimeState !== "suspended" || data.goalId !== p.goalId || data.ownerSessionId !== ownerSessionId(p) || data.baseHead !== p.runtimeBaseHead || data.oldRevision !== p.executionRevision || data.newRevision !== data.oldRevision + 1 || !data.proposalId || !isPlainObject(data.changes) || !hash(data.proposalHash) || !hash(data.changesHash) || !hash(data.targetContractHash) || data.changesHash !== hashCanonical(data.changes) || data.targetContractHash !== hashRuntimeExecutionContract(data.targetExecutionContract) || !sameCanonical(data.targetExecutionContract, normalizedTarget) || data.proposalHash !== hashCanonical(material)) throw new Error("invalid amendment proposal");
  p.pendingHumanDecision = { ...structuredClone(data), phase: "proposed" };
}
function amendmentApproved(p, data) {
  runtimeOnly(p);
  const fields = ["proposalId", "proposalHash", "ownerSessionId", "userEntryId", "userEntryHash", "branchBindingHash", "source", "recordedAt", "decisionId"];
  requireExactFields(data, fields, "amendment approval");
  const pending = p.pendingHumanDecision, { decisionId, ...material } = data;
  if (!pending || pending.phase !== "proposed" || pending.proposalId !== data.proposalId || pending.proposalHash !== data.proposalHash || pending.ownerSessionId !== data.ownerSessionId || data.ownerSessionId !== ownerSessionId(p) || !data.userEntryId || !hash(data.userEntryHash) || !hash(data.branchBindingHash) || !hash(data.decisionId) || !["interactive", "rpc"].includes(data.source) || !canonicalIso(data.recordedAt) || data.decisionId !== hashCanonical(material)) throw new Error("invalid amendment approval");
  p.pendingHumanDecision = { ...pending, ...structuredClone(data), phase: "approved" };
}
function amendmentCapabilityConsumed(p, data) { runtimeOnly(p); requireExactFields(data, ["proposalId", "nonceDigest"], "amendment capability"); const pending = p.pendingHumanDecision; if (!pending || pending.phase !== "approved" || pending.proposalId !== data.proposalId || !hash(data.nonceDigest)) throw new Error("invalid amendment capability"); pending.phase = "consumed"; }
function amendmentApplied(p, data) { runtimeOnly(p); requireExactFields(data, ["proposalId", "oldRevision", "newRevision", "contractHash", "reconciliation"], "amendment apply"); const pending = p.pendingHumanDecision; if (!pending || pending.phase !== "consumed" || pending.proposalId !== data.proposalId || data.oldRevision !== p.executionRevision || data.newRevision !== data.oldRevision + 1 || !hash(data.contractHash) || !Array.isArray(data.reconciliation)) throw new Error("invalid amendment apply"); p.executionRevision = data.newRevision; p.executionContractHash = data.contractHash; p.pendingHumanDecision = null; recordRuntimeMutation(p, [...p.tasks.keys()]); }
function finalReviewStarted(p, data) { runtimeOnly(p); requireExactFields(data, ["reviewId", "manifestHash", "stateHash", "worldHash"], "final review start"); if (!data.reviewId || !hash(data.manifestHash) || !hash(data.stateHash) || !hash(data.worldHash)) throw new Error("invalid final review start"); p.finalReview = { ...data, status: "started" }; }
function finalReviewRecorded(p, data) { runtimeOnly(p); requireExactFields(data, ["reviewId", "resultHash", "severity"], "final review record"); if (!p.finalReview || p.finalReview.reviewId !== data.reviewId || !hash(data.resultHash) || !["none", "minor", "important", "critical"].includes(data.severity)) throw new Error("invalid final review record"); p.finalReview = { ...p.finalReview, ...data, status: "recorded" }; }
function hash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value; }
function hashCanonical(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function suspensionClosureHash(closure) { return hashCanonical(closure); }
function recordRuntimeMutation(p, taskIds) { p.mutationSequence++; if (!Number.isSafeInteger(p.mutationSequence)) throw new Error("runtime mutation sequence overflow"); for (const taskId of taskIds) if (p.tasks.has(taskId)) p.taskMutationSequences.set(taskId, p.mutationSequence); }

function goalCreated(p, event, replay) {
  const { objective, scope, nonGoals, dod, tasks, taskDefs } = event.data;
  if (generationCapabilities(event.schemaVersion).taskContract === "criteria-only") validateTaskDefinitions(tasks, taskDefs, { planned: true });
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
      || (generationCapabilities(event.schemaVersion).taskContract !== "criteria-only" && !Array.isArray(def.acceptance.commands))) {
      throw new Error(`taskDef ${taskId} missing acceptance${generationCapabilities(event.schemaVersion).taskContract === "criteria-only" ? " criteria" : " (criteria + commands)"}`);
    }
    p.tasks.set(taskId, {
      description: def.description,
      deps: def.deps || [],
      writePaths: def.writePaths,
      acceptance: generationCapabilities(event.schemaVersion).taskContract === "criteria-only"
        ? { criteria: structuredClone(def.acceptance.criteria) }
        : { criteria: def.acceptance.criteria, commands: def.acceptance.commands },
      workflow: def.workflow || "tdd",
      status: "pending",
      evidence: [],
      attempts: 0,
      lastSettledOutcome: null,
      contractHash: null,
      workspace: null,
      ...(generationCapabilities(event.schemaVersion).executorBinding === "strict" ? { executorBinding: null, lastExecutorProof: null } : {}),
      acceptanceVerification: null,
      settlement: null,
    });
  }
  if (generationCapabilities(event.schemaVersion).taskContract === "criteria-only") assertPendingTaskContractsCompile(p, DISPATCH_VALIDATION_SENTINEL);
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
  if (generationCapabilities(schemaVersion).conditions) recordRuntimeMutation(p, [taskId]);
  task.contractHash = contractHash;
  if (generationCapabilities(schemaVersion).executorBinding === "strict") {
    task.executorBinding = null;
    task.lastExecutorProof = null;
  }
}

function taskExecutorBound(p, data, schemaVersion) {
  requireActive(p);
  if (generationCapabilities(schemaVersion).executorBinding !== "strict") throw new Error("executor binding requires strict generation");
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

function validatedPlannedSettlementEvidence(goalId, task, data, executorProof) {
  requireExactFields(data, ["taskId", "outcome", "attempt", "executorHead", "executorProof", "settlementEvidence"], "planned succeeded settlement data");
  const evidence = data.settlementEvidence;
  requireExactFields(evidence, ["schemaVersion", "path", "sha256", "subagentFingerprint", "mainFingerprint", "subagent", "main", "mainSessionId"], "settlement evidence");
  if (evidence.schemaVersion !== "goal-engine.settlement-evidence.v1") throw new Error("settlement evidence schemaVersion is invalid");
  if (!/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new Error("settlement evidence sha256 is invalid");
  if (typeof evidence.path !== "string" || !new RegExp(`^acceptance-evidence/sha256/${evidence.sha256}\\.yaml$`).test(evidence.path)) {
    throw new Error("settlement evidence path must be the exact relative CAS path");
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.subagentFingerprint) || !/^[a-f0-9]{64}$/.test(evidence.mainFingerprint)) throw new Error("settlement evidence fingerprint is invalid");
  if (typeof evidence.mainSessionId !== "string" || !evidence.mainSessionId.trim()) throw new Error("settlement evidence mainSessionId is required");
  if (evidence.mainSessionId !== executorProof.rootSessionId) throw new Error("settlement evidence mainSessionId does not match official proof");
  const identity = { goalId, taskId: data.taskId, runId: task.executorBinding.runId, attempt: data.attempt, contractHash: task.contractHash, head: data.executorHead };
  const criteria = task.acceptance.criteria.map((criterion) => criterion.id);
  const subagent = normalizeSettlementEvidence(evidence.subagent, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" });
  const main = normalizeSettlementEvidence(evidence.main, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" });
  if (fingerprintSettlementEvidence(subagent, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" }) !== evidence.subagentFingerprint
    || fingerprintSettlementEvidence(main, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" }) !== evidence.mainFingerprint) throw new Error("settlement evidence fingerprint mismatch");
  assertIndependentSettlementEvidence(subagent, main);
  return { ...evidence, subagent, main };
}

function taskSettled(p, data, occurredAt, schemaVersion, replay) {
  requireActive(p);
  const { taskId, outcome, evidence, evidenceSource, nextAction } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "dispatched") throw new Error(`task is not dispatched: ${taskId} (${task.status})`);
  if (!["succeeded", "failed", "blocked"].includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);

  const capabilities = generationCapabilities(schemaVersion);
  const strictBinding = capabilities.executorBinding === "strict";
  if (capabilities.conditions && outcome === "succeeded" && !Object.hasOwn(data, "settlementEvidence")) throw new Error("runtime succeeded settlement requires dual-path evidence");
  const dualPathSucceeded = generationCapabilities(schemaVersion).settlement === "dual-path" && outcome === "succeeded" && Object.hasOwn(data, "settlementEvidence");
  if (!dualPathSucceeded) {
    if (strictBinding && outcome === "succeeded" && (!evidence || !nextAction)) throw new Error("settlement evidence is required for strict succeeded settlement");
    validateEvidenceSource(evidenceSource, evidence);
    validateNextAction(nextAction);
    if (outcome === "succeeded") validateEvidence(evidence);
  }
  const executorProof = strictBinding && (outcome === "succeeded" || data.evidenceSource !== undefined || capabilities.conditions) ? validatedExecutorProof(task, data) : null;
  const settlementEvidence = dualPathSucceeded ? validatedPlannedSettlementEvidence(p.goalId, task, data, executorProof) : null;

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
        task.settlement = { attempt: workspace.attempt, executorHead: data.executorHead, ...executorIdentity, ...(settlementEvidence ? { evidence: settlementEvidence } : {}) };
      } else if (!replay) {
        throw new Error("settlement identity requires attempt and executorHead");
      } else {
        task.settlement = null;
      }
    }
    task.status = "succeeded";
    if (!dualPathSucceeded) task.evidence.push({ ...evidence, source: evidenceSource || "self_produced", ts: occurredAt });
  } else if (outcome === "failed") {
    task.settlement = null;
    task.status = "pending";
  } else {
    task.settlement = null;
    task.status = "blocked";
    task.blockedReason = data.reason || null;
  }
  p.coordinationState = coordinationStateFor(p);
  if (capabilities.conditions) recordRuntimeMutation(p, [taskId]);
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
  if (generationCapabilities(schemaVersion).conditions) recordRuntimeMutation(p, [taskId]);
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
  if (schemaVersion !== "goal-engine.event.v3" && schemaVersion !== PLANNED_SCHEMA_VERSION && schemaVersion !== RUNTIME_SCHEMA_VERSION) {
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
  const { addTasks, removeTasks, updateTasks, reason, hostInternalRemediation = false } = data;
  if (hostInternalRemediation !== false && hostInternalRemediation !== true) throw new Error("invalid Host-internal remediation flag");
  if (hostInternalRemediation && schemaVersion !== RUNTIME_SCHEMA_VERSION) throw new Error("Host-internal remediation requires runtime generation");
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
      workflow: def.workflow || "tdd", ...(def.metadata ? { metadata: structuredClone(def.metadata) } : {}), status: "pending", evidence: [], attempts: 0,
      lastSettledOutcome: null, contractHash: null, workspace: null,
      ...((schemaVersion === PLANNED_SCHEMA_VERSION || schemaVersion === RUNTIME_SCHEMA_VERSION) ? { executorBinding: null, lastExecutorProof: null } : {}),
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
  if (schemaVersion === PLANNED_SCHEMA_VERSION || schemaVersion === RUNTIME_SCHEMA_VERSION) {
    validateTaskDefinitions([...candidate.keys()], taskDefinitions(candidate), { planned: true, hostInternalRemediation });
    if (schemaVersion === RUNTIME_SCHEMA_VERSION && [...candidate.values()].some((task) => task.writePaths.some((path) => !p.writePolicy.allowedPaths.some((allowed) => path === allowed || allowed.endsWith("/**") && path.startsWith(allowed.slice(0, -2)))))) throw new Error("runtime task writePaths exceed write policy");
  } else if (schemaVersion !== "goal-engine.event.v1" && !replay) {
    validateTaskDefinitions([...candidate.keys()], taskDefinitions(candidate));
  } else {
    validateDAG(candidate);
  }
  if (!hostInternalRemediation && ((schemaVersion === PLANNED_SCHEMA_VERSION || schemaVersion === RUNTIME_SCHEMA_VERSION) || (schemaVersion !== "goal-engine.event.v1" && !replay))) {
    const candidateProjection = { ...p, tasks: candidate };
    assertPendingTaskContractsCompile(candidateProjection, DISPATCH_VALIDATION_SENTINEL);
  }
  p.tasks = candidate;
  if (schemaVersion === RUNTIME_SCHEMA_VERSION) {
    for (const taskId of Object.keys(addTasks || {})) {
      if (!p.taskApplicability.has(taskId)) p.taskApplicability.set(taskId, { revision: p.executionRevision, state: "applicable", reason: null });
      if (!p.taskMutationSequences.has(taskId)) p.taskMutationSequences.set(taskId, 0);
    }
    recordRuntimeMutation(p, Object.keys(addTasks || {}));
  }
}

function taskDefinitions(tasks) {
  return Object.fromEntries([...tasks].map(([id, task]) => [id, {
    description: task.description, ...(task.deps?.length ? { deps: task.deps } : {}), writePaths: task.writePaths,
    acceptance: task.acceptance, workflow: task.workflow, ...(task.metadata ? { metadata: task.metadata } : {}),
  }]));
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

export function ownerSessionId(projection) {
  const bindings = projection?.sessionBindings || [];
  return [...bindings].reverse().find((binding) => binding.state !== "transferred")?.sessionId || null;
}

function goalSessionBound(p, event, schemaVersion) {
  requireV3(schemaVersion, event.type);
  requireExactFields(event.data, ["sessionId", "leafId"], "session binding");
  const { sessionId, leafId } = event.data;
  requireNonEmptyStrings({ sessionId, leafId }, "session binding");
  const existing = ownerSessionId(p);
  if (existing && existing !== sessionId) throw new Error("goal owner session is immutable");
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

function goalSessionTransferred(p, event, schemaVersion) {
  requireV3(schemaVersion, event.type);
  requireExactFields(event.data, ["fromSessionId", "toSessionId", "challengeId", "reason", "ownershipRevision"], "session transfer");
  const { fromSessionId, toSessionId, challengeId, reason, ownershipRevision } = event.data;
  if (fromSessionId !== null && (typeof fromSessionId !== "string" || !fromSessionId.trim())) throw new Error("invalid transfer source session");
  requireNonEmptyStrings({ toSessionId, challengeId, reason }, "session transfer");
  if (!Number.isSafeInteger(ownershipRevision) || ownershipRevision !== p.ownershipRevision + 1) throw new Error("invalid ownership revision");
  if (ownerSessionId(p) !== fromSessionId) throw new Error("transfer source owner mismatch");
  if (fromSessionId !== null) {
    const source = [...p.sessionBindings].reverse().find((binding) => binding.sessionId === fromSessionId && binding.state !== "transferred");
    if (!source) throw new Error(`transfer source session binding not found: ${fromSessionId}`);
    Object.assign(source, { state: "transferred", transferredAt: event.occurredAt, transferredToSessionId: toSessionId.trim(), challengeId });
  }
  p.sessionBindings.push({ sessionId: toSessionId.trim(), leafId: "session-transfer", state: "watching", boundAt: event.occurredAt });
  p.ownershipRevision = ownershipRevision;
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
  if (p.eventSchemaVersion === RUNTIME_SCHEMA_VERSION) {
    requireExactFields(data, ["canonicalFingerprint", "advanced", "sequence"], "runtime checkpoint");
    if (!hash(data.canonicalFingerprint) || typeof data.advanced !== "boolean" || !Number.isSafeInteger(data.sequence) || data.sequence !== p.progressLedger.length + 1) throw new Error("invalid runtime checkpoint");
    const previous = p.progressLedger.at(-1); if (data.advanced !== (!previous || previous.canonicalFingerprint !== data.canonicalFingerprint)) throw new Error("runtime checkpoint advanced mismatch");
    p.progressLedger.push(structuredClone(data)); p.checkpointCount++; return;
  }
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
