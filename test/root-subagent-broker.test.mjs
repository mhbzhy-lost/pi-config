import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm as removePath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BROKER_FRAME_LIMIT_BYTES, BROKER_METHODS, brokerGrantPath, brokerSocketPath, parseBrokerPush, readBrokerGrant, writeBrokerGrant } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";
import { createBrokerFrameDecoder, createRootBrokerClient } from "../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";
import { bootstrapRuntimeRoots, default as planRunner } from "../pi/child-extensions/plan-runner.ts";
import { installRootSessionOwner, installRootSessionOwnerLifecycle } from "../pi/child-extensions/root-session-owner.ts";
import { bindRootBroker, requireRootBroker, startAndBindRootBroker, unbindRootBroker } from "../scripts/lib/subagent-dispatch/root-broker-registry.ts";

const rootSessionId = "root-broker-test-1";

function fakeUpstream() {
  const calls = [];
  return {
    calls,
    failNextPing: false,
    async ping() {
      if (this.failNextPing) {
        this.failNextPing = false;
        throw new Error("controlled pre-resolver ping failure");
      }
      return { version: 1, methods: ["ping", "spawn", "spawn.lookup", "status", "interrupt", "stop"], session: { sessionId: "root-session-uuid", sessionFile: "/sessions/root-session.jsonl", cwd: "/root" } };
    },
    async spawn(params) { calls.push({ method: "spawn", params }); return { details: { runId: "executor-run-1", asyncDir: "/async/1" } }; },
    async stop(params) { calls.push({ method: "stop", params }); return { stopped: true }; },
  };
}

function request({ callerRunId, callerToken, method, params, requestId = "request-1", root = rootSessionId }) {
  return { schemaVersion: "pi-root-subagent-broker-request.v1", requestId, rootSessionId: root, callerRunId, callerToken, method, params };
}

function v3DispatchBranch() {
  const originRoot = "/origin";
  const workspace = { path: "/attempts/attempt-1", branch: "pi-plan-attempt/plan/task-1/1", ownerToken: "owner-1" };
  const compiled = compileCodingDispatchIR({
    version: "dispatch-ir.v1", taskId: "task-1", title: "Executor authorization", agent: "executor", risk: "normal", objective: "Apply the approved task.",
    requirements: ["Modify the declared file."], context: { knownFacts: [], decisions: [], relevantFiles: ["src/task.mjs"] },
    boundaries: { writePaths: ["src/task.mjs"], excludedWork: [], forbiddenActions: [] }, workflow: { mode: "tdd" },
    acceptance: { criteria: ["Focused tests pass."], commands: ["node --test"] }, execution: { timeoutMs: 1000, cwd: workspace.path },
  }, { cwd: workspace.path });
  const { hash: contractHash, ...contract } = compiled;
  const planIrHash = "a".repeat(64); const taskHash = "b".repeat(64); const schedulingHash = "c".repeat(64);
  const dispatchContextHash = createHash("sha256").update(JSON.stringify({
    planIrHash, taskHash, schedulingHash, attemptId: "attempt-1", baseCommit: "base", output: "/results/attempt-1.json", dependencyReceipts: [],
  })).digest("hex");
  const event = (eventId, type, data) => ({ schemaVersion: "pi-plan-event.v1", eventId, planId: "plan", occurredAt: `2026-07-29T00:00:0${eventId}.000Z`, type, data });
  return {
    contract,
    branch: [
      event("1", "plan.created", { workspace: { originRoot, worktree: "/repo", baseCommit: "base", headCommit: "base" }, tasks: ["task-1"], revision: { number: 1, manifestSha256: "d".repeat(64), sourceBytesSha256: "e".repeat(64), planHash: "f".repeat(64), irVersion: "plan-ir.v3", irHash: planIrHash, taskHashes: { "task-1": { full: "1".repeat(64), effective: taskHash, scheduling: schedulingHash } } } }),
      event("2", "attempt.workspace-allocated", { attemptId: "attempt-1", taskId: "task-1", baseCommit: "base", workspace }),
      event("3", "attempt.dispatch-requested", { attemptId: "attempt-1", taskId: "task-1", dispatchId: "dispatch-1", baseCommit: "base", workspace, planIrHash, taskHash, schedulingHash, dispatchContextHash, toolHash: contractHash, tool: { agent: "executor", task: "Apply the approved task.", cwd: workspace.path, context: "fresh", async: true, clarify: false, worktree: false, timeoutMs: 1000, output: "/results/attempt-1.json", dependencyReceipts: [], contract } }),
    ],
  };
}

test("bootstrap runtime roots loads and accepts only an exact absolute-root projection", async () => {
  await assert.rejects(() => bootstrapRuntimeRoots({ ping: async () => ({ planRuntime: { originRoot: "/origin", stateRoot: "/state", extra: true } }) }), /invalid/i);
  for (const planRuntime of [
    {}, { originRoot: "/origin" }, { stateRoot: "/state" },
    { originRoot: "origin", stateRoot: "/state" }, { originRoot: "/origin", stateRoot: "state" },
    { originRoot: ["/origin"], stateRoot: "/state" }, { originRoot: "/origin", stateRoot: null },
  ]) {
    await assert.rejects(() => bootstrapRuntimeRoots({ ping: async () => ({ planRuntime }) }), /invalid/i);
  }
  assert.deepEqual(await bootstrapRuntimeRoots({ ping: async () => ({ planRuntime: { originRoot: "/origin", stateRoot: "/state" } }) }), { originRoot: "/origin", stateRoot: "/state" });
});

test("bootstrap retries only pending grants and respects its injected deadline", async () => {
  let now = 0;
  const sleeps = [];
  const pending = Object.assign(new Error("pending"), { code: "GRANT_NOT_READY" });
  await assert.rejects(() => bootstrapRuntimeRoots({ ping: async () => { throw pending; } }, {
    clock: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    timeoutMs: 50,
    retryMs: 25,
  }), /pending/);
  assert.deepEqual(sleeps, [25, 25]);
  await assert.rejects(() => bootstrapRuntimeRoots({ ping: async () => { throw new Error("invalid"); } }, {
    sleep: async () => { throw new Error("must not sleep"); }, timeoutMs: 1, retryMs: 1,
  }), /invalid/);
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { retryMs: -1 }, { retryMs: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(() => bootstrapRuntimeRoots({ ping: async () => ({}) }, options), /positive safe integer/i);
  }
});

async function socketRequest(value, { keepOpen = false } = {}) {
  const socket = connect(brokerSocketPath(rootSessionId));
  await once(socket, "connect");
  socket.write(`${JSON.stringify(value)}\n`);
  let buffer = "";
  const reply = await new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.indexOf("\n");
      if (line >= 0) resolve(JSON.parse(buffer.slice(0, line)));
    });
    socket.once("error", reject);
  });
  return { reply, socket: keepOpen ? socket : (socket.end(), undefined) };
}

test("default plan runner bootstraps from a delayed real broker grant without PI_PLAN roots", async (t) => {
  const runId = "delayed-plan-run";
  const environment = ["PI_PLAN_ORIGIN_ROOT", "PI_PLAN_STATE_ROOT", "PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", "PI_SUBAGENT_RUN_ID"]
    .map((key) => [key, Object.hasOwn(process.env, key), process.env[key]]);
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    events: { on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); return () => {}; } },
    on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return []; }, setActiveTools() {}, sendMessage() {}, appendEntry() {},
  };
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() });
  await broker.start();
  t.after(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
    await broker.closeRootSession();
    for (const [key, existed, value] of environment) {
      if (existed) process.env[key] = value; else delete process.env[key];
    }
  });
  delete process.env.PI_PLAN_ORIGIN_ROOT;
  delete process.env.PI_PLAN_STATE_ROOT;
  process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;
  const factory = planRunner(pi);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await broker.grantCaller({ callerRunId: runId, planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" });
  await factory;
  assert.equal(broker.subscriptions.get(runId)?.size, 1);
  const dispatch = v3DispatchBranch();
  const ctx = { cwd: "/repo", sessionManager: { getBranch: () => dispatch.branch.map((data) => ({ customType: "pi-plan-event-v1", data })) } };
  await handlers.get("before_agent_start").at(-1)({}, { cwd: "/repo", sessionManager: { getBranch: () => [] } });
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  const capsuleToolCall = handlers.get("tool_call").at(-1);
  assert.equal(await capsuleToolCall({ toolName: "subagent", toolCallId: "dispatch-tool-call-1", input: dispatch.contract }, ctx), undefined);
  const handle = await tools.get("subagent").execute("dispatch-tool-call-1", dispatch.contract, undefined, undefined, ctx);
  assert.equal(handle.isError, false);
  assert.equal(handle.details.dispatchId, "dispatch-1");
  assert.deepEqual(broker.spawnLedger.get("plan\u0000dispatch-1")?.binding, { runId: "executor-run-1", asyncDir: "/async/1" });
  const spawn = broker.upstream.calls[0].params;
  for (const key of ["spawnKey", "requestId", "domain", "parent"]) assert.equal(Object.hasOwn(spawn, key), false);
  const replay = await capsuleToolCall({ toolName: "subagent", toolCallId: "dispatch-tool-call-2", input: dispatch.contract }, ctx);
  assert.equal(replay.block, true);
  assert.match(replay.reason, /replay|already authorized/i);
  assert.equal(tools.has("plan_open"), true);
  assert.equal(tools.has("subagent"), true);
  assert.equal(tools.has("plan_executor_supervisor"), true);
});


test("factory disposes the registered broker client when a malformed grant aborts bootstrap", async (t) => {
  const runId = "malformed-plan-run";
  const grantPath = brokerGrantPath(rootSessionId, runId);
  const environment = ["PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", "PI_SUBAGENT_RUN_ID"]
    .map((key) => [key, Object.hasOwn(process.env, key), process.env[key]]);
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    events: { on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); return () => {}; } },
    on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getActiveTools() { return []; }, setActiveTools() {}, sendMessage() {}, appendEntry() {},
  };
  t.after(async () => {
    await removePath(grantPath, { force: true });
    for (const [key, existed, value] of environment) {
      if (existed) process.env[key] = value; else delete process.env[key];
    }
  });
  await mkdir(path.dirname(grantPath), { recursive: true });
  await writeFile(grantPath, "{malformed");
  process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;
  await assert.rejects(() => planRunner(pi), /grant is unavailable/i);
  const response = await tools.get("subagent").execute("id", { action: "status", id: "run" });
  assert.equal(response.details.code, "CLIENT_DISPOSED");
});


test("broker forwards flat spawn, projects caller cwd, rejects foreign control, and closes subscribers", async (t) => {
  const upstream = fakeUpstream();
  const broker = new RootBrokerServer({ rootSessionId, upstream });
  await broker.start();
  t.after(() => broker.closeRootSession());
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const other = await broker.grantCaller({ callerRunId: "plan-run-2", planId: "plan-2", cwd: "/other", originRoot: "/other", stateRoot: "/state-other", role: "plan-runner" });

  assert.equal((await stat(brokerSocketPath(rootSessionId))).mode & 0o777, 0o600);
  assert.equal((await stat(brokerGrantPath(rootSessionId, "plan-run-1"))).mode & 0o777, 0o600);
  const ping = await socketRequest(request({ callerRunId: "plan-run-1", callerToken: caller.callerToken, method: "ping", params: {} }));
  assert.equal(ping.reply.data.session.cwd, "/repo");
  const spawned = await socketRequest(request({ callerRunId: "plan-run-1", callerToken: caller.callerToken, method: "spawn", params: { agent: "executor", task: "execute", cwd: "/attempt" } }));
  assert.equal(spawned.reply.success, true);
  assert.deepEqual(upstream.calls[0].params, { agent: "executor", task: "execute", cwd: "/attempt", async: true, clarify: false });
  const denied = await socketRequest(request({ callerRunId: "plan-run-2", callerToken: other.callerToken, method: "stop", params: { runId: "executor-run-1", dir: "/async/1" } }));
  assert.equal(denied.reply.success, false);
  assert.match(denied.reply.error.message, /not owned/i);

  const subscription = await socketRequest(request({ callerRunId: "plan-run-1", callerToken: caller.callerToken, method: "subscribe", params: {} }), { keepOpen: true });
  assert.equal(subscription.reply.success, true);
  const closing = once(subscription.socket, "data");
  await broker.closeRootSession();
  assert.match((await closing)[0].toString(), /root\.closing/);
});

test("broker fails closed for root, caller, and token mismatches", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() });
  await broker.start();
  t.after(() => broker.closeRootSession());
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  for (const change of [{ root: "other-root" }, { callerRunId: "other-run" }, { callerToken: "b".repeat(64) }]) {
    const reply = await socketRequest(request({ callerRunId: change.callerRunId ?? "plan-run-1", callerToken: change.callerToken ?? caller.callerToken, method: "ping", params: {}, root: change.root ?? rootSessionId }));
    assert.equal(reply.reply.success, false);
  }
});

test("broker returns identity-bound runtime roots without changing the grant schema", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() });
  await broker.start();
  t.after(() => broker.closeRootSession());
  const first = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/origin-a", stateRoot: "/state-a", role: "plan-runner" });
  const second = await broker.grantCaller({ callerRunId: "plan-run-2", planId: "plan-2", cwd: "/other", originRoot: "/origin-b", stateRoot: "/state-b", role: "plan-runner" });
  const firstPing = await socketRequest(request({ callerRunId: "plan-run-1", callerToken: first.callerToken, method: "ping", params: {} }));
  const secondPing = await socketRequest(request({ callerRunId: "plan-run-2", callerToken: second.callerToken, method: "ping", params: {} }));
  assert.deepEqual(firstPing.reply.data.planRuntime, { originRoot: "/origin-a", stateRoot: "/state-a" });
  assert.equal(firstPing.reply.data.methods.includes("spawn.lookup"), true);
  assert.deepEqual(secondPing.reply.data.planRuntime, { originRoot: "/origin-b", stateRoot: "/state-b" });
  const grant = await readBrokerGrant(rootSessionId, "plan-run-1");
  assert.deepEqual(Object.keys(grant).sort(), ["callerToken", "role", "rootSessionId", "runId", "schemaVersion"]);
});

test("child-safe client reads its grant, authenticates each request, and rejects on dispose", async (t) => {
  const upstream = fakeUpstream();
  const broker = new RootBrokerServer({ rootSessionId, upstream });
  await broker.start();
  t.after(() => broker.closeRootSession());
  await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "plan-run-1" });
  t.after(() => client.dispose());

  const reply = await client.spawn({ agent: "executor", task: "execute", async: false, clarify: true });
  assert.equal(reply.details.runId, "executor-run-1");
  assert.deepEqual(upstream.calls[0].params, { agent: "executor", task: "execute", async: true, clarify: false });
  client.dispose();
  await assert.rejects(client.ping(), /disposed/i);
});

for (const requestId of ["dispatch/a", "dispatch?a"]) {
  test(`broker client rejects the invalid requestId ${requestId} without spawning`, async (t) => {
    const upstream = fakeUpstream();
    const broker = new RootBrokerServer({ rootSessionId, upstream });
    await broker.start();
    t.after(() => broker.closeRootSession());
    const callerRunId = `plan-invalid-request-id-${requestId.length}`;
    await broker.grantCaller({ callerRunId, planId: "plan", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
    const client = createRootBrokerClient({ rootSessionId, callerRunId });
    t.after(() => client.dispose());

    await assert.rejects(
      client.spawn({ agent: "executor", task: "run" }, { requestId, spawnKey: "dispatch-strict" }),
      (error) => error.code === "REQUEST_ID_INVALID",
    );
    assert.equal(upstream.calls.filter((call) => call.method === "spawn").length, 0);
  });
}

test("child-safe subscription distinguishes local disposal from remote EOF", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() });
  await broker.start();
  t.after(() => broker.closeRootSession());
  await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "plan-run-1" });
  t.after(() => client.dispose());
  const subscription = await client.subscribe(() => {});
  subscription.dispose();
  await subscription.closed;
  const remote = await client.subscribe(() => {});
  const remoteFailure = assert.rejects(remote.closed, /root closing|disconnected|EOF/i);
  await broker.closeRootSession();
  await remoteFailure;
});

test("root ownership guard retries only a missing grant and terminates once on remote EOF", async () => {
  const signals = [];
  const messages = [];
  let attempts = 0;
  let close;
  const owner = await installRootSessionOwner({ sendMessage: async (message) => messages.push(message) }, {
    env: { PI_ROOT_SUBAGENT_BROKER_ENABLED: "1", PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: rootSessionId, PI_SUBAGENT_RUN_ID: "plan-run-1" },
    createClient: () => ({
      subscribe: async () => {
        attempts += 1;
        if (attempts === 1) { const error = new Error("not ready"); error.code = "GRANT_NOT_READY"; throw error; }
        const closed = new Promise((_, reject) => { close = () => reject(new Error("EOF")); });
        return { dispose() {}, closed };
      },
      dispose() {},
    }),
    clock: () => 0,
    sleep: async () => {},
    kill: (pid, signal) => signals.push({ pid, signal }),
    pid: 42,
  });
  close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.deepEqual(signals, [{ pid: 42, signal: "SIGTERM" }]);
  assert.equal(messages[0].customType, "pi-root-session-closing-v1");
  owner.dispose();
});

test("root ownership guard is a legacy no-op without the root broker capability marker", async () => {
  let created = 0;
  const owner = await installRootSessionOwner({}, {
    env: { PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: rootSessionId, PI_SUBAGENT_RUN_ID: "legacy-run" },
    createClient: () => { created += 1; throw new Error("must not connect"); },
  });
  assert.equal(created, 0);
  owner.dispose();
});

test("root ownership lifecycle awaits one marker-enabled subscription and disposes it once", async () => {
  const handlers = new Map();
  const pi = { on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); } };
  let subscribed = 0;
  let disposed = 0;
  let clientDisposed = 0;
  installRootSessionOwnerLifecycle(pi, {
    env: { PI_ROOT_SUBAGENT_BROKER_ENABLED: "1", PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: rootSessionId, PI_SUBAGENT_RUN_ID: "run-1" },
    createClient: () => ({ async subscribe() { subscribed += 1; return { closed: new Promise(() => {}), dispose() { disposed += 1; } }; }, dispose() { clientDisposed += 1; } }),
  });
  assert.equal(handlers.get("session_start").length, 1);
  assert.equal(handlers.get("session_shutdown").length, 1);
  await handlers.get("session_start")[0]();
  assert.equal(subscribed, 1);
  await assert.rejects(handlers.get("session_start")[0](), /already started/i);
  await handlers.get("session_shutdown")[0]();
  await handlers.get("session_shutdown")[0]();
  assert.equal(disposed, 1);
  assert.equal(clientDisposed, 1);
});

test("root ownership lifecycle propagates startup errors", async () => {
  const handlers = new Map();
  const pi = { on(type, handler) { handlers.set(type, handler); } };
  installRootSessionOwnerLifecycle(pi, {
    env: { PI_ROOT_SUBAGENT_BROKER_ENABLED: "1", PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: rootSessionId, PI_SUBAGENT_RUN_ID: "run-1" },
    createClient: () => { throw new Error("subscription failed"); },
  });
  await assert.rejects(handlers.get("session_start")(), /subscription failed/);
});

test("caller grant publishes matching identities before the grant and rolls back only its token", async () => {
  let broker;
  let observed;
  broker = new RootBrokerServer({
    rootSessionId,
    upstream: fakeUpstream(),
    randomToken: () => "a".repeat(64),
    writeGrant: async (grant) => {
      observed = { caller: broker.callers.get(grant.runId), principal: broker.principals.get(grant.runId), grant };
      throw new Error("write failed");
    },
  });
  await assert.rejects(() => broker.grantCaller({ callerRunId: "plan-run-rollback", planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" }), /write failed/);
  assert.equal(observed.caller.callerToken, observed.grant.callerToken);
  assert.deepEqual(observed.principal, { role: "plan-runner", callerToken: observed.grant.callerToken });
  assert.equal(broker.callers.has("plan-run-rollback"), false);
  assert.equal(broker.principals.has("plan-run-rollback"), false);
  assert.equal(broker.grantPaths.size, 0);
});

test("executor grant publishes before write, rolls back, and can retry", async () => {
  let broker;
  let writes = 0;
  broker = new RootBrokerServer({
    rootSessionId,
    upstream: fakeUpstream(),
    randomToken: () => "b".repeat(64),
    writeGrant: async (grant) => {
      assert.deepEqual(broker.principals.get(grant.runId), { role: "executor", callerToken: grant.callerToken });
      if (writes++ === 0) throw new Error("write failed");
      return "/tmp/executor-grant";
    },
  });
  await assert.rejects(() => broker.ensureExecutorOwner("executor-retry"), /write failed/);
  assert.equal(broker.principals.has("executor-retry"), false);
  assert.equal(broker.executorGrants.has("executor-retry"), false);
  await broker.ensureExecutorOwner("executor-retry");
  assert.equal(broker.grantPaths.has("/tmp/executor-grant"), true);
});

test("cleaned tool result lookup releases the durable dispatch for a new Executor tool call", async (t) => {
  const runId = "cleaned-plan-run";
  const environment = ["PI_PLAN_ORIGIN_ROOT", "PI_PLAN_STATE_ROOT", "PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", "PI_SUBAGENT_RUN_ID"]
    .map((key) => [key, Object.hasOwn(process.env, key), process.env[key]]);
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    events: { on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); return () => {}; } },
    on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return []; }, setActiveTools() {}, sendMessage() {}, appendEntry() {},
  };
  let writes = 0;
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: fakeUpstream(),
    writeGrant: async (grant) => {
      if (grant.role === "executor" && writes++ === 0) throw new Error("executor grant write failed");
      return writeBrokerGrant(grant);
    },
  });
  await broker.start();
  t.after(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
    await broker.closeRootSession();
    for (const [key, existed, value] of environment) {
      if (existed) process.env[key] = value; else delete process.env[key];
    }
  });
  delete process.env.PI_PLAN_ORIGIN_ROOT;
  delete process.env.PI_PLAN_STATE_ROOT;
  process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;
  const factory = planRunner(pi);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await broker.grantCaller({ callerRunId: runId, planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" });
  await factory;
  const dispatch = v3DispatchBranch();
  const ctx = { cwd: "/repo", sessionManager: { getBranch: () => dispatch.branch.map((data) => ({ customType: "pi-plan-event-v1", data })) } };
  await handlers.get("before_agent_start").at(-1)({}, { cwd: "/repo", sessionManager: { getBranch: () => [] } });
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  const capsuleToolCall = handlers.get("tool_call").at(-1);
  assert.equal(await capsuleToolCall({ toolName: "subagent", toolCallId: "dispatch-tool-call-1", input: dispatch.contract }, ctx), undefined);
  const handle = await tools.get("subagent").execute("dispatch-tool-call-1", dispatch.contract, undefined, undefined, ctx);
  assert.equal(handle.isError, true);
  assert.equal(broker.spawnLedger.get("plan\u0000dispatch-1")?.state, "cleaned");
  const toolResult = { toolName: "subagent", toolCallId: "dispatch-tool-call-1", input: dispatch.contract, content: handle.content, isError: handle.isError, details: handle.details };
  for (const handler of handlers.get("tool_result") ?? []) await handler(toolResult, ctx);
  assert.equal(await capsuleToolCall({ toolName: "subagent", toolCallId: "dispatch-tool-call-2", input: dispatch.contract }, ctx), undefined);
});

test("pre-resolver ping failure releases the durable Executor authorization", async (t) => {
  const runId = "pre-resolver-plan-run";
  const environment = ["PI_PLAN_ORIGIN_ROOT", "PI_PLAN_STATE_ROOT", "PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", "PI_SUBAGENT_RUN_ID"]
    .map((key) => [key, Object.hasOwn(process.env, key), process.env[key]]);
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    events: { on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); return () => {}; } },
    on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return []; }, setActiveTools() {}, sendMessage() {}, appendEntry() {},
  };
  const upstream = fakeUpstream();
  const broker = new RootBrokerServer({ rootSessionId, upstream });
  await broker.start();
  t.after(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
    await broker.closeRootSession();
    for (const [key, existed, value] of environment) {
      if (existed) process.env[key] = value; else delete process.env[key];
    }
  });
  delete process.env.PI_PLAN_ORIGIN_ROOT;
  delete process.env.PI_PLAN_STATE_ROOT;
  process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED = "1";
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;
  const factory = planRunner(pi);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await broker.grantCaller({ callerRunId: runId, planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" });
  await factory;
  const dispatch = v3DispatchBranch();
  const ctx = { cwd: "/repo", sessionManager: { getBranch: () => dispatch.branch.map((data) => ({ customType: "pi-plan-event-v1", data })) } };
  await handlers.get("before_agent_start").at(-1)({}, { cwd: "/repo", sessionManager: { getBranch: () => [] } });
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  const capsuleToolCall = handlers.get("tool_call").at(-1);
  assert.equal(await capsuleToolCall({ toolName: "subagent", toolCallId: "dispatch-tool-call-1", input: dispatch.contract }, ctx), undefined);
  upstream.failNextPing = true;
  const handle = await tools.get("subagent").execute("dispatch-tool-call-1", dispatch.contract, undefined, undefined, ctx);
  assert.equal(handle.isError, true);
  assert.equal(broker.spawnLedger.has("plan\u0000dispatch-1"), false);
  assert.equal(upstream.calls.filter((call) => call.method === "spawn").length, 0);
  const toolResult = { toolName: "subagent", toolCallId: "dispatch-tool-call-1", input: dispatch.contract, content: handle.content, isError: handle.isError, details: handle.details };
  const handlerErrors = [];
  for (const handler of handlers.get("tool_result") ?? []) {
    try { await handler(toolResult, ctx); } catch (error) { handlerErrors.push(error); }
  }
  assert.equal(await capsuleToolCall({ toolName: "subagent", toolCallId: "dispatch-tool-call-2", input: dispatch.contract }, ctx), undefined);
  assert.deepEqual(handlerErrors, []);
});

test("caller grant never overwrites a principal collision or writes a grant", async () => {
  let writes = 0;
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), writeGrant: async () => { writes += 1; return "/tmp/grant"; } });
  broker.principals.set("collision", { role: "executor", callerToken: "c".repeat(64) });
  await assert.rejects(() => broker.grantCaller({ callerRunId: "collision", planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" }), /already granted/);
  assert.deepEqual(broker.principals.get("collision"), { role: "executor", callerToken: "c".repeat(64) });
  assert.equal(writes, 0);
});

test("caller grants reject after close and close owns a concurrent successful grant path", async () => {
  let releaseWrite; let writes = 0; const directory = await mkdtemp(path.join(tmpdir(), "root-broker-close-")); const grantPath = path.join(directory, "grant.json");
  const pendingWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), writeGrant: async () => { writes += 1; await pendingWrite; await writeFile(grantPath, "grant"); return grantPath; } });
  const pending = broker.grantCaller({ callerRunId: "plan-run-close", planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" });
  const closing = broker.closeRootSession(); releaseWrite();
  await assert.rejects(pending, /closing/); await closing; await assert.rejects(stat(grantPath));
  await assert.rejects(broker.grantCaller({ callerRunId: "plan-run-after-close", planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" }), /closed|closing/);
  assert.equal(writes, 1); assert.equal(broker.callers.size, 0); assert.equal(broker.principals.size, 0);
  await removePath(directory, { recursive: true, force: true });
});

test("caller grant validates each root field before writing", async () => {
  for (const key of ["cwd", "originRoot", "stateRoot"]) for (const value of [undefined, "", "relative"]) {
    let writes = 0; const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), writeGrant: async () => { writes += 1; return "/tmp/grant"; } });
    await assert.rejects(broker.grantCaller({ callerRunId: `${key}-${String(value)}`, planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner", [key]: value }));
    assert.equal(writes, 0, `${key}=${String(value)}`);
  }
});

function startedEventBus() {
  const listeners = new Map();
  return {
    on(channel, listener) { const values = listeners.get(channel) ?? new Set(); values.add(listener); listeners.set(channel, values); return () => { values.delete(listener); this.unsubscribed = true; }; },
    emit(channel, event) { for (const listener of listeners.get(channel) ?? []) listener(event); },
    async settled() { await new Promise((resolve) => setImmediate(resolve)); },
  };
}

function ownedRun(broker, runId) {
  return broker.ownedRuns?.get(runId);
}

async function closeOwnedRuns(broker, events) {
  for (const run of broker.ownedRuns?.values?.() ?? []) {
    if (broker.terminalProofs?.has(run.runId)) continue;
    const runnerProcessInstanceId = `${run.runId}-cleanup-runner`;
    const observedAt = Date.now();
    events.emit("subagent:process-terminal", {
      version: 1,
      state: "observed",
      runId: run.runId,
      runnerProcessInstanceId,
      observedAt,
      instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
    });
  }
  await events.settled?.();
  await broker.closeRootSession();
}

function installMissingOwnedRunsFallback(broker, events, captureProcessBirthIdentity, behavior) {
  if (broker.ownedRuns instanceof Map) return;
  const ownedRuns = new Map();
  broker.ownedRuns = ownedRuns;
  events.on("subagent:async-started", async (event) => {
    const runId = event?.id;
    if (typeof runId !== "string" || !Number.isSafeInteger(event?.pid) || event.pid <= 0 || event.sessionId !== rootSessionId || typeof event.asyncDir !== "string" || !event.asyncDir.startsWith("/")) return;
    if (!["executor", "plan-runner"].includes(event.agent)) return;
    if (behavior === "conflict" && ownedRuns.has(runId) && ownedRuns.get(runId)?.pid !== event.pid) {
      const previous = ownedRuns.get(runId);
      ownedRuns.set(runId, { ...previous, asyncDir: event.asyncDir, pid: event.pid, identityState: "verified" });
      return;
    }
    try {
      const birthIdentity = await captureProcessBirthIdentity(event.pid);
      const entry = { rootSessionId, runId, role: event.agent, asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid, birthIdentity, identityState: "verified" };
      if (behavior === "duplicate") ownedRuns.set(runId, entry);
      if (behavior === "conflict" && !ownedRuns.has(runId)) ownedRuns.set(runId, entry);
    } catch (error) {
      if (behavior !== "unavailable" || error?.code !== "PROCESS_BIRTH_IDENTITY_UNAVAILABLE") throw error;
    }
  });
}

test("root broker grants direct async executor runs idempotently", async (t) => {
  const grants = [];
  const events = startedEventBus();
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: fakeUpstream(),
    events,
    captureProcessBirthIdentity: async () => "stable-birth-identity",
    writeGrant: async (grant) => { grants.push(grant); return `/tmp/${grant.runId}`; },
    randomToken: () => "a".repeat(64),
  });
  await broker.start();
  t.after(() => closeOwnedRuns(broker, events));
  await Promise.all([
    events.emit("subagent:async-started", { id: "direct-executor", pid: 101, sessionId: rootSessionId, agent: "executor", cwd: "/repo", asyncDir: "/async/direct-executor" }),
    events.emit("subagent:async-started", { id: "direct-executor", pid: 101, sessionId: rootSessionId, agent: "executor", cwd: "/repo", asyncDir: "/async/direct-executor" }),
  ]);
  await events.settled();
  assert.deepEqual(grants, [{ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId, runId: "direct-executor", callerToken: "a".repeat(64), role: "executor" }]);
  assert.equal(broker.principals.get("direct-executor").role, "executor");
  await closeOwnedRuns(broker, events);
  assert.equal(events.unsubscribed, true);
});

test("started ownership records an exact verified executor entry from id-only event", async (t) => {
  const captures = []; const events = startedEventBus();
  const captureProcessBirthIdentity = async (pid) => { captures.push(pid); return "birth-701"; };
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), events, captureProcessBirthIdentity, writeGrant: async () => "/tmp/grant" });
  installMissingOwnedRunsFallback(broker, events, captureProcessBirthIdentity);
  await broker.start(); t.after(() => closeOwnedRuns(broker, events));
  events.emit("subagent:async-started", { id: "executor-701", pid: 701, sessionId: rootSessionId, agent: "executor", cwd: "/repo", asyncDir: "/async/executor-701" });
  await events.settled();
  assert.deepEqual(captures, [701]);
  assert.deepEqual(ownedRun(broker, "executor-701"), { rootSessionId, runId: "executor-701", role: "executor", asyncDir: "/async/executor-701", sessionId: rootSessionId, pid: 701, birthIdentity: "birth-701", identityState: "verified" });
});

test("started ownership records plan-runner identity without executor principal or grant", async (t) => {
  const captures = []; const grants = []; const events = startedEventBus();
  const captureProcessBirthIdentity = async (pid) => { captures.push(pid); return "birth-plan"; };
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), events, captureProcessBirthIdentity, writeGrant: async (grant) => { grants.push(grant); return "/tmp/grant"; } });
  installMissingOwnedRunsFallback(broker, events, captureProcessBirthIdentity);
  await broker.start(); t.after(() => closeOwnedRuns(broker, events));
  events.emit("subagent:async-started", { id: "plan-run-702", pid: 702, sessionId: rootSessionId, agent: "plan-runner", cwd: "/repo", asyncDir: "/async/plan-run-702" });
  await events.settled();
  assert.deepEqual(captures, [702]); assert.deepEqual(grants, []); assert.equal(broker.principals.has("plan-run-702"), false);
  assert.deepEqual(ownedRun(broker, "plan-run-702"), { rootSessionId, runId: "plan-run-702", role: "plan-runner", asyncDir: "/async/plan-run-702", sessionId: rootSessionId, pid: 702, birthIdentity: "birth-plan", identityState: "verified" });
});

test("birth identity unavailable records ownership but retains executor EOF grant", async (t) => {
  const events = startedEventBus(); const unavailable = Object.assign(new Error("unavailable"), { code: "PROCESS_BIRTH_IDENTITY_UNAVAILABLE" });
  const captureProcessBirthIdentity = async () => { throw unavailable; };
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), events, captureProcessBirthIdentity, writeGrant: async () => "/tmp/grant" });
  installMissingOwnedRunsFallback(broker, events, captureProcessBirthIdentity, "unavailable");
  await broker.start(); t.after(() => closeOwnedRuns(broker, events));
  events.emit("subagent:async-started", { id: "executor-703", pid: 703, sessionId: rootSessionId, agent: "executor", cwd: "/repo", asyncDir: "/async/executor-703" });
  await events.settled();
  assert.equal(broker.principals.get("executor-703")?.role, "executor");
  assert.deepEqual(ownedRun(broker, "executor-703"), { rootSessionId, runId: "executor-703", role: "executor", asyncDir: "/async/executor-703", sessionId: rootSessionId, pid: 703, birthIdentity: null, identityState: "unavailable" });
});

test("started ownership fails closed for malformed events before capture or grant", async (t) => {
  const captures = []; const grants = []; const events = startedEventBus();
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), events, captureProcessBirthIdentity: async (pid) => { captures.push(pid); return "birth"; }, writeGrant: async (grant) => { grants.push(grant); return "/tmp/grant"; } });
  await broker.start(); t.after(() => closeOwnedRuns(broker, events));
  for (const event of [
    { id: "missing-pid", sessionId: rootSessionId, agent: "executor", asyncDir: "/async/missing-pid" },
    { id: "unsafe-pid", pid: 0, sessionId: rootSessionId, agent: "executor", asyncDir: "/async/unsafe-pid" },
    { id: "negative-pid", pid: -1, sessionId: rootSessionId, agent: "executor", asyncDir: "/async/negative-pid" },
    { id: "non-safe-pid", pid: Number.MAX_SAFE_INTEGER + 1, sessionId: rootSessionId, agent: "executor", asyncDir: "/async/non-safe-pid" },
    { id: "relative-dir", pid: 704, sessionId: rootSessionId, agent: "executor", asyncDir: "async/relative" },
    { id: "missing-session", pid: 705, agent: "executor", asyncDir: "/async/missing-session" },
  ]) events.emit("subagent:async-started", event);
  await events.settled();
  assert.deepEqual(captures, []); assert.deepEqual(grants, []); assert.equal(broker.principals.size, 0); assert.equal(broker.ownedRuns?.size ?? 0, 0);
});

test("started ownership fails closed for foreign root session events before capture or grant", async (t) => {
  const captures = []; const grants = []; const events = startedEventBus();
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), events, captureProcessBirthIdentity: async (pid) => { captures.push(pid); return "birth"; }, writeGrant: async (grant) => { grants.push(grant); return "/tmp/grant"; } });
  await broker.start(); t.after(() => closeOwnedRuns(broker, events));
  events.emit("subagent:async-started", { id: "foreign-706", pid: 706, sessionId: "foreign-root", agent: "executor", cwd: "/repo", asyncDir: "/async/foreign-706" });
  await events.settled();
  assert.deepEqual(captures, []); assert.deepEqual(grants, []); assert.equal(broker.principals.size, 0); assert.equal(broker.ownedRuns?.size ?? 0, 0);
});

test("started ownership deduplicates exact events with one birth probe", async (t) => {
  const captures = []; const events = startedEventBus();
  const captureProcessBirthIdentity = async (pid) => { captures.push(pid); return "birth-707"; };
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), events, captureProcessBirthIdentity, writeGrant: async () => "/tmp/grant" });
  installMissingOwnedRunsFallback(broker, events, captureProcessBirthIdentity, "duplicate");
  await broker.start(); t.after(() => closeOwnedRuns(broker, events));
  const first = { id: "executor-707", pid: 707, sessionId: rootSessionId, agent: "executor", cwd: "/repo", asyncDir: "/async/executor-707" };
  events.emit("subagent:async-started", first); events.emit("subagent:async-started", { ...first });
  await events.settled();
  assert.deepEqual(captures, [707]);
  assert.deepEqual(ownedRun(broker, "executor-707"), { rootSessionId, runId: "executor-707", role: "executor", asyncDir: "/async/executor-707", sessionId: rootSessionId, pid: 707, birthIdentity: "birth-707", identityState: "verified" });
});

test("started ownership preserves first facts and marks conflicting identity without reprobe", async (t) => {
  const captures = []; const events = startedEventBus();
  const captureProcessBirthIdentity = async (pid) => { captures.push(pid); return "birth-707"; };
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream(), events, captureProcessBirthIdentity, writeGrant: async () => "/tmp/grant" });
  installMissingOwnedRunsFallback(broker, events, captureProcessBirthIdentity, "conflict");
  await broker.start(); t.after(() => closeOwnedRuns(broker, events));
  const first = { id: "executor-707", pid: 707, sessionId: rootSessionId, agent: "executor", cwd: "/repo", asyncDir: "/async/executor-707" };
  events.emit("subagent:async-started", first); await events.settled();
  events.emit("subagent:async-started", { ...first, pid: 708, asyncDir: "/async/conflict-707" });
  await events.settled();
  assert.deepEqual(captures, [707]);
  assert.deepEqual(ownedRun(broker, "executor-707"), { rootSessionId, runId: "executor-707", role: "executor", asyncDir: "/async/executor-707", sessionId: rootSessionId, pid: 707, birthIdentity: "birth-707", identityState: "conflict" });
});

test("executor grant subscribes with its own identity and cannot call other methods", async (t) => {
  const upstream = fakeUpstream();
  const broker = new RootBrokerServer({ rootSessionId, upstream });
  await broker.start();
  t.after(() => broker.closeRootSession());
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const spawned = await socketRequest(request({ callerRunId: "plan-run-1", callerToken: caller.callerToken, method: "spawn", params: { agent: "executor" } }));
  assert.equal(spawned.reply.success, true);
  const executor = await readBrokerGrant(rootSessionId, "executor-run-1");

  const subscription = await socketRequest(request({ callerRunId: executor.runId, callerToken: executor.callerToken, method: "subscribe", params: {} }), { keepOpen: true });
  assert.equal(subscription.reply.success, true);
  for (const denied of [
    request({ callerRunId: executor.runId, callerToken: "a".repeat(64), method: "subscribe", params: {} }),
    request({ callerRunId: "executor-run-2", callerToken: executor.callerToken, method: "subscribe", params: {} }),
  ]) {
    const reply = await socketRequest(denied);
    assert.equal(reply.reply.success, false);
    assert.equal(reply.reply.error.code, "caller_unauthorized");
  }

  for (const [method, params] of [
    ["ping", {}], ["spawn", {}], ["status", {}], ["steer", {}], ["interrupt", {}], ["stop", {}], ["supervisor.pending", {}], ["supervisor.reply", { replyTo: "request-2" }],
  ]) {
    const reply = await socketRequest(request({ callerRunId: executor.runId, callerToken: executor.callerToken, method, params }));
    assert.equal(reply.reply.success, false);
    assert.equal(reply.reply.error.code, "role_unauthorized");
  }
  assert.deepEqual(upstream.calls, [{ method: "spawn", params: { agent: "executor", async: true, clarify: false } }]);

  const closing = once(subscription.socket, "data");
  await broker.closeRootSession();
  assert.equal(JSON.parse((await closing)[0].toString()).callerRunId, executor.runId);
});

test("broker closes idle sockets, disposes upstream once, and validates caller grants at runtime", async (t) => {
  const order = [];
  const upstream = { ...fakeUpstream(), dispose() { order.push("upstream.dispose"); } };
  const broker = new RootBrokerServer({ rootSessionId, upstream });
  await broker.start();
  t.after(() => broker.closeRootSession());
  for (const grant of [
    { callerRunId: "bad-role", planId: "plan", cwd: "/repo", role: "executor" },
    { callerRunId: "empty-plan", planId: "", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" },
    { callerRunId: "relative-cwd", planId: "plan", cwd: "repo", role: "plan-runner" },
  ]) await assert.rejects(() => broker.grantCaller(grant));
  const idle = connect(brokerSocketPath(rootSessionId));
  await once(idle, "connect");
  await Promise.race([
    broker.closeRootSession(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 100)),
  ]);
  assert.deepEqual(order, ["upstream.dispose"]);
  await broker.closeRootSession();
  assert.deepEqual(order, ["upstream.dispose"]);
});

test("broker disposes upstream when grant cleanup fails", async (t) => {
  let disposed = 0;
  const grantDirectory = await mkdtemp(path.join(tmpdir(), "root-broker-grant-"));
  t.after(() => removePath(grantDirectory, { recursive: true, force: true }));
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: { ...fakeUpstream(), dispose() { disposed += 1; } },
  });
  await broker.start();
  broker.grantPaths.add(grantDirectory);

  await assert.rejects(() => broker.closeRootSession());
  assert.equal(disposed, 1);
});

test("broker normal close removes grants and releases every authorization collection", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "root-broker-close-"));
  const callerGrant = path.join(directory, "caller-grant.json");
  const executorGrant = path.join(directory, "executor-grant.json");
  let disposed = 0;
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: { ...fakeUpstream(), dispose() { disposed += 1; } },
    writeGrant: async (grant) => {
      const grantPath = grant.role === "executor" ? executorGrant : callerGrant;
      await writeFile(grantPath, JSON.stringify(grant));
      return grantPath;
    },
  });
  t.after(() => removePath(directory, { recursive: true, force: true }));
  await broker.start();
  await broker.grantCaller({ callerRunId: "plan-run-close-cleanup", planId: "plan", cwd: "/repo", originRoot: "/origin", stateRoot: "/state", role: "plan-runner" });
  await broker.ensureExecutorOwner("executor-run-close-cleanup");
  broker.runOwners.set("executor-run-close-cleanup", "plan-run-close-cleanup");

  await broker.closeRootSession();

  await assert.rejects(stat(callerGrant));
  await assert.rejects(stat(executorGrant));
  for (const collection of [broker.callers, broker.principals, broker.runOwners, broker.subscriptions, broker.sockets, broker.grantPaths, broker.executorGrants, broker.callerGrants]) assert.equal(collection.size, 0);
  assert.equal(disposed, 1);
});

test("broker cleans failed spawn grants and bounds failure messages", async () => {
  const stops = [];
  let grants = 0;
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: {
      ...fakeUpstream(),
      async spawn() { return { details: { runId: "executor-run-2", asyncDir: "/async/2" } }; },
      async stop(params) { stops.push(params); throw new Error("x".repeat(2_000)); },
    },
    writeGrant: async () => { if (grants++ > 0) throw new Error("grant write failed"); return "/tmp/grant"; },
  });
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const reply = await broker.dispatch(request({ callerRunId: "plan-run-1", callerToken: caller.callerToken, method: "spawn", params: { agent: "executor" } }), {});
  assert.equal(reply.success, false);
  assert.equal(reply.error.message.length <= 1024, true);
  assert.deepEqual(stops, [{ runId: "executor-run-2", dir: "/async/2" }]);
  assert.equal(broker.runOwners.has("executor-run-2"), false);
  assert.equal(broker.principals?.has("executor-run-2") ?? false, false);
});

test("broker leaves no executor principal after invalid spawn reply", async () => {
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: { ...fakeUpstream(), async spawn() { return { details: { runId: "executor-run-invalid" } }; } },
    writeGrant: async () => "/tmp/grant",
  });
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const reply = await broker.dispatch(request({ callerRunId: "plan-run-1", callerToken: caller.callerToken, method: "spawn", params: { agent: "executor" } }), {});
  assert.equal(reply.success, false);
  assert.equal(reply.error.code, "spawn_invalid");
  assert.equal(broker.runOwners.has("executor-run-invalid"), false);
  assert.equal(broker.principals?.has("executor-run-invalid") ?? false, false);
});

test("root broker registry isolates Pis and has bind/require/unbind contracts", () => {
  const first = {};
  const second = {};
  const broker = {};
  assert.throws(() => requireRootBroker(first));
  bindRootBroker(first, broker);
  assert.equal(requireRootBroker(first), broker);
  assert.throws(() => bindRootBroker(first, broker));
  assert.throws(() => requireRootBroker(second));
  unbindRootBroker(first);
  unbindRootBroker(first);
  assert.throws(() => requireRootBroker(first));
});

test("root broker startup keeps an existing binding and closes the rejected broker", async () => {
  const pi = {};
  const existing = {};
  const next = {
    starts: 0,
    closes: 0,
    async start() { this.starts += 1; },
    async closeRootSession() { this.closes += 1; },
  };
  bindRootBroker(pi, existing);

  await assert.rejects(() => startAndBindRootBroker(pi, next), /already bound/);
  assert.equal(next.starts, 0);
  assert.equal(next.closes, 1);
  assert.equal(requireRootBroker(pi), existing);
  unbindRootBroker(pi);
});

test("root broker startup rolls back only its failed reservation and closes it", async () => {
  const pi = {};
  const next = {
    closes: 0,
    async start() { throw new Error("listen failed"); },
    async closeRootSession() { this.closes += 1; },
  };

  await assert.rejects(() => startAndBindRootBroker(pi, next), /listen failed/);
  assert.equal(next.closes, 1);
  assert.throws(() => requireRootBroker(pi));
});

test("broker client excludes model spawnKey from upstream params", async (t) => {
  const upstream = fakeUpstream(); const broker = new RootBrokerServer({ rootSessionId, upstream }); await broker.start(); t.after(() => broker.closeRootSession());
  await broker.grantCaller({ callerRunId: "plan-client", planId: "plan", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "plan-client", randomUUID: () => "generated" }); t.after(() => client.dispose());
  await client.spawn({ agent: "executor", task: "run", spawnKey: "model-key" }, { requestId: "dispatch-client", spawnKey: "dispatch-client" });
  assert.deepEqual(upstream.calls, [{ method: "spawn", params: { agent: "executor", task: "run", async: true, clarify: false } }]);
});

test("broker client lookup finds the trusted durable key as spawned", async (t) => {
  const upstream = fakeUpstream(); const broker = new RootBrokerServer({ rootSessionId, upstream }); await broker.start(); t.after(() => broker.closeRootSession());
  await broker.grantCaller({ callerRunId: "plan-client-durable", planId: "plan", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "plan-client-durable", randomUUID: () => "generated" }); t.after(() => client.dispose());
  await client.spawn({ agent: "executor", task: "run", spawnKey: "model-key" }, { requestId: "dispatch-client", spawnKey: "dispatch-client" });
  const result = await client.lookupSpawn?.({ spawnKey: "dispatch-client" });
  assert.equal(result?.state, "spawned");
});

test("broker client lookup reports a model key as not-started", async (t) => {
  const upstream = fakeUpstream(); const broker = new RootBrokerServer({ rootSessionId, upstream }); await broker.start(); t.after(() => broker.closeRootSession());
  await broker.grantCaller({ callerRunId: "plan-client-model", planId: "plan", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "plan-client-model", randomUUID: () => "generated" }); t.after(() => client.dispose());
  await client.spawn({ agent: "executor", task: "run", spawnKey: "model-key" }, { requestId: "dispatch-client", spawnKey: "dispatch-client" });
  const result = await client.lookupSpawn?.({ spawnKey: "model-key" });
  assert.equal(result?.state, "not-started");
});

test("broker protocol capability includes spawn.lookup", () => { assert.equal(BROKER_METHODS.includes("spawn.lookup"), true); });

test("broker client exposes lookupSpawn", () => {
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "plan-client-lookup" });
  assert.equal(typeof client.lookupSpawn, "function"); client.dispose();
});

async function ledgerBroker(t, runId, upstream = fakeUpstream()) {
  const broker = new RootBrokerServer({ rootSessionId, upstream }); await broker.start(); t.after(() => broker.closeRootSession());
  const caller = await broker.grantCaller({ callerRunId: runId, planId: runId, cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const call = (method, params, requestId = "request-1") => socketRequest(request({ callerRunId: runId, callerToken: caller.callerToken, method, params, requestId }));
  const dispatch = (method, params, requestId = "request-1") => broker.dispatch(request({ callerRunId: runId, callerToken: caller.callerToken, method, params, requestId }), {});
  const lookup = (params, requestId = "request-1") => dispatch("spawn.lookup", params, requestId);
  return { upstream, call, dispatch, lookup, broker };
}

test("sequential equivalent durable spawns replay one exact binding", async (t) => {
  const { upstream, call } = await ledgerBroker(t, "plan-sequential");
  const spawnRequest = { agent: "executor", task: "run", spawnKey: "dispatch-sequential" };
  const first = await call("spawn", spawnRequest, "dispatch-sequential"); const second = await call("spawn", spawnRequest, "dispatch-sequential");
  assert.deepEqual(second.reply.data, first.reply.data); assert.equal(upstream.calls.filter((x) => x.method === "spawn").length, 1);
});

test("concurrent equivalent durable spawns share one deferred upstream request", async (t) => {
  let release; let entered; const blocked = new Promise((resolve) => { release = resolve; }); const enteredUpstream = new Promise((resolve) => { entered = resolve; }); const upstream = fakeUpstream(); upstream.spawn = async (params) => { upstream.calls.push({ method: "spawn", params }); entered(); await blocked; return { details: { runId: "concurrent-run", asyncDir: "/async/concurrent" } }; };
  const { dispatch } = await ledgerBroker(t, "plan-concurrent", upstream);
  const spawnRequest = { agent: "executor", task: "run", spawnKey: "dispatch-concurrent" };
  t.after(() => release?.());
  const left = dispatch("spawn", spawnRequest, "dispatch-concurrent"); await enteredUpstream; const right = dispatch("spawn", spawnRequest, "dispatch-concurrent");
  const calls = upstream.calls.length; release(); const [first, second] = await Promise.all([left, right]); assert.equal(calls, 1); assert.deepEqual(first.data, second.data);
});

test("conflicting durable spawn parameters return stable conflict without respawn", async (t) => {
  const { upstream, call } = await ledgerBroker(t, "plan-conflict");
  assert.equal((await call("spawn", { agent: "executor", task: "one", spawnKey: "dispatch-conflict" }, "dispatch-conflict")).reply.success, true);
  const conflict = await call("spawn", { agent: "executor", task: "two", spawnKey: "dispatch-conflict" }, "dispatch-conflict");
  assert.equal(conflict.reply.success, false); assert.equal(conflict.reply.error?.code, "spawn_conflict"); assert.equal(upstream.calls.length, 1);
});

test("lookup returns the caller's spawned durable binding", async (t) => {
  const { call, lookup } = await ledgerBroker(t, "plan-lookup-spawned");
  const spawned = await call("spawn", { agent: "executor", spawnKey: "dispatch-lookup" }, "dispatch-lookup");
  const found = await lookup({ spawnKey: "dispatch-lookup" });
  assert.equal(found.success, true); assert.equal(found.data?.state, "spawned"); assert.deepEqual(found.data?.binding, spawned.reply.data.details);
});

test("lookup reports not-started for an unknown durable key", async (t) => {
  const { lookup } = await ledgerBroker(t, "plan-lookup-unknown");
  const unknown = await lookup({ spawnKey: "unknown" });
  assert.equal(unknown.success, true); assert.equal(unknown.data?.state, "not-started");
});

test("lookup isolates a caller from another caller's durable binding", async (t) => {
  const { call, broker } = await ledgerBroker(t, "plan-lookup-a"); const other = await broker.grantCaller({ callerRunId: "plan-lookup-b", planId: "b", cwd: "/other", originRoot: "/other", stateRoot: "/other-state", role: "plan-runner" });
  await call("spawn", { agent: "executor", spawnKey: "dispatch-lookup" }, "dispatch-lookup");
  const lookupParams = { spawnKey: "dispatch-lookup" };
  const isolated = await broker.dispatch(request({ callerRunId: "plan-lookup-b", callerToken: other.callerToken, method: "spawn.lookup", params: lookupParams }), {});
  assert.equal(isolated.success, true); assert.equal(isolated.data?.state, "not-started");
});

test("pre-spawn rejection does not poison a durable key", async (t) => {
  const { call, upstream } = await ledgerBroker(t, "plan-preflight");
  const invalid = await call("spawn", { agent: "reviewer", spawnKey: "dispatch-preflight" }, "dispatch-preflight");
  assert.equal(invalid.reply.success, false); assert.equal(invalid.reply.error?.code, "spawn_unauthorized");
  assert.equal((await call("spawn", { agent: "executor", spawnKey: "dispatch-preflight" }, "dispatch-preflight")).reply.success, true);
  assert.equal(upstream.calls.filter((call) => call.method === "spawn").length, 1);
});

test("upstream failure makes a second durable spawn uncertain without retrying", async (t) => {
  let attempts = 0; const upstream = { ...fakeUpstream(), async spawn() { attempts += 1; throw new Error("connection lost"); } }; const { call } = await ledgerBroker(t, "plan-uncertain-retry", upstream);
  const params = { agent: "executor", spawnKey: "dispatch-uncertain" }; const first = await call("spawn", params, "dispatch-uncertain"); const second = await call("spawn", params, "dispatch-uncertain");
  assert.equal(first.reply.success, false); assert.equal(first.reply.error?.code, "upstream_failed");
  assert.equal(second.reply.success, false); assert.equal(second.reply.error?.code, "spawn_uncertain"); assert.equal(attempts, 1);
});

test("upstream failure lookup reports an unbound uncertain durable spawn", async (t) => {
  const upstream = { ...fakeUpstream(), async spawn() { throw new Error("connection lost"); } }; const { call, lookup } = await ledgerBroker(t, "plan-uncertain-lookup", upstream);
  const params = { agent: "executor", spawnKey: "dispatch-uncertain" }; await call("spawn", params, "dispatch-uncertain"); const found = await lookup({ spawnKey: "dispatch-uncertain" });
  assert.equal(found.success, true); assert.equal(found.data?.state, "uncertain"); assert.equal(Object.hasOwn(found.data ?? {}, "binding"), false);
});

async function notStartedLedgerBroker(t, runId) {
  let attempts = 0;
  const upstream = {
    ...fakeUpstream(),
    async spawn() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("request was not started");
        error.detail = { spawnDisposition: "not-started" };
        throw error;
      }
      return { details: { runId: "not-started-retry", asyncDir: "/async/not-started-retry" } };
    },
  };
  return { ...await ledgerBroker(t, runId, upstream), attempts: () => attempts };
}

async function cleanedGrantFailureBroker(t, runId) {
  let executorGrants = 0;
  let spawns = 0;
  const stops = [];
  const upstream = {
    ...fakeUpstream(),
    async spawn() { spawns += 1; return { details: { runId: `cleaned-run-${spawns}`, asyncDir: `/async/cleaned-${spawns}` } }; },
    async stop(params) { stops.push(params); return { stopped: true }; },
  };
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream,
    writeGrant: async (grant) => {
      if (grant.role === "executor" && executorGrants++ === 0) throw new Error("executor grant write failed");
      return `/tmp/${grant.runId}.json`;
    },
  });
  await broker.start();
  t.after(() => broker.closeRootSession());
  const caller = await broker.grantCaller({ callerRunId: runId, planId: runId, cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const dispatch = (method, params, requestId = "request-1") => broker.dispatch(request({ callerRunId: runId, callerToken: caller.callerToken, method, params, requestId }), {});
  return { dispatch, spawns: () => spawns, stops: () => stops.length };
}

async function uncertainCleanupBroker(t, runId) {
  let spawns = 0;
  let stops = 0;
  const upstream = {
    ...fakeUpstream(),
    async spawn() { spawns += 1; return { details: { runId: "uncertain-cleanup-run", asyncDir: "/async/uncertain-cleanup" } }; },
    async stop() { stops += 1; throw new Error("executor stop failed"); },
  };
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream,
    writeGrant: async (grant) => {
      if (grant.role === "executor") throw new Error("executor grant write failed");
      return `/tmp/${grant.runId}.json`;
    },
  });
  await broker.start();
  t.after(() => broker.closeRootSession());
  const caller = await broker.grantCaller({ callerRunId: runId, planId: runId, cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const dispatch = (method, params, requestId = "request-1") => broker.dispatch(request({ callerRunId: runId, callerToken: caller.callerToken, method, params, requestId }), {});
  return { dispatch, spawns: () => spawns, stops: () => stops };
}

test("an explicit not-started spawn is recorded as not-started", async (t) => {
  const { call, lookup } = await notStartedLedgerBroker(t, "plan-not-started-lookup");
  const params = { agent: "executor", spawnKey: "dispatch-not-started" };
  await call("spawn", params, "dispatch-not-started");
  const result = await lookup({ spawnKey: "dispatch-not-started" });

  assert.equal(result.data?.state, "not-started");
});

test("an explicit not-started spawn retries the same key", async (t) => {
  const { call, attempts } = await notStartedLedgerBroker(t, "plan-not-started-retry");
  const params = { agent: "executor", spawnKey: "dispatch-not-started" };
  await call("spawn", params, "dispatch-not-started");
  const second = await call("spawn", params, "dispatch-not-started");

  assert.equal(second.reply.success, true);
  assert.equal(attempts(), 2);
});

test("a cleaned grant failure is recorded without a binding", async (t) => {
  const { dispatch } = await cleanedGrantFailureBroker(t, "plan-cleaned-lookup");
  const params = { agent: "executor", spawnKey: "dispatch-cleaned" };
  await dispatch("spawn", params, "dispatch-cleaned");
  const result = await dispatch("spawn.lookup", { spawnKey: "dispatch-cleaned" });

  assert.equal(result.data?.state, "cleaned");
  assert.equal(Object.hasOwn(result.data ?? {}, "binding"), false);
});

test("a cleaned grant failure retries after the executor grant recovers", async (t) => {
  const { dispatch, spawns, stops } = await cleanedGrantFailureBroker(t, "plan-cleaned-retry");
  const params = { agent: "executor", spawnKey: "dispatch-cleaned" };
  await dispatch("spawn", params, "dispatch-cleaned");
  const second = await dispatch("spawn", params, "dispatch-cleaned");

  assert.equal(second.success, true);
  assert.equal(spawns(), 2);
  assert.equal(stops(), 1);
});

test("a grant and cleanup failure response includes the grant error", async (t) => {
  const { dispatch } = await uncertainCleanupBroker(t, "plan-uncertain-grant-message");
  const params = { agent: "executor", spawnKey: "dispatch-uncertain-cleanup" };
  const first = await dispatch("spawn", params, "dispatch-uncertain-cleanup");

  assert.match(first.error?.message ?? "", /executor grant write failed/);
});

test("a grant and cleanup failure response includes the stop error", async (t) => {
  const { dispatch } = await uncertainCleanupBroker(t, "plan-uncertain-stop-message");
  const params = { agent: "executor", spawnKey: "dispatch-uncertain-cleanup" };
  const first = await dispatch("spawn", params, "dispatch-uncertain-cleanup");

  assert.match(first.error?.message ?? "", /executor stop failed/);
});

test("a grant and cleanup failure is recorded as uncertain", async (t) => {
  const { dispatch } = await uncertainCleanupBroker(t, "plan-uncertain-lookup");
  const params = { agent: "executor", spawnKey: "dispatch-uncertain-cleanup" };
  await dispatch("spawn", params, "dispatch-uncertain-cleanup");
  const result = await dispatch("spawn.lookup", { spawnKey: "dispatch-uncertain-cleanup" });

  assert.equal(result.data?.state, "uncertain");
});

test("a grant and cleanup failure prevents a second durable spawn", async (t) => {
  const { dispatch, spawns, stops } = await uncertainCleanupBroker(t, "plan-uncertain-retry");
  const params = { agent: "executor", spawnKey: "dispatch-uncertain-cleanup" };
  await dispatch("spawn", params, "dispatch-uncertain-cleanup");
  const second = await dispatch("spawn", params, "dispatch-uncertain-cleanup");

  assert.equal(second.success, false);
  assert.equal(second.error?.code, "spawn_uncertain");
  assert.equal(spawns(), 1);
  assert.equal(stops(), 1);
});

function lifecycleEvents() {
  const listeners = new Map();
  const pending = new Set();
  return {
    on(channel, listener) { const values = listeners.get(channel) ?? new Set(); values.add(listener); listeners.set(channel, values); return () => values.delete(listener); },
    emit(channel, event) {
      for (const listener of listeners.get(channel) ?? []) {
        const result = listener(event);
        if (result?.then) {
          pending.add(result);
          void result.finally(() => pending.delete(result));
        }
      }
    },
    async settled() { while (pending.size > 0) await Promise.all([...pending]); },
  };
}

function lifecycleSocket() {
  const lines = [];
  return { lines, once() {}, write(line) { lines.push(JSON.parse(line)); } };
}

async function lifecycleBroker(t, eventDuringSpawn) {
  const events = lifecycleEvents();
  const upstream = fakeUpstream();
  upstream.spawn = async (params) => {
    upstream.calls.push({ method: "spawn", params });
    eventDuringSpawn(events, { aSocket, bSocket });
    return { details: { runId: "lifecycle-run", asyncDir: "/async/lifecycle" } };
  };
  const broker = new RootBrokerServer({ rootSessionId, upstream, events, captureProcessBirthIdentity: async () => "lifecycle-birth-identity" });
  await broker.start();
  t.after(() => closeOwnedRuns(broker, events));
  const a = await broker.grantCaller({ callerRunId: "caller-a", planId: "plan-a", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const b = await broker.grantCaller({ callerRunId: "caller-b", planId: "plan-b", cwd: "/other", originRoot: "/other", stateRoot: "/state-b", role: "plan-runner" });
  const aSocket = lifecycleSocket(); const bSocket = lifecycleSocket();
  await broker.dispatch(request({ callerRunId: "caller-a", callerToken: a.callerToken, method: "subscribe", params: {} }), aSocket);
  await broker.dispatch(request({ callerRunId: "caller-b", callerToken: b.callerToken, method: "subscribe", params: {} }), bSocket);
  return { broker, events, a, aSocket, bSocket };
}

async function cleanedLifecycleBroker(t) {
  const events = lifecycleEvents();
  let spawns = 0;
  let executorGrants = 0;
  const stops = [];
  const upstream = {
    ...fakeUpstream(),
    async spawn(params) {
      spawns += 1;
      upstream.calls.push({ method: "spawn", params });
      if (spawns === 1) {
        events.emit("subagent:async-started", { runId: "cleaned-run-1", pid: 811, agent: "executor", asyncDir: "/async/cleaned-1", cwd: "/repo", sessionId: rootSessionId });
      }
      return { details: { runId: `cleaned-run-${spawns}`, asyncDir: `/async/cleaned-${spawns}` } };
    },
    async stop(params) { stops.push(params); return { stopped: true }; },
  };
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream,
    events,
    captureProcessBirthIdentity: async () => "cleaned-lifecycle-birth-identity",
    writeGrant: async (grant) => {
      if (grant.role === "executor" && executorGrants++ === 0) throw new Error("executor grant write failed");
      return `/tmp/${grant.runId}.json`;
    },
  });
  await broker.start();
  t.after(() => closeOwnedRuns(broker, events));
  const a = await broker.grantCaller({ callerRunId: "caller-a", planId: "plan-cleaned-lifecycle", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const b = await broker.grantCaller({ callerRunId: "caller-b", planId: "plan-cleaned-other", cwd: "/other", originRoot: "/other", stateRoot: "/state-b", role: "plan-runner" });
  const aSocket = lifecycleSocket(); const bSocket = lifecycleSocket();
  await broker.dispatch(request({ callerRunId: "caller-a", callerToken: a.callerToken, method: "subscribe", params: {} }), aSocket);
  await broker.dispatch(request({ callerRunId: "caller-b", callerToken: b.callerToken, method: "subscribe", params: {} }), bSocket);
  const spawn = () => broker.dispatch(request({ callerRunId: "caller-a", callerToken: a.callerToken, method: "spawn", params: { agent: "executor", task: "run", spawnKey: "dispatch-cleaned-lifecycle" } }), {});
  const first = await spawn();
  await events.settled();
  assert.equal(first.success, false);
  assert.equal(stops.length, 1);
  const second = await spawn();
  assert.equal(second.success, true);
  assert.equal(spawns, 2);
  aSocket.lines.length = 0;
  bSocket.lines.length = 0;
  return { events, aSocket, bSocket };
}

test("broker defers owner-only started push until the durable spawn binding exists", async (t) => {
  const subject = await lifecycleBroker(t, (events, sockets) => {
    assert.deepEqual(sockets.aSocket.lines, []); assert.deepEqual(sockets.bSocket.lines, []);
    events.emit("subagent:async-started", { runId: "lifecycle-run", pid: 801, agent: "executor", asyncDir: "/async/lifecycle", cwd: "/repo", sessionId: rootSessionId });
  });
  const reply = await subject.broker.dispatch(request({ callerRunId: "caller-a", callerToken: subject.a.callerToken, method: "spawn", params: { agent: "executor", task: "run", spawnKey: "dispatch-lifecycle" } }), {});
  assert.equal(reply.success, true);
  await subject.events.settled();
  assert.equal(subject.aSocket.lines.length, 1);
  assert.equal(subject.bSocket.lines.length, 0);
  assert.deepEqual(subject.aSocket.lines[0], { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId, type: "execution.started", callerRunId: "caller-a", data: { dispatchId: "dispatch-lifecycle", runId: "lifecycle-run", asyncDir: "/async/lifecycle", cwd: "/repo", sessionId: rootSessionId, state: "running" } });
});

test("broker sends async completion only to the durable spawn owner", async (t) => {
  const subject = await lifecycleBroker(t, () => {});
  await subject.broker.dispatch(request({ callerRunId: "caller-a", callerToken: subject.a.callerToken, method: "spawn", params: { agent: "executor", task: "run", spawnKey: "dispatch-complete" } }), {});
  subject.events.emit("subagent:async-started", { runId: "lifecycle-run", pid: 802, agent: "executor", asyncDir: "/async/lifecycle", cwd: "/repo", sessionId: rootSessionId });
  await subject.events.settled();
  subject.aSocket.lines.length = 0;
  subject.events.emit("subagent:async-complete", { runId: "lifecycle-run", asyncDir: "/async/lifecycle", cwd: "/repo", sessionId: rootSessionId, state: "complete" });
  assert.deepEqual(subject.aSocket.lines, [{ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId, type: "execution.completed", callerRunId: "caller-a", data: { dispatchId: "dispatch-complete", runId: "lifecycle-run", asyncDir: "/async/lifecycle", cwd: "/repo", sessionId: rootSessionId, state: "complete" } }]);
  assert.deepEqual(subject.bSocket.lines, []);
});

test("broker reconstructs process-terminal lifecycle identity from its spawn ledger", async (t) => {
  const subject = await lifecycleBroker(t, () => {});
  await subject.broker.dispatch(request({ callerRunId: "caller-a", callerToken: subject.a.callerToken, method: "spawn", params: { agent: "executor", task: "run", spawnKey: "dispatch-terminal" } }), {});
  subject.events.emit("subagent:async-started", { runId: "lifecycle-run", pid: 803, agent: "executor", asyncDir: "/async/lifecycle", cwd: "/repo", sessionId: rootSessionId });
  await subject.events.settled();
  subject.aSocket.lines.length = 0;
  subject.events.emit("subagent:process-terminal", {
    version: 1,
    runId: "lifecycle-run",
    runnerProcessInstanceId: "runner-process-1",
    state: "observed",
    observedAt: 1_700_000_000_000,
    instances: [{ processInstanceId: "runner-process-1", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 0, signal: null }],
  });
  assert.deepEqual(subject.aSocket.lines, [{ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId, type: "execution.completed", callerRunId: "caller-a", data: { dispatchId: "dispatch-terminal", runId: "lifecycle-run", asyncDir: "/async/lifecycle", cwd: "/repo", sessionId: rootSessionId, state: "observed", processTerminal: { version: 1, runnerProcessInstanceId: "runner-process-1", state: "observed", observedAt: 1_700_000_000_000, instances: [{ processInstanceId: "runner-process-1", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 0, signal: null }] } } }]);
  assert.deepEqual(subject.bSocket.lines, []);
});

test("a cleaned retry does not reuse old started evidence for a new process terminal", async (t) => {
  const subject = await cleanedLifecycleBroker(t);
  subject.events.emit("subagent:process-terminal", {
    version: 1,
    runId: "cleaned-run-2",
    runnerProcessInstanceId: "runner-process-2",
    state: "observed",
    observedAt: 1_700_000_000_000,
    instances: [{ processInstanceId: "runner-process-2", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 0, signal: null }],
  });

  assert.deepEqual(subject.aSocket.lines, []);
  assert.deepEqual(subject.bSocket.lines, []);
});

test("a cleaned retry publishes only its new started identity", async (t) => {
  const subject = await cleanedLifecycleBroker(t);
  subject.events.emit("subagent:async-started", { runId: "cleaned-run-2", pid: 812, agent: "executor", asyncDir: "/async/cleaned-2", cwd: "/repo", sessionId: rootSessionId });
  await subject.events.settled();

  assert.deepEqual(subject.aSocket.lines, [{ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId, type: "execution.started", callerRunId: "caller-a", data: { dispatchId: "dispatch-cleaned-lifecycle", runId: "cleaned-run-2", asyncDir: "/async/cleaned-2", cwd: "/repo", sessionId: rootSessionId, state: "running" } }]);
  assert.deepEqual(subject.bSocket.lines, []);
});

function lifecycleCompletedPush(processTerminal, state = typeof processTerminal === "object" && processTerminal !== null ? processTerminal.state : "unknown") {
  return {
    schemaVersion: "pi-root-subagent-broker-push.v1",
    rootSessionId,
    callerRunId: "caller-lifecycle-protocol",
    type: "execution.completed",
    data: {
      dispatchId: "dispatch-lifecycle-protocol",
      runId: "run-lifecycle-protocol",
      asyncDir: "/async/lifecycle-protocol",
      cwd: "/repo",
      sessionId: "/sessions/lifecycle-protocol",
      state,
      processTerminal,
    },
  };
}

function observedProcessTerminal() {
  return {
    version: 1,
    runnerProcessInstanceId: "runner-process-protocol",
    resumeDisposition: "resumable",
    state: "observed",
    observedAt: 1_700_000_000_000,
    instances: [
      { processInstanceId: "runner-process-protocol", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 0, signal: null },
      { processInstanceId: "writer-process-protocol", kind: "pi-writer", attempt: 1, closeObservedAt: 1_700_000_000_001, exitCode: 0, signal: null },
    ],
    canonicalSession: { canonicalSessionId: "canonical-session-protocol", leaseDisposition: "released", freeAtObservation: true, canonicalSessionLeaseReleased: true },
  };
}

test("frame decoder accepts multiple valid frames across chunks", () => {
  const small = lifecycleCompletedPush({ version: 1, runnerProcessInstanceId: "runner-small-frame", state: "pending" });
  const large1 = lifecycleCompletedPush({ version: 1, runnerProcessInstanceId: "runner-large-frame-1", state: "unknown", reason: "observer-unavailable", diagnostic: "x".repeat(40 * 1024) });
  const large2 = lifecycleCompletedPush({ version: 1, runnerProcessInstanceId: "runner-large-frame-2", state: "unknown", reason: "observer-unavailable", diagnostic: "y".repeat(40 * 1024) });
  const smallFrame = `${JSON.stringify(small)}\n`;
  const large1Frame = `${JSON.stringify(large1)}\n`;
  const large2Frame = `${JSON.stringify(large2)}\n`;
  const prefixLength = Math.floor(large1Frame.length / 4);
  const large1Prefix = large1Frame.slice(0, prefixLength);
  const large1Suffix = large1Frame.slice(prefixLength);

  for (const push of [small, large1, large2]) assert.deepEqual(parseBrokerPush(push), push);
  for (const frame of [smallFrame, large1Frame, large2Frame]) assert.ok(Buffer.byteLength(frame, "utf8") <= BROKER_FRAME_LIMIT_BYTES);
  assert.equal(large1Prefix.includes("\n"), false);

  const decoder = createBrokerFrameDecoder();
  assert.deepEqual(decoder.push(`${smallFrame}${large1Prefix}`), [smallFrame.trimEnd()]);
  assert.ok(Buffer.byteLength(`${large1Prefix}${large1Suffix}${large2Frame}`, "utf8") > BROKER_FRAME_LIMIT_BYTES);
  assert.deepEqual(decoder.push(`${large1Suffix}${large2Frame}`), [large1Frame.trimEnd(), large2Frame.trimEnd()]);
});

test("frame decoder preserves UTF-8 split across chunks", () => {
  const push = lifecycleCompletedPush({ version: 1, runnerProcessInstanceId: "runner-utf8-frame", state: "unknown", reason: "observer-unavailable", diagnostic: "中文 diagnostic" });
  const frame = Buffer.from(`${JSON.stringify(push)}\n`, "utf8");
  const chineseCharacter = Buffer.from("中", "utf8");
  const splitIndex = frame.indexOf(chineseCharacter) + 1;

  assert.deepEqual(parseBrokerPush(push), push);
  assert.ok(Buffer.byteLength(frame) <= BROKER_FRAME_LIMIT_BYTES);
  assert.ok(splitIndex > 0);
  assert.equal(frame[splitIndex - 1] & 0xc0, 0xc0);
  assert.equal(frame[splitIndex] & 0xc0, 0x80);

  const decoder = createBrokerFrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, splitIndex)), []);
  const [line] = decoder.push(frame.subarray(splitIndex));
  assert.equal(line, `${JSON.stringify(push)}`);
  assert.deepEqual(JSON.parse(line), push);
});

test("lifecycle push protocol accepts pinned observed, unknown, pending, and not-started terminals", () => {
  const terminals = [
    observedProcessTerminal(),
    { version: 1, childIndex: 2, runnerProcessInstanceId: "runner-unknown-protocol", resumeDisposition: "unavailable", state: "unknown", reason: "observer-unavailable", diagnostic: "observer disconnected" },
    { version: 1, runnerProcessInstanceId: "runner-pending-protocol", state: "pending" },
    { version: 1, runnerProcessInstanceId: "runner-not-started-protocol", state: "not-started" },
  ];

  for (const terminal of terminals) {
    const push = lifecycleCompletedPush(terminal);
    assert.deepEqual(parseBrokerPush(push), push);
  }
});

test("lifecycle push protocol rejects a complete frame over 64 KiB", () => {
  const processTerminal = { version: 1, runnerProcessInstanceId: "runner-frame-protocol", state: "unknown", reason: "observer-unavailable", diagnostic: "x".repeat(64 * 1024 - 256) };
  const push = lifecycleCompletedPush(processTerminal);
  assert.ok(Buffer.byteLength(JSON.stringify(processTerminal), "utf8") < 64 * 1024);
  assert.ok(Buffer.byteLength(`${JSON.stringify(push)}\n`, "utf8") > 64 * 1024);
  assert.throws(() => parseBrokerPush(push), /frame|size|large/i);
});

test("lifecycle push protocol rejects a non-object processTerminal", () => {
  assert.throws(() => parseBrokerPush(lifecycleCompletedPush("not-a-terminal")), /terminal|process|proof/i);
});

test("lifecycle push protocol rejects unknown processTerminal fields", () => {
  assert.throws(() => parseBrokerPush(lifecycleCompletedPush({ ...observedProcessTerminal(), extra: true })), /terminal|field|process|proof/i);
});

test("lifecycle push protocol rejects observed terminals without instances", () => {
  const terminal = observedProcessTerminal();
  delete terminal.instances;
  assert.throws(() => parseBrokerPush(lifecycleCompletedPush(terminal)), /terminal|instances|process|proof/i);
});

test("lifecycle push protocol rejects observed terminals without the runner instance", () => {
  const terminal = observedProcessTerminal();
  terminal.instances[0].processInstanceId = "other-runner-process";
  assert.throws(() => parseBrokerPush(lifecycleCompletedPush(terminal)), /terminal|runner|instances|process|proof/i);
});

test("lifecycle push protocol rejects terminal states that disagree with completion state", () => {
  assert.throws(() => parseBrokerPush(lifecycleCompletedPush(observedProcessTerminal(), "complete")), /terminal|state|process|proof/i);
});

test("lifecycle push protocol rejects unknown terminals with an invalid reason", () => {
  const terminal = { version: 1, runnerProcessInstanceId: "runner-reason-protocol", state: "unknown", reason: "not-a-pinned-reason" };
  assert.throws(() => parseBrokerPush(lifecycleCompletedPush(terminal)), /terminal|reason|process|proof/i);
});

function supervisorIngress({ id, runId, content = "Need approval", reason = "need_decision", expectsReply = true, agent = "executor", childIndex = 0 }) {
  return { customType: "subagent_supervisor_request", content, details: { id, runId, reason, expectsReply, agent, childIndex } };
}

async function waitForCondition(predicate, expected, { timeoutMs = 250, pollMs = 5, stablePolls = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveMatches = 0;
  while (Date.now() <= deadline) {
    if (predicate()) {
      consecutiveMatches += 1;
      if (consecutiveMatches >= stablePolls) return;
    } else {
      consecutiveMatches = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test("routes Supervisor requests only to the Executor owner in stable owner order", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() });
  await broker.start();
  const grantA = await broker.grantCaller({ callerRunId: "supervisor-plan-a", planId: "supervisor-a", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const grantB = await broker.grantCaller({ callerRunId: "supervisor-plan-b", planId: "supervisor-b", cwd: "/other", originRoot: "/other", stateRoot: "/state-b", role: "plan-runner" });
  broker.runOwners.set("supervisor-executor-a", "supervisor-plan-a");
  broker.runOwners.set("supervisor-executor-b", "supervisor-plan-b");
  const a = createRootBrokerClient({ rootSessionId, callerRunId: "supervisor-plan-a" });
  const b = createRootBrokerClient({ rootSessionId, callerRunId: "supervisor-plan-b" });
  const pushedA = []; const pushedB = [];
  const subscriptionA = await a.subscribe((push) => pushedA.push(push));
  const subscriptionB = await b.subscribe((push) => pushedB.push(push));
  const closedA = subscriptionA.closed.catch((error) => error);
  const closedB = subscriptionB.closed.catch((error) => error);
  t.after(async () => {
    subscriptionA.dispose(); subscriptionB.dispose();
    a.dispose(); b.dispose();
    await Promise.all([closedA, closedB]);
    await broker.closeRootSession();
  });
  await broker.routeSupervisorRequest(supervisorIngress({ id: "A1", runId: "supervisor-executor-a" }));
  await broker.routeSupervisorRequest(supervisorIngress({ id: "B2", runId: "supervisor-executor-b" }));
  await broker.routeSupervisorRequest(supervisorIngress({ id: "A2", runId: "supervisor-executor-a" }));
  await waitForCondition(() => pushedA.length === 2 && pushedB.length === 1, "two owner A pushes and one owner B push");
  assert.deepEqual(pushedA.map((push) => push.data), [
    { requestId: "A1", executorRunId: "supervisor-executor-a", content: "Need approval", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 },
    { requestId: "A2", executorRunId: "supervisor-executor-a", content: "Need approval", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 },
  ]);
  assert.deepEqual(pushedB.map((push) => push.data), [{ requestId: "B2", executorRunId: "supervisor-executor-b", content: "Need approval", reason: "need_decision", expectsReply: true, agent: "executor", childIndex: 0 }]);
});

test("Supervisor pending exposes only requests owned by its caller", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() }); await broker.start(); t.after(() => broker.closeRootSession());
  const a = await broker.grantCaller({ callerRunId: "pending-a", planId: "pending-a", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const b = await broker.grantCaller({ callerRunId: "pending-b", planId: "pending-b", cwd: "/other", originRoot: "/other", stateRoot: "/state-b", role: "plan-runner" });
  broker.runOwners.set("pending-executor-a", "pending-a"); broker.runOwners.set("pending-executor-b", "pending-b");
  await broker.routeSupervisorRequest(supervisorIngress({ id: "pending-A", runId: "pending-executor-a" }));
  await broker.routeSupervisorRequest(supervisorIngress({ id: "pending-B", runId: "pending-executor-b" }));
  const pendingA = await broker.dispatch(request({ callerRunId: "pending-a", callerToken: a.callerToken, method: "supervisor.pending", params: {} }), {});
  const pendingB = await broker.dispatch(request({ callerRunId: "pending-b", callerToken: b.callerToken, method: "supervisor.pending", params: {} }), {});
  assert.deepEqual(pendingA.data?.pending?.map((entry) => entry.requestId), ["pending-A"]);
  assert.deepEqual(pendingB.data?.pending?.map((entry) => entry.requestId), ["pending-B"]);
});

test("Supervisor reply fences ownership, strips Plan routing, and consumes requests exactly once", async (t) => {
  const calls = [];
  const nativeResult = { content: [{ type: "text", text: "replied natively" }] };
  const upstream = { ...fakeUpstream(), async executeSupervisor(params) { calls.push(params); return nativeResult; } };
  const broker = new RootBrokerServer({ rootSessionId, upstream }); await broker.start(); t.after(() => broker.closeRootSession());
  const a = await broker.grantCaller({ callerRunId: "reply-a", planId: "reply-a", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const b = await broker.grantCaller({ callerRunId: "reply-b", planId: "reply-b", cwd: "/other", originRoot: "/other", stateRoot: "/state-b", role: "plan-runner" });
  broker.runOwners.set("reply-executor-a", "reply-a");
  await broker.routeSupervisorRequest(supervisorIngress({ id: "reply-A", runId: "reply-executor-a" }));
  const denied = await broker.dispatch(request({ callerRunId: "reply-b", callerToken: b.callerToken, method: "supervisor.reply", params: { replyTo: "reply-A", message: "no", to: "executor" } }), {});
  assert.equal(denied.error?.code, "supervisor_not_owned");
  assert.deepEqual(calls, []);
  const replied = await broker.dispatch(request({ callerRunId: "reply-a", callerToken: a.callerToken, method: "supervisor.reply", params: { replyTo: "reply-A", message: "yes", to: "executor" } }), {});
  assert.strictEqual(replied.data, nativeResult);
  assert.deepEqual(calls, [{ action: "reply", replyTo: "reply-A", message: "yes" }]);
  for (const replyTo of ["unknown", "reply-A"]) {
    const rejected = await broker.dispatch(request({ callerRunId: "reply-a", callerToken: a.callerToken, method: "supervisor.reply", params: { replyTo, message: "again" } }), {});
    assert.equal(rejected.error?.code, "supervisor_request_unknown");
  }
  assert.equal(calls.length, 1);
});

test("rejects oversized Supervisor final frames", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() }); await broker.start();
  await broker.grantCaller({ callerRunId: "frame-owner", planId: "frame-owner", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "frame-owner" });
  const subscription = await client.subscribe(() => {});
  const closed = subscription.closed.catch((error) => error);
  t.after(async () => {
    subscription.dispose();
    client.dispose();
    await closed;
    await broker.closeRootSession();
  });
  broker.runOwners.set("frame-executor", "frame-owner");

  const result = await broker.routeSupervisorRequest(supervisorIngress({ id: "frame-limit", runId: "frame-executor", content: "x".repeat(BROKER_FRAME_LIMIT_BYTES) }));

  assert.deepEqual({
    code: result?.code,
    registered: broker.supervisorRequests.has("frame-limit"),
  }, {
    code: "supervisor_request_invalid",
    registered: false,
  });
});

test("does not authorize replies to Supervisor progress updates", async (t) => {
  const calls = [];
  const upstream = { ...fakeUpstream(), async executeSupervisor(params) { calls.push(params); return { content: [] }; } };
  const broker = new RootBrokerServer({ rootSessionId, upstream }); await broker.start(); t.after(() => broker.closeRootSession());
  const owner = await broker.grantCaller({ callerRunId: "progress-owner", planId: "progress-owner", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  broker.runOwners.set("progress-executor", "progress-owner");

  await broker.routeSupervisorRequest(supervisorIngress({ id: "progress-update", runId: "progress-executor", reason: "progress_update", expectsReply: false }));
  const pending = await broker.dispatch(request({ callerRunId: "progress-owner", callerToken: owner.callerToken, method: "supervisor.pending", params: {} }), {});
  const reply = await broker.dispatch(request({ callerRunId: "progress-owner", callerToken: owner.callerToken, method: "supervisor.reply", params: { replyTo: "progress-update", message: "acknowledged" } }), {});

  assert.deepEqual({
    pending: pending.data?.pending,
    replyCode: reply.error?.code,
    calls,
  }, {
    pending: [],
    replyCode: "supervisor_request_unknown",
    calls: [],
  });
});

test("rejects conflicting Supervisor ingress without changing the original owner", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId, upstream: fakeUpstream() }); await broker.start();
  await broker.grantCaller({ callerRunId: "owner-a", planId: "ingress-a", cwd: "/repo", originRoot: "/repo", stateRoot: "/state", role: "plan-runner" });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: "owner-a" });
  const pushed = []; const subscription = await client.subscribe((push) => pushed.push(push));
  const closed = subscription.closed.catch((error) => error);
  t.after(async () => {
    subscription.dispose();
    client.dispose();
    await closed;
    await broker.closeRootSession();
  });
  broker.runOwners.set("ingress-a", "owner-a"); broker.runOwners.set("ingress-b", "owner-b");
  await broker.routeSupervisorRequest(supervisorIngress({ id: "ingress-1", runId: "unknown-run" }));
  await waitForCondition(() => pushed.length === 0, "no push for unknown ingress", { stablePolls: 2 });
  await broker.routeSupervisorRequest(supervisorIngress({ id: "ingress-1", runId: "ingress-a", content: "first" }));
  await waitForCondition(() => pushed.length === 1, "one push for the first valid ingress");
  await broker.routeSupervisorRequest(supervisorIngress({ id: "ingress-1", runId: "ingress-a", content: "first" }));
  await waitForCondition(() => pushed.length === 1, "one stable push after the exact duplicate ingress", { stablePolls: 2 });
  const conflict = await broker.routeSupervisorRequest(supervisorIngress({ id: "ingress-1", runId: "ingress-b", content: "conflict" }));
  assert.equal(conflict?.code, "supervisor_request_conflict");
  assert.equal(pushed.length, 1);
  assert.equal(broker.supervisorRequests?.get("ingress-1")?.ownerRunId, "owner-a");
});

let orderedDrainFixtureNumber = 0;

async function orderedDrainFixture(t, { emitTerminalOnStop = false, unavailableBirthIdentity = false, failStopOnce, terminalTimeoutMs = 250 } = {}) {
  const events = startedEventBus();
  const root = `ordered-drain-root-${++orderedDrainFixtureNumber}`;
  const stopOrder = [];
  const timeline = [];
  let timelineSequence = 0;
  const record = (entry) => timeline.push({ ...entry, at: Date.now(), sequence: ++timelineSequence });
  const socket = {
    destroyed: false,
    write(frame) { record({ action: "socket.write", frame: JSON.parse(frame) }); return true; },
    end() { record({ action: "socket.end" }); },
    destroy() { this.destroyed = true; record({ action: "socket.destroy" }); },
  };
  const terminal = (runId, state = "observed") => {
    const runnerProcessInstanceId = `${runId}-instance`;
    const processTerminal = state === "observed"
      ? {
        version: 1,
        state: "observed",
        runId,
        runnerProcessInstanceId,
        observedAt: Date.now(),
        instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: Date.now(), exitCode: 0, signal: null }],
      }
      : { version: 1, state: "unknown", runId, runnerProcessInstanceId, reason: "observer-unavailable" };
    record({ action: "terminal.event", runId, state: processTerminal.state });
    events.emit("subagent:process-terminal", processTerminal);
  };
  const upstream = {
    ...fakeUpstream(),
    async stop({ runId, dir }) {
      const entry = { runId, dir, at: Date.now() };
      stopOrder.push(entry); record({ action: "upstream.stop", ...entry });
      if (failStopOnce === runId && stopOrder.filter((item) => item.runId === runId).length === 1) throw new Error(`controlled stop failure for ${runId}`);
      if (emitTerminalOnStop) terminal(runId);
      return { stopped: true };
    },
    dispose() { record({ action: "upstream.dispose" }); },
  };
  const broker = new RootBrokerServer({
    rootSessionId: root,
    upstream,
    events,
    terminalTimeoutMs,
    captureProcessBirthIdentity: async () => {
      if (unavailableBirthIdentity) throw Object.assign(new Error("birth identity unavailable"), { code: "PROCESS_BIRTH_IDENTITY_UNAVAILABLE" });
      return "trusted-birth";
    },
    writeGrant: async (grant) => `/tmp/${root}-${grant.runId}.json`,
  });
  await broker.start();
  for (const [id, pid, agent] of [["executor-a", 8101, "executor"], ["executor-b", 8102, "executor"], ["plan-runner", 8103, "plan-runner"]]) {
    events.emit("subagent:async-started", { id, pid, agent, sessionId: root, cwd: "/trusted", asyncDir: `/trusted/${id}` });
  }
  await events.settled();
  broker.subscriptions.set("plan-runner", new Set([socket]));
  t.after(async () => { await closeOwnedRuns(broker, events).catch(() => undefined); });
  return { broker, events, root, socket, stopOrder, terminal, timeline };
}

function terminalEntries(subject, runId) {
  return subject.timeline.filter((entry) => entry.action === "terminal.event" && entry.runId === runId);
}

test("Root session ordered drain stops Executors, observes terminals, then stops Plan Runner", async (t) => {
  const subject = await orderedDrainFixture(t, { emitTerminalOnStop: true });
  await subject.broker.closeRootSession();
  assert.deepEqual(subject.stopOrder.map(({ runId, dir }) => ({ runId, dir })), [
    { runId: "executor-a", dir: "/trusted/executor-a" },
    { runId: "executor-b", dir: "/trusted/executor-b" },
    { runId: "plan-runner", dir: "/trusted/plan-runner" },
  ], "stopOrder drains Executors before Plan Runner");
  const executorTerminals = ["executor-a", "executor-b"].flatMap((runId) => terminalEntries(subject, runId));
  const planTerminal = terminalEntries(subject, "plan-runner").at(-1);
  const closing = subject.timeline.filter((entry) => entry.action === "socket.write" && entry.frame.type === "root.closing").at(-1);
  const socketEnd = subject.timeline.find((entry) => entry.action === "socket.end");
  const dispose = subject.timeline.find((entry) => entry.action === "upstream.dispose");
  assert.equal(executorTerminals.length, 2, "both Executor terminal events are recorded");
  assert.ok(executorTerminals.every((entry) => entry.sequence < planTerminal.sequence && entry.at <= planTerminal.at));
  assert.ok(planTerminal.sequence < closing.sequence && planTerminal.at <= closing.at);
  assert.ok(planTerminal.sequence < socketEnd.sequence && planTerminal.at <= socketEnd.at);
  assert.ok(planTerminal.sequence < dispose.sequence && planTerminal.at <= dispose.at);
  assert.equal(subject.timeline.filter((entry) => entry.action === "socket.write").at(-1).frame.type, "root.closing");
});

test("Root session ordered drain remains pending until exact observed process terminals", async (t) => {
  const subject = await orderedDrainFixture(t, { terminalTimeoutMs: 250 });
  let outcome;
  const closing = subject.broker.closeRootSession().then(
    () => { outcome = { status: "resolved" }; },
    (error) => { outcome = { status: "rejected", error }; },
  );
  subject.events.emit("subagent:async-complete", { runId: "executor-a", sessionId: subject.root });
  subject.terminal("executor-a", "unknown");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(outcome, undefined, "async-complete plus unknown must remain pending inside its 250ms terminal deadline");
  subject.terminal("executor-a"); subject.terminal("executor-b");
  await waitForCondition(() => subject.stopOrder.some((entry) => entry.runId === "plan-runner"), "Plan Runner stop after Executor observations", { timeoutMs: 40, pollMs: 2 });
  assert.equal(outcome, undefined, "Plan Runner stop request is not its terminal proof");
  subject.terminal("plan-runner");
  await closing;
  assert.deepEqual(outcome, { status: "resolved" });
});

test("Root session ordered drain retains cleanup debt after unknown terminal without birth identity", async (t) => {
  const subject = await orderedDrainFixture(t, { unavailableBirthIdentity: true, terminalTimeoutMs: 50 });
  const closing = subject.broker.closeRootSession();
  assert.deepEqual(subject.stopOrder.map((entry) => entry.runId), ["executor-a", "executor-b"], "cleanup debt attempts both Executor stops before terminal proof failure");
  subject.terminal("executor-a", "unknown");
  await assert.rejects(() => closing, (error) => error instanceof AggregateError, "unknown terminal with unavailable birth identity leaves cleanup debt");
  assert.equal(subject.stopOrder.some((entry) => entry.runId === "plan-runner"), false);
  assert.equal(subject.broker.server?.listening, true);
  assert.equal(typeof subject.broker.unsubscribeTerminal, "function");
  assert.equal(subject.timeline.some((entry) => entry.action === "socket.write"), false);
  assert.equal(subject.timeline.some((entry) => entry.action === "socket.end"), false);
  assert.equal(subject.timeline.some((entry) => entry.action === "upstream.dispose"), false);
  subject.terminal("executor-a"); subject.terminal("executor-b");
  const retry = subject.broker.closeRootSession();
  await waitForCondition(() => subject.stopOrder.some((entry) => entry.runId === "plan-runner"), "Plan Runner stop on debt retry", { timeoutMs: 40, pollMs: 2 });
  subject.terminal("plan-runner");
  await retry;
});

test("Root session ordered drain aggregates Executor stop failures and retries only debt", async (t) => {
  const subject = await orderedDrainFixture(t, { emitTerminalOnStop: true, failStopOnce: "executor-a" });
  await assert.rejects(() => subject.broker.closeRootSession(), AggregateError);
  assert.deepEqual(subject.stopOrder.map((entry) => entry.runId), ["executor-a", "executor-b"], "all-settled drains the second Executor after the first stop failure");
  assert.equal(subject.stopOrder.some((entry) => entry.runId === "plan-runner"), false);
  assert.equal(subject.timeline.some((entry) => entry.action === "upstream.dispose"), false);
  await subject.broker.closeRootSession();
  assert.deepEqual(subject.stopOrder.map((entry) => entry.runId), ["executor-a", "executor-b", "executor-a", "plan-runner"]);
});

test("Root session ordered drain is single-flight and idempotent", async (t) => {
  const subject = await orderedDrainFixture(t, { emitTerminalOnStop: true });
  await Promise.all([subject.broker.closeRootSession(), subject.broker.closeRootSession()]);
  await subject.broker.closeRootSession();
  assert.deepEqual(subject.stopOrder.map((entry) => entry.runId), ["executor-a", "executor-b", "plan-runner"]);
  assert.equal(subject.timeline.filter((entry) => entry.action === "socket.write" && entry.frame.type === "root.closing").length, 1);
  assert.equal(subject.timeline.filter((entry) => entry.action === "socket.end").length, 1);
  assert.equal(subject.timeline.filter((entry) => entry.action === "upstream.dispose").length, 1);
});
