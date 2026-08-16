import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection, schemaVersionForMutation } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, loadProjection, projectionStateHash } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { evaluateConditionGraph } from "../scripts/lib/goal-engine/condition-validity.mjs";
import { createRepairChallenge, issueRepairCapability, recordRepairUserDecision, repairEpisodeTransition, rejectSubjectHash, validateRemediationTask } from "../scripts/lib/goal-engine/repair-policy.mjs";

function event(type, data, n) { return { schemaVersion: "goal-runtime.v1", eventId: `runtime-${n}`, goalId: "runtime-goal", occurredAt: `2026-08-13T00:00:${String(n).padStart(2, "0")}.000Z`, type, data }; }
function hash(n) { return String(n).padStart(64, "0"); }
function runtimeApprovalHash({ goalId = "runtime-goal", proposalId = "proposal", executionContractHash, baseHead = "a".repeat(40), sessionId = "session" }) { return createHash("sha256").update(JSON.stringify({ baseHead, executionContractHash, goalId, proposalId, sessionId })).digest("hex"); }
function draft() { const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries); let p = applyEvent(createProjection(), event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: "a".repeat(40), readiness: "draft" }, 1)); return applyEvent(p, event("goal.session_bound", { sessionId: "session", leafId: "leaf" }, 0)); }
function calibrating() { let p = draft(); p = applyEvent(p, event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 2)); const approval = { proposalId: "proposal", executionContractHash: p.executionContractHash, baseHead: p.runtimeBaseHead, sessionId: "session" }; return applyEvent(p, event("goal.runtime_approval_recorded", { ...approval, proposalHash: runtimeApprovalHash(approval), userEntryId: "entry", capabilityDigest: hash(2) }, 3)); }
function evidence(p, artifactId, environment = { ref: "local", fingerprint: "environment-1" }) { return { executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("condition-1").conditionHash, head: "a".repeat(40), adapter: { ref: "oracle", version: "1" }, environment, fixtures: [{ ref: "sample", fingerprint: "fixture-1" }], artifact: { id: artifactId, hash: "9".repeat(64) } }; }
function observationEvents(p, { runId, evidenceId, cycle, verdict = { kind: "passed" }, start, environment }) {
  const data = { runId, conditionId: "condition-1" };
  const request = { ...data, cycle, head: "a".repeat(40), executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("condition-1").conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: hash(start), resourceClaimsHash: hash(start + 1) };
  return [
    event("condition.observation_requested", request, start),
    event("condition.observation_lease_allocated", { ...data, allocationId: `lease-${runId}`, leaseReceiptHash: hash(start + 2) }, start + 1),
    event("condition.observation_process_bound", { ...data, processIdentityHash: hash(start + 3) }, start + 2),
    event("condition.observation_terminal", { ...data, terminalProofHash: hash(start + 4) }, start + 3),
    event("condition.observation_recorded", { ...data, evidenceId, verdict, evidence: evidence(p, `artifact-${runId}`, environment) }, start + 4),
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

test("mutation schema preserves runtime generation while planned and legacy matrix remains stable", () => {
  assert.equal(schemaVersionForMutation({ eventSchemaVersion: "goal-runtime.v1" }), "goal-runtime.v1");
  assert.equal(schemaVersionForMutation({ eventSchemaVersion: "planned.v1" }), "planned.v1");
  assert.equal(schemaVersionForMutation({ eventSchemaVersion: "goal-engine.event.v2" }, "goal-engine.event.v3"), "goal-engine.event.v3");
  assert.equal(schemaVersionForMutation({ eventSchemaVersion: "goal-engine.event.v3" }, "goal-engine.event.v2"), "goal-engine.event.v3");
  assert.throws(() => schemaVersionForMutation({ eventSchemaVersion: "unknown.v1" }), /unknown event generation/);
});

test("runtime checkpoint reducer rejects non-exact, non-monotonic, and dishonest progress records", () => {
  const p = active(); const fingerprint = hash(700);
  const first = applyEvent(p, event("goal.checkpoint", { canonicalFingerprint: fingerprint, advanced: true, sequence: 1 }, 15));
  assert.throws(() => applyEvent(first, event("goal.checkpoint", { canonicalFingerprint: fingerprint, advanced: true, sequence: 3 }, 16)), /checkpoint/i);
  assert.throws(() => applyEvent(first, event("goal.checkpoint", { canonicalFingerprint: fingerprint, advanced: true, sequence: 2 }, 16)), /advanced/i);
  assert.throws(() => applyEvent(first, event("goal.checkpoint", { canonicalFingerprint: fingerprint, advanced: false, sequence: 2, extra: true }, 16)), /exact|checkpoint/i);
});

test("runtime approval is canonically bound and remains separate from amendment decisions", () => {
  const p = applyEvent(draft(), event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 2)); const data = { proposalId: "proposal", executionContractHash: p.executionContractHash, baseHead: p.runtimeBaseHead, sessionId: "session", userEntryId: "entry", capabilityDigest: hash(2) };
  assert.throws(() => applyEvent(p, event("goal.runtime_approval_recorded", { ...data, proposalHash: hash(1) }, 3)), /approval|canonical/i);
  const calibrated = applyEvent(p, event("goal.runtime_approval_recorded", { ...data, proposalHash: runtimeApprovalHash(data) }, 3));
  assert.equal(calibrated.pendingHumanDecision, null); assert.equal(calibrated.runtimeApproval.proposalHash, runtimeApprovalHash(data)); assert.equal(calibrated.runtimeState, "calibrating");
});

test("runtime approval requires the event-sourced owner session", () => {
  let p = draft();
  p = applyEvent(p, event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 3));
  const data = { proposalId: "proposal", executionContractHash: p.executionContractHash, baseHead: p.runtimeBaseHead, sessionId: "other", userEntryId: "entry", capabilityDigest: hash(2) };
  assert.throws(() => applyEvent(p, event("goal.runtime_approval_recorded", { ...data, proposalHash: runtimeApprovalHash(data) }, 4)), /owner|approval/i);
});

test("runtime draft preserves contract state and observation identity", () => {
  const p = draft();
  assert.equal(p.runtimeState, "draft"); assert.equal(p.runtimeGeneration, "goal-runtime.v1"); assert.equal(p.conditions.get("condition-1").status, "inactive");
  assert.throws(() => applyEvent(p, event("condition.observation_requested", { runId: "bad", conditionId: "condition-1", cycle: 0, worldSnapshotHash: hash(2), resourceClaimsHash: hash(3) }, 2)), /observation request/);
  assert.throws(() => applyEvent(p, { ...event("goal.checkpoint", { nextAction: "a sufficiently concrete historical next action" }, 3), schemaVersion: "planned.v1" }), /mixed event generations/);
});

test("observation request identity is exact, event-sourced, and current", () => {
  const p = calibrating();
  const request = { runId: "identity-run", conditionId: "condition-1", cycle: 0, head: "a".repeat(40), executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("condition-1").conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: hash(400), resourceClaimsHash: hash(401) };
  const applied = applyEvent(p, event("condition.observation_requested", request, 4));
  assert.deepEqual(applied.observationRuns.get("identity-run").adapter, request.adapter);
  for (const malformed of [{ ...request, extra: true }, { ...request, head: "bad" }, { ...request, executionRevision: 2 }, { ...request, executionContractHash: hash(402) }, { ...request, conditionHash: hash(403) }, { ...request, adapter: { ref: "wrong", version: "1" } }, { ...request, adapter: { ref: "oracle", version: "" } }]) assert.throws(() => applyEvent(p, event("condition.observation_requested", malformed, 5)), /observation/i);
});

test("observation transitions require phase-exact hashed authority", () => {
  let p = calibrating();
  p = applyEvent(p, event("condition.observation_requested", { runId: "exact-run", conditionId: "condition-1", cycle: 0, head: "a".repeat(40), executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("condition-1").conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: hash(4), resourceClaimsHash: hash(5) }, 4));
  const lease = { runId: "exact-run", conditionId: "condition-1", allocationId: "lease", leaseReceiptHash: hash(6) };
  assert.throws(() => applyEvent(p, event("condition.observation_lease_allocated", { ...lease, extra: true }, 5)), /exact|phase|observation/i);
  assert.throws(() => applyEvent(p, event("condition.observation_lease_allocated", { ...lease, leaseReceiptHash: "bad" }, 5)), /lease|proof|phase/i);
  p = applyEvent(p, event("condition.observation_lease_allocated", lease, 5));
  assert.equal(p.observationRuns.get("exact-run").worldSnapshotHash, hash(4));
  assert.equal(p.observationRuns.get("exact-run").resourceClaimsHash, hash(5));
  assert.throws(() => applyEvent(p, event("condition.observation_process_bound", { runId: "exact-run", conditionId: "condition-1", processIdentityHash: hash(7), allocationId: "lease" }, 6)), /exact|phase|observation/i);
});

test("activation requires the latest decidable Cycle0 and never supports Conditions or Findings", () => {
  let p = calibrating();
  p = applyAll(p, observationEvents(p, { runId: "cycle0-pass", evidenceId: hash(101), cycle: 0, start: 4 }));
  assert.deepEqual(p.conditions.get("condition-1").supportingEvidenceIds, []); assert.equal(p.conditions.get("condition-1").status, "inactive");
  assert.throws(() => applyEvent(p, event("finding.recorded", { findingId: "cycle0-finding", conditionId: "condition-1", runId: "cycle0-pass", evidenceId: hash(101), fingerprint: hash(102) }, 9)), /finding requires/);
  p = applyEvent(p, event("goal.runtime_activated", {}, 9)); assert.equal(p.runtimeState, "active");
  let latestPassed = calibrating(); latestPassed = applyAll(latestPassed, observationEvents(latestPassed, { runId: "inconclusive-earlier", evidenceId: hash(105), cycle: 0, verdict: { kind: "inconclusive", reason: "unknown" }, start: 4 }));
  latestPassed = applyAll(latestPassed, observationEvents(latestPassed, { runId: "passed-latest", evidenceId: hash(106), cycle: 0, start: 9 }));
  assert.deepEqual(latestPassed.conditions.get("condition-1").supportingEvidenceIds, []); assert.equal(applyEvent(latestPassed, event("goal.runtime_activated", {}, 14)).runtimeState, "active");
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

test("runtime reducer records canonical product evidence with derived authority", () => {
  const p = active(); const row = p.evidenceHistory[1];
  assert.deepEqual(Object.keys(row).sort(), ["adapter", "artifact", "conditionHash", "conditionId", "environment", "evidenceId", "executionContractHash", "executionRevision", "fixtures", "head", "mutationSequence", "run", "sequence", "terminalProofHash", "verdict"].sort());
  assert.equal(row.sequence, 2); assert.equal(row.run.runId, "product-run"); assert.equal(row.run.state, "terminal");
  const before = structuredClone(p); const malformed = event("condition.observation_recorded", { runId: "product-run", conditionId: "condition-1", evidenceId: hash(201), verdict: { kind: "passed" }, evidence: { ...evidence(p, "bad-artifact"), command: "leak" } }, 15);
  assert.throws(() => applyEvent(p, malformed), /record|evidence|field/i); assert.deepEqual(p, before);
});

test("runtime task mutations invalidate product evidence while observation release does not", () => {
  let p = active(); const evidenceMutation = p.mutationSequence;
  assert.equal(evaluateConditionGraph({ projection: p, worldSnapshot: world() }).conditions.get("condition-1").status, "fresh");
  p = applyEvent(p, event("condition.observation_released", { runId: "product-run", conditionId: "condition-1", releaseReceiptHash: hash(400) }, 15));
  assert.equal(p.mutationSequence, evidenceMutation); assert.equal(evaluateConditionGraph({ projection: p, worldSnapshot: world() }).conditions.get("condition-1").status, "fresh");
  p = applyEvent(p, event("task.dispatched", { taskId: "task-1", contractHash: hash(401), workspace: { attempt: 1, path: "/tmp/runtime-task", branch: "runtime-task", baseCommit: "a".repeat(40) } }, 16));
  assert.equal(evaluateConditionGraph({ projection: p, worldSnapshot: world() }).conditions.get("condition-1").status, "stale");
});

test("Finding and Repair derive only from active product failed evidence", () => {
  let p = active({ productVerdict: { kind: "failed", failureCode: "assertion", findingFingerprint: hash(300) } });
  p.conditions.get("condition-1").definition.remediation.policy = "autonomous";
  p = applyEvent(p, event("finding.recorded", { findingId: "finding-1", conditionId: "condition-1", runId: "product-run", evidenceId: hash(200), fingerprint: hash(300) }, 15));
  p = applyEvent(p, event("repair.episode_opened", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"] }, 16));
  const plan = validateRemediationTask({ projection: p, episodeId: "episode-1", findingIds: ["finding-1"], taskDef: { description: "Repair condition", deps: [], writePaths: ["src/**"], acceptance: { criteria: [{ id: "repair", statement: "Condition is repaired", evidenceKinds: ["tests"] }] }, workflow: "tdd" } });
  assert.deepEqual(plan.events.map((entry) => entry.type), ["goal.amended", "repair.task_linked"]);
  p = applyAll(p, plan.events.map((entry, index) => event(entry.type, entry.data, 17 + index)));
  assert.equal(p.tasks.get(plan.taskId).metadata.kind, "remediation"); assert.equal(p.repairEpisodes.get("episode-1").status, "waiting_for_tasks");
});

test("repair resolution reducer requires canonical owned evidence identity", () => {
  const p = active(), evidenceId = hash(200), canonical = { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh passed reobservation", runId: "product-run", evidenceId, supportingEvidenceRefs: [{ runId: "product-run", evidenceId }] };
  p.repairEpisodes.set("episode-1", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], remediationTaskIds: [], ownedRunIds: ["product-run"], status: "reverifying", resolution: null }); p.findings.set("finding-1", { findingId: "finding-1", conditionId: "condition-1", status: "reverification" });
  assert.throws(() => applyEvent(p, event("repair.episode_resolved", (({ runId, evidenceId: ignored, supportingEvidenceRefs, ...legacy }) => legacy)(canonical), 15)), /resolution/);
  for (const malformed of [{ ...canonical, runId: "other" }, { ...canonical, evidenceId: hash(201) }, { ...canonical, supportingEvidenceRefs: [{ runId: "other", evidenceId }] }, { ...canonical, supportingEvidenceRefs: [] }]) assert.throws(() => applyEvent(p, event("repair.episode_resolved", malformed, 15)), /resolution/);
  const resolved = applyEvent(p, event("repair.episode_resolved", canonical, 15));
  assert.deepEqual(resolved.repairEpisodes.get("episode-1").resolution, { runId: "product-run", evidenceId, supportingEvidenceRefs: [{ runId: "product-run", evidenceId }] });
});

test("repair resolution reducer rejects an incomplete consecutive stability replay", () => {
  const p = active(), evidenceId = hash(200), canonical = { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh passed reobservation", runId: "product-run", evidenceId, supportingEvidenceRefs: [{ runId: "product-run", evidenceId }] };
  const condition = p.conditions.get("condition-1");
  condition.definition.stability = { mode: "consecutive", count: 2, require_distinct_environment: true };
  condition.status = "observing";
  p.repairEpisodes.set("episode-1", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], remediationTaskIds: [], ownedRunIds: ["product-run"], status: "reverifying", resolution: null }); p.findings.set("finding-1", { findingId: "finding-1", conditionId: "condition-1", status: "reverification" });
  assert.throws(() => applyEvent(p, event("repair.episode_resolved", canonical, 15)), /resolution/);
});

test("repair resolution reducer rejects a released current support run", () => {
  let p = active(); const evidenceId = hash(200), canonical = { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh passed reobservation", runId: "product-run", evidenceId, supportingEvidenceRefs: [{ runId: "product-run", evidenceId }] };
  p = applyEvent(p, event("condition.observation_released", { runId: "product-run", conditionId: "condition-1", releaseReceiptHash: hash(400) }, 15));
  p.repairEpisodes.set("episode-1", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], remediationTaskIds: [], ownedRunIds: ["product-run"], status: "reverifying", resolution: null }); p.findings.set("finding-1", { findingId: "finding-1", conditionId: "condition-1", status: "reverification" });
  assert.throws(() => applyEvent(p, event("repair.episode_resolved", canonical, 16)), /resolution/);
});

test("repair resolution reducer accepts complete consecutive support with only earlier release", () => {
  let p = active(); const firstEvidenceId = hash(200), currentEvidenceId = hash(201);
  const condition = p.conditions.get("condition-1");
  condition.definition.stability = { mode: "consecutive", count: 2, require_distinct_environment: true };
  condition.status = "observing";
  p = applyEvent(p, event("condition.observation_released", { runId: "product-run", conditionId: "condition-1", releaseReceiptHash: hash(400) }, 15));
  p = applyAll(p, observationEvents(p, { runId: "current-run", evidenceId: currentEvidenceId, cycle: 2, start: 16, environment: { ref: "local", fingerprint: "environment-2" } }));
  const canonical = { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], oldStatus: "reverifying", newStatus: "resolved", reason: "fresh passed reobservation", runId: "current-run", evidenceId: currentEvidenceId, supportingEvidenceRefs: [{ runId: "product-run", evidenceId: firstEvidenceId }, { runId: "current-run", evidenceId: currentEvidenceId }] };
  p.repairEpisodes.set("episode-1", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], remediationTaskIds: [], ownedRunIds: ["product-run", "current-run"], status: "reverifying", resolution: null }); p.findings.set("finding-1", { findingId: "finding-1", conditionId: "condition-1", status: "reverification" });
  assert.equal(p.conditions.get("condition-1").status, "satisfied");
  assert.equal(applyEvent(p, event("repair.episode_resolved", canonical, 21)).repairEpisodes.get("episode-1").status, "resolved");
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

test("runtime accept never completes and accepted tasks cannot regress", () => {
  let p = active(); const task = p.tasks.get("task-1"); task.status = "succeeded"; task.workspace = { attempt: 1, phase: "disposed", disposition: "integrated", released: true };
  p = applyEvent(p, event("task.accepted", { taskId: "task-1", workspaceAttempt: 1 }, 15));
  assert.equal(p.lifecycle, "active"); assert.equal(p.tasks.get("task-1").status, "accepted");
  assert.throws(() => applyEvent(p, event("task.dispatched", { taskId: "task-1", contractHash: hash(402), workspace: { attempt: 2, path: "/tmp/a", branch: "x", baseCommit: "a".repeat(40) } }, 16)), /not pending/);
});

test("runtime evidence ledger survives store replay with calibration and product histories", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-runtime-ledger-"));
  try {
    let p = createProjection(); const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
    p = appendAll(root, p, [event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: "a".repeat(40), readiness: "draft" }, 1), event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 2), event("goal.runtime_approval_recorded", { proposalId: "proposal", proposalHash: runtimeApprovalHash({ executionContractHash: hashRuntimeExecutionContract(contract) }), executionContractHash: hashRuntimeExecutionContract(contract), baseHead: "a".repeat(40), sessionId: "session", userEntryId: "entry", capabilityDigest: hash(2) }, 3)]);
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
    p = appendAll(root, p, [event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: "a".repeat(40), readiness: "draft" }, 1), event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 2), event("goal.runtime_approval_recorded", { proposalId: "proposal", proposalHash: runtimeApprovalHash({ executionContractHash: hashRuntimeExecutionContract(contract) }), executionContractHash: hashRuntimeExecutionContract(contract), baseHead: "a".repeat(40), sessionId: "session", userEntryId: "entry", capabilityDigest: hash(2) }, 3)]);
    p = appendAll(root, p, observationEvents(p, { runId: "calibration-run", evidenceId: hash(100), cycle: 0, start: 4 })); p = appendEvent(root, event("goal.runtime_activated", {}, 9), p.version);
    p = appendAll(root, p, observationEvents(p, { runId: "product-run", evidenceId: hash(200), cycle: 1, verdict: { kind: "failed", failureCode: "assertion", findingFingerprint: hash(300) }, start: 10 }));
    p = appendEvent(root, event("finding.recorded", { findingId: "finding-1", conditionId: "condition-1", runId: "product-run", evidenceId: hash(200), fingerprint: hash(300) }, 15), p.version); p = appendEvent(root, event("repair.episode_opened", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"] }, 16), p.version);
    const challenge = createRepairChallenge({ projection: p, episodeId: "episode-1", action: "reject", sessionId: "session-1", requestedAt: 20, expiresAt: 30, subjectHash: rejectSubjectHash(p, p.repairEpisodes.get("episode-1")) });
    p = appendEvent(root, event(challenge.events[0].type, challenge.events[0].data, 17), p.version); const decision = recordRepairUserDecision({ projection: p, challengeId: challenge.challengeId, sessionId: "session-1", userEntryId: "entry-1", approved: true, source: "interactive", recordedAt: 21 });
    p = appendEvent(root, event(decision.events[0].type, decision.events[0].data, 18), p.version); p = loadProjection(root, "runtime-goal"); const capability = issueRepairCapability({ projection: p, challengeId: challenge.challengeId, now: 22 }); const plan = repairEpisodeTransition({ projection: p, episodeId: "episode-1", event: { type: "repair.reject", capability, consumedAt: 23 } });
    const versionBeforeExpired = p.version, expired = { ...plan.events[0], data: { ...plan.events[0].data, consumedAt: 30 } };
    assert.throws(() => appendEvent(root, event(expired.type, expired.data, 19), p.version), /consume/); assert.equal(loadProjection(root, "runtime-goal").version, versionBeforeExpired);
    for (const [index, entry] of plan.events.entries()) p = appendEvent(root, event(entry.type, entry.data, 20 + index), p.version);
    const replayed = loadProjection(root, "runtime-goal"), persisted = readFileSync(join(root, "goals/runtime-goal/events.jsonl"), "utf8"); assert.equal(replayed.repairEpisodes.get("episode-1").status, "resolved"); assert.equal(replayed.repairChallenges.get(challenge.challengeId).phase, "applied"); assert.equal(replayed.repairChallenges.get(challenge.challengeId).recordedAt, 21); assert.equal(replayed.repairChallenges.get(challenge.challengeId).consumedAt, 23); assert.equal(persisted.includes(capability.nonce), false); assert.deepEqual(replayed.evidenceHistory.map((row) => row.evidenceId), [hash(100), hash(200)]); assert.equal(replayed.conditions.get("condition-1").supportingEvidenceIds.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
