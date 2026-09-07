import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection } from "../src/goal-engine/events.ts";
import { assertExecutionSettlementProof, assertRunBindingTicketCurrent, prepareRunBindingTicket, runBoundEventData } from "../src/goal-engine/run-binding.ts";

const hash = (value) => value.repeat(64).slice(0, 64);
const event = (type, data, n) => ({ schemaVersion: "planned.v2", eventId: `v2-${n}`, goalId: "v2-goal", occurredAt: "2026-09-07T00:00:00.000Z", type, data });
const workspaceReceipt = () => ({ schemaVersion: "managed-workspace.v1", workspaceId: "goal-v2-workspace", leaseId: hash("c"), owner: { kind: "goal-task", rootSessionId: "root", goalId: "v2-goal", taskId: "t1", attempt: 1, executionRevision: 1 }, originRoot: "/repo", requestedCwd: "/repo", originRef: "refs/heads/main", baseCommit: "b".repeat(40), path: "/tmp/v2-workspace", dispatchCwd: "/tmp/v2-workspace", branchRef: "refs/heads/goal-v2", state: "active", run: null, disposition: null, cleanupDebt: null });

function dispatched() {
  let projection = applyEvent(createProjection(), event("goal.created", { objective: "v2", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { agentProfile: " coder-alpha ", description: "work", deps: [], writePaths: ["src/a.ts"], acceptance: { criteria: [{ id: "proof", statement: "proof", evidenceKinds: ["tests"], evaluator: "run" }] }, workflow: "tdd" } } }, 1));
  projection = applyEvent(projection, event("task.dispatched", { taskId: "t1", contractHash: hash("a"), workspace: workspaceReceipt() }, 2));
  return projection;
}

test("v2 run binding is profile-bound, unique, and immutable", () => {
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
  const settled = applyEvent(bound, event("task.settled", { taskId: "t1", outcome: "succeeded", attempt: 1, executionHead: "d".repeat(40), runProof: { runId: "run-v2", proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome: "succeeded", agentProfile: "coder-alpha" } }, 5));
  assert.equal(settled.tasks.get("t1").lastRunProof.runId, "run-v2");
  assert.equal(Object.hasOwn(settled.tasks.get("t1"), "lastExecutorProof"), false);
});

test("v2 settlements preserve failed and blocked lifecycle outcomes", () => {
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

test("run binding ticket and settlement proof reject identity drift", () => {
  const projection = dispatched();
  const ticket = prepareRunBindingTicket({ projection, taskId: "t1", contractHash: hash("a"), controlCwd: "/repo", rootSessionId: "root" });
  assert.equal(ticket.agentProfile, "coder-alpha");
  assert.equal(ticket.workspaceId, "goal-v2-workspace");
  assert.deepEqual(ticket.workspaceRequest, {
    workspaceId: "goal-v2-workspace",
    owner: { kind: "goal-task", rootSessionId: "root", goalId: "v2-goal", taskId: "t1", attempt: 1, executionRevision: 1 },
    originRoot: "/repo",
    requestedCwd: "/repo",
    originRef: "refs/heads/main",
    baseCommit: "b".repeat(40),
    contractHash: hash("a"),
    mode: "coding",
    writePaths: ["src/a.ts"],
  });
  assert.doesNotThrow(() => assertRunBindingTicketCurrent(ticket, projection));
  assert.throws(() => assertRunBindingTicketCurrent({ ...ticket, agentProfile: "coder-beta" }, projection), /binding/i);
  assert.throws(() => assertRunBindingTicketCurrent({ ...ticket, workspaceRequest: { ...ticket.workspaceRequest, contractHash: hash("e") } }, projection), /binding/i);
  const data = runBoundEventData(ticket, { runId: "run-v2", asyncDir: "/tmp/v2-async", agentProfile: "coder-alpha" }, workspaceReceipt());
  assert.equal(data.workspaceId, "goal-v2-workspace");
  assert.throws(() => runBoundEventData(ticket, { runId: "run-v2", asyncDir: "/tmp/v2-async", agentProfile: "coder-alpha" }, { ...workspaceReceipt(), workspaceId: "goal-other" }), /workspace/i);
  const bound = applyEvent(projection, event("task.run_bound", data, 3));
  assert.deepEqual(assertExecutionSettlementProof({ task: bound.tasks.get("t1"), proof: { runId: "run-v2", proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome: "succeeded", agentProfile: "coder-alpha" } }), { runId: "run-v2", proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome: "succeeded", agentProfile: "coder-alpha" });
  assert.throws(() => assertExecutionSettlementProof({ task: bound.tasks.get("t1"), proof: { runId: "run-v2", proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome: "succeeded", agentProfile: "coder-beta" } }), /profile/i);
  for (const taskOutcome of ["failed", "blocked"]) for (const proofOutcome of ["succeeded", "failed"]) assert.equal(assertExecutionSettlementProof({ task: bound.tasks.get("t1"), taskOutcome, proof: { runId: "run-v2", proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome: proofOutcome, agentProfile: "coder-alpha" } }).outcome, proofOutcome);
  assert.throws(() => assertExecutionSettlementProof({ task: bound.tasks.get("t1"), taskOutcome: "failed", proof: { runId: "run-v2", proofId: hash("d"), rootSessionId: "root", observedAt: 1, outcome: "blocked", agentProfile: "coder-alpha" } }), /proof/i);
});
