import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";

import { brokerGrantPath, brokerSocketPath, readBrokerGrant } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";
import { createBrokerFrameDecoder, createRootBrokerClient } from "../scripts/lib/subagent-dispatch/root-broker-client.ts";
import { bindRootBroker, requireRootBroker, startAndBindRootBroker, unbindRootBroker } from "../scripts/lib/subagent-dispatch/root-broker-registry.ts";

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

test("Root broker registry keeps exact Pi ownership", async () => {
  const pi = {};
  const broker = { async start() {}, async closeRootSession() {} };
  bindRootBroker(pi, broker);
  assert.equal(requireRootBroker(pi), broker);
  assert.throws(() => bindRootBroker(pi, broker), /already bound/);
  unbindRootBroker(pi, broker);
  assert.throws(() => requireRootBroker(pi), /unavailable/);

  const started = [];
  const managed = { async start() { started.push("start"); }, async closeRootSession() { started.push("close"); } };
  await startAndBindRootBroker(pi, managed);
  assert.equal(requireRootBroker(pi), managed);
  unbindRootBroker(pi, managed);
  assert.deepEqual(started, ["start"]);
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
