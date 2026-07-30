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

async function createSubscriptionFixture() {
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

  await server.respond(socket, JSON.stringify({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "subscribe-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    callerToken,
    method: "subscribe",
    params: {},
  }));

  return { server, socket };
}

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
