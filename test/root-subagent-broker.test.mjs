import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { stat } from "node:fs/promises";
import test from "node:test";

import { brokerGrantPath, brokerSocketPath } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

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
