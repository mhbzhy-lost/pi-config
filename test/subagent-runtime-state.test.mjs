import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFromStatus } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-state.ts";

test("asyncSnapshot running run is exposed as steerable runtime", () => {
  const runtime = runtimeFromStatus("run-live", {
    asyncSnapshot: { runs: [{ id: "run-live", state: "running" }] },
  });
  assert.deepEqual(runtime, { runId: "run-live", running: true, steerable: true });
});

test("terminal asyncSnapshot run is not steerable", () => {
  const runtime = runtimeFromStatus("run-done", {
    asyncSnapshot: { runs: [{ id: "run-done", state: "complete" }] },
  });
  assert.deepEqual(runtime, { runId: "run-done", running: false, steerable: false });
});
