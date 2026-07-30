import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes = [];

  write(frame, callback) {
    this.writes.push({ frame: JSON.parse(frame), callback });
    return true;
  }

  end() {}

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

async function createSubscriptionFixture({
  respondSubscribe = true,
  subscribeCallerRunId = "plan-runner-1",
  subscribeCallerToken = "a".repeat(64),
} = {}) {
  const callerToken = "a".repeat(64);
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream: { async ping() { return {}; } },
    randomToken: () => callerToken,
    writeGrant: async () => "/tmp/root-broker-subscribe-flush-grant.json",
  });
  await server.grantCaller({
    callerRunId: "plan-runner-1",
    planId: "plan-1",
    cwd: "/repo",
    originRoot: "/repo",
    stateRoot: "/state",
    role: "plan-runner",
  });
  const socket = new FakeSocket();

  if (respondSubscribe) {
    await server.respond(socket, JSON.stringify({
      schemaVersion: "pi-root-subagent-broker-request.v1",
      requestId: "subscribe-1",
      rootSessionId: "root-session-1",
      callerRunId: subscribeCallerRunId,
      callerToken: subscribeCallerToken,
      method: "subscribe",
      params: {},
    }));
  }

  return { server, socket };
}

test("respond flushes queued logical pushes to the active actual caller after its success ACK", async () => {
  const logicalCallerRunId = "plan-runner-1";
  const actualCallerRunId = "plan-runner-2";
  const actualCallerToken = "b".repeat(64);
  const { server, socket } = await createSubscriptionFixture({ respondSubscribe: false });
  const lifecycleData = {
    dispatchId: "dispatch-1",
    runId: "executor-1",
    asyncDir: "/async/executor-1",
    cwd: "/repo",
    sessionId: "root-session-1",
    state: "running",
  };
  const supervisorData = {
    requestId: "request-1",
    executorRunId: "executor-1",
    content: "Need approval",
    expectsReply: true,
  };
  const delivered = [];

  server.logicalCallers.set(logicalCallerRunId, { activeRunId: actualCallerRunId, generation: 1 });
  server.callerAliases.set(actualCallerRunId, logicalCallerRunId);
  server.principals.set(actualCallerRunId, { role: "plan-runner", callerToken: actualCallerToken });
  server.callerPushQueues.get(logicalCallerRunId).push(
    {
      push: {
        schemaVersion: "pi-root-subagent-broker-push.v1",
        rootSessionId: "root-session-1",
        callerRunId: logicalCallerRunId,
        type: "execution.started",
        data: lifecycleData,
      },
      onDelivered: () => delivered.push("lifecycle"),
    },
    {
      push: {
        schemaVersion: "pi-root-subagent-broker-push.v1",
        rootSessionId: "root-session-1",
        callerRunId: logicalCallerRunId,
        type: "supervisor.request",
        data: supervisorData,
      },
      onDelivered: () => delivered.push("supervisor"),
    },
  );

  await server.respond(socket, JSON.stringify({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "subscribe-1",
    rootSessionId: "root-session-1",
    callerRunId: actualCallerRunId,
    callerToken: actualCallerToken,
    method: "subscribe",
    params: {},
  }));

  assert.equal(socket.writes.length, 1);
  assert.equal(server.callerPushQueues.get(logicalCallerRunId).length, 2);
  assert.deepEqual(delivered, []);

  socket.writes[0].callback();

  assert.deepEqual(socket.writes.map(({ frame }) => frame), [
    {
      schemaVersion: "pi-root-subagent-broker-response.v1",
      requestId: "subscribe-1",
      rootSessionId: "root-session-1",
      callerRunId: actualCallerRunId,
      success: true,
      data: { subscribed: true },
    },
    {
      schemaVersion: "pi-root-subagent-broker-push.v1",
      rootSessionId: "root-session-1",
      callerRunId: actualCallerRunId,
      type: "execution.started",
      data: lifecycleData,
    },
    {
      schemaVersion: "pi-root-subagent-broker-push.v1",
      rootSessionId: "root-session-1",
      callerRunId: actualCallerRunId,
      type: "supervisor.request",
      data: supervisorData,
    },
  ]);
  assert.equal(server.callerPushQueues.get(logicalCallerRunId).length, 0);
  assert.deepEqual(delivered, ["lifecycle", "supervisor"]);
  assert.equal(server.subscriptions.get(actualCallerRunId)?.has(socket) ?? false, true);
  assert.equal(server.subscriptions.get(logicalCallerRunId)?.has(socket) ?? false, false);
});

test("respond activates a subscription only after its success ACK write callback", async () => {
  const { server, socket } = await createSubscriptionFixture();

  assert.deepEqual(socket.writes.map(({ frame }) => frame), [{
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "subscribe-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    success: true,
    data: { subscribed: true },
  }]);
  assert.equal(server.subscriptions.get("plan-runner-1")?.has(socket) ?? false, false);

  socket.writes[0].callback();

  assert.equal(server.subscriptions.get("plan-runner-1")?.has(socket) ?? false, true);
});

test("respond does not activate a subscription when its ACK write callback fails", async () => {
  const { server, socket } = await createSubscriptionFixture();

  socket.writes[0].callback(new Error("ack failed"));

  assert.equal(server.subscriptions.get("plan-runner-1")?.has(socket) ?? false, false);
  assert.equal(socket.destroyed, true);
});

test("respond does not activate a subscription when the root closes before its ACK write callback", async () => {
  const { server, socket } = await createSubscriptionFixture();

  server.closed = true;
  socket.writes[0].callback();

  assert.equal(server.subscriptions.get("plan-runner-1")?.has(socket) ?? false, false);
});
