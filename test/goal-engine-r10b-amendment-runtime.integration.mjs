import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyEvent, createProjection, ownerSessionId } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { hashRuntimeExecutionContract, normalizeRuntimeGoalInit } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { suspensionClosureHash } from "../scripts/lib/goal-engine/suspension.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sha = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const digest = (n) => String(n).padStart(64, "0");
const baseHead = "a".repeat(40);
const event = (type, data, n) => ({ schemaVersion: "goal-runtime.v1", eventId: `r10b-amendment-${n}`, goalId: "r10b-goal", occurredAt: `2026-08-22T00:00:${String(n).padStart(2, "0")}.000Z`, type, data });

function sourceContract() {
  const fixture = runtimeInit();
  const task2 = { ...fixture.execution.tasks[0], id: "task-2", description: "Keep accepted unaffected work" };
  return normalizeRuntimeGoalInit({
    ...fixture, scope: ["runtime amendment"], non_goals: ["extension branch validation"], dod: ["replay canonical amendment ledger"],
    execution: { ...fixture.execution, tasks: [fixture.execution.tasks[0], task2] },
  }, runtimeRegistries);
}

function activeEntries() {
  const runtime = sourceContract();
  const approval = { proposalId: "runtime-proposal", executionContractHash: hashRuntimeExecutionContract(runtime), baseHead, sessionId: "owner-session" };
  const proposalHash = sha({ ...approval, goalId: "r10b-goal" });
  const common = { runId: "calibration-run", conditionId: "condition-1" };
  const observation = { ...common, cycle: 0, head: baseHead, executionRevision: 1, executionContractHash: approval.executionContractHash, conditionHash: sha(runtime.execution.conditions[0]), adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: digest(1), resourceClaimsHash: digest(2) };
  return [
    event("goal.runtime_drafted", { runtimeInit: runtime, executionContractHash: approval.executionContractHash, baseHead, readiness: "draft" }, 1),
    event("goal.session_bound", { sessionId: "owner-session", leafId: "owner-leaf" }, 2),
    event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 3),
    event("goal.runtime_approval_recorded", { ...approval, proposalHash, userEntryId: "runtime-entry", capabilityDigest: digest(3) }, 4),
    event("condition.observation_requested", observation, 5),
    event("condition.observation_lease_allocated", { ...common, allocationId: "calibration-lease", leaseReceiptHash: digest(4) }, 6),
    event("condition.observation_process_bound", { ...common, processIdentityHash: digest(5) }, 7),
    event("condition.observation_terminal", { ...common, terminalProofHash: digest(6) }, 8),
    event("condition.observation_recorded", { ...common, evidenceId: digest(7), verdict: { kind: "passed" }, evidence: { executionRevision: 1, executionContractHash: approval.executionContractHash, conditionHash: observation.conditionHash, head: baseHead, adapter: observation.adapter, environment: { ref: "local", fingerprint: "r10b-environment" }, fixtures: [{ ref: "sample", fingerprint: "r10b-fixture" }], artifact: { id: "calibration-artifact", hash: digest(8) } } }, 9),
    event("goal.runtime_activated", {}, 10),
    event("condition.observation_requested", { ...observation, runId: "product-run", cycle: 1, worldSnapshotHash: digest(9), resourceClaimsHash: digest(10) }, 11),
    event("condition.observation_lease_allocated", { runId: "product-run", conditionId: "condition-1", allocationId: "product-lease", leaseReceiptHash: digest(11) }, 12),
    event("condition.observation_process_bound", { runId: "product-run", conditionId: "condition-1", processIdentityHash: digest(12) }, 13),
    event("condition.observation_terminal", { runId: "product-run", conditionId: "condition-1", terminalProofHash: digest(13) }, 14),
    event("condition.observation_recorded", { runId: "product-run", conditionId: "condition-1", evidenceId: digest(14), verdict: { kind: "passed" }, evidence: { executionRevision: 1, executionContractHash: approval.executionContractHash, conditionHash: observation.conditionHash, head: baseHead, adapter: observation.adapter, environment: { ref: "local", fingerprint: "r10b-product-environment" }, fixtures: [{ ref: "sample", fingerprint: "r10b-product-fixture" }], artifact: { id: "product-artifact", hash: digest(15) } } }, 15),
  ];
}

function applyAll(entries) { return entries.reduce((projection, entry) => applyEvent(projection, entry), createProjection()); }
function initialSuspension() { return { suspensionId: "amendment-suspension", reason: "execution_amendment", affectedTaskIds: ["task-1"], affectedRunIds: ["amendment-run"], requestedAt: "2026-08-22T00:00:11.000Z", resourcesQuarantined: false }; }
function fullClosure() {
  const initial = initialSuspension();
  return { ...initial, resourcesQuarantined: true, terminalProofRefs: [{ runId: "amendment-run", proofHash: digest(9), state: "observed" }], workspaceClosureProofRefs: [{ taskId: "task-1", attempt: 0, proofHash: digest(10), state: "quarantined", disposition: "preserved" }], resourceClosureProofRefs: [{ ownerId: "amendment-run", proofHash: digest(11), state: "quarantined", debt: true }] };
}
function suspendedRuntime() { return applyAll([...activeEntries(), event("goal.runtime_suspended", initialSuspension(), 16), event("goal.runtime_suspended", fullClosure(), 17)]); }

function proposalData(projection) {
  const source = sourceContract();
  // The literal task change is normalized into the complete durable runtime contract.
  const targetExecutionContract = normalizeRuntimeGoalInit({
    ...source,
    execution: { ...source.execution, tasks: [{ ...source.execution.tasks[0], description: "Harden amended runtime task contract" }, source.execution.tasks[1]] },
  }, runtimeRegistries);
  const changes = { update_tasks: [{ id: "task-1", description: "Harden amended runtime task contract" }] };
  const material = {
    goalId: projection.goalId, proposalId: "proposal-r10b", changes: canonical(changes), changesHash: sha(changes),
    targetExecutionContract, targetContractHash: hashRuntimeExecutionContract(targetExecutionContract),
    baseHead: projection.runtimeBaseHead, ownerSessionId: ownerSessionId(projection), oldRevision: projection.executionRevision, newRevision: projection.executionRevision + 1,
  };
  return { ...material, proposalHash: sha(material) };
}

function approvalData(proposal, projection) {
  const approval = { proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, ownerSessionId: ownerSessionId(projection), userEntryId: "user-entry-r10b", userEntryHash: sha({ id: "user-entry-r10b", text: "approve amendment" }), branchBindingHash: sha({ ownerSessionId: ownerSessionId(projection), branch: "extension-lane" }), source: "interactive", recordedAt: "2026-08-22T00:01:00.000Z" };
  return { ...approval, decisionId: sha(approval) };
}

// RED: the reducer must persist the normalized target contract rather than a projection-shaped surrogate.
test("R10B durable amendment proposal reloads the normalized target runtime contract", () => {
  const projection = suspendedRuntime();
  const proposal = proposalData(projection);
  assert.deepEqual(Object.keys(proposal.targetExecutionContract).sort(), ["dod", "execution", "non_goals", "objective", "scope"]);
  assert.deepEqual(Object.keys(proposal.targetExecutionContract.execution).sort(), ["budgets", "conditions", "schema", "tasks", "write_policy"]);
  assert.equal(proposal.targetContractHash, hashRuntimeExecutionContract(proposal.targetExecutionContract));
  const root = mkdtempSync(join(tmpdir(), "goal-r10b-proposal-"));
  try {
    const persisted = appendEventBatch(root, [...activeEntries(), event("goal.runtime_suspended", initialSuspension(), 16), event("goal.runtime_suspended", fullClosure(), 17), event("execution.amendment_proposed", proposal, 18)], 0);
    const replayed = loadProjection(root, "r10b-goal");
    assert.deepEqual(persisted.pendingHumanDecision, { ...proposal, phase: "proposed" });
    assert.deepEqual(replayed.pendingHumanDecision.targetExecutionContract, proposal.targetExecutionContract);
    assert.equal(replayed.pendingHumanDecision.targetContractHash, hashRuntimeExecutionContract(replayed.pendingHumanDecision.targetExecutionContract));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// RED: this ledger identity deliberately does not claim to validate the live Pi branch; that belongs to Extension tests.
test("R10B durable amendment approval reducer records the complete decision identity", () => {
  const projection = suspendedRuntime(), proposal = proposalData(projection);
  const approval = approvalData(proposal, projection);
  assert.deepEqual(Object.keys(approval).sort(), ["branchBindingHash", "decisionId", "ownerSessionId", "proposalHash", "proposalId", "recordedAt", "source", "userEntryHash", "userEntryId"]);
  const { decisionId, ...approvalMaterial } = approval;
  assert.equal(decisionId, sha(approvalMaterial));
  const pending = applyEvent(projection, event("execution.amendment_proposed", proposal, 18));
  const approved = applyEvent(pending, event("execution.amendment_approved", approval, 19));
  assert.deepEqual(approved.pendingHumanDecision, { ...proposal, ...approval, phase: "approved" });
  assert.throws(() => applyEvent(pending, event("execution.amendment_approved", { ...approval, userEntryHash: digest(12) }, 26)), /approval|decision|user/i);
});

function preparedStore(root) {
  const projection = appendEventBatch(root, [...activeEntries(), event("goal.runtime_suspended", initialSuspension(), 16), event("goal.runtime_suspended", fullClosure(), 17)], 0);
  const proposal = proposalData(projection), approval = approvalData(proposal, projection);
  return { proposal, prepared: appendEventBatch(root, [event("execution.amendment_proposed", proposal, 18), event("execution.amendment_approved", approval, 19)], projection.version) };
}
function canonicalBatch(proposal) {
  return [
    event("execution.amendment_capability_consumed", { proposalId: proposal.proposalId, nonceDigest: digest(16) }, 20),
    event("task.applicability_changed", { taskId: "task-1", revision: proposal.newRevision, state: "reverify_required", reason: "task_change" }, 21),
    event("task.applicability_changed", { taskId: "task-2", revision: proposal.newRevision, state: "applicable", reason: "unaffected" }, 22),
    event("condition.evidence_invalidated", { conditionId: "condition-1", revision: proposal.newRevision, priorEvidenceIds: [digest(14)], reason: "task_change" }, 23),
    event("execution.amendment_applied", { proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, oldRevision: proposal.oldRevision, newRevision: proposal.newRevision, targetContractHash: proposal.targetContractHash, reconciliation: [{ taskId: "task-1", action: "reverify" }, { taskId: "task-2", action: "keep" }] }, 24),
    event("goal.runtime_resumed", { suspensionId: initialSuspension().suspensionId, closureHash: suspensionClosureHash(fullClosure()) }, 25),
  ];
}
function assertRejectedBeforeWrite(root, expectedVersion, events) {
  assert.throws(() => events.length === 1 ? appendEvent(root, events[0], expectedVersion) : appendEventBatch(root, events, expectedVersion), /canonical amendment batch|atomic|applicability|amendment|target|closure|resume/i);
  assert.equal(loadProjection(root, "r10b-goal").version, expectedVersion);
}

test("R10B Store applies the canonical amendment batch with product support and target contract", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-r10b-batch-"));
  try {
    const { proposal, prepared } = preparedStore(root), batch = canonicalBatch(proposal);
    const applied = appendEventBatch(root, batch, prepared.version);
    assert.equal(applied.executionRevision, proposal.newRevision);
    assert.equal(applied.executionContractHash, proposal.targetContractHash);
    assert.deepEqual(applied.taskApplicability.get("task-1"), { revision: proposal.newRevision, state: "reverify_required", reason: "task_change" });
    assert.deepEqual(applied.taskApplicability.get("task-2"), { revision: proposal.newRevision, state: "applicable", reason: "unaffected" });
    assert.deepEqual(applied.conditions.get("condition-1").supportingEvidenceIds, []);
    assert.equal(applied.evidenceHistory.length, 2);
    assert.deepEqual(applied.tasks.get("task-1").definition, proposal.targetExecutionContract.execution.tasks[0]);
    assert.equal(applied.tasks.get("task-1").description, proposal.targetExecutionContract.execution.tasks[0].description);
    assert.equal(applied.tasks.get("task-2").description, sourceContract().execution.tasks[1].description);
    assert.deepEqual(batch[4].data.reconciliation, [{ taskId: "task-1", action: "reverify" }, { taskId: "task-2", action: "keep" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R10B Store rejects every split, unordered, incomplete, or mismatched canonical amendment before writing", () => {
  const cases = [
    ["standalone consume", ({ proposal, prepared }) => [prepared.version, [canonicalBatch(proposal)[0]]]],
    ["out of order", ({ proposal, prepared }) => [prepared.version, [canonicalBatch(proposal)[1], canonicalBatch(proposal)[0], ...canonicalBatch(proposal).slice(2)]]],
    ["missing task applicability", ({ proposal, prepared }) => [prepared.version, canonicalBatch(proposal).filter((entry) => entry.data.taskId !== "task-2")]],
    ["wrong prior evidence", ({ proposal, prepared }) => [prepared.version, canonicalBatch(proposal).map((entry) => entry.type === "condition.evidence_invalidated" ? { ...entry, data: { ...entry.data, priorEvidenceIds: [digest(7)] } } : entry)]],
    ["wrong target hash", ({ proposal, prepared }) => [prepared.version, canonicalBatch(proposal).map((entry) => entry.type === "execution.amendment_applied" ? { ...entry, data: { ...entry.data, targetContractHash: digest(17) } } : entry)]],
    ["duplicate replay apply", ({ proposal, prepared }) => [prepared.version, [...canonicalBatch(proposal), { ...canonicalBatch(proposal)[4], eventId: "r10b-amendment-26", occurredAt: "2026-08-22T00:00:26.000Z" }]]],
    ["wrong resume closure", ({ proposal, prepared }) => [prepared.version, canonicalBatch(proposal).map((entry) => entry.type === "goal.runtime_resumed" ? { ...entry, data: { ...entry.data, closureHash: digest(18) } } : entry)]],
  ];
  for (const [name, arrange] of cases) {
    const root = mkdtempSync(join(tmpdir(), "goal-r10b-reject-"));
    try { const state = preparedStore(root); const [version, entries] = arrange(state); assertRejectedBeforeWrite(root, version, entries); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("R10B amendment reducer replays capability consumption without changing other state", () => {
  const projection = suspendedRuntime(), proposal = proposalData(projection);
  let pending = applyEvent(projection, event("execution.amendment_proposed", proposal, 18));
  pending = applyEvent(pending, event("execution.amendment_approved", approvalData(proposal, pending), 19));
  const before = { revision: pending.executionRevision, contract: pending.executionContractHash, applicability: structuredClone([...pending.taskApplicability]), evidence: structuredClone(pending.evidenceHistory), suspension: structuredClone(pending.suspension) };
  const consumed = applyEvent(pending, event("execution.amendment_capability_consumed", { proposalId: proposal.proposalId, nonceDigest: digest(19) }, 20));
  assert.equal(consumed.pendingHumanDecision.phase, "consumed");
  assert.deepEqual({ revision: consumed.executionRevision, contract: consumed.executionContractHash, applicability: [...consumed.taskApplicability], evidence: consumed.evidenceHistory, suspension: consumed.suspension }, before);
});
