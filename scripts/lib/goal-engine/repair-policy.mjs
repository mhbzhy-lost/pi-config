import { validateRemediationMetadata, validateTaskDefinitions } from "./task-definition.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._-]{1,160}$/;
const CAPABILITY_KEYS = ["prefix", "goalId", "executionRevision", "episodeId", "challenge", "nonce", "singleUse"];
const CANCELLATION_KEYS = ["ownedTaskIds", "ownedRunIds", "terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs", "resourceDebt"];

function fail(message) { throw new Error(`invalid repair protocol: ${message}`); }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function ids(value, label) { if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string" || !ID.test(id)) || new Set(value).size !== value.length) fail(`${label} must be unique ids`); return value; }
function runtime(projection) { if (!projection || typeof projection.goalId !== "string" || !Number.isSafeInteger(projection.executionRevision) || !(projection.findings instanceof Map) || !(projection.conditions instanceof Map) || !(projection.repairEpisodes instanceof Map)) fail("runtime projection required"); }
function condition(projection, conditionId) { const state = projection.conditions.get(conditionId); if (!state?.definition?.remediation) fail("unknown remediation condition"); return state; }
function event(type, data) { return Object.freeze({ type, data: Object.freeze(data) }); }
function pathCovered(path, scope) { return scope.some((allowed) => allowed === path || allowed.endsWith("/**") && path.startsWith(allowed.slice(0, -2))); }

export function deriveFindingFromFailedEvidence({ projection, evidence } = {}) {
  runtime(projection);
  if (!exact(evidence, ["kind", "evidenceId", "failureCode", "findingFingerprint", "identity"]) || evidence.kind !== "failed" || typeof evidence.failureCode !== "string" || !evidence.failureCode || !HASH.test(evidence.evidenceId) || !HASH.test(evidence.findingFingerprint) || !exact(evidence.identity, ["goalId", "conditionId", "executionRevision", "runId"])) fail("canonical failed Host evidence required");
  const identity = evidence.identity;
  if (identity.goalId !== projection.goalId || identity.executionRevision !== projection.executionRevision || !ID.test(identity.conditionId) || !ID.test(identity.runId)) fail("evidence identity mismatch");
  condition(projection, identity.conditionId);
  for (const finding of projection.findings.values()) if (finding.fingerprint === evidence.findingFingerprint) {
    if (finding.status !== "open" || finding.conditionId !== identity.conditionId || finding.executionRevision !== projection.executionRevision) fail("existing fingerprint is not an open matching finding");
    return Object.freeze({ finding: Object.freeze(structuredClone(finding)), events: Object.freeze([]) });
  }
  const findingId = `finding-${evidence.findingFingerprint.slice(0, 32)}`;
  const finding = { findingId, conditionId: identity.conditionId, observationRunId: identity.runId, executionRevision: projection.executionRevision, fingerprint: evidence.findingFingerprint, status: "open", episodeId: null };
  return Object.freeze({ finding: Object.freeze(finding), events: Object.freeze([event("finding.recorded", { findingId, conditionId: identity.conditionId, runId: identity.runId, evidenceId: evidence.evidenceId, fingerprint: evidence.findingFingerprint, verdict: "failed" })]) });
}

export function openRepairEpisode({ projection, findingIds } = {}) {
  runtime(projection); ids(findingIds, "findingIds");
  const findings = findingIds.map((id) => projection.findings.get(id));
  if (findings.some((finding) => !finding || finding.status !== "open" || finding.episodeId !== null || finding.executionRevision !== projection.executionRevision)) fail("findings must be open, current, and unowned");
  const conditionId = findings[0].conditionId;
  if (findings.some((finding) => finding.conditionId !== conditionId)) fail("findings must share condition");
  condition(projection, conditionId);
  const episodeId = `repair-${conditionId}-${projection.repairEpisodes.size + 1}`;
  if (!ID.test(episodeId) || projection.repairEpisodes.has(episodeId)) fail("episode id collision");
  return Object.freeze({ episodeId, events: Object.freeze([event("repair.episode_opened", { episodeId, conditionId, findingIds: [...findingIds] })]) });
}

export function validateRemediationTask({ projection, episodeId, findingIds, taskDef, capability } = {}) {
  runtime(projection); if (typeof episodeId !== "string" || !ID.test(episodeId)) fail("episode id required"); ids(findingIds, "findingIds");
  const episode = projection.repairEpisodes.get(episodeId);
  if (!episode || episode.status !== "active") fail("episode is not active");
  if (findingIds.some((id) => !episode.findingIds.includes(id))) fail("finding is not owned by episode");
  const state = condition(projection, episode.conditionId), remediation = state.definition.remediation;
  const taskId = `repair-task-${episodeId}-${episode.remediationTaskIds.length + 1}`;
  if (!ID.test(taskId)) fail("task id too long");
  if (!taskDef || typeof taskDef !== "object" || Array.isArray(taskDef) || Object.hasOwn(taskDef, "metadata")) fail("caller may not set repair metadata");
  validateTaskDefinitions([taskId], { [taskId]: taskDef });
  if (taskDef.workflow !== "tdd") fail("remediation task must use tdd");
  const paths = taskDef.writePaths;
  const writePolicy = projection.writePolicy?.allowedPaths;
  if (!Array.isArray(writePolicy) || !Array.isArray(remediation.allowed_paths) || !paths.every((path) => pathCovered(path, writePolicy) && pathCovered(path, remediation.allowed_paths))) fail("write paths are not a provable subset of repair scope");
  if (remediation.policy === "user-approved") validateCapability(capability, projection, episodeId);
  else if (remediation.policy !== "autonomous") fail("unknown remediation policy");
  const internal = { ...structuredClone(taskDef), metadata: { kind: "remediation", findingIds: [...findingIds], episodeId } };
  validateRemediationMetadata(internal.metadata);
  return Object.freeze({ taskId, taskDef: Object.freeze(internal), events: Object.freeze([event("repair.task_linked", { episodeId, taskId })]) });
}

function validateCapability(capability, projection, episodeId) {
  if (!exact(capability, CAPABILITY_KEYS) || capability.prefix !== "goal-repair-capability.v1" || capability.goalId !== projection.goalId || capability.executionRevision !== projection.executionRevision || capability.episodeId !== episodeId || typeof capability.challenge !== "string" || !capability.challenge || typeof capability.nonce !== "string" || !capability.nonce || capability.singleUse !== true) fail("independent challenge-bound user capability required");
}

export function repairEpisodeTransition({ projection, episodeId, event: input } = {}) {
  runtime(projection); const episode = projection.repairEpisodes.get(episodeId); if (!episode || !input || typeof input.type !== "string") fail("episode and event required");
  if (input.type === "task.accepted") {
    if (episode.status !== "waiting_for_tasks" || !episode.remediationTaskIds.includes(input.taskId)) fail("accepted task cannot reverify this episode");
    return planReverify(episode, "accepted remediation task");
  }
  if (input.type === "condition.observation_recorded") {
    if (episode.status !== "reverifying" || input.conditionId !== episode.conditionId || !ID.test(input.runId || "")) fail("reobservation does not belong to this reverifying episode");
    if (input.verdict === "passed" && input.fresh === true) return Object.freeze({ events: Object.freeze([event("repair.episode_resolved", { episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh passed reobservation" })]) });
    if (["failed", "inconclusive", "infrastructure_error"].includes(input.verdict)) return Object.freeze({ events: Object.freeze([]) });
    fail("unknown reobservation verdict");
  }
  if (input.type === "finding.status_changed") {
    if (episode.status !== "reverifying" || !episode.findingIds.includes(input.findingId) || input.status !== "rejected_by_user" || input.userApproved !== true) fail("only real user rejection closes a finding");
    return Object.freeze({ events: Object.freeze([event("finding.status_changed", { findingId: input.findingId, status: "rejected_by_user" })]) });
  }
  if (input.type === "cancel") {
    if (!new Set(["active", "waiting_for_tasks", "reverifying", "blocked"]).has(episode.status)) fail("episode cannot be cancelled"); validateCancellation(input.cancellation, episode, projection);
    return Object.freeze({ events: Object.freeze([event("repair.episode_cancel_requested", { episodeId, cancellation: structuredClone(input.cancellation) })]) });
  }
  if (input.type === "cancelled") {
    if (episode.status !== "cancel_pending") fail("episode must be cancel_pending"); validateCancellation(input.cancellation, episode, projection);
    if (input.cancellation.resourceDebt) fail("resource debt permanently blocks cancellation finalization");
    return Object.freeze({ events: Object.freeze([event("repair.episode_cancelled", { episodeId })]) });
  }
  fail("unsupported repair transition");
}
function planReverify(episode, reason) { return Object.freeze({ events: Object.freeze([event("repair.reverification_requested", { episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], remediationTaskIds: [...episode.remediationTaskIds], oldStatus: episode.status, newStatus: "reverifying", reason })]) }); }
function validateCancellation(cancellation, episode, projection) {
  if (!exact(cancellation, CANCELLATION_KEYS) || !Array.isArray(cancellation.ownedTaskIds) || !Array.isArray(cancellation.ownedRunIds) || !["terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs"].every((key) => Array.isArray(cancellation[key])) || typeof cancellation.resourceDebt !== "boolean") fail("invalid cancellation proof");
  const terminalTasks = new Set(["accepted", "failed", "cancelled", "rejected"]);
  const terminalRuns = new Set(["terminal", "recorded", "released"]);
  const incomplete = new Set(cancellation.ownedTaskIds).size !== cancellation.ownedTaskIds.length
    || cancellation.ownedTaskIds.some((id) => !episode.remediationTaskIds.includes(id))
    || cancellation.terminalProofRefs.length < cancellation.ownedRunIds.length
    || cancellation.workspaceClosureProofRefs.length < cancellation.ownedTaskIds.length
    || cancellation.resourceClosureProofRefs.length < cancellation.ownedRunIds.length
    || (projection?.tasks instanceof Map && cancellation.ownedTaskIds.some((id) => !terminalTasks.has(projection.tasks.get(id)?.status)))
    || (projection?.observationRuns instanceof Map && cancellation.ownedRunIds.some((id) => !terminalRuns.has(projection.observationRuns.get(id)?.phase)));
  if (incomplete) fail("incomplete cancellation closure proof");
}
