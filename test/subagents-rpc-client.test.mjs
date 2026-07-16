import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentsRpcClient } from "../scripts/lib/subagents-rpc-client.mjs";

function createEvents() {
  const listeners = new Map();
  const emitted = [];

  return {
    emitted,
    on(channel, listener) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
    emit(channel, value) {
      emitted.push({ channel, value });
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
    listenerCount(channel) {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

test("subscribes before emitting a versioned request and resolves success", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-1" });
  const replyChannel = "subagents:rpc:v1:reply:request-1";

  const request = client.ping();

  assert.equal(events.listenerCount(replyChannel), 1);
  assert.deepEqual(events.emitted, [{
    channel: "subagents:rpc:v1:request",
    value: {
      version: 1,
      requestId: "request-1",
      method: "ping",
      params: {},
      source: { extension: "pi-plan-capsule" },
    },
  }]);
  events.emit(replyChannel, { version: 1, requestId: "request-1", success: true, data: { ok: true } });

  assert.deepEqual(await request, { ok: true });
  assert.equal(events.listenerCount(replyChannel), 0);
  client.dispose();
});

test("rejects an error envelope and removes its reply listener", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-2" });
  const replyChannel = "subagents:rpc:v1:reply:request-2";
  const request = client.status({ id: "job-1" });

  events.emit(replyChannel, {
    version: 1,
    requestId: "request-2",
    success: false,
    error: { code: "unavailable", message: "unavailable" },
  });

  await assert.rejects(request, /unavailable/);
  assert.equal(events.listenerCount(replyChannel), 0);
  client.dispose();
});

test("uses the injected five-second timeout and removes its reply listener", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-3", timeoutMs: 5 });
  const replyChannel = "subagents:rpc:v1:reply:request-3";

  await assert.rejects(client.interrupt({ id: "job-1" }), /timed out/);
  assert.equal(events.listenerCount(replyChannel), 0);
  client.dispose();
});

test("settles only the first of repeated replies", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-4" });
  const replyChannel = "subagents:rpc:v1:reply:request-4";
  const request = client.stop({ id: "job-1" });

  events.emit(replyChannel, { version: 1, requestId: "request-4", success: true, data: { stopped: true } });
  events.emit(replyChannel, { version: 1, requestId: "request-4", success: false, error: { message: "late reply" } });

  assert.deepEqual(await request, { stopped: true });
  assert.equal(events.listenerCount(replyChannel), 0);
  client.dispose();
});

test("dispose rejects pending calls and removes all reply listeners", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-5" });
  const replyChannel = "subagents:rpc:v1:reply:request-5";
  const request = client.ping();

  client.dispose();

  await assert.rejects(request, /disposed/);
  assert.equal(events.listenerCount(replyChannel), 0);
});

test("spawn enforces asynchronous non-clarifying calls and rejects action", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-6" });
  const request = client.spawn({ agent: "executor", task: "run", cwd: "/repo", async: false, clarify: true });

  assert.deepEqual(events.emitted[0].value.params, {
    agent: "executor",
    task: "run",
    cwd: "/repo",
    async: true,
    clarify: false,
  });
  events.emit("subagents:rpc:v1:reply:request-6", { version: 1, requestId: "request-6", success: true, data: {} });
  await request;
  assert.throws(() => client.spawn({ action: "run" }), /action/);
  client.dispose();
});

test("exposes only the stable RPC v1 methods and keeps the crypto receiver", async () => {
  const events = createEvents();
  const emit = events.emit.bind(events);
  events.emit = (channel, value) => {
    emit(channel, value);
    if (channel === "subagents:rpc:v1:request") {
      emit(`subagents:rpc:v1:reply:${value.requestId}`, { version: 1, requestId: value.requestId, success: true, data: {} });
    }
  };
  const client = createSubagentsRpcClient(events);

  assert.deepEqual(Object.keys(client).sort(), ["dispose", "interrupt", "ping", "spawn", "status", "stop"]);
  await client.ping();
  assert.match(events.emitted[0].value.requestId, /^[0-9a-f-]{36}$/);
  client.dispose();
});
