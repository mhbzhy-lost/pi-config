import assert from "node:assert/strict";
import test from "node:test";

import {
  TypedSubagentRpcError,
  createRenewableTypedSubagentRpcClient,
  createTypedSubagentRpcClient,
} from "../scripts/lib/subagent-dispatch/rpc-client.ts";

function createEvents() {
  const listeners = new Map();
  const emitted = [];
  return {
    emitted,
    on(channel, listener) {
      const current = listeners.get(channel) ?? new Set();
      current.add(listener);
      listeners.set(channel, current);
      return () => current.delete(listener);
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

test("subscribes before emitting a request with the isolated runtime source", async () => {
  const events = createEvents();
  const client = createTypedSubagentRpcClient(events, { randomUUID: () => "request-1" });
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
      source: { extension: "typed-subagent-runtime" },
    },
  }]);
  events.emit(replyChannel, {
    version: 1,
    requestId: "request-1",
    success: true,
    data: { version: 1, methods: ["spawn"] },
  });

  assert.deepEqual(await request, { version: 1, methods: ["spawn"] });
  assert.equal(events.listenerCount(replyChannel), 0);
  client.dispose();
});

test("spawn forces detached non-clarifying execution without mutating its input", async () => {
  const events = createEvents();
  const client = createTypedSubagentRpcClient(events, { randomUUID: () => "request-2" });
  const params = { agent: "reviewer", task: "Review exactly this diff.", async: false, clarify: true };
  const request = client.spawn(params);

  assert.deepEqual(params, { agent: "reviewer", task: "Review exactly this diff.", async: false, clarify: true });
  assert.deepEqual(events.emitted[0].value.params, {
    agent: "reviewer",
    task: "Review exactly this diff.",
    async: true,
    clarify: false,
  });
  events.emit("subagents:rpc:v1:reply:request-2", {
    version: 1,
    requestId: "request-2",
    success: true,
    data: { details: { runId: "run-1", asyncDir: "/tmp/run-1" } },
  });
  await request;
  client.dispose();
});

test("exposes only the approved RPC v1 methods", () => {
  const client = createTypedSubagentRpcClient(createEvents());
  assert.deepEqual(Object.keys(client).sort(), [
    "dispose",
    "interrupt",
    "ping",
    "resume",
    "spawn",
    "status",
    "steer",
    "stop",
  ]);
  client.dispose();
});

test("maps control calls to their same-named RPC methods", async () => {
  const events = createEvents();
  let next = 0;
  const client = createTypedSubagentRpcClient(events, { randomUUID: () => `control-${++next}` });

  for (const [method, params] of [
    ["status", { id: "run-1" }],
    ["resume", { id: "plan-runner-1", message: "A durable Root broker wake is pending." }],
    ["steer", { id: "run-1", message: "Use the approved decision." }],
    ["interrupt", { id: "run-1" }],
    ["stop", { id: "run-1" }],
  ]) {
    const request = client[method](params);
    const emitted = events.emitted.at(-1).value;
    assert.equal(emitted.method, method);
    assert.deepEqual(emitted.params, params);
    events.emit(`subagents:rpc:v1:reply:${emitted.requestId}`, {
      version: 1,
      requestId: emitted.requestId,
      success: true,
      data: { ok: true },
    });
    assert.deepEqual(await request, { ok: true });
  }
  client.dispose();
});

test("rejects RPC error replies with stable error details and removes listeners", async () => {
  const events = createEvents();
  const client = createTypedSubagentRpcClient(events, { randomUUID: () => "request-3" });
  const replyChannel = "subagents:rpc:v1:reply:request-3";
  const request = client.status({ id: "missing" });

  events.emit(replyChannel, {
    version: 1,
    requestId: "request-3",
    success: false,
    error: { code: "not_found", message: "run not found" },
  });

  await assert.rejects(request, (error) => {
    assert.equal(error instanceof TypedSubagentRpcError, true);
    assert.equal(error.code, "not_found");
    assert.match(error.message, /run not found/);
    return true;
  });
  assert.equal(events.listenerCount(replyChannel), 0);
  client.dispose();
});

test("times out, rejects duplicate caller ids, and removes reply listeners", async () => {
  const events = createEvents();
  const client = createTypedSubagentRpcClient(events, { timeoutMs: 2 });
  const first = client.ping({ requestId: "fixed-id" });

  assert.throws(() => client.status({}, { requestId: "fixed-id" }), (error) => {
    assert.equal(error.code, "duplicate_request_id");
    return true;
  });
  await assert.rejects(first, (error) => error.code === "timeout");
  assert.equal(events.listenerCount("subagents:rpc:v1:reply:fixed-id"), 0);
  client.dispose();
});

test("starts immediately and renews the underlying RPC client after a session shutdown", async () => {
  const events = createEvents();
  let generation = 1;
  const client = createRenewableTypedSubagentRpcClient(() => createTypedSubagentRpcClient(events, {
    randomUUID: () => `session-${generation}`,
  }));

  const first = client.ping();
  events.emit("subagents:rpc:v1:reply:session-1", {
    version: 1,
    requestId: "session-1",
    success: true,
    data: { session: 1 },
  });
  assert.deepEqual(await first, { session: 1 });

  client.dispose();

  generation = 2;
  const second = client.ping();
  events.emit("subagents:rpc:v1:reply:session-2", {
    version: 1,
    requestId: "session-2",
    success: true,
    data: { session: 2 },
  });
  assert.deepEqual(await second, { session: 2 });
  client.dispose();
});

test("recovers lazily when an eager renew factory call fails", async () => {
  const events = createEvents();
  let factoryCalls = 0;
  const client = createRenewableTypedSubagentRpcClient(() => {
    factoryCalls += 1;
    if (factoryCalls === 2) throw new Error("factory unavailable");
    return createTypedSubagentRpcClient(events, { randomUUID: () => "recovered-session" });
  });

  assert.throws(() => client.renew(), /factory unavailable/);
  const recovered = client.ping();
  events.emit("subagents:rpc:v1:reply:recovered-session", {
    version: 1,
    requestId: "recovered-session",
    success: true,
    data: { recovered: true },
  });
  assert.deepEqual(await recovered, { recovered: true });
  assert.equal(factoryCalls, 3);
  client.dispose();
});

test("dispose rejects pending calls and fences invalid request ids", async () => {
  const events = createEvents();
  const client = createTypedSubagentRpcClient(events);
  const pending = client.ping({ requestId: "pending-1" });

  for (const requestId of ["", "has space", "../escape", "line\nbreak", "x".repeat(161)]) {
    assert.throws(() => client.ping({ requestId }), (error) => error.code === "invalid_request_id");
  }
  client.dispose();

  await assert.rejects(pending, (error) => error.code === "disposed");
  assert.equal(events.listenerCount("subagents:rpc:v1:reply:pending-1"), 0);
  await assert.rejects(client.ping(), (error) => error.code === "disposed");
});
