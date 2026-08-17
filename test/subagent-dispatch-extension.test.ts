import assert from "node:assert/strict";
import test from "node:test";

import { createTypedSubagentExtension } from "../scripts/lib/subagent-dispatch/extension.ts";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";

const contract = {
  version: "dispatch-ir.v1", taskId: "identity-ledger", title: "Bind durable spawn identity", agent: "executor", risk: "normal",
  objective: "Bind coding calls to durable identities.", workflow: { mode: "tdd" }, requirements: ["Preserve the exact contract."],
  context: { knownFacts: [], decisions: [], relevantFiles: ["test/subagent-dispatch-extension.test.ts"] },
  boundaries: { writePaths: ["test/subagent-dispatch-extension.test.ts"], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["Identity is trusted."] }, execution: { cwd: "/repo", timeoutMs: 1_000 },
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

test("coding spawn resolves durable metadata exactly once", async () => {
  const { pi, rpc, calls, tools } = setup(); const resolved = [];
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-1", spawnKey: "durable-dispatch-1" }; } });
  const result = await tools[0].execute("tool-call-identity-1", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false); assert.equal(resolved.length, 1); assert.equal(calls.length, 1);
  assert.equal(result.details.dispatchId, "durable-dispatch-1");
  assert.equal(result.details.runId, "run-1");
  assert.equal(result.details.asyncDir, "/tmp/run-1");
});

test("coding spawn resolver receives the raw contract", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await tools[0].execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.strictEqual(resolved[0]?.contract, contract);
});

test("coding spawn resolver receives the tool call id", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await tools[0].execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved[0]?.toolCallId, "tool-call-identity-2");
});

test("coding spawn resolver receives the exact compiled hash", async () => {
  const { pi, rpc, tools } = setup(); const resolved = [];
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-2", spawnKey: "durable-dispatch-2" }; } });
  await tools[0].execute("tool-call-identity-2", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved[0]?.contractHash, compileCodingDispatchIR(contract, { cwd: "/repo" }).hash);
});

test("coding spawn forwards resolver metadata raw as RPC options and excludes spawnKey from params", async () => {
  const { pi, rpc, calls, tools } = setup();
  const metadata = { requestId: "durable-dispatch-3", spawnKey: "durable-dispatch-3" };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity() { return metadata; } });
  await tools[0].execute("tool-call-identity-3", contract, undefined, undefined, { cwd: "/repo" });
  assert.strictEqual(calls[0]?.options, metadata);
  assert.equal(Object.hasOwn(calls[0]?.params ?? {}, "spawnKey"), false);
});

test("coding prepare runs after ping and before spawn", async () => {
  const { pi, rpc, tools } = setup(); const order = [];
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/tmp/s", cwd: "/repo" } }; };
  rpc.spawn = async () => { order.push("spawn"); return { details: { runId: "run-1", asyncDir: "/tmp/run-1" } }; };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { order.push("prepare"); } });
  await tools[0].execute("prepare-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(order, ["ping", "prepare", "spawn"]);
});

test("coding prepare runs before durable identity resolution", async () => {
  const { pi, rpc, tools } = setup(); const order = [];
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/tmp/s", cwd: "/repo" } }; };
  rpc.spawn = async () => { order.push("spawn"); return { details: { runId: "run-1", asyncDir: "/tmp/run-1" } }; };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { order.push("prepare"); }, resolveCodingSpawnIdentity() { order.push("resolveIdentity"); return { requestId: "x", spawnKey: "x" }; } });
  await tools[0].execute("prepare-resolver-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(order, ["ping", "prepare", "resolveIdentity", "spawn"]);
});

test("coding prepare failure prevents identity resolution and spawn", async () => {
  const { pi, rpc, calls, tools } = setup(); let resolved = 0;
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { throw new Error("owner wrapper failed"); }, resolveCodingSpawnIdentity() { resolved += 1; return { requestId: "x", spawnKey: "x" }; } });
  const result = await tools[0].execute("prepare-fail", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /owner wrapper failed/);
  assert.equal(calls.length, 0); assert.equal(resolved, 0);
});

test("generic and control dispatches never prepare or resolve coding spawn identity", async () => {
  const { pi, rpc, tools } = setup(); let resolved = 0; let prepared = 0;
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { prepared += 1; }, resolveCodingSpawnIdentity() { resolved += 1; return { requestId: "x", spawnKey: "x" }; } });
  await tools[0].execute("generic-call", { agent: "reviewer", title: "Review", task: "Inspect." }, undefined, undefined, { cwd: "/repo" });
  await tools[0].execute("control-call", { action: "status", id: "run-1" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(resolved, 0); assert.equal(prepared, 0);
});
