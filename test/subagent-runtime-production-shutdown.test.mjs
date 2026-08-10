import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
assert.equal(npmRoot.status, 0, npmRoot.stderr);
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} = await import(join(npmRoot.stdout.trim(), "@earendil-works", "pi-coding-agent", "dist", "index.js"));
import { installHeadlessTypedSubagentRuntime } from "../scripts/lib/subagent-dispatch/extension.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

function piRunner() {
  const handlers = new Map();
  const listeners = [];
  return {
    handlers, listeners,
    events: {
      on(type, handler) { listeners.push({ type, handler }); return () => { const i = listeners.findIndex((x) => x.type === type && x.handler === handler); if (i >= 0) listeners.splice(i, 1); }; },
      emit(type, event) { for (const entry of [...listeners]) if (entry.type === type) entry.handler(event); },
    },
    on(type, handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
    registerTool() {}, registerMessageRenderer() {}, getAllTools() { return []; },
  };
}
const rpc = { dispose() {} };
async function emitRunner(pi, type, event = {}, ctx = {}) {
  // ExtensionRunner records an error and continues with later handlers.
  const errors = [];
  for (const handler of pi.handlers.get(type) ?? []) try { await handler(event, ctx); } catch (error) { errors.push(error); }
  return errors;
}

test("project startup installs Root Broker listeners before synchronous upstream recovery events", async () => {
  const pi = piRunner();
  const rootSessionId = `recovery-order-${process.pid}`;
  const runId = "recovered-executor";
  let broker;

  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore: {},
    rpc,
    bootstrap(api) {
      api.registerTool({ name: "subagent_supervisor", execute() {} });
      api.on("session_start", () => {
        pi.events.emit("subagent:async-started", {
          id: runId,
          pid: 4242,
          sessionId: rootSessionId,
          agent: "executor",
          cwd: "/repo",
          asyncDir: `/async/${runId}`,
        });
      });
    },
    async beforeUpstreamSessionStart() {
      broker = new RootBrokerServer({
        rootSessionId,
        lifecycleSessionId: rootSessionId,
        events: pi.events,
        captureProcessBirthIdentity: async () => "recovered-birth",
        upstream: {
          ping() {}, stop() {}, dispose() {},
        },
      });
      await broker.start();
    },
  });

  try {
    const errors = await emitRunner(pi, "session_start", { reason: "reload" }, { cwd: "/repo" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.ok(broker, "the project startup hook must run before upstream recovery");
    assert.equal(broker.ownedRuns.has(runId), true, "the Broker must observe the synchronous recovered started event");
  } finally {
    if (broker) {
      const observedAt = Date.now();
      pi.events.emit("subagent:process-terminal", {
        version: 1,
        state: "observed",
        runId,
        runnerProcessInstanceId: `${runId}-runner`,
        observedAt,
        instances: [{ processInstanceId: `${runId}-runner`, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
      });
      await new Promise((resolve) => setImmediate(resolve));
      await broker.closeRootSession();
    }
  }
});

test("reload gate keeps a bootstrapped RPC bridge isolated until old shutdown debt is repaid", async () => {
  const pi = piRunner();
  const store = {};
  const replies = [];
  const started = [];
  let failDrain = true;
  const bootstrap = (generation) => (api) => {
    api.registerTool({ name: "subagent_supervisor", execute() {} });
    api.events.on("request", () => replies.push(generation));
    api.on("session_start", () => started.push(generation));
    api.on("session_shutdown", () => {});
  };
  installHeadlessTypedSubagentRuntime(pi, { cleanupStore: store, rpc, bootstrap: bootstrap("old"), async beforeRuntimeDispose() { if (failDrain) throw new Error("old drain"); pi.events.emit("request"); } });
  await emitRunner(pi, "session_start");
  pi.events.emit("request");
  assert.deepEqual(replies, ["old"]);
  await assert.rejects(() => pi.handlers.get("session_shutdown")[0]({}, {}), /old drain/);

  installHeadlessTypedSubagentRuntime(pi, { cleanupStore: store, rpc, bootstrap: bootstrap("new") });
  failDrain = false;
  const errors = await emitRunner(pi, "session_start");
  assert.deepEqual(errors, [], "the runner may swallow failures, but no later handler may bypass ready");
  assert.deepEqual(replies, ["old", "old"], "the new bridge is still unsubscribed during old drain");
  assert.deepEqual(started, ["old", "new"]);
  pi.events.emit("request");
  assert.deepEqual(replies, ["old", "old", "new"]);
});

test("shutdown debt manager preserves three failed generations in order", async () => {
  const pi = piRunner(); const store = {}; const order = []; const failures = [true, true, true];
  for (let generation = 0; generation < 3; generation += 1) {
    installHeadlessTypedSubagentRuntime(pi, { cleanupStore: store, rpc, bootstrap() {}, async beforeRuntimeDispose() { order.push(generation); if (failures[generation]) throw new Error(`debt ${generation}`); } });
    await assert.rejects(() => pi.handlers.get("session_shutdown").at(-1)({}, {}));
  }
  failures.fill(false);
  await emitRunner(pi, "session_start");
  assert.deepEqual(order, [0, 0, 0, 0, 1, 2], "oldest debt is never overwritten by a later generation");
  assert.equal(store.__typedSubagentRuntimeShutdownDebt.debts.length, 0, "completed generations must release retained runtime ownership");
});

test("real Pi reload keeps every RPC bridge inactive until old debt is repaid", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-runtime-reload-"));
  const cleanupStore = {};
  const order = [];
  const replies = [];
  const lifecycleErrors = [];
  let generation = 0;
  let firstDrainAttempts = 0;
  let result;

  try {
    const factory = (pi) => {
      const current = ++generation;
      let runtime;
      runtime = installHeadlessTypedSubagentRuntime(pi, {
        cleanupStore,
        rpc: { dispose() { order.push(`project-${current}`); } },
        bootstrap(api) {
          api.registerTool({ name: "subagent_supervisor", execute() {} });
          api.events.on("shutdown-debt:request", () => replies.push(current));
          api.on("session_start", () => order.push(`upstream-start-${current}`));
          api.on("session_shutdown", (event, ctx) => order.push(`upstream-stop-${current}:${event.reason}:${ctx.cwd}`));
        },
        async beforeRuntimeDispose() {
          order.push(`drain-${current}`);
          if (current !== 1) return;
          firstDrainAttempts += 1;
          if (firstDrainAttempts === 1) throw new Error("controlled drain failure");
        },
      });
      pi.on("session_start", async (event, ctx) => {
        await runtime.ready(event, ctx);
        order.push(`broker-start-${current}`);
      });
    };

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      extensionFactories: [factory],
    });
    await loader.reload();
    result = await createAgentSession({
      cwd: root,
      agentDir: root,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    });
    await result.session.bindExtensions({
      mode: "rpc",
      shutdownHandler() {},
      onError(error) { lifecycleErrors.push(error.error); },
    });

    assert.deepEqual(order, ["upstream-start-1", "broker-start-1"]);
    await result.session.reload();

    // Pi 0.84 invalidates the old extension context and unsubscribes its event listeners before retry.
    assert.deepEqual(replies, [], "disposed extension listeners must not answer while shutdown debt is repaid");
    assert.deepEqual(order, [
      "upstream-start-1",
      "broker-start-1",
      "drain-1",
      "drain-1",
      `upstream-stop-1:reload:${root}`,
      "project-1",
      "upstream-start-2",
      "broker-start-2",
    ]);
    assert.deepEqual(lifecycleErrors, ["controlled drain failure"]);

    loader.eventBus.emit("shutdown-debt:request", {});
    assert.deepEqual(replies, [2], "the new bridge activates only after the old bridge is cleaned");
  } finally {
    if (result) {
      await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      result.session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown debt lanes isolate independent Pi instances sharing a cleanup store", async () => {
  const store = {}; const first = piRunner(); const second = piRunner();
  let firstFails = true; let secondDisposed = 0;
  installHeadlessTypedSubagentRuntime(first, { cleanupStore: store, rpc, bootstrap() {}, async beforeRuntimeDispose() { if (firstFails) throw new Error("first debt"); } });
  await assert.rejects(() => first.handlers.get("session_shutdown")[0]({}, {}), /first debt/);
  installHeadlessTypedSubagentRuntime(second, { cleanupStore: store, rpc: { dispose() { secondDisposed += 1; } }, bootstrap() {} });
  installHeadlessTypedSubagentRuntime(second, { cleanupStore: store, rpc, bootstrap() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondDisposed, 1, "an unrelated Pi debt must not prevent replacement cleanup");
  firstFails = false;
});

test("direct replacement retains a failed dispose as retryable debt", async () => {
  const store = {}; const pi = piRunner(); const calls = []; let failDispose = true;
  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore: store,
    bootstrap() {},
    rpc: { dispose() { calls.push("old-dispose"); if (failDispose) throw new Error("old dispose failed"); } },
  });
  const current = installHeadlessTypedSubagentRuntime(pi, { cleanupStore: store, bootstrap() {}, rpc });
  await new Promise((resolve) => setImmediate(resolve));
  failDispose = false;
  await current.ready({}, {});
  assert.deepEqual(calls, ["old-dispose", "old-dispose"]);
  assert.equal(store.__typedSubagentRuntimeShutdownDebt.debts.length, 1, "only the current generation debt remains");
});

test("replacement disposal cannot settle debt after ordered cleanup fails", async () => {
  const store = {}; const pi = piRunner(); let releaseDispose; let cleanupFails = true; let cleanupCalls = 0;
  const disposePending = new Promise((resolve) => { releaseDispose = resolve; });
  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore: store,
    bootstrap() {},
    rpc: { dispose() { return disposePending; } },
    async beforeRuntimeDispose() { cleanupCalls += 1; if (cleanupFails) throw new Error("ordered cleanup failed"); },
  });
  const current = installHeadlessTypedSubagentRuntime(pi, { cleanupStore: store, bootstrap() {}, rpc });
  await assert.rejects(() => current.ready({}, {}), /ordered cleanup failed/);
  releaseDispose();
  await new Promise((resolve) => setImmediate(resolve));
  cleanupFails = false;
  await current.ready({}, {});
  assert.equal(cleanupCalls, 2, "a transport disposal result must not erase failed ordered cleanup debt");
});

test("direct replacement hides unattempted upstream ownership from the new bootstrap", async () => {
  const store = {}; const pi = piRunner(); const oldCleanup = () => {}; const newCleanup = () => {}; let observed;
  delete globalThis.__piSubagentRuntimeCleanup;
  try {
    installHeadlessTypedSubagentRuntime(pi, {
      cleanupStore: store,
      bootstrap() { globalThis.__piSubagentRuntimeCleanup = oldCleanup; },
      rpc,
    });
    installHeadlessTypedSubagentRuntime(pi, {
      cleanupStore: store,
      bootstrap() {
        observed = globalThis.__piSubagentRuntimeCleanup;
        globalThis.__piSubagentRuntimeCleanup = newCleanup;
      },
      rpc,
    });
    assert.equal(observed, undefined);
    assert.equal(globalThis.__piSubagentRuntimeCleanup, newCleanup);
  } finally {
    delete globalThis.__piSubagentRuntimeCleanup;
  }
});

test("three direct replacements repay every intermediate generation in order", async () => {
  const store = {}; const pi = piRunner(); const calls = []; let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore: store,
    bootstrap() {},
    rpc: { dispose() { calls.push("first"); return firstPending; } },
  });
  installHeadlessTypedSubagentRuntime(pi, {
    cleanupStore: store,
    bootstrap() {},
    rpc: { dispose() { calls.push("second"); } },
  });
  const current = installHeadlessTypedSubagentRuntime(pi, { cleanupStore: store, bootstrap() {}, rpc });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first"]);
  releaseFirst();
  await current.ready({}, {});
  assert.deepEqual(calls, ["first", "second"]);
  await pi.handlers.get("session_shutdown").at(-1)({}, {});
  assert.equal(store.__typedSubagentRuntimeShutdownDebt.debts.length, 0);
});
