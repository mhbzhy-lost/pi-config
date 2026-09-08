import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { applyEvent, createProjection } from "../src/goal-engine/events.ts";
import { taskActionState } from "../src/goal-engine/graph.ts";
import { fingerprintSettlementEvidence } from "../src/goal-engine/settlement-evidence.ts";
import { deterministicGoalWorkspaceId } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";

const goalId = "managed-disposition";
const contractHash = "a".repeat(64);
const baseCommit = "b".repeat(40);
const workspaceId = deterministicGoalWorkspaceId({ goalId, taskId: "t1", attempt: 1, executionRevision: 1, contractHash, baseCommit });
const owner = { kind: "goal-task", rootSessionId: "root-1", goalId, taskId: "t1", attempt: 1, executionRevision: 1 };
const event = (type, data) => ({ schemaVersion: "planned.v1", eventId: crypto.randomUUID(), goalId, occurredAt: "2026-09-05T00:00:00.000Z", type, data });
const receipt = (state, disposition) => ({
  schemaVersion: "managed-workspace.v1", workspaceId, leaseId: "d".repeat(64), owner,
  originRoot: "/tmp/origin", requestedCwd: "/tmp/origin", originRef: "refs/heads/main", baseCommit,
  path: "/tmp/workspaces/goal", dispatchCwd: "/tmp/workspaces/goal", branchRef: "refs/heads/pi-managed/goal",
  state, run: null, disposition, cleanupDebt: null,
});
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

function succeededProjection() {
  let projection = applyEvent(createProjection(), event("goal.created", {
    objective: "Bridge managed disposition", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "work", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: [{ id: "proof", statement: "proof", evidenceKinds: ["tests"] }] }, workflow: "tdd" } },
  }));
  projection = applyEvent(projection, event("task.dispatch_requested", { taskId: "t1", attempt: 1, contractHash, workspaceId, originRoot: "/tmp/origin", requestedCwd: "/tmp/origin", originRef: "refs/heads/main", baseCommit }));
  projection = applyEvent(projection, event("task.workspace_allocated", { taskId: "t1", attempt: 1, contractHash, workspace: receipt("active", null) }));
  const executorHead = "c".repeat(40);
  projection = applyEvent(projection, event("task.executor_bound", { taskId: "t1", attempt: 1, runId: "run-1", contractHash, asyncDir: "/tmp/run-1", workspacePath: "/tmp/workspaces/goal", workspaceLeaseId: "d".repeat(64), headAtDispatch: baseCommit }));
  const identity = { goalId, taskId: "t1", runId: "run-1", attempt: 1, contractHash, head: executorHead };
  const report = (ref) => ({ identity, criteria: [{ id: "proof", status: "satisfied", evidence: [ref] }], commandsRun: [], changedFiles: ["src/x.ts"] });
  const subagent = report(`sha256:${"2".repeat(64)}`), main = report(`sha256:${"3".repeat(64)}`);
  const options = { expectedIdentity: identity, expectedCriteria: ["proof"], outcome: "succeeded" };
  const sha256 = "e".repeat(64);
  const settlementEvidence = { schemaVersion: "goal-engine.settlement-evidence.v1", path: `acceptance-evidence/sha256/${sha256}.yaml`, sha256, subagentFingerprint: fingerprintSettlementEvidence(subagent, options), mainFingerprint: fingerprintSettlementEvidence(main, options), subagent, main, mainSessionId: "root-1" };
  return applyEvent(projection, event("task.settled", { taskId: "t1", outcome: "succeeded", attempt: 1, executorHead, executorProof: { runId: "run-1", proofId: "4".repeat(64), rootSessionId: "root-1", observedAt: 1_700_000_000_000, outcome: "succeeded" }, settlementEvidence }));
}

test("RED provenance: without a managed receipt fact, an active unified receipt rejects acceptance", () => {
  const projection = succeededProjection();
  assert.throws(() => applyEvent(projection, event("task.accepted", { taskId: "t1", workspaceAttempt: 1 })), /managed workspace receipt/);
});

test("managed disposition is exact intent then durable receipt and accepts only released integration", () => {
  let projection = succeededProjection();
  const intent = { taskId: "t1", attempt: 1, executionRevision: 1, workspaceId, leaseId: "d".repeat(64), action: "integrate", strategy: "cherry-pick" };
  projection = applyEvent(projection, event("task.managed_workspace_disposition_intent", intent));
  assert.equal(projection.tasks.get("t1").managedDisposition.phase, "intent");
  assert.throws(() => applyEvent(projection, event("task.managed_workspace_disposition_intent", { ...intent, phase: "disposing" })), /exact|identity/);
  assert.throws(() => applyEvent(projection, event("task.managed_workspace_disposition_intent", { ...intent, executionRevision: 2 })), /exact|identity/);
  const released = receipt("released", { action: "integrate", strategy: "cherry-pick" });
  assert.throws(() => applyEvent(projection, event("task.managed_workspace_disposition_receipt", { taskId: "t1", attempt: 1, workspaceId, leaseId: "d".repeat(64), serviceReceiptHash: digest({ ...released, owner: { ...owner, attempt: 2 } }), receipt: { ...released, owner: { ...owner, attempt: 2 } } })), /identity mismatch/);
  projection = applyEvent(projection, event("task.managed_workspace_disposition_receipt", { taskId: "t1", attempt: 1, workspaceId, leaseId: "d".repeat(64), serviceReceiptHash: digest(released), receipt: released }));
  assert.equal(projection.tasks.get("t1").workspace.state, "released");
  assert.deepEqual(projection.tasks.get("t1").managedDisposition.receipt, { disposition: { action: "integrate", strategy: "cherry-pick" }, released: true });
  projection = applyEvent(projection, event("task.accepted", { taskId: "t1", workspaceAttempt: 1 }));
  assert.equal(projection.tasks.get("t1").status, "accepted");
});

test("terminal managed receipts fail closed for every disposition identity or hash drift", () => {
  const intent = { taskId: "t1", attempt: 1, executionRevision: 1, workspaceId, leaseId: "d".repeat(64), action: "integrate", strategy: "cherry-pick" };
  const released = receipt("released", { action: "integrate", strategy: "cherry-pick" });
  const cases = [
    ["action", { ...released, disposition: { action: "discard" } }],
    ["strategy", { ...released, disposition: { action: "integrate", strategy: "merge" } }],
    ["owner", { ...released, owner: { ...owner, rootSessionId: "other-root" } }],
    ["attempt", { ...released, owner: { ...owner, attempt: 2 } }],
    ["executionRevision", { ...released, owner: { ...owner, executionRevision: 2 } }],
    ["workspaceId", { ...released, workspaceId: "other-workspace" }],
    ["leaseId", { ...released, leaseId: "e".repeat(64) }],
  ];
  for (const [name, drifted] of cases) {
    let projection = succeededProjection();
    projection = applyEvent(projection, event("task.managed_workspace_disposition_intent", intent));
    assert.throws(() => applyEvent(projection, event("task.managed_workspace_disposition_receipt", {
      taskId: "t1", attempt: 1, workspaceId, leaseId: "d".repeat(64), serviceReceiptHash: digest(drifted), receipt: drifted,
    })), /identity mismatch/, name);
    assert.equal(projection.tasks.get("t1").workspace.state, "active", `${name} must not mutate the Goal workspace fact`);
  }
  let projection = succeededProjection();
  projection = applyEvent(projection, event("task.managed_workspace_disposition_intent", intent));
  assert.throws(() => applyEvent(projection, event("task.managed_workspace_disposition_receipt", {
    taskId: "t1", attempt: 1, workspaceId, leaseId: "d".repeat(64), serviceReceiptHash: "f".repeat(64), receipt: released,
  })), /identity mismatch/, "serviceReceiptHash");
  assert.equal(projection.tasks.get("t1").workspace.state, "active");
});

test("managed preserve remains preserve through explicit release and becomes redispatchable", () => {
  let projection = succeededProjection();
  const intent = { taskId: "t1", attempt: 1, executionRevision: 1, workspaceId, leaseId: "d".repeat(64), action: "preserve", strategy: null };
  projection = applyEvent(projection, event("task.managed_workspace_disposition_intent", intent));
  const preserved = receipt("preserved", { action: "preserve", reason: "Goal requested workspace preservation" });
  projection = applyEvent(projection, event("task.managed_workspace_disposition_receipt", { taskId: "t1", attempt: 1, workspaceId, leaseId: "d".repeat(64), serviceReceiptHash: digest(preserved), receipt: preserved }));
  assert.deepEqual(taskActionState(projection, "t1").requiredNextAction, { tool: "goal_integrate", params: { task_id: "t1", action: "discard" }, reason: "Preserved managed workspace must be explicitly released before retrying" });
  const released = receipt("released", { action: "preserve", reason: "Goal requested workspace preservation" });
  projection = applyEvent(projection, event("task.managed_workspace_disposition_receipt", { taskId: "t1", attempt: 1, workspaceId, leaseId: "d".repeat(64), serviceReceiptHash: digest(released), receipt: released }));
  assert.equal(projection.tasks.get("t1").managedDisposition.action, "preserve");
  assert.equal(projection.tasks.get("t1").status, "pending");
  assert.equal(taskActionState(projection, "t1").requiredNextAction.tool, "goal_dispatch");
});

test("canonical released discard receipt permits attempt two dispatch without legacy workspace fields", () => {
  let projection = succeededProjection();
  const intent = { taskId: "t1", attempt: 1, executionRevision: 1, workspaceId, leaseId: "d".repeat(64), action: "discard", strategy: null };
  projection = applyEvent(projection, event("task.managed_workspace_disposition_intent", intent));
  const released = receipt("released", { action: "discard" });
  projection = applyEvent(projection, event("task.managed_workspace_disposition_receipt", {
    taskId: "t1", attempt: 1, workspaceId, leaseId: "d".repeat(64), serviceReceiptHash: digest(released), receipt: released,
  }));
  assert.equal(projection.tasks.get("t1").status, "pending");
  assert.equal(Object.hasOwn(projection.tasks.get("t1").workspace, "phase"), false);
  assert.equal(Object.hasOwn(projection.tasks.get("t1").workspace, "released"), false);
  const workspaceId2 = deterministicGoalWorkspaceId({ goalId, taskId: "t1", attempt: 2, executionRevision: 1, contractHash, baseCommit });
  projection = applyEvent(projection, event("task.dispatch_requested", {
    taskId: "t1", attempt: 2, contractHash, workspaceId: workspaceId2, originRoot: "/tmp/origin",
    requestedCwd: "/tmp/origin", originRef: "refs/heads/main", baseCommit,
  }));
  assert.equal(projection.tasks.get("t1").attempts, 2);
});
