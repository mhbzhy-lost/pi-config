import assert from "node:assert/strict";
import test from "node:test";

import { createTypedSubagentExtension } from "../scripts/lib/subagent-dispatch/extension.ts";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";
import { bindGoalExecutorCoordinator, bindGoalExecutorCoordinatorSession, unbindGoalExecutorCoordinatorSession } from "../scripts/lib/subagent-dispatch/root-broker-registry.ts";

const contract = {
  version: "dispatch-ir.v1", taskId: "identity-ledger", title: "Bind durable spawn identity", agent: "executor", risk: "normal",
  objective: "Bind coding calls to durable identities.", workflow: { mode: "tdd" }, requirements: ["Preserve the exact contract."],
  context: { knownFacts: [], decisions: [], relevantFiles: ["test/subagent-dispatch-extension.test.ts"] },
  boundaries: { writePaths: ["test/subagent-dispatch-extension.test.ts"], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["Identity is trusted."] }, execution: { cwd: "/repo", timeoutMs: 1_000 },
};

function setup() {
  const tools = []; const calls = []; const listeners = new Map();
  const events = {
    on(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener); listeners.set(type, current);
      return () => current.delete(listener);
    },
    emit(type, event) { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); },
  };
  const pi = { events, registerTool(tool) { tools.push(tool); }, on() {} };
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; },
    async spawn(params, options) {
      calls.push({ params, options });
      const match = params.workflowScript.match(/^return await runs\.run\(([^,]+), (.*)\);$/);
      const workflowKey = JSON.parse(match[1]); const { agent } = JSON.parse(match[2]);
      queueMicrotask(() => events.emit("subagent:async-started", {
        parentWorkflowRunId: "run-1", runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "s", pid: 123, agent, workflowKey,
      }));
      return { details: { runId: "run-1", asyncDir: "/tmp/run-1" } };
    },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  return { pi, rpc, calls, tools };
}

function workflowLeaf(params: any) {
  const match = String(params.workflowScript).match(/runs\.run\("[^"]+", (.*)\);/);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]);
}

test("coding spawn binds the Goal coordinator through a same-root different-ExtensionAPI wrapper before returning", async () => {
  const { pi, rpc, tools } = setup();
  const goalPi = { events: {} };
  const bindings: any[] = [];
  const coordinator = {
    prepareSpawn() { return { ticketId: "goal-ticket", spawnIdentity: { requestId: "goal-request", spawnKey: "goal-request" } }; },
    bindSpawn(ticket: any, binding: any) { bindings.push({ ticket, binding }); },
  };
  bindGoalExecutorCoordinator(goalPi, coordinator);
  bindGoalExecutorCoordinatorSession(goalPi, "root-shared", coordinator);
  try {
    createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveRootSessionId() { return "root-shared"; } });
    const result = await tools[0].execute("goal-wrapper-bridge", contract, undefined, undefined, { cwd: "/repo", sessionManager: {} });
    assert.equal(result.isError, false, result.content[0]?.text);
    assert.deepEqual(bindings, [{ ticket: { ticketId: "goal-ticket", spawnIdentity: { requestId: "goal-request", spawnKey: "goal-request" } }, binding: { runId: "leaf-1", asyncDir: "/tmp/leaf-1" } }]);
  } finally {
    unbindGoalExecutorCoordinatorSession(goalPi, "root-shared", coordinator);
  }
});

test("coding spawn leaves executor model selection to ordered agent metadata", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  await tools[0].execute("ordered-models", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(workflowLeaf(calls[0]?.params).agent, "executor");
  assert.equal(Object.hasOwn(workflowLeaf(calls[0]?.params), "model"), false);
});

test("coding spawn lets explicit modelTier override the ordered metadata primary", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  await tools[0].execute("tier-luna", { ...contract, modelTier: "luna" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(workflowLeaf(calls[0]?.params).model, "codex-pool/gpt-5.6-luna");
});

test("coding spawn resolves durable metadata exactly once", async () => {
  const { pi, rpc, calls, tools } = setup(); const resolved = [];
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, resolveCodingSpawnIdentity(value) { resolved.push(value); return { requestId: "durable-dispatch-1", spawnKey: "durable-dispatch-1" }; } });
  const result = await tools[0].execute("tool-call-identity-1", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false, result.content[0]?.text); assert.equal(resolved.length, 1); assert.equal(calls.length, 1);
  assert.equal(result.details.dispatchId, "durable-dispatch-1");
  assert.equal(result.details.runId, "leaf-1");
  assert.equal(result.details.asyncDir, "/tmp/leaf-1");
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
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args) => { order.push("spawn"); return spawn(...args); };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, async prepareCodingSpawn() { order.push("prepare"); } });
  await tools[0].execute("prepare-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.deepEqual(order, ["ping", "prepare", "spawn"]);
});

test("coding prepare runs before durable identity resolution", async () => {
  const { pi, rpc, tools } = setup(); const order = [];
  rpc.ping = async () => { order.push("ping"); return { version: 1, methods: ["spawn"], session: { sessionId: "s", cwd: "/repo" } }; };
  const spawn = rpc.spawn;
  rpc.spawn = async (...args) => { order.push("spawn"); return spawn(...args); };
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
