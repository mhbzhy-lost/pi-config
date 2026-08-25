import assert from "node:assert/strict";
import test from "node:test";
import { buildSuspensionPlan, requestOwnedRunStop, inspectSuspensionCompletion, deriveOwnedExecutorStopRequest } from "../scripts/lib/goal-engine/suspension.mjs";

const leaseId = "c".repeat(64), dispatchHead = "d".repeat(40);
const projection = () => ({ goalId: "goal-1", runtimeGeneration: "goal-runtime.v1", executionContractHash: "a".repeat(64), runtimeBaseHead: "b".repeat(40), sessionBindings: [{ sessionId: "session-1", state: "watching" }], runtimeState: "active", executionRevision: 2, actionOffer: { id: "offer-1", consumed: false }, tasks: new Map([["task-1", { attempts: 3, executorBinding: { runId: "run-1", asyncDir: "/tmp/run-1", workspacePath: "/tmp/workspace-1", workspaceLeaseId: leaseId, headAtDispatch: dispatchHead }, status: "dispatched" }]]) });
test("interactive intent changes durably suspend and block stale operations", () => {
  for (const reason of ["interactive_steer", "follow_up", "abort", "execution_amendment"]) {
    const plan = buildSuspensionPlan({ projection: projection(), reason, affectedIds: { taskIds: ["task-1"], runIds: ["run-1"] }, inventories: { workspaces: [{ taskId: "task-1", runId: "run-1", affected: true }] } });
    assert.deepEqual(plan.events.map(({ type }) => type), ["goal.runtime_suspended"]);
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
test("reload derives an exact owned stop request from durable executor binding", () => {
  const reloaded = structuredClone({ goalId: "goal-1", runtimeGeneration: "goal-runtime.v1", executionRevision: 2, executionContractHash: "a".repeat(64), runtimeBaseHead: "b".repeat(40), sessionBindings: [{ sessionId: "session-1", state: "watching" }], tasks: [["task-1", { attempts: 3, status: "dispatched", executorBinding: { runId: "run-1", asyncDir: "/tmp/run-1", workspacePath: "/tmp/workspace-1", workspaceLeaseId: leaseId, headAtDispatch: dispatchHead } }]] });
  reloaded.tasks = new Map(reloaded.tasks);
  const request = deriveOwnedExecutorStopRequest({ projection: reloaded, taskId: "task-1" });
  assert.deepEqual(request, { goalId: "goal-1", taskId: "task-1", attempt: 3, runId: "run-1", asyncDir: "/tmp/run-1", workspacePath: "/tmp/workspace-1", leaseId, sessionId: "session-1", baseHead: "b".repeat(40), headAtDispatch: dispatchHead, executionRevision: 2, contractHash: "a".repeat(64), agent: "executor" });
  assert.throws(() => deriveOwnedExecutorStopRequest({ projection: { ...reloaded, executionRevision: 0 }, taskId: "task-1" }), /identity/);
});
test("owned stop requires every immutable identity and official terminal proof", async () => {
  const calls = []; const pi = { stopOwnedRun: async (request) => { calls.push(request); return { state: "observed", proof: { id: "proof-1" } }; } };
  const authority = deriveOwnedExecutorStopRequest({ projection: projection(), taskId: "task-1" });
  const result = await requestOwnedRunStop(pi, { projection: projection(), ...authority });
  assert.equal(result.attention, false); assert.equal(calls.length, 1);
  await assert.rejects(requestOwnedRunStop(pi, { projection: projection(), ...authority, attempt: 2 }), /identity/);
  const noProof = await requestOwnedRunStop({ stopOwnedRun: async () => ({ state: "pending" }) }, { projection: projection(), ...authority });
  assert.equal(noProof.attention, true); assert.equal(noProof.terminal, false);
});
test("completion retains attention for missing proof, unknown identity, or cleanup debt", () => {
  const suspended = { ...projection(), suspension: { affectedTaskIds: ["task-1"], affectedRunIds: ["run-1"] } };
  assert.equal(inspectSuspensionCompletion({ projection: suspended, stopProofs: [], workspaceInventories: [] }).complete, false);
  const complete = inspectSuspensionCompletion({ projection: suspended, stopProofs: [{ runId: "run-1", proofHash: "a".repeat(64), state: "observed" }], workspaceInventories: [{ taskId: "task-1", attempt: 3, proofHash: "b".repeat(64), state: "quarantined", disposition: "preserved" }], resourceProofs: [{ ownerId: "run-1", proofHash: "c".repeat(64), state: "quarantined", debt: true }] });
  assert.equal(complete.complete, true);
});
