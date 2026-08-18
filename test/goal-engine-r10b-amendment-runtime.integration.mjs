import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyEvent, createProjection, ownerSessionId } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { hashRuntimeExecutionContract, normalizeRuntimeGoalInit } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const sha = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (n) => String(n).padStart(64, "0");
const baseHead = "a".repeat(40);
function event(type, data, n) { return { schemaVersion: "goal-runtime.v1", eventId: `r10b-${n}`, goalId: "r10b-goal", occurredAt: `2026-08-14T00:00:${String(n).padStart(2, "0")}.000Z`, type, data }; }

function suspendedRuntime() {
  const runtime = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  let projection = applyEvent(createProjection(), event("goal.runtime_drafted", { runtimeInit: runtime, executionContractHash: hashRuntimeExecutionContract(runtime), baseHead, readiness: "draft" }, 1));
  projection = applyEvent(projection, event("goal.session_bound", { sessionId: "owner-session", leafId: "owner-leaf" }, 2));
  return applyEvent(projection, event("goal.runtime_suspended", { suspensionId: "amendment-suspension", reason: "execution_amendment" }, 3));
}

function proposalData(projection) {
  const changes = { tasks: [{ id: "task-1", intent: "change", expected: { condition: "amended contract" } }] };
  const targetExecutionContract = {
    tasks: [...projection.tasks].map(([id, task]) => ({ id, description: task.description, deps: task.deps, writePaths: task.writePaths, acceptance: task.acceptance, workflow: task.workflow })),
    conditions: [...projection.conditions].map(([id, condition]) => ({ id, ...condition.definition })),
    writePolicy: projection.writePolicy,
    budget: projection.convergenceBudget,
    changes,
  };
  const material = {
    goalId: projection.goalId, proposalId: "proposal-r10b", changes, changesHash: sha(changes), targetExecutionContract,
    targetContractHash: sha(targetExecutionContract), baseHead: projection.runtimeBaseHead, ownerSessionId: ownerSessionId(projection),
    oldRevision: projection.executionRevision, newRevision: projection.executionRevision + 1,
  };
  return { ...material, proposalHash: sha(material) };
}

// This is intentionally RED until amendment_proposed becomes the durable authority.
test("R10B durable proposal replays its complete target contract from real runtime bindings", () => {
  const projection = suspendedRuntime();
  const proposal = proposalData(projection);
  const root = mkdtempSync(join(tmpdir(), "goal-r10b-proposal-"));
  try {
    const entries = [
      event("goal.runtime_drafted", { runtimeInit: normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries), executionContractHash: projection.executionContractHash, baseHead, readiness: "draft" }, 1),
      event("goal.session_bound", { sessionId: "owner-session", leafId: "owner-leaf" }, 2),
      event("goal.runtime_suspended", { suspensionId: "amendment-suspension", reason: "execution_amendment" }, 3),
      event("execution.amendment_proposed", proposal, 4),
    ];
    const persisted = appendEventBatch(root, entries, 0);
    const replayed = loadProjection(root, "r10b-goal");
    assert.deepEqual(replayed.pendingHumanDecision, { ...proposal, phase: "proposed" });
    assert.equal(replayed.pendingHumanDecision.targetContractHash, sha(replayed.pendingHumanDecision.targetExecutionContract));
    assert.equal(persisted.pendingHumanDecision.ownerSessionId, ownerSessionId(replayed));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R10B approval accepts only the event-sourced active-branch real-user intent", () => {
  const projection = suspendedRuntime();
  const proposal = proposalData(projection);
  let pending = applyEvent(projection, event("execution.amendment_proposed", proposal, 4));
  const approval = {
    proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, ownerSessionId: ownerSessionId(pending),
    userEntryId: "real-user-entry", source: "interactive", intentId: "pi-intent-r10b", branchBindingHash: digest(5),
  };
  pending = applyEvent(pending, event("execution.amendment_approved", approval, 5));
  assert.equal(pending.pendingHumanDecision.phase, "approved");
  for (const invalid of [
    { ...approval, source: "extension" },
    { ...approval, ownerSessionId: "off-branch-session" },
    { ...approval, branchBindingHash: digest(6) },
    { ...approval, userEntryId: "streamed-or-duplicate" },
  ]) assert.throws(() => applyEvent(applyEvent(projection, event("execution.amendment_proposed", proposal, 40 + invalid.branchBindingHash.charCodeAt(0) % 10)), event("execution.amendment_approved", invalid, 50 + invalid.branchBindingHash.charCodeAt(0) % 10)), /approval|branch|user|intent/i);
});

test("R10B Store rejects a split consume before applicability, evidence invalidation, apply, and bound resume", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-r10b-batch-"));
  try {
    const runtime = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
    const proposed = { proposalId: "legacy-r10b", proposalHash: digest(1), changesHash: digest(2), oldRevision: 1, newRevision: 2 };
    let projection = appendEventBatch(root, [
      event("goal.runtime_drafted", { runtimeInit: runtime, executionContractHash: hashRuntimeExecutionContract(runtime), baseHead, readiness: "draft" }, 1),
      event("goal.session_bound", { sessionId: "owner-session", leafId: "owner-leaf" }, 2),
      event("goal.runtime_suspended", { suspensionId: "amendment-suspension", reason: "execution_amendment" }, 3),
      event("execution.amendment_proposed", proposed, 4),
      event("execution.amendment_approved", { proposalId: proposed.proposalId, proposalHash: proposed.proposalHash, sessionId: "owner-session", userEntryId: "real-user-entry" }, 5),
    ], 0);
    assert.throws(() => appendEvent(root, event("execution.amendment_capability_consumed", { proposalId: proposed.proposalId, nonceDigest: digest(3) }, 6), projection.version), /canonical amendment batch|atomic|consume/i);

    const canonicalTypes = ["execution.amendment_capability_consumed", "task.applicability_changed", "condition.evidence_invalidated", "execution.amendment_applied", "goal.runtime_resumed"];
    const resume = { suspensionId: "amendment-suspension", closureHash: digest(9) };
    assert.throws(() => appendEventBatch(root, canonicalTypes.map((type, index) => event(type, index === 0 ? { proposalId: proposed.proposalId, nonceDigest: digest(4) } : type === "task.applicability_changed" ? { taskId: "task-1", state: "reverify_required", reason: "task_change" } : type === "condition.evidence_invalidated" ? { conditionId: "condition-1", reason: "task_change" } : type === "execution.amendment_applied" ? { proposalId: proposed.proposalId, oldRevision: 1, newRevision: 2, contractHash: digest(8), reconciliation: [] } : resume, 10 + index)), projection.version), /proposal|batch|applicability|resume/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R10B canonical batch advances every applicability revision and invalidates prior support exactly once", () => {
  const proposed = { proposalId: "revision-r10b", proposalHash: digest(11), changesHash: digest(12), oldRevision: 1, newRevision: 2 };
  let projection = applyEvent(suspendedRuntime(), event("execution.amendment_proposed", proposed, 64));
  projection = applyEvent(projection, event("execution.amendment_approved", { proposalId: proposed.proposalId, proposalHash: proposed.proposalHash, sessionId: "owner-session", userEntryId: "real-user-entry" }, 65));
  for (const [type, data, n] of [
    ["execution.amendment_capability_consumed", { proposalId: proposed.proposalId, nonceDigest: digest(13) }, 66],
    ["task.applicability_changed", { taskId: "task-1", state: "reverify_required", reason: "task_change" }, 67],
    ["condition.evidence_invalidated", { conditionId: "condition-1", reason: "task_change" }, 68],
    ["execution.amendment_applied", { proposalId: proposed.proposalId, oldRevision: 1, newRevision: 2, contractHash: digest(14), reconciliation: [] }, 69],
    ["goal.runtime_resumed", { suspensionId: "amendment-suspension", closureHash: digest(15) }, 70],
  ]) projection = applyEvent(projection, event(type, data, n));
  assert.equal(projection.executionRevision, 2);
  assert.deepEqual(projection.taskApplicability.get("task-1"), { revision: 2, state: "reverify_required", reason: "task_change" });
  assert.equal(projection.conditions.get("condition-1").status, "stale");
  assert.deepEqual(projection.conditions.get("condition-1").supportingEvidenceIds, []);
});

test("R10B runtime resume cannot clear a suspension without its matching closure proof", () => {
  const projection = suspendedRuntime();
  assert.throws(() => applyEvent(projection, event("goal.runtime_resumed", {}, 4)), /suspension|closure|resume/i);
  assert.throws(() => applyEvent(projection, event("goal.runtime_resumed", { suspensionId: "other", closureHash: digest(7) }, 5)), /suspension|closure|resume/i);
});
