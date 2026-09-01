import assert from "node:assert/strict";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const runtimeJiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { createSubagentToolRenderers } = await runtimeJiti.import("../pi/extensions/subagent-runtime.ts");

import { createHeadlessSubagentApi } from "../scripts/lib/subagent-dispatch/runtime-membrane.ts";
import { createTitleRegistry } from "../scripts/lib/subagent-dispatch/title-registry.ts";
import {
  createSupervisorRequestMailbox,
  createTypedSubagentExtension,
  installHeadlessTypedSubagentRuntime,
} from "../scripts/lib/subagent-dispatch/extension.ts";

function codingContract(overrides = {}) {
  const base = {
    version: "dispatch-ir.v1",
    taskId: "typed-runtime",
    title: "Install the typed subagent runtime",
    agent: "executor",
    risk: "normal",
    objective: "Expose only the project-owned typed subagent facade.",
    workflow: { mode: "tdd" },
    requirements: ["Compile a deterministic initial child prompt."],
    context: {
      knownFacts: ["pi-subagents is an implementation dependency."],
      decisions: ["All execution crosses RPC v1."],
      relevantFiles: ["pi/extensions/subagent-runtime.ts"],
    },
    boundaries: {
      writePaths: ["pi/extensions/subagent-runtime.ts", "test/subagent-runtime-membrane.test.mjs"],
      excludedWork: ["Do not expose upstream package resources."],
      forbiddenActions: ["Do not call an upstream tool definition."],
    },
    acceptance: {
      criteria: ["The main Agent sees only the project-owned facade."],
    },
    execution: { timeoutMs: 900_000 },
  };
  return {
    ...base,
    ...overrides,
    workflow: { ...base.workflow, ...overrides.workflow },
    context: { ...base.context, ...overrides.context },
    boundaries: { ...base.boundaries, ...overrides.boundaries },
    acceptance: { ...base.acceptance, ...overrides.acceptance },
    execution: { ...base.execution, ...overrides.execution },
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
        session: { sessionId: "session-1", sessionFile: "/tmp/session.jsonl", cwd: "/repo" },
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

const ctx = { cwd: "/repo" };
const signal = new AbortController().signal;

async function execute(tool, params, context = ctx) {
  return tool.execute("tool-call-1", params, signal, undefined, context);
}

test("the headless membrane decorates lifecycle and grouped completion messages by run title", () => {
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
  api.sendMessage({ customType: "subagent-notify", content: "Background task completed: **delegate**\n\nDone" });

  assert.equal(emitted[0].payload.title, "First task");
  assert.equal(emitted[1].payload.title, "First task");
  assert.match(messages[0].content, /\*\*delegate\*\* \[First task\]/);
  assert.deepEqual(messages[0].details, { titles: ["First task"] });
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
  assert.match(visible[0].content, /\*\*delegate\*\* \[First task\]/);
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

test("grouped same-agent completions render each title in the header and matching numbered block", () => {
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

  api.sendMessage({
    customType: "subagent-notify",
    content: [
      "Background tasks completed (2): **delegate**, **delegate**",
      "",
      "1. delegate",
      "first result",
      "",
      "2. delegate",
      "second result",
    ].join("\n"),
  });

  assert.match(messages[0].content, /\*\*delegate\*\* \[First task\], \*\*delegate\*\* \[Second task\]/);
  assert.match(messages[0].content, /1\. delegate \[First task\]/);
  assert.match(messages[0].content, /2\. delegate \[Second task\]/);
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

test("spawn rendering keeps the complete execute result while showing one stateful call line", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "leaf-run-1", runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1",
      sessionId: "/tmp/session.jsonl", agent: "executor", pid: 102,
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
    ["subagent starting executor: Install the typed subagent runtime"],
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
  assert.deepEqual(statusCall.render(120), []);
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

  const schema = pi.tools[0].parameters;
  assert.equal(schema.type, "object");
  assert.equal(schema.anyOf.length, 5);
  for (const [index, branch] of schema.anyOf.entries()) {
    assert.equal(branch.type, "object", `anyOf branch ${index} must expose an object root`);
  }
});

test("headless runtime installation exposes only project-owned subagent tools", () => {
  const pi = createPi();
  const rpc = createRpc();
  let upstreamApi;

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      upstreamApi = api;
      api.registerTool({
        name: "subagent",
        description: "CHAIN PARALLEL proactive skill methodology",
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
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["subagent", "subagent_supervisor"]);
  assert.equal(pi.commands.length, 0);
  assert.doesNotMatch(pi.tools[0].description, /CHAIN|PARALLEL|proactive skill|Fable/i);
  assert.doesNotMatch(pi.tools[1].description, /pi-subagents|upstream/i);
});

test("headless installation wires the title-aware completion notifier to session lifecycle", async () => {
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
  assert.match(pi.messages[0].content, /\*\*delegate\*\* \[Observed task\]/);

  for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" });
  assert.equal(notifierDisposals, 1);
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
  assert.match(pi.messages[0].content, /\*\*delegate\*\* \[First task\]/);
  assert.match(pi.messages[1].content, /\*\*delegate\*\* \[Second task\]/);
  assert.equal(registry.takeCompleted("delegate"), undefined, "each completion must enqueue one title only");
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
      sessionId: "/tmp/session.jsonl", pid: 101, agent: "reviewer", workflowKey: "typed-notify-1", parentWorkflowRunId: "workflow-root-1",
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
  assert.match(pi.messages[0].content, /\*\*delegate\*\* \[真实业务\]/);
  assert.match(pi.messages[0].content, /业务摘要/);

  upstreamApi.events.emit("subagent:async-complete", { runId: "user-workflow", agent: "workflow", success: true, sessionId: "session-1", summary: "用户 workflow" });
  for (const state of ["failed", "paused", "stopped"]) {
    upstreamApi.events.emit("subagent:async-complete", { runId: "workflow-root-1", agent: "workflow", success: false, state, sessionId: "session-1", summary: state });
  }
  assert.deepEqual(delivered, ["leaf-run-1", "user-workflow", "workflow-root-1", "workflow-root-1", "workflow-root-1"]);
  assert.equal(pi.messages.length, 5, "unrelated workflow and internal non-success states remain visible");
});

test("executor rejects free-form task dispatch before RPC", async () => {
  const pi = createPi();
  const rpc = createRpc();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  const tool = pi.tools[0];

  for (const agent of ["executor"]) {
    const result = await execute(tool, { agent, task: "Implement it." });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "CODING_CONTRACT_REQUIRED");
  }
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
      sessionId: "/tmp/session.jsonl",
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
    taskId: "typed-runtime",
    agent: "executor",
    title: "Install the typed subagent runtime",
    contractHash: result.details.contractHash,
    runId: "leaf-run-1",
    asyncDir: "/tmp/leaf-run-1",
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
  assert.equal(spawn.params.timeoutMs, 900_000);
  assert.match(spawn.params.workflowScript, /runs\.run\("typed-dispatch-1"/);
  assert.match(spawn.params.workflowScript, /# Coding Dispatch Contract v1/);
  assert.match(spawn.params.workflowScript, /"level":"checked"/);
  assert.doesNotMatch(spawn.params.workflowScript, /"verify"/);
  assert.doesNotMatch(result.content[0].text, /Authoritative Known Facts/);
  assert.equal(
    result.content[0].text,
    "Started executor: Install the typed subagent runtime (leaf-run-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  );
});

test("coding continuation dispatch rebinds its managed workspace run", async () => {
  const pi = createPi();
  const rpc = createRpc();
  const bindings = [];
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "continuation-leaf-1",
      runId: "continuation-leaf-1",
      asyncDir: "/tmp/continuation-leaf-1",
      sessionId: "/tmp/session.jsonl",
      agent: "executor", pid: 103,
      workflowKey: "typed-continuation-1",
      parentWorkflowRunId: "continuation-workflow-1",
    });
    return { details: { runId: "continuation-workflow-1", asyncDir: "/tmp/continuation-workflow-1" } };
  };
  const workspaceController = {
    bindManagedSubagentWorkspaceRun(workspace, binding) { bindings.push({ workspace, binding }); },
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "continuation-1",
    workspaceController,
    resolveCanonicalOrigin: async () => "/repo",
  });

  const result = await execute(pi.tools[0], codingContract({
    execution: {
      timeoutMs: 900_000,
      cwd: "/repo/.state/subagent-dispatch/worktrees/workspace-1/sub",
      worktree: false,
    },
  }));

  assert.equal(result.isError, false);
  assert.deepEqual(bindings, [{
    workspace: { originRoot: "/repo", workspaceId: "workspace-1" },
    binding: { runId: "continuation-leaf-1", asyncDir: "/tmp/continuation-leaf-1" },
  }]);
});

test("compiles a non-coding agent prompt into one workflow leaf without rewriting its task", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "leaf-review-1",
      runId: "leaf-review-1",
      asyncDir: "/tmp/leaf-review-1",
      sessionId: "/tmp/session.jsonl",
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
    timeoutMs: 60_000,
    output: false,
  };

  const result = await execute(pi.tools[0], params);
  const spawn = rpc.calls.find((call) => call.method === "spawn");

  assert.equal(result.isError, false);
  for (const key of ["agent", "title", "task", "clarify", "acceptance"]) {
    assert.equal(Object.hasOwn(spawn.params, key), false, `${key} must not reach public RPC spawn`);
  }
  assert.equal(spawn.params.workflowScript.includes(task), false, "task must be JSON-escaped inside the workflow script");
  assert.match(spawn.params.workflowScript, /Review exactly this diff\.\\nPreserve this whitespace/);
  assert.equal(result.details.runId, "leaf-review-1");
  assert.equal(result.details.asyncDir, "/tmp/leaf-review-1");
  assert.equal(result.details.title, "Review the diff");
  assert.equal(
    result.content[0].text,
    "Started reviewer: Review the diff (leaf-review-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  );
});

test("uses a bounded fallback while waiting for a generic leaf without input timeout", async () => {
  const pi = createPi();
  const rpc = createRpc();
  rpc.spawn = async (params) => {
    rpc.calls.push({ method: "spawn", params });
    pi.events.emit("subagent:async-started", {
      id: "fallback-leaf-1", runId: "fallback-leaf-1", asyncDir: "/tmp/fallback-leaf-1",
      sessionId: "/tmp/session.jsonl", pid: 104, agent: "reviewer", workflowKey: "typed-fallback-1", parentWorkflowRunId: "workflow-fallback-1",
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

  for (const title of [undefined, "line\nbreak"]) {
    const result = await execute(pi.tools[0], { agent: "delegate", task: "Inspect", ...(title === undefined ? {} : { title }) });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, title === undefined ? "INVALID_GENERIC_DISPATCH" : "INVALID_TITLE");
  }
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

test("workspace_status text exposes action token and blocked reasons", async () => {
  const pi = createPi();
  const workspaceController = {
    loadManagedSubagentWorkspace() { return { workspaceId: "workspace-1", state: "active", runId: "run-1" }; },
    statusManagedSubagentWorkspace() {
      return {
        workspaceId: "workspace-1",
        state: "active",
        allowedDispositions: ["preserve", "discard"],
        actionToken: "once-token",
        integrateBlockedReasons: ["no-commits"],
      };
    },
  };
  createTypedSubagentExtension(pi, {
    rpc: createRpc(), cleanupStore: {}, workspaceController,
    inspectFacadeTerminalProof: async () => ({ state: "observed" }),
    resolveCanonicalOrigin: async () => "/repo",
  });

  const result = await execute(pi.tools[0], { action: "workspace_status", workspace_id: "workspace-1" });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /"workspace_id":"workspace-1"/);
  assert.match(result.content[0].text, /"state":"active"/);
  assert.match(result.content[0].text, /"action_token":"once-token"/);
  assert.match(result.content[0].text, /"allowed_dispositions":\["preserve","discard"\]/);
  assert.match(result.content[0].text, /"integrate_blocked_reasons":\["no-commits"\]/);
});

test("workspace_disposition release is accepted and releases preserved workspace", async () => {
  const pi = createPi();
  const releases = [];
  const workspaceController = {
    loadManagedSubagentWorkspace() { return { workspaceId: "workspace-1", state: "preserved", runId: null }; },
    releaseManagedSubagentWorkspace(input) {
      releases.push(input);
      return { workspaceId: "workspace-1", state: "released" };
    },
    disposeManagedSubagentWorkspace() { throw new Error("release must not dispose through action token path"); },
  };
  createTypedSubagentExtension(pi, {
    rpc: createRpc(), cleanupStore: {}, workspaceController,
    resolveCanonicalOrigin: async () => "/repo",
  });
  const tool = pi.tools[0];
  const dispositionSchema = tool.parameters.anyOf.find((branch) => branch.properties?.action?.const === "workspace_disposition");

  assert.ok(dispositionSchema.properties.disposition.enum.includes("release"));
  const result = await execute(tool, { action: "workspace_disposition", workspace_id: "workspace-1", disposition: "release" });

  assert.equal(result.isError, false);
  assert.equal(result.details.state, "released");
  assert.deepEqual(releases, [{ originRoot: "/repo", workspaceId: "workspace-1" }]);
});

test("uses persistent sessionFile identity for workflow leaf correlation and falls back for --no-session", async () => {
  const persistentPi = createPi();
  const persistentRpc = createRpc({
    ping: async () => ({ version: 1, methods: ["spawn"], session: { sessionId: "logical-session-id", sessionFile: "/var/sessions/persistent.jsonl", cwd: "/repo" } }),
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      persistentPi.events.emit("subagent:async-started", {
        id: "persistent-leaf", runId: "persistent-leaf", asyncDir: "/tmp/persistent-leaf",
        sessionId: "/var/sessions/persistent.jsonl", pid: 105, agent: "executor",
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
    assert.match(result.details.code, /CAPABILITY_MISMATCH|SPAWN_REPLY_INVALID/);
  }
});

test("uses the coding IR deadline when a delayed leaf exceeds the former fixed start limit", async () => {
  const pi = createPi();
  const rpc = createRpc({
    async spawn(params) {
      this.calls.push({ method: "spawn", params });
      setTimeout(() => pi.events.emit("subagent:async-started", {
        id: "delayed-leaf-1",
        runId: "delayed-leaf-1",
        asyncDir: "/tmp/delayed-leaf-1",
        sessionId: "/tmp/session.jsonl",
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

  const result = await execute(pi.tools[0], codingContract({ execution: { timeoutMs: 50 } }));

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
    ticketId: "ticket-1",
    spawnIdentity: { requestId: "dispatch-1", spawnKey: "dispatch-1" },
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "dispatch-1",
    workflowChildStartTimeoutMs: 10,
    goalExecutorCoordinator: {
      prepareSpawn() { return ticket; },
      bindSpawn(_ticket, binding) { bound.push(binding); },
    },
  });

  const result = await execute(pi.tools[0], codingContract());

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "WORKFLOW_CHILD_START_TIMEOUT");
  assert.deepEqual(bound, []);
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

  assert.deepEqual(pi.tools.map((tool) => tool.name), ["subagent", "subagent_supervisor"]);
  for (const handler of pi.handlers.get("message_end") ?? []) await handler({ message: ignoredMessage }, ignoredContext);
  assert.deepEqual(calls, [], "unrelated native messages must be ignored");
  for (const handler of pi.handlers.get("message_end") ?? []) await handler({ message: supervisorMessage }, supervisorContext);
  assert.equal(calls.length, 1, "Root ingress must receive one native Supervisor message");
  assert.strictEqual(calls[0].message, supervisorMessage);
  assert.strictEqual(calls[0].context, supervisorContext);
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
