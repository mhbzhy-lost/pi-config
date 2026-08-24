import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";

import { brokerGrantPath, brokerSocketPath, readBrokerGrant } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";
import { createBrokerFrameDecoder, createRootBrokerClient } from "../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { bindRootBroker, requireRootBroker, startAndBindRootBroker, unbindRootBroker, bindGoalExecutorCoordinator, bindGoalExecutorCoordinatorSession, findGoalExecutorCoordinator, unbindGoalExecutorCoordinatorSession } from "../scripts/lib/subagent-dispatch/root-broker-registry.ts";
import * as rootBrokerRegistry from "../scripts/lib/subagent-dispatch/root-broker-registry.ts";

class EventBus {
  handlers = new Map();
  on(type, handler) {
    const values = this.handlers.get(type) ?? new Set();
    values.add(handler);
    this.handlers.set(type, values);
    return () => values.delete(handler);
  }
  async emit(type, value) {
    await Promise.all([...this.handlers.get(type) ?? []].map((handler) => handler(value)));
  }
}

function observedProof(runId) {
  const observedAt = 1_700_000_000_000;
  const runnerProcessInstanceId = `${runId}-runner`;
  return {
    version: 1,
    runId,
    runnerProcessInstanceId,
    state: "observed",
    observedAt,
    instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
  };
}

function startedEvent(rootSessionId, runId = "executor-1") {
  return { runId, id: runId, agent: "executor", pid: 43210, asyncDir: `/tmp/${runId}`, sessionId: rootSessionId };
}

test("Root broker exposes no delegated caller or revival capability", () => {
  const broker = new RootBrokerServer({ rootSessionId: "root-capability", upstream: { async ping() { return { alive: true }; }, async stop() {}, async dispose() {} } });
  for (const name of ["grantCaller", "wakeCaller", "statusCaller", "interruptCaller", "stopCaller", "reviveCallerAfterProof", "routeSupervisorRequest"]) {
    assert.equal(typeof broker[name], "undefined", name);
  }
  assert.equal(broker.startedFacts({ ...startedEvent("root-capability", "runner-1"), agent: "plan-runner" }), undefined);
});

test("Root broker grants, serves, and drains one directly owned Executor", async (t) => {
  const rootSessionId = `root-direct-${process.pid}-${Date.now()}`;
  const runId = "executor-direct";
  const events = new EventBus();
  let broker;
  const calls = [];
  const upstream = {
    async ping() { calls.push({ method: "ping" }); return { alive: true }; },
    async stop(params) {
      calls.push({ method: "stop", params });
      broker.observeTerminal(observedProof(params.runId));
      return { stopped: true };
    },
    async dispose() { calls.push({ method: "dispose" }); },
  };
  broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    upstream,
    events,
    captureProcessBirthIdentity: async () => "birth-1",
    terminalTimeoutMs: 250,
    artifactPollIntervalMs: 5,
  });
  const grantPath = brokerGrantPath(rootSessionId, runId);
  let client;
  t.after(async () => {
    client?.dispose();
    await broker.closeRootSession().catch(() => undefined);
    await rm(grantPath, { force: true });
  });
  await broker.start();
  await events.emit("subagent:async-started", startedEvent(rootSessionId, runId));

  const grant = await readBrokerGrant(rootSessionId, runId);
  assert.equal(grant.role, "executor");
  assert.equal(broker.ownedRuns.get(runId)?.identityState, "verified");

  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 500 });
  assert.deepEqual(Object.keys(client).sort(), ["dispose", "ping", "subscribe"]);
  assert.deepEqual(await client.ping(), { alive: true });

  let resolveClosing;
  const closing = new Promise((resolve) => { resolveClosing = resolve; });
  const subscription = await client.subscribe((push) => {
    if (push.type === "root.closing") resolveClosing(push);
  });
  const closed = subscription.closed.catch((error) => error);
  const close = broker.closeRootSession();
  assert.deepEqual(await closing, { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId, callerRunId: runId, type: "root.closing", data: {} });
  await close;
  await closed;

  assert.deepEqual(calls, [
    { method: "ping" },
    { method: "stop", params: { runId, dir: `/tmp/${runId}` } },
    { method: "dispose" },
  ]);
  await assert.rejects(readBrokerGrant(rootSessionId, runId), { code: "ENOENT" });
  assert.equal(broker.teardown.released, true);
  client.dispose();
});

test("Root broker stops only an exact registered Goal-owned run and returns an official proof", async (t) => {
  const runId = "executor-goal-owned"; let broker; const calls = [];
  broker = new RootBrokerServer({ rootSessionId: "root-goal-owned", lifecycleSessionId: "root-goal-owned", captureProcessBirthIdentity: async () => "birth", writeGrant: async () => "/tmp/no-grant", terminalTimeoutMs: 100, upstream: { async ping() { return {}; }, async stop(request) { calls.push(request); broker.observeTerminal(observedProof(runId)); }, async dispose() {} } });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await broker.observeStarted(startedEvent("root-goal-owned", runId));
  const binding = { runId, asyncDir: `/tmp/${runId}`, sessionId: "root-goal-owned" };
  const stopped = await broker.stopGoalOwnedRun(binding);
  assert.equal(stopped.state, "observed"); assert.deepEqual(calls, [{ runId, dir: `/tmp/${runId}` }]);
  await assert.rejects(broker.stopGoalOwnedRun({ ...binding, asyncDir: "/tmp/other" }), /identity/);
});

test("Root broker returns a stable attention code without upstream error leakage", async (t) => {
  const runId = "executor-goal-stop-error";
  const broker = new RootBrokerServer({ rootSessionId: "root-stop-error", lifecycleSessionId: "root-stop-error", captureProcessBirthIdentity: async () => "birth", writeGrant: async () => "/tmp/no-grant", terminalTimeoutMs: 10, upstream: { async ping() { return {}; }, async stop() { throw new Error("private upstream failure"); }, async dispose() {} } });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await broker.observeStarted(startedEvent("root-stop-error", runId));
  const binding = { runId, asyncDir: `/tmp/${runId}`, sessionId: "root-stop-error" };
  const result = await broker.stopGoalOwnedRun(binding);
  assert.deepEqual(result, { state: "attention", code: "OWNED_STOP_UNAVAILABLE" });
});

test("Root broker exposes an immutable read-only ownership and successful terminal proof snapshot", async (t) => {
  const rootSessionId = "root-proof-snapshot";
  const runId = "executor-proof";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    captureProcessBirthIdentity: async () => "birth-proof",
    writeGrant: async () => "/tmp/nonexistent-proof-grant",
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  const emittedProof = observedProof(runId);
  broker.observeTerminal(emittedProof);

  assert.equal(typeof broker.inspectExecutorProof, "function");
  const snapshot = broker.inspectExecutorProof(runId);
  emittedProof.instances[0].exitCode = 9;
  emittedProof.observedAt += 10;
  assert.deepEqual(broker.inspectExecutorProof(runId), snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ["ownership", "schemaVersion", "terminal", "terminalConflict"]);
  assert.deepEqual(snapshot.ownership, {
    rootSessionId,
    runId,
    role: "executor",
    asyncDir: `/tmp/${runId}`,
    sessionId: rootSessionId,
    identityState: "verified",
  });
  assert.equal(snapshot.terminal.outcome, "succeeded");
  assert.equal(snapshot.terminal.observedAt, 1_700_000_000_000);
  assert.match(snapshot.terminal.proofId, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.terminalConflict, false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.ownership), true);
  assert.equal(Object.isFrozen(snapshot.terminal), true);
  for (const forbidden of ["removeWorktree", "deleteBranch", "cleanupGit", "releaseWorkspace"]) {
    assert.equal(Object.hasOwn(snapshot, forbidden), false);
    assert.equal(typeof broker[forbidden], "undefined");
  }
});

test("Root broker never marks a missing process birth identity as verified ownership", async () => {
  const rootSessionId = "root-missing-birth";
  const runId = "executor-missing-birth";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    captureProcessBirthIdentity: async () => null,
    writeGrant: async () => "/tmp/nonexistent-missing-birth-grant",
  });
  await broker.observeStarted(startedEvent(rootSessionId, runId));

  assert.equal(broker.inspectExecutorProof(runId).ownership.identityState, "unavailable");
});

test("Root broker tracks a registered Generic facade leaf official proof without an Executor grant", async () => {
  const rootSessionId = "root-generic-proof";
  const runId = "generic-proof";
  const grants = [];
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    writeGrant: async (grant) => { grants.push(grant); return "/tmp/nonexistent-generic-grant"; },
  });
  broker.registerFacadeRun({ runId, asyncDir: "/tmp/generic-proof", sessionId: rootSessionId, pid: 43210, agent: "reviewer", kind: "generic" });
  broker.observeTerminal({ ...observedProof(runId), sessionId: rootSessionId, pid: 43210, asyncDir: "/tmp/generic-proof", agent: "reviewer" });

  const proof = broker.inspectFacadeTerminalProof(runId);
  assert.deepEqual(proof, {
    runId,
    state: "observed",
    proofHash: proof.proofHash,
    proof: observedProof(runId),
    conflict: false,
  });
  assert.match(proof.proofHash, /^[a-f0-9]{64}$/);
  assert.equal(broker.inspectExecutorProof(runId), null);
  assert.deepEqual(grants, []);

  broker.observeTerminal({ ...observedProof(runId), sessionId: rootSessionId, pid: 999, asyncDir: "/tmp/generic-proof", agent: "reviewer" });
  broker.observeTerminal({ ...observedProof(runId), sessionId: rootSessionId, pid: 43210, asyncDir: "/tmp/foreign", agent: "reviewer" });
  broker.observeTerminal({ ...observedProof(runId), sessionId: "foreign", pid: 43210, asyncDir: "/tmp/generic-proof", agent: "reviewer" });
  assert.equal(broker.inspectFacadeTerminalProof(runId).conflict, false);
  broker.observeTerminal({ ...observedProof(runId), sessionId: rootSessionId, pid: 43210, asyncDir: "/tmp/generic-proof", agent: "reviewer", observedAt: 2 });
  assert.equal(broker.inspectFacadeTerminalProof(runId).conflict, true);
  assert.equal(broker.inspectFacadeTerminalProof("unknown"), null);
});

test("Root broker marks conflicting official terminal proofs instead of replacing the first proof", async (t) => {
  const rootSessionId = "root-proof-conflict";
  const runId = "executor-proof-conflict";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    captureProcessBirthIdentity: async () => "birth-proof-conflict",
    writeGrant: async () => "/tmp/nonexistent-proof-conflict-grant",
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  const first = observedProof(runId);
  broker.observeTerminal(first);
  broker.observeTerminal({
    ...first,
    observedAt: first.observedAt + 1,
    instances: first.instances.map((instance) => ({ ...instance, closeObservedAt: instance.closeObservedAt + 1 })),
  });

  const snapshot = broker.inspectExecutorProof(runId);
  assert.equal(snapshot.terminalConflict, true);
  assert.equal(snapshot.terminal.observedAt, first.observedAt);
  assert.equal(snapshot.terminal.outcome, "succeeded");
});

test("Root broker rejects malformed, foreign, and conflicting started ownership", async () => {
  const captures = [];
  const broker = new RootBrokerServer({
    rootSessionId: "root-started",
    lifecycleSessionId: "root-started",
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    captureProcessBirthIdentity: async (pid) => { captures.push(pid); return `birth-${pid}`; },
    writeGrant: async () => "/tmp/nonexistent-direct-grant",
  });
  await broker.observeStarted({ ...startedEvent("foreign", "foreign"), sessionId: "foreign" });
  await broker.observeStarted({ ...startedEvent("root-started", "bad-agent"), agent: "plan-runner" });
  await broker.observeStarted({ ...startedEvent("root-started", "bad-path"), asyncDir: "relative" });
  assert.deepEqual(captures, []);
  assert.equal(broker.ownedRuns.size, 0);

  await broker.observeStarted(startedEvent("root-started", "executor-conflict"));
  await broker.observeStarted({ ...startedEvent("root-started", "executor-conflict"), pid: 54321 });
  assert.equal(broker.ownedRuns.get("executor-conflict")?.identityState, "conflict");
  assert.deepEqual(captures, [43210]);
});

test("Root broker registry exposes only the bound broker's read-only executor proof", () => {
  assert.equal(typeof rootBrokerRegistry.inspectRootBrokerExecutorProof, "function");
  const pi = { events: {} };
  const snapshot = Object.freeze({ schemaVersion: "root-broker.executor-proof.v1", ownership: Object.freeze({ runId: "run-1" }), terminal: null, terminalConflict: false });
  const broker = { rootSessionId: "root-registry-proof", inspectExecutorProof(runId) { assert.equal(runId, "run-1"); return snapshot; } };
  bindRootBroker(pi, broker);
  try {
    assert.strictEqual(rootBrokerRegistry.inspectRootBrokerExecutorProof(pi, "run-1"), snapshot);
  } finally {
    unbindRootBroker(pi, broker);
  }
  assert.throws(() => rootBrokerRegistry.inspectRootBrokerExecutorProof(pi, "run-1"), /unavailable/);
});

test("Goal executor coordinator resolves a session alias across ExtensionAPI wrappers and CAS-unbinds", () => {
  const goalPi = { events: {} };
  const subagentPi = { events: {} };
  const foreignPi = { events: {} };
  const coordinator = { prepareSpawn() {}, bindSpawn() {} };
  bindGoalExecutorCoordinator(goalPi, coordinator);
  bindGoalExecutorCoordinatorSession(goalPi, "root-goal-alias", coordinator);
  assert.strictEqual(findGoalExecutorCoordinator(goalPi), coordinator, "same-wrapper lookup remains preferred");
  assert.strictEqual(findGoalExecutorCoordinator(subagentPi, "root-goal-alias"), coordinator);
  assert.equal(findGoalExecutorCoordinator(foreignPi, "root-other-session"), undefined);
  unbindGoalExecutorCoordinatorSession(goalPi, "root-goal-alias", { prepareSpawn() {}, bindSpawn() {} });
  assert.strictEqual(findGoalExecutorCoordinator(subagentPi, "root-goal-alias"), coordinator, "foreign shutdown cannot delete the alias");
  unbindGoalExecutorCoordinatorSession(goalPi, "root-goal-alias", coordinator);
  assert.equal(findGoalExecutorCoordinator(goalPi), undefined, "correct shutdown clears the exact wrapper binding");
  assert.equal(findGoalExecutorCoordinator(subagentPi, "root-goal-alias"), undefined);
});

test("Goal executor coordinator session replacement does not resurrect the old generation", () => {
  const events = {};
  const goalPi = { events };
  const replacementPi = { events };
  const oldCoordinator = { prepareSpawn() {}, bindSpawn() {} };
  const replacement = { prepareSpawn() {}, bindSpawn() {} };
  bindGoalExecutorCoordinatorSession(goalPi, "root-goal-old", oldCoordinator);
  bindGoalExecutorCoordinatorSession(replacementPi, "root-goal-new", replacement);
  unbindGoalExecutorCoordinatorSession(goalPi, "root-goal-old", oldCoordinator);
  assert.strictEqual(findGoalExecutorCoordinator(goalPi), replacement);
  assert.strictEqual(findGoalExecutorCoordinator({ events: {} }, "root-goal-new"), replacement);
  assert.equal(findGoalExecutorCoordinator({ events: {} }, "root-goal-old"), undefined);
});

test("Root broker registry reload coexists with a legacy v1 WeakMap process slot", () => {
  const registryUrl = new URL("../scripts/lib/subagent-dispatch/root-broker-registry.ts", import.meta.url).href;
  const source = `
    const legacyKey = Symbol.for("pi.root-subagent-broker-registry.v1");
    const legacy = new WeakMap();
    Object.defineProperty(process, legacyKey, { value: legacy, enumerable: false, configurable: false, writable: false });
    const first = await import(${JSON.stringify(registryUrl)} + "?generation=first");
    const second = await import(${JSON.stringify(registryUrl)} + "?generation=second");
    const pi = { events: {} };
    const broker = { rootSessionId: "root-legacy-slot", async start() {}, async closeRootSession() {} };
    first.bindRootBroker(pi, broker);
    if (second.requireRootBroker(pi, "root-legacy-slot") !== broker) throw new Error("new registry slot is not shared across module copies");
    second.unbindRootBroker(pi, broker);
    if (Object.getOwnPropertyDescriptor(process, legacyKey)?.value !== legacy) throw new Error("legacy slot was changed");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("Root broker registry keeps exact Pi ownership", async () => {
  const pi = {};
  const broker = { rootSessionId: "root-exact-ownership", async start() {}, async closeRootSession() {} };
  bindRootBroker(pi, broker);
  assert.equal(requireRootBroker(pi), broker);
  assert.throws(() => bindRootBroker(pi, broker), /already bound/);
  unbindRootBroker(pi, broker);
  assert.throws(() => requireRootBroker(pi), /unavailable/);

  const started = [];
  const managed = { rootSessionId: "root-exact-managed", async start() { started.push("start"); }, async closeRootSession() { started.push("close"); } };
  await startAndBindRootBroker(pi, managed);
  assert.equal(requireRootBroker(pi), managed);
  unbindRootBroker(pi, managed);
  assert.deepEqual(started, ["start"]);
});

test("Root broker registry requires an explicit Root session identity across Pi facades", () => {
  const runtimePi = { events: {} };
  const probePi = { events: {} };
  const broker = { rootSessionId: "root-facade-shared", async start() {}, async closeRootSession() {} };
  const replacement = { rootSessionId: "root-facade-shared", async start() {}, async closeRootSession() {} };

  bindRootBroker(runtimePi, broker);
  try {
    assert.throws(() => requireRootBroker(probePi), /unavailable/);
    assert.strictEqual(requireRootBroker(probePi, "root-facade-shared"), broker);
    assert.throws(() => requireRootBroker(runtimePi, "root-facade-missing"), /unavailable/);
    assert.throws(() => requireRootBroker(probePi, ""), /identity is invalid/);
    assert.throws(() => requireRootBroker(probePi, "root-facade-missing"), /unavailable/);
    assert.throws(() => bindRootBroker(probePi, { rootSessionId: "root-facade-shared" }), /already bound/);

    unbindRootBroker(runtimePi, broker);
    bindRootBroker(runtimePi, replacement);
    unbindRootBroker(runtimePi, broker);
    assert.strictEqual(requireRootBroker(probePi, "root-facade-shared"), replacement);
    unbindRootBroker(runtimePi, replacement);
    assert.throws(() => requireRootBroker(probePi, "root-facade-shared"), /unavailable/);
  } finally {
    unbindRootBroker(runtimePi, broker);
    unbindRootBroker(runtimePi, replacement);
  }
});

test("Root broker startup rolls back an earlier lifecycle listener when later registration fails", async () => {
  const rootSessionId = `root-start-rollback-${process.pid}-${Date.now()}`;
  const bus = new EventBus();
  let registrations = 0;
  const events = {
    on(type, handler) {
      registrations += 1;
      if (registrations === 2) throw new Error("terminal listener registration failed");
      return bus.on(type, handler);
    },
  };
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    events,
    captureProcessBirthIdentity: async () => "birth-start-rollback",
    writeGrant: async () => "/tmp/unreachable-start-rollback-grant",
  });

  await assert.rejects(broker.start(), /terminal listener registration failed/);
  assert.equal(bus.handlers.get("subagent:async-started")?.size ?? 0, 0);
  await bus.emit("subagent:async-started", startedEvent(rootSessionId, "executor-after-failed-start"));
  assert.equal(broker.ownedRuns.size, 0);
});

test("Root broker preserves the startup error when socket cleanup also fails", async (t) => {
  const rootSessionId = `root-start-error-${process.pid}-${Date.now()}`;
  const socketPath = brokerSocketPath(rootSessionId);
  const bus = new EventBus();
  let registrations = 0;
  const events = {
    on(type, handler) {
      registrations += 1;
      if (registrations === 2) {
        rmSync(socketPath, { force: true });
        mkdirSync(socketPath);
        throw new Error("original listener startup failure");
      }
      return bus.on(type, handler);
    },
  };
  const broker = new RootBrokerServer({
    rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    events,
  });
  t.after(async () => {
    await rm(socketPath, { force: true, recursive: true });
  });

  await assert.rejects(broker.start(), /original listener startup failure/);
});

test("Root broker closes an accepted socket before waiting for failed startup transport", async (t) => {
  const rootSessionId = `root-start-socket-${process.pid}-${Date.now()}`;
  const socketPath = brokerSocketPath(rootSessionId);
  let client;
  let broker;
  broker = new RootBrokerServer({
    rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    setSocketPermissions: async () => {
      client = createConnection(socketPath);
      client.on("error", () => undefined);
      await new Promise((resolve) => client.once("connect", resolve));
      while (broker.sockets.size === 0) await new Promise((resolve) => setImmediate(resolve));
      throw new Error("socket permission startup failure");
    },
  });
  t.after(async () => {
    client?.destroy();
    await broker.closeRootSession().catch(() => undefined);
    await rm(socketPath, { force: true, recursive: true });
  });

  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("startup rollback deadline exceeded")), 500);
  });
  try {
    await assert.rejects(Promise.race([broker.start(), deadline]), /socket permission startup failure/);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(broker.sockets.size, 0);
});

test("broker frame decoder preserves split UTF-8 and rejects oversized frames", () => {
  const decoder = createBrokerFrameDecoder();
  const frame = Buffer.from(`${JSON.stringify({ diagnostic: "中文" })}\n`, "utf8");
  const split = frame.indexOf(Buffer.from("中", "utf8")) + 1;
  assert.deepEqual(decoder.push(frame.subarray(0, split)), []);
  assert.deepEqual(decoder.push(frame.subarray(split)), [JSON.stringify({ diagnostic: "中文" })]);

  const oversized = createBrokerFrameDecoder();
  assert.throws(() => oversized.push("x".repeat(64 * 1024 + 1)), /too large/);
});
