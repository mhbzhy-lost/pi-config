import assert from "node:assert/strict";
import test from "node:test";

const observed = (runId) => ({ version: 1, runId, state: "observed", runnerProcessInstanceId: `process-${runId}`, observedAt: 1, instances: [{ kind: "runner", processInstanceId: `process-${runId}`, closeObservedAt: 1, exitCode: 0, signal: null }], resumeDisposition: "resumable" });

test("run quiescence waits for a late generation and its official terminal proof", async () => {
  const { waitForHarnessRunQuiescence } = await import("./support/flat-plan-run-quiescence.mjs");
  let polls = 0;
  const result = await waitForHarnessRunQuiescence({
    timeoutMs: 100,
    quietMs: 5,
    pollIntervalMs: 1,
    listRuns: async () => {
      polls += 1;
      return polls === 1
        ? [{ runId: "run-a", asyncDir: "/tmp/run-a" }]
        : [{ runId: "run-a", asyncDir: "/tmp/run-a" }, { runId: "run-b", asyncDir: "/tmp/run-b" }];
    },
    readOfficialTerminal: async ({ runId }) => runId === "run-a" || polls >= 3 ? observed(runId) : undefined,
  });

  assert.deepEqual(result.map(({ runId }) => runId), ["run-a", "run-b"]);
  assert.ok(polls >= 3, "late generation must be observed before the barrier resolves");
});

test("run quiescence times out while any actual run lacks official proof", async () => {
  const { waitForHarnessRunQuiescence } = await import("./support/flat-plan-run-quiescence.mjs");
  await assert.rejects(waitForHarnessRunQuiescence({
    timeoutMs: 10,
    quietMs: 2,
    pollIntervalMs: 1,
    listRuns: async () => [{ runId: "run-pending", asyncDir: "/tmp/run-pending" }],
    readOfficialTerminal: async () => undefined,
  }), /run-pending.*official terminal/i);
});
