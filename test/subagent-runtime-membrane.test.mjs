import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessSubagentApi } from "../scripts/lib/subagent-dispatch/runtime-membrane.ts";
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
      commands: ["node --test test/subagent-runtime-membrane.test.mjs"],
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

test("project subagent tool retains the injected display-only result renderer", () => {
  const pi = createPi();
  const renderSubagentResult = () => undefined;

  createTypedSubagentExtension(pi, {
    rpc: createRpc(),
    cleanupStore: {},
    renderSubagentResult,
  });

  assert.equal(pi.tools[0].name, "subagent");
  assert.equal(pi.tools[0].renderResult, renderSubagentResult);
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

test("beforeDispose failure still disposes RPC and removes its cleanup entry", async () => {
  const pi = createPi();
  const order = [];
  const rpc = createRpc({ dispose() { order.push("dispose"); } });
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    async beforeDispose() { order.push("before"); throw new Error("close failed"); },
  });
  const shutdown = pi.handlers.get("session_shutdown")[0];
  await assert.rejects(() => shutdown(), /close failed/);
  await shutdown();
  assert.deepEqual(order, ["before", "dispose"]);
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
  assert.equal(schema.anyOf.length, 3);
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
      api.registerTool({ name: "subagent_wait", execute() {} });
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

test("executor and spark reject free-form task dispatch before RPC", async () => {
  const pi = createPi();
  const rpc = createRpc();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  const tool = pi.tools[0];

  for (const agent of ["executor", "spark"]) {
    const result = await execute(tool, { agent, task: "Implement it." });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "CODING_CONTRACT_REQUIRED");
  }
  assert.deepEqual(rpc.calls, []);
});

test("compiles a coding contract and returns a typed async handle", async () => {
  const pi = createPi();
  const rpc = createRpc();
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
    runId: "run-1",
    asyncDir: "/tmp/run-1",
  });
  assert.match(result.details.contractHash, /^[a-f0-9]{64}$/);
  assert.equal(spawn.params.agent, "executor");
  assert.equal(spawn.params.title, "Install the typed subagent runtime");
  assert.match(spawn.params.task, /^# Coding Dispatch Contract v1/m);
  assert.match(spawn.params.task, /## Authoritative Known Facts/);
  assert.equal(spawn.params.cwd, "/repo");
  assert.equal(spawn.params.context, "fresh");
  assert.equal(spawn.params.async, true);
  assert.equal(spawn.params.clarify, false);
  assert.equal(spawn.params.timeoutMs, 900_000);
  assert.deepEqual(spawn.params.acceptance.criteria, ["The main Agent sees only the project-owned facade."]);
  assert.doesNotMatch(result.content[0].text, /Authoritative Known Facts/);
  assert.equal(
    result.content[0].text,
    "Started executor: Install the typed subagent runtime (run-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  );
});

test("passes a non-coding agent prompt through RPC without rewriting it", async () => {
  const pi = createPi();
  const rpc = createRpc();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
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
  assert.deepEqual(spawn.params, params);
  assert.equal(spawn.params.task, task);
  assert.equal(result.details.title, "Review the diff");
  assert.equal(
    result.content[0].text,
    "Started reviewer: Review the diff (run-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  );
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

test("maps only approved control actions to RPC", async () => {
  const pi = createPi();
  const rpc = createRpc();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  const tool = pi.tools[0];

  for (const [action, params, expected] of [
    ["status", { action: "status", id: "run-1" }, { id: "run-1" }],
    ["steer", { action: "steer", runId: "run-1", message: "Continue." }, { runId: "run-1", message: "Continue." }],
    ["interrupt", { action: "interrupt", dir: "/tmp/run-1" }, { dir: "/tmp/run-1" }],
    ["stop", { action: "stop", id: "run-1" }, { id: "run-1" }],
  ]) {
    const result = await execute(tool, params);
    assert.equal(result.isError, false);
    assert.deepEqual(rpc.calls.at(-1), { method: action, params: expected });
  }

  const rejected = await execute(tool, { action: "resume", id: "run-1" });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.details.code, "UNSUPPORTED_ACTION");
});

test("fails closed when RPC capabilities or spawn identity are incomplete", async () => {
  for (const rpc of [
    createRpc({ ping: async () => ({ version: 1, methods: ["status"], session: { sessionId: "s", sessionFile: "/s", cwd: "/repo" } }) }),
    createRpc({ ping: async () => ({ version: 2, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/s", cwd: "/repo" } }) }),
    createRpc({ ping: async () => ({ version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: null, cwd: "/repo" } }) }),
    createRpc({ spawn: async () => ({ text: "missing handle", details: {} }) }),
  ]) {
    const pi = createPi();
    createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
    const result = await execute(pi.tools[0], codingContract());
    assert.equal(result.isError, true);
    assert.match(result.details.code, /CAPABILITY_MISMATCH|SPAWN_REPLY_INVALID/);
  }
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
  createTypedSubagentExtension(pi, { rpc: second, cleanupStore });
  const secondShutdown = pi.handlers.get("session_shutdown")[1];

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
