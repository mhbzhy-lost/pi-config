import assert from "node:assert/strict";
import test from "node:test";
import { createProjection, applyEvent } from "../src/goal-engine/events.ts";

const SHA256 = "a".repeat(64);
const HEAD = "b".repeat(40);

function abandonedData({ head = HEAD, receiptHash = SHA256, manifestHead = head, manifestDisposition = "preserved" } = {}) {
  return {
    suspensionId: "suspension-1",
    deficits: ["workspace-closure"],
    ownerSessionId: "session-1",
    reasonDigest: SHA256,
    preserveProof: {
      safe: true,
      preserved: [{
        taskId: "task-1", attempt: 1, head,
        receipt: {
          ownerCas: SHA256, workspacePath: "/workspace/task-1", executorHead: head,
          disposition: "preserved", receiptHash,
          manifest: {
            id: "allocation-1", originRoot: "/origin", path: "/workspace/task-1",
            branchRef: "refs/heads/task-1", baseCommit: "c".repeat(40),
            headCommit: manifestHead, state: "preserved", disposition: manifestDisposition,
          },
        },
      }],
    },
  };
}

function suspendedProjection() {
  const projection = createProjection();
  Object.assign(projection, {
    goalId: "goal-1", lifecycle: "active", eventSchemaVersion: "goal-runtime.v1",
    runtimeGeneration: "goal-runtime.v1", runtimeState: "suspended",
    suspension: { suspensionId: "suspension-1", resourcesQuarantined: false, affectedTaskIds: ["task-1"], affectedRunIds: [] },
  });
  return projection;
}

function abandon(projection, data) {
  return applyEvent(projection, {
    schemaVersion: "goal-runtime.v1", eventId: crypto.randomUUID(), goalId: "goal-1",
    occurredAt: "2026-08-25T00:00:00.000Z", type: "goal.runtime_abandoned", data,
  });
}

test("runtime_abandoned accepts Git heads and exact SHA-256 proof hashes", () => {
  const next = abandon(suspendedProjection(), abandonedData());
  assert.equal(next.runtimeState, "abandoned");
  assert.equal(next.lifecycle, "abandoned");
});

test("runtime_abandoned rejects invalid head/hash lengths and manifest identity", () => {
  for (const data of [
    abandonedData({ head: "b".repeat(64) }),
    abandonedData({ receiptHash: "a".repeat(40) }),
    abandonedData({ manifestHead: "d".repeat(40) }),
    abandonedData({ manifestDisposition: { state: "preserved", reason: "goal workspace preserved" } }),
    abandonedData({ manifestDisposition: "discarded" }),
  ]) assert.throws(() => abandon(suspendedProjection(), data), /invalid runtime abandonment/);
});
