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

test("run quiescence rejects a malformed observed-looking terminal", async () => {
  const { waitForHarnessRunQuiescence } = await import("./support/flat-plan-run-quiescence.mjs");
  await assert.rejects(waitForHarnessRunQuiescence({
    timeoutMs: 10,
    quietMs: 2,
    pollIntervalMs: 1,
    listRuns: async () => [{ runId: "run-malformed", asyncDir: "/tmp/run-malformed" }],
    readOfficialTerminal: async () => ({ runId: "run-malformed", state: "observed" }),
  }), /run-malformed.*official terminal/i);
});

test("run quiescence requires every known initial run", async () => {
  const { waitForHarnessRunQuiescence } = await import("./support/flat-plan-run-quiescence.mjs");
  await assert.rejects(waitForHarnessRunQuiescence({
    timeoutMs: 10,
    quietMs: 2,
    pollIntervalMs: 1,
    requiredRuns: [{ runId: "run-required", asyncDir: "/tmp/run-required" }],
    listRuns: async () => [],
    readOfficialTerminal: async () => undefined,
  }), /required actual run.*run-required/i);
});

test("run quiescence rejects an actual run that disappears after observation", async () => {
  const { waitForHarnessRunQuiescence } = await import("./support/flat-plan-run-quiescence.mjs");
  let polls = 0;
  await assert.rejects(waitForHarnessRunQuiescence({
    timeoutMs: 30,
    quietMs: 10,
    pollIntervalMs: 1,
    requiredRuns: [{ runId: "run-a", asyncDir: "/tmp/run-a" }],
    listRuns: async () => {
      polls += 1;
      if (polls === 1) return [{ runId: "run-a", asyncDir: "/tmp/run-a" }];
      if (polls === 2) return [{ runId: "run-a", asyncDir: "/tmp/run-a" }, { runId: "run-b", asyncDir: "/tmp/run-b" }];
      return [{ runId: "run-a", asyncDir: "/tmp/run-a" }];
    },
    readOfficialTerminal: async ({ runId }) => observed(runId),
  }), /actual run disappeared.*run-b/i);
});

test("run quiescence timeout reports a changing fully observed run set", async () => {
  const { waitForHarnessRunQuiescence } = await import("./support/flat-plan-run-quiescence.mjs");
  let polls = 0;
  await assert.rejects(waitForHarnessRunQuiescence({
    timeoutMs: 10,
    quietMs: 50,
    pollIntervalMs: 1,
    requiredRuns: [{ runId: "run-a", asyncDir: "/tmp/run-a" }],
    listRuns: async () => {
      polls += 1;
      return Array.from({ length: polls }, (_, index) => {
        const runId = index === 0 ? "run-a" : `run-${index + 1}`;
        return { runId, asyncDir: `/tmp/${runId}` };
      });
    },
    readOfficialTerminal: async ({ runId }) => observed(runId),
  }), /quiet window not reached.*last run ids.*run-a.*last change/i);
});
