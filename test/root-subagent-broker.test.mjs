import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { mkdtemp, mkdir, rm as removePath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { brokerGrantPath, brokerSocketPath, readBrokerGrant } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";
import { createRootBrokerClient } from "../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { bootstrapRuntimeRoots, default as planRunner } from "../pi/child-extensions/plan-runner.ts";
import { installRootSessionOwner, installRootSessionOwnerLifecycle } from "../pi/child-extensions/root-session-owner.ts";
import { bindRootBroker, requireRootBroker, startAndBindRootBroker, unbindRootBroker } from "../scripts/lib/subagent-dispatch/root-broker-registry.ts";

const rootSessionId = "root-broker-test-1";

function fakeUpstream() {
  const calls = [];
  return {
    calls,
    async ping() { return { version: 1, methods: ["ping", "spawn", "stop"], session: { cwd: "/root" } }; },
    async spawn(params) { calls.push({ method: "spawn", params }); return { details: { runId: "executor-run-1", asyncDir: "/async/1" } }; },
    async stop(params) { calls.push({ method: "stop", params }); return { stopped: true }; },
  };
}

function request({ callerRunId, callerToken, method, params, requestId = "request-1", root = rootSessionId }) {
  return { schemaVersion: "pi-root-subagent-broker-request.v1", requestId, rootSessionId: root, callerRunId, callerToken, method, params };
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

test("root broker grants direct async executor runs idempotently", async (t) => {
  const grants = [];
  const events = { on(_channel, listener) { this.listener = listener; return () => { this.unsubscribed = true; }; } };
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: fakeUpstream(),
    events,
    writeGrant: async (grant) => { grants.push(grant); return `/tmp/${grant.runId}`; },
    randomToken: () => "a".repeat(64),
  });
  await broker.start();
  t.after(() => broker.closeRootSession());
  await Promise.all([
    events.listener({ id: "direct-executor", agent: "executor" }),
    events.listener({ runId: "direct-executor", agent: "executor" }),
  ]);
  assert.deepEqual(grants, [{ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId, runId: "direct-executor", callerToken: "a".repeat(64), role: "executor" }]);
  assert.equal(broker.principals.get("direct-executor").role, "executor");
  await broker.closeRootSession();
  assert.equal(events.unsubscribed, true);
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
