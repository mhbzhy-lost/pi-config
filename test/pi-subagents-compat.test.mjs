import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentsRpcClient, evaluateCompatibility, REQUIRED_METHODS } from "../scripts/probes/pi-subagents-compat.mjs";

const compatibleReport = {
  piVersion: "0.80.6",
  rpcMethods: ["ping", "status", "spawn", "interrupt", "stop"],
  planExtensionLoaded: true,
  planChildNestedSpawn: true,
  nestedResultHasDetails: true,
  workerCanSpawn: false,
  stopReachedTerminalState: true,
};

test("exports the stable RPC v1 method contract", () => {
  assert.deepEqual(REQUIRED_METHODS, ["ping", "status", "spawn", "interrupt", "stop"]);
});

test("accepts the required Pi subagent compatibility report", () => {
  assert.deepEqual(evaluateCompatibility(compatibleReport), { ok: true, failures: [] });
});

test("rejects an unsupported Pi version", () => {
  assert.deepEqual(evaluateCompatibility({ ...compatibleReport, piVersion: "0.80.5" }), {
    ok: false,
    failures: ["unexpected Pi version: 0.80.5"],
  });
});

test("reports each missing stable RPC method", () => {
  assert.deepEqual(evaluateCompatibility({ ...compatibleReport, rpcMethods: ["ping", "status", "spawn", "interrupt"] }), {
    ok: false,
    failures: ["missing RPC method: stop"],
  });
});

test("rejects a Plan child that does not load its extension", () => {
  assert.deepEqual(evaluateCompatibility({ ...compatibleReport, planExtensionLoaded: false }), {
    ok: false,
    failures: ["Plan child did not load plan-capsule extension"],
  });
});

test("rejects a Plan child that cannot make an authorized nested spawn", () => {
  assert.deepEqual(evaluateCompatibility({ ...compatibleReport, planChildNestedSpawn: false }), {
    ok: false,
    failures: ["Plan child cannot spawn an authorized nested worker"],
  });
});

test("rejects nested results without structured lifecycle details", () => {
  assert.deepEqual(evaluateCompatibility({ ...compatibleReport, nestedResultHasDetails: false }), {
    ok: false,
    failures: ["nested subagent result lacks structured lifecycle details"],
  });
});

test("rejects ordinary workers that can recursively spawn", () => {
  assert.deepEqual(evaluateCompatibility({ ...compatibleReport, workerCanSpawn: true }), {
    ok: false,
    failures: ["ordinary worker can recursively spawn subagents"],
  });
});

test("rejects stop operations that do not reach a terminal artifact state", () => {
  assert.deepEqual(evaluateCompatibility({ ...compatibleReport, stopReachedTerminalState: false }), {
    ok: false,
    failures: ["stop did not reach a terminal artifact state"],
  });
});

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

test("subagents RPC subscribes before emitting and resolves a successful reply", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-1" });
  const replyChannel = "subagents:rpc:v1:reply:request-1";

  const request = client.call("ping");

  assert.equal(events.listenerCount(replyChannel), 1);
  assert.deepEqual(events.emitted, [{
    channel: "subagents:rpc:v1:request",
    value: { version: 1, requestId: "request-1", method: "ping", params: {} },
  }]);
  events.emit(replyChannel, {
    version: 1,
    requestId: "request-1",
    success: true,
    data: { version: 1, methods: ["ping"], capabilities: {} },
  });

  assert.deepEqual(await request, { version: 1, methods: ["ping"], capabilities: {} });
  assert.equal(events.listenerCount(replyChannel), 0);
});

test("subagents RPC default UUID generator keeps the Crypto receiver", async () => {
  const events = createEvents();
  const emit = events.emit.bind(events);
  events.emit = (channel, value) => {
    emit(channel, value);
    if (channel !== "subagents:rpc:v1:request") return;
    emit(`subagents:rpc:v1:reply:${value.requestId}`, {
      version: 1,
      requestId: value.requestId,
      success: true,
      data: { version: 1 },
    });
  };

  const result = await createSubagentsRpcClient(events).call("ping");

  assert.deepEqual(result, { version: 1 });
  assert.match(events.emitted[0].value.requestId, /^[0-9a-f-]{36}$/);
});

test("subagents RPC rejects an error reply and unsubscribes", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-2" });
  const replyChannel = "subagents:rpc:v1:reply:request-2";
  const request = client.call("ping");

  events.emit(replyChannel, {
    version: 1,
    requestId: "request-2",
    success: false,
    error: { code: "unavailable", message: "unavailable" },
  });

  await assert.rejects(request, /unavailable/);
  assert.equal(events.listenerCount(replyChannel), 0);
});

test("subagents RPC rejects replies with a mismatched version or request id", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-4" });
  const replyChannel = "subagents:rpc:v1:reply:request-4";
  const request = client.call("ping");

  events.emit(replyChannel, { version: 2, requestId: "request-4", success: true, data: {} });

  await assert.rejects(request, /version/);
  assert.equal(events.listenerCount(replyChannel), 0);
});

test("subagents RPC times out and unsubscribes", async () => {
  const events = createEvents();
  const client = createSubagentsRpcClient(events, { randomUUID: () => "request-3", timeoutMs: 1 });
  const replyChannel = "subagents:rpc:v1:reply:request-3";

  await assert.rejects(client.call("ping"), /timed out/);
  assert.equal(events.listenerCount(replyChannel), 0);
});
