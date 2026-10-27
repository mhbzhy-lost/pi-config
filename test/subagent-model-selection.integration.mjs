import assert from "node:assert/strict";
import test from "node:test";

import { createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { registerBuiltinAgentsViaEvents } from "../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts";
import { assertRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

// 模型面按工具名解析；roster 已退役，内部 list 诊断不再由模型工具注册。
function operationTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `harness 未注册 ${name}`);
  return tool;
}

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
    async spawn(params) { calls.push(params); const [key, leaf] = params.script.match(/^return await runs\.run\(([^,]+), (.*)\);$/).slice(1); queueMicrotask(() => { for (const fn of listeners.get("subagent:async-started") ?? []) fn({ parentWorkflowRunId: "root", runId: "leaf", asyncDir: "/tmp/leaf", sessionId: "/tmp/pi-sessions/lifecycle.jsonl", pid: 1, agent: JSON.parse(leaf).agent, workflowKey: JSON.parse(key) }); }); return { details: { runId: "root", asyncDir: "/tmp/root" } }; },
    dispose() {},
  };
  return { pi, rpc, calls, tools };
}

const codingContract = {
  title: "Undiscovered executor", agent: "executor",
  task: "Prove discovery rejects before lifecycle effects. Do not spawn. Known facts: none. Decisions: none. Relevant files: none.",
  writePaths: ["test/subagent-model-selection.integration.mjs"],
  acceptance: { criteria: ["No effects occur."] }, cwd: "/repo", worktree: true,

};

test("real repository internal admission list exposes all three trusted profiles without registering roster or accessing RPC/registry", async () => {
  const { pi, rpc, tools } = harness();
  const admission = registerBuiltinAgentsViaEvents({ pi, agentDir: new URL("../pi/", import.meta.url).pathname });
  rpc.ping = async () => { throw new Error("list must not call RPC"); };
  const runtime = createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, discoverAgents: admission.discoverAgents });
  assert.equal(tools.some((tool) => tool.name === "subagent_roster"), false);
  const result = await runtime.tool.execute("real-list", { action: "list" }, undefined, undefined, {
    cwd: "/repo", modelRegistry: { getAvailable() { throw new Error("list must not call registry"); } },
  });
  try {
    assert.equal(result.isError, false);
    assert.deepEqual(result.details.agents.map((agent) => agent.name), ["delegate", "executor", "reviewer"]);
    assert.equal(result.details.agents.every((agent) => Object.hasOwn(agent, "description")), true);
    assert.equal(result.details.agents.some((agent) => Object.hasOwn(agent, "filePath")), false);
  } finally { admission.dispose(); }
});

test("internal repository admission list preserves diagnostic metadata without registering roster or accessing RPC/registry", async () => {
  const { pi, rpc, tools } = harness();
  let calls = 0;
  rpc.ping = async () => { throw new Error("list must not call RPC"); };
  const runtime = createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() {
      calls += 1;
      return { admission: "repository-configured", agents: [
        { name: "delegate", description: "Delegate", models: ["pool/astra"] },
        { name: "executor", description: "Executor", tools: ["read"] },
        { name: "reviewer", description: "Reviewer", model: "pool/sol", tools: ["read", "grep"] },
      ] };
    },
  });
  assert.equal(tools.some((tool) => tool.name === "subagent_roster"), false);
  const result = await runtime.tool.execute("list", { action: "list" }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { throw new Error("list must not call registry"); } },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.agents, [
    { name: "delegate", description: "Delegate", model: null, models: ["pool/astra"], tools: null },
    { name: "executor", description: "Executor", model: null, models: [], tools: ["read"] },
    { name: "reviewer", description: "Reviewer", model: "pool/sol", models: [], tools: ["read", "grep"] },
  ]);
  assert.equal(calls, 1);
});

test("profile omission selects first currently available candidate in generic leaf", async () => {
  const { pi, rpc, calls, tools } = harness();
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() { return { admission: "repository-configured", agents: [{ name: "reviewer", models: ["pool/astra", "direct/astra", "pool/sol"] }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("profile-default", { agent: "reviewer", title: "Review", task: "Inspect." }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [
      { provider: "pool", id: "sol", api: "openai-completions" },
      { provider: "pool", id: "astra", api: "openai-completions" },
    ]; } },
  });
  const leaf = JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]);
  assert.equal(leaf.model, "pool/astra");
  assert.deepEqual(result.details.modelSelection, { source: "agent-default", resolvedModel: "pool/astra" });
  assert.equal(Object.hasOwn(result.details.modelSelection, "requestedModel"), false);
});

test("profile omission selects first currently available candidate in coding leaf", async () => {
  const { pi, rpc, calls, tools } = harness();
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() { return { admission: "repository-configured", agents: [{ name: "reviewer", models: ["pool/astra", "pool/sol"] }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("coding-profile-default", {
    title: "Review", agent: "reviewer", task: "Inspect.",
    writePaths: ["test/subagent-model-selection.integration.mjs"],
    acceptance: { criteria: ["Inspect the dispatch contract."] },
  }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "pool", id: "astra", api: "openai-completions" }]; } },
  });
  assert.equal(result.isError, false, result.content[0]?.text);
  const leaf = JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]);
  assert.equal(leaf.model, "pool/astra");
  assert.deepEqual(result.details.modelSelection, { source: "agent-default", resolvedModel: "pool/astra" });
});

for (const kind of ["generic", "coding"]) {
  const input = {
    agent: "reviewer", title: "Review", task: "Inspect.",
    ...(kind === "coding" ? { writePaths: ["test/subagent-model-selection.integration.mjs"], acceptance: { criteria: ["Inspect the dispatch contract."] } } : {}),
  };

test(`F1 ${kind} 首缺时 leaf 选择次位候选并报告 agent-default`, async () => {
  const { pi, rpc, calls, tools } = harness();
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {},
    discoverAgents() { return { admission: "repository-configured", agents: [{ name: "reviewer", models: ["pool/first", "pool/second"] }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("profile-second", input, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "pool", id: "second", api: "openai-completions" }]; } },
  });
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal(JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]).model, "pool/second");
  assert.deepEqual(result.details.modelSelection, { source: "agent-default", resolvedModel: "pool/second" });
});

test(`F1 ${kind} 候选全缺在 RPC、workspace、title 副作用前失败`, async () => {
  const { pi, rpc, calls, tools } = harness();
  const effects = [];
  rpc.ping = async () => { effects.push("ping"); throw new Error("不能访问 RPC"); };
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {},
    workspaceService: { ensureAllocated() { effects.push("workspace"); throw new Error("不能分配 workspace"); } },
    titleRegistry: { prepare() { effects.push("title"); } },
    discoverAgents() { return { admission: "repository-configured", agents: [{ name: "reviewer", models: ["pool/first", "pool/second"] }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("profile-none", { ...input, worktree: true }, undefined, undefined, {
    cwd: "/repo", modelRegistry: { getAvailable() { return []; } },
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "MODEL_NOT_AVAILABLE");
  assert.equal(calls.length, 0);
  assert.deepEqual(effects, []);
});

test(`F1 ${kind} 无 profile 不访问 registry 且 leaf 省略 model`, async () => {
  const { pi, rpc, calls, tools } = harness();
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, discoverAgents() { return { admission: "repository-configured", agents: [{ name: "reviewer" }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("profile-absent", input, undefined, undefined, { cwd: "/repo", modelRegistry: { getAvailable() { throw new Error("无 profile 不应访问 registry"); } } });
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal(Object.hasOwn(JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]), "model"), false);
  assert.deepEqual(result.details.modelSelection, { source: "default" });
});

test(`F1 ${kind} explicit model 优先于 profile 默认首位`, async () => {
  const { pi, rpc, calls, tools } = harness();
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, discoverAgents() { return { admission: "repository-configured", agents: [{ name: "reviewer", models: ["pool/first", "pool/second"] }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("profile-explicit", { ...input, model: "pool/second" }, undefined, undefined, {
    cwd: "/repo", modelRegistry: { getAvailable() { return [{ provider: "pool", id: "first", api: "openai-completions" }, { provider: "pool", id: "second", api: "openai-completions" }]; } },
  });
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal(JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]).model, "pool/second");
  assert.deepEqual(result.details.modelSelection, { source: "qualified", requestedModel: "pool/second", resolvedModel: "pool/second" });
});

test(`F1 ${kind} 启动错误只报告失败，不换模再次 spawn`, async () => {
  const { pi, rpc, calls, tools } = harness();
  let spawnCount = 0;
  rpc.spawn = async (params) => { calls.push(params); spawnCount += 1; throw Object.assign(new Error("provider error"), { code: "PROVIDER_ERROR" }); };
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, discoverAgents() { return { admission: "repository-configured", agents: [{ name: "reviewer", models: ["pool/first", "pool/second"] }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("provider-error", input, undefined, undefined, {
    cwd: "/repo", modelRegistry: { getAvailable() { return [{ provider: "pool", id: "first", api: "openai-completions" }, { provider: "pool", id: "second", api: "openai-completions" }]; } },
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "PROVIDER_ERROR");
  assert.equal(spawnCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]).model, "pool/first");
});
}

test("profile omission preserves zero-spawn failure for virtual candidates", async () => {
  const { pi, rpc, calls, tools } = harness();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, discoverAgents: () => ({ admission: "repository-configured", agents: [{ name: "reviewer", models: ["fixture/virtual"] }] }) });
  const result = await operationTool(tools, "subagent_start").execute("profile-virtual", { agent: "reviewer", title: "Review", task: "Inspect." }, undefined, undefined, {
    cwd: "/repo", modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "virtual", api: "pi-virtual" }] },
  });
  assert.equal(result.details.code, "VIRTUAL_MODEL_UNSUPPORTED_BY_DISPATCH");
  assert.equal(calls.length, 0);
});

test("generic bare model uses sorted global catalog warning and normalized request separates workspace hashes", async () => {
  const { pi, rpc, calls, tools } = harness(); const requests = []; const registrations = [];
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, randomUUID: () => `workspace-${requests.length + 1}`,
    discoverAgents() { return { agents: [{ name: "reviewer" }] }; },
    workspaceService: { ensureAllocated(request) { requests.push(request); return { workspaceId: request.workspaceId, leaseId: "a".repeat(64), state: "active", dispatchCwd: "/managed" }; }, async bindRun({ run }) { return { workspaceId: "workspace", leaseId: "a".repeat(64), state: "active", dispatchCwd: "/managed", run }; } },
    resolveRootSessionId: () => "root-session", resolveCanonicalOrigin: async () => "/repo", inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }), registerAuthorizedRun: authorizationRegistrar(registrations),
  });
  const ctx = { cwd: "/repo", sessionManager: {}, modelRegistry: { getAvailable() { return [{ provider: "openai", id: "gpt-5.6-sol", api: "openai-completions" }, { provider: "codex-pool", id: "gpt-5.6-sol", api: "openai-completions" }, { provider: "codex-pool", id: "gpt-5.6-luna", api: "openai-completions" }]; } } };
  const result = await operationTool(tools, "subagent_start").execute("generic", { agent: "reviewer", title: "Review", task: "Inspect.", model: " gpt-5.6-sol ", worktree: true }, undefined, undefined, ctx);
  assert.equal(result.isError, false); assert.match(result.content[0].text, /Warning: requested model gpt-5\.6-sol matched codex-pool\/gpt-5\.6-sol/);
  assert.deepEqual(result.details.modelSelection, { requestedModel: "gpt-5.6-sol", resolvedModel: "codex-pool/gpt-5.6-sol", source: "global-catalog" });
  assert.deepEqual(result.details.warnings, [{ code: "MODEL_MATCH_USED_GLOBAL_CATALOG", agent: "reviewer", requestedModel: "gpt-5.6-sol", resolvedModel: "codex-pool/gpt-5.6-sol" }]);
  assert.equal(JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]).model, "codex-pool/gpt-5.6-sol");
  const second = await operationTool(tools, "subagent_start").execute("generic-qualified", { agent: "reviewer", title: "Review", task: "Inspect.", model: "codex-pool/gpt-5.6-sol", worktree: true }, undefined, undefined, ctx);
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
  const result = await operationTool(tools, "subagent_start").execute("miss", { agent: "reviewer", title: "Review", task: "Inspect.", model: "missing", worktree: true }, undefined, undefined, ctx);
  const undiscovered = await operationTool(tools, "subagent_start").execute("undiscovered", { agent: "absent", title: "Absent", task: "Inspect.", model: "missing", worktree: true }, undefined, undefined, ctx);
  const undiscoveredDefault = await operationTool(tools, "subagent_start").execute("undiscovered-default", { agent: "absent", title: "Absent", task: "Inspect.", worktree: true }, undefined, undefined, ctx);
  assert.equal(result.details.code, "MODEL_NOT_AVAILABLE");
  assert.equal(undiscovered.details.code, "UNKNOWN_AGENT");
  assert.equal(undiscoveredDefault.details.code, "UNKNOWN_AGENT");
  assert.equal(effects, 0); assert.equal(calls.length, 0);
});

test("repository admission rejection preserves AGENT_ADMISSION_UNAVAILABLE before spawn effects", async () => {
  const { pi, rpc, calls, tools } = harness(); let effects = 0;
  rpc.ping = async () => { effects += 1; return {}; };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() { return { admission: "repository-configured", agents: [{ name: "delegate" }, { name: "executor" }, { name: "reviewer" }] }; },
    workspaceService: { ensureAllocated() { effects += 1; } },
    titleRegistry: { prepare() { effects += 1; } },
  });
  const result = await operationTool(tools, "subagent_start").execute("probe-worker", { agent: "probe-worker", title: "Probe", task: "Reject." }, undefined, undefined, { cwd: "/repo", modelRegistry: { getAvailable() { return []; } } });
  assert.equal(result.details.code, "AGENT_ADMISSION_UNAVAILABLE");
  assert.match(result.content[0].text, /AGENT_ADMISSION_UNAVAILABLE/);
  assert.equal(effects, 0); assert.equal(calls.length, 0);
});

test("undiscovered coding profile fails before workspace, RPC, and title effects without a model", async () => {
  const { pi, rpc, calls, tools } = harness(); const preflight = []; let effects = 0;
  rpc.ping = async () => { effects += 1; return {}; };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents() { return { agents: [] }; },
    // Goal 契约预检是有意先于模型发现/准入执行的设计（extension.ts "production
    // contract preflight" 注释）；单独计数以区分 spawn 侧副作用。
    goalExecutorCoordinator: { prepareSpawn() { preflight.push("goal"); return undefined; } },
    workspaceService: { ensureAllocated() { effects += 1; } },
    titleRegistry: { prepare() { effects += 1; } },
  });
  const result = await operationTool(tools, "subagent_start").execute("undiscovered-coder", { ...codingContract, agent: "coder-alpha" }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "codex-pool", id: "gpt-5.6-sol", api: "openai-completions" }]; } },
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
  const coding = await operationTool(tools, "subagent_start").execute("custom-coding", { ...codingContract, agent: "coder-alpha", worktree: false }, undefined, undefined, ctx);
  const generic = await operationTool(tools, "subagent_start").execute("generic-executor", { agent: "executor", title: "Review", task: "Inspect." }, undefined, undefined, ctx);
  assert.equal(coding.isError, false, coding.content[0]?.text);
  assert.equal(generic.isError, false, generic.content[0]?.text);
  assert.equal(calls.length, 2);
  assert.deepEqual(discoveryCalls, [["/repo", "both", undefined], ["/repo", "both", undefined]]);
  // coding 派发（worktree:false）不经 workspace/grant 路径，不注册 authority（基线
  // dff0da9 解耦代理名称与运行授权以来的有意语义，生产 7a2f7322 同样不注册）；
  // 只有 generic 派发经 onBinding 注册。
  assert.deepEqual(registrations.map(({ kind, binding, capabilities, goal }) => ({ kind, binding, capabilities, goal })), [{
    kind: "generic", binding: { runId: "leaf", asyncDir: "/tmp/leaf", sessionId: "/tmp/pi-sessions/lifecycle.jsonl", pid: 1, agentProfile: "executor" }, capabilities: [], goal: null,
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
  const available = await operationTool(tools, "subagent_start").execute("available-executor", { ...codingContract, model: "gpt-5.6-luna", worktree: false }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-completions" }]; } },
  });
  assert.equal(available.isError, false, available.content[0]?.text);
  assert.equal(JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]).model, "openai-codex/gpt-5.6-luna");
  // coding 派发（worktree:false）不经 workspace/grant 路径，不注册 authority。

  assert.deepEqual(registrations, []);

  effects = 0; calls.length = 0;
  const miss = await operationTool(tools, "subagent_start").execute("unavailable-executor", { ...codingContract, model: "gpt-5.6-luna" }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "global-only", id: "gpt-5.6-luna", api: "openai-completions" }]; } },
  });
  assert.equal(miss.details.code, "MODEL_NOT_AVAILABLE");
  // Goal 契约预检有意先于模型发现（见首个用例注释）：miss 路径只触发 preflight，
  // 无 workspace/RPC/title 副作用。

  assert.equal(effects, 1); assert.equal(calls.length, 0);
  assert.deepEqual(discoveryCalls, [["/repo", "both", undefined], ["/repo", "both", undefined]]);
});

test("model discovery receives the current host model provider", async () => {
  const { pi, rpc, tools } = harness(); const discoveryCalls = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents(...args) { discoveryCalls.push(args); return { agents: [{ name: "reviewer", models: ["codex-pool/gpt-5.6-sol"] }] }; },
  });
  const result = await operationTool(tools, "subagent_start").execute("provider", { agent: "reviewer", title: "Review", task: "Inspect.", model: "gpt-5.6-sol" }, undefined, undefined, {
    cwd: "/repo",
    model: { provider: "codex-pool", id: "parent", api: "openai-completions" },
    modelRegistry: { getAvailable() { return [{ provider: "codex-pool", id: "gpt-5.6-sol", api: "openai-completions" }]; } },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(discoveryCalls, [["/repo", "both", "codex-pool"]]);
  assert.equal(Object.hasOwn(result.details, "warnings"), false);
});

test("provider blacklist rejects deepseek before workspace and RPC side effects", async () => {
  const { pi, rpc, calls, tools } = harness();
  let effects = 0;
  rpc.ping = async () => { effects += 1; return {}; };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    providerBlacklist: ["deepseek"],
    discoverAgents() { return { agents: [{ name: "executor", models: ["deepseek/deepseek-v4-pro"] }] }; },
    workspaceService: { ensureAllocated() { effects += 1; } },
  });
  const result = await operationTool(tools, "subagent_start").execute("blocked-provider", {
    ...codingContract,
    model: "deepseek/deepseek-v4-pro",
  }, undefined, undefined, {
    cwd: "/repo",
    modelRegistry: { getAvailable() { return [{ provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions" }]; } },
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "MODEL_NOT_AVAILABLE");
  assert.equal(effects, 0);
  assert.equal(calls.length, 0);
});
