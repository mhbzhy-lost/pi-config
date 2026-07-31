import assert from "node:assert/strict";
import test from "node:test";

function attempt(taskId, status, requestId) {
  return {
    taskId,
    status,
    attemptId: `attempt-${taskId}`,
    runId: `run-${taskId}`,
    attention: requestId ? { requestId, projectionVersion: 1 } : null,
  };
}

test("Attention driver replies incrementally before all capacity-blocked requests exist", async () => {
  let support = {};
  try { support = await import("./support/flat-plan-attention-driver.mjs"); } catch {}
  assert.equal(typeof support.driveHarnessAttention, "function", "driveHarnessAttention is required");

  const replied = new Set();
  const callbackOrder = [];
  let reads = 0;
  const statuses = () => [
    {
      tasks: [
        { taskId: "task-1", attempts: [attempt("p0-task-1", replied.has("p0-task-1") ? "active" : "waiting-attention", "p0-task-1")] },
        { taskId: "task-2", attempts: [attempt("p0-task-2", replied.size > 0 && !replied.has("p0-task-2") ? "waiting-attention" : "active", replied.size > 0 ? "p0-task-2" : undefined)] },
      ],
    },
    {
      tasks: [
        { taskId: "task-1", attempts: [attempt("p1-task-1", replied.has("p1-task-1") ? "active" : "waiting-attention", "p1-task-1")] },
        { taskId: "task-2", attempts: [attempt("p1-task-2", replied.has("p1-task-2") ? "active" : "waiting-attention", "p1-task-2")] },
      ],
    },
  ];

  const result = await support.driveHarnessAttention({
    handles: [{ planId: "plan-0" }, { planId: "plan-1" }],
    expectedPerPlan: 2,
    timeoutMs: 100,
    pollIntervalMs: 0,
    readStatuses: async () => { reads += 1; return statuses(); },
    readRunners: async () => [{ state: "complete" }, { state: "complete" }],
    onPending: async ({ planIndex, attempt: pending }) => {
      assert.ok(pending.attention?.requestId);
      callbackOrder.push(`${planIndex}:${pending.taskId}`);
      replied.add(pending.attention.requestId);
    },
  });

  assert.ok(reads >= 2, "the fourth request must require a post-reply poll");
  assert.equal(callbackOrder.length, 4);
  assert.equal(new Set(callbackOrder).size, 4);
  assert.deepEqual(result.pending.map((entries) => entries.length), [2, 2]);
  assert.equal(replied.has("p0-task-2"), true, "capacity-blocked request was eventually observed and replied");
});
