import { createHash, randomBytes } from "node:crypto";
import { evaluateConditionGraph } from "./condition-validity.mjs";
import { validateRemediationMetadata, validateTaskDefinitions, taskContractHash, remediationSubjectHash as taskSubjectHash } from "./task-definition.mjs";

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
  if (!run || run.cycle === 0 || run.phase !== "recorded" || run.evidenceId !== evidenceId || !evidence || evidence.conditionId !== run.conditionId
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

export function remediationSubjectHash(projection, episode, findingIds, taskDef) { return taskSubjectHash({ goalId: projection.goalId, executionRevision: projection.executionRevision, episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds, task: taskDef }); }
export function rejectSubjectHash(projection, episode) { return digest({ goalId: projection.goalId, executionRevision: projection.executionRevision, episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds].sort() }); }
const publicBinding = (c) => ({ challengeId: c.challengeId, episodeId: c.episodeId, action: c.action, subjectHash: c.subjectHash, sessionId: c.sessionId, userEntryId: c.userEntryId });
function actionAllowed(episode, action) { return action === "authorize_task" ? episode?.status === "active" : action === "reject" && ["active", "waiting_for_tasks", "reverifying"].includes(episode?.status); }
function validateCapability(capability, p, episode, action, subjectHash, consumedAt) {
  if (!Number.isFinite(consumedAt) || !actionAllowed(episode, action) || !exact(capability, ["prefix", "goalId", "executionRevision", "challengeId", "episodeId", "action", "subjectHash", "sessionId", "userEntryId", "nonce", "singleUse"]) || capability.prefix !== "goal-repair-capability.v1" || capability.goalId !== p.goalId || capability.executionRevision !== p.executionRevision || capability.episodeId !== episode?.episodeId || capability.action !== action || capability.subjectHash !== subjectHash || capability.singleUse !== true || typeof capability.nonce !== "string" || !capability.nonce) fail("durable challenge-bound capability required");
  const c = p.repairChallenges?.get(capability.challengeId);
  if (!c || c.executionRevision !== p.executionRevision || c.phase !== "approved" || c.recordedAt > consumedAt || consumedAt >= c.expiresAt || Object.entries(publicBinding(c)).some(([key, value]) => capability[key] !== value)) fail("challenge capability is not valid");
  return c;
}
export function issueRepairCapability({ projection, challengeId, now } = {}) {
  runtime(projection); const c = projection.repairChallenges?.get(challengeId), episode = projection.repairEpisodes?.get(c?.episodeId);
  if (!c || c.executionRevision !== projection.executionRevision || !actionAllowed(episode, c.action) || c.phase !== "approved" || !Number.isFinite(now) || now >= c.expiresAt) fail("approved unexpired challenge required");
  return Object.freeze({ prefix: "goal-repair-capability.v1", goalId: projection.goalId, executionRevision: projection.executionRevision, ...publicBinding(c), nonce: randomBytes(32).toString("hex"), singleUse: true });
}
export function validateRemediationTask({ projection, episodeId, findingIds, taskDef, capability, consumedAt } = {}) {
  runtime(projection); if (!ID.test(episodeId || "")) fail("episode id required"); ids(findingIds, "findingIds"); const episode = projection.repairEpisodes.get(episodeId);
  if (!episode || episode.status !== "active" || findingIds.length !== episode.findingIds.length || findingIds.some((id) => !episode.findingIds.includes(id))) fail("finding set must exactly match active episode");
  const state = condition(projection, episode.conditionId), remediation = state.definition.remediation, taskId = `repair-task-${episodeId}-${episode.remediationTaskIds.length + 1}`;
  if (!taskDef || typeof taskDef !== "object" || Array.isArray(taskDef) || Object.hasOwn(taskDef, "metadata")) fail("caller may not set repair metadata"); validateTaskDefinitions([taskId], { [taskId]: taskDef }, { planned: true });
  if (taskDef.workflow !== "tdd" || !Array.isArray(projection.writePolicy?.allowedPaths) || !Array.isArray(remediation.allowed_paths) || !taskDef.writePaths.every((path) => pathCovered(path, projection.writePolicy.allowedPaths) && pathCovered(path, remediation.allowed_paths))) fail("write paths are not a provable subset of repair scope");
  const internal = { ...structuredClone(taskDef), metadata: { kind: "remediation", goalId: projection.goalId, executionRevision: projection.executionRevision, episodeId, conditionId: episode.conditionId, findingIds: [...findingIds].sort(), subjectHash: remediationSubjectHash(projection, episode, findingIds, taskDef), taskDefHash: taskContractHash(taskDef) } };
  if (remediation.policy === "user-approved") { const c = validateCapability(capability, projection, episode, "authorize_task", internal.metadata.subjectHash, consumedAt); return Object.freeze({ taskId, taskDef: Object.freeze(internal), events: Object.freeze([amendmentEvent(taskId, internal), consumeEvent(c, capability, consumedAt), event("repair.task_linked", { episodeId, taskId, challengeId: c.challengeId })]) }); }
  if (remediation.policy !== "autonomous") fail("unknown remediation policy"); return Object.freeze({ taskId, taskDef: Object.freeze(internal), events: Object.freeze([amendmentEvent(taskId, internal), event("repair.task_linked", { episodeId, taskId, challengeId: null })]) });
}
function amendmentEvent(taskId, taskDef) { return event("goal.amended", { addTasks: { [taskId]: taskDef }, removeTasks: [], updateTasks: {}, reason: "Materialize canonical remediation task", hostInternalRemediation: true }); }
function consumeEvent(c, capability, consumedAt) { return event("repair.capability_consumed", { nonceDigest: createHash("sha256").update(capability.nonce).digest("hex"), consumedAt, ...publicBinding(c) }); }
export function createRepairChallenge({ projection, episodeId, action, sessionId, requestedAt, expiresAt, subjectHash } = {}) {
  runtime(projection); const episode = projection.repairEpisodes.get(episodeId); if (!episode || !actionAllowed(episode, action) || !ID.test(sessionId || "") || !Number.isFinite(requestedAt) || !Number.isFinite(expiresAt) || expiresAt <= requestedAt || !HASH.test(subjectHash || "")) fail("invalid repair challenge");
  if (action === "reject" && subjectHash !== rejectSubjectHash(projection, episode)) fail("reject subject mismatch"); const challengeId = `repair-challenge-${digest({ episodeId, action, subjectHash, requestedAt }).slice(0, 32)}`;
  return Object.freeze({ challengeId, events: Object.freeze([event("repair.challenge_created", { challengeId, executionRevision: projection.executionRevision, episodeId, action, subjectHash, sessionId, requestedAt, expiresAt })]) });
}
export function recordRepairUserDecision({ projection, challengeId, sessionId, userEntryId, approved, source, recordedAt } = {}) {
  runtime(projection); const c = projection.repairChallenges?.get(challengeId); if (!c || c.phase !== "created" || c.sessionId !== sessionId || !Number.isFinite(recordedAt) || recordedAt < c.requestedAt || recordedAt >= c.expiresAt || !ID.test(userEntryId || "") || typeof approved !== "boolean" || !["interactive", "rpc"].includes(source)) fail("invalid real user decision");
  return Object.freeze({ events: Object.freeze([event("repair.user_decision_recorded", { challengeId, sessionId, userEntryId, approved, source, recordedAt })]) });
}
export function consumeRepairCapability({ projection, capability, consumedAt } = {}) { runtime(projection); const c = validateCapability(capability, projection, projection.repairEpisodes.get(capability?.episodeId), capability?.action, capability?.subjectHash, consumedAt); return Object.freeze({ events: Object.freeze([consumeEvent(c, capability, consumedAt)]) }); }

export function planRepairObservationLink({ projection, episodeId, runId } = {}) { runtime(projection); const episode = projection.repairEpisodes.get(episodeId), run = projection.observationRuns.get(runId); if (!episode || episode.status !== "reverifying" || !run || run.phase !== "requested" || run.conditionId !== episode.conditionId || episode.ownedRunIds?.includes(runId)) fail("reobservation must be requested and unlinked"); return Object.freeze({ events: Object.freeze([event("repair.observation_linked", { episodeId, conditionId: episode.conditionId, runId })]) }); }
export function repairEpisodeTransition({ projection, episodeId, event: input, worldSnapshot, gitRunner } = {}) {
  runtime(projection); const episode = projection.repairEpisodes.get(episodeId); if (!episode || !input || typeof input.type !== "string") fail("episode and event required");
  if (input.type === "task.accepted") {
    if (episode.status !== "waiting_for_tasks" || !episode.remediationTaskIds.includes(input.taskId)) fail("accepted task cannot reverify this episode");
    if (!episode.remediationTaskIds.every((id) => id === input.taskId || projection.tasks.get(id)?.status === "accepted")) return Object.freeze({ events: Object.freeze([]) });
    return planReverify(episode, "all remediation tasks accepted");
  }
  if (input.type === "condition.observation_recorded") {
    if (episode.status !== "reverifying" || input.conditionId !== episode.conditionId || !ID.test(input.runId || "") || !HASH.test(input.evidenceId || "")) fail("reobservation ledger references required");
    const { run, evidence } = ledger(projection, input.runId, input.evidenceId); const state = condition(projection, episode.conditionId);
    if (!episode.ownedRunIds?.includes(input.runId) || !run || run.phase !== "recorded" || run.conditionId !== episode.conditionId || run.evidenceId !== input.evidenceId || state.supportingEvidenceIds?.at(-1) !== input.evidenceId || !evidence || evidence.conditionId !== episode.conditionId || evidence.verdict?.kind !== "passed") return Object.freeze({ events: Object.freeze([]) });
    const freshness = evaluateConditionGraph({ projection, worldSnapshot, gitRunner }).conditions.get(episode.conditionId);
    if (freshness?.status !== "fresh") return Object.freeze({ events: Object.freeze([]) });
    return Object.freeze({ events: Object.freeze([event("repair.episode_resolved", { episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh passed reobservation" })]) });
  }
  if (input.type === "repair.reject") {
    const subjectHash = rejectSubjectHash(projection, episode), c = validateCapability(input.capability, projection, episode, "reject", subjectHash, input.consumedAt);
    return Object.freeze({ events: Object.freeze([consumeEvent(c, input.capability, input.consumedAt), event("repair.episode_rejected_by_user", { episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], challengeId: c.challengeId, reasonCode: "repair_rejected" })]) });
  }
  if (input.type === "cancel" || input.type === "cancelled") {
    if (input.type === "cancel" && !new Set(["active", "waiting_for_tasks", "reverifying", "blocked"]).has(episode.status)) fail("episode cannot be cancelled");
    if (input.type === "cancelled" && (episode.status !== "cancel_pending" || JSON.stringify(canonical(input.cancellation)) !== JSON.stringify(canonical(episode.cancellation)))) fail("stored cancellation mismatch");
    validateCancellation(input.cancellation, episode, projection);
    return Object.freeze({ events: Object.freeze([event(input.type === "cancel" ? "repair.episode_cancel_requested" : "repair.episode_cancelled", { episodeId, cancellation: structuredClone(input.cancellation) })]) });
  }
  fail("unsupported repair transition");
}
function planReverify(episode, reason) { return Object.freeze({ events: Object.freeze([event("repair.reverification_requested", { episodeId: episode.episodeId, conditionId: episode.conditionId, findingIds: [...episode.findingIds], remediationTaskIds: [...episode.remediationTaskIds], oldStatus: episode.status, newStatus: "reverifying", reason })]) }); }
function validateCancellation(c, episode, p) {
  if (!exact(c, CANCELLATION_KEYS) || !Array.isArray(c.ownedTaskIds) || !Array.isArray(c.ownedRunIds) || !["terminalProofRefs", "workspaceClosureProofRefs", "resourceClosureProofRefs"].every((k) => Array.isArray(c[k])) || typeof c.resourceDebt !== "boolean") fail("invalid cancellation proof");
  const exactIds = (actual, expected) => actual.every((id) => typeof id === "string" && ID.test(id)) && new Set(actual).size === actual.length && actual.length === expected.length && actual.every((id) => expected.includes(id));
  if (!exactIds(c.ownedTaskIds, episode.remediationTaskIds) || !exactIds(c.ownedRunIds, episode.ownedRunIds || [])) fail("closure ownership mismatch");
  const terminal = c.terminalProofRefs.length === c.ownedRunIds.length && c.terminalProofRefs.every((ref) => exact(ref, ["runId", "proofHash", "phase"]) && c.ownedRunIds.includes(ref.runId) && HASH.test(ref.proofHash) && p.observationRuns.get(ref.runId)?.phase === ref.phase && ["terminal", "recorded", "released"].includes(ref.phase)) && new Set(c.terminalProofRefs.map((ref) => ref.runId)).size === c.ownedRunIds.length;
  const workspace = c.workspaceClosureProofRefs.length === c.ownedTaskIds.length && c.workspaceClosureProofRefs.every((ref) => exact(ref, ["taskId", "proofHash", "disposition", "released"]) && c.ownedTaskIds.includes(ref.taskId) && HASH.test(ref.proofHash) && ref.released === true && (p.tasks.get(ref.taskId)?.workspace ? ["integrated", "discarded", "preserved"].includes(ref.disposition) && p.tasks.get(ref.taskId).workspace.disposition === ref.disposition && p.tasks.get(ref.taskId).workspace.released === true : p.tasks.get(ref.taskId)?.status === "pending" && p.tasks.get(ref.taskId)?.attempts === 0 && ref.disposition === "never_started")) && new Set(c.workspaceClosureProofRefs.map((ref) => ref.taskId)).size === c.ownedTaskIds.length;
  const resource = c.resourceClosureProofRefs.length === c.ownedRunIds.length && c.resourceClosureProofRefs.every((ref) => exact(ref, ["runId", "proofHash", "state", "debt"]) && c.ownedRunIds.includes(ref.runId) && HASH.test(ref.proofHash) && typeof ref.debt === "boolean" && ["released", "quarantined"].includes(ref.state)) && new Set(c.resourceClosureProofRefs.map((ref) => ref.runId)).size === c.ownedRunIds.length;
  if (!terminal || !workspace || !resource || c.resourceDebt !== c.resourceClosureProofRefs.some((ref) => ref.debt || ref.state === "quarantined")) fail("incomplete cancellation closure proof");
}
