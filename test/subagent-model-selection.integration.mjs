import assert from "node:assert/strict";
import test from "node:test";

import { createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { assertRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

function authorizationRegistrar(registrations) {
  return (authorization) => {
    assertRunAuthorization(authorization);
    registrations.push(authorization);
  };
}

function harness() {
  const tools = []; const calls = []; const listeners = new Map();
  const pi = { events: { on(type, fn) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); return () => set.delete(fn); } }, registerTool(tool) { tools.push(tool); }, on() {} };
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "lifecycle-session", sessionFile: "/tmp/pi-sessions/lifecycle.jsonl", cwd: "/repo" } }; },
    async spawn(params) { calls.push(params); const [key, leaf] = params.workflowScript.match(/^return await runs\.run\(([^,]+), (.*)\);$/).slice(1); queueMicrotask(() => { for (const fn of listeners.get("subagent:async-started") ?? []) fn({ parentWorkflowRunId: "root", runId: "leaf", asyncDir: "/tmp/leaf", sessionId: "/tmp/pi-sessions/lifecycle.jsonl", pid: 1, agent: JSON.parse(leaf).agent, workflowKey: JSON.parse(key) }); }); return { details: { runId: "root", asyncDir: "/tmp/root" } }; },
    dispose() {},
  };
  return { pi, rpc, calls, tools };
}

const codingContract = {
  version: "dispatch-ir.v1", taskId: "undiscovered-executor", title: "Undiscovered executor", agent: "executor", risk: "normal",
  objective: "Prove discovery rejects before lifecycle effects.", workflow: { mode: "tdd" }, requirements: ["Do not spawn."],
  context: { knownFacts: [], decisions: [], relevantFiles: [] }, boundaries: { writePaths: ["test/subagent-model-selection.integration.mjs"], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["No effects occur."] }, execution: { cwd: "/repo", timeoutMs: 1_000, worktree: true },
};

test("generic bare model uses sorted global catalog warning and normalized request separates workspace hashes", async () => {
  const { pi, rpc, calls, tools } = harness(); const requests = []; const registrations = [];
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, randomUUID: () => `workspace-${requests.length + 1}`,
    discoverAgents() { return { agents: [{ name: "reviewer" }] }; },
    workspaceService: { ensureAllocated(request) { requests.push(request); return { workspaceId: request.workspaceId, leaseId: "a".repeat(64), state: "active", dispatchCwd: "/managed" }; }, async bindRun({ run }) { return { workspaceId: "workspace", leaseId: "a".repeat(64), state: "active", dispatchCwd: "/managed", run }; } },
    resolveRootSessionId: () => "root-session", resolveCanonicalOrigin: async () => "/repo", inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }), registerAuthorizedRun: authorizationRegistrar(registrations),
  });
  const ctx = { cwd: "/repo", sessionManager: {}, modelRegistry: { getAvailable() { return [{ provider: "openai", id: "gpt-5.6-sol" }, { provider: "codex-pool", id: "gpt-5.6-sol" }, { provider: "codex-pool", id: "gpt-5.6-luna" }]; } } };
  const result = await tools[0].execute("generic", { agent: "reviewer", title: "Review", task: "Inspect.", model: " gpt-5.6-sol ", worktree: true }, undefined, undefined, ctx);
  assert.equal(result.isError, false); assert.match(result.content[0].text, /Warning: requested model gpt-5\.6-sol matched codex-pool\/gpt-5\.6-sol/);
  assert.deepEqual(result.details.modelSelection, { requestedModel: "gpt-5.6-sol", resolvedModel: "codex-pool/gpt-5.6-sol", source: "global-catalog" });
  assert.deepEqual(result.details.warnings, [{ code: "MODEL_MATCH_USED_GLOBAL_CATALOG", agent: "reviewer", requestedModel: "gpt-5.6-sol", resolvedModel: "codex-pool/gpt-5.6-sol" }]);
  assert.equal(JSON.parse(calls[0].workflowScript.match(/, (.*)\);$/)[1]).model, "codex-pool/gpt-5.6-sol");
  const second = await tools[0].execute("generic-qualified", { agent: "reviewer", title: "Review", task: "Inspect.", model: "codex-pool/gpt-5.6-sol", worktree: true }, undefined, undefined, ctx);
  assert.equal(second.isError, false);
  assert.equal(Object.hasOwn(second.details, "warnings"), false);
  assert.notEqual(requests[0].contractHash, requests[1].contractHash);
  assert.deepEqual(registrations.map(({ kind, binding, capabilities, goal }) => ({ kind, binding, capabilities, goal })), [
    { kind: "generic", binding: { runId: "leaf", asyncDir: "/tmp/leaf", sessionId: "/tmp/pi-sessions/lifecycle.jsonl", pid: 1, agentProfile: "reviewer" }, capabilities: [], goal: null },
    { kind: "generic", binding: { runId: "leaf", asyncDir: "/tmp/leaf", sessionId: "/tmp/pi-sessions/lifecycle.jsonl", pid: 1, agentProfile: "reviewer" }, capabilities: [], goal: null },
  ]);
});

test("model misses and undiscovered generic targets have no workspace, Goal, RPC, or title side effects", async () => {
  const { pi, rpc, calls, tools } = harness(); let effects = 0;
  rpc.ping = async () => { effects += 1; return {}; };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, discoverAgents() { return { agents: [{ name: "reviewer", models: [] }] }; }, workspaceService: { ensureAllocated() { effects += 1; } } });
  const ctx = { cwd: "/repo", modelRegistry: { getAvailable() { return []; } } };
  const result = await tools[0].execute("miss", { agent: "reviewer", title: "Review", task: "Inspect.", model: "missing", worktree: true }, undefined, undefined, ctx);
  const undiscovered = await tools[0].execute("undiscovered", { agent: "absent", title: "Absent", task: "Inspect.", model: "missing", worktree: true }, undefined, undefined, ctx);
  const undiscoveredDefault = await tools[0].execute("undiscovered-default", { agent: "absent", title: "Absent", task: "Inspect.", worktree: true }, undefined, undefined, ctx);
  assert.equal(result.details.code, "MODEL_NOT_AVAILABLE");
  assert.equal(undiscovered.details.code, "UNKNOWN_AGENT");
  assert.equal(undiscoveredDefault.details.code, "UNKNOWN_AGENT");
  assert.equal(effects, 0); assert.equal(calls.length, 0);
});

test("undiscovered coding profile fails before Goal, workspace, RPC, and title effects without a model", async () => {
  const { pi, rpc, calls, tools } = harness(); let effects = 0;
  rpc.ping = async () => { effects += 1; return {}; };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() { return { agents: [] }; },
    goalExecutorCoordinator: { prepareSpawn() { effects += 1; return undefined; } },
    workspaceService: { ensureAllocated() { effects += 1; } },
    titleRegistry: { prepare() { effects += 1; } },
  });
  const result = await tools[0].execute("undiscovered-coder", { ...codingContract, agent: "coder-alpha" }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "codex-pool", id: "gpt-5.6-sol" }]; } },
  });
  assert.equal(result.details.code, "UNKNOWN_AGENT");
  assert.equal(effects, 0); assert.equal(calls.length, 0);
});

test("custom coding and generic executor dispatch use their structure and discover once", async () => {
  const { pi, rpc, calls, tools } = harness(); const discoveryCalls = []; const registrations = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents(...args) { discoveryCalls.push(args); return { agents: [{ name: "coder-alpha" }, { name: "executor" }] }; },
    titleRegistry: { prepare() {}, bindWorkflowRoot() {}, bindWorkflowLeaf() {}, remember() {} },
    registerAuthorizedRun: authorizationRegistrar(registrations),
  });
  const ctx = { cwd: "/repo" };
  const coding = await tools[0].execute("custom-coding", { ...codingContract, agent: "coder-alpha", execution: { ...codingContract.execution, worktree: false } }, undefined, undefined, ctx);
  const generic = await tools[0].execute("generic-executor", { agent: "executor", title: "Review", task: "Inspect." }, undefined, undefined, ctx);
  assert.equal(coding.isError, false, coding.content[0]?.text);
  assert.equal(generic.isError, false, generic.content[0]?.text);
  assert.equal(calls.length, 2);
  assert.deepEqual(discoveryCalls, [["/repo", "both", undefined], ["/repo", "both", undefined]]);
  assert.deepEqual(registrations.map(({ kind, binding, capabilities, goal }) => ({ kind, binding, capabilities, goal })), [{
    kind: "coding", binding: { runId: "leaf", asyncDir: "/tmp/leaf", sessionId: "/tmp/pi-sessions/lifecycle.jsonl", pid: 1, agentProfile: "coder-alpha" }, capabilities: ["root.subscribe"], goal: null,
  }]);
});

test("typed executor selects an available declared candidate and fails a terminal miss before spawn effects", async () => {
  const { pi, rpc, calls, tools } = harness(); let effects = 0; const registrations = []; const discoveryCalls = [];
  rpc.ping = async () => { effects += 1; return { version: 1, methods: ["spawn"], session: { sessionId: "lifecycle-session", sessionFile: "/tmp/pi-sessions/lifecycle.jsonl", cwd: "/repo" } }; };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents(...args) {
      discoveryCalls.push(args);
      return { agents: [{ name: "executor", models: ["codex-pool/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"] }] };
    },
    goalExecutorCoordinator: { prepareSpawn() { effects += 1; } },
    workspaceService: { ensureAllocated() { effects += 1; } },
    titleRegistry: {
      prepare() { effects += 1; },
      bindWorkflowRoot() {},
      bindWorkflowLeaf() {},
      remember() {},
    },
    registerAuthorizedRun: authorizationRegistrar(registrations),
  });
  const available = await tools[0].execute("available-executor", { ...codingContract, model: "gpt-5.6-luna", execution: { ...codingContract.execution, worktree: false } }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "openai-codex", id: "gpt-5.6-luna" }]; } },
  });
  assert.equal(available.isError, false, available.content[0]?.text);
  assert.equal(JSON.parse(calls[0].workflowScript.match(/, (.*)\);$/)[1]).model, "openai-codex/gpt-5.6-luna");
  assert.deepEqual(registrations.map(({ kind, binding, capabilities, goal }) => ({ kind, binding, capabilities, goal })), [{
    kind: "coding", binding: { runId: "leaf", asyncDir: "/tmp/leaf", sessionId: "/tmp/pi-sessions/lifecycle.jsonl", pid: 1, agentProfile: "executor" }, capabilities: ["root.subscribe"], goal: null,
  }]);

  effects = 0; calls.length = 0;
  const miss = await tools[0].execute("unavailable-executor", { ...codingContract, model: "gpt-5.6-luna" }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "global-only", id: "gpt-5.6-luna" }]; } },
  });
  assert.equal(miss.details.code, "MODEL_NOT_AVAILABLE");
  assert.equal(effects, 0); assert.equal(calls.length, 0);
  assert.deepEqual(discoveryCalls, [["/repo", "both", undefined], ["/repo", "both", undefined]]);
});

test("model discovery receives the current host model provider", async () => {
  const { pi, rpc, tools } = harness(); const discoveryCalls = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents(...args) { discoveryCalls.push(args); return { agents: [{ name: "reviewer", models: ["codex-pool/gpt-5.6-sol"] }] }; },
  });
  const result = await tools[0].execute("provider", { agent: "reviewer", title: "Review", task: "Inspect.", model: "gpt-5.6-sol" }, undefined, undefined, {
    cwd: "/repo",
    model: { provider: "codex-pool", id: "parent" },
    modelRegistry: { getAvailable() { return [{ provider: "codex-pool", id: "gpt-5.6-sol" }]; } },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(discoveryCalls, [["/repo", "both", "codex-pool"]]);
  assert.equal(Object.hasOwn(result.details, "warnings"), false);
});
