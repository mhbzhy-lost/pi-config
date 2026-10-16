import assert from "node:assert/strict";
import test from "node:test";

import { createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

// Bug docs/bugs/2026-09-29-authority-lock-contention-orphan-spawn.md 修复面③（RED 3）：
// spawn 成功后的注册/onBinding 失败必须对已 spawn 的 root/leaf 发起尽力 stop 回滚，
// 消除孤儿 run 与重派副本并行重复执行（现场：leaf 2bb5e33f 与重派 c3e551ca 并行，浪费 417k tokens）。
// 失败注入 code 用 authority_store_unavailable（修复面②引入的 authority_lock_contention
// 重试后仍失败的场景在语义上等价于这里的最终失败）。

// S4：按工具名解析注册面，不以 tools 数组位置为权威。
function startTool(host) {
  const found = (host.tools ?? []).find((tool) => tool?.name === "subagent_start");
  if (!found) throw new Error("subagent_start must be registered");
  return found;
}

function createPi() {
  const tools = [];
  const handlers = new Map();
  const eventListeners = [];
  const events = {
    on(name, handler) {
      eventListeners.push({ name, handler });
      return () => {
        const index = eventListeners.findIndex((entry) => entry.name === name && entry.handler === handler);
        if (index >= 0) eventListeners.splice(index, 1);
      };
    },
    emit(name, payload) {
      for (const entry of [...eventListeners]) {
        if (entry.name === name) entry.handler(payload);
      }
    },
  };
  return {
    tools,
    handlers,
    events,
    registerTool(tool) { tools.push(tool); },
    on(name, handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    getAllTools() { return [...tools]; },
  };
}

function createRpc(overrides = {}) {
  const calls = [];
  let disposed = 0;
  const rpc = {
    calls,
    async ping() {
      calls.push({ method: "ping", params: {} });
      return {
        version: 1,
        methods: ["ping", "spawn", "status", "steer", "interrupt", "stop"],
        session: { sessionId: "session-1", sessionFile: "session-1", cwd: "/repo" },
      };
    },
    async spawn(params) {
      calls.push({ method: "spawn", params });
      return { text: "spawned", details: { runId: "run-1", asyncDir: "/tmp/run-1" } };
    },
    async status(params) { calls.push({ method: "status", params }); return { text: "status" }; },
    async steer(params) { calls.push({ method: "steer", params }); return { text: "steered" }; },
    async interrupt(params) { calls.push({ method: "interrupt", params }); return { text: "interrupted" }; },
    async resume(params) { calls.push({ method: "resume", params }); return { text: "resumed" }; },
    async stop(params) { calls.push({ method: "stop", params }); return { text: "stopped" }; },
    dispose() { disposed += 1; },
    disposed: () => disposed,
    ...overrides,
  };
  return rpc;
}

// spawn 成功（root reply 返回、leaf async-started 事件送达）的 harness；
// leaf 通过 queueMicrotask 在 root reply 后立刻启动，复刻现场时序：
// spawn 全部成功之后增强层注册才失败。
function leafSpawningRpc(pi, { rootRunId, leafRunId, leafAsyncDir }, overrides = {}) {
  return createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      const [workflowKey, leaf] = JSON.parse(`[${params.script.match(/^return await runs\.run\((.*)\);$/s)[1]}]`);
      queueMicrotask(() => pi.events.emit("subagent:async-started", {
        parentWorkflowRunId: rootRunId,
        workflowKey,
        runId: leafRunId,
        asyncDir: leafAsyncDir,
        sessionId: "session-1",
        pid: 4321,
        agent: leaf.agent,
      }));
      return { details: { runId: rootRunId, asyncDir: `/tmp/${rootRunId}` } };
    },
    ...overrides,
  });
}

function authorityStoreUnavailable() {
  return Object.assign(new Error("authority_store_unavailable: authority_store_unavailable"), {
    code: "authority_store_unavailable",
  });
}

function discoverAgents() {
  return { agents: [{ name: "executor" }] };
}

async function execute(tool, params, context = { cwd: "/repo" }) {
  return tool.execute("tool-call-1", params, undefined, undefined, context);
}

function codingContract(overrides = {}) {
  const base = {
    title: "Probe the spawn failure rollback", agent: "executor",
    task: "Spawn must roll back spawned runs when post-spawn registration fails.",
    writePaths: ["packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts"],
    acceptance: { criteria: ["Failed dispatches stop their spawned runs."] },
    worktree: false,
  };
  return { ...base, ...overrides, acceptance: { ...base.acceptance, ...overrides.acceptance } };
}
function managedReceipt(overrides = {}) {
  return {
    schemaVersion: "managed-workspace.v2",
    workspaceId: "workspace-1",
    leaseId: "c".repeat(64),
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: "/repo",
    requestedCwd: "/repo",
    originRef: "refs/heads/main",
    baseCommit: "b".repeat(40),
    path: "/managed/workspace-1",
    dispatchCwd: "/managed/workspace-1",
    branchRef: "refs/heads/pi-managed/workspace-1",
    state: "active",
    run: null,
    cleanupDebt: null,
    policy: { publication: "allowed", application: "allowed", writePaths: ["allowed.txt"] },
    publishedArtifact: null,
    application: null,
    terminalProof: null,
    ...overrides,
  };
}

function stoppedRunIds(rpc) {
  return rpc.calls.filter((call) => call.method === "stop").map((call) => call.params?.runId).sort();
}

test("generic dispatch：spawn 成功后注册失败对已 spawn 的 root/leaf 发起尽力 stop", async () => {
  const pi = createPi();
  const rpc = leafSpawningRpc(pi, { rootRunId: "workflow-rollback-1", leafRunId: "leaf-orphan-1", leafAsyncDir: "/tmp/leaf-orphan-1" });
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents,
    async registerAuthorizedRun() { throw authorityStoreUnavailable(); },
  });

  const result = await execute(startTool(pi), {
    agent: "executor",
    title: "Rollback probe",
    task: "Probe the spawn failure rollback.",
  });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "authority_store_unavailable");
  assert.deepEqual(
    stoppedRunIds(rpc),
    ["leaf-orphan-1", "workflow-rollback-1"],
    "注册失败必须对已 spawn 的 leaf 与 workflow root 发起 stop（bug 记录 RED 3：当前实现失败路径无任何 stop）",
  );
});

test("尽力语义：stop 失败仅记日志，不影响原失败错误上抛", async () => {
  const pi = createPi();
  const rpc = leafSpawningRpc(
    pi,
    { rootRunId: "workflow-rollback-2", leafRunId: "leaf-orphan-2", leafAsyncDir: "/tmp/leaf-orphan-2" },
    {
      async stop(params) {
        this.calls.push({ method: "stop", params });
        throw new Error("stop channel unavailable");
      },
    },
  );
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents,
    async registerAuthorizedRun() { throw authorityStoreUnavailable(); },
  });

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.map((value) => String(value)).join(" ")); };
  let result;
  try {
    result = await execute(startTool(pi), {
      agent: "executor",
      title: "Best-effort probe",
      task: "Probe that stop failure never masks the dispatch error.",
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "authority_store_unavailable", "stop 失败不得掩盖原注册失败错误");
  assert.ok(
    rpc.calls.some((call) => call.method === "stop" && call.params?.runId === "leaf-orphan-2"),
    "尽力回滚必须实际尝试 stop",
  );
  assert.ok(
    logged.some((line) => line.includes("leaf-orphan-2") && /rollback stop/i.test(line)),
    "stop 失败必须留下尽力回滚日志",
  );
});

test("generic dispatch：onBinding 同步抛错时对已 spawn 的 root/leaf 发起尽力 stop", async () => {
  const pi = createPi();
  const rpc = leafSpawningRpc(pi, { rootRunId: "workflow-sync-1", leafRunId: "leaf-sync-1", leafAsyncDir: "/tmp/leaf-sync-1" });
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents,
    registerAuthorizedRun() { throw authorityStoreUnavailable(); },
  });

  const result = await execute(startTool(pi), {
    agent: "executor",
    title: "Sync throw probe",
    task: "Probe the synchronous onBinding failure rollback.",
  });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "authority_store_unavailable");
  assert.deepEqual(stoppedRunIds(rpc), ["leaf-sync-1", "workflow-sync-1"]);
});

test("leaf 启动等待超时时对已 spawn 的 workflow root 发起尽力 stop", async () => {
  const pi = createPi();
  const rpc = createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      return { details: { runId: "workflow-timeout-1", asyncDir: "/tmp/workflow-timeout-1" } };
    },
  });
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    workflowChildStartTimeoutMs: 10,
    discoverAgents,
    registerAuthorizedRun() {},
  });

  const result = await execute(startTool(pi), {
    agent: "executor",
    title: "Timeout rollback probe",
    task: "Probe the leaf-wait timeout rollback.",
  });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "WORKFLOW_CHILD_START_TIMEOUT");
  assert.deepEqual(stoppedRunIds(rpc), ["workflow-timeout-1"],
    "leaf 等待超时必须 stop 已 spawn 的 workflow root，避免迟到 leaf 成为孤儿");
});

test("coding managed workspace：注册失败回滚已 spawn 的 root/leaf，原错误保留", async () => {
  const pi = createPi();
  const rpc = leafSpawningRpc(pi, { rootRunId: "workflow-coding-1", leafRunId: "leaf-coding-1", leafAsyncDir: "/tmp/leaf-coding-1" });
  const workspaceService = {
    ensureAllocated(request) {
      return managedReceipt({ workspaceId: request.workspaceId, owner: request.owner, run: null });
    },
    bindRun() { throw new Error("must not bind after grant failure"); },
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "coding-rollback",
    workspaceService,
    resolveRootSessionId: () => "root-1",
    resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    discoverAgents,
    resolveRootSessionId: () => "root-1",
    resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    async registerAuthorizedRun() { throw authorityStoreUnavailable(); },
  });

  const result = await execute(
    startTool(pi),
    codingContract({ worktree: true }),
    { cwd: "/repo", sessionManager: {} },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "authority_store_unavailable");
  assert.deepEqual(stoppedRunIds(rpc), ["leaf-coding-1", "workflow-coding-1"]);
});

test("成功路径零行为变化：注册成功后不发起任何 stop", async () => {
  const pi = createPi();
  const rpc = leafSpawningRpc(pi, { rootRunId: "workflow-success-1", leafRunId: "leaf-success-1", leafAsyncDir: "/tmp/leaf-success-1" });
  const registered = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    discoverAgents,
    async registerAuthorizedRun(authorization) { registered.push(authorization); },
  });

  const result = await execute(startTool(pi), {
    agent: "executor",
    title: "Success path probe",
    task: "Probe that successful dispatches never stop their runs.",
  });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal(registered.length, 1);
  assert.deepEqual(stoppedRunIds(rpc), [], "成功派发不得发起任何 stop");
});
