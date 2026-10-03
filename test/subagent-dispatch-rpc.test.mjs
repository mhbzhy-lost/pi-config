import assert from "node:assert/strict";
import test from "node:test";

import {
  TypedSubagentRpcError,
  createRenewableTypedSubagentRpcClient,
  createTypedSubagentRpcClient,
  negotiateCapabilities,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts";

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

test("correlates RPC diagnostic phases with the generated request id without changing the wire payload", async () => {
  const events = createEvents();
  const trace = [];
  const client = createTypedSubagentRpcClient(events, { randomUUID: () => "trace-request-1" });
  const request = client.ping({ diagnostic: { toolCallId: "tool-1", sink: (...args) => trace.push(args) } });
  events.emit("subagents:rpc:v1:reply:trace-request-1", {
    version: 1, requestId: "trace-request-1", success: true, data: { ok: true },
  });
  assert.deepEqual(await request, { ok: true });
  assert.deepEqual(trace, [
    ["rpc-ping-sent", { method: "ping", requestId: "trace-request-1" }],
    ["rpc-ping-replied", { method: "ping", requestId: "trace-request-1" }],
  ]);
  assert.deepEqual(events.emitted[0].value.params, {});
  client.dispose();
});

test("spawn forwards a normalized workflow payload without injecting direct-execution fields", async () => {
  const events = createEvents();
  const client = createTypedSubagentRpcClient(events, { randomUUID: () => "request-2" });
  const params = {
    workflowScript: "return await runs.run('typed-request-1', { agent: 'reviewer', task: 'Review exactly this diff.', async: true, worktree: false });",
    cwd: "/repo",
    context: "fresh",
    async: true,
    worktree: false,
    mission: false,
    chatProgress: "off",
  };
  const trace = [];
  const request = client.spawn(params, { diagnostic: { toolCallId: "tool-spawn-1", sink: (...args) => trace.push(args) } });

  assert.deepEqual(params, {
    workflowScript: "return await runs.run('typed-request-1', { agent: 'reviewer', task: 'Review exactly this diff.', async: true, worktree: false });",
    cwd: "/repo",
    context: "fresh",
    async: true,
    worktree: false,
    mission: false,
    chatProgress: "off",
  });
  const emitted = events.emitted[0].value.params;
  events.emit("subagents:rpc:v1:reply:request-2", {
    version: 1,
    requestId: "request-2",
    success: true,
    data: { details: { runId: "workflow-run-1", asyncDir: "/tmp/workflow-run-1" } },
  });
  await request;
  assert.deepEqual(emitted, params);
  assert.equal(Object.hasOwn(emitted, "clarify"), false);
  assert.equal(Object.hasOwn(emitted, "diagnostic"), false);
  assert.equal(Object.hasOwn(emitted, "spawnKey"), false);
  assert.equal(Object.hasOwn(emitted, "toolCallId"), false);
  assert.equal(Object.hasOwn(emitted, "sink"), false);
  assert.deepEqual(trace, [
    ["rpc-spawn-sent", { method: "spawn", requestId: "request-2" }],
    ["rpc-spawn-replied", { method: "spawn", requestId: "request-2" }],
  ]);
  assert.equal(Object.hasOwn(emitted, "agent"), false);
  assert.equal(Object.hasOwn(emitted, "task"), false);
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
    ["resume", { id: "resumable-child-1", message: "A durable child resume is pending." }],
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

test("renewable client forwards resume to the active generation", async () => {
  const events = createEvents();
  const client = createRenewableTypedSubagentRpcClient(() => createTypedSubagentRpcClient(events, {
    randomUUID: () => "renewable-resume-1",
  }));
  const params = { id: "resumable-child-1", message: "A durable child resume is pending." };
  const request = client.resume(params);

  assert.equal(events.emitted[0].value.method, "resume");
  assert.deepEqual(events.emitted[0].value.params, params);
  events.emit("subagents:rpc:v1:reply:renewable-resume-1", {
    version: 1,
    requestId: "renewable-resume-1",
    success: true,
    data: { ok: true },
  });
  assert.deepEqual(await request, { ok: true });
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

test("negotiates all capabilities and validates the negotiated spawn reply", async () => {
  const pingResponse = {
    version: 1,
    methods: [
      "ping", "spawn", "status", "steer", "nonRecoveringSteer", "interrupt", "stop", "resume", "cost",
    ],
    capabilities: {
      asyncSpawn: true,
      processTerminalProof: true,
      launchResolvedExtensions: true,
      runtimeAcknowledgedExtensions: true,
      statusProjection: true,
      fleetStatus: true,
    },
    events: { processTerminal: "terminal", asyncComplete: "complete", childStatus: "status" },
    session: { sessionId: "session-1", sessionFile: "/repo/session.jsonl", cwd: "/repo" },
    unknownField: { preserve: true },
  };
  const rpc = { async ping() { return pingResponse; } };
  const negotiated = await negotiateCapabilities(rpc, { cwd: "/repo" });
  assert.equal(negotiated.canSpawn, true);
  assert.deepEqual(negotiated.securityMissing, []);
  assert.equal(negotiated.enabled.status, true);
  assert.equal(negotiated.enabled.cost, true);
  // 真实 0.71 契约形态（rpc.js:307-336）：安全 capability 为对象而非布尔
  const objectShaped = await negotiateCapabilities({
    async ping() {
      return {
        ...pingResponse,
        capabilities: {
          asyncSpawn: true,
          processTerminalProof: { version: 1, lifecycleArtifactVersion: 3 },
          launchResolvedExtensions: { version: 1, source: "launch-resolved" },
          runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime" },
          statusProjection: { version: 1, untargeted: "in-memory-when-ready", targeted: "executor" },
          fleetStatus: { version: 1 },
        },
      };
    },
  }, { cwd: "/repo" });
  assert.equal(objectShaped.canSpawn, true, "对象型安全 capability（真实 0.71 形态）应视为具备");
  assert.deepEqual(objectShaped.securityMissing, []);
  assert.deepEqual(negotiated.raw.unknownField, { preserve: true });
  assert.deepEqual(negotiated.validateSpawnReply({ details: { runId: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo" } }), {
    runId: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo",
  });
});

test("recognizes object-shaped 0.71 capabilities as negotiated capabilities", async () => {
  const negotiated = await negotiateCapabilities({
    async ping() {
      return {
        version: 1,
        methods: ["ping", "spawn", "status"],
        capabilities: {
          asyncSpawn: true,
          processTerminalProof: true,
          launchResolvedExtensions: true,
          runtimeAcknowledgedExtensions: true,
          statusProjection: { version: 1, untargeted: "in-memory-when-ready", targeted: "executor" },
          fleetStatus: { version: 1 },
          asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
        },
        session: { sessionId: "session-1", sessionFile: "/repo/session.jsonl", cwd: "/repo" },
      };
    },
  }, { cwd: "/repo" });
  assert.equal(negotiated.canSpawn, true);
  assert.equal(negotiated.enabled.status, true);
  assert.equal(negotiated.enabled.fleetStatus, true);
});

test("fails closed when a security capability is absent and reports upgrade stop", async () => {
  const negotiated = await negotiateCapabilities({
    async ping() {
      return {
        version: 1,
        methods: ["ping", "spawn"],
        capabilities: { asyncSpawn: true },
        session: { sessionId: "session-1", sessionFile: "/repo/session.jsonl", cwd: "/repo" },
      };
    },
  }, { cwd: "/repo" });
  assert.equal(negotiated.canSpawn, false);
  assert.equal(negotiated.upgradeStopped, true);
  assert.ok(negotiated.securityMissing.includes("processTerminalProof"));
  assert.throws(() => negotiated.assertSpawnAllowed(), (error) => {
    assert.equal(error.code, "CAPABILITY_NEGOTIATION_FAILED");
    assert.deepEqual(error.missingCapabilities, negotiated.securityMissing);
    assert.equal(error.upgradeStopped, true);
    return true;
  });
});

test("downgrades missing display capabilities without treating unavailable as terminal", async () => {
  const negotiated = await negotiateCapabilities({
    async ping() {
      return {
        version: 1,
        methods: ["ping", "spawn"],
        capabilities: {
          asyncSpawn: true, processTerminalProof: true, launchResolvedExtensions: true,
          runtimeAcknowledgedExtensions: true,
        },
        session: { sessionId: "session-1", sessionFile: "/repo/session.jsonl", cwd: "/repo" },
      };
    },
  }, { cwd: "/repo" });
  assert.equal(negotiated.canSpawn, true);
  assert.equal(negotiated.enabled.status, false);
  assert.equal(negotiated.enabled.cost, false);
  assert.equal(negotiated.displayUnavailable.includes("status"), true);
  assert.equal(negotiated.displayUnavailable.includes("cost"), true);
  assert.equal(negotiated.diagnostics[0].code, "DISPLAY_CAPABILITY_UNAVAILABLE");
  assert.equal(negotiated.isTerminalStatus("unavailable"), false);
});

test("passes through unknown methods and fields without throwing", async () => {
  const raw = {
    version: 1, methods: ["ping", "spawn", "futureMethod"],
    capabilities: { asyncSpawn: true, processTerminalProof: true, launchResolvedExtensions: true, runtimeAcknowledgedExtensions: true, futureCapability: { mode: "x" } },
    session: { sessionId: "session-1", sessionFile: "/repo/session.jsonl", cwd: "/repo", futureSessionField: 42 },
    futureField: ["opaque"],
  };
  const negotiated = await negotiateCapabilities({ async ping() { return raw; } }, { cwd: "/repo" });
  assert.equal(negotiated.canSpawn, true);
  assert.deepEqual(negotiated.raw, raw);
});

test("validates spawn reply fields only when their capabilities are negotiated", async () => {
  const base = {
    version: 1, methods: ["ping", "spawn"],
    capabilities: { asyncSpawn: true, processTerminalProof: true, launchResolvedExtensions: true, runtimeAcknowledgedExtensions: true },
    session: { sessionId: "session-1", sessionFile: "/repo/session.jsonl", cwd: "/repo" },
  };
  const strict = await negotiateCapabilities({ async ping() { return { ...base, capabilities: { ...base.capabilities, spawnReplyIdentity: true, spawnReplyCwd: true } }; } }, { cwd: "/repo" });
  assert.throws(() => strict.validateSpawnReply({ details: { runId: "run-1", asyncDir: "/tmp/run-1", cwd: "/wrong" } }), /cwd/);
  assert.throws(() => strict.validateSpawnReply({ details: { runId: "run-1", cwd: "/repo" } }), /asyncDir/);

  const permissive = await negotiateCapabilities({ async ping() { return base; } }, { cwd: "/repo" });
  assert.deepEqual(permissive.validateSpawnReply({ details: { arbitrary: "reply" } }), { arbitrary: "reply" });
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
