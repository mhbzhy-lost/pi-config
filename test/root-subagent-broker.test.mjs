import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { brokerGrantPath, readBrokerGrant } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
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

test("broker frame decoder preserves split UTF-8 and rejects oversized frames", () => {
  const decoder = createBrokerFrameDecoder();
  const frame = Buffer.from(`${JSON.stringify({ diagnostic: "中文" })}\n`, "utf8");
  const split = frame.indexOf(Buffer.from("中", "utf8")) + 1;
  assert.deepEqual(decoder.push(frame.subarray(0, split)), []);
  assert.deepEqual(decoder.push(frame.subarray(split)), [JSON.stringify({ diagnostic: "中文" })]);

  const oversized = createBrokerFrameDecoder();
  assert.throws(() => oversized.push("x".repeat(64 * 1024 + 1)), /too large/);
});
