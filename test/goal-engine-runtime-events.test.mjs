import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, loadProjection, projectionStateHash } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { evaluateConditionGraph } from "../scripts/lib/goal-engine/condition-validity.mjs";
import { taskContractHash, remediationSubjectHash } from "../scripts/lib/goal-engine/task-definition.mjs";
import { createRepairChallenge, issueRepairCapability, recordRepairUserDecision, repairEpisodeTransition, rejectSubjectHash } from "../scripts/lib/goal-engine/repair-policy.mjs";

function event(type, data, n) { return { schemaVersion: "goal-runtime.v1", eventId: `runtime-${n}`, goalId: "runtime-goal", occurredAt: `2026-08-13T00:00:${String(n).padStart(2, "0")}.000Z`, type, data }; }
function draft() { const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries); return applyEvent(createProjection(), event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), readiness: "draft" }, 1)); }

function evidence(p, verdict = { kind: "passed" }) {
  return { executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("condition-1").conditionHash, head: "a".repeat(40), adapter: { ref: "oracle", version: "1" }, environment: { ref: "local", fingerprint: "environment-1" }, fixtures: [{ ref: "sample", fingerprint: "fixture-1" }], artifact: { id: "artifact-1", hash: "9".repeat(64) }, verdict };
}
function observed(p, verdict) {
  p = applyEvent(p, event("condition.observation_requested", { runId: "run-1", conditionId: "condition-1", cycle: 0, worldSnapshotHash: "a".repeat(64), resourceClaimsHash: "b".repeat(64) }, 2));
  p = applyEvent(p, event("condition.observation_lease_allocated", { runId: "run-1", conditionId: "condition-1", allocationId: "lease-1", leaseReceiptHash: "c".repeat(64) }, 3));
  p = applyEvent(p, event("condition.observation_process_bound", { runId: "run-1", conditionId: "condition-1", processIdentityHash: "d".repeat(64) }, 4));
  p = applyEvent(p, event("condition.observation_terminal", { runId: "run-1", conditionId: "condition-1", terminalProofHash: "e".repeat(64) }, 5));
  const { verdict: derivedVerdict, ...summary } = evidence(p, verdict);
  return applyEvent(p, event("condition.observation_recorded", { runId: "run-1", conditionId: "condition-1", evidenceId: "8".repeat(64), verdict: derivedVerdict, evidence: summary }, 6));
}

test("runtime draft preserves contract state and observation identity", () => {
  let p = draft();
  assert.equal(p.runtimeGeneration, "goal-runtime.v1"); assert.equal(p.initialShape, "hybrid"); assert.equal(p.conditions.get("condition-1").status, "inactive");
  p = applyEvent(p, event("condition.observation_requested", { runId: "run-1", conditionId: "condition-1", cycle: 0, worldSnapshotHash: "a".repeat(64), resourceClaimsHash: "b".repeat(64) }, 2));
  assert.equal(p.observationRuns.get("run-1").allocationId, null); assert.equal(p.conditions.get("condition-1").lastObservationRunId, "run-1");
  assert.throws(() => applyEvent(p, event("finding.recorded", { findingId: "f-1", conditionId: "condition-1", runId: "run-1", evidenceId: "e-1", fingerprint: "f".repeat(64) }, 3)), /failed ledger|terminal/);
  assert.throws(() => applyEvent(p, { ...event("goal.checkpoint", { nextAction: "a sufficiently concrete historical next action" }, 3), schemaVersion: "planned.v1" }), /mixed event generations/);
});

test("runtime FSM accepts only exact ordered observation, finding, repair, amendment and review events", () => {
  let p = observed(draft(), { kind: "failed", failureCode: "assertion", findingFingerprint: "f".repeat(64) }); p.conditions.get("condition-1").definition.remediation.policy = "autonomous";
  p = applyEvent(p, event("finding.recorded", { findingId: "finding-1", conditionId: "condition-1", runId: "run-1", evidenceId: "8".repeat(64), fingerprint: "f".repeat(64) }, 7));
  p = applyEvent(p, event("repair.episode_opened", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"] }, 8));
  p.tasks.get("task-1").status = "accepted"; const repairTask = p.tasks.get("task-1"); repairTask.metadata = { kind: "remediation", goalId: p.goalId, executionRevision: p.executionRevision, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], subjectHash: remediationSubjectHash({ goalId: p.goalId, executionRevision: p.executionRevision, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], task: repairTask }), taskDefHash: taskContractHash(repairTask) };
  p = applyEvent(p, event("repair.task_linked", { episodeId: "episode-1", taskId: "task-1", challengeId: null }, 9));
  p = applyEvent(p, event("repair.reverification_requested", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], remediationTaskIds: ["task-1"], oldStatus: "waiting_for_tasks", newStatus: "reverifying", reason: "accepted repair" }, 10));
  assert.equal(p.repairEpisodes.get("episode-1").status, "reverifying");
  p = applyEvent(p, event("repair.episode_resolved", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh evidence" }, 11));
  assert.equal(p.findings.get("finding-1").status, "resolved");
  p = applyEvent(p, event("execution.amendment_proposed", { proposalId: "p", proposalHash: "1".repeat(64), changesHash: "2".repeat(64), oldRevision: 1, newRevision: 2 }, 12));
  p = applyEvent(p, event("execution.amendment_approved", { proposalId: "p", proposalHash: "1".repeat(64), sessionId: "s", userEntryId: "u" }, 13));
  p = applyEvent(p, event("execution.amendment_capability_consumed", { proposalId: "p", nonceDigest: "3".repeat(64) }, 14));
  p = applyEvent(p, event("execution.amendment_applied", { proposalId: "p", oldRevision: 1, newRevision: 2, contractHash: "4".repeat(64), reconciliation: [] }, 15));
  assert.equal(p.executionRevision, 2);
  const passed = observed(draft(), { kind: "passed" });
  assert.throws(() => applyEvent(passed, event("finding.recorded", { findingId: "bad", conditionId: "condition-1", runId: "run-1", evidenceId: "8".repeat(64), fingerprint: "f".repeat(64) }, 7)), /failed/);
});

test("runtime reducer records canonical evidence with derived authority", () => {
  const p = observed(draft());
  const row = p.evidenceHistory[0];
  assert.deepEqual(Object.keys(row).sort(), ["adapter", "artifact", "conditionHash", "conditionId", "environment", "evidenceId", "executionContractHash", "executionRevision", "fixtures", "head", "mutationSequence", "run", "sequence", "terminalProofHash", "verdict"].sort());
  assert.equal(row.sequence, 1); assert.equal(row.mutationSequence, p.mutationSequence); assert.equal(row.run.runId, "run-1"); assert.equal(row.run.state, "terminal");
  const before = structuredClone(p); const malformed = event("condition.observation_recorded", { runId: "run-1", conditionId: "condition-1", evidenceId: "7".repeat(64), verdict: { kind: "passed" }, evidence: { ...evidence(p, { kind: "passed" }), command: "leak" } }, 7);
  assert.throws(() => applyEvent(p, malformed), /record|evidence|field/i); assert.deepEqual(p, before);
});

test("runtime task mutations invalidate replayed ledger evidence while observation noise does not", () => {
  let p = observed(draft()); const evidenceMutation = p.mutationSequence;
  const world = { safe: true, repo: { root: "/repo", head: "a".repeat(40), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "environment-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "fixture-1", available: true }], resources: [], activeRuns: [] };
  assert.equal(evaluateConditionGraph({ projection: p, worldSnapshot: world }).conditions.get("condition-1").status, "fresh");
  p = applyEvent(p, event("condition.observation_released", { runId: "run-1", conditionId: "condition-1" }, 7));
  assert.equal(p.mutationSequence, evidenceMutation); assert.equal(evaluateConditionGraph({ projection: p, worldSnapshot: world }).conditions.get("condition-1").status, "fresh");
  p = applyEvent(p, event("task.dispatched", { taskId: "task-1", contractHash: "1".repeat(64), workspace: { attempt: 1, path: "/tmp/runtime-task", branch: "runtime-task", baseCommit: "a".repeat(40) } }, 8));
  assert.equal(p.mutationSequence, evidenceMutation + 1); assert.equal(p.taskMutationSequences.get("task-1"), p.mutationSequence);
  assert.equal(evaluateConditionGraph({ projection: p, worldSnapshot: world }).conditions.get("condition-1").status, "stale");
});

test("runtime evidence ledger survives store replay and snapshot hashing", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-runtime-ledger-"));
  try {
    const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
    const events = [event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), readiness: "draft" }, 1), event("condition.observation_requested", { runId: "run-1", conditionId: "condition-1", cycle: 0, worldSnapshotHash: "a".repeat(64), resourceClaimsHash: "b".repeat(64) }, 2), event("condition.observation_lease_allocated", { runId: "run-1", conditionId: "condition-1", allocationId: "lease-1", leaseReceiptHash: "c".repeat(64) }, 3), event("condition.observation_process_bound", { runId: "run-1", conditionId: "condition-1", processIdentityHash: "d".repeat(64) }, 4), event("condition.observation_terminal", { runId: "run-1", conditionId: "condition-1", terminalProofHash: "e".repeat(64) }, 5)];
    let p = createProjection(); for (const entry of events) { p = appendEvent(root, entry, p.version); }
    const { verdict, ...summary } = evidence(p); p = appendEvent(root, event("condition.observation_recorded", { runId: "run-1", conditionId: "condition-1", evidenceId: "8".repeat(64), verdict, evidence: summary }, 6), p.version);
    const replayed = loadProjection(root, "runtime-goal"), snapshot = JSON.parse(readFileSync(join(root, "goals/runtime-goal/projection.json"), "utf8"));
    assert.deepEqual(replayed.evidenceHistory, p.evidenceHistory); assert.deepEqual([...replayed.taskMutationSequences], [...p.taskMutationSequences]); assert.equal(projectionStateHash(replayed), projectionStateHash(p)); assert.equal(snapshot.evidenceHistory[0].terminalProofHash, "e".repeat(64)); assert.deepEqual(snapshot.taskMutationSequences, { "task-1": 0 });
    const world = { safe: true, repo: { root: "/repo", head: "a".repeat(40), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "environment-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "fixture-1", available: true }], resources: [], activeRuns: [] };
    assert.equal(evaluateConditionGraph({ projection: replayed, worldSnapshot: world }).conditions.get("condition-1").status, "fresh");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime store replay persists only challenge bindings through approved reject consumption", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-runtime-repair-"));
  try {
    const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
    const entries = [event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), readiness: "draft" }, 1)];
    let p = createProjection(); for (const entry of entries) p = appendEvent(root, entry, p.version);
    for (const entry of [event("condition.observation_requested", { runId: "run-1", conditionId: "condition-1", cycle: 0, worldSnapshotHash: "a".repeat(64), resourceClaimsHash: "b".repeat(64) }, 2), event("condition.observation_lease_allocated", { runId: "run-1", conditionId: "condition-1", allocationId: "lease-1", leaseReceiptHash: "c".repeat(64) }, 3), event("condition.observation_process_bound", { runId: "run-1", conditionId: "condition-1", processIdentityHash: "d".repeat(64) }, 4), event("condition.observation_terminal", { runId: "run-1", conditionId: "condition-1", terminalProofHash: "e".repeat(64) }, 5)]) p = appendEvent(root, entry, p.version);
    const { verdict, ...summary } = evidence(p, { kind: "failed", failureCode: "assertion", findingFingerprint: "f".repeat(64) });
    p = appendEvent(root, event("condition.observation_recorded", { runId: "run-1", conditionId: "condition-1", evidenceId: "8".repeat(64), verdict, evidence: summary }, 6), p.version);
    p = appendEvent(root, event("finding.recorded", { findingId: "finding-1", conditionId: "condition-1", runId: "run-1", evidenceId: "8".repeat(64), fingerprint: "f".repeat(64) }, 7), p.version);
    p = appendEvent(root, event("repair.episode_opened", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"] }, 8), p.version);
    const challenge = createRepairChallenge({ projection: p, episodeId: "episode-1", action: "reject", sessionId: "session-1", requestedAt: 10, expiresAt: 30, subjectHash: rejectSubjectHash(p, p.repairEpisodes.get("episode-1")) });
    p = appendEvent(root, event(challenge.events[0].type, challenge.events[0].data, 9), p.version);
    const decision = recordRepairUserDecision({ projection: p, challengeId: challenge.challengeId, sessionId: "session-1", userEntryId: "entry-1", approved: true, source: "interactive", recordedAt: 20 });
    p = appendEvent(root, event(decision.events[0].type, decision.events[0].data, 10), p.version);
    p = loadProjection(root, "runtime-goal"); const capability = issueRepairCapability({ projection: p, challengeId: challenge.challengeId, now: 21 });
    const plan = repairEpisodeTransition({ projection: p, episodeId: "episode-1", event: { type: "repair.reject", capability, consumedAt: 22 } });
    const versionBeforeExpired = p.version, expired = { ...plan.events[0], data: { ...plan.events[0].data, consumedAt: 30 } };
    assert.throws(() => appendEvent(root, event(expired.type, expired.data, 11), p.version), /consume/);
    assert.equal(loadProjection(root, "runtime-goal").version, versionBeforeExpired);
    for (const [index, entry] of plan.events.entries()) p = appendEvent(root, event(entry.type, entry.data, 12 + index), p.version);
    const replayed = loadProjection(root, "runtime-goal"), persisted = readFileSync(join(root, "goals/runtime-goal/events.jsonl"), "utf8");
    assert.equal(replayed.repairEpisodes.get("episode-1").status, "resolved"); assert.equal(replayed.repairChallenges.get(challenge.challengeId).phase, "applied"); assert.equal(replayed.repairChallenges.get(challenge.challengeId).recordedAt, 20); assert.equal(replayed.repairChallenges.get(challenge.challengeId).consumedAt, 22); assert.equal(persisted.includes(capability.nonce), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime accept never completes and accepted tasks cannot regress", () => {
  let p = draft(); const task = p.tasks.get("task-1"); task.status = "succeeded"; task.workspace = { attempt: 1, phase: "disposed", disposition: "integrated", released: true };
  p = applyEvent(p, event("task.accepted", { taskId: "task-1", workspaceAttempt: 1 }, 2));
  assert.equal(p.lifecycle, "active"); assert.equal(p.tasks.get("task-1").status, "accepted");
  assert.throws(() => applyEvent(p, event("task.dispatched", { taskId: "task-1", contractHash: "a".repeat(64), workspace: { attempt: 2, path: "/tmp/a", branch: "x", baseCommit: "b".repeat(40) } }, 3)), /not pending/);
});
