import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { mkdtemp, rm as removePath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { brokerGrantPath, brokerSocketPath } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";
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

test("broker forwards flat spawn, projects caller cwd, rejects foreign control, and closes subscribers", async (t) => {
  const upstream = fakeUpstream();
  const broker = new RootBrokerServer({ rootSessionId, upstream });
  await broker.start();
  t.after(() => broker.closeRootSession());
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", role: "plan-runner" });
  const other = await broker.grantCaller({ callerRunId: "plan-run-2", planId: "plan-2", cwd: "/other", role: "plan-runner" });

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
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", role: "plan-runner" });
  for (const change of [{ root: "other-root" }, { callerRunId: "other-run" }, { callerToken: "b".repeat(64) }]) {
    const reply = await socketRequest(request({ callerRunId: change.callerRunId ?? "plan-run-1", callerToken: change.callerToken ?? caller.callerToken, method: "ping", params: {}, root: change.root ?? rootSessionId }));
    assert.equal(reply.reply.success, false);
  }
});

test("broker closes idle sockets, disposes upstream once, and validates caller grants at runtime", async (t) => {
  const order = [];
  const upstream = { ...fakeUpstream(), dispose() { order.push("upstream.dispose"); } };
  const broker = new RootBrokerServer({ rootSessionId, upstream });
  await broker.start();
  t.after(() => broker.closeRootSession());
  for (const grant of [
    { callerRunId: "bad-role", planId: "plan", cwd: "/repo", role: "executor" },
    { callerRunId: "empty-plan", planId: "", cwd: "/repo", role: "plan-runner" },
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
  const caller = await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", role: "plan-runner" });
  const reply = await broker.dispatch(request({ callerRunId: "plan-run-1", callerToken: caller.callerToken, method: "spawn", params: { agent: "executor" } }), {});
  assert.equal(reply.success, false);
  assert.equal(reply.error.message.length <= 1024, true);
  assert.deepEqual(stops, [{ runId: "executor-run-2", dir: "/async/2" }]);
  assert.equal(broker.runOwners.has("executor-run-2"), false);
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
