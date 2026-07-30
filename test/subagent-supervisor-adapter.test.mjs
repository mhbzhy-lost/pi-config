import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessSubagentApi } from "../scripts/lib/subagent-dispatch/runtime-membrane.ts";
import { installHeadlessTypedSubagentRuntime } from "../scripts/lib/subagent-dispatch/extension.ts";
import { installRootOwnedSubagent } from "../pi/child-extensions/root-owned-subagent.ts";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";

let supervisor = {};
try {
  supervisor = await import("../scripts/lib/subagent-dispatch/supervisor-adapter.ts");
} catch {}

const {
  createSupervisorAdapter,
  createSupervisorTool,
  SUPERVISOR_PARAMETERS,
} = supervisor;

function requireSupervisorApi() {
  assert.equal(typeof createSupervisorAdapter, "function");
  assert.equal(typeof createSupervisorTool, "function");
}

test("the membrane privately binds only the upstream supervisor execution closure", async () => {
  requireSupervisorApi();
  const projectSupervisor = createSupervisorTool(createSupervisorAdapter());
  const otherTool = { name: "read", execute() {} };
  const pi = {
    tools: [projectSupervisor, otherTool],
    getAllTools() { return [...this.tools]; },
    registerTool(tool) { this.tools.push(tool); },
  };
  const adapter = createSupervisorAdapter();
  const api = createHeadlessSubagentApi(pi, { supervisorAdapter: adapter });
  const result = { content: [{ type: "text", text: "active" }] };
  let receiver;
  const upstreamDefinition = {
    name: "subagent_supervisor",
    execute() {
      receiver = this;
      return result;
    },
  };

  assert.deepEqual(api.getAllTools().map((tool) => tool.name), ["read"]);
  api.registerTool({ name: "subagent", execute() {} });
  api.registerTool({ name: "subagent_wait", execute() {} });
  api.registerTool({ name: "intercom", execute() {} });
  api.registerTool(upstreamDefinition);

  assert.deepEqual(pi.tools, [projectSupervisor, otherTool]);
  assert.strictEqual(await adapter.execute("tool-1", { action: "status" }), result);
  assert.strictEqual(receiver, upstreamDefinition);
});

function createPi() {
  const tools = [];
  const handlers = new Map();
  return {
    tools,
    events: { on() { return () => {}; }, emit() {} },
    registerTool(tool) { tools.push(tool); },
    getAllTools() { return [...tools]; },
    on(name, handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    async emitLifecycle(name) {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name }, {});
    },
  };
}

test("headless installation exposes project tools and binds the session supervisor target", async () => {
  requireSupervisorApi();
  const pi = createPi();
  const upstreamResult = { content: [{ type: "text", text: "Native supervisor channel active." }] };
  let upstreamDefinition;
  const rpc = { dispose() {} };

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap(api) {
      api.registerTool({ name: "subagent", execute() {} });
      api.registerTool({ name: "subagent_wait", execute() {} });
      api.registerTool({ name: "intercom", execute() {} });
      api.on("session_start", () => {
        upstreamDefinition = {
          name: "subagent_supervisor",
          execute() { return upstreamResult; },
        };
        api.registerTool(upstreamDefinition);
      });
    },
    rpc,
    cleanupStore: {},
  });

  assert.deepEqual(pi.tools.map((tool) => tool.name), ["subagent", "subagent_supervisor"]);
  assert.notStrictEqual(pi.tools[1], upstreamDefinition);
  await pi.emitLifecycle("session_start");
  assert.notStrictEqual(pi.tools[1], upstreamDefinition);
  assert.strictEqual(await pi.tools[1].execute("tool-1", { action: "status" }), upstreamResult);
});

test("session start fails closed when upstream does not provide a supervisor target", async () => {
  const pi = createPi();

  installHeadlessTypedSubagentRuntime(pi, {
    bootstrap() {},
    rpc: { dispose() {} },
    cleanupStore: {},
  });

  await assert.rejects(pi.emitLifecycle("session_start"), /SUPERVISOR_TARGET_UNAVAILABLE/);
});

test("real ExtensionRunner reports and deactivates an unbound supervisor facade", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
  } = await import("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "unbound-supervisor-"));
  const errors = [];
  let result;

  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      extensionFactories: [
        (pi) => installHeadlessTypedSubagentRuntime(pi, {
          bootstrap() {},
          rpc: { dispose() {} },
          cleanupStore: {},
        }),
      ],
    });
    await loader.reload();
    result = await createAgentSession({
      cwd: root,
      agentDir: root,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    });
    await result.session.bindExtensions({
      mode: "rpc",
      shutdownHandler() {},
      onError(error) { errors.push(error); },
    });

    assert.ok(
      errors.some((error) => error.error === "SUPERVISOR_TARGET_UNAVAILABLE"),
      JSON.stringify(errors),
    );
    assert.ok(!result.session.getActiveToolNames().includes("subagent_supervisor"));
  } finally {
    if (result) {
      await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      result.session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("exports a project-owned static supervisor contract", () => {
  requireSupervisorApi();
  const adapter = createSupervisorAdapter();
  const tool = createSupervisorTool(adapter);

  assert.equal(tool.name, "subagent_supervisor");
  assert.strictEqual(tool.parameters, SUPERVISOR_PARAMETERS);
  assert.deepEqual(tool.parameters, {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { enum: ["reply", "pending", "status"] },
      to: { type: "string" },
      message: { type: "string" },
      replyTo: { type: "string" },
    },
  });
  assert.match(tool.description, /reply|pending|status/);
  assert.doesNotMatch(tool.description, /pi-subagents|upstream/i);
});

test("allows a unique project-owned supervisor name and label", () => {
  requireSupervisorApi();
  const tool = createSupervisorTool(createSupervisorAdapter(), {
    name: "plan_executor_supervisor",
    label: "Plan Executor Supervisor",
  });
  assert.equal(tool.name, "plan_executor_supervisor");
  assert.equal(tool.label, "Plan Executor Supervisor");
});

test("root-owned project supervisor calls only the broker and never the native supervisor", async () => {
  const pi = createPi();
  let nativeExecutions = 0;
  const calls = [];
  const rpc = { dispose() {}, supervisorPending() { calls.push("pending"); return { pending: [] }; }, supervisorReply(params) { calls.push(params); return { replied: true }; } };
  pi.registerTool({ name: "subagent_supervisor", execute() { nativeExecutions += 1; } });
  installRootOwnedSubagent(pi, { rootSessionId: "root", callerRunId: "run", createClient: () => rpc });
  assert.ok(pi.tools.some((tool) => tool.name === "subagent"));
  const project = pi.tools.find((tool) => tool.name === "plan_executor_supervisor");
  assert.ok(project);
  await project.execute("pending", { action: "pending" });
  await project.execute("status", { action: "status" });
  await project.execute("reply", { action: "reply", replyTo: "request-1", message: "go" });
  assert.deepEqual(calls, ["pending", "pending", { action: "reply", replyTo: "request-1", message: "go" }]);
  assert.equal(nativeExecutions, 0);
});

test("root-owned subagent passes its coding spawn identity resolver to the registered tool", async () => {
  const pi = createPi(); const resolverCalls = []; const spawnCalls = [];
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session", sessionFile: "/tmp/root-session", cwd: "/repo" } }; },
    async spawn(params, options) { spawnCalls.push({ params, options }); return { details: { runId: "rpc-run", asyncDir: "/tmp/rpc-run" } }; },
    async subscribe() { return { dispose() {} }; },
    supervisorPending() { return { pending: [] }; }, supervisorReply() { return { replied: true }; }, dispose() {},
  };
  const contract = {
    version: "dispatch-ir.v1", taskId: "durable-task", title: "Use durable identity", agent: "executor", risk: "normal", objective: "Preserve root-owned identity.", workflow: { mode: "tdd" }, requirements: ["Use the resolver."],
    context: { knownFacts: [], decisions: [], relevantFiles: ["test/subagent-supervisor-adapter.test.mjs"] }, boundaries: { writePaths: ["test/subagent-supervisor-adapter.test.mjs"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["identity"], commands: ["node --test"] }, execution: { cwd: "/repo", timeoutMs: 1000 },
  };
  const compiled = compileCodingDispatchIR(contract, { cwd: "/repo" });
  installRootOwnedSubagent(pi, {
    rootSessionId: "root", callerRunId: "run", createClient: () => rpc,
    resolveCodingSpawnIdentity(value) { resolverCalls.push(value); return { requestId: "durable-dispatch", spawnKey: "durable-dispatch" }; },
  });
  const tool = pi.tools.find((candidate) => candidate.name === "subagent");
  assert.ok(tool);
  const result = await tool.execute("root-tool-call", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, false);
  assert.deepEqual(resolverCalls, [{ toolCallId: "root-tool-call", contract, contractHash: compiled.hash }]);
  assert.deepEqual(spawnCalls[0].options, { requestId: "durable-dispatch", spawnKey: "durable-dispatch" });
  assert.equal(result.details.dispatchId, "durable-dispatch");
  assert.equal(result.details.runId, "rpc-run");
  assert.equal(result.details.asyncDir, "/tmp/rpc-run");
});

test("delegates every execution argument and the resolved result unchanged", async () => {
  requireSupervisorApi();
  const adapter = createSupervisorAdapter();
  const params = { action: "reply", replyTo: "request-1", message: "Proceed." };
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/repo" };
  const result = { content: [{ type: "text", text: "replied" }], details: { replyTo: "request-1" } };
  let received;

  adapter.bind((...args) => {
    received = args;
    return result;
  });

  const actual = await createSupervisorTool(adapter).execute("tool-1", params, signal, onUpdate, ctx);

  assert.deepEqual(received, ["tool-1", params, signal, onUpdate, ctx]);
  assert.strictEqual(received[1], params);
  assert.strictEqual(actual, result);
});

test("fails closed before binding, on duplicate binding, and after dispose", async () => {
  requireSupervisorApi();
  const adapter = createSupervisorAdapter();
  const execute = () => ({ content: [] });

  await assert.rejects(adapter.execute("tool-1", { action: "status" }), /SUPERVISOR_TARGET_UNAVAILABLE/);
  adapter.bind(execute);
  assert.throws(() => adapter.bind(execute), /SUPERVISOR_TARGET_ALREADY_BOUND/);
  adapter.dispose();
  await assert.rejects(adapter.execute("tool-1", { action: "status" }), /SUPERVISOR_TARGET_UNAVAILABLE/);
});

function lifecycleFixture({ subscribeError, lifecycleDedupeLimit } = {}) {
  const emitted = []; const messages = []; let subscribeCalls = 0; let closedCatchCalls = 0; let subscriptionDisposals = 0; let rpcDisposals = 0;
  const listeners = new Map();
  const pi = createPi();
  pi.events = {
    on(channel, listener) { const values = listeners.get(channel) ?? new Set(); values.add(listener); listeners.set(channel, values); return () => values.delete(listener); },
    emit(channel, event) { emitted.push([channel, event]); for (const listener of listeners.get(channel) ?? []) listener(event); },
  };
  pi.sendMessage = (message, options) => messages.push({ message, options });
  const closed = { catch(handler) { closedCatchCalls += 1; handler(new Error("closed")); return Promise.resolve(); } };
  const rpc = {
    dispose() { rpcDisposals += 1; },
    async subscribe(onPush) { subscribeCalls += 1; if (subscribeError) throw subscribeError; this.onPush = onPush; return { dispose() { subscriptionDisposals += 1; }, closed }; },
    supervisorPending() {}, supervisorReply() {},
  };
  const installed = installRootOwnedSubagent(pi, { rootSessionId: "root", callerRunId: "run", createClient: () => rpc, lifecycleDedupeLimit });
  return { emitted, messages, rpc, installed, closed: () => closedCatchCalls, subscribeCalls: () => subscribeCalls, subscriptionDisposals: () => subscriptionDisposals, rpcDisposals: () => rpcDisposals };
}

function started(dispatchId = "D1") { return { type: "execution.started", callerRunId: "run", data: { dispatchId, runId: "R1", state: "running" } }; }
function completed(dispatchId = "D1") { return { type: "execution.completed", callerRunId: "run", data: { dispatchId, runId: "R1", state: "observed" } }; }

test("root-owned lifecycle subscription API is installed", () => {
  const { installed } = lifecycleFixture();
  assert.equal(typeof installed.startLifecycleSubscription, "function");
});

test("root-owned lifecycle subscription subscribes once across consecutive starts", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.(); await subject.installed.startLifecycleSubscription?.();
  assert.equal(subject.subscribeCalls(), 1);
});

test("root-owned lifecycle mirrors started pushes as raw async-started data once", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.(); subject.rpc.onPush?.(started());
  assert.deepEqual(subject.emitted, [["subagent:async-started", started().data]]);
});

test("root-owned lifecycle mirrors completed pushes as raw async-complete data once", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.(); subject.rpc.onPush?.(completed());
  assert.deepEqual(subject.emitted, [["subagent:async-complete", completed().data]]);
});

test("root-owned lifecycle follow-up payload and options are exact", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.(); subject.rpc.onPush?.(completed());
  assert.deepEqual(subject.messages, [{ message: { customType: "pi-root-subagent-lifecycle-v1", content: "A lifecycle update arrived. Call plan_status.", details: { dispatchId: "D1", runId: "R1", state: "observed" } }, options: { triggerTurn: true, deliverAs: "followUp" } }]);
});

test("root-owned lifecycle dedupe evicts old dispatches at its bounded limit", async () => {
  const subject = lifecycleFixture({ lifecycleDedupeLimit: 2 });
  await subject.installed.startLifecycleSubscription?.();
  for (const dispatchId of ["D1", "D1", "D2", "D3", "D1"]) subject.rpc.onPush?.(completed(dispatchId));
  assert.equal(subject.messages.length, 4);
});

test("root-owned lifecycle consumes one successful subscription closed rejection", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.();
  assert.equal(subject.closed(), 1);
});

test("root-owned lifecycle disposal is idempotent for subscription and rpc", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.();
  subject.installed.dispose?.(); subject.installed.dispose?.();
  assert.equal(subject.subscriptionDisposals(), 1);
  assert.equal(subject.rpcDisposals(), 1);
});

test("root-owned lifecycle propagates initial subscription rejection", async () => {
  const subject = lifecycleFixture({ subscribeError: new Error("initial subscribe failed") });
  await assert.rejects(async () => subject.installed.startLifecycleSubscription?.(), /initial subscribe failed/);
});
