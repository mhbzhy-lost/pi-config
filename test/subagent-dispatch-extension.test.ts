import assert from "node:assert/strict";
import test from "node:test";

import { createTypedSubagentExtension } from "../scripts/lib/subagent-dispatch/extension.ts";

const contract = {
  version: "dispatch-ir.v1", taskId: "identity-ledger", title: "Bind durable spawn identity", agent: "executor", risk: "normal",
  objective: "Bind coding calls to durable identities.", workflow: { mode: "tdd" }, requirements: ["Preserve the exact contract."],
  context: { knownFacts: [], decisions: [], relevantFiles: ["test/subagent-dispatch-extension.test.ts"] },
  boundaries: { writePaths: ["test/subagent-dispatch-extension.test.ts"], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["Identity is trusted."], commands: ["node --test test/subagent-dispatch-extension.test.ts"] }, execution: { cwd: "/repo", timeoutMs: 1_000 },
};

function setup() {
  const tools = []; const calls = [];
  const pi = { events: { on() { return () => {}; }, emit() {} }, registerTool(tool) { tools.push(tool); }, on() {} };
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/tmp/s", cwd: "/repo" } }; },
    async spawn(params, options) { calls.push({ params, options }); return { details: { runId: "run-1", asyncDir: "/tmp/run-1" } }; },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  return { pi, rpc, calls, tools };
}

test("coding spawn resolver binds toolCallId and exact contract to durable raw RPC metadata", async () => {
  const { pi, rpc, calls, tools } = setup(); const resolved = [];
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-1", spawnKey: "durable-dispatch-1" }; } });
  const result = await tools[0].execute("tool-call-identity-1", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false); assert.equal(resolved.length, 1);
  assert.equal(resolved[0].toolCallId, "tool-call-identity-1"); assert.strictEqual(resolved[0].contract, contract); assert.match(resolved[0].contractHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls[0].options, { requestId: "durable-dispatch-1", spawnKey: "durable-dispatch-1" }); assert.equal(calls[0].params.spawnKey, undefined);
});

test("generic and control dispatches never resolve coding spawn identity", async () => {
  const { pi, rpc, tools } = setup(); let resolved = 0;
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity() { resolved += 1; return { requestId: "x", spawnKey: "x" }; } });
  await tools[0].execute("generic-call", { agent: "reviewer", title: "Review", task: "Inspect." }, undefined, undefined, { cwd: "/repo" });
  await tools[0].execute("control-call", { action: "status", id: "run-1" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved, 0);
});
