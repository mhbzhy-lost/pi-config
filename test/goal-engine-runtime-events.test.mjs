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
function hash(n) { return String(n).padStart(64, "0"); }
function draft() { const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries); return applyEvent(createProjection(), event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), readiness: "draft" }, 1)); }
function calibrating() { let p = draft(); p = applyEvent(p, event("goal.runtime_readiness_recorded", { readiness: "ready" }, 2)); return applyEvent(p, event("goal.runtime_approval_recorded", {}, 3)); }
function evidence(p, artifactId) { return { executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("condition-1").conditionHash, head: "a".repeat(40), adapter: { ref: "oracle", version: "1" }, environment: { ref: "local", fingerprint: "environment-1" }, fixtures: [{ ref: "sample", fingerprint: "fixture-1" }], artifact: { id: artifactId, hash: "9".repeat(64) } }; }
function observationEvents(p, { runId, evidenceId, cycle, verdict = { kind: "passed" }, start }) {
  const data = { runId, conditionId: "condition-1" };
  return [
    event("condition.observation_requested", { ...data, cycle, worldSnapshotHash: hash(start), resourceClaimsHash: hash(start + 1) }, start),
    event("condition.observation_lease_allocated", { ...data, allocationId: `lease-${runId}`, leaseReceiptHash: hash(start + 2) }, start + 1),
    event("condition.observation_process_bound", { ...data, processIdentityHash: hash(start + 3) }, start + 2),
    event("condition.observation_terminal", { ...data, terminalProofHash: hash(start + 4) }, start + 3),
    event("condition.observation_recorded", { ...data, evidenceId, verdict, evidence: evidence(p, `artifact-${runId}`) }, start + 4),
  ];
}
function applyAll(p, entries) { for (const entry of entries) p = applyEvent(p, entry); return p; }
function active({ calibrationVerdict = { kind: "passed" }, productVerdict = { kind: "passed" } } = {}) {
  let p = calibrating();
  p = applyAll(p, observationEvents(p, { runId: "calibration-run", evidenceId: hash(100), cycle: 0, verdict: calibrationVerdict, start: 4 }));
  p = applyEvent(p, event("goal.runtime_activated", {}, 9));
  return applyAll(p, observationEvents(p, { runId: "product-run", evidenceId: hash(200), cycle: 1, verdict: productVerdict, start: 10 }));
}
function appendAll(root, p, entries) { for (const entry of entries) p = appendEvent(root, entry, p.version); return p; }
function world() { return { safe: true, repo: { root: "/repo", head: "a".repeat(40), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "environment-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "fixture-1", available: true }], resources: [], activeRuns: [] }; }

test("runtime draft preserves contract state and observation identity", () => {
  const p = draft();
  assert.equal(p.runtimeState, "draft"); assert.equal(p.runtimeGeneration, "goal-runtime.v1"); assert.equal(p.conditions.get("condition-1").status, "inactive");
  assert.throws(() => applyEvent(p, event("condition.observation_requested", { runId: "bad", conditionId: "condition-1", cycle: 0, worldSnapshotHash: hash(2), resourceClaimsHash: hash(3) }, 2)), /invalid observation request/);
  assert.throws(() => applyEvent(p, { ...event("goal.checkpoint", { nextAction: "a sufficiently concrete historical next action" }, 3), schemaVersion: "planned.v1" }), /mixed event generations/);
});

test("activation requires the latest decidable Cycle0 and never supports Conditions or Findings", () => {
  let p = calibrating();
  p = applyAll(p, observationEvents(p, { runId: "cycle0-pass", evidenceId: hash(101), cycle: 0, start: 4 }));
  assert.deepEqual(p.conditions.get("condition-1").supportingEvidenceIds, []); assert.equal(p.conditions.get("condition-1").status, "inactive");
  assert.throws(() => applyEvent(p, event("finding.recorded", { findingId: "cycle0-finding", conditionId: "condition-1", runId: "cycle0-pass", evidenceId: hash(101), fingerprint: hash(102) }, 9)), /finding requires/);
  p = applyEvent(p, event("goal.runtime_activated", {}, 9)); assert.equal(p.runtimeState, "active");
  for (const [name, verdict] of [["inconclusive", { kind: "inconclusive", reason: "unknown" }], ["infra", { kind: "infrastructure_error", reason: "offline" }]]) {
    let candidate = calibrating(); candidate = applyAll(candidate, observationEvents(candidate, { runId: `${name}-pass`, evidenceId: hash(110), cycle: 0, start: 4 }));
    candidate = applyAll(candidate, observationEvents(candidate, { runId: `${name}-latest`, evidenceId: hash(120), cycle: 0, verdict, start: 9 }));
    assert.throws(() => applyEvent(candidate, event("goal.runtime_activated", {}, 14)), /decidable cycle zero/);
  }
});

test("product observations use Cycle1 evidence independently from Cycle0", () => {
  const p = active(); const condition = p.conditions.get("condition-1");
  assert.equal(p.runtimeState, "active"); assert.deepEqual(condition.supportingEvidenceIds, [hash(200)]);
  assert.deepEqual(p.evidenceHistory.map((row) => row.evidenceId), [hash(100), hash(200)]);
  assert.notEqual(p.evidenceHistory[0].run.runId, p.evidenceHistory[1].run.runId); assert.notEqual(p.evidenceHistory[0].artifact.id, p.evidenceHistory[1].artifact.id);
  assert.equal(evaluateConditionGraph({ projection: p, worldSnapshot: world() }).conditions.get("condition-1").status, "fresh");
});

test("Finding and Repair derive only from active product failed evidence", () => {
  let p = active({ productVerdict: { kind: "failed", failureCode: "assertion", findingFingerprint: hash(300) } });
  p.conditions.get("condition-1").definition.remediation.policy = "autonomous";
  p = applyEvent(p, event("finding.recorded", { findingId: "finding-1", conditionId: "condition-1", runId: "product-run", evidenceId: hash(200), fingerprint: hash(300) }, 15));
  p = applyEvent(p, event("repair.episode_opened", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"] }, 16));
  p.tasks.get("task-1").status = "accepted"; const repairTask = p.tasks.get("task-1"); repairTask.metadata = { kind: "remediation", goalId: p.goalId, executionRevision: p.executionRevision, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], subjectHash: remediationSubjectHash({ goalId: p.goalId, executionRevision: p.executionRevision, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], task: repairTask }), taskDefHash: taskContractHash(repairTask) };
  p = applyEvent(p, event("repair.task_linked", { episodeId: "episode-1", taskId: "task-1", challengeId: null }, 17));
  assert.equal(p.repairEpisodes.get("episode-1").status, "waiting_for_tasks");
});

test("amendment enters suspended through its durable runtime event", () => {
  let p = active(); p = applyEvent(p, event("goal.runtime_suspended", { suspensionId: "s-1", reason: "amend execution" }, 15));
  assert.equal(p.runtimeState, "suspended");
  p = applyEvent(p, event("execution.amendment_proposed", { proposalId: "p", proposalHash: hash(1), changesHash: hash(2), oldRevision: 1, newRevision: 2 }, 16));
  p = applyEvent(p, event("execution.amendment_approved", { proposalId: "p", proposalHash: hash(1), sessionId: "s", userEntryId: "u" }, 17));
  p = applyEvent(p, event("execution.amendment_capability_consumed", { proposalId: "p", nonceDigest: hash(3) }, 18));
  p = applyEvent(p, event("execution.amendment_applied", { proposalId: "p", oldRevision: 1, newRevision: 2, contractHash: hash(4), reconciliation: [] }, 19));
  assert.equal(p.executionRevision, 2);
});

test("runtime evidence ledger survives store replay with calibration and product histories", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-runtime-ledger-"));
  try {
    let p = createProjection(); const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
    p = appendAll(root, p, [event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), readiness: "draft" }, 1), event("goal.runtime_readiness_recorded", { readiness: "ready" }, 2), event("goal.runtime_approval_recorded", {}, 3)]);
    p = appendAll(root, p, observationEvents(p, { runId: "calibration-run", evidenceId: hash(100), cycle: 0, start: 4 })); p = appendEvent(root, event("goal.runtime_activated", {}, 9), p.version);
    p = appendAll(root, p, observationEvents(p, { runId: "product-run", evidenceId: hash(200), cycle: 1, start: 10 }));
    const replayed = loadProjection(root, "runtime-goal"), snapshot = JSON.parse(readFileSync(join(root, "goals/runtime-goal/projection.json"), "utf8"));
    assert.deepEqual(replayed.evidenceHistory, p.evidenceHistory); assert.equal(projectionStateHash(replayed), projectionStateHash(p));
    assert.deepEqual(snapshot.evidenceHistory.map((row) => row.evidenceId), [hash(100), hash(200)]); assert.deepEqual(replayed.conditions.get("condition-1").supportingEvidenceIds, [hash(200)]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime store replay persists repair challenge after complete calibration, activation, and product failure", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-runtime-repair-"));
  try {
    let p = createProjection(); const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
    p = appendAll(root, p, [event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), readiness: "draft" }, 1), event("goal.runtime_readiness_recorded", { readiness: "ready" }, 2), event("goal.runtime_approval_recorded", {}, 3)]);
    p = appendAll(root, p, observationEvents(p, { runId: "calibration-run", evidenceId: hash(100), cycle: 0, start: 4 })); p = appendEvent(root, event("goal.runtime_activated", {}, 9), p.version);
    p = appendAll(root, p, observationEvents(p, { runId: "product-run", evidenceId: hash(200), cycle: 1, verdict: { kind: "failed", failureCode: "assertion", findingFingerprint: hash(300) }, start: 10 }));
    p = appendEvent(root, event("finding.recorded", { findingId: "finding-1", conditionId: "condition-1", runId: "product-run", evidenceId: hash(200), fingerprint: hash(300) }, 15), p.version); p = appendEvent(root, event("repair.episode_opened", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"] }, 16), p.version);
    const challenge = createRepairChallenge({ projection: p, episodeId: "episode-1", action: "reject", sessionId: "session-1", requestedAt: 20, expiresAt: 30, subjectHash: rejectSubjectHash(p, p.repairEpisodes.get("episode-1")) });
    p = appendEvent(root, event(challenge.events[0].type, challenge.events[0].data, 17), p.version); const decision = recordRepairUserDecision({ projection: p, challengeId: challenge.challengeId, sessionId: "session-1", userEntryId: "entry-1", approved: true, source: "interactive", recordedAt: 21 });
    p = appendEvent(root, event(decision.events[0].type, decision.events[0].data, 18), p.version); p = loadProjection(root, "runtime-goal"); const capability = issueRepairCapability({ projection: p, challengeId: challenge.challengeId, now: 22 }); const plan = repairEpisodeTransition({ projection: p, episodeId: "episode-1", event: { type: "repair.reject", capability, consumedAt: 23 } });
    for (const [index, entry] of plan.events.entries()) p = appendEvent(root, event(entry.type, entry.data, 19 + index), p.version);
    const replayed = loadProjection(root, "runtime-goal"); assert.equal(replayed.repairEpisodes.get("episode-1").status, "resolved"); assert.deepEqual(replayed.evidenceHistory.map((row) => row.evidenceId), [hash(100), hash(200)]); assert.equal(replayed.conditions.get("condition-1").supportingEvidenceIds.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
