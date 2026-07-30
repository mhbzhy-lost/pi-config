import assert from "node:assert/strict";
import test from "node:test";

import { createPiSubagentsExecutionBackend } from "../scripts/lib/plan/pi-subagents-execution-backend.mjs";

function createEvents() {
  const listeners = new Map();
  return {
    on(channel, listener) {
      const values = listeners.get(channel) ?? new Set();
      values.add(listener);
      listeners.set(channel, values);
      return () => values.delete(listener);
    },
    emit(channel, value) {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
    count(channel) {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

function capabilities(overrides = {}) {
  return {
    version: 1,
    methods: ["ping", "spawn", "status", "interrupt", "stop"],
    session: { sessionId: "plan-session-uuid", sessionFile: "/sessions/plan-session-1.jsonl", cwd: "/plan" },
    ...overrides,
  };
}

function spawnInput(overrides = {}) {
  return {
    dispatchId: "attempt-1.dispatch.1",
    attemptId: "attempt-1",
    agent: "executor",
    task: "Execute approved task",
    cwd: "/attempts/attempt-1",
    output: "/results/attempt-1.json",
    timeoutMs: 900_000,
    ...overrides,
  };
}

test("asserts capabilities and emits the exact asynchronous executor RPC envelope", async () => {
  const events = createEvents();
  const calls = [];
  const facts = [];
  const rpc = {
    async ping() { return capabilities(); },
    async spawn(params, options) {
      calls.push({ params, options });
      events.emit("subagent:async-started", {
        id: "run-1",
        asyncDir: "/async/run-1",
        cwd: params.cwd,
        sessionId: "/sessions/plan-session-1.jsonl",
      });
      return { details: { runId: "run-1", asyncDir: "/async/run-1" }, text: "formatted output" };
    },
    dispose() {},
  };
  const backend = createPiSubagentsExecutionBackend({ rpc, events, emitFact: (fact) => facts.push(fact), now: () => "2026-07-26T00:00:00.000Z" });

  const negotiated = await backend.assertCapabilities({
    rpcVersion: 1,
    methods: ["ping", "spawn", "status", "interrupt", "stop"],
  });
  assert.equal(negotiated.sessionId, "/sessions/plan-session-1.jsonl");
  assert.equal(negotiated.rpcSessionId, "plan-session-uuid");
  const binding = await backend.spawn(spawnInput());

  assert.deepEqual(calls, [{
    params: {
      agent: "executor",
      task: "Execute approved task",
      cwd: "/attempts/attempt-1",
      context: "fresh",
      worktree: false,
      async: true,
      clarify: false,
      output: "/results/attempt-1.json",
      outputMode: "file-only",
      acceptance: false,
      artifacts: true,
      timeoutMs: 900_000,
    },
    options: { requestId: "attempt-1.dispatch.1", spawnKey: "attempt-1.dispatch.1" },
  }]);
  assert.deepEqual(binding, {
    dispatchId: "attempt-1.dispatch.1",
    attemptId: "attempt-1",
    runId: "run-1",
    asyncDir: "/async/run-1",
    cwd: "/attempts/attempt-1",
    output: "/results/attempt-1.json",
    sessionId: "/sessions/plan-session-1.jsonl",
    sessionFile: "/sessions/plan-session-1.jsonl",
  });
  assert.deepEqual(facts, [{
    type: "execution.started",
    dispatchId: "attempt-1.dispatch.1",
    attemptId: "attempt-1",
    runId: "run-1",
    asyncDir: "/async/run-1",
    cwd: "/attempts/attempt-1",
    state: "running",
    observedAt: "2026-07-26T00:00:00.000Z",
  }]);
  backend.dispose();
});

test("normalizes matching completion facts and rejects zero-match or wrong-session lifecycle events", async () => {
  const events = createEvents();
  const facts = [];
  const rpc = {
    async ping() { return capabilities(); },
    async spawn(params) {
      events.emit("subagent:async-started", { id: "run-1", asyncDir: "/async/run-1", cwd: params.cwd, sessionId: "/sessions/plan-session-1.jsonl" });
      return { details: { runId: "run-1", asyncDir: "/async/run-1" } };
    },
    dispose() {},
  };
  const backend = createPiSubagentsExecutionBackend({ rpc, events, emitFact: (fact) => facts.push(fact), now: () => "observed" });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await backend.spawn(spawnInput());

  events.emit("subagent:async-complete", {
    runId: "run-1",
    asyncDir: "/async/run-1",
    cwd: "/attempts/attempt-1",
    sessionId: "/sessions/plan-session-1.jsonl",
    state: "complete",
  });
  events.emit("subagent:async-started", {
    id: "unknown",
    asyncDir: "/async/unknown",
    cwd: "/attempts/unknown",
    sessionId: "/sessions/plan-session-1.jsonl",
  });
  events.emit("subagent:async-started", {
    id: "wrong-session",
    asyncDir: "/async/wrong-session",
    cwd: "/attempts/unknown",
    sessionId: "another-session",
  });

  assert.equal(facts[1].type, "execution.completed");
  assert.deepEqual(facts[1], {
    type: "execution.completed",
    dispatchId: "attempt-1.dispatch.1",
    attemptId: "attempt-1",
    runId: "run-1",
    asyncDir: "/async/run-1",
    cwd: "/attempts/attempt-1",
    state: "complete",
    observedAt: "observed",
  });
  assert.equal(facts[2].type, "execution.protocol-violation");
  assert.equal(facts[2].code, "LIFECYCLE_BINDING_NOT_FOUND");
  assert.equal(facts[3].code, "LIFECYCLE_SESSION_MISMATCH");
  backend.dispose();
});

test("does not guess when more than one pending dispatch has the same cwd", async () => {
  const events = createEvents();
  const facts = [];
  const resolvers = [];
  const rpc = {
    async ping() { return capabilities(); },
    spawn() { return new Promise((resolve) => resolvers.push(resolve)); },
    dispose() {},
  };
  const backend = createPiSubagentsExecutionBackend({ rpc, events, emitFact: (fact) => facts.push(fact) });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  const first = backend.spawn(spawnInput());
  const second = backend.spawn(spawnInput({ dispatchId: "attempt-2.dispatch.1", attemptId: "attempt-2" }));
  events.emit("subagent:async-started", {
    id: "ambiguous-run",
    asyncDir: "/async/ambiguous",
    cwd: "/attempts/attempt-1",
    sessionId: "/sessions/plan-session-1.jsonl",
  });
  assert.equal(facts[0].code, "LIFECYCLE_BINDING_AMBIGUOUS");
  resolvers[0]({ details: { runId: "run-1", asyncDir: "/async/run-1" } });
  resolvers[1]({ details: { runId: "run-2", asyncDir: "/async/run-2" } });
  await Promise.all([first, second]);
  backend.dispose();
});

test("uses status RPC only to reconcile, then reads and validates authoritative artifacts", async () => {
  const events = createEvents();
  const calls = [];
  const artifactCalls = [];
  const rpc = {
    async ping() { return capabilities(); },
    async spawn(params) {
      events.emit("subagent:async-started", { id: "run-1", asyncDir: "/async/run-1", cwd: params.cwd, sessionId: "/sessions/plan-session-1.jsonl" });
      return { details: { runId: "run-1", asyncDir: "/async/run-1" } };
    },
    async status(params) { calls.push(["status", params]); return { text: "formatted, non-authoritative" }; },
    async interrupt(params) { calls.push(["interrupt", params]); return { ok: true }; },
    async stop(params) { calls.push(["stop", params]); return { ok: true }; },
    dispose() { calls.push(["dispose"]); },
  };
  const readArtifacts = async (input) => {
    artifactCalls.push(input);
    return { status: { kind: "stable", value: { state: "running" } } };
  };
  const backend = createPiSubagentsExecutionBackend({ rpc, events, readArtifacts });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await backend.spawn(spawnInput());

  assert.deepEqual(await backend.status({ runId: "run-1", asyncDir: "/async/run-1" }), {
    status: { kind: "stable", value: { state: "running" } },
  });
  await backend.interrupt({ runId: "run-1", asyncDir: "/async/run-1" });
  await backend.stop({ runId: "run-1", asyncDir: "/async/run-1" });
  assert.deepEqual(calls.slice(0, 3), [
    ["status", { runId: "run-1", dir: "/async/run-1" }],
    ["interrupt", { runId: "run-1", dir: "/async/run-1" }],
    ["stop", { runId: "run-1", dir: "/async/run-1" }],
  ]);
  assert.deepEqual(artifactCalls, [{
    artifactDir: "/async/run-1",
    binding: {
      runId: "run-1",
      sessionId: "/sessions/plan-session-1.jsonl",
      cwd: "/attempts/attempt-1",
      output: "/results/attempt-1.json",
    },
  }]);
  backend.dispose();
  assert.deepEqual(calls.at(-1), ["dispose"]);
});

test("fails closed on capability drift and removes lifecycle listeners on dispose", async () => {
  const events = createEvents();
  let disposed = false;
  const backend = createPiSubagentsExecutionBackend({
    rpc: {
      async ping() { return capabilities({ version: 2, methods: ["ping"] }); },
      dispose() { disposed = true; },
    },
    events,
  });
  await assert.rejects(
    backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] }),
    (error) => error.code === "EXECUTION_CAPABILITY_MISMATCH",
  );
  assert.equal(events.count("subagent:async-started"), 1);
  assert.equal(events.count("subagent:async-complete"), 1);
  backend.dispose();
  assert.equal(events.count("subagent:async-started"), 0);
  assert.equal(events.count("subagent:async-complete"), 0);
  assert.equal(disposed, true);
});

function supersedeHarness({ spawn, artifacts = async () => ({ status: { kind: "stable", value: { state: "stopped" } } }) } = {}) {
  const events = createEvents();
  const stops = [];
  const rpc = {
    async ping() { return capabilities(); },
    spawn: spawn ?? (async () => ({ details: { runId: "run-1", asyncDir: "/async/run-1" } })),
    async stop(input) { stops.push(input); return { ok: true }; },
    dispose() {},
  };
  const backend = createPiSubagentsExecutionBackend({
    rpc, events, readArtifacts: artifacts, supersedeTimeoutMs: 40, supersedePollIntervalMs: 1,
  });
  return { backend, events, stops };
}

test("supersede fences a reply-first run and returns only an authoritative terminal artifact proof", async () => {
  const reads = [];
  const subject = supersedeHarness({
    artifacts: async (input) => {
      reads.push(input);
      return { status: { kind: "stable", value: { state: reads.length === 1 ? "stopping" : "stopped", runId: "run-1" } } };
    },
  });
  await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await subject.backend.spawn(spawnInput());

  const [first, second] = await Promise.all([
    subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }),
    subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }),
  ]);

  assert.deepEqual(subject.stops, [{ runId: "run-1", dir: "/async/run-1" }]);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), ["artifactSha256", "asyncDir", "dispatchId", "kind", "runId"]);
  assert.equal(first.kind, "terminal");
  assert.equal(first.runId, "run-1");
  assert.match(first.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(reads.length >= 2, true);
  subject.backend.dispose();
});

test("supersede fences an event-first or reply-lost late binding exactly once", async () => {
  let resolveSpawn;
  const subject = supersedeHarness({ spawn: () => new Promise((resolve) => { resolveSpawn = resolve; }) });
  await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  const spawning = subject.backend.spawn(spawnInput());
  const superseding = subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" });
  subject.events.emit("subagent:async-started", {
    id: "run-1", asyncDir: "/async/run-1", cwd: "/attempts/attempt-1", sessionId: "/sessions/plan-session-1.jsonl",
  });
  resolveSpawn({ details: { runId: "run-1", asyncDir: "/async/run-1" } });

  await spawning;
  assert.equal((await superseding).kind, "terminal");
  assert.deepEqual(subject.stops, [{ runId: "run-1", dir: "/async/run-1" }]);
  subject.backend.dispose();
});

test("supersede keeps its late-start fence after an unbound timeout", async () => {
  const subject = supersedeHarness({ spawn: () => new Promise(() => {}) });
  await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  void subject.backend.spawn(spawnInput()).catch(() => {});
  await assert.rejects(
    subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }),
    (error) => error.code === "EXECUTION_DISPATCH_UNCERTAIN",
  );
  subject.events.emit("subagent:async-started", {
    id: "late-run", asyncDir: "/async/late", cwd: "/attempts/attempt-1", sessionId: "/sessions/plan-session-1.jsonl",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(subject.stops, [{ runId: "late-run", dir: "/async/late" }]);
  subject.backend.dispose();
});

test("supersede rejects an attempt mismatch", async () => {
  const subject = supersedeHarness();
  await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await subject.backend.spawn(spawnInput());
  await assert.rejects(
    subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "another-attempt" }),
    (error) => error.code === "EXECUTION_DISPATCH_MISMATCH",
  );
  subject.backend.dispose();
});

test("supersede supports recovered completed bindings and fails closed on reply conflict", async () => {
  const events = createEvents();
  const stops = [];
  const backend = createPiSubagentsExecutionBackend({
    events,
    rpc: { async ping() { return capabilities(); }, async stop(input) { stops.push(input); }, dispose() {} },
    readArtifacts: async () => ({ status: { kind: "stable", value: { state: "complete" } } }),
    bindings: [{
      dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1", runId: "run-1", asyncDir: "/async/run-1",
      cwd: "/attempts/attempt-1", output: "/results/attempt-1.json", sessionId: "/sessions/plan-session-1.jsonl", sessionFile: "/sessions/plan-session-1.jsonl",
    }],
  });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  assert.equal((await backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" })).kind, "terminal");
  assert.deepEqual(stops, []);
  backend.dispose();
});

test("recoverBinding validates the negotiated session and fails closed on identity conflicts", async () => {
  const events = createEvents();
  const backend = createPiSubagentsExecutionBackend({
    events,
    rpc: { async ping() { return capabilities(); }, async stop() {}, dispose() {} },
    readArtifacts: async () => ({ status: { kind: "stable", value: { state: "stopped" } } }),
  });
  const binding = {
    dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1", runId: "run-1", asyncDir: "/async/run-1",
    cwd: "/attempts/attempt-1", output: "/results/attempt-1.json", sessionId: "/sessions/plan-session-1.jsonl", sessionFile: "/sessions/plan-session-1.jsonl",
  };
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  assert.deepEqual(await backend.recoverBinding(binding), binding);
  assert.deepEqual(await backend.recoverBinding(binding), binding);
  await assert.rejects(
    backend.recoverBinding({ ...binding, runId: "run-2" }),
    (error) => error.code === "EXECUTION_BINDING_CONFLICT",
  );
  await assert.rejects(
    backend.recoverBinding({ ...binding, dispatchId: "attempt-2.dispatch.1", runId: "run-1" }),
    (error) => error.code === "EXECUTION_BINDING_CONFLICT",
  );
  await assert.rejects(
    backend.recoverBinding({ ...binding, sessionId: "other-session" }),
    (error) => error.code === "EXECUTION_CAPABILITY_MISMATCH",
  );
  backend.dispose();
});

test("supersede retries an unbound timeout after a late lifecycle start", async () => {
  const subject = supersedeHarness({ spawn: () => new Promise(() => {}) });
  await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  void subject.backend.spawn(spawnInput()).catch(() => {});
  await assert.rejects(subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }), (error) => error.code === "EXECUTION_DISPATCH_UNCERTAIN");
  subject.events.emit("subagent:async-started", { id: "late-run", asyncDir: "/async/late", cwd: "/attempts/attempt-1", sessionId: "/sessions/plan-session-1.jsonl" });
  assert.equal((await subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" })).kind, "terminal");
  assert.deepEqual(subject.stops, [{ runId: "late-run", dir: "/async/late" }]);
  subject.backend.dispose();
});

test("supersede retries failed stops while sharing an in-flight stop and caches terminal proof", async () => {
  const events = createEvents();
  let stops = 0;
  let artifactReads = 0;
  const backend = createPiSubagentsExecutionBackend({ events, supersedePollIntervalMs: 1, rpc: { async ping() { return capabilities(); }, async spawn() { return { details: { runId: "run-1", asyncDir: "/async/run-1" } }; }, async stop() { stops += 1; if (stops === 1) throw new Error("transient"); }, dispose() {} }, readArtifacts: async () => ({ status: { kind: "stable", value: { state: artifactReads++ < 2 ? "running" : "stopped" } } }) });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await backend.spawn(spawnInput());
  await assert.rejects(backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }));
  const [one, two] = await Promise.all([backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }), backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" })]);
  assert.deepEqual(one, two);
  await backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" });
  assert.equal(stops, 2);
  backend.dispose();
});

test("recoverDispatch is exact, idempotent, never spawns, and fences a late lifecycle", async () => {
  const events = createEvents();
  let spawns = 0;
  const backend = createPiSubagentsExecutionBackend({ events, supersedeTimeoutMs: 15, supersedePollIntervalMs: 1, rpc: { async ping() { return capabilities(); }, async spawn() { spawns += 1; }, async stop() {}, dispose() {} }, readArtifacts: async () => ({ status: { kind: "stable", value: { state: "stopped" } } }) });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  const request = spawnInput();
  assert.deepEqual(await backend.recoverDispatch(request), request);
  assert.deepEqual(await backend.recoverDispatch(request), request);
  assert.equal(spawns, 0);
  await assert.rejects(backend.recoverDispatch({ ...request, extra: true }), (error) => error.code === "INVALID_EXECUTION_REQUEST");
  await assert.rejects(backend.recoverDispatch({ ...request, timeoutMs: 2 }), (error) => error.code === "EXECUTION_DISPATCH_CONFLICT");
  await assert.rejects(backend.supersede({ dispatchId: request.dispatchId, attemptId: request.attemptId, extra: true }), (error) => error.code === "INVALID_EXECUTION_REQUEST");
  await assert.rejects(backend.supersede({ dispatchId: request.dispatchId }), (error) => error.code === "INVALID_EXECUTION_REQUEST");
  await assert.rejects(backend.supersede({ dispatchId: request.dispatchId, attemptId: request.attemptId }), (error) => error.code === "EXECUTION_DISPATCH_UNCERTAIN");
  events.emit("subagent:async-started", { id: "late-run", asyncDir: "/async/late", cwd: request.cwd, sessionId: "/sessions/plan-session-1.jsonl" });
  assert.equal((await backend.supersede({ dispatchId: request.dispatchId, attemptId: request.attemptId })).kind, "terminal");
  backend.dispose();
});

test("dispatchId selects its exact recovered dispatch when cwd candidates differ", async () => {
  const events = createEvents(); const facts = [];
  const backend = createPiSubagentsExecutionBackend({ events, emitFact: (fact) => facts.push(fact), now: () => "observed", rpc: { async ping() { return capabilities(); }, dispose() {} } });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await backend.recoverDispatch(spawnInput({ dispatchId: "D1" }));
  await backend.recoverDispatch(spawnInput({ dispatchId: "D2", attemptId: "attempt-2" }));
  events.emit("subagent:async-started", { dispatchId: "D2", id: "run-d2", asyncDir: "/async/d2", cwd: "/attempts/attempt-1", sessionId: "/sessions/plan-session-1.jsonl" });
  assert.deepEqual(facts, [{ type: "execution.started", dispatchId: "D2", attemptId: "attempt-2", runId: "run-d2", asyncDir: "/async/d2", cwd: "/attempts/attempt-1", state: "running", observedAt: "observed" }]);
  backend.dispose();
});

test("stale lifecycle dispatchId never falls back to the only cwd candidate", async () => {
  const events = createEvents(); const facts = [];
  const backend = createPiSubagentsExecutionBackend({ events, emitFact: (fact) => facts.push(fact), rpc: { async ping() { return capabilities(); }, dispose() {} } });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await backend.recoverDispatch(spawnInput({ dispatchId: "D1" }));
  events.emit("subagent:async-started", { dispatchId: "D2", id: "stale", asyncDir: "/async/stale", cwd: "/attempts/attempt-1", sessionId: "/sessions/plan-session-1.jsonl" });
  assert.equal(facts[0].type, "execution.protocol-violation");
  assert.match(facts[0].code, /BINDING_(NOT_FOUND|MISMATCH)/);
  backend.dispose();
});

test("rejects mixed constructor sessions", () => {
  const binding = { dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1", runId: "run-1", asyncDir: "/async/run-1", cwd: "/attempts/attempt-1", output: "/results/attempt-1.json", sessionId: "/sessions/plan-session-1.jsonl", sessionFile: "/sessions/plan-session-1.jsonl" };
  assert.throws(() => createPiSubagentsExecutionBackend({ events: createEvents(), rpc: { ping() {} }, bindings: [binding, { ...binding, dispatchId: "attempt-2.dispatch.1", runId: "run-2", sessionId: "other", sessionFile: "other" }] }), (error) => error.code === "EXECUTION_CAPABILITY_MISMATCH");
});

test("recovered bindings do not bypass capability negotiation", async () => {
  const binding = { dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1", runId: "run-1", asyncDir: "/async/run-1", cwd: "/attempts/attempt-1", output: "/results/attempt-1.json", sessionId: "/sessions/plan-session-1.jsonl", sessionFile: "/sessions/plan-session-1.jsonl" };
  const backend = createPiSubagentsExecutionBackend({ events: createEvents(), rpc: { async ping() { return capabilities(); }, async stop() {}, async spawn() {}, dispose() {} }, bindings: [binding] });
  for (const call of [() => backend.spawn(spawnInput({ dispatchId: "attempt-2.dispatch.1" })), () => backend.status({ runId: "run-1", asyncDir: "/async/run-1" }), () => backend.stop({ runId: "run-1", asyncDir: "/async/run-1" }), () => backend.supersede({ dispatchId: binding.dispatchId, attemptId: binding.attemptId }), () => backend.recoverBinding(binding), () => backend.recoverDispatch(spawnInput({ dispatchId: "attempt-2.dispatch.1" }))]) {
    await assert.rejects(call(), (error) => error.code === "EXECUTION_CAPABILITIES_UNVERIFIED");
  }
  backend.dispose();
});

test("consumes deferred and background stop rejections without hiding awaited errors", async () => {
  const events = createEvents();
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    const subject = supersedeHarness({ spawn: () => new Promise(() => {}) });
    await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
    void subject.backend.spawn(spawnInput()).catch(() => {});
    const waiting = subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" });
    subject.backend.dispose();
    await assert.rejects(waiting, (error) => error.code === "EXECUTION_BACKEND_DISPOSED");
    const rejecting = supersedeHarness({ spawn: () => new Promise(() => {}) });
    rejecting.backend = createPiSubagentsExecutionBackend({ events: rejecting.events, rpc: { async ping() { return capabilities(); }, async spawn() { return new Promise(() => {}); }, async stop() { throw new Error("late failure"); }, dispose() {} }, supersedeTimeoutMs: 20, supersedePollIntervalMs: 1 });
    await rejecting.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
    void rejecting.backend.spawn(spawnInput()).catch(() => {});
    await assert.rejects(rejecting.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }), (error) => error.code === "EXECUTION_DISPATCH_UNCERTAIN");
    rejecting.events.emit("subagent:async-started", { id: "late-run", asyncDir: "/async/late", cwd: "/attempts/attempt-1", sessionId: "/sessions/plan-session-1.jsonl" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    rejecting.backend.dispose();
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("supersede proves terminal artifacts before stopping and fails closed on initial identity mismatch", async () => {
  for (const state of ["complete", "failed", "paused", "stopped"]) {
    const subject = supersedeHarness({ artifacts: async () => ({ status: { kind: "stable", value: { state } } }) });
    await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
    await subject.backend.spawn(spawnInput());
    assert.equal((await subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" })).kind, "terminal");
    assert.deepEqual(subject.stops, []);
    subject.backend.dispose();
  }
  let reads = 0;
  const subject = supersedeHarness({ artifacts: async () => ({ status: { kind: "stable", value: { state: reads++ === 0 ? "running" : "stopped" } } }) });
  await subject.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await subject.backend.spawn(spawnInput());
  await subject.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" });
  assert.equal(subject.stops.length, 1);
  subject.backend.dispose();
  const mismatch = supersedeHarness({ artifacts: async () => { const error = new Error("mismatch"); error.code = "RUNTIME_ARTIFACT_BINDING_MISMATCH"; throw error; } });
  await mismatch.backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  await mismatch.backend.spawn(spawnInput());
  await assert.rejects(mismatch.backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }), (error) => error.code === "RUNTIME_ARTIFACT_BINDING_MISMATCH");
  assert.deepEqual(mismatch.stops, []);
  mismatch.backend.dispose();
});
