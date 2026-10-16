import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const runtimeJiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const {
  createSubagentToolRenderers,
  projectManagedWorkspaceTerminalProof,
} = await runtimeJiti.import("../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");

import { createHeadlessSubagentApi } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts";
import { createTitleRegistry } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts";
import { createSupervisorAdapter } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts";
import { createSupervisorControlPlane, supervisorCanonicalDigest } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts";
import {
  createSupervisorRequestMailbox,
  createSubagentDispatchTraceFileSink,
  createTypedSubagentExtension as createTypedSubagentExtensionProduction,
  installHeadlessTypedSubagentRuntime as installHeadlessTypedSubagentRuntimeProduction,
  TYPED_SUBAGENT_DESCRIPTION,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const enhancedPackageRoot = join(repoRoot, "packages/pi-subagents-enhanced");

function createTypedSubagentExtension(pi, options = {}) {
  return createTypedSubagentExtensionProduction(pi, {
    registerAuthorizedRun() {},
    discoverAgents() { return { agents: [{ name: "executor" }, { name: "reviewer" }] }; },
    ...options,
  });
}

function installHeadlessTypedSubagentRuntime(pi, options = {}) {
  return installHeadlessTypedSubagentRuntimeProduction(pi, {
    discoverAgents() { return { agents: [{ name: "executor" }, { name: "reviewer" }] }; },
    ...options,
  });
}

function executionProofV2Snapshot(overrides = {}) {
  return {
    schemaVersion: "root-broker.execution-proof.v2",
    binding: { rootSessionId: "root-1", runId: "leaf-run", asyncDir: "/tmp/async", sessionId: "s", pid: 42, agentProfile: "executor" },
    authorization: { state: "verified" },
    capabilities: ["root.subscribe"],
    terminal: {
      proofId: "d".repeat(64),
      observedAt: 1,
      outcome: "succeeded",
      proof: { version: 1, runId: "leaf-run", runnerProcessInstanceId: "pi-1", instances: [] },
    },
    terminalConflict: false,
    ...overrides,
  };
}

test("workspace terminal proof adapter returns pending without a bound run or observed terminal", () => {
  assert.deepEqual(projectManagedWorkspaceTerminalProof(null, executionProofV2Snapshot()), { state: "pending" });
  assert.deepEqual(projectManagedWorkspaceTerminalProof({ runId: "leaf-run" }, null), { state: "pending" });
  assert.deepEqual(projectManagedWorkspaceTerminalProof(
    { runId: "leaf-run" },
    executionProofV2Snapshot({ terminal: null }),
  ), { state: "pending" });
});

test("workspace terminal proof adapter projects execution-proof.v2 snapshots to the v2 seven-field codec", () => {
  // v2 ledger 的 proof 校验要求 {state,conflict,runId,rootSessionId,asyncDir,processInstance,proofId}；
  // 投影曾输出 v1 三字段（proofHash 伪装 proofId），使 v2 workspace 终结后 subagent_worktree status 报 MANAGED_WORKSPACE_TERMINAL。
  const snapshot = executionProofV2Snapshot({ terminal: { proofId: "a".repeat(64), observedAt: 1, outcome: "succeeded", proof: { version: 1, runId: "leaf-run", runnerProcessInstanceId: "pi-1", instances: [] } } });
  assert.deepEqual(projectManagedWorkspaceTerminalProof({ runId: "leaf-run" }, snapshot), {
    state: "observed",
    conflict: false,
    runId: "leaf-run",
    rootSessionId: "root-1",
    asyncDir: "/tmp/async",
    processInstance: "pi-1",
    proofId: "a".repeat(64),
  });
});

test("workspace terminal proof adapter preserves an observed broker conflict", () => {
  const snapshot = executionProofV2Snapshot({ terminalConflict: true });
  assert.deepEqual(
    projectManagedWorkspaceTerminalProof({ runId: "leaf-run" }, snapshot),
    {
      state: "observed",
      conflict: true,
      runId: "leaf-run",
      rootSessionId: "root-1",
      asyncDir: "/tmp/async",
      processInstance: "pi-1",
      proofId: "d".repeat(64),
    },
  );
});

test("workspace terminal proof adapter rejects malformed snapshots and the removed v1 facade shape", () => {
  assert.throws(
    () => projectManagedWorkspaceTerminalProof(
      { runId: "leaf-run" },
      executionProofV2Snapshot({ terminalConflict: undefined, terminal: { proofId: "not-a-proof-hash", observedAt: 1, outcome: "succeeded", proof: { version: 1, runId: "leaf-run", instances: [] } } }),
    ),
    (error) => error?.code === "MANAGED_WORKSPACE_TERMINAL_PROOF_ADAPTER"
      && error.message === "observed facade terminal proof is invalid",
  );
  // v1 三字段 facade 形态已随 v1 全删：非 v2 envelope 的 snapshot 必须 fail closed。
  assert.throws(
    () => projectManagedWorkspaceTerminalProof({ runId: "leaf-run" }, { runId: "leaf-run", state: "observed", conflict: false, proofHash: "d".repeat(64), proof: null }),
    (error) => error?.code === "MANAGED_WORKSPACE_TERMINAL_PROOF_ADAPTER",
  );
});

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:mjs|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("the enhanced package runtime closes every relative implementation import inside a copied package", async (t) => {
  const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-subagents-enhanced-closure-"));
  t.after(() => rm(isolatedRoot, { recursive: true, force: true }));
  for (const entry of ["package.json", "extensions", "child-extensions", "scripts", "src"]) {
    await cp(join(enhancedPackageRoot, entry), join(isolatedRoot, entry), { recursive: true });
  }
  await mkdir(join(isolatedRoot, "node_modules"), { recursive: true });
  await cp(
    join(enhancedPackageRoot, "node_modules/pi-subagents"),
    join(isolatedRoot, "node_modules/pi-subagents"),
    { recursive: true },
  );

  const implementationRoots = ["extensions", "child-extensions", "scripts", "src"];
  const files = (await Promise.all(implementationRoots.map((entry) => sourceFiles(join(isolatedRoot, entry))))).flat();
  const edges = [];
  const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+(?:type\s+)?|\bnew URL\s*\(\s*)["']([^"']+)["']/g;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = new URL(specifier, pathToFileURL(file));
      const targetPath = decodeURIComponent(target.pathname);
      const targetRelative = relative(isolatedRoot, targetPath);
      assert.equal(targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative), false, `${relative(isolatedRoot, file)} escapes through ${specifier}`);
      await stat(targetPath);
      edges.push({ source: relative(isolatedRoot, file), specifier, target: targetRelative });
    }
  }
  const isolatedExtension = await import(`${pathToFileURL(join(isolatedRoot, "src/subagent-dispatch/extension.ts")).href}?closure=${Date.now()}`);
  const isolatedOwner = await import(`${pathToFileURL(join(isolatedRoot, "child-extensions/root-session-owner.ts")).href}?closure=${Date.now()}`);
  const isolatedEvidence = await import(`${pathToFileURL(join(isolatedRoot, "child-extensions/acceptance-evidence.ts")).href}?closure=${Date.now()}`);
  const packageEntry = await runtimeJiti.import("../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
  assert.equal(typeof isolatedExtension.createTypedSubagentExtension, "function");
  assert.equal(typeof isolatedOwner.installRootSessionOwner, "function");
  assert.equal(typeof isolatedEvidence.installAcceptanceEvidence, "function");
  assert.equal(typeof packageEntry.default, "function");
});

function codingContract(overrides = {}) {
  const base = {
    title: "Install the typed subagent runtime",
    agent: "executor",
    task: "Expose only the project-owned typed subagent facade. Compile a deterministic initial child prompt. Known fact: pi-subagents is an implementation dependency. Decision: all execution crosses RPC v1. Do not expose upstream package resources.",
    writePaths: ["pi/extensions/subagent-runtime.ts", "test/subagent-runtime-membrane.test.mjs"],
    acceptance: { criteria: ["The main Agent sees only the project-owned facade."] },
  };
  return { ...base, ...overrides, acceptance: { ...base.acceptance, ...overrides.acceptance } };
}

test("v2 routing selects coding by writePaths and rejects legacy version inputs", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "v2-leaf-run", runId: "v2-leaf-run", asyncDir: "/tmp/v2-leaf-run",
      sessionId: "session-1", agent: "executor", pid: 102,
      workflowKey: "typed-v2-routing", parentWorkflowRunId: "v2-workflow-root",
    });
    return { text: "spawned", details: { runId: "v2-workflow-root", asyncDir: "/tmp/v2-workflow-root" } };

  };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, randomUUID: () => "v2-routing" });
  const result = await execute(pi.tools[0], {
    agent: "executor",
    task: "Implement the feature",
    title: "Feature",
    writePaths: ["src/feature.ts"],
    acceptance: { criteria: ["tests pass"] },
  });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  const spawnCall = rpc.calls.find((call) => call.method === "spawn");
  assert.ok(spawnCall, "spawn was not called");
  const leafAgent = JSON.parse(spawnCall.params.script.match(/runs\.run\([^,]+, (.*)\);$/s)[1]).agent;
  assert.equal(leafAgent, "executor");
  const deprecated = await execute(pi.tools[0], { ...codingContract(), version: "dispatch-ir.v1" });
  assert.equal(deprecated.isError, true);
  assert.equal(deprecated.details.code, "DEPRECATED_SCHEMA");
});

function v2Contract(overrides = {}) {
  const base = {
    title: "Install the typed subagent runtime",
    agent: "executor",
    task: "Expose only the project-owned typed subagent facade.",
    writePaths: ["pi/extensions/subagent-runtime.ts"],
    acceptance: { criteria: ["The main Agent sees only the project-owned facade."] },
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
    run: { runId: "run-1", asyncDir: "/tmp/run-1" },
    cleanupDebt: null,
    policy: { publication: "allowed", application: "allowed", writePaths: ["pi/extensions/subagent-runtime.ts"] },
    publishedArtifact: null,
    application: null,
    terminalProof: null,
    ...overrides,
  };
}

function createPi() {
  const tools = [];
  const commands = [];
  const shortcuts = [];
  const providers = [];
  const messageRenderers = [];
  const entryRenderers = [];
  const handlers = new Map();
  const eventListeners = [];
  const messages = [];
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
    commands,
    shortcuts,
    providers,
    messageRenderers,
    entryRenderers,
    handlers,
    eventListeners,
    messages,
    events,
    sendMessage(message) { messages.push(message); },
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, definition) { commands.push({ name, definition }); },
    registerShortcut(name, definition) { shortcuts.push({ name, definition }); },
    registerProvider(name, definition) { providers.push({ name, definition }); },
    registerMessageRenderer(name, renderer) { messageRenderers.push({ name, renderer }); },
    registerEntryRenderer(name, renderer) { entryRenderers.push({ name, renderer }); },
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

test("production runtime wires no compat completion notifier; upstream native notify owns delivery", async () => {
  const entry = await readFile(join(enhancedPackageRoot, "extensions", "subagent-runtime.ts"), "utf8");
  const compat = await readFile(join(enhancedPackageRoot, "src", "compat", "pi-subagents-0.75.ts"), "utf8");
  // 用户决策：删除增强层 completion notifier 包装（asyncComplete→sendMessage 转发链），
  // 完成投递+ack 完全依赖上游 pi-subagents@0.71 原生 notify 语义。
  for (const wrapper of ["createCompletionNotifier", "subscribeAsyncComplete", "completionNotifierFactory", "initializeCompletionNotifierState"]) {
    assert.doesNotMatch(entry, new RegExp(wrapper), `${wrapper} wiring must not exist in the production runtime entry`);
    assert.doesNotMatch(compat, new RegExp(wrapper), `${wrapper} must not exist in the compat facade`);
  }
  // 上游原生 notify 仍发送 subagent-notify customType（notify.js sendCompletion），
  // 项目 renderer 保留以赢得 last-write 所有权。
  assert.match(entry, /registerMessageRenderer\("subagent-notify"/);
});

test("the designated completion notifier api delivers subagent-notify while the upstream bootstrap api keeps its suppression", async () => {
  // 具名不变式（docs/bugs/2026-09-29-async-completion-notification-silent-swallow.md 残留风险 1，
  // 2026-09-29 复核确认现状已满足）：completionNotifierFactory 注入点构造的 completionApi
  // 不得携带 suppressCompletionNotifications——suppression 只属于 upstream bootstrap api
  // （防上游 native 双投递），host 指定的投递者必须能投递。
  const pi = createPi();
  let upstreamApi;
  let factoryApi;
  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      upstreamApi = api;
      api.registerTool({ name: "subagent_supervisor", execute() {} });
    },
    completionNotifierFactory(api) {
      factoryApi = api;
      return { dispose() {} };
    },
    resolveSessionId(sessionManager) { return sessionManager.id; },
    rpc: createRpc(),
    cleanupStore: {},
  });
  assert.ok(upstreamApi, "the upstream bootstrap must receive the membrane api");
  assert.ok(factoryApi, "the designated notifier factory must receive the completion api");

  const notify = { customType: "subagent-notify", content: "Background task completed: **delegate**\n\nDone" };

  // upstream bootstrap api：suppression 原样有效（防上游 native 双投递的语义不变）。
  const upstreamSend = upstreamApi.sendMessage({ ...notify }, { triggerTurn: true });
  assert.equal(upstreamSend, undefined, "the upstream bootstrap api must keep suppressing subagent-notify");
  assert.equal(pi.messages.length, 0, "the suppressed upstream send must not reach the Host");

  // 不变式主体：designated notifier 收到的 api 发送 subagent-notify 直达真实 Host sendMessage。
  factoryApi.sendMessage({ ...notify }, { triggerTurn: true });
  assert.equal(pi.messages.filter((message) => message?.customType === "subagent-notify").length, 1,
    "the designated notifier's subagent-notify send must reach the real Host sendMessage");
  assert.equal(pi.messages[0].content, notify.content);

  // 检测力对照分支：同一 createHeadlessSubagentApi 构造若回归为携带
  // suppressCompletionNotifications（footgun 复发形态），等价发送被吞且无任何 Host 消息——
  // 若注入点的 completionApi 构造回归，上方不变式断言将以同一形态失败。
  const suppressedApi = createHeadlessSubagentApi(pi, { suppressCompletionNotifications: true });
  const swallowed = suppressedApi.sendMessage({ ...notify }, { triggerTurn: true });
  assert.equal(swallowed, undefined, "the suppression membrane primitive still swallows the equivalent send");
  assert.equal(pi.messages.filter((message) => message?.customType === "subagent-notify").length, 1,
    "the suppressed contrast send must add no Host message");
});

test("completion lifecycle events preserve the original authoritative payload and summary", () => {
  const pi = createPi();
  const api = createHeadlessSubagentApi(pi);
  const payload = {
    runId: "raw-completion",
    agent: "executor",
    state: "failed",
    success: false,
    summary: "Status: completed",
    acceptance: { status: "rejected" },
    error: "runtime error",
  };
  const before = structuredClone(payload);
  let observed;
  api.events.on("subagent:async-complete", (event) => { observed = event; });
  api.events.emit("subagent:async-complete", payload);
  assert.notStrictEqual(observed, payload, "presentation projection may clone the event for observers");
  assert.equal(observed.summary, payload.summary);
  assert.deepEqual(observed.acceptance, payload.acceptance);
  assert.equal(observed.error, payload.error);
  assert.deepEqual(payload, before);
});

const ctx = { cwd: "/repo" };
const signal = new AbortController().signal;

async function execute(tool, params, context = ctx) {
  return tool.execute("tool-call-1", params, signal, undefined, context);
}

test("the headless membrane decorates lifecycle events while completion messages pass through raw", () => {
  const emitted = [];
  const messages = [];
  const registry = {
    started(event) { return event.id === "run-1" ? "First task" : undefined; },
    completed(event) { return event.runId === "run-1" ? "First task" : undefined; },
    titleFor() { return undefined; },
    takeCompleted(agent) { return agent === "delegate" ? "First task" : undefined; },
  };
  const pi = {
    events: { emit(type, payload) { emitted.push({ type, payload }); }, on() {} },
    sendMessage(message) { messages.push(message); },
  };
  const api = createHeadlessSubagentApi(pi, { titleRegistry: registry });
  api.events.emit("subagent:async-started", { id: "run-1", agent: "delegate" });
  api.events.emit("subagent:async-complete", { runId: "run-1", agent: "delegate" });
  const notify = { customType: "subagent-notify", content: "Background task completed: **delegate**\n\nDone" };
  api.sendMessage(notify);

  assert.equal(emitted[0].payload.title, "First task");
  assert.equal(emitted[1].payload.title, "First task");
  // raw boundary：即使 registry 提供 takeCompleted 也不得被 send 路径消费，
  // message 原样传递（无 title suffix、无 details 注入）。
  assert.equal(messages[0], notify);
});

test("the production notification order suppresses the pre-event upstream message and renders after runId observation", () => {
  const visible = [];
  const listeners = new Map();
  const completionTitles = [];
  const registry = {
    started() { return undefined; },
    completed(event) {
      if (event.runId !== "run-1") return undefined;
      completionTitles.push({ agent: event.agent, title: "First task" });
      return "First task";
    },
    titleFor(runId) { return runId === "run-1" ? "First task" : undefined; },
    takeCompleted(agent) {
      const index = completionTitles.findIndex((entry) => entry.agent === agent);
      if (index < 0) return undefined;
      return completionTitles.splice(index, 1)[0].title;
    },
  };
  const pi = {
    events: {
      on(name, handler) {
        const current = listeners.get(name) ?? [];
        current.push(handler);
        listeners.set(name, current);
        return () => {};
      },
      emit(name, payload) {
        for (const handler of listeners.get(name) ?? []) handler(payload);
      },
    },
    sendMessage(message) { visible.push(message); },
  };
  const upstreamApi = createHeadlessSubagentApi(pi, {
    titleRegistry: registry,
    suppressCompletionNotifications: true,
  });
  const titleAwareApi = createHeadlessSubagentApi(pi, { titleRegistry: registry });
  titleAwareApi.events.on("subagent:async-complete", (event) => {
    titleAwareApi.sendMessage({
      customType: "subagent-notify",
      content: `Background task completed: **${event.agent}**\n\nDone`,
    });
  });

  upstreamApi.sendMessage({ customType: "subagent-notify", content: "Background task completed: **delegate**\n\nDone" });
  assert.deepEqual(visible, [], "the direct pre-event upstream notifier must be acknowledged without rendering");

  upstreamApi.events.emit("subagent:async-complete", { runId: "run-1", agent: "delegate" });
  assert.equal(visible.length, 1);
  // raw boundary：事件后发送的消息原样传递，title 解析留给显示层。
  assert.deepEqual(visible[0], { customType: "subagent-notify", content: "Background task completed: **delegate**\n\nDone" });
});

test("project completion notifier makes only completed subagent messages visible", () => {
  const messages = [];
  const source = { customType: "subagent-notify", content: "Background task completed: **delegate**", display: false };
  const pi = { events: { on() {}, emit() {} }, sendMessage(message) { messages.push(message); } };
  const api = createHeadlessSubagentApi(pi, { forceCompletionDisplay: true });

  api.sendMessage(source);
  api.sendMessage({ customType: "other-message", content: "hidden", display: false });

  assert.equal(messages[0].display, true);
  assert.equal(messages[1].display, false);
  assert.equal(source.display, false);
});

test("ExtensionRunner lifecycle records only supported actual pi.on events without manufacturing run identity", async () => {
  const pi = createPi();
  const trace = [];
  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) { api.registerTool({ name: "subagent_supervisor", execute() {} }); },
    completionNotifierFactory(_api, state) {
      state.completionOwnerId = "owner-1";
      return { dispose() {} };
    },
    resolveSessionId() { return "session-1"; },
    workingStateTrace(entry) { trace.push(entry); },
  });

  for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, { sessionManager: {} });
  const emitLifecycle = async (type, payload, context) => {
    for (const handler of pi.handlers.get(type) ?? []) await handler(payload, context);
  };
  const payload = { sessionId: "session-1" };
  await emitLifecycle("agent_settled", payload, { sessionManager: {} });

  assert.deepEqual(trace.map((entry) => entry.event), ["agent-settled", "host-idle"]);
  assert.equal(trace[0].hostSessionId, "session-1");
  assert.equal(trace[0].completionOwnerId, "owner-1");
  assert.equal(Object.hasOwn(trace[0], "runId"), false);
  assert.equal(pi.handlers.has("queue_update"), false);
  assert.deepEqual(payload, { sessionId: "session-1" });
});

test("ExtensionRunner shutdown disposes an owner-scoped trace sink exactly once", async () => {
  const pi = createPi();
  let disposals = 0;
  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) { api.registerTool({ name: "subagent_supervisor", execute() {} }); },
    extraDisposables: [{ dispose() { disposals += 1; } }],
  });
  const emitLifecycle = async (type, payload, context) => {
    for (const handler of pi.handlers.get(type) ?? []) await handler(payload, context);
  };
  await emitLifecycle("session_shutdown", { reason: "reload" }, { sessionManager: {} });
  await emitLifecycle("session_shutdown", { reason: "reload" }, { sessionManager: {} });
  assert.equal(disposals, 1);
});

test("grouped same-agent completions pass through without consuming the completed queue", () => {
  const messages = [];
  const queued = ["First task", "Second task"];
  const registry = {
    titleFor() { return undefined; },
    takeCompleted(agent) { return agent === "delegate" ? queued.shift() : undefined; },
  };
  const api = createHeadlessSubagentApi({
    events: { on() {}, emit() {} },
    sendMessage(message) { messages.push(message); },
  }, { titleRegistry: registry });

  const content = [
    "Background tasks completed (2): **delegate**, **delegate**",
    "",
    "1. delegate",
    "first result",
    "",
    "2. delegate",
    "second result",
  ].join("\n");
  api.sendMessage({ customType: "subagent-notify", content });

  // raw boundary：grouped 通知也不得按 agent 消费 completed 队列或改写内容。
  assert.deepEqual(messages[0], { customType: "subagent-notify", content });
  assert.deepEqual(queued, ["First task", "Second task"], "the completed queue must stay untouched by the send path");
});

test("the headless membrane denies registration APIs by default and preserves runtime APIs", () => {
  const pi = createPi();
  const api = createHeadlessSubagentApi(pi);
  const messageRenderer = () => {};
  const entryRenderer = () => {};
  const lifecycle = () => {};
  const eventHandler = () => {};

  api.registerTool({ name: "upstream-subagent", execute() {} });
  api.registerCommand("parallel-review", {});
  api.registerShortcut("ctrl+x", {});
  api.registerProvider("upstream-provider", {});
  api.registerMessageRenderer("subagent-result", messageRenderer);
  api.registerEntryRenderer("subagent-entry", entryRenderer);
  api.on("session_start", lifecycle);
  api.events.on("subagents:rpc:v1:request", eventHandler);

  assert.deepEqual(pi.tools, []);
  assert.deepEqual(pi.commands, []);
  assert.deepEqual(pi.shortcuts, []);
  assert.deepEqual(pi.providers, []);
  assert.deepEqual(pi.messageRenderers, [{ name: "subagent-result", renderer: messageRenderer }]);
  assert.deepEqual(pi.entryRenderers, [{ name: "subagent-entry", renderer: entryRenderer }]);
  assert.deepEqual(pi.handlers.get("session_start"), [lifecycle]);
  assert.deepEqual(pi.eventListeners, [{ name: "subagents:rpc:v1:request", handler: eventHandler }]);
});

test("project subagent tool retains injected display-only call and result renderers", () => {
  const pi = createPi();
  const renderSubagentCall = () => undefined;
  const renderSubagentResult = () => undefined;

  createTypedSubagentExtension(pi, {
    rpc: createRpc(),
    cleanupStore: {},
    renderSubagentCall,
    renderSubagentResult,
  });

  assert.equal(pi.tools[0].name, "subagent");
  assert.equal(pi.tools[0].renderCall, renderSubagentCall);
  assert.equal(pi.tools[0].renderResult, renderSubagentResult);
});

test("supervisor request renderer compacts inbound progress without mutating the message", () => {
  const renderers = createSubagentToolRenderers();
  assert.equal(typeof renderers.renderSupervisorRequest, "function");
  const message = {
    customType: "subagent_supervisor_request",
    content: "Supervisor needs decision.\nRun: run-7\nChild index: 1\nIntercom target: target-7\n请确认是否继续。",
    details: { agent: "executor", requestId: "request-7" },
  };
  const before = structuredClone(message);
  const backgrounds = [];
  const component = renderers.renderSupervisorRequest(message, { outputPad: 0 }, {
    fg: (_color, value) => value,
    bg(color, value) { backgrounds.push(color); return `<${color}>${value}</${color}>`; },
  });
  assert.equal(component.constructor.name, "Box");
  assert.equal(component.paddingX, 1);
  assert.equal(component.paddingY, 1);
  assert.equal(component.children.length, 2);
  const rendered = component.render(40);
  assert.equal(backgrounds.includes("toolPendingBg"), true);
  assert.equal(rendered.length >= 4, true);
  assert.match(rendered[1], /← \(executor\):/);
  assert.match(rendered.slice(2, -1).join("\n"), /请确认是否继续。/);
  assert.deepEqual(message, before);
});

test("spawn rendering keeps the complete execute result while showing one stateful call line", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "leaf-run-1", runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1",
      sessionId: "session-1", agent: "executor", pid: 102,
      workflowKey: "typed-dispatch-1", parentWorkflowRunId: "workflow-run-1",
    });
    return { text: "workflow spawned", details: { runId: "workflow-run-1", asyncDir: "/tmp/workflow-run-1" } };
  };
  const renderers = createSubagentToolRenderers();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, randomUUID: () => "dispatch-1", ...renderers });
  const result = await execute(pi.tools[0], codingContract());
  const theme = { fg: (_color, text) => text };
  const context = { args: codingContract(), state: {} };

  assert.deepEqual(
    renderers.renderSubagentCall(context.args, theme, context).render(120).map((line) => line.trimEnd()),
    ["subagent start", "executor: Install the typed subagent runtime"],
  );
  assert.equal(
    result.content[0].text,
    "Started executor: Install the typed subagent runtime (leaf-run-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  );
  assert.equal(result.details.runId, "leaf-run-1");
  assert.deepEqual(
    renderers.renderSubagentResult(result, { expanded: false }, theme, context).render(120),
    [],
  );
  assert.equal(context.state.subagentSpawnSummary, "* subagent started executor: Install the typed subagent runtime");
  assert.deepEqual(
    renderers.renderSubagentCall(context.args, theme, context).render(120).map((line) => line.trimEnd()),
    ["* subagent started executor: Install the typed subagent runtime"],
  );
  assert.deepEqual(
    renderers.renderSubagentResult(result, { expanded: true }, theme, context).render(120),
    [],
  );

  const failed = { isError: true, details: { agent: "executor", title: "Install the typed subagent runtime" } };
  assert.deepEqual(renderers.renderSubagentResult(failed, { expanded: false }, theme, context).render(120), []);
  assert.equal(context.state.subagentSpawnSummary, "* subagent failed executor: Install the typed subagent runtime");

  const statusState = { subagentSpawnSummary: "unchanged" };
  assert.deepEqual(
    renderers.renderSubagentResult(
      { content: [{ type: "text", text: "State: running" }] },
      { expanded: false }, theme,
      { args: { action: "status" }, state: statusState },
    ).render(120).map((line) => line.trimEnd()),
    ["Status: running"],
  );
  assert.deepEqual(statusState, { subagentSpawnSummary: "unchanged" });
  const statusCall = renderers.renderSubagentCall({ action: "status" }, theme, { state: statusState });
  assert.ok(statusCall, "defined renderCall slots must return a Component");
  assert.deepEqual(statusCall.render(120).map((line) => line.trimEnd()), ["subagent status"]);
});

test("subagent renderer preserves validation Received arguments without changing result or args", () => {
  const renderers = createSubagentToolRenderers();
  const result = {
    isError: true,
    content: [{ type: "text", text: [
      'Validation failed for tool "subagent":',
      "  - $.execution.timeoutMs: expected integer",
      "  - $.acceptance.criteria: expected at least one item",
      "",
      "Received arguments:",
      JSON.stringify({  taskId: "very-long", execution: { timeoutMs: "invalid" }, requirements: ["x".repeat(2048)] }, null, 2),
    ].join("\n") }],
    details: { code: "VALIDATION_ERROR", received: { preserved: true } },
  };
  const args = {  execution: { timeoutMs: "invalid" } };
  const beforeResult = structuredClone(result);
  const beforeArgs = structuredClone(args);
  const rendered = renderers.renderSubagentResult(result, { expanded: false }, { fg: (_color, text) => text }, { args, state: {} }).render(120).join("\n");
  assert.match(rendered, /Validation failed for tool "subagent":/);
  assert.match(rendered, /execution\.timeoutMs/);
  assert.match(rendered, /acceptance\.criteria/);
  assert.match(rendered, /Received arguments/);
  assert.match(rendered, /very-long/);
  assert.match(rendered, /invalid/);
  assert.match(rendered, /x{64}/);
  assert.deepEqual(result, beforeResult);
  assert.deepEqual(args, beforeArgs);
});

test("beforeDispose completes before RPC disposal in the single shutdown handler", async () => {
  const pi = createPi();
  const order = [];
  const rpc = createRpc({ dispose() { order.push("dispose"); } });
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    async beforeDispose() { order.push("before"); },
  });
  assert.equal((pi.handlers.get("session_shutdown") ?? []).length, 1);
  await pi.handlers.get("session_shutdown")[0]({ reason: "shutdown" });
  assert.deepEqual(order, ["before", "dispose"]);
});

test("beforeDispose failure retains RPC and cleanup entry for shutdown retry", async () => {
  const pi = createPi();
  const order = [];
  let failClose = true;
  const rpc = createRpc({ dispose() { order.push("dispose"); } });
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    async beforeDispose() {
      order.push("before");
      if (failClose) throw new Error("close failed");
    },
  });
  const shutdown = pi.handlers.get("session_shutdown")[0];
  await assert.rejects(() => shutdown(), /close failed/);
  assert.deepEqual(order, ["before"]);
  failClose = false;
  await shutdown();
  await shutdown();
  assert.deepEqual(order, ["before", "before", "dispose"]);
});

test("headless bootstrap defers upstream shutdown cleanup until ordered drain succeeds and preserves retry ownership", async () => {
  const pi = createPi();
  const order = [];
  let failDrain = true;
  const rpc = createRpc({ dispose() { order.push("project-rpc-dispose"); } });

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      api.on("session_shutdown", (event, context) => {
        order.push(`upstream:${event.reason}:${context.id}`);
      });
    },
    rpc,
    cleanupStore: {},
    async beforeRuntimeDispose() {
      order.push("ordered-drain");
      if (failDrain) throw new Error("drain failed");
    },
  });

  const shutdown = async (event, context) => {
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler(event, context);
  };
  await assert.rejects(() => shutdown({ reason: "exit" }, { id: "original-context" }), /drain failed/);
  assert.deepEqual(order, ["ordered-drain"], "failed drain must retain upstream and project cleanup ownership");

  failDrain = false;
  await shutdown({ reason: "exit" }, { id: "original-context" });
  await shutdown({ reason: "exit" }, { id: "original-context" });
  assert.deepEqual(order, [
    "ordered-drain",
    "ordered-drain",
    "upstream:exit:original-context",
    "project-rpc-dispose",
  ]);
});

test("shutdown is single-flight and retries the complete flow after failure", async () => {
  const pi = createPi();
  const order = [];
  let fail = true;
  createTypedSubagentExtension(pi, {
    cleanupStore: {},
    rpc: createRpc({ dispose() { order.push("dispose"); } }),
    async beforeDispose() {
      order.push("drain");
      if (fail) throw new Error("drain failed");
    },
    async afterBeforeDispose() { order.push("upstream"); },
  });
  const shutdown = pi.handlers.get("session_shutdown")[0];
  await assert.rejects(() => Promise.all([shutdown(), shutdown()]), /drain failed/);
  assert.deepEqual(order, ["drain"]);
  fail = false;
  await Promise.all([shutdown(), shutdown()]);
  await shutdown();
  assert.deepEqual(order, ["drain", "drain", "upstream", "dispose"]);
});

test("upstream shutdown debt retries only handlers that failed", async () => {
  const pi = createPi();
  const calls = [];
  let failSecond = true;
  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore: {}, rpc: createRpc(),
    bootstrap(api) {
      api.on("session_shutdown", () => { calls.push("first"); });
      api.on("session_shutdown", (event) => {
        calls.push(`second:${event.reason}`);
        if (failSecond) throw new Error("second failed");
      });
      api.on("session_shutdown", (event) => { calls.push(`third:${event.reason}`); });
    },
  });
  const shutdown = pi.handlers.get("session_shutdown")[0];
  await assert.rejects(() => shutdown({ reason: "exit" }, {}), /second failed/);
  failSecond = false;
  await shutdown({ reason: "changed" }, { changed: true });
  assert.deepEqual(calls, ["first", "second:exit", "second:exit", "third:exit"]);
});

test("reload repays old generation shutdown debt before activating new upstream handlers", async () => {
  const pi = createPi();
  const cleanupStore = {};
  const order = [];
  let failDrain = true;
  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore, rpc: createRpc({ dispose() { order.push("old-project"); } }),
    bootstrap(api) {
      api.registerTool({ name: "subagent_supervisor", execute() {} });
      api.on("session_start", () => { order.push("old-generation"); });
      api.on("session_shutdown", () => { order.push("old-upstream"); });
    },
    async beforeRuntimeDispose() {
      order.push("old-drain");
      if (failDrain) throw new Error("drain failed");
    },
  });
  const oldShutdown = pi.handlers.get("session_shutdown")[0];
  await assert.rejects(() => oldShutdown({ reason: "reload" }, {}), /drain failed/);
  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore, rpc: createRpc(),
    bootstrap(api) {
      api.registerTool({ name: "subagent_supervisor", execute() {} });
      api.on("session_start", () => { order.push("new-generation"); });
    },
    async beforeUpstreamSessionStart() { order.push("new-project"); },
  });
  failDrain = false;
  for (const handler of pi.handlers.get("session_start") ?? []) await handler({ reason: "reload" }, {});
  assert.deepEqual(order, ["old-drain", "old-drain", "old-upstream", "old-project", "new-project", "new-generation"]);
});

test("retain-on-beforeDispose-failure retries cleanup before disposing RPC", async () => {
  const pi = createPi();
  let attempts = 0;
  const rpc = createRpc();
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    retainOnBeforeDisposeFailure: true,
    async beforeDispose() { attempts += 1; if (attempts === 1) throw new Error("controlled close failure"); },
  });
  const shutdown = pi.handlers.get("session_shutdown")[0];
  await assert.rejects(() => shutdown(), /controlled close failure/);
  assert.equal(rpc.disposed(), 0);
  await shutdown();
  assert.equal(attempts, 2);
  assert.equal(rpc.disposed(), 1);
});

test("project subagent schema exposes an object root to OpenAI-compatible providers", () => {
  const pi = createPi();

  createTypedSubagentExtension(pi, {
    rpc: createRpc(),
    cleanupStore: {},
  });

  // 根节点必须是显式单一 object：deepseek 要求顶层 type:object（历史 bug），
  // glm 对顶层联合组合子生成空 arguments（docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md）。
  // 分支字段以字段级联合形态内联在 properties 中。
  const schema = pi.tools[0].parameters;
  assert.equal(schema.type, "object");
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    assert.equal(schema[combinator], undefined, `root must not use ${combinator}`);
  }
  for (const field of ["agent", "task", "writePaths", "acceptance", "action", "worktree"]) {

    assert.ok(schema.properties[field], `flattened root must keep the ${field} field for its branch`);
  }
});

test("headless runtime installation exposes only project-owned subagent tools", () => {
  const pi = createPi();
  const rpc = createRpc();
  const upstreamMethodologyDescription = "CHAIN PARALLEL proactive skill methodology";
  let upstreamApi;

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      upstreamApi = api;
      api.registerTool({
        name: "subagent",
        description: upstreamMethodologyDescription,
        execute() { throw new Error("must never execute"); },
      });
      api.registerTool({ name: "bg_wait", execute() {} });
      api.registerCommand("parallel-review", {});
      api.on("session_start", () => {});
    },
    rpc,
    cleanupStore: {},
    randomUUID: () => "dispatch-1",
  });

  assert.notEqual(upstreamApi, pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["subagent", "subagent_worktree", "subagent_supervisor"]);
  assert.equal(pi.tools.some((tool) => tool.name === "subagent_workspace"), false);
  assert.equal(pi.commands.length, 0);
  assert.equal(pi.tools[0].description, TYPED_SUBAGENT_DESCRIPTION);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /writePaths/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /worktree 隔离通过顶层 worktree 与 cwd 字段声明/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /worktree=true 时响应携带 workspace_id/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /CHILD_OWNS_INTEGRATION/);
  assert.match(TYPED_SUBAGENT_DESCRIPTION, /已 released 的工作区无需额外处置/);
  // M05B：单工具提示可见性正确且不扩大权限；model-only 保持。
  assert.equal(pi.tools[0].exposure, "model-only");
  assert.match(pi.tools[0].promptSnippet, /委派/);
  assert.match(pi.tools[0].promptGuidelines.join("\n"), /完整任务合同/);
  assert.equal(pi.tools[0].promptGuidelines.length, 3);
  assert.equal(pi.tools[1].exposure, "model-only");
  assert.match(pi.tools[1].promptSnippet, /status/);
  assert.match(pi.tools[1].promptGuidelines.join("\n"), /CHILD_OWNS_INTEGRATION/);
  assert.equal(pi.tools[2].exposure, "model-only");
  assert.match(pi.tools[2].promptSnippet, /pending/);
  assert.match(pi.tools[2].promptGuidelines.join("\n"), /writeReply/);
  assert.equal(pi.tools[2].promptGuidelines.length, 2);
  assert.doesNotMatch(pi.tools[0].description, /proactive skill methodology/i);
  assert.doesNotMatch(pi.tools[1].description, /pi-subagents|upstream/i);
});

test("headless installation wires the completion notifier to session lifecycle", async () => {
  const pi = createPi();
  const rpc = createRpc();
  let upstreamApi;
  let notifierState;
  let notifierDisposals = 0;
  const completionTitles = [];
  const titleRegistry = {
    prepare() {},
    started() { return undefined; },
    remember() {},
    completed(event) {
      const title = event.runId === "run-1" ? "Observed task" : undefined;
      if (title) completionTitles.push({ agent: event.agent, title });
      return title;
    },
    titleFor() { return undefined; },
    takeCompleted(agent) {
      const index = completionTitles.findIndex((entry) => entry.agent === agent);
      return index < 0 ? undefined : completionTitles.splice(index, 1)[0].title;
    },
  };

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      upstreamApi = api;
      api.registerTool({ name: "subagent_supervisor", execute() {} });
    },
    completionNotifierFactory(api, state) {
      notifierState = state;
      const unsubscribe = api.events.on("subagent:async-complete", (event) => {
        api.sendMessage({ customType: "subagent-notify", content: `Background task completed: **${event.agent}**\n\nDone` });
      });
      return { dispose() { notifierDisposals += 1; unsubscribe(); } };
    },
    resolveSessionId(sessionManager) { return sessionManager.id; },
    rpc,
    cleanupStore: {},
    titleRegistry,
  });

  for (const handler of pi.handlers.get("session_start") ?? []) {
    await handler({ reason: "startup" }, { sessionManager: { id: "session-1" } });
  }
  assert.equal(notifierState.currentSessionId, "session-1");

  upstreamApi.sendMessage({ customType: "subagent-notify", content: "Background task completed: **delegate**\n\nDone" });
  assert.deepEqual(pi.messages, []);
  upstreamApi.events.emit("subagent:async-complete", { runId: "run-1", agent: "delegate", sessionId: "session-1" });
  assert.equal(pi.messages.length, 1);
  // raw boundary：message 原样传递（仅 designated notifier 的既有 display gating
  // 翻转 display 字段），title 由显示层按 runId 解析。
  assert.deepEqual(pi.messages[0], { customType: "subagent-notify", content: "Background task completed: **delegate**\n\nDone", display: true });

  for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" });
  assert.equal(notifierDisposals, 1);
});

test("workspace reminder listener registers before the completion notifier and disposes on shutdown", async () => {
  const pi = createPi();
  const order = [];
  let reminderDisposals = 0;
  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) { api.registerTool({ name: "subagent_supervisor", execute() {} }); }, rpc: createRpc(), cleanupStore: {},
    resolveSessionId(sessionManager) { return sessionManager.id; },
    workspaceCompletionReminderFactory(api, state) {
      assert.equal(state.currentSessionId, null);
      api.events.on("subagent:async-complete", () => order.push("reminder"));
      return { dispose() { reminderDisposals += 1; } };
    },
    completionNotifierFactory(api) {
      api.events.on("subagent:async-complete", () => order.push("notifier"));
      return { dispose() {} };
    },
  });
  for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, { sessionManager: { id: "session-1" } });
  await pi.events.emit("subagent:async-complete", { runId: "leaf" });
  assert.deepEqual(order, ["reminder", "notifier"]);
  for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, {});
  assert.equal(reminderDisposals, 1);
});

test("production upstream completion emits decorate each same-agent leaf once", async () => {
  const pi = createPi();
  const registry = createTitleRegistry();
  const delivered = [];
  let upstreamApi;

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      upstreamApi = api;
      api.registerTool({ name: "subagent_supervisor", execute() {} });
    },
    titleRegistry: registry,
    rpc: createRpc(),
    cleanupStore: {},
    resolveSessionId(sessionManager) { return sessionManager.id; },
    completionNotifierFactory(api) {
      const unsubscribe = api.events.on("subagent:async-complete", (event) => {
        delivered.push(event.title);
        api.sendMessage({
          customType: "subagent-notify",
          content: `Background task completed: **${event.agent}**`,
        });
      });
      return { dispose: unsubscribe };
    },
  });
  for (const handler of pi.handlers.get("session_start") ?? []) {
    await handler({}, { sessionManager: { id: "session-1" } });
  }

  registry.prepare({ agent: "delegate", task: "first", title: "First task" });
  upstreamApi.events.emit("subagent:async-started", { runId: "leaf-1", agent: "delegate", task: "first" });
  registry.prepare({ agent: "delegate", task: "second", title: "Second task" });
  upstreamApi.events.emit("subagent:async-started", { runId: "leaf-2", agent: "delegate", task: "second" });
  upstreamApi.events.emit("subagent:async-complete", { runId: "leaf-1", agent: "delegate", success: true });
  upstreamApi.events.emit("subagent:async-complete", { runId: "leaf-2", agent: "delegate", success: true });

  assert.deepEqual(delivered, ["First task", "Second task"]);
  // raw boundary：message 不再注入 title；lifecycle event 仍按 runId 各 enqueue
  // 恰一个条目且 FIFO 有序（leaf-1 → leaf-2），队列残留由显示层之外无消费者。
  assert.equal(pi.messages[0].content, "Background task completed: **delegate**");
  assert.equal(pi.messages[1].content, "Background task completed: **delegate**");
  assert.equal(registry.takeCompleted("delegate"), "First task", "each completion must enqueue one title only, in run order");
  assert.equal(registry.takeCompleted("delegate"), "Second task");
  assert.equal(registry.takeCompleted("delegate"), undefined);
});

test("confirmed facade workflow success is filtered before the completion notifier while its leaf remains visible", async () => {
  const pi = createPi();
  const registry = createTitleRegistry();
  const delivered = [];
  let upstreamApi;
  const rpc = createRpc();
  rpc.spawn = async () => {
    upstreamApi.events.emit("subagent:async-started", {
      id: "leaf-run-1", runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1",
      sessionId: "session-1", pid: 101, agent: "reviewer", workflowKey: "typed-notify-1", parentWorkflowRunId: "workflow-root-1",
    });
    return { details: { runId: "workflow-root-1", asyncDir: "/tmp/workflow-root-1" } };
  };

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      upstreamApi = api;
      api.registerTool({ name: "subagent_supervisor", execute() {} });
    },
    titleRegistry: registry,
    rpc,
    cleanupStore: {},
    randomUUID: () => "notify-1",
    resolveSessionId(sessionManager) { return sessionManager.id; },
    completionNotifierFactory(api) {
      const unsubscribe = api.events.on("subagent:async-complete", (event) => {
        delivered.push(event.runId);
        api.sendMessage({
          customType: "subagent-notify",
          content: `Background task completed: **${event.agent}**\n\n${event.summary}`,
        }, { triggerTurn: true });
      });
      return { dispose: unsubscribe };
    },
  });
  for (const handler of pi.handlers.get("session_start") ?? []) {
    await handler({}, { sessionManager: { id: "session-1" } });
  }

  const started = await execute(pi.tools.find((tool) => tool.name === "subagent"), {
    agent: "reviewer", title: "真实业务", task: "交付业务摘要",
  });
  assert.equal(started.isError, false);
  assert.equal(started.details.runId, "leaf-run-1");

  upstreamApi.events.emit("subagent:async-complete", {
    runId: "workflow-root-1", agent: "workflow", success: true, sessionId: "session-1", summary: "Async: delegate [leaf-run-1]",
  });
  assert.deepEqual(delivered, [], "the wrapper must not enter completion batching");
  assert.deepEqual(pi.messages, [], "the wrapper must not send or trigger the main Agent");

  upstreamApi.events.emit("subagent:async-complete", {
    runId: "leaf-run-1", agent: "delegate", success: true, sessionId: "session-1", summary: "业务摘要",
  });
  assert.deepEqual(delivered, ["leaf-run-1"]);
  assert.equal(pi.messages.length, 1);
  // raw boundary：leaf 通知原样传递（title 由显示层解析），保留摘要正文。
  assert.equal(pi.messages[0].content, "Background task completed: **delegate**\n\n业务摘要");

  upstreamApi.events.emit("subagent:async-complete", { runId: "user-workflow", agent: "workflow", success: true, sessionId: "session-1", summary: "用户 workflow" });
  for (const state of ["failed", "paused", "stopped"]) {
    upstreamApi.events.emit("subagent:async-complete", { runId: "workflow-root-1", agent: "workflow", success: false, state, sessionId: "session-1", summary: state });
  }
  assert.deepEqual(delivered, ["leaf-run-1", "user-workflow", "workflow-root-1", "workflow-root-1", "workflow-root-1"]);
  assert.equal(pi.messages.length, 5, "unrelated workflow and internal non-success states remain visible");
});

test("generic dispatch validates required fields without using profile names as authorization", async () => {
  const pi = createPi();
  const rpc = createRpc();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  const tool = pi.tools[0];

  // v2: title is optional; only agent and task are required
  const missingTask = await execute(tool, { agent: "executor" });
  assert.equal(missingTask.isError, true);
  assert.equal(missingTask.details.code, "INVALID_GENERIC_DISPATCH");
  const missingAgent = await execute(tool, { task: "Implement it." });
  assert.equal(missingAgent.isError, true);
  assert.equal(missingAgent.details.code, "INVALID_GENERIC_DISPATCH");
  assert.deepEqual(rpc.calls, []);
});

test("compiles a coding contract into one workflow root and returns its correlated leaf handle", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "leaf-run-1",
      runId: "leaf-run-1",
      asyncDir: "/tmp/leaf-run-1",
      sessionId: "session-1",
      agent: "executor", pid: 102,
      workflowKey: "typed-dispatch-1",
      parentWorkflowRunId: "workflow-run-1",
    });
    return { text: "workflow spawned", details: { runId: "workflow-run-1", asyncDir: "/tmp/workflow-run-1" } };
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "dispatch-1",
  });

  const result = await execute(pi.tools[0], codingContract());
  const spawn = rpc.calls.find((call) => call.method === "spawn");

  assert.equal(result.isError, false);
  assert.deepEqual(result.details, {
    version: "coding-dispatch-handle.v1",
    dispatchId: "dispatch-1",
    taskId: "dispatch-" + result.details.contractHash.slice(0, 8),
    agent: "executor",
    title: "Install the typed subagent runtime",
    contractHash: result.details.contractHash,
    runId: "leaf-run-1",
    asyncDir: "/tmp/leaf-run-1",
    modelSelection: { source: "default" },
  });
  assert.match(result.details.contractHash, /^[a-f0-9]{64}$/);
  for (const key of ["agent", "title", "task", "clarify", "acceptance"]) {
    assert.equal(Object.hasOwn(spawn.params, key), false, `${key} must not reach public RPC spawn`);
  }
  assert.equal(spawn.params.cwd, "/repo");
  assert.equal(spawn.params.context, "fresh");
  assert.equal(spawn.params.async, true);
  assert.equal(spawn.params.worktree, false);
  assert.equal(spawn.params.mission, false);
  assert.equal(spawn.params.chatProgress, "off");
  assert.equal(Object.hasOwn(spawn.params, "timeoutMs"), false);
  assert.equal(Object.hasOwn(spawn.params.child ?? {}, "timeoutMs"), false);

  assert.match(spawn.params.script, /runs\.run\("typed-dispatch-1"/);
  assert.match(spawn.params.script, /# Dispatch Contract/);
  assert.match(spawn.params.script, /"level":"checked"/);
  assert.doesNotMatch(spawn.params.script, /"verify"/);
  assert.doesNotMatch(result.content[0].text, /Authoritative Known Facts/);
  assert.equal(
    result.content[0].text,
    "Started executor: Install the typed subagent runtime (leaf-run-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  );
});

test("coding cwd never infers ownership from a legacy workspace-shaped path", async () => {
  const pi = createPi();
  const rpc = createRpc();
  const workspaceCalls = [];
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "continuation-leaf-1",
      runId: "continuation-leaf-1",
      asyncDir: "/tmp/continuation-leaf-1",
      sessionId: "session-1",
      agent: "executor", pid: 103,
      workflowKey: "typed-continuation-1",
      parentWorkflowRunId: "continuation-workflow-1",
    });
    return { details: { runId: "continuation-workflow-1", asyncDir: "/tmp/continuation-workflow-1" } };
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "continuation-1",
    workspaceService: new Proxy({}, { get(_target, property) { return () => workspaceCalls.push(property); } }),
  });

  const result = await execute(pi.tools[0], codingContract({
    cwd: "/repo/.state/subagent-dispatch/worktrees/workspace-1/sub",
    worktree: false,

  }));

  assert.equal(result.isError, false);
  assert.deepEqual(workspaceCalls, []);
});

test("generic dispatch compiles a non-coding agent prompt into the unified dispatch contract", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "leaf-review-1",
      runId: "leaf-review-1",
      asyncDir: "/tmp/leaf-review-1",
      sessionId: "session-1",
      agent: "reviewer", pid: 103,
      workflowKey: "typed-generic-1",
      parentWorkflowRunId: "workflow-review-1",
    });
    return { text: "workflow spawned", details: { runId: "workflow-review-1", asyncDir: "/tmp/workflow-review-1" } };
  };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, randomUUID: () => "generic-1" });
  const task = "  Review exactly this diff.\nPreserve this whitespace.  ";
  const params = {
    agent: "reviewer",
    title: "Review the diff",
    task,
    context: "fresh",
    cwd: "/repo",
    output: false,
  };

  const result = await execute(pi.tools[0], params);
  const spawn = rpc.calls.find((call) => call.method === "spawn");

  assert.equal(result.isError, false);
  for (const key of ["agent", "title", "task", "clarify", "acceptance"]) {
    assert.equal(Object.hasOwn(spawn.params, key), false, `${key} must not reach public RPC spawn`);
  }
  // The raw task (with surrounding whitespace) must not appear verbatim in the top-level spawn params
  assert.equal(Object.hasOwn(spawn.params, "task"), false, "task must not be a top-level spawn param");
  const workflowRun = spawn.params.script.match(/^return await runs\.run\("typed-generic-1", (.+)\);$/);
  assert.ok(workflowRun, "workflow script must contain a serialized child leaf");
  const leaf = JSON.parse(workflowRun[1]);
  // v2: generic task is now compiled through the unified renderDispatchPrompt
  const expectedLeafTask = leaf.task; // verify it's a non-empty string, content checked by render tests
  assert.equal(typeof leaf.task, "string");
  assert.ok(leaf.task.length > 0);
  assert.match(leaf.task, /Review exactly this diff/);

  assert.equal(result.details.runId, "leaf-review-1");
  assert.equal(result.details.asyncDir, "/tmp/leaf-review-1");
  assert.equal(result.details.title, "Review the diff");
  assert.equal(
    result.content[0].text,
    "Started reviewer: Review the diff (leaf-review-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  );
});

test("generic worktree spawn result explains workspace disposition without exposing lease data", async () => {
  const pi = createPi();
  const rpc = createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      pi.events.emit("subagent:async-started", { id: "generic-worktree-leaf", runId: "generic-worktree-leaf", asyncDir: "/tmp/generic-worktree-leaf", sessionId: "session-1", agent: "reviewer", pid: 104, workflowKey: "typed-generic-workspace", parentWorkflowRunId: "generic-worktree-root" });
      return { details: { runId: "generic-worktree-root", asyncDir: "/tmp/generic-worktree-root" } };
    },
  });
  const workspaceService = {
    ensureAllocated(request) { return managedReceipt({ workspaceId: request.workspaceId, owner: request.owner }); },
    bindRun({ run }) { return managedReceipt({ workspaceId: "generic-workspace", state: "active", run }); },
  };
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, randomUUID: () => "generic-workspace", workspaceService,
    resolveRootSessionId: () => "root-1", resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    registerAuthorizedRun() {},
  });
  const result = await execute(pi.tools[0], { agent: "reviewer", title: "Review", task: "Review it", writePaths: ["README.md"], acceptance: { criteria: ["review complete"] }, worktree: true }, { cwd: "/repo", sessionManager: {} });
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.match(result.content[0].text, /Workspace generic-workspace allocated \(state: active\)/);
  assert.match(result.content[0].text, /integrate or discard to finish, or preserve temporarily and later release/);
  assert.doesNotMatch(result.content[0].text, /action_token|lease[_-]id|\/Users\//i);
});

test("uses a bounded fallback while waiting for a generic leaf without input timeout", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "fallback-leaf-1", runId: "fallback-leaf-1", asyncDir: "/tmp/fallback-leaf-1",
      sessionId: "session-1", pid: 104, agent: "reviewer", workflowKey: "typed-fallback-1", parentWorkflowRunId: "workflow-fallback-1",
    });
    return { details: { runId: "workflow-fallback-1", asyncDir: "/tmp/workflow-fallback-1" } };
  };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, randomUUID: () => "fallback-1" });

  const result = await execute(pi.tools[0], { agent: "reviewer", title: "Review fallback", task: "Review." });

  assert.equal(result.isError, false);
  assert.equal(rpc.calls.find((call) => call.method === "spawn").params.timeoutMs, undefined);
});

test("requires a safe generic title before RPC", async () => {
  const pi = createPi();
  const rpc = createRpc();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });

  // v2: title is optional; only invalid title (newline) is rejected
  const noTask = await execute(pi.tools[0], { agent: "delegate" });
  assert.equal(noTask.isError, true);
  assert.equal(noTask.details.code, "INVALID_GENERIC_DISPATCH");
  const badTitle = await execute(pi.tools[0], { agent: "delegate", task: "Inspect", title: "line\nbreak" });
  assert.equal(badTitle.isError, true);
  assert.equal(badTitle.details.code, "INVALID_TITLE");
  assert.deepEqual(rpc.calls, []);
});

test("maps approved control actions to RPC and requires a resume instruction", async () => {
  const pi = createPi();
  const rpc = createRpc();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  const tool = pi.tools[0];

  for (const [action, params, expected] of [
    ["status", { action: "status", id: "run-1" }, { id: "run-1" }],
    ["steer", { action: "steer", runId: "run-1", message: "Continue." }, { runId: "run-1", message: "Continue." }],
    ["interrupt", { action: "interrupt", dir: "/tmp/run-1" }, { dir: "/tmp/run-1" }],
    ["resume", { action: "resume", id: "run-1", runId: "run-1", dir: "/tmp/run-1", index: 2, message: "Continue with the new instruction." }, { id: "run-1", runId: "run-1", dir: "/tmp/run-1", index: 2, message: "Continue with the new instruction." }],
    ["stop", { action: "stop", id: "run-1" }, { id: "run-1" }],
  ]) {
    const result = await execute(tool, params);
    assert.equal(result.isError, false);
    assert.deepEqual(rpc.calls.at(-1), { method: action, params: expected });
  }

  const callCount = rpc.calls.length;
  for (const message of [undefined, ""]) {
    const rejected = await execute(tool, { action: "resume", id: "run-1", ...(message === undefined ? {} : { message }) });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.details.code, "INVALID_RESUME_MESSAGE");
  }
  assert.equal(rpc.calls.length, callCount, "invalid resume calls must not reach RPC");
});

test("subagent_worktree status exposes action token and blocked reasons", async () => {
  const pi = createPi();
  const workspaceService = {
    statusOwned() {
      return {
        receipt: managedReceipt(),
        terminalProof: { state: "observed", conflict: false, runId: "run-1", rootSessionId: "root-1", asyncDir: "/tmp/run-1", processInstance: "proc-1", proofId: "d".repeat(64) },
        allowedDispositions: ["preserve", "discard"],
        blockedReasons: ["no-commits"],
      };
    },
    issueOwnedDisposition() {
      return {
        receipt: managedReceipt(),
        terminalProof: { state: "observed", conflict: false, runId: "run-1", rootSessionId: "root-1", asyncDir: "/tmp/run-1", processInstance: "proc-1", proofId: "d".repeat(64) },
        allowedDispositions: ["preserve", "discard"],
        actionToken: "once-token",
        blockedReasons: ["no-commits"],
      };
    },
  };
  createTypedSubagentExtension(pi, {
    rpc: createRpc(), cleanupStore: {}, workspaceService, resolveRootSessionId: () => "root-1",
  });

  const result = await execute(pi.tools[1], { action: "status", workspace_id: "workspace-1" });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /"workspace_id":"workspace-1"/);
  assert.match(result.content[0].text, /"state":"active"/);
  assert.match(result.content[0].text, /"action_token":"once-token"/);
  assert.match(result.content[0].text, /"allowed_dispositions":\["preserve","discard"\]/);
  assert.match(result.content[0].text, /"integrate_blocked_reasons":\["no-commits"\]/);
});

test("subagent_worktree release accepts only the scoped service path", async () => {
  const pi = createPi();
  const releases = [];
  const workspaceService = {
    releaseOwned(input) {
      releases.push(input);
      return managedReceipt({ state: "released", disposition: { action: "preserve", reason: "manual" } });
    },
    disposeOwned() { throw new Error("release must not dispose through action token path"); },
  };
  createTypedSubagentExtension(pi, {
    rpc: createRpc(), cleanupStore: {}, workspaceService, resolveRootSessionId: () => "root-1",
  });
  const tool = pi.tools[1];
  const releaseSchema = tool.parameters.anyOf.find((branch) => branch.properties?.action?.const === "release");

  assert.ok(releaseSchema);
  const result = await execute(tool, { action: "release", workspace_id: "workspace-1" });

  assert.equal(result.isError, false);
  assert.equal(result.details.state, "released");
  assert.deepEqual(releases, [{ workspaceId: "workspace-1", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" } }]);
});

test("uses persistent sessionFile identity for workflow leaf correlation and falls back for --no-session", async () => {
  const persistentPi = createPi();
  const persistentRpc = createRpc({
    ping: async () => ({ version: 1, methods: ["spawn"], session: { sessionId: "logical-session-id", sessionFile: "logical-session-id", cwd: "/repo" } }),
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      persistentPi.events.emit("subagent:async-started", {
        id: "persistent-leaf", runId: "persistent-leaf", asyncDir: "/tmp/persistent-leaf",
        sessionId: "logical-session-id", pid: 105, agent: "executor",
        workflowKey: "typed-persistent-1", parentWorkflowRunId: "persistent-root",
      });
      return { details: { runId: "persistent-root", asyncDir: "/tmp/persistent-root" } };
    },
  });
  createTypedSubagentExtension(persistentPi, {
    rpc: persistentRpc, cleanupStore: {}, randomUUID: () => "persistent-1", workflowChildStartTimeoutMs: 10,
  });
  const persistent = await execute(persistentPi.tools[0], codingContract());
  assert.equal(persistent.isError, false);
  assert.equal(persistent.details.runId, "persistent-leaf");

  const noSessionPi = createPi();
  const noSessionRpc = createRpc({
    ping: async () => ({ version: 1, methods: ["spawn"], session: { sessionId: "no-session-id", sessionFile: null, cwd: "/repo" } }),
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      noSessionPi.events.emit("subagent:async-started", {
        id: "no-session-leaf", runId: "no-session-leaf", asyncDir: "/tmp/no-session-leaf",
        sessionId: "no-session-id", pid: 106, agent: "executor",
        workflowKey: "typed-no-session-1", parentWorkflowRunId: "no-session-root",
      });
      return { details: { runId: "no-session-root", asyncDir: "/tmp/no-session-root" } };
    },
  });
  createTypedSubagentExtension(noSessionPi, {
    rpc: noSessionRpc, cleanupStore: {}, randomUUID: () => "no-session-1", workflowChildStartTimeoutMs: 10,
  });
  const noSession = await execute(noSessionPi.tools[0], codingContract());
  assert.equal(noSession.isError, false);
  assert.equal(noSession.details.runId, "no-session-leaf");
});

test("fails closed when RPC capabilities or spawn identity are incomplete", async () => {
  for (const rpc of [
    createRpc({ ping: async () => ({ version: 1, methods: ["status"], session: { sessionId: "s", sessionFile: "/s", cwd: "/repo" } }) }),
    createRpc({ ping: async () => ({ version: 2, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/s", cwd: "/repo" } }) }),
    createRpc({ ping: async () => ({ version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: 42, cwd: "/repo" } }) }),
    createRpc({ spawn: async () => ({ text: "missing handle", details: {} }) }),
  ]) {
    const pi = createPi();
    createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
    const result = await execute(pi.tools[0], codingContract());
    assert.equal(result.isError, true);
    assert.match(result.details.code, /CAPABILITY_NEGOTIATION_FAILED|CAPABILITY_MISMATCH|SPAWN_REPLY_INVALID/);
  }
});

test("coding spawn uses the Host collector deadline for a delayed leaf", async () => {
  const pi = createPi();
  const rpc = createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      setTimeout(() => pi.events.emit("subagent:async-started", {
        id: "delayed-leaf-1",
        runId: "delayed-leaf-1",
        asyncDir: "/tmp/delayed-leaf-1",
        sessionId: "session-1",
        agent: "executor", pid: 107,
        workflowKey: "typed-delayed-1",
        parentWorkflowRunId: "workflow-delayed-1",
      }), 35);
      return { text: "workflow spawned", details: { runId: "workflow-delayed-1", asyncDir: "/tmp/workflow-delayed-1" } };
    },
  });
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "delayed-1",
  });

  const result = await execute(pi.tools[0], codingContract());

  assert.equal(result.isError, false);
  assert.equal(result.details.runId, "delayed-leaf-1");
});

test("does not bind a Goal executor ticket when the workflow root has no matching leaf", async () => {
  const pi = createPi();
  const rpc = createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      return { text: "workflow spawned", details: { runId: "workflow-run-1", asyncDir: "/tmp/workflow-run-1" } };
    },
  });
  const bound = [];
  const ticket = {
    version: "goal-run-binding-ticket.v2",
    ticketId: "ticket-1",
    goalId: "goal-1",
    taskId: "task-1",
    attempt: 1,
    contractHash: "",
    workspaceId: "goal-timeout",
    executionRevision: 1,
    expectedCriteria: ["identity"],
    agentProfile: "executor",
    spawnIdentity: { requestId: "dispatch-1", spawnKey: "dispatch-1" },
  };
  let workspaceRequest;
  const workspaceService = {
    ensureAllocated(request) {
      return managedReceipt({
        workspaceId: request.workspaceId,
        owner: request.owner,
        requestedCwd: request.requestedCwd,
      });
    },
    bindRun() { throw new Error("timed out spawn must not bind a workspace run"); },
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "dispatch-1",
    workflowChildStartTimeoutMs: 10,
    workspaceService,
    goalExecutorCoordinator: {
      prepareSpawn(request) {
        workspaceRequest = {
          workspaceId: "goal-timeout",
          owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal-1", taskId: "task-1", attempt: 1, executionRevision: 1 },
          originRoot: "/repo",
          requestedCwd: "/repo",
          originRef: "refs/heads/main",
          baseCommit: "b".repeat(40),
          contractHash: request.contractHash,
          policy: { publication: "allowed", application: "allowed", writePaths: codingContract().writePaths },

        };
        return { ...ticket, contractHash: request.contractHash, workspaceRequest };
      },
      workspaceAllocated() {},
      confirmSpawn() {},
      bindSpawn(_ticket, binding) { bound.push(binding); },
    },
  });

  const result = await execute(pi.tools[0], codingContract({ worktree: true }));

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "WORKFLOW_CHILD_START_TIMEOUT");
  assert.deepEqual(bound, []);
});

test("standalone managed coding registers minimal Host authority before binding the workspace", async () => {
  const pi = createPi();
  const order = [];
  const registrations = [];
  const diagnostics = [];
  const rpc = createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      const [workflowKey, leaf] = JSON.parse(`[${params.script.match(/^return await runs\.run\((.*)\);$/s)[1]}]`);
      queueMicrotask(() => pi.events.emit("subagent:async-started", {
        parentWorkflowRunId: "workflow-managed", workflowKey, runId: "leaf-managed", asyncDir: "/tmp/leaf-managed",
        sessionId: "session-1", pid: 4242, agent: leaf.agent,
      }));
      return { details: { runId: "workflow-managed", asyncDir: "/tmp/workflow-managed" } };
    },
  });
  const workspaceService = {
    ensureAllocated(request) { order.push("allocate"); return managedReceipt({ workspaceId: request.workspaceId, owner: request.owner, run: null }); },
    bindRun({ run }) { order.push("bind"); return managedReceipt({ workspaceId: "standalone-managed", run }); },
  };
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, randomUUID: () => "standalone-managed", workspaceService,
    resolveRootSessionId: () => "root-1", resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    async registerAuthorizedRun(authorization) { order.push("grant"); registrations.push(authorization); },
    diagnosticSink(entry) { diagnostics.push(entry); },
  });

  const result = await execute(pi.tools[0], codingContract({ worktree: true }), { cwd: "/repo", sessionManager: {} });

  assert.equal(result.isError, false, result.content[0]?.text);

  assert.deepEqual(order, ["allocate", "grant", "bind"]);
  assert.deepEqual(registrations.map(({ kind, capabilities, goal, binding }) => ({ kind, capabilities, goal, binding })), [{
    kind: "coding", capabilities: ["root.subscribe"], goal: null,
    binding: { runId: "leaf-managed", asyncDir: "/tmp/leaf-managed", sessionId: "session-1", pid: 4242, agentProfile: "executor" },
  }]);
  const created = diagnostics.find((entry) => entry.phase === "grant-created");
  assert.equal(created.stage, "grant-registration");
  assert.match(created.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(created), /callerToken|token=/i);
});

test("standalone grant failure rejects dispatch, preserves the allocated workspace, and records redacted diagnostics", async () => {
  const pi = createPi();
  const diagnostics = [];
  let bound = 0;
  let allocated;
  const rpc = createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      const [workflowKey, leaf] = JSON.parse(`[${params.script.match(/^return await runs\.run\((.*)\);$/s)[1]}]`);
      queueMicrotask(() => pi.events.emit("subagent:async-started", {
        parentWorkflowRunId: "workflow-denied", workflowKey, runId: "leaf-denied", asyncDir: "/tmp/leaf-denied",
        sessionId: "session-1", pid: 4343, agent: leaf.agent,
      }));
      return { details: { runId: "workflow-denied", asyncDir: "/tmp/workflow-denied" } };
    },
  });
  const workspaceService = {
    ensureAllocated(request) { allocated = managedReceipt({ workspaceId: request.workspaceId, owner: request.owner, run: null }); return allocated; },
    bindRun() { bound += 1; throw new Error("must not bind after grant failure"); },
  };
  createTypedSubagentExtension(pi, {
    rpc, cleanupStore: {}, randomUUID: () => "standalone-denied", workspaceService,
    resolveRootSessionId: () => "root-1", resolveCanonicalOrigin: async () => "/repo",
    inspectWorkspaceSource: async () => ({ originRef: "refs/heads/main", baseCommit: "b".repeat(40) }),
    registerAuthorizedRun() { throw Object.assign(new Error("grant writer unavailable token=secret"), { code: "GRANT_WRITE_FAILED" }); },
    diagnosticSink(entry) { diagnostics.push(entry); },
  });

  const result = await execute(pi.tools[0], codingContract({ worktree: true }), { cwd: "/repo", sessionManager: {} });


  assert.equal(result.isError, true);
  assert.equal(result.details.code, "GRANT_WRITE_FAILED");
  assert.equal(bound, 0);
  assert.equal(allocated.state, "active");
  assert.equal(allocated.run, null);
  const failed = diagnostics.find((entry) => entry.phase === "grant-failed");
  assert.equal(failed.stage, "grant-registration");
  assert.match(failed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(failed), /secret|callerToken|token=/i);
});

test("independent Pi runtimes do not dispose each other", () => {
  const cleanupStore = {};
  const firstPi = createPi();
  const secondPi = createPi();
  const first = createRpc();
  const second = createRpc();

  createTypedSubagentExtension(firstPi, { rpc: first, cleanupStore });
  createTypedSubagentExtension(secondPi, { rpc: second, cleanupStore });

  assert.equal(first.disposed(), 0);
  assert.equal(second.disposed(), 0);
});

test("reload and shutdown dispose only the current RPC client", async () => {
  const pi = createPi();
  const cleanupStore = {};
  const first = createRpc();
  const second = createRpc();

  createTypedSubagentExtension(pi, { rpc: first, cleanupStore });
  const firstShutdown = pi.handlers.get("session_shutdown")[0];
  const current = createTypedSubagentExtension(pi, { rpc: second, cleanupStore });
  const secondShutdown = pi.handlers.get("session_shutdown")[1];

  await current.ready();
  assert.equal(first.disposed(), 1);
  await firstShutdown();
  assert.equal(second.disposed(), 0);
  await secondShutdown();
  assert.equal(second.disposed(), 1);
});

test("routes native Supervisor messages through the Root ingress callback", async () => {
  const pi = createPi();
  const calls = [];
  const ignoredMessage = { customType: "subagent-notify", content: "Unrelated" };
  const supervisorMessage = {
    customType: "subagent_supervisor_request",
    content: "Choose the target.",
    details: { id: "request-1", runId: "run-1" },
  };
  const ignoredContext = { cwd: "/ignored" };
  const supervisorContext = { cwd: "/repo", request: "exact" };

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      api.registerTool({ name: "subagent_supervisor", execute() {} });
    },
    onSupervisorRequest(message, context) { calls.push({ message, context }); },
    rpc: createRpc(), cleanupStore: {},
  });

  assert.deepEqual(pi.tools.map((tool) => tool.name), ["subagent", "subagent_worktree", "subagent_supervisor"]);
  for (const handler of pi.handlers.get("message_end") ?? []) await handler({ message: ignoredMessage }, ignoredContext);
  assert.deepEqual(calls, [], "unrelated native messages must be ignored");
  for (const handler of pi.handlers.get("message_end") ?? []) await handler({ message: supervisorMessage }, supervisorContext);
  assert.equal(calls.length, 1, "Root ingress must receive one native Supervisor message");
  assert.strictEqual(calls[0].message, supervisorMessage);
  assert.strictEqual(calls[0].context, supervisorContext);
});

test("configured supervisor control plane fences reply and steer delivery without changing its public tool schema", async () => {
  const pi = createPi();
  const rpc = createRpc();
  let nativeCalls = 0;
  const controlPlane = createSupervisorControlPlane({
    readOwnerReceipt: async (runId) => ({ runId, rootSessionId: "root-1", ownerGeneration: 1 }),
    readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 4, running: true, steerable: true }),
    randomId: () => "receipt-1",
  });
  const adapter = createSupervisorAdapter();
  adapter.bind(async () => { nativeCalls += 1; return { content: [{ type: "text", text: "native" }] }; });
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, supervisorAdapter: adapter, supervisorControlPlane: controlPlane });
  const ingress = pi.handlers.get("message_end")[0];
  await ingress({ message: { customType: "subagent_supervisor_request", details: { id: "request-1", runId: "run-1", reason: "needs approval" } } }, ctx);

  const blockedSteer = await pi.tools[0].execute("steer-1", { action: "steer", runId: "run-1", message: "approve" }, signal, undefined, ctx);
  assert.equal(blockedSteer.details.code, "SUPERVISOR_REPLY_REQUIRED");
  const absentReply = await pi.tools[2].execute("reply-absent", { action: "reply", replyTo: "missing", message: "approve" }, signal, undefined, ctx);
  assert.equal(absentReply.details.code, "SUPERVISOR_REQUEST_NOT_PENDING");

  const reply = await pi.tools[2].execute("reply-1", { action: "reply", replyTo: "request-1", message: "approve" }, signal, undefined, ctx);
  assert.equal(reply.isError, undefined);
  assert.equal(nativeCalls, 1);
  const repeated = await pi.tools[2].execute("reply-1", { action: "reply", replyTo: "request-1", message: "approve" }, signal, undefined, ctx);
  assert.equal(repeated.details.receiptId, "receipt-receipt-1");
  assert.equal(nativeCalls, 1);
  const duplicateSteer = await pi.tools[0].execute("steer-2", { action: "steer", runId: "run-1", message: "approve" }, signal, undefined, ctx);
  assert.equal(duplicateSteer.details.code, "SUPERVISOR_REPLY_REQUIRED");
  assert.equal(rpc.calls.filter((call) => call.method === "steer").length, 0);
});

// A worktree:false native ask has no broker owner receipt; Host session is its root authority.
// Removing the unowned registration/resolve branch must make this fail at the public reply boundary.
test("worktree:false unowned contact_supervisor ask registers and reply commits without interrupt/resume", async () => {
  const pi = createPi();
  let nativeCalls = 0;
  const plane = createSupervisorControlPlane({
    readOwnerReceipt: async () => { throw Object.assign(new Error("no broker owner for non-workspace run"), { code: "unknown_run" }); },
    readRuntime: async (runId) => ({ runId, running: true, steerable: true }), // no runtime.ownerGeneration
    randomId: () => "unowned-receipt",
  });
  const adapter = createSupervisorAdapter();
  adapter.bind(async () => { nativeCalls++; return { content: [{ type: "text", text: "native reply delivered" }] }; });
  const host = { cwd: "/repo", sessionManager: { getSessionId: () => "host-root-1" } };
  createTypedSubagentExtension(pi, { rpc: createRpc(), cleanupStore: {}, supervisorAdapter: adapter,
    supervisorControlPlane: plane, resolveRootSessionId: (sessionManager) => sessionManager.getSessionId() });
  const native = { id: "ask-unowned-1", runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", agent: "delegate", childIndex: 0,
    reason: "need decision", expectsReply: true }; // worktree:false is proven by broker unknown_run, not native message metadata
  await pi.handlers.get("message_end")[0]({ message: { customType: "subagent_supervisor_request", details: native } }, host);
  assert.equal(plane.listPending().length, 1, "ingress must register before reply");
  const blockedSteer = await pi.tools[0].execute("steer-while-pending", { action: "steer", runId: native.runId, message: "approved" }, signal, undefined, host);
  assert.equal(blockedSteer.details.code, "SUPERVISOR_REPLY_REQUIRED");
  const reply = await pi.tools[2].execute("reply-unowned-1", { action: "reply", replyTo: native.id, message: "approved" }, signal, undefined, host);
  assert.equal(reply.isError, undefined, `registration=${JSON.stringify(pi.messages.at(-1)?.details)}, reply=${JSON.stringify(reply.details)}`);
  assert.equal(plane.listPending().length, 1, "the native pending ask must register locally");
  assert.equal(pi.messages.some((message) => message.customType === "subagent_supervisor_registration_failed"), false);
  assert.equal(nativeCalls, 1);
  assert.equal(plane.snapshot().requests[0].state, "pending", "unconsumed delivery stays pending");
  const replay = await pi.tools[2].execute("reply-unowned-1", { action: "reply", replyTo: native.id, message: "approved" }, signal, undefined, host);
  assert.equal(replay.details.code, "SUPERVISOR_DELIVERY_IDEMPOTENT");
  assert.equal(replay.details.receiptId, "receipt-unowned-receipt");
  assert.equal(nativeCalls, 1);
  const request = plane.snapshot().requests[0];
  const intent = { schemaVersion: "supervisor-control-intent.v1", intentId: "reply-unowned-1", runId: native.runId,
    rootSessionId: "host-root-1", ownerGeneration: request.ownerGeneration, kind: "reply",
    requestId: native.id, requestGeneration: request.requestGeneration, payloadDigest: supervisorCanonicalDigest("approved") };
  const consumed = await plane.commitDelivery({ intent, consumed: true }, "host-root-1");
  assert.equal(consumed.status, "committed");
  assert.equal(consumed.receipt.receiptId, replay.details.receiptId);
  assert.equal(plane.listPending().length, 0);
  assert.equal(plane.snapshot().requests[0].state, "replied");
  const duplicateSteer = await pi.tools[0].execute("steer-duplicate-unowned", { action: "steer", runId: native.runId, message: "approved" }, signal, undefined, host);
  assert.equal(duplicateSteer.details?.code, "STEER_DUPLICATES_REPLY", JSON.stringify(duplicateSteer));
  const redundant = await plane.resolveSupervisorControl(intent, "host-root-1");
  assert.equal(redundant.status, "idempotent");
  assert.equal(redundant.receipt.receiptId, replay.details.receiptId);
  const absent = await pi.tools[2].execute("reply-unknown", { action: "reply", replyTo: "unknown-request", message: "approved" }, signal, undefined, host);
  assert.equal(absent.details.code, "SUPERVISOR_REQUEST_NOT_PENDING");
});

test("supervisor pending request survives a Host reload and can reply through commit idempotently", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "supervisor-reload-red-"));
  try {
    const options = {
      persistenceRoot: stateRoot,
      readOwnerReceipt: async () => { throw Object.assign(new Error("non-workspace"), { code: "unknown_run" }); },
      readRuntime: async (runId) => ({ runId, running: true }),
    };
    const native = { id: "reload-request-1", runId: "reload-run-1", reason: "approval", expectsReply: true };
    const first = createSupervisorControlPlane(options);
    const reloaded = createSupervisorControlPlane(options);
    const registered = await first.registerSupervisorRequest(native, "reload-root-1");
    assert.equal(registered.status, "registered");
    assert.equal((await readdir(stateRoot)).filter((entry) => entry.endsWith(".json")).length, 1, "registration must write durable state");
    const request = registered.request;
    const intent = {
      schemaVersion: "supervisor-control-intent.v1", intentId: "reload-reply-1", runId: native.runId,
      rootSessionId: request.rootSessionId, ownerGeneration: request.ownerGeneration, kind: "reply",
      requestId: request.requestId, requestGeneration: request.requestGeneration,
      payloadDigest: supervisorCanonicalDigest("reload-approved"),
    };
    assert.equal(await reloaded.ready("reload-root-1"), true);
    assert.equal(reloaded.listPending().length, 1, "a new control-plane instance must restore pending state");
    const committed = await reloaded.commitDelivery({ intent, consumed: true }, "reload-root-1");
    assert.equal(committed.status, "committed");
    assert.equal(reloaded.snapshot().requests[0].state, "replied");
    const replay = await reloaded.commitDelivery({ intent, consumed: true }, "reload-root-1");
    assert.equal(replay.status, "idempotent");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("supervisor persistence rejects cross-root, expired, and corrupted records observably", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "supervisor-reload-invalid-"));
  const diagnostics = [];
  try {
    const options = { persistenceRoot: stateRoot, diagnosticSink: (entry) => diagnostics.push(entry), now: () => 10_000,
      readOwnerReceipt: async () => { throw Object.assign(new Error("non-workspace"), { code: "unknown_run" }); } };
    const first = createSupervisorControlPlane(options);
    const registered = await first.registerSupervisorRequest({ id: "invalid-request-1", runId: "invalid-run-1", reason: "approval" }, "invalid-root-1");
    assert.equal(registered.status, "registered");
    const crossRoot = createSupervisorControlPlane(options);
    assert.equal(await crossRoot.ready("other-root"), true);
    assert.deepEqual(crossRoot.listPending(), []);
    const file = (await readdir(stateRoot)).find((entry) => entry.endsWith(".json"));
    const statePath = join(stateRoot, file);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.value.requests[0].requestDigest = `sha256:${"f".repeat(64)}`;
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const corrupted = createSupervisorControlPlane(options);
    assert.equal(await corrupted.ready("invalid-root-1"), false);
    assert.deepEqual(corrupted.listPending(), []);
    assert.equal(diagnostics.some((entry) => entry.type === "supervisor-persistence-corrupt"), true);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("unowned reply retains expiry, pending identity and Host root fences", async () => {
  let clock = 1_000;
  let root = "host-root-1";
  const plane = createSupervisorControlPlane({ readOwnerReceipt: async () => undefined, now: () => clock,
    readRuntime: async (runId) => ({ runId, running: true }) });
  const host = { sessionManager: { getSessionId: () => root } };
  const getRoot = (ctx) => ctx.sessionManager.getSessionId();
  const registered = await plane.registerSupervisorRequest({ id: "ask-1", runId: "run-1", reason: "approve" }, getRoot(host));
  assert.equal(registered.status, "registered");
  const intent = { schemaVersion: "supervisor-control-intent.v1", intentId: "reply-1", runId: "run-1",
    rootSessionId: registered.request.rootSessionId, ownerGeneration: registered.request.ownerGeneration,
    kind: "reply", requestId: "ask-1", requestGeneration: 1, payloadDigest: `sha256:${"a".repeat(64)}` };
  const mismatch = await plane.resolveSupervisorControl({ ...intent, requestGeneration: 2 }, getRoot(host));
  assert.equal(mismatch.code, "SUPERVISOR_REQUEST_NOT_PENDING");
  assert.equal((await plane.resolveSupervisorControl({ ...intent, requestId: "ask-missing" }, getRoot(host))).code, "SUPERVISOR_REQUEST_NOT_PENDING");
  assert.equal((await plane.resolveSupervisorControl({ ...intent, ownerGeneration: 2 }, getRoot(host))).code, "SUPERVISOR_STALE_OWNER");
  root = "other-host";
  assert.equal((await plane.resolveSupervisorControl(intent, getRoot(host))).code, "SUPERVISOR_STALE_OWNER");
  root = "host-root-1";
  clock += 21 * 60 * 1000;
  assert.equal((await plane.resolveSupervisorControl(intent, getRoot(host))).code, "SUPERVISOR_REQUEST_EXPIRED");
});

for (const scenario of [
  { name: "missing owner dependency", options: {} },
  { name: "broker not ready", options: { readOwnerReceipt: async () => { throw Object.assign(new Error("not ready"), { code: "authority_store_unavailable" }); } } },
]) {
  test(`unavailable (${scenario.name}) fails closed for registration and reply`, async () => {
    const plane = createSupervisorControlPlane(scenario.options);
    const result = await plane.registerSupervisorRequest({ id: "ask-1", runId: "run-1", reason: "approval" }, "host-root-1");
    assert.equal(result.code, "SUPERVISOR_OWNER_UNAVAILABLE");
    assert.deepEqual(plane.listPending(), []);
    const reply = await plane.resolveSupervisorControl({ schemaVersion: "supervisor-control-intent.v1", intentId: "reply-1",
      runId: "run-1", rootSessionId: "host-root-1", ownerGeneration: 1, kind: "reply", requestId: "ask-1",
      requestGeneration: 1, payloadDigest: `sha256:${"a".repeat(64)}` }, "host-root-1");
    assert.equal(reply.code, "SUPERVISOR_STALE_OWNER");
  });
}

test("owner authority loss after unowned registration cannot authorize reply or commit", async () => {
  let unavailable = false;
  const plane = createSupervisorControlPlane({ readOwnerReceipt: async () => {
    if (unavailable) throw Object.assign(new Error("broker not ready"), { code: "authority_store_unavailable" });
    throw Object.assign(new Error("non-workspace"), { code: "unknown_run" });
  } });
  const registered = await plane.registerSupervisorRequest({ id: "ask-1", runId: "run-1", reason: "approval" }, "host-root-1");
  assert.equal(registered.status, "registered");
  unavailable = true;
  const intent = { schemaVersion: "supervisor-control-intent.v1", intentId: "reply-1", runId: "run-1",
    rootSessionId: registered.request.rootSessionId, ownerGeneration: registered.request.ownerGeneration,
    kind: "reply", requestId: "ask-1", requestGeneration: 1, payloadDigest: `sha256:${"a".repeat(64)}` };
  assert.equal((await plane.resolveSupervisorControl(intent, "host-root-1")).code, "SUPERVISOR_STALE_OWNER");
  assert.equal((await plane.commitDelivery({ intent, consumed: true }, "host-root-1")).code, "SUPERVISOR_STALE_OWNER");
  assert.equal(plane.listPending().length, 1);
});

// Missing ingress registration must not turn a native-visible ask into a misleading NOT_PENDING reply.
for (const scenario of [
  { name: "owner authority unavailable", details: { id: "request-1", runId: "run-1", reason: "needs approval" }, ownerUnavailable: true, code: "SUPERVISOR_OWNER_UNAVAILABLE" },
  { name: "native request missing reason", details: { id: "request-1", runId: "run-1" }, code: "SUPERVISOR_REQUEST_IDENTITY_UNAVAILABLE" },
  { name: "registration throws", details: { id: "request-1", runId: "run-1", reason: "needs approval" }, throws: true, code: "SUPERVISOR_REQUEST_REGISTRATION_FAILED" },
]) {
  test(`native Supervisor ask with ${scenario.name} reports registration failure and actionable reply error`, async () => {
    const pi = createPi();
    const diagnostics = [];
    const realPlane = createSupervisorControlPlane({
      readOwnerReceipt: async (runId) => {
        if (scenario.ownerUnavailable) throw Object.assign(new Error("broker unavailable"), { code: "authority_store_unavailable" });
        return { runId, rootSessionId: "root-1", ownerGeneration: 1 };
      },
      readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 4, running: true, steerable: true }),
    });
    const controlPlane = scenario.throws ? {
      ...realPlane,
      async registerSupervisorRequest() { throw new Error("registration storage failed"); },
    } : realPlane;
    let nativeCalls = 0;
    const adapter = createSupervisorAdapter();
    adapter.bind(async () => { nativeCalls++; return { content: [{ type: "text", text: "native" }] }; });
    createTypedSubagentExtension(pi, { rpc: createRpc(), cleanupStore: {}, supervisorAdapter: adapter, supervisorControlPlane: controlPlane, diagnosticSink: (entry) => diagnostics.push(entry) });
    const ingress = pi.handlers.get("message_end")[0];
    await ingress({ message: { customType: "subagent_supervisor_request", details: scenario.details } }, ctx);
    assert.deepEqual(realPlane.snapshot().requests, []);
    const reply = await pi.tools[2].execute("reply-failed", { action: "reply", replyTo: "request-1", message: "approve" }, signal, undefined, ctx);
    assert.equal(reply.isError, true);
    assert.equal(reply.details.code, "SUPERVISOR_REQUEST_REGISTRATION_FAILED", `native-visible ask cannot reply; actual=${reply.details.code}, diagnostics=${diagnostics.length}, messages=${pi.messages.length}`);
    assert.equal(reply.details.registrationCode, scenario.code);
    assert.match(reply.content[0].text, /interrupt.*resume/i);
    assert.equal(diagnostics.at(-1)?.phase, "supervisor-registration-failed");
    assert.equal(diagnostics.at(-1)?.errorCode, scenario.code);
    assert.equal(diagnostics.at(-1)?.requestId, "request-1");
    if (scenario.throws) assert.equal(diagnostics.at(-1)?.error?.message, "registration storage failed");
    assert.equal(pi.messages.at(-1)?.details?.code, scenario.code, "parent must see failed registration without first trying reply");
    assert.equal(nativeCalls, 0);
  });
}

test("supervisor control plane diagnoses owner and runtime read failures without changing fail-closed states", async () => {
  const diagnostics = [];
  const ownerError = Object.assign(new Error("owner storage unavailable"), { code: "authority_store_unavailable", cause: new Error("disk offline") });
  const runtimeError = Object.assign(new Error("runtime lookup unavailable"), { code: "RUNTIME_READ_FAILED" });
  const plane = createSupervisorControlPlane({
    readOwnerReceipt: async () => { throw ownerError; },
    readRuntime: async () => { throw runtimeError; },
    diagnosticSink: (entry) => diagnostics.push(entry),
  });
  const identity = await plane.identityForRun("run-diagnostic-1");
  assert.equal(identity.ownerState, "unavailable");
  assert.equal(identity.runtime, undefined);
  assert.equal(diagnostics.find((entry) => entry.phase === "supervisor-owner-read-failed")?.error, ownerError);
  assert.equal(diagnostics.find((entry) => entry.phase === "supervisor-runtime-read-failed")?.error, runtimeError);
  assert.equal(diagnostics.find((entry) => entry.phase === "supervisor-owner-read-failed")?.cause, ownerError.cause);
});

test("supervisor delivery compensation preserves the primary error and diagnoses a blocked compensation", async () => {
  const pi = createPi();
  const diagnostics = [];
  const primary = new Error("native delivery failed");
  const compensation = new Error("durable compensation unavailable");
  const realPlane = createSupervisorControlPlane({
    readOwnerReceipt: async (runId) => ({ runId, rootSessionId: "root-1", ownerGeneration: 1 }),
    readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 1, running: true, steerable: true }),
    randomId: () => "compensation-receipt",
  });
  const plane = {
    ...realPlane,
    async commitDelivery(input, root) {
      if (input.success === false) throw compensation;
      return realPlane.commitDelivery(input, root);
    },
  };
  const adapter = createSupervisorAdapter();
  adapter.bind(async () => { throw primary; });
  createTypedSubagentExtension(pi, { rpc: createRpc(), cleanupStore: {}, supervisorAdapter: adapter, supervisorControlPlane: plane, diagnosticSink: (entry) => diagnostics.push(entry) });
  const ctxWithSession = { ...ctx, sessionManager: { getSessionId: () => "root-1" } };
  await pi.handlers.get("message_end")[0]({ message: { customType: "subagent_supervisor_request", details: { id: "compensation-request", runId: "run-compensation", reason: "approve" } } }, ctxWithSession);
  await assert.rejects(
    () => pi.tools[2].execute("reply-compensation", { action: "reply", replyTo: "compensation-request", message: "approved" }, signal, undefined, ctxWithSession),
    (error) => error instanceof AggregateError && error.cause === primary && error.errors.includes(primary) && error.errors.includes(compensation),
  );
  const diagnostic = diagnostics.find((entry) => entry.phase === "supervisor-delivery-compensation-failed");
  assert.equal(diagnostic?.error, primary);
  assert.equal(diagnostic?.cause, primary.cause);
  assert.equal(diagnostic?.secondaryError, compensation);
});

test("supervisor control plane fails closed for stale owners, expired requests, and non-running steers", async () => {
  async function createScenario({ now = () => 1_000, readOwnerReceipt, readRuntime } = {}) {
    const pi = createPi();
    const rpc = createRpc();
    const owner = readOwnerReceipt ?? (async (runId) => ({ runId, rootSessionId: "root-1", ownerGeneration: 1 }));
    const runtime = readRuntime ?? (async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 4, running: true, steerable: true }));
    const controlPlane = createSupervisorControlPlane({ readOwnerReceipt: owner, readRuntime: runtime, now, randomId: () => "receipt-1" });
    const adapter = createSupervisorAdapter();
    adapter.bind(async () => ({ content: [{ type: "text", text: "native" }] }));
    createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, supervisorAdapter: adapter, supervisorControlPlane: controlPlane });
    const ingress = pi.handlers.get("message_end")[0];
    await ingress({ message: { customType: "subagent_supervisor_request", details: { id: "request-1", runId: "run-1", reason: "needs approval" } } }, ctx);
    return { pi, controlPlane };
  }

  let owner = { rootSessionId: "root-1", ownerGeneration: 1 };
  const staleOwner = await createScenario({ readOwnerReceipt: async (runId) => ({ runId, ...owner }) });
  owner = { rootSessionId: "root-2", ownerGeneration: 2 };
  const staleReply = await staleOwner.pi.tools[2].execute("stale-owner", { action: "reply", replyTo: "request-1", message: "approve" }, signal, undefined, ctx);
  assert.equal(staleReply.details.code, "SUPERVISOR_STALE_OWNER");

  let clock = 1_000;
  const expired = await createScenario({ now: () => clock });
  clock += 21 * 60 * 1000;
  const expiredReply = await expired.pi.tools[2].execute("expired", { action: "reply", replyTo: "request-1", message: "approve" }, signal, undefined, ctx);
  assert.equal(expiredReply.details.code, "SUPERVISOR_REQUEST_EXPIRED");

  const notRunning = await createScenario({ readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 4, running: false, steerable: true }) });
  await notRunning.pi.tools[2].execute("consume-request", { action: "reply", replyTo: "request-1", message: "approve" }, signal, undefined, ctx);
  const blockedSteer = await notRunning.pi.tools[0].execute("not-running", { action: "steer", runId: "run-1", message: "follow up" }, signal, undefined, ctx);
  assert.equal(blockedSteer.details.code, "SUPERVISOR_REPLY_REQUIRED");

  const runtimeOwnerMismatch = await createScenario({ readRuntime: async (runId) => ({ runId, ownerGeneration: 2, liveRunEpoch: 4, running: true, steerable: true }) });
  const mismatchReply = await runtimeOwnerMismatch.pi.tools[2].execute("runtime-owner-mismatch", { action: "reply", replyTo: "request-1", message: "approve" }, signal, undefined, ctx);
  assert.equal(mismatchReply.details.code, "SUPERVISOR_STALE_OWNER");
});

// docs/bugs/2026-09-30-steer-blocked-for-non-workspace-runs.md：非 workspace run
// （coding worktree:false）无 broker owner receipt，主动 steer 不应被控制面以
// SUPERVISOR_INTENT_INVALID 拦截，而应透传到 rpc.steer 由上游投递。
test("steer on a run without a broker owner receipt bypasses the control plane and reaches rpc.steer", async () => {
  const pi = createPi();
  const rpc = createRpc();
  const controlPlane = createSupervisorControlPlane({
    readOwnerReceipt: async () => undefined,
    readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 4, running: true, steerable: true }),
    randomId: () => "receipt-1",
  });
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, supervisorControlPlane: controlPlane });
  const result = await pi.tools[0].execute("steer-no-owner", { action: "steer", runId: "run-1", message: "Continue please." }, signal, undefined, ctx);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.notEqual(result.details?.code, "SUPERVISOR_INTENT_INVALID", JSON.stringify(result));
  assert.deepEqual(rpc.calls.filter((call) => call.method === "steer"), [{ method: "steer", params: { runId: "run-1", message: "Continue please." } }]);
});

test("internal Supervisor target forwards the public two-argument handle through the native five-argument closure", async () => {
  const pi = createPi();
  const params = { action: "reply", replyTo: "native-1", message: "Proceed." };
  const context = { cwd: "/repo", request: "exact" };
  const result = { content: [{ type: "text", text: "native result" }] };
  let received;
  const installed = installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      api.registerTool({ name: "subagent_supervisor", execute(...args) { received = args; return result; } });
    },
    rpc: createRpc(), cleanupStore: {},
  });
  const executeSupervisor = typeof installed.executeSupervisor === "function"
    ? installed.executeSupervisor.bind(installed)
    : async () => undefined;
  const actual = await executeSupervisor(params, context);
  assert.strictEqual(actual, result, "runtime must expose its internal Supervisor target");
  assert.equal(typeof received?.[0], "string");
  assert.notEqual(received?.[0].length, 0);
  assert.strictEqual(received?.[1], params);
  assert.strictEqual(received?.[2], undefined);
  assert.strictEqual(received?.[3], undefined);
  assert.strictEqual(received?.[4], context);
});

test("buffers Supervisor requests until mailbox activation", async () => {
  const calls = [];
  let releaseFirst;
  const firstRouted = new Promise((resolve) => { releaseFirst = resolve; });
  const first = { id: "first" };
  const second = { id: "second" };
  const firstContext = { request: "first" };
  const secondContext = { request: "second" };
  const mailbox = createSupervisorRequestMailbox(async (message, context) => {
    calls.push({ message, context });
    if (message === first) await firstRouted;
  });

  mailbox.handle(first, firstContext);
  mailbox.handle(second, secondContext);
  assert.deepEqual(calls, []);

  const activation = mailbox.activate();
  await Promise.resolve();
  assert.equal(calls.length, 1, "activation must route the first queued request before the second");
  assert.strictEqual(calls[0].message, first);
  assert.strictEqual(calls[0].context, firstContext);
  releaseFirst();
  await activation;
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[1].message, second);
  assert.strictEqual(calls[1].context, secondContext);
});

test("routes Supervisor requests immediately after mailbox activation", async () => {
  const calls = [];
  const message = { id: "active" };
  const context = { request: "active" };
  const mailbox = createSupervisorRequestMailbox((receivedMessage, receivedContext) => {
    calls.push({ message: receivedMessage, context: receivedContext });
  });

  await mailbox.activate();
  mailbox.handle(message, context);
  await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0].message, message);
  assert.strictEqual(calls[0].context, context);
});

test("drops old-session Supervisor requests on mailbox deactivation", async () => {
  const calls = [];
  const oldMessage = { id: "old" };
  const oldContext = { request: "old" };
  const newMessage = { id: "new" };
  const newContext = { request: "new" };
  const mailbox = createSupervisorRequestMailbox((message, context) => {
    calls.push({ message, context });
  });

  mailbox.handle(oldMessage, oldContext);
  mailbox.deactivate();
  mailbox.handle(newMessage, newContext);
  await mailbox.activate();

  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0].message, newMessage);
  assert.strictEqual(calls[0].context, newContext);
});

test("fails closed when the Supervisor startup mailbox is full", async () => {
  const calls = [];
  const first = { id: "first" };
  const second = { id: "second" };
  const third = { id: "third" };
  const mailbox = createSupervisorRequestMailbox((message, context) => {
    calls.push({ message, context });
  }, { limit: 2 });

  mailbox.handle(first, { request: "first" });
  mailbox.handle(second, { request: "second" });
  assert.throws(
    () => mailbox.handle(third, { request: "third" }),
    (error) => error?.code === "SUPERVISOR_REQUEST_QUEUE_FULL"
      && error.message.includes("SUPERVISOR_REQUEST_QUEUE_FULL"),
  );

  await mailbox.activate();
  assert.deepEqual(calls.map(({ message }) => message), [first, second]);
});

test("preserves queued Supervisor order after mailbox route failure", async () => {
  const calls = [];
  const first = { id: 1 };
  const second = { id: 2 };
  const third = { id: 3 };
  let rejectFirst = true;
  const mailbox = createSupervisorRequestMailbox(async (message) => {
    calls.push(message.id);
    if (message === first && rejectFirst) {
      rejectFirst = false;
      throw new Error("controlled route failure");
    }
  });

  mailbox.handle(first, {});
  mailbox.handle(second, {});
  await assert.rejects(mailbox.activate(), /controlled route failure/);
  mailbox.handle(third, {});
  await mailbox.activate();

  assert.deepEqual(calls, [1, 2, 3], "reactivation must preserve the remaining queue order after the failed request");
});

test("keeps in-flight Supervisor routing isolated from mailbox deactivation", async () => {
  const calls = [];
  let releaseFirst;
  const firstRouted = new Promise((resolve) => { releaseFirst = resolve; });
  const mailbox = createSupervisorRequestMailbox(async (message) => {
    calls.push(message.id);
    if (message.id === 1) await firstRouted;
  });

  mailbox.handle({ id: 1 }, {});
  mailbox.handle({ id: 2 }, {});
  const activation = mailbox.activate();
  await Promise.resolve();
  mailbox.deactivate();
  releaseFirst();
  await activation;
  mailbox.handle({ id: 3 }, {});
  await mailbox.activate();

  assert.deepEqual(calls, [1, 3]);
});

test("installation rollback cleans the failed generation and restores hidden upstream ownership", async () => {
  const pi = createPi(); const cleanupStore = {}; const oldRuntime = { old: "runtime" }; const oldEvents = { old: "events" };
  let generatedRuntimeCleanups = 0; let generatedEventCleanups = 0;
  globalThis.__piSubagentRuntimeCleanup = oldRuntime;
  globalThis.__piSubagentEventUnsubscribes = oldEvents;
  try {
    installHeadlessTypedSubagentRuntime(pi, { cleanupStore, rpc: createRpc(), bootstrap() {}, async beforeRuntimeDispose() { throw new Error("old debt"); } });
    await assert.rejects(() => pi.handlers.get("session_shutdown")[0](), /old debt/);
    assert.throws(() => installHeadlessTypedSubagentRuntime(pi, {
      cleanupStore,
      rpc: createRpc(),
      bootstrap() {
        globalThis.__piSubagentRuntimeCleanup = () => { generatedRuntimeCleanups += 1; };
        globalThis.__piSubagentEventUnsubscribes = [() => { generatedEventCleanups += 1; }];
      },
      completionNotifierFactory() { throw new Error("notifier failure"); },
      resolveSessionId() { return "session"; },
    }), /notifier failure/);
    assert.equal(generatedRuntimeCleanups, 1);
    assert.equal(generatedEventCleanups, 1);
    assert.equal(globalThis.__piSubagentRuntimeCleanup, oldRuntime);
    assert.equal(globalThis.__piSubagentEventUnsubscribes, oldEvents);
  } finally {
    delete globalThis.__piSubagentRuntimeCleanup;
    delete globalThis.__piSubagentEventUnsubscribes;
  }
});

test("installation rollback preserves a newer owner written by another cleanup callback", async () => {
  const pi = createPi(); const cleanupStore = {}; const oldRuntime = { old: "runtime" }; const oldEvents = { old: "events" };
  const newerRuntime = { newer: "runtime" };
  globalThis.__piSubagentRuntimeCleanup = oldRuntime;
  globalThis.__piSubagentEventUnsubscribes = oldEvents;
  try {
    installHeadlessTypedSubagentRuntime(pi, { cleanupStore, rpc: createRpc(), bootstrap() {}, async beforeRuntimeDispose() { throw new Error("old debt"); } });
    await assert.rejects(() => pi.handlers.get("session_shutdown")[0](), /old debt/);
    assert.throws(() => installHeadlessTypedSubagentRuntime(pi, {
      cleanupStore,
      rpc: createRpc(),
      bootstrap() {
        globalThis.__piSubagentRuntimeCleanup = () => {};
        globalThis.__piSubagentEventUnsubscribes = [() => { globalThis.__piSubagentRuntimeCleanup = newerRuntime; }];
      },
      completionNotifierFactory() { throw new Error("notifier failure"); },
      resolveSessionId() { return "session"; },
    }), /notifier failure/);
    assert.equal(globalThis.__piSubagentRuntimeCleanup, newerRuntime);
    assert.equal(globalThis.__piSubagentEventUnsubscribes, oldEvents);
  } finally {
    delete globalThis.__piSubagentRuntimeCleanup;
    delete globalThis.__piSubagentEventUnsubscribes;
  }
});

test("installation rollback preserves a newer owner written by its own cleanup callback", async () => {
  const pi = createPi(); const cleanupStore = {}; const oldRuntime = { old: "runtime" }; const newerRuntime = { newer: "runtime" };
  globalThis.__piSubagentRuntimeCleanup = oldRuntime;
  delete globalThis.__piSubagentEventUnsubscribes;
  try {
    installHeadlessTypedSubagentRuntime(pi, { cleanupStore, rpc: createRpc(), bootstrap() {}, async beforeRuntimeDispose() { throw new Error("old debt"); } });
    await assert.rejects(() => pi.handlers.get("session_shutdown")[0](), /old debt/);
    assert.throws(() => installHeadlessTypedSubagentRuntime(pi, {
      cleanupStore,
      rpc: createRpc(),
      bootstrap() { globalThis.__piSubagentRuntimeCleanup = () => { globalThis.__piSubagentRuntimeCleanup = newerRuntime; }; },
      completionNotifierFactory() { throw new Error("notifier failure"); },
      resolveSessionId() { return "session"; },
    }), /notifier failure/);
    assert.equal(globalThis.__piSubagentRuntimeCleanup, newerRuntime);
  } finally {
    delete globalThis.__piSubagentRuntimeCleanup;
    delete globalThis.__piSubagentEventUnsubscribes;
  }
});

test("dispose retries only failed resources while continuing after an earlier failure", async () => {
  const pi = createPi(); const calls = []; let failSupervisor = true;
  createTypedSubagentExtension(pi, {
    cleanupStore: {},
    extraDisposables: [
      { dispose() { calls.push("supervisor"); if (failSupervisor) throw new Error("supervisor failed"); } },
      { dispose() { calls.push("extra"); } },
    ],
    rpc: createRpc({ dispose() { calls.push("rpc"); } }),
  });
  const shutdown = pi.handlers.get("session_shutdown")[0];
  await assert.rejects(() => shutdown(), AggregateError);
  assert.deepEqual(calls, ["supervisor", "extra", "rpc"]);
  failSupervisor = false;
  await shutdown();
  assert.deepEqual(calls, ["supervisor", "extra", "rpc", "supervisor"]);
});

test("lifecycle registration failure rolls back runtime debt, registry ownership, and RPC", async () => {
  const pi = createPi();
  const cleanupStore = {};
  const rpc = createRpc();
  const originalOn = pi.on;
  pi.on = (name, handler) => {
    if (name === "session_shutdown") throw new Error("shutdown registration failed");
    return originalOn.call(pi, name, handler);
  };

  assert.throws(
    () => createTypedSubagentExtension(pi, { cleanupStore, rpc }),
    /shutdown registration failed/,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rpc.disposed(), 1);
  assert.equal(cleanupStore.__typedSubagentRuntimeCleanup.has(pi), false);
  assert.equal(cleanupStore.__typedSubagentRuntimeShutdownDebt.debts.length, 0);
});

test("completion lifecycle projects normalized status children without changing raw lifecycle", () => {
  const emitted = [];
  const api = createHeadlessSubagentApi({ events: { emit(type, payload) { emitted.push({ type, payload }); }, on() {} } });
  const source = { state: "failed", success: true, results: [{ status: "completed", success: true, outputState: "present" }] };
  api.events.emit("subagent:async-complete", source);
  assert.equal(emitted[0].payload.state, "failed");
  assert.equal(emitted[0].payload.results[0].status, "completed");
  assert.equal(emitted[0].payload.presentation, "completed");
});

test("completion lifecycle adds a presentation projection without changing raw failed state", () => {
  const emitted = [];
  const api = createHeadlessSubagentApi({ events: { emit(type, payload) { emitted.push({ type, payload }); }, on() {} } });
  const source = { runId: "run-report", state: "failed", outputState: "RED", acceptance: { accepted: false }, output: "tests-only RED" };
  api.events.emit("subagent:async-complete", source);
  assert.equal(emitted[0].payload.state, "failed");
  assert.equal(emitted[0].payload.presentation, "reported");
  assert.equal(source.presentation, undefined);
});

// B1（docs/bugs/2026-09-30-steer-control-plane-target-aliasing.md）：授权目标必须与
// 上游实际投递目标一致。上游 resolveAsyncRunLocation 的优先级是 `params.id ?? params.runId`，
// 且支持 dir 单独定位、以及长度落在 [8,36) 的前缀扫描。本层若用相反的 `runId ?? id`
// 优先级、或跳过别名路径，就会对「查不到 owner 的标识」放行，而上游却 steer 到真实
// 受管 run，从而绕过 STALE_OWNER / REPLY_REQUIRED / DUPLICATES_REPLY 等全部围栏。
const FULL_RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_FULL_RUN_ID = "ffffffff-1111-2222-3333-444444444444";
const FULL_RUN_PREFIX = FULL_RUN_ID.slice(0, 8);

function createSteerScenario({ readOwnerReceipt, withOwnerDep = true } = {}) {
  const pi = createPi();
  const rpc = createRpc();
  const options = {
    readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 4, running: true, steerable: true }),
    randomId: () => "receipt-1",
  };
  if (withOwnerDep) options.readOwnerReceipt = readOwnerReceipt;
  const controlPlane = createSupervisorControlPlane(options);
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, supervisorControlPlane: controlPlane });
  return { pi, rpc };
}

const steerCalls = (rpc) => rpc.calls.filter((call) => call.method === "steer");

test("steer 拒绝 id 与 runId 冲突的别名目标，不得按其中一个放行", async () => {
  const { pi, rpc } = createSteerScenario({
    readOwnerReceipt: async (runId) => (runId === FULL_RUN_ID ? { runId, rootSessionId: "root-1", ownerGeneration: 1 } : undefined),
  });
  const result = await pi.tools[0].execute("steer-conflict", { action: "steer", id: FULL_RUN_ID, runId: OTHER_FULL_RUN_ID, message: "hi" }, signal, undefined, ctx);
  assert.equal(result.details.code, "SUPERVISOR_STEER_TARGET_CONFLICT", JSON.stringify(result));
  assert.deepEqual(steerCalls(rpc), [], "冲突目标绝不得投递");
});

test("steer 拒绝 dir 别名目标，避免绕过 owner 判定", async () => {
  const { pi, rpc } = createSteerScenario({ readOwnerReceipt: async (runId) => ({ runId, rootSessionId: "root-1", ownerGeneration: 1 }) });
  const result = await pi.tools[0].execute("steer-dir", { action: "steer", dir: `/tmp/async/${FULL_RUN_ID}`, message: "hi" }, signal, undefined, ctx);
  assert.equal(result.details.code, "SUPERVISOR_STEER_TARGET_ALIAS", JSON.stringify(result));
  assert.deepEqual(steerCalls(rpc), []);
});

test("steer 拒绝前缀形态 runId，避免授权目标与上游扫描解析结果不一致", async () => {
  const { pi, rpc } = createSteerScenario({
    readOwnerReceipt: async (runId) => (runId === FULL_RUN_ID ? { runId, rootSessionId: "root-1", ownerGeneration: 1 } : undefined),
  });
  const result = await pi.tools[0].execute("steer-prefix", { action: "steer", runId: FULL_RUN_PREFIX, message: "hi" }, signal, undefined, ctx);
  assert.equal(result.details.code, "SUPERVISOR_STEER_TARGET_AMBIGUOUS", JSON.stringify(result));
  assert.deepEqual(steerCalls(rpc), []);
});

test("owner 查询抛异常时 steer 必须 fail-closed，不得当作非受管放行", async () => {
  const { pi, rpc } = createSteerScenario({ readOwnerReceipt: async () => { throw new Error("ROOT_BROKER_UNAVAILABLE"); } });
  const result = await pi.tools[0].execute("steer-owner-error", { action: "steer", runId: FULL_RUN_ID, message: "hi" }, signal, undefined, ctx);
  assert.equal(result.details.code, "SUPERVISOR_OWNER_UNAVAILABLE", JSON.stringify(result));
  assert.deepEqual(steerCalls(rpc), []);
});

test("未接线 owner 读取依赖时 steer 必须 fail-closed", async () => {
  const { pi, rpc } = createSteerScenario({ withOwnerDep: false });
  const result = await pi.tools[0].execute("steer-no-dep", { action: "steer", runId: FULL_RUN_ID, message: "hi" }, signal, undefined, ctx);
  assert.equal(result.details.code, "SUPERVISOR_OWNER_UNAVAILABLE", JSON.stringify(result));
  assert.deepEqual(steerCalls(rpc), []);
});

test("明确非受管的精确 runId 仍可 steer 透传（原缺陷修复不得回归）", async () => {
  const { pi, rpc } = createSteerScenario({ readOwnerReceipt: async () => undefined });
  const result = await pi.tools[0].execute("steer-unowned", { action: "steer", runId: FULL_RUN_ID, message: "Continue please." }, signal, undefined, ctx);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(steerCalls(rpc), [{ method: "steer", params: { runId: FULL_RUN_ID, message: "Continue please." } }]);
});

test("受管精确 runId 在 id 与 runId 同值时仍走控制面并成功投递", async () => {
  const { pi, rpc } = createSteerScenario({ readOwnerReceipt: async (runId) => ({ runId, rootSessionId: "root-1", ownerGeneration: 1 }) });
  const result = await pi.tools[0].execute("steer-managed", { action: "steer", id: FULL_RUN_ID, runId: FULL_RUN_ID, message: "hi" }, signal, undefined, ctx);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(steerCalls(rpc).length, 1, "受管 run 经控制面放行后应投递一次");
});

// broker 对「无当前 owner receipt」的权威回答是抛 code=unknown_run；这是唯一可用于
// 「确认非受管」的信号。其余错误码都属「无法确认」，必须 fail-closed。
test("broker 抛 unknown_run 时判定为明确非受管并透传 steer", async () => {
  const { pi, rpc } = createSteerScenario({
    readOwnerReceipt: async () => { throw Object.assign(new Error("Owner is no longer current"), { code: "unknown_run" }); },
  });
  const result = await pi.tools[0].execute("steer-unknown-run", { action: "steer", runId: FULL_RUN_ID, message: "Continue please." }, signal, undefined, ctx);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(steerCalls(rpc).length, 1, "unknown_run 是权威的非受管信号，应透传投递");
});

test("broker 存储类错误一律 fail-closed，不得当作非受管放行", async () => {
  for (const code of ["authority_store_unavailable", "authority_lock_contention", "cas_conflict", "revoked", "unsupported_layout"]) {
    const { pi, rpc } = createSteerScenario({ readOwnerReceipt: async () => { throw Object.assign(new Error(code), { code }); } });
    const result = await pi.tools[0].execute(`steer-${code}`, { action: "steer", runId: FULL_RUN_ID, message: "hi" }, signal, undefined, ctx);
    assert.equal(result.details.code, "SUPERVISOR_OWNER_UNAVAILABLE", `${code} 必须 fail-closed，实际 ${JSON.stringify(result)}`);
    assert.deepEqual(steerCalls(rpc), [], `${code} 绝不得投递`);
  }
});

test("替换代偿失败携原异常诊断，ready 仍阻断并允许恢复重试", async () => {
  const pi = createPi(), cleanupStore = {}, diagnostics = [];
  const cause = new Error("存储不可用"), failure = new Error("旧代清理失败", { cause });
  let blocked = true, started = 0;
  createTypedSubagentExtension(pi, { rpc: createRpc(), cleanupStore, beforeDispose() { if (blocked) throw failure; } });
  const next = createTypedSubagentExtension(pi, { rpc: createRpc(), cleanupStore,
    diagnosticSink(entry) { diagnostics.push(entry); }, beforeSessionStart() { started++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(diagnostics[0]?.phase, "subagent-ready-debt-retry-failed");
  assert.equal(diagnostics[0]?.error, failure);
  assert.equal(diagnostics[0]?.cause, cause);
  await assert.rejects(next.ready({}, {}), error => error === failure);
  assert.equal(started, 0);
  blocked = false;
  await next.ready({}, {});
  assert.equal(started, 1);
  await next.dispose();
});

/* -------------------- D3：supervisor status/reply 只读诊断接线 -------------------- */

const SUPERVISOR_CANARY_PATH = "/Users/canary/.pi/sessions/child-canary.jsonl";
const SUPERVISOR_CANARY_BODY = "TASK-BODY-CANARY";
const SUPERVISOR_CANARY_DIGEST = `sha256:${"c".repeat(64)}`;
const SUPERVISOR_CANARIES = [SUPERVISOR_CANARY_PATH, SUPERVISOR_CANARY_BODY, SUPERVISOR_CANARY_DIGEST, "canary", "CANARY"];
/** root 不可验证时的唯一 fail-closed 包络；它绝不等于「无 pending」。 */
const UNAVAILABLE_DIAGNOSTIC = {
  schemaVersion: "supervisor-diagnostics.v1", availability: "unavailable",
  code: "SUPERVISOR_DIAGNOSTICS_UNAVAILABLE", requests: [], receipts: [], complete: false,
};
const DIAGNOSTIC_REQUEST_KEYS = ["createdAt", "expiresAt", "ownerGeneration", "requestGeneration", "requestId", "runId", "state"];
/** D2 的唯一 state 文件名（与 supervisor-control-plane.ts 的 stateKey 一致）。 */
const supervisorStateFile = (persistenceRoot, rootSessionId) =>
  join(persistenceRoot, `supervisor-${createHash("sha256").update(rootSessionId).digest("hex")}.json`);

const canaryError = () => Object.assign(new Error(`open '${SUPERVISOR_CANARY_PATH}' failed: ${SUPERVISOR_CANARY_BODY}`), {
  code: "authority_store_unavailable", cause: new Error(SUPERVISOR_CANARY_DIGEST),
});

function assertNoCanary(value, label) {
  const text = JSON.stringify(value) ?? "";
  for (const canary of SUPERVISOR_CANARIES) assert.equal(text.includes(canary), false, `${label} 泄漏 canary：${canary}`);
}

/** 合法 correlation（producer 形状），只用于验证敏感关联事实不进诊断投影。 */
function supervisorCorrelation() {
  return {
    asyncDir: SUPERVISOR_CANARY_PATH, pid: 7, lifecycleSessionId: "lifecycle-canary", processBirth: "7:1.5",
    sessionFile: SUPERVISOR_CANARY_PATH, childSessionId: "child-canary", toolCallId: "tool-canary",
    agent: "executor", childIndex: 0, reason: "need_decision", requestBodyDigest: SUPERVISOR_CANARY_DIGEST,
  };
}

const ownedPlaneOptions = (rootSessionId, overrides = {}) => ({
  readOwnerReceipt: async (runId) => ({ runId, rootSessionId, ownerGeneration: 1 }),
  readRuntime: async (runId) => ({ runId, ownerGeneration: 1, liveRunEpoch: 4, running: true, steerable: true }),
  ...overrides,
});
const unownedPlaneOptions = (overrides = {}) => ({
  readOwnerReceipt: async () => { throw Object.assign(new Error("non-workspace run"), { code: "unknown_run" }); },
  readRuntime: async (runId) => ({ runId, running: true, steerable: true }),
  ...overrides,
});

/** 经公开 createTypedSubagentExtension 组装一个 supervisor 工具现场（不改 production 接线）。 */
function createSupervisorScenario({ plane, native, rootSessionId = "diag-root-1", resolveRootSessionId, diagnosticSink }) {
  const pi = createPi();
  const adapter = createSupervisorAdapter();
  const nativeActions = [];
  adapter.bind(async (_toolCallId, params) => {
    nativeActions.push(params?.action);
    if (params?.action === "reply" && native?.throwWith) throw native.throwWith;
    return native?.result ?? { content: [{ type: "text", text: "native" }] };
  });
  createTypedSubagentExtension(pi, {
    rpc: createRpc(), cleanupStore: {}, supervisorAdapter: adapter, supervisorControlPlane: plane,
    ...(resolveRootSessionId === null ? {} : { resolveRootSessionId: resolveRootSessionId ?? ((sessionManager) => sessionManager.getSessionId()) }),
    ...(diagnosticSink ? { diagnosticSink } : {}),
  });
  const host = { cwd: "/repo", sessionManager: { getSessionId: () => rootSessionId } };
  const ingress = async (details) => pi.handlers.get("message_end")[0]({ message: { customType: "subagent_supervisor_request", details } }, host);
  const supervisor = (params) => pi.tools[2].execute("supervisor-tool-call", params, signal, undefined, host);
  const count = (action) => nativeActions.filter((entry) => entry === action).length;
  return { pi, host, ingress, supervisor, count, nativeActions };
}

test("supervisor status 透传 native content/details 并附本 root 的只读白名单诊断", async () => {
  const plane = createSupervisorControlPlane(ownedPlaneOptions("diag-root-1", { randomId: () => "status-receipt" }));
  const nativeResult = Object.freeze({
    content: Object.freeze([{ type: "text", text: "native status body" }]),
    isError: false,
    details: Object.freeze({ pending: 1, nativeField: "kept" }),
  });
  const scenario = createSupervisorScenario({ plane, native: { result: nativeResult } });
  await scenario.ingress({ id: "ask-b", runId: "run-b", agent: "executor", reason: "need_decision", expectsReply: true, correlation: supervisorCorrelation() });
  await scenario.ingress({ id: "ask-a", runId: "run-a", agent: "executor", reason: "need_decision", expectsReply: true });
  assert.deepEqual(scenario.pi.messages, [], "合法注册不得产生失败消息");

  const status = await scenario.supervisor({ action: "status" });
  assert.equal(status.content, nativeResult.content, "content 必须按引用原样透传，不改写 raw");
  assert.equal(status.isError, false);
  assert.equal(status.details.pending, 1, "原 details 字段完整保留");
  assert.equal(status.details.nativeField, "kept");
  assert.deepEqual(Object.keys(nativeResult.details).sort(), ["nativeField", "pending"], "native 结果对象不得被就地改写");
  const diagnostic = status.details.supervisorDiagnostic;
  assert.equal(diagnostic.schemaVersion, "supervisor-diagnostics.v1");
  assert.equal(diagnostic.availability, "available");
  assert.equal(diagnostic.complete, true);
  assert.equal("code" in diagnostic, false, "available 包络不带错误码");
  assert.deepEqual(diagnostic.requests.map((request) => request.requestId), ["ask-a", "ask-b"], "按 ID 稳定排序");
  for (const request of diagnostic.requests) assert.deepEqual(Object.keys(request).sort(), DIAGNOSTIC_REQUEST_KEYS, "request 投影只能是白名单字段");
  assert.deepEqual(diagnostic.receipts, []);
  assert.equal(scenario.count("status"), 1, "native status 只透传一次");
  assertNoCanary(diagnostic, "status 诊断");
});

test("supervisor status 的 replyTo 只作 requestId 过滤，只读且不触发 TTL 改写", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "supervisor-status-readonly-"));
  try {
    let clock = 1_000;
    const options = { ...ownedPlaneOptions("status-root-2"), persistenceRoot: stateRoot, now: () => clock };
    const seeding = createSupervisorControlPlane(options);
    assert.equal((await seeding.registerSupervisorRequest({ id: "ask-kept", runId: "run-kept", reason: "need_decision" }, "status-root-2")).status, "registered");
    assert.equal((await seeding.registerSupervisorRequest({ id: "ask-filtered", runId: "run-filtered", reason: "need_decision" }, "status-root-2")).status, "registered");
    const stateFile = supervisorStateFile(stateRoot, "status-root-2");
    const bytesBefore = await readFile(stateFile);
    const mtimeBefore = (await stat(stateFile)).mtimeMs;

    const realPlane = createSupervisorControlPlane(options);
    const readCalls = [];
    const plane = { ...realPlane, readDiagnostics: (root, filter) => { readCalls.push({ root, filter }); return realPlane.readDiagnostics(root, filter); } };
    const scenario = createSupervisorScenario({ plane, rootSessionId: "status-root-2" });
    // 远超 20 分钟 TTL：事务路径会改写 expired，只读诊断必须保持存储观察值。
    clock += 60 * 60 * 1000;
    const filtered = await scenario.supervisor({ action: "status", replyTo: "ask-kept" });
    assert.deepEqual(readCalls, [{ root: "status-root-2", filter: { requestId: "ask-kept" } }], "root 只能来自当前 Host authority，replyTo 只能作过滤");
    const diagnostic = filtered.details.supervisorDiagnostic;
    assert.equal(diagnostic.availability, "available");
    assert.deepEqual(diagnostic.requests.map((request) => [request.requestId, request.state]), [["ask-kept", "pending"]], "requestId 过滤只收窄，且不得把 TTL 后的 pending 改写为 expired");
    assert.deepEqual(diagnostic.receipts, []);

    const all = await scenario.supervisor({ action: "status" });
    assert.deepEqual(readCalls[1], { root: "status-root-2", filter: undefined }, "无 replyTo 时不传过滤条件");
    assert.deepEqual(all.details.supervisorDiagnostic.requests.map((request) => request.requestId), ["ask-filtered", "ask-kept"]);

    assert.deepEqual(await readFile(stateFile), bytesBefore, "只读诊断不得改变 durable state 字节");
    assert.equal((await stat(stateFile)).mtimeMs, mtimeBefore, "只读诊断不得改变 durable state mtime");
    // 对照：TTL 收敛仍只属于事务路径（loadRoot），只读诊断既不改写也不冒充。
    const intent = { schemaVersion: "supervisor-control-intent.v1", intentId: "ttl-probe", runId: "run-kept", rootSessionId: "status-root-2", ownerGeneration: 1, kind: "reply", requestId: "ask-kept", requestGeneration: 1, payloadDigest: supervisorCanonicalDigest("approved") };
    assert.equal((await realPlane.resolveSupervisorControl(intent, "status-root-2")).code, "SUPERVISOR_REQUEST_NOT_PENDING", "事务路径 loadRoot 已把过期 pending 收敛为 expired，TTL 判定未被诊断接线改变");
    assert.equal(realPlane.snapshot().requests.find((request) => request.requestId === "ask-kept").state, "expired");
    const afterTransaction = await realPlane.readDiagnostics("status-root-2", { requestId: "ask-kept" });
    assert.deepEqual(afterTransaction.requests.map((request) => [request.requestId, request.state]), [["ask-kept", "pending"]], "过期未写回存储：只读诊断仍报告存储观察值");
    assert.deepEqual(await readFile(stateFile), bytesBefore, "对照路径也未产生额外 durable 写入");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "root resolver 抛异常", resolveRootSessionId: () => { throw new Error("ROOT_SESSION_UNAVAILABLE"); } },
  { name: "未接线 root resolver", resolveRootSessionId: null },
  { name: "root resolver 返回非字符串", resolveRootSessionId: () => undefined },
  { name: "控制面未启用", enabled: () => false },
  { name: "控制面缺 readDiagnostics", withoutReadDiagnostics: true },
]) {
  test(`owner/root 不明（${scenario.name}）时 status 附 unavailable，不查询任何 root`, async () => {
    const realPlane = createSupervisorControlPlane(ownedPlaneOptions("other-root"));
    await realPlane.registerSupervisorRequest({ id: "ask-other", runId: "run-other", reason: "need_decision" }, "other-root");
    const readCalls = [];
    const plane = {
      ...realPlane,
      readDiagnostics: (root, filter) => { readCalls.push({ root, filter }); return realPlane.readDiagnostics(root, filter); },
      ...(scenario.enabled ? { enabled: scenario.enabled } : {}),
    };
    const exposed = scenario.withoutReadDiagnostics ? (() => { const { readDiagnostics: _ignored, ...rest } = plane; return rest; })() : plane;
    const nativeResult = { content: [{ type: "text", text: "native status" }], details: { nativeField: "kept" } };
    const fixture = createSupervisorScenario({ plane: exposed, native: { result: nativeResult }, rootSessionId: "diag-root-1", resolveRootSessionId: scenario.resolveRootSessionId });
    const status = await fixture.supervisor({ action: "status", replyTo: "ask-other" });
    assert.deepEqual(status.details.supervisorDiagnostic, UNAVAILABLE_DIAGNOSTIC, "unavailable 必须是固定 fail-closed 包络");
    assert.deepEqual(readCalls, [], "root 不可验证/控制面未启用时不得调用 readDiagnostics，也不得改查其它 root");
    assert.equal(status.content, nativeResult.content, "native content 原样透传");
    assert.equal(status.details.nativeField, "kept", "原 details 字段保留");
    assert.equal(fixture.count("status"), 1);
  });
}

for (const malformed of [
  { name: "非对象", value: "supervisor-diagnostics.v1" },
  { name: "错 schemaVersion", value: { schemaVersion: "supervisor-diagnostics.v2", availability: "available", requests: [], receipts: [], complete: true } },
  { name: "白名单外顶层键", value: { schemaVersion: "supervisor-diagnostics.v1", availability: "available", requests: [], receipts: [], complete: true, leaked: SUPERVISOR_CANARY_PATH } },
  { name: "request 行携带路径", value: { schemaVersion: "supervisor-diagnostics.v1", availability: "available", requests: [{ requestId: SUPERVISOR_CANARY_PATH, runId: "run-1", state: "pending", ownerGeneration: 1, requestGeneration: 1, createdAt: 1, expiresAt: 2 }], receipts: [], complete: true } },
  { name: "unavailable 却携带事实", value: { schemaVersion: "supervisor-diagnostics.v1", availability: "unavailable", code: "SUPERVISOR_DIAGNOSTICS_UNAVAILABLE", requests: [{ requestId: "ask-1", runId: "run-1", state: "pending", ownerGeneration: 1, requestGeneration: 1, createdAt: 1, expiresAt: 2 }], receipts: [], complete: false } },
  { name: "receipt 行缺 consumed", value: { schemaVersion: "supervisor-diagnostics.v1", availability: "available", requests: [], receipts: [{ schemaVersion: "supervisor-receipt-diagnostic.v1", receiptId: "receipt-1", runId: "run-1", status: "queued" }], complete: true } },
]) {
  test(`readDiagnostics 返回畸形包络（${malformed.name}）时 status fail closed 成 unavailable`, async () => {
    const plane = { readDiagnostics: async () => malformed.value, enabled: () => true };
    const status = await createSupervisorScenario({ plane }).supervisor({ action: "status" });
    assert.deepEqual(status.details.supervisorDiagnostic, UNAVAILABLE_DIAGNOSTIC);
    assertNoCanary(status.details, "status details");
  });
}

test("readDiagnostics 抛异常时 status 仍返回 native 结果并附 unavailable", async () => {
  const readCalls = [];
  const plane = { readDiagnostics: async (root) => { readCalls.push(root); throw canaryError(); }, enabled: () => true };
  const nativeResult = { content: [{ type: "text", text: "native status" }], isError: false, details: { nativeField: "kept" } };
  const status = await createSupervisorScenario({ plane, native: { result: nativeResult } }).supervisor({ action: "status" });
  assert.deepEqual(readCalls, ["diag-root-1"], "只查当前 Host root");
  assert.deepEqual(status.details.supervisorDiagnostic, UNAVAILABLE_DIAGNOSTIC);
  assert.equal(status.content, nativeResult.content);
  assert.equal(status.isError, false, "诊断失败不得把 status 变成错误结果");
  assertNoCanary(status, "status 结果");
});

test("supervisor reply 仅在 committed 后附 D0 receipt 投影：queued≠consumed，幂等/失败不伪装成功", async () => {
  const plane = createSupervisorControlPlane(unownedPlaneOptions({ randomId: () => "reply-receipt" }));
  const nativeResult = Object.freeze({ content: Object.freeze([{ type: "text", text: "native reply delivered" }]), details: Object.freeze({ nativeField: "kept" }) });
  const scenario = createSupervisorScenario({ plane, native: { result: nativeResult }, rootSessionId: "reply-root-1" });
  await scenario.ingress({ id: "ask-1", runId: "run-1", agent: "delegate", reason: "need_decision", expectsReply: true });

  const reply = await scenario.supervisor({ action: "reply", replyTo: "ask-1", message: "approved" });
  assert.equal(reply.content, nativeResult.content, "reply 文本与 native sender 结果原样");
  assert.equal(reply.details.nativeField, "kept");
  assert.equal("supervisorDiagnostic" in reply.details, false, "reply 不附 status 诊断");
  assert.deepEqual(reply.details.deliveryReceiptDiagnostic, {
    schemaVersion: "supervisor-receipt-diagnostic.v1", receiptId: "receipt-reply-receipt", runId: "run-1",
    requestId: "ask-1", status: "queued", consumed: false, requestGeneration: 1, ownerGeneration: 1,
  }, "只投影本次 committed.receipt，queued 不等于 consumed");
  assert.equal(scenario.count("reply"), 1);
  assert.equal(plane.snapshot().requests[0].state, "pending", "queued 回执不得声称 child 已消费");

  const replay = await scenario.supervisor({ action: "reply", replyTo: "ask-1", message: "approved" });
  assert.equal(replay.isError, true);
  assert.equal(replay.details.code, "SUPERVISOR_DELIVERY_IDEMPOTENT");
  assert.equal("deliveryReceiptDiagnostic" in replay.details, false, "幂等路径不得伪装成本次提交成功");
  assert.equal(scenario.count("reply"), 1, "幂等路径不得再次投递");

  // native 投递失败：抛原错误，只留下 failed 回执事实。
  const failing = createSupervisorScenario({ plane, native: { result: nativeResult, throwWith: new Error("native delivery failed") }, rootSessionId: "reply-root-1" });
  await failing.ingress({ id: "ask-2", runId: "run-2", agent: "delegate", reason: "need_decision", expectsReply: true });
  await assert.rejects(failing.supervisor({ action: "reply", replyTo: "ask-2", message: "approved" }), /native delivery failed/);

  // 终局消费：只有真实 observe 能把 queued 推进为 delivered/consumed。
  const consumed = await plane.observeReplyConsumption({ runId: "run-1", requestId: "ask-1", payloadDigest: supervisorCanonicalDigest("approved") }, "reply-root-1");
  assert.equal(consumed.status, "committed");
  assert.equal(consumed.receipt.consumed, true);
  const status = await scenario.supervisor({ action: "status" });
  const diagnostic = status.details.supervisorDiagnostic;
  assert.equal(diagnostic.availability, "available");
  assert.deepEqual(diagnostic.receipts.map((entry) => [entry.requestId, entry.status, entry.consumed]), [["ask-1", "delivered", true], ["ask-2", "failed", false]]);
  assert.deepEqual(diagnostic.requests.map((entry) => [entry.requestId, entry.state]), [["ask-1", "replied"], ["ask-2", "failed"]]);
  assert.equal("idempotencyKey" in diagnostic.receipts[0], false, "receipt 投影不得暴露 idempotencyKey");
  assertNoCanary(diagnostic, "status 诊断");
});

test("真实控制面 producer 经文件 sink 落盘 owner/runtime/persistence 诊断且 canary 不落盘", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-diagnostic-plane-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "supervisor-diagnostic-state-"));
  try {
    const file = join(directory, "trace.jsonl");
    await writeFile(file, "", { mode: 0o600 });
    const sink = createSubagentDispatchTraceFileSink(file);
    const error = canaryError();
    // owner-read-failed / runtime-read-failed：真实公开 identityForRun，且三态不变。
    const unavailablePlane = createSupervisorControlPlane({ diagnosticSink: sink, readOwnerReceipt: async () => { throw error; }, readRuntime: async () => { throw error; } });
    const identity = await unavailablePlane.identityForRun("run-diag-1");
    assert.equal(identity.ownerState, "unavailable", "诊断接线不得改变 fail-closed owner 三态");
    assert.equal(identity.runtime, undefined);
    // persistence-rejected：TTL 后真实 loadRoot producer。
    let clock = 1_000;
    const persistedOptions = { persistenceRoot: stateRoot, diagnosticSink: sink, now: () => clock, readOwnerReceipt: async () => { throw Object.assign(new Error("non-workspace"), { code: "unknown_run" }); } };
    const seeding = createSupervisorControlPlane(persistedOptions);
    assert.equal((await seeding.registerSupervisorRequest({ id: "ask-ttl", runId: "run-ttl", reason: "need_decision" }, "sink-root-1")).status, "registered");
    clock += 21 * 60 * 1000;
    const reloaded = createSupervisorControlPlane(persistedOptions);
    assert.equal(await reloaded.ready("sink-root-1"), true);
    assert.equal(reloaded.snapshot().requests[0].state, "expired", "TTL 判定仍由事务路径拥有");
    // persistence-corrupt：损坏 state 的真实 producer。
    const stateFile = supervisorStateFile(stateRoot, "sink-root-1");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.value.requests[0].requestDigest = `sha256:${"f".repeat(64)}`;
    await writeFile(stateFile, JSON.stringify(state));
    const corrupted = createSupervisorControlPlane(persistedOptions);
    assert.equal(await corrupted.ready("sink-root-1"), false);
    sink.dispose();

    const text = await readFile(file, "utf8");
    const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const phases = records.map((record) => record.phase);
    for (const expected of ["supervisor-owner-read-failed", "supervisor-runtime-read-failed", "supervisor-persistence-rejected", "supervisor-persistence-corrupt"]) {
      assert.ok(phases.includes(expected), `缺少真实 producer 诊断 ${expected}：${JSON.stringify(phases)}`);
    }
    for (const record of records) {
      assert.equal(record.version, 1);
      assert.equal(record.eventKind, "supervisor-diagnostic");
      assert.equal(Number.isSafeInteger(record.monotonicMs), true);
      assert.equal("error" in record || "cause" in record || "type" in record, false);
    }
    assert.equal(records.find((record) => record.phase === "supervisor-persistence-rejected").errorCode, "SUPERVISOR_REQUEST_EXPIRED");
    for (const canary of SUPERVISOR_CANARIES) assert.equal(text.includes(canary), false, `诊断文件泄漏 canary：${canary}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("真实 extension/replay producer 经文件 sink 落盘 registration/compensation/replay 诊断", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-diagnostic-extension-"));
  try {
    const file = join(directory, "trace.jsonl");
    await writeFile(file, "", { mode: 0o600 });
    const sink = createSubagentDispatchTraceFileSink(file);
    const error = canaryError();
    // registration-failed：真实 message_end ingress（owner authority 不可用）。
    const unavailablePlane = createSupervisorControlPlane({ diagnosticSink: sink, readOwnerReceipt: async () => { throw error; }, readRuntime: async () => { throw error; } });
    const registration = createSupervisorScenario({ plane: unavailablePlane, diagnosticSink: sink });
    await registration.ingress({ id: "ask-reg", runId: "run-reg", reason: "need_decision" });
    assert.equal(registration.pi.messages.at(-1)?.customType, "subagent_supervisor_registration_failed");
    assert.equal(registration.pi.messages.at(-1)?.details?.code, "SUPERVISOR_OWNER_UNAVAILABLE");
    // delivery-compensation-failed：真实 reply 链路 + 被阻塞的补偿提交。
    const realPlane = createSupervisorControlPlane({ ...unownedPlaneOptions(), diagnosticSink: sink, randomId: () => "compensation-receipt" });
    const blockedPlane = { ...realPlane, async commitDelivery(input, root) { if (input.success === false) throw error; return realPlane.commitDelivery(input, root); } };
    const compensation = createSupervisorScenario({ plane: blockedPlane, native: { result: { content: [{ type: "text", text: "native" }] }, throwWith: new Error("native delivery failed") }, rootSessionId: "compensation-root-1", diagnosticSink: sink });
    await compensation.ingress({ id: "ask-comp", runId: "run-comp", agent: "delegate", reason: "need_decision", expectsReply: true });
    await assert.rejects(compensation.supervisor({ action: "reply", replyTo: "ask-comp", message: "approved" }), /supervisor reply delivery and compensation failed/);
    // replay-failed：真实 createSupervisorReplay producer（当前无 production 实例化点）。
    // supervisor-replay.ts 依赖链上的 durable-contract.ts 使用 TS parameter property，
    // Node strip-only 模式无法直接 import，因此沿用本文件已有的 jiti 实例。
    const { createSupervisorReplay } = await runtimeJiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-replay.ts");
    const { createOwnerReceipt } = await runtimeJiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");
    const replay = createSupervisorReplay({
      outbox: {}, barrier: { beginReplayBarrier() { throw error; } }, consumerId: "supervisor-1",
      ownerValidator: async () => true, cursorValidator: async () => true,
      deliverySink: { async hasDelivered() { return false; }, async deliver() {} }, diagnosticSink: sink,
    });
    const replayed = await replay.replaySupervisor({
      rootSessionId: "root-1", runId: "run-1",
      ownerReceipt: createOwnerReceipt({ receiptId: "owner-1", rootSessionId: "root-1", runId: "run-1", ownerGeneration: 2, processBirth: "birth-1", revision: 1, authorizationReference: `sha256:${"a".repeat(64)}` }),
      after: { rootSessionId: "root-1", runId: "run-1", ownerGeneration: 2, epoch: 3, sequence: 0 }, batchSize: 1,
    });
    assert.equal(replayed.status, "blocked-unknown", "replay 失败仍 fail closed");
    sink.dispose();

    const text = await readFile(file, "utf8");
    const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const phases = records.map((record) => record.phase);
    for (const expected of ["supervisor-registration-failed", "supervisor-delivery-compensation-failed", "supervisor-replay-failed"]) {
      assert.ok(phases.includes(expected), `缺少真实 producer 诊断 ${expected}：${JSON.stringify(phases)}`);
    }
    const registrationRecord = records.find((record) => record.phase === "supervisor-registration-failed");
    assert.deepEqual({ ...registrationRecord, monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-registration-failed", monotonicMs: 0, requestId: "ask-reg", runId: "run-reg", errorCode: "SUPERVISOR_OWNER_UNAVAILABLE" });
    assert.deepEqual({ ...records.find((record) => record.phase === "supervisor-delivery-compensation-failed"), monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-delivery-compensation-failed", monotonicMs: 0 });
    for (const record of records) {
      assert.equal(record.version, 1);
      assert.equal(record.eventKind, "supervisor-diagnostic");
      assert.equal("error" in record || "cause" in record || "secondaryError" in record || "compensation" in record || "deliveryPhase" in record, false);
    }
    for (const canary of SUPERVISOR_CANARIES) assert.equal(text.includes(canary), false, `诊断文件泄漏 canary：${canary}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
