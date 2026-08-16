import assert from "node:assert/strict";
import test from "node:test";
import { buildSuspensionPlan, requestOwnedRunStop, inspectSuspensionCompletion } from "../scripts/lib/goal-engine/suspension.mjs";

const projection = () => ({ goalId: "goal-1", runtimeState: "active", executionRevision: 2, actionOffer: { id: "offer-1", active: true }, tasks: new Map([["task-1", { attempts: 3, executorBinding: { runId: "run-1", workspaceLeaseId: "lease-1" }, status: "dispatched" }]]) });
test("interactive intent changes durably suspend, revoke offers, and block stale operations", () => {
  for (const reason of ["interactive_steer", "follow_up", "abort", "execution_amendment"]) {
    const plan = buildSuspensionPlan({ projection: projection(), reason, affectedIds: { taskIds: ["task-1"], runIds: ["run-1"] }, inventories: { workspaces: [{ taskId: "task-1", runId: "run-1", affected: true }] } });
    assert.equal(plan.events[0].type, "goal.runtime_suspended"); assert.equal(plan.events[1].type, "goal.action_offer_revoked");
    assert.equal(plan.suspensionId, plan.events[0].data.suspensionId);
    assert.deepEqual(plan.blocked, ["dispatch", "integrate", "finalize"]); assert.equal(plan.workspaceStrategies[0].action, "quarantine");
  }
});
test("suspension does not fabricate a revoke fact without an active offer", () => {
  const plan = buildSuspensionPlan({ projection: { ...projection(), actionOffer: null }, reason: "abort" });
  assert.equal(plan.events.length, 1);
});
test("suspended guards quarantine affected success and permit only explicit unaffected keep", () => {
  const plan = buildSuspensionPlan({ projection: projection(), reason: "abort", affectedIds: { taskIds: ["task-1"] }, inventories: { workspaces: [{ taskId: "task-1", affected: true }, { taskId: "task-2", policy: "keep" }] } });
  assert.equal(plan.workspaceStrategies[0].resultPolicy, "quarantine");
  assert.equal(plan.workspaceStrategies[1].resultPolicy, "keep");
  assert.throws(() => plan.guard("integrate"), /suspended/);
});
test("owned stop requires every immutable identity and official terminal proof", async () => {
  const calls = []; const pi = { stopOwnedRun: async (request) => { calls.push(request); return { state: "observed", proof: { id: "proof-1" } }; } };
  const result = await requestOwnedRunStop(pi, { projection: projection(), goalId: "goal-1", taskId: "task-1", attempt: 3, runId: "run-1", leaseId: "lease-1" });
  assert.equal(result.attention, false); assert.equal(calls.length, 1);
  await assert.rejects(requestOwnedRunStop(pi, { projection: projection(), goalId: "goal-1", taskId: "task-1", attempt: 2, runId: "run-1", leaseId: "lease-1" }), /identity/);
  const noProof = await requestOwnedRunStop({ stopOwnedRun: async () => ({ state: "pending" }) }, { projection: projection(), goalId: "goal-1", taskId: "task-1", attempt: 3, runId: "run-1", leaseId: "lease-1" });
  assert.equal(noProof.attention, true); assert.equal(noProof.terminal, false);
});
test("completion retains attention for missing proof, unknown identity, or cleanup debt", () => {
  assert.equal(inspectSuspensionCompletion({ projection: projection(), stopProofs: [], workspaceInventories: [] }).complete, false);
  const complete = inspectSuspensionCompletion({ projection: projection(), stopProofs: [{ runId: "run-1", state: "observed" }], workspaceInventories: [{ taskId: "task-1", action: "quarantine", proof: "workspace-proof", resourcesReleased: true }] });
  assert.equal(complete.complete, true);
});
