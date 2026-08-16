import { createHash, randomBytes } from "node:crypto";
import { evaluateConditionGraph } from "./condition-validity.mjs";
import { validateRemediationMetadata, validateTaskDefinitions } from "./task-definition.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._-]{1,160}$/;
const CANCELLATION_KEYS = ["ownedTaskIds", "ownedRunIds", "terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs", "resourceDebt"];
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function fail(message) { throw new Error(`invalid repair protocol: ${message}`); }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function ids(value, label) { if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string" || !ID.test(id)) || new Set(value).size !== value.length) fail(`${label} must be unique ids`); return value; }
function runtime(p) { if (!p || typeof p.goalId !== "string" || !Number.isSafeInteger(p.executionRevision) || !(p.findings instanceof Map) || !(p.conditions instanceof Map) || !(p.repairEpisodes instanceof Map) || !(p.observationRuns instanceof Map)) fail("runtime projection required"); }
function condition(p, id) { const state = p.conditions.get(id); if (!state?.definition?.remediation) fail("unknown remediation condition"); return state; }
function event(type, data) { return Object.freeze({ type, data: Object.freeze(data) }); }
function pathCovered(path, scope) { return scope.some((allowed) => allowed === path || allowed.endsWith("/**") && path.startsWith(allowed.slice(0, -2))); }
function ledger(p, runId, evidenceId) { const run = p.observationRuns.get(runId); const evidence = p.evidenceHistory?.find((row) => row?.run?.runId === runId && row.evidenceId === evidenceId); return { run, evidence }; }

// The caller can name only immutable ledger references; verdict, identity and fingerprint
// are recovered from the R4 evidence record.
export function deriveFindingFromFailedEvidence({ projection, runId, evidenceId } = {}) {
  runtime(projection);
  if (!ID.test(runId || "") || !HASH.test(evidenceId || "")) fail("ledger references required");
  const { run, evidence } = ledger(projection, runId, evidenceId);
  if (!run || run.phase !== "recorded" || run.evidenceId !== evidenceId || !evidence || evidence.conditionId !== run.conditionId
    || evidence.executionRevision !== projection.executionRevision || evidence.executionContractHash !== projection.executionContractHash
    || evidence.verdict?.kind !== "failed" || !HASH.test(evidence.verdict.findingFingerprint)) fail("current failed ledger evidence required");
  const conditionId = run.conditionId, fingerprint = evidence.verdict.findingFingerprint;
  condition(projection, conditionId);
  for (const finding of projection.findings.values()) if (finding.fingerprint === fingerprint) {
    if (finding.status !== "open" || finding.conditionId !== conditionId || finding.executionRevision !== projection.executionRevision) fail("existing fingerprint is not an open matching finding");
    return Object.freeze({ finding: Object.freeze(structuredClone(finding)), events: Object.freeze([]) });
  }
  const findingId = `finding-${fingerprint.slice(0, 32)}`;
  const finding = { findingId, conditionId, observationRunId: runId, executionRevision: projection.executionRevision, fingerprint, status: "open", episodeId: null };
  return Object.freeze({ finding: Object.freeze(finding), events: Object.freeze([event("finding.recorded", { findingId, conditionId, runId, evidenceId, fingerprint })]) });
}

export function openRepairEpisode({ projection, findingIds } = {}) {
  runtime(projection); ids(findingIds, "findingIds");
  const findings = findingIds.map((id) => projection.findings.get(id));
  if (findings.some((f) => !f || f.status !== "open" || f.episodeId !== null || f.executionRevision !== projection.executionRevision)) fail("findings must be open, current, and unowned");
  const conditionId = findings[0].conditionId;
  if (findings.some((f) => f.conditionId !== conditionId)) fail("findings must share condition");
  condition(projection, conditionId);
  const episodeId = `repair-${conditionId}-${projection.repairEpisodes.size + 1}`;
  if (!ID.test(episodeId) || projection.repairEpisodes.has(episodeId)) fail("episode id collision");
  return Object.freeze({ episodeId, events: Object.freeze([event("repair.episode_opened", { episodeId, conditionId, findingIds: [...findingIds] })]) });
}

export function remediationSubjectHash(projection, episode, findingIds, taskDef) {
  return digest({ goalId: projection.goalId, executionRevision: projection.executionRevision, episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds: [...findingIds].sort(), taskDef: canonical(taskDef) });
}
export function rejectSubjectHash(projection, episode) { return digest({ goalId: projection.goalId, executionRevision: projection.executionRevision, episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds].sort() }); }

export function validateRemediationTask({ projection, episodeId, findingIds, taskDef, capability } = {}) {
  runtime(projection); if (!ID.test(episodeId || "")) fail("episode id required"); ids(findingIds, "findingIds");
  const episode = projection.repairEpisodes.get(episodeId);
  if (!episode || episode.status !== "active" || findingIds.length !== episode.findingIds.length || findingIds.some((id) => !episode.findingIds.includes(id))) fail("finding set must exactly match active episode");
  const state = condition(projection, episode.conditionId), remediation = state.definition.remediation;
  const taskId = `repair-task-${episodeId}-${episode.remediationTaskIds.length + 1}`;
  if (!ID.test(taskId) || !taskDef || typeof taskDef !== "object" || Array.isArray(taskDef) || Object.hasOwn(taskDef, "metadata")) fail("caller may not set repair metadata");
  validateTaskDefinitions([taskId], { [taskId]: taskDef });
  if (taskDef.workflow !== "tdd") fail("remediation task must use tdd");
  if (!Array.isArray(projection.writePolicy?.allowedPaths) || !Array.isArray(remediation.allowed_paths) || !taskDef.writePaths.every((path) => pathCovered(path, projection.writePolicy.allowedPaths) && pathCovered(path, remediation.allowed_paths))) fail("write paths are not a provable subset of repair scope");
  const internal = { ...structuredClone(taskDef), metadata: { kind: "remediation", findingIds: [...findingIds], episodeId } };
  validateRemediationMetadata(internal.metadata);
  if (remediation.policy === "user-approved") validateCapability(capability, projection, episode, "authorize_task", remediationSubjectHash(projection, episode, findingIds, internal));
  else if (remediation.policy !== "autonomous") fail("unknown remediation policy");
  return Object.freeze({ taskId, taskDef: Object.freeze(internal), events: Object.freeze([event("repair.task_linked", { episodeId, taskId })]) });
}
function validateCapability(capability, p, episode, action, subjectHash) {
  if (!exact(capability, ["prefix", "challengeId", "nonce", "singleUse", "action", "subjectHash"]) || capability.prefix !== "goal-repair-capability.v1" || capability.singleUse !== true || capability.action !== action || capability.subjectHash !== subjectHash || typeof capability.nonce !== "string" || !capability.nonce) fail("durable challenge-bound capability required");
  const challenge = p.repairChallenges?.get(capability.challengeId);
  if (!challenge || challenge.executionRevision !== p.executionRevision || challenge.episodeId !== episode.episodeId || challenge.action !== action || challenge.subjectHash !== subjectHash || challenge.phase !== "approved" || challenge.expiresAt <= Date.now() || challenge.nonceDigest !== createHash("sha256").update(capability.nonce).digest("hex")) fail("challenge capability is not valid");
}

// Plans only.  R10 appends the resulting capability-consumed/add/link batch atomically.
export function createRepairChallenge({ projection, episodeId, action, sessionId, requestedAt, expiresAt, subjectHash, nonce = randomBytes(32).toString("hex") } = {}) {
  runtime(projection); const episode = projection.repairEpisodes.get(episodeId);
  if (!episode || !["authorize_task", "reject"].includes(action) || !ID.test(sessionId || "") || !Number.isFinite(requestedAt) || !Number.isFinite(expiresAt) || expiresAt <= requestedAt || !HASH.test(subjectHash || "")) fail("invalid repair challenge");
  if (action === "reject" && subjectHash !== rejectSubjectHash(projection, episode)) fail("reject subject mismatch");
  const challengeId = `repair-challenge-${digest({ episodeId, action, subjectHash, requestedAt }).slice(0, 32)}`;
  return Object.freeze({ challengeId, capability: Object.freeze({ prefix: "goal-repair-capability.v1", challengeId, nonce, singleUse: true, action, subjectHash }), events: Object.freeze([event("repair.challenge_created", { challengeId, executionRevision: projection.executionRevision, episodeId, action, subjectHash, sessionId, requestedAt, expiresAt, nonceDigest: createHash("sha256").update(nonce).digest("hex") })]) });
}
export function recordRepairUserDecision({ projection, challengeId, sessionId, userEntryId, approved, source } = {}) {
  runtime(projection); const c = projection.repairChallenges?.get(challengeId);
  if (!c || c.phase !== "created" || c.sessionId !== sessionId || c.expiresAt <= Date.now() || !ID.test(userEntryId || "") || typeof approved !== "boolean" || !["interactive", "rpc"].includes(source)) fail("invalid real user decision");
  return Object.freeze({ events: Object.freeze([event("repair.user_decision_recorded", { challengeId, sessionId, userEntryId, approved, source })]) });
}
export function consumeRepairCapability({ projection, capability } = {}) {
  runtime(projection); const c = projection.repairChallenges?.get(capability?.challengeId);
  if (!c || !exact(capability, ["prefix", "challengeId", "nonce", "singleUse", "action", "subjectHash"])) fail("invalid capability");
  const episode = projection.repairEpisodes.get(c.episodeId); validateCapability(capability, projection, episode, c.action, c.subjectHash);
  return Object.freeze({ events: Object.freeze([event("repair.capability_consumed", { challengeId: c.challengeId, nonceDigest: c.nonceDigest })]) });
}

export function repairEpisodeTransition({ projection, episodeId, event: input, worldSnapshot, gitRunner } = {}) {
  runtime(projection); const episode = projection.repairEpisodes.get(episodeId); if (!episode || !input || typeof input.type !== "string") fail("episode and event required");
  if (input.type === "task.accepted") {
    if (episode.status !== "waiting_for_tasks" || !episode.remediationTaskIds.includes(input.taskId)) fail("accepted task cannot reverify this episode");
    if (!episode.remediationTaskIds.every((id) => id === input.taskId || projection.tasks.get(id)?.status === "accepted")) return Object.freeze({ events: Object.freeze([]) });
    return planReverify(episode, "all remediation tasks accepted");
  }
  if (input.type === "condition.observation_recorded") {
    if (episode.status !== "reverifying" || input.conditionId !== episode.conditionId || !ID.test(input.runId || "") || !HASH.test(input.evidenceId || "")) fail("reobservation ledger references required");
    const { evidence } = ledger(projection, input.runId, input.evidenceId);
    if (!evidence || evidence.conditionId !== episode.conditionId || evidence.verdict?.kind !== "passed") return Object.freeze({ events: Object.freeze([]) });
    const freshness = evaluateConditionGraph({ projection, worldSnapshot, gitRunner }).conditions.get(episode.conditionId);
    if (freshness?.status !== "fresh") return Object.freeze({ events: Object.freeze([]) });
    return Object.freeze({ events: Object.freeze([event("repair.episode_resolved", { episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh passed reobservation" })]) });
  }
  if (input.type === "repair.reject") {
    const subjectHash = rejectSubjectHash(projection, episode); validateCapability(input.capability, projection, episode, "reject", subjectHash);
    return Object.freeze({ events: Object.freeze([event("repair.episode_rejected_by_user", { episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], reasonCode: "repair_rejected" })]) });
  }
  if (input.type === "cancel" || input.type === "cancelled") {
    if (input.type === "cancel" && !new Set(["active", "waiting_for_tasks", "reverifying", "blocked"]).has(episode.status)) fail("episode cannot be cancelled");
    if (input.type === "cancelled" && episode.status !== "cancel_pending") fail("episode must be cancel_pending");
    validateCancellation(input.cancellation, episode, projection);
    return Object.freeze({ events: Object.freeze([event(input.type === "cancel" ? "repair.episode_cancel_requested" : "repair.episode_cancelled", input.type === "cancel" ? { episodeId, cancellation: structuredClone(input.cancellation) } : { episodeId })]) });
  }
  fail("unsupported repair transition");
}
function planReverify(episode, reason) { return Object.freeze({ events: Object.freeze([event("repair.reverification_requested", { episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], remediationTaskIds: [...episode.remediationTaskIds], oldStatus: episode.status, newStatus: "reverifying", reason })]) }); }
function validateCancellation(c, episode, p) {
  if (!exact(c, CANCELLATION_KEYS) || !Array.isArray(c.ownedTaskIds) || !Array.isArray(c.ownedRunIds) || !["terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs"].every((k) => Array.isArray(c[k])) || typeof c.resourceDebt !== "boolean") fail("invalid cancellation proof");
  const exactIds = (actual, expected) => ids(actual, "owned ids") && actual.length === expected.length && actual.every((id) => expected.includes(id));
  if (!exactIds(c.ownedTaskIds, episode.remediationTaskIds) || new Set(c.ownedRunIds).size !== c.ownedRunIds.length) fail("closure ownership mismatch");
  const refs = (list, owners, field) => list.length === owners.length && list.every((ref) => exact(ref, [field, "hash", "state"]) && owners.includes(ref[field]) && HASH.test(ref.hash) && ["closed", "terminal", "released"].includes(ref.state)) && new Set(list.map((r) => r[field])).size === owners.length;
  if (!refs(c.terminalProofRefs, c.ownedRunIds, "runId") || !refs(c.resourceClosureProofRefs, c.ownedRunIds, "runId") || !refs(c.workspaceClosureProofRefs, c.ownedTaskIds, "taskId") || c.ownedTaskIds.some((id) => !["accepted", "failed", "cancelled", "rejected"].includes(p.tasks.get(id)?.status)) || c.ownedRunIds.some((id) => !["terminal", "recorded", "released"].includes(p.observationRuns.get(id)?.phase))) fail("incomplete cancellation closure proof");
}
