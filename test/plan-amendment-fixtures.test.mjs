import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { bindRootBroker, unbindRootBroker } = await jiti.import("../scripts/lib/subagent-dispatch/root-broker-registry.ts");
const fixture = await jiti.import("./fixtures/plan-harness/root-amendment-control-extension.ts");

function install(broker) {
  const pi = { events: {}, registerTool(tool) { this.tool = tool; } };
  bindRootBroker(pi, broker);
  fixture.default(pi);
  return { pi, tool: pi.tool };
}

test("root amendment fixture drains the exact Executor before its active Plan Runner", async () => {
  const calls = [];
  const broker = {
    callers: new Map([["logical-1", { ownedRunIds: new Set(["executor-1"]) }]]),
    runOwners: new Map([["executor-1", "logical-1"]]),
    ownedRuns: new Map([["executor-1", { runId: "executor-1", role: "executor" }], ["runner-active", { runId: "runner-active", role: "plan-runner" }]]),
    terminalProofs: new Map(),
    resolveActiveCaller(id) { assert.equal(id, "logical-1"); return "runner-active"; },
    async drainRun(run) { calls.push(run.runId); this.terminalProofs.set(run.runId, { runId: run.runId, state: "observed" }); },
  };
  const { pi, tool } = install(broker);
  try {
    const response = await tool.execute("x", { logicalRunId: "logical-1", executorRunId: "executor-1" });
    assert.equal(response.isError, undefined);
    assert.deepEqual(calls, ["executor-1", "runner-active"]);
    const proof = JSON.parse(response.content[0].text);
    assert.equal(proof.actualRunId, "runner-active");
    assert.deepEqual(proof.executorProof, { runId: "executor-1", state: "observed" });
    assert.deepEqual(proof.runnerProof, { runId: "runner-active", state: "observed" });
  } finally { unbindRootBroker(pi, broker); }
});

test("root amendment fixture fails closed when owner or active generation changes", async () => {
  const broker = {
    callers: new Map([["logical-1", { ownedRunIds: new Set() }]]),
    runOwners: new Map([["executor-1", "other"]]),
    ownedRuns: new Map([["executor-1", { runId: "executor-1", role: "executor" }], ["runner-active", { runId: "runner-active", role: "plan-runner" }]]),
    terminalProofs: new Map(),
    resolveActiveCaller() { return "runner-active"; },
    async drainRun() { throw new Error("must not drain"); },
  };
  const { pi, tool } = install(broker);
  try {
    const response = await tool.execute("x", { logicalRunId: "logical-1", executorRunId: "executor-1" });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /ownership changed/);
  } finally { unbindRootBroker(pi, broker); }
});
