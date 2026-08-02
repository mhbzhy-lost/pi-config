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
    async emitLifecycle(name, ctx = {}) {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
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
    rootSessionId: "root", callerRunId: "run", createClient: () => rpc, prepareCodingSpawn: async () => {},
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

test("root-owned subagent forwards injected coding prepare to its registered tool", async () => {
  const pi = createPi(); const prepared = [];
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session", sessionFile: "/tmp/root-session", cwd: "/repo" } }; },
    async spawn() { return { details: { runId: "rpc-run", asyncDir: "/tmp/rpc-run" } }; },
    supervisorPending() {}, supervisorReply() {}, dispose() {},
  };
  installRootOwnedSubagent(pi, { rootSessionId: "root", callerRunId: "run", createClient: () => rpc, async prepareCodingSpawn(ir) { prepared.push(ir); } });
  const tool = pi.tools.find((candidate) => candidate.name === "subagent");
  const input = { version: "dispatch-ir.v1", taskId: "prepared-task", title: "Prepare entry", agent: "executor", risk: "normal", objective: "Prepare owner entry.", workflow: { mode: "tdd" }, requirements: ["Prepare."], context: { knownFacts: [], decisions: [], relevantFiles: [] }, boundaries: { writePaths: ["test/subagent-supervisor-adapter.test.mjs"], excludedWork: [], forbiddenActions: [] }, acceptance: { criteria: ["prepared"], commands: ["node --test"] }, execution: { cwd: "/repo", timeoutMs: 1000 } };
  await tool.execute("prepared-call", input, undefined, undefined, { cwd: "/repo" });
  assert.equal(prepared.length, 1); assert.equal(prepared[0].taskId, "prepared-task");
});

test("root-owned default preparer materializes a private canonical owner wrapper", async () => {
  const { access, mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "root-owned-entry-"));
  const pi = createPi();
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session", sessionFile: "/tmp/root-session", cwd: root } }; },
    async spawn() { return { details: { runId: "rpc-run", asyncDir: "/tmp/rpc-run" } }; },
    supervisorPending() {}, supervisorReply() {}, dispose() {},
  };
  try {
    installRootOwnedSubagent(pi, { rootSessionId: "root", callerRunId: "run", createClient: () => rpc });
    const tool = pi.tools.find((candidate) => candidate.name === "subagent");
    const input = { version: "dispatch-ir.v1", taskId: "materialized-task", title: "Materialize entry", agent: "executor", risk: "normal", objective: "Materialize owner entry.", workflow: { mode: "tdd" }, requirements: ["Materialize."], context: { knownFacts: [], decisions: [], relevantFiles: [] }, boundaries: { writePaths: ["test/subagent-supervisor-adapter.test.mjs"], excludedWork: [], forbiddenActions: [] }, acceptance: { criteria: ["materialized"], commands: ["node --test"] }, execution: { cwd: root, timeoutMs: 1000 } };
    const entry = join(root, ".pi-subagents", "root-session-owner-entry.mjs");
    await tool.execute("spark-call", { ...input, taskId: "spark-task", agent: "spark" }, undefined, undefined, { cwd: root });
    await assert.rejects(access(entry));
    await tool.execute("materialized-call", input, undefined, undefined, { cwd: root });
    const source = await readFile(entry, "utf8"); const target = new URL("../pi/child-extensions/root-session-owner.ts", import.meta.url).href;
    assert.equal(source, `export { default } from ${JSON.stringify(target)};\n`);
    assert.equal((await stat(join(root, ".pi-subagents"))).mode & 0o777, 0o700);
    assert.equal((await stat(entry)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
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

function lifecycleFixture({ subscribeError, lifecycleDedupeLimit, initialPush, recordSupervisorRequest, supervisorAcknowledge, rpcDispose } = {}) {
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
    dispose() { rpcDisposals += 1; rpcDispose?.(); },
    async subscribe(onPush) { subscribeCalls += 1; if (subscribeError) throw subscribeError; this.onPush = onPush; if (initialPush) onPush(initialPush); return { dispose() { subscriptionDisposals += 1; }, closed }; },
    supervisorPending() {}, supervisorReply() {}, supervisorAcknowledge(requestId) { return supervisorAcknowledge?.(requestId); },
  };
  const installed = installRootOwnedSubagent(pi, { rootSessionId: "root", callerRunId: "run", createClient: () => rpc, lifecycleDedupeLimit, recordSupervisorRequest });
  return { emitted, messages, pi, rpc, installed, closed: () => closedCatchCalls, subscribeCalls: () => subscribeCalls, subscriptionDisposals: () => subscriptionDisposals, rpcDisposals: () => rpcDisposals };
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

test("mirrors Supervisor request pushes as an exact Plan Attention without lifecycle emission", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.();
  const push = { type: "supervisor.request", callerRunId: "run", data: { requestId: "request-1", executorRunId: "executor-1", content: "Approve the change.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 2 } };
  subject.rpc.onPush?.(push);
  assert.deepEqual(subject.emitted, []);
  assert.deepEqual(subject.messages, [{
    message: { customType: "subagent_supervisor_request", content: "Approve the change.", display: true, details: { id: "request-1", reason: "need_decision", expectsReply: true, runId: "executor-1", agent: "executor", childIndex: 2 } },
    options: { triggerTurn: true, deliverAs: "followUp" },
  }]);
});

test("deduplicates Supervisor request pushes into one Plan Attention", async () => {
  const subject = lifecycleFixture();
  await subject.installed.startLifecycleSubscription?.();
  const push = { type: "supervisor.request", callerRunId: "run", data: { requestId: "request-1", executorRunId: "executor-1", content: "Approve the change.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 2 } };
  subject.rpc.onPush?.(push); subject.rpc.onPush?.(push);
  assert.equal(subject.messages.length, 1);
  assert.equal(subject.messages[0].message.customType, "subagent_supervisor_request");
});

test("does not let lifecycle churn evict Supervisor request dedupe", async () => {
  const subject = lifecycleFixture({ lifecycleDedupeLimit: 2 });
  const supervisor = { type: "supervisor.request", callerRunId: "run", data: { requestId: "request-1", executorRunId: "R1", content: "Approve.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 } };
  await subject.installed.startLifecycleSubscription?.();
  subject.rpc.onPush?.(supervisor);
  subject.rpc.onPush?.(completed("D1"));
  subject.rpc.onPush?.(completed("D2"));
  subject.rpc.onPush?.(supervisor);

  assert.deepEqual({
    supervisor: subject.messages.filter(({ message }) => message.customType === "subagent_supervisor_request").length,
    lifecycleEmitted: subject.emitted.length,
    lifecycleFollowUps: subject.messages.filter(({ message }) => message.customType === "pi-root-subagent-lifecycle-v1").length,
  }, { supervisor: 1, lifecycleEmitted: 2, lifecycleFollowUps: 2 });
});

test("records subscription-backlog Supervisor requests before the ready barrier returns", async () => {
  const records = [];
  const ctx = { cwd: "/plan-worktree", marker: "backlog" };
  const push = { type: "supervisor.request", callerRunId: "run", data: { requestId: "request-backlog", executorRunId: "executor-1", content: "Approve the backlog change.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 1 } };
  const subject = lifecycleFixture({
    initialPush: push,
    async recordSupervisorRequest(message, options) { records.push({ message, options }); },
  });

  await subject.installed.startLifecycleSubscription?.(ctx);

  assert.deepEqual(records, [{
    message: { customType: "subagent_supervisor_request", content: "Approve the backlog change.", display: true, details: { id: "request-backlog", reason: "need_decision", expectsReply: true, runId: "executor-1", agent: "executor", childIndex: 1 } },
    options: { ctx },
  }]);
  assert.deepEqual(subject.messages, []);
});

test("records live Supervisor requests immediately with the latest subscription context", async () => {
  const records = [];
  const ctx = { cwd: "/plan-worktree", marker: "live" };
  const subject = lifecycleFixture({
    async recordSupervisorRequest(message, options) { records.push({ message, options }); },
  });
  const push = { type: "supervisor.request", callerRunId: "run", data: { requestId: "request-live", executorRunId: "executor-2", content: "Approve the live change.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 2 } };
  await subject.installed.startLifecycleSubscription?.(ctx);
  subject.rpc.onPush?.(push);
  subject.rpc.onPush?.(push);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(records.length, 1);
  assert.strictEqual(records[0].options.ctx, ctx);
  assert.equal(records[0].message.details.id, "request-live");
  assert.deepEqual(subject.messages, []);
});

test("records a Supervisor request before acknowledging its exact requestId", async () => {
  const timeline = [];
  const subject = lifecycleFixture({
    async recordSupervisorRequest(message) { timeline.push(["record", message.details.id]); },
    async supervisorAcknowledge(requestId) { timeline.push(["ack", requestId]); },
  });
  await subject.installed.startLifecycleSubscription?.();
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "request-ack", executorRunId: "executor-ack", content: "Persist before ACK.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 } });

  await subject.pi.emitLifecycle("agent_settled", { cwd: "/plan-worktree" });

  assert.deepEqual(timeline, [["record", "request-ack"], ["ack", "request-ack"]]);
});

test("retries only a failed Supervisor ACK on the next lifecycle hook", async () => {
  const records = []; const acknowledgements = [];
  const subject = lifecycleFixture({
    async recordSupervisorRequest(message) { records.push(message.details.id); },
    async supervisorAcknowledge(requestId) { acknowledgements.push(requestId); if (acknowledgements.length === 1) throw new Error("ack transport failed"); },
  });
  await subject.installed.startLifecycleSubscription?.();
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "request-ack-retry", executorRunId: "executor-ack-retry", content: "Retry ACK only.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 } });

  await assert.rejects(subject.pi.emitLifecycle("agent_settled", { marker: "settled" }), /ack transport failed/);
  await subject.pi.emitLifecycle("session_shutdown", { marker: "shutdown" });

  assert.deepEqual(records, ["request-ack-retry"]);
  assert.deepEqual(acknowledgements, ["request-ack-retry", "request-ack-retry"]);
});

test("runs Supervisor record drain before typed rpc disposal during session shutdown", async () => {
  const timeline = [];
  const subject = lifecycleFixture({
    async recordSupervisorRequest(message) { timeline.push(["record", message.details.id]); },
    rpcDispose() { timeline.push(["dispose"]); },
  });
  await subject.installed.startLifecycleSubscription?.();
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "shutdown-order", executorRunId: "executor-shutdown", content: "Drain before dispose.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 } });
  await subject.pi.emitLifecycle("session_shutdown", { marker: "shutdown" });
  assert.deepEqual(timeline, [["record", "shutdown-order"], ["dispose"]]);
});

test("session shutdown waits for a failed agent-settled drain then retries with shutdown context", async () => {
  let release; const entered = new Promise((resolve) => { release = resolve; }); const attempts = [];
  const subject = lifecycleFixture({ async recordSupervisorRequest(_message, { ctx }) { attempts.push(ctx.marker); if (attempts.length === 1) { await entered; throw new Error("settled write failed"); } } });
  await subject.installed.startLifecycleSubscription?.();
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "concurrent-retry", executorRunId: "executor-concurrent", content: "Retry after settled drain.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 } });
  const settled = subject.pi.emitLifecycle("agent_settled", { marker: "settled" });
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = subject.pi.emitLifecycle("session_shutdown", { marker: "shutdown" });
  release();
  await assert.rejects(settled, /settled write failed/);
  await assert.doesNotReject(shutdown);
  assert.deepEqual(attempts, ["settled", "shutdown"]);
});

test("drains a Supervisor push that arrives during a successful in-flight pass", async () => {
  let enterFirst; let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const records = []; const acknowledgements = [];
  const subject = lifecycleFixture({
    async recordSupervisorRequest(message) {
      records.push(message.details.id);
      if (message.details.id === "snapshot-a") { enterFirst(); await firstRelease; }
    },
    async supervisorAcknowledge(requestId) { acknowledgements.push(requestId); },
  });
  const ctx = { marker: "settled" };
  await subject.installed.startLifecycleSubscription?.(ctx);
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "snapshot-a", executorRunId: "executor-a", content: "First.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 } });
  const settled = subject.pi.emitLifecycle("agent_settled", ctx);
  await firstEntered;
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "snapshot-b", executorRunId: "executor-b", content: "Second.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 1 } });
  releaseFirst();
  await settled;

  assert.deepEqual(records, ["snapshot-a", "snapshot-b"]);
  assert.deepEqual(acknowledgements, ["snapshot-a", "snapshot-b"]);
});

test("bounds concurrent lifecycle compensation when Supervisor record keeps failing", async () => {
  let enterFirst; let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let attempts = 0;
  const subject = lifecycleFixture({
    async recordSupervisorRequest() {
      attempts += 1;
      if (attempts === 1) { enterFirst(); await firstRelease; }
      throw new Error("persistent record failure");
    },
  });
  await subject.installed.startLifecycleSubscription?.({ marker: "live" });
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "bounded-retry", executorRunId: "executor-bounded", content: "Keep failing.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 } });
  await firstEntered;
  const settled = subject.pi.emitLifecycle("agent_settled", { marker: "settled" });
  const shutdown = subject.pi.emitLifecycle("session_shutdown", { marker: "shutdown" });
  releaseFirst();

  const outcomes = await Promise.allSettled([settled, shutdown]);
  assert.deepEqual(outcomes.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(attempts, 2);
});

test("isolates failed Supervisor records by Executor while retaining each Executor FIFO", async () => {
  const attempts = [];
  const subject = lifecycleFixture({ async recordSupervisorRequest(message) { attempts.push(message.details.id); if (message.details.runId === "executor-a") throw new Error("A permanently fails"); } });
  await subject.installed.startLifecycleSubscription?.();
  for (const [requestId, runId] of [["a-first", "executor-a"], ["b-first", "executor-b"], ["a-second", "executor-a"]]) subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId, executorRunId: runId, content: requestId, reason: "progress_update", expectsReply: false, agent: "executor", childIndex: 0 } });
  await assert.rejects(subject.pi.emitLifecycle("agent_settled", {}), /A permanently fails/);
  assert.deepEqual(attempts, ["a-first", "b-first"]);
});

test("retains a failed immediate Supervisor record for session-shutdown retry", async () => {
  const attempts = [];
  const liveCtx = { marker: "live" };
  const shutdownCtx = { marker: "shutdown" };
  const subject = lifecycleFixture({
    async recordSupervisorRequest(message, { ctx }) {
      attempts.push({ requestId: message.details.id, ctx });
      if (attempts.length === 1) throw new Error("durable attention write failed");
    },
  });
  await subject.installed.startLifecycleSubscription?.(liveCtx);
  subject.rpc.onPush?.({ type: "supervisor.request", callerRunId: "run", data: { requestId: "request-retry", executorRunId: "executor-3", content: "Retry this request.", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 3 } });

  await new Promise((resolve) => setImmediate(resolve));
  await subject.pi.emitLifecycle("session_shutdown", shutdownCtx);

  assert.deepEqual(attempts, [
    { requestId: "request-retry", ctx: liveCtx },
    { requestId: "request-retry", ctx: shutdownCtx },
  ]);
});
