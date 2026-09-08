import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection } from "../src/goal-engine/events.ts";
import { prepareRunBindingTicket } from "../src/goal-engine/run-binding.ts";

const hash = (value) => value.repeat(64).slice(0, 64);
const event = (type, data, n) => ({ schemaVersion: "planned.v2", eventId: `v2-${n}`, goalId: "v2-goal", occurredAt: "2026-09-07T00:00:00.000Z", type, data });
const workspaceReceipt = () => ({ schemaVersion: "managed-workspace.v1", workspaceId: "goal-v2-workspace", leaseId: hash("c"), owner: { kind: "goal-task", rootSessionId: "root", goalId: "v2-goal", taskId: "t1", attempt: 1, executionRevision: 1 }, originRoot: "/repo", requestedCwd: "/repo", originRef: "refs/heads/main", baseCommit: "b".repeat(40), path: "/tmp/v2-workspace", dispatchCwd: "/tmp/v2-workspace", branchRef: "refs/heads/goal-v2", state: "active", run: null, disposition: null, cleanupDebt: null });

function dispatched() {
  let projection = applyEvent(createProjection(), event("goal.created", { objective: "v2", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { agentProfile: " coder-alpha ", description: "work", deps: [], writePaths: ["src/a.ts"], acceptance: { criteria: [{ id: "proof", statement: "proof", evidenceKinds: ["tests"], evaluator: "run" }] }, workflow: "tdd" } } }, 1));
  projection = applyEvent(projection, event("task.dispatched", { taskId: "t1", contractHash: hash("a"), workspace: workspaceReceipt() }, 2));
  return projection;
}

test("historical v2 run-binding replay remains profile-bound, unique, and immutable", () => {
  const projection = dispatched();
  const data = { taskId: "t1", attempt: 1, runId: "run-v2", agentProfile: "coder-alpha", contractHash: hash("a"), workspaceId: "goal-v2-workspace", asyncDir: "/tmp/v2-async", workspacePath: "/tmp/v2-workspace", workspaceLeaseId: hash("c"), headAtDispatch: "b".repeat(40) };
  const bound = applyEvent(projection, event("task.run_bound", data, 3));
  assert.deepEqual(Object.keys(bound.tasks.get("t1")).filter((key) => /executor/i.test(key)), []);
  assert.equal(bound.tasks.get("t1").runBinding.agentProfile, "coder-alpha");
  assert.equal(bound.tasks.get("t1").agentProfile, "coder-alpha");
  assert.deepEqual([...bound.runIds], ["run-v2"]);
  assert.throws(() => applyEvent(bound, event("task.run_bound", data, 4)), /immutable|bound/i);
  assert.throws(() => applyEvent(projection, event("task.run_bound", { ...data, agentProfile: "coder-beta" }, 4)), /profile/i);
  assert.throws(() => applyEvent(projection, event("task.run_bound", { ...data, agentProfile: "x".repeat(257) }, 4)), /profile/i);
  assert.throws(() => applyEvent(projection, event("task.run_bound", { ...data, workspaceId: "goal-other" }, 4)), /workspace/i);
  assert.throws(() => applyEvent(projection, event("task.run_bound", { ...data, runId: "run-v2", taskId: "missing" }, 4)), /task/i);
  // Historical v2 payloads remain subject to their frozen strict reducer shape.
  assert.throws(() => applyEvent(bound, event("task.settled", { taskId: "t1", outcome: "succeeded", attempt: 1, executionHead: "d".repeat(40), runProof: { runId: "run-v2", proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome: "succeeded", agentProfile: "coder-alpha" } }, 5)), /exactly: taskId, outcome, attempt, executionHead, runProof, settlementEvidence/);
  assert.equal(Object.hasOwn(bound.tasks.get("t1"), "lastExecutorProof"), false);
});

test("historical v2 settlement replay preserves failed and blocked lifecycle outcomes", () => {
  const bind = (projection, runId, n) => applyEvent(projection, event("task.run_bound", { taskId: "t1", attempt: 1, runId, agentProfile: "coder-alpha", contractHash: hash("a"), workspaceId: "goal-v2-workspace", asyncDir: "/tmp/v2-async", workspacePath: "/tmp/v2-workspace", workspaceLeaseId: hash("c"), headAtDispatch: "b".repeat(40) }, n));
  const proof = (runId, outcome) => ({ runId, proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome, agentProfile: "coder-alpha" });
  for (const proofOutcome of ["succeeded", "failed"]) {
    const failed = applyEvent(bind(dispatched(), `run-failed-${proofOutcome}`, 3), event("task.settled", { taskId: "t1", outcome: "failed", attempt: 1, runProof: proof(`run-failed-${proofOutcome}`, proofOutcome), nextAction: "Investigate the failed execution and prepare a concrete retry plan." }, 4));
    assert.equal(failed.tasks.get("t1").status, "pending");
    assert.equal(failed.tasks.get("t1").lastRunProof.outcome, proofOutcome);
    const blocked = applyEvent(bind(dispatched(), `run-blocked-${proofOutcome}`, 3), event("task.settled", { taskId: "t1", outcome: "blocked", attempt: 1, runProof: proof(`run-blocked-${proofOutcome}`, proofOutcome), reason: "The required external service remains unavailable to this run.", nextAction: "Wait for the external service and rerun the verified task contract." }, 4));
    assert.equal(blocked.tasks.get("t1").status, "blocked");
    assert.match(blocked.tasks.get("t1").blockedReason, /external service/);
  }
  assert.throws(() => applyEvent(bind(dispatched(), "run-bad", 3), event("task.settled", { taskId: "t1", outcome: "failed", attempt: 1, runProof: proof("run-bad", "blocked"), nextAction: "Investigate the failed execution and prepare a concrete retry plan." }, 4)), /proof/i);
});

test("v2 direct dispatch is read-only and cannot mint a run-binding ticket", () => {
  const projection = dispatched();
  const before = projection.tasks.get("t1");
  assert.equal(prepareRunBindingTicket({ projection, taskId: "t1", contractHash: hash("a"), controlCwd: "/repo", rootSessionId: "root" }), null);
  assert.equal(before.status, "dispatched");
  assert.equal(before.runBinding, null);
  assert.deepEqual([...projection.runIds], []);
});
