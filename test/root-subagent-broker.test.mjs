import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { brokerGrantPath, brokerSocketPath, parseBrokerPush, readBrokerGrant, writeBrokerGrant } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { createBrokerFrameDecoder, createRootBrokerClient } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts";
import { bindRootBroker, requireRootBroker, startAndBindRootBroker, unbindRootBroker, bindGoalRunCoordinator, bindGoalRunCoordinatorSession, findGoalRunCoordinator, unbindGoalRunCoordinatorSession } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import * as rootBrokerRegistry from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";

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

test("Root Broker heartbeat renews verified durable leases without upstream or event side effects", async (t) => {
  const { AuthorityStore } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts");
  const root = await mkdtemp(join(tmpdir(), "root-broker-heartbeat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const timers = [];
  const calls = [];
  const broker = new RootBrokerServer({ rootSessionId: "root-heartbeat", lifecycleSessionId: "root-heartbeat", authorityStore: new AuthorityStore({ root, rootSessionId: "root-heartbeat" }), clock: () => now, setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearInterval() {}, captureProcessBirthIdentity: async () => "birth-heartbeat", upstream: { async ping() { calls.push("ping"); }, async stop() { calls.push("stop"); }, async dispose() { calls.push("dispose"); } } });
  await broker.registerAuthorizedRun(createRunAuthorization({ kind: "coding", binding: { runId: "run-heartbeat", asyncDir: "/tmp/run-heartbeat", sessionId: "root-heartbeat", pid: 123, agentProfile: "executor" }, goal: null }));
  const before = await broker.authorityStore.readLease("run-heartbeat");
  await broker.start();
  assert.equal(timers[0].ms, 15_000);
  now = 16_000;
  const renewal = timers[0].fn();
  assert.equal(typeof renewal?.then, "function", "fake timer callback must expose the renewal Promise");
  await renewal;
  const after = await broker.authorityStore.readLease("run-heartbeat");
  assert.equal(after.renewalSequence, 1);
  assert.equal(after.lastRenewedAt, now);
  assert.deepEqual(calls, [], "heartbeat must not invoke upstream turns or stops");
  broker.observeTerminal(observedProof("run-heartbeat"));
  await broker.closeRootSession();
});

test("Root Broker replays pending recovery event when root attaches a subscription", () => {
  const broker = new RootBrokerServer({ rootSessionId: "root-replay", upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  const writes = [];
  const socket = { destroyed: false, once(_event, handler) { this.closeHandler = handler; }, write(value) { writes.push(JSON.parse(value)); } };
  const event = { recoveryIntentId: "intent-replay", queueItemId: "queue-replay", workspaceId: "workspace-replay", runId: "run-replay", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-replay" }, attempt: 1, generation: 1, reason: "root restart", requiredAction: "preserve" };
  assert.deepEqual(broker.publishRecoveryEvent(event), { state: "debt", reason: "root-not-subscribed" });
  broker.registerSubscription("run-replay", socket);
  broker.replayRecoveryNotifications("run-replay");
  assert.equal(writes[0].type, "recovery.event");
  assert.equal(writes[0].data.recoveryIntentId, "intent-replay");
  assert.equal(writes[0].data.schemaVersion, "recovery-event.v1");
});

test("Root Broker recovery event is structured and offline delivery becomes replayable debt", () => {
  const broker = new RootBrokerServer({ rootSessionId: "root-recovery", upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  const event = { recoveryIntentId: "intent-1", queueItemId: "queue-1", workspaceId: "workspace-1", runId: "run-1", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-recovery" }, attempt: 1, generation: 2, reason: "broker disconnected", requiredAction: "preserve" };
  const result = broker.publishRecoveryEvent(event);
  assert.deepEqual(result, { state: "debt", reason: "root-not-subscribed" });
  assert.equal(broker.recoveryNotificationDebt.length, 1);
  assert.equal(broker.recoveryNotifications[0].schemaVersion, "recovery-event.v1");
  assert.equal("token" in broker.recoveryNotifications[0], false);
});

// Equivalent to upstream writeAtomicJson: an unspecified write mode followed by
// same-directory atomic rename. Native Node refuses type stripping for TS below
// node_modules, so the test cannot invoke that upstream TS source directly.
function upstreamWriteAtomicJsonFixture(file, value) {
  const temp = `${file}.${process.pid}.fixture.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
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
function goalAuthority(sessionId, runId) {
  return { goalId: "test-goal", taskId: "test-task", attempt: 1, runId, asyncDir: `/tmp/${runId}`, workspacePath: "/tmp/test-workspace", leaseId: "a".repeat(64), sessionId, baseHead: "b".repeat(40), headAtDispatch: "b".repeat(40), executionRevision: 1, contractHash: "c".repeat(64), expectedCriteria: ["criterion-1"], agentProfile: "executor" };
}
function goalStopRequest({ expectedCriteria: _expectedCriteria, agentProfile: _agentProfile, ...request }) { return { ...request, agent: "executor" }; }
function persistGoalAuthority(broker, authority) { broker.persistGoalBindingAuthority({ version: "root-broker.goal-run-binding-authority.v2", ticketId: "d".repeat(64), ...authority }); }
async function authorize(broker, event, goal = null) {
  await broker.registerAuthorizedRun(createRunAuthorization({
    kind: "coding",
    binding: { runId: event.runId, asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid, agentProfile: event.agent },
    goal: goal && { ticketId: "d".repeat(64), goalId: goal.goalId, taskId: goal.taskId, attempt: goal.attempt, contractHash: goal.contractHash, workspaceId: "workspace-1", executionRevision: goal.executionRevision, expectedCriteria: goal.expectedCriteria },
  }));
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
  await authorize(broker, startedEvent(rootSessionId, runId));
  await events.emit("subagent:async-started", startedEvent(rootSessionId, runId));

  const grant = await readBrokerGrant(rootSessionId, runId);
  assert.deepEqual(grant.capabilities, ["root.subscribe"]);
  assert.equal(broker.ownedRuns.get(runId)?.identityState, "verified");

  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 2_000 });
  assert.deepEqual(Object.keys(client).sort(), ["dispose", "ping", "readOwnerReceipt", "rebindRun", "revokeOwner", "submitAcceptanceEvidence", "subscribe"]);
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

test("Root broker rolls back authorization when durable grant creation fails", async () => {
  const rootSessionId = "root-grant-failure";
  const runId = "executor-grant-failure";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    captureProcessBirthIdentity: async () => "birth-grant-failure",
    writeGrant: async () => { throw Object.assign(new Error("grant storage unavailable"), { code: "EIO" }); },
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  const event = startedEvent(rootSessionId, runId);
  await assert.rejects(authorize(broker, event), { code: "EIO" });
  assert.equal(broker.ownedRuns.has(runId), false);
  assert.equal(broker.principals.has(runId), false);
  assert.equal(broker.authorizationGrants.has(runId), false);
});

test("Root broker authorizes all child integration operations by caller run and rejects foreign or revoked grants", async (t) => {
  const rootSessionId = "root-coordinator-request";
  const runId = "child-coordinator-request";
  const calls = [];
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    writeGrant: async () => "/tmp/coordinator-request-grant",
    captureProcessBirthIdentity: async () => "birth-coordinator-request",
    coordinatorRequest: async (...args) => { calls.push(args); return { accepted: true }; },
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  const event = startedEvent(rootSessionId, runId);
  await authorize(broker, event);
  await broker.observeStarted(event);
  const token = broker.principals.get(runId).callerToken;
  const inputs = {
    enqueue: { requestId: "tool-call", authorizedWorkspaceHead: "a".repeat(40), targetRef: "refs/heads/main" },
    await_admission: { queueItemId: "queue-1" },
    report_conflict: { queueItemId: "queue-1", queueLeaseId: "lease-1" },
    publish: { queueItemId: "queue-1", queueLeaseId: "lease-1", candidateHead: "b".repeat(40) },
    fail: { queueItemId: "queue-1", queueLeaseId: "lease-1", retry: false },
    inspect_integration_state: {},
    preserve_integration_debt: {},
  };
  const dispatch = (callerRunId, callerToken, operation, input) => broker.dispatch({
    schemaVersion: "pi-root-subagent-broker-request.v1", requestId: `request-${operation}`,
    rootSessionId, callerRunId, callerToken, method: "coordinator.request", params: { operation, input },
  }, {});
  for (const [operation, input] of Object.entries(inputs)) {
    assert.equal((await dispatch(runId, token, operation, input)).success, true, operation);
    assert.equal((await dispatch("foreign-run", token, operation, input)).success, false, operation);
  }
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.map(([callerRunId, operation]) => [callerRunId, operation]), Object.keys(inputs).map((operation) => [runId, operation]));
  broker.coordinatorRequest = undefined;
  assert.equal((await dispatch(runId, token, "inspect_integration_state", {})).success, false);
  assert.equal(broker.inspectIntegrationRequests(runId).debt.operation, "inspect_integration_state");
  broker.revokedRuns.add(runId);
  for (const [operation, input] of Object.entries(inputs)) assert.equal((await dispatch(runId, token, operation, input)).success, false, operation);
  assert.equal(calls.length, 7);
});

test("Root broker keeps an owned child integration request alive across Root session close", async (t) => {
  const rootSessionId = `root-integration-drain-${process.pid}-${Date.now()}`;
  const runId = "child-integration-drain";
  const grantPath = brokerGrantPath(rootSessionId, runId);
  let releaseIntegration;
  const integrationGate = new Promise((resolve) => { releaseIntegration = resolve; });
  const coordinatorCalls = [];
  let broker;
  broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    captureProcessBirthIdentity: async () => "birth-integration-drain",
    terminalTimeoutMs: 250,
    integrationTimeoutMs: 5_000,
    coordinatorRequest: async (callerRunId, operation, input) => {
      coordinatorCalls.push({ callerRunId, operation, input });
      await integrationGate;
      return { accepted: true, operation };
    },
    upstream: {
      async ping() { return {}; },
      async stop(params) { broker.observeTerminal(observedProof(params.runId)); return { stopped: true }; },
      async dispose() {},
    },
  });
  let client;
  t.after(async () => {
    releaseIntegration();
    client?.dispose();
    await broker.closeRootSession().catch(() => undefined);
    await rm(grantPath, { force: true });
  });
  await broker.start();
  await authorize(broker, startedEvent(rootSessionId, runId));
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 5_000 });

  // The child still has an integration request in flight when the Root session
  // begins to close. A premature drain tears down the broker transport and the
  // child observes BROKER_DISCONNECTED for work the Root asked it to perform.
  const inflight = client.coordinatorRequest("enqueue", {
    requestId: "tool-call", authorizedWorkspaceHead: "a".repeat(40), targetRef: "refs/heads/main",
  });
  // Wait until the broker has accepted the request and started the (blocked)
  // coordinator operation, so the request is genuinely in flight before close.
  while (coordinatorCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const close = broker.closeRootSession();
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseIntegration();
  // GREEN: the Root waits for the owned integration request to settle, so it
  // completes. RED: the request rejects with BROKER_DISCONNECTED.
  assert.deepEqual(await inflight, { accepted: true, operation: "enqueue" });
  await close;
  assert.equal(broker.teardown.released, true);
  assert.deepEqual(coordinatorCalls.map((call) => call.operation), ["enqueue"]);
});

test("Root broker records integration debt and stays bounded when a child request cannot settle before close", async (t) => {
  const rootSessionId = `root-integration-debt-${process.pid}-${Date.now()}`;
  const runId = "child-integration-debt";
  const grantPath = brokerGrantPath(rootSessionId, runId);
  let releaseIntegration;
  const integrationGate = new Promise((resolve) => { releaseIntegration = resolve; });
  let broker;
  broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    captureProcessBirthIdentity: async () => "birth-integration-debt",
    terminalTimeoutMs: 250,
    integrationTimeoutMs: 100,
    coordinatorRequest: async () => { await integrationGate; return { accepted: true }; },
    upstream: {
      async ping() { return {}; },
      async stop(params) { broker.observeTerminal(observedProof(params.runId)); return { stopped: true }; },
      async dispose() {},
    },
  });
  let client;
  t.after(async () => {
    releaseIntegration();
    client?.dispose();
    await broker.closeRootSession().catch(() => undefined);
    await rm(grantPath, { force: true });
  });
  await broker.start();
  await authorize(broker, startedEvent(rootSessionId, runId));
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 5_000 });

  const inflight = client.coordinatorRequest("enqueue", {
    requestId: "tool-call", authorizedWorkspaceHead: "a".repeat(40), targetRef: "refs/heads/main",
  });
  // Attach a handler immediately so the bounded disconnect during close is not
  // an unhandled rejection; the outcome is asserted after the close completes.
  const inflightOutcome = inflight.then(() => undefined, (error) => error);
  while (broker.inspectIntegrationRequests(runId).inflight.length === 0) await new Promise((resolve) => setImmediate(resolve));
  // The close deadline expires before the request settles; the broker records
  // observable debt and proceeds instead of hanging forever.
  await broker.closeRootSession();
  const debt = broker.inspectIntegrationRequests(runId).debt;
  assert.equal(debt.operation, "enqueue");
  assert.match(debt.reason, /settle/i);
  // The pending request is disconnected (a bounded outcome), never left hanging.
  const outcome = await inflightOutcome;
  assert.equal(outcome?.code, "BROKER_DISCONNECTED");
  assert.equal(broker.teardown.released, true);
});

test("Root broker close is idempotent under duplicate close and leaves no residual transport", async (t) => {
  const rootSessionId = `root-duplicate-close-${process.pid}-${Date.now()}`;
  const runId = "child-duplicate-close";
  const grantPath = brokerGrantPath(rootSessionId, runId);
  let broker;
  const disposeCalls = [];
  broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    captureProcessBirthIdentity: async () => "birth-duplicate-close",
    terminalTimeoutMs: 250,
    upstream: {
      async ping() { return {}; },
      async stop(params) { broker.observeTerminal(observedProof(params.runId)); return { stopped: true }; },
      async dispose() { disposeCalls.push("dispose"); },
    },
  });
  let client;
  t.after(async () => {
    client?.dispose();
    await broker.closeRootSession().catch(() => undefined);
    await rm(grantPath, { force: true });
  });
  await broker.start();
  await authorize(broker, startedEvent(rootSessionId, runId));
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 2_000 });

  await Promise.all([broker.closeRootSession(), broker.closeRootSession()]);
  assert.equal(broker.teardown.released, true);
  assert.deepEqual(disposeCalls, ["dispose"], "duplicate close tears down upstream exactly once");
  assert.equal(broker.server, undefined, "the listening server is released");
  assert.equal(broker.sockets.size, 0, "no residual accepted sockets");
  assert.equal(broker.transportSockets.size, 0, "no residual transport sockets");
  assert.equal(broker.integrationRequests.size, 0, "no residual integration tracking");
});

test("authenticated Executor submits bound acceptance evidence only after its durable context exists", async (t) => {
  const rootSessionId = `root-acceptance-${process.pid}-${Date.now()}`;
  const runId = "executor-acceptance";
  const root = await mkdtemp(join(tmpdir(), "root-broker-acceptance-"));
  const workspacePath = join(root, "workspace");
  const asyncDir = join(root, "async");
  mkdirSync(workspacePath);
  mkdirSync(asyncDir);
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-q"], { cwd: workspacePath });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspacePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspacePath });
  execFileSync("git", ["add", "README.md"], { cwd: workspacePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workspacePath });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8" }).trim();
  const events = new EventBus();
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    events,
    captureProcessBirthIdentity: async () => "birth-acceptance",
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  let client;
  t.after(async () => {
    client?.dispose();
    broker.observeTerminal(observedProof(runId));
    await broker.closeRootSession().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await broker.start();
  const acceptanceEvent = { ...startedEvent(rootSessionId, runId), asyncDir };
  const acceptanceAuthority = { ...goalAuthority(rootSessionId, runId), goalId: "goal-acceptance", taskId: "task-acceptance", asyncDir, workspacePath };
  await authorize(broker, acceptanceEvent, acceptanceAuthority);
  await events.emit("subagent:async-started", acceptanceEvent);
  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 2_000 });
  const params = {
    outcome: "succeeded",
    criteria: [{ id: "criterion-1", status: "satisfied", evidence: [`sha256:${"1".repeat(64)}`] }],
    commandsRun: [{ command: "node --test", result: "passed", outputRef: `sha256:${"2".repeat(64)}` }],
    changedFiles: [],
  };
  await assert.rejects(client.submitAcceptanceEvidence(params), { code: "CONTEXT_NOT_READY" });
  broker.persistGoalBindingAuthority({
    version: "root-broker.goal-run-binding-authority.v2",
    ticketId: "d".repeat(64),
    goalId: acceptanceAuthority.goalId,
    taskId: acceptanceAuthority.taskId,
    attempt: acceptanceAuthority.attempt,
    runId,
    asyncDir,
    workspacePath,
    leaseId: "a".repeat(64),
    sessionId: rootSessionId,
    baseHead: head,
    headAtDispatch: head,
    executionRevision: acceptanceAuthority.executionRevision,
    contractHash: acceptanceAuthority.contractHash,
    expectedCriteria: acceptanceAuthority.expectedCriteria,
    agentProfile: "executor",
  });
  const first = await client.submitAcceptanceEvidence(params);
  const second = await client.submitAcceptanceEvidence(params);
  assert.deepEqual(second, first);
  assert.equal(first.path, join(asyncDir, "acceptance-evidence", `${first.fingerprint}.yaml`));
  assert.match(await readFile(first.path, "utf8"), new RegExp(`head: "${head}"`));
  assert.equal((await lstat(first.path)).mode & 0o777, 0o600);
  await assert.rejects(client.submitAcceptanceEvidence({ ...params, criteria: [{ ...params.criteria[0], id: "wrong" }] }));
});

test("Root broker stops only an exact registered Goal-owned run and returns an official proof", async (t) => {
  const runId = "executor-goal-owned"; let broker; const calls = [];
  broker = new RootBrokerServer({ rootSessionId: "root-goal-owned", lifecycleSessionId: "root-goal-owned", captureProcessBirthIdentity: async () => "birth", writeGrant: async () => "/tmp/no-grant", terminalTimeoutMs: 100, upstream: { async ping() { return {}; }, async stop(request) { calls.push(request); broker.observeTerminal(observedProof(runId)); }, async dispose() {} } });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  const binding = goalAuthority("root-goal-owned", runId);
  await authorize(broker, startedEvent("root-goal-owned", runId), binding);
  persistGoalAuthority(broker, binding);
  await broker.observeStarted(startedEvent("root-goal-owned", runId));
  const stopped = await broker.stopGoalOwnedRun(goalStopRequest(binding));
  assert.equal(stopped.state, "observed"); assert.deepEqual(calls, [{ runId, dir: `/tmp/${runId}` }]);
  assert.deepEqual(await broker.stopGoalOwnedRun({ ...goalStopRequest(binding), asyncDir: "/tmp/other" }), { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
});

test("Root broker returns a stable attention code without upstream error leakage", async (t) => {
  const runId = "executor-goal-stop-error";
  const broker = new RootBrokerServer({ rootSessionId: "root-stop-error", lifecycleSessionId: "root-stop-error", captureProcessBirthIdentity: async () => "birth", writeGrant: async () => "/tmp/no-grant", terminalTimeoutMs: 10, upstream: { async ping() { return {}; }, async stop() { throw new Error("private upstream failure"); }, async dispose() {} } });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  const binding = goalAuthority("root-stop-error", runId);
  await authorize(broker, startedEvent("root-stop-error", runId), binding);
  persistGoalAuthority(broker, binding);
  await broker.observeStarted(startedEvent("root-stop-error", runId));
  const result = await broker.stopGoalOwnedRun(goalStopRequest(binding));
  assert.deepEqual(result, { state: "attention", code: "OWNED_STOP_UNAVAILABLE" });
});

test("standalone run terminal proof is visible without Goal authority", async (t) => {
  const rootSessionId = "root-standalone-proof";
  const runId = "standalone-proof-run";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    captureProcessBirthIdentity: async () => "birth-standalone-proof",
    writeGrant: async () => "/tmp/nonexistent-standalone-grant",
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  // standalone coding dispatch：goal 为 null
  await authorize(broker, startedEvent(rootSessionId, runId), null);
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  broker.observeTerminal(observedProof(runId));

  const snapshot = broker.inspectExecutionProof(runId);
  assert.notEqual(snapshot.terminal, null, "standalone terminal proof must be observable after acceptance");
  assert.equal(snapshot.terminal.outcome, "succeeded");
  assert.match(snapshot.terminal.proofId, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.terminal.proof, observedProof(runId));
  // authorization.state 独立报告，不因 terminal 可见而变成 verified
  assert.deepEqual(snapshot.authorization, { state: "unavailable" });
});

test("Root broker exposes an immutable neutral execution proof without the legacy executor inspector", async (t) => {
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
  await authorize(broker, startedEvent(rootSessionId, runId), goalAuthority(rootSessionId, runId));
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  const emittedProof = observedProof(runId);
  broker.observeTerminal(emittedProof);

  assert.equal(typeof broker.inspectExecutorProof, "undefined");
  const snapshot = broker.inspectExecutionProof(runId);
  emittedProof.instances[0].exitCode = 9;
  emittedProof.observedAt += 10;
  assert.deepEqual(broker.inspectExecutionProof(runId), snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ["authorization", "binding", "capabilities", "schemaVersion", "terminal", "terminalConflict"]);
  assert.equal(snapshot.schemaVersion, "root-broker.execution-proof.v2");
  assert.deepEqual(snapshot.binding, {
    rootSessionId,
    runId,
    asyncDir: `/tmp/${runId}`,
    sessionId: rootSessionId,
    pid: 43210,
    agentProfile: "executor",
  });
  assert.deepEqual(snapshot.authorization, { state: "verified" });
  assert.equal(snapshot.terminal.observedAt, 1_700_000_000_000);
  assert.equal(snapshot.terminal.outcome, "succeeded");
  assert.match(snapshot.terminal.proofId, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.terminal.proof, observedProof(runId));
  assert.equal(snapshot.terminalConflict, false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.binding), true);
  assert.equal(Object.isFrozen(snapshot.terminal), true);
  assert.equal(Object.isFrozen(snapshot.terminal.proof), true);
  assert.deepEqual(snapshot.capabilities, ["acceptance.submit", "root.subscribe"]);
  for (const forbidden of ["removeWorktree", "deleteBranch", "cleanupGit", "releaseWorkspace"]) {
    assert.equal(Object.hasOwn(snapshot, forbidden), false);
    assert.equal(typeof broker[forbidden], "undefined");
  }
});

test("Root broker canonical settlement reader accepts the upstream writer shape only for a verified Goal-owned run", async (t) => {
  const rootSessionId = "root-async-proof-recovery";
  const runId = "executor-async-proof-recovery";
  const asyncDir = mkdtempSync(join(tmpdir(), "root-broker-terminal-"));
  const event = { ...startedEvent(rootSessionId, runId), asyncDir };
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} }, captureProcessBirthIdentity: async () => "birth-async-proof-recovery", writeGrant: async () => join(asyncDir, "grant") });
  t.after(async () => { await broker.closeRootSession().catch(() => undefined); await rm(asyncDir, { recursive: true, force: true }); });
  const authority = { ...goalAuthority(rootSessionId, runId), asyncDir };
  await authorize(broker, event, authority); await broker.observeStarted(event);
  const terminal = observedProof(runId);
  // Real writer fixture: it writes the native proof (no session/path/agent/pid)
  // and currently leaves its mode umask-derived rather than forcing 0600.
  upstreamWriteAtomicJsonFixture(join(asyncDir, "process-terminal.json"), terminal);
  chmodSync(join(asyncDir, "process-terminal.json"), 0o644);
  const recovered = await broker.inspectExecutorProofAsync(runId);
  assert.deepEqual(Object.keys(recovered).sort(), ["authorization", "binding", "capabilities", "schemaVersion", "terminal", "terminalConflict"]);
  assert.deepEqual(recovered.authorization, { state: "verified" });
  assert.equal(recovered.terminal.outcome, "succeeded");

  for (const [label, value, mode] of [["pending", { ...terminal, state: "pending" }, 0o600], ["foreign", { ...terminal, runId: "foreign-run" }, 0o600], ["malformed", { runId }, 0o600], ["group-writable", terminal, 0o660], ["world-writable", terminal, 0o666]]) {
    const isolated = new RootBrokerServer({ rootSessionId: `${rootSessionId}-${label}`, lifecycleSessionId: `${rootSessionId}-${label}`, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} }, captureProcessBirthIdentity: async () => "birth", writeGrant: async () => join(asyncDir, "grant") });
    const isolatedEvent = { ...event, sessionId: `${rootSessionId}-${label}` };
    await authorize(isolated, isolatedEvent, { ...authority, sessionId: isolatedEvent.sessionId }); await isolated.observeStarted(isolatedEvent);
    writeFileSync(join(asyncDir, "process-terminal.json"), JSON.stringify(value), { mode }); chmodSync(join(asyncDir, "process-terminal.json"), mode);
    assert.equal((await isolated.inspectExecutorProofAsync(runId)).terminal, null, label);
    isolated.terminalProofs.set(runId, terminal); await isolated.closeRootSession().catch(() => undefined);
  }
  writeFileSync(join(asyncDir, "process-terminal.json"), JSON.stringify(terminal), { mode: 0o600 }); chmodSync(join(asyncDir, "process-terminal.json"), 0o600);
  linkSync(join(asyncDir, "process-terminal.json"), join(asyncDir, "terminal-hardlink.json"));
  rmSync(join(asyncDir, "process-terminal.json"));
  linkSync(join(asyncDir, "terminal-hardlink.json"), join(asyncDir, "process-terminal.json"));
  const hardlinkBroker = new RootBrokerServer({ rootSessionId: "root-hardlink", lifecycleSessionId: "root-hardlink", upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} }, captureProcessBirthIdentity: async () => "birth", writeGrant: async () => join(asyncDir, "grant") });
  const hardlinkEvent = { ...event, sessionId: "root-hardlink" }; await authorize(hardlinkBroker, hardlinkEvent, { ...authority, sessionId: "root-hardlink" }); await hardlinkBroker.observeStarted(hardlinkEvent);
  assert.equal((await hardlinkBroker.inspectExecutorProofAsync(runId)).terminal, null, "hardlink"); hardlinkBroker.terminalProofs.set(runId, terminal); await hardlinkBroker.closeRootSession().catch(() => undefined);
  rmSync(join(asyncDir, "process-terminal.json")); symlinkSync(join(asyncDir, "terminal-hardlink.json"), join(asyncDir, "process-terminal.json"));
  const symlinkBroker = new RootBrokerServer({ rootSessionId: "root-symlink", lifecycleSessionId: "root-symlink", upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} }, captureProcessBirthIdentity: async () => "birth", writeGrant: async () => join(asyncDir, "grant") });
  const symlinkEvent = { ...event, sessionId: "root-symlink" }; await authorize(symlinkBroker, symlinkEvent, { ...authority, sessionId: "root-symlink" }); await symlinkBroker.observeStarted(symlinkEvent);
  assert.equal((await symlinkBroker.inspectExecutorProofAsync(runId)).terminal, null, "symlink"); symlinkBroker.terminalProofs.set(runId, terminal); await symlinkBroker.closeRootSession().catch(() => undefined);

  rmSync(join(asyncDir, "process-terminal.json")); linkSync(join(asyncDir, "terminal-hardlink.json"), join(asyncDir, "process-terminal.json"));
  const ownerMismatch = new RootBrokerServer({ rootSessionId: "root-owner", lifecycleSessionId: "root-owner", upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} }, captureProcessBirthIdentity: async () => "birth", writeGrant: async () => join(asyncDir, "grant"), lstat: (file) => ({ ...lstatSync(file), uid: process.getuid() + 1 }) });
  const ownerEvent = { ...event, sessionId: "root-owner" }; await authorize(ownerMismatch, ownerEvent, { ...authority, sessionId: "root-owner" }); await ownerMismatch.observeStarted(ownerEvent);
  assert.equal((await ownerMismatch.inspectExecutorProofAsync(runId)).terminal, null, "owner mismatch"); ownerMismatch.terminalProofs.set(runId, terminal); await ownerMismatch.closeRootSession().catch(() => undefined);

  const facade = new RootBrokerServer({ rootSessionId: "root-facade", lifecycleSessionId: "root-facade", upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  facade.registerFacadeRun({ ...event, sessionId: "root-facade", agent: "executor", kind: "executor" });
  assert.equal(await facade.inspectExecutorProofAsync(runId), null, "facade-only run has no settlement proof");
});

test("Root broker lifecycle readers accept one upstream artifact through the same proof facts", async (t) => {
  const runId = "executor-lifecycle-core";
  const terminal = observedProof(runId);
  const snapshots = [];
  for (const lifecycle of ["settlement", "restart", "stop"]) {
    const rootSessionId = `root-lifecycle-${lifecycle}`;
    const asyncDir = mkdtempSync(join(tmpdir(), `root-broker-${lifecycle}-`));
    const event = { ...startedEvent(rootSessionId, runId), asyncDir };
    const authority = { ...goalAuthority(rootSessionId, runId), asyncDir };
    const broker = new RootBrokerServer({
      rootSessionId,
      lifecycleSessionId: rootSessionId,
      captureProcessBirthIdentity: async () => `birth-${lifecycle}`,
      writeGrant: async () => join(asyncDir, "grant"),
      terminalTimeoutMs: 100,
      artifactPollIntervalMs: 1,
      upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    });
    t.after(async () => { await broker.closeRootSession().catch(() => undefined); await rm(asyncDir, { recursive: true, force: true }); });
    await authorize(broker, event, authority);
    await broker.observeStarted(event);
    persistGoalAuthority(broker, authority);
    upstreamWriteAtomicJsonFixture(join(asyncDir, "process-terminal.json"), terminal);
    chmodSync(join(asyncDir, "process-terminal.json"), 0o644);

    const result = lifecycle === "settlement"
      ? await broker.inspectExecutionProofForSettlement(runId)
      : lifecycle === "restart"
        ? await broker.recoverExactTerminalProof(authority)
        : await broker.stopGoalOwnedRun(goalStopRequest(authority));
    assert.equal(result.state ?? result.authorization.state, lifecycle === "settlement" ? "verified" : "observed", lifecycle);
    snapshots.push(broker.inspectExecutionProof(runId));
  }
  assert.deepEqual(snapshots.map((snapshot) => snapshot.terminal.proofId), [snapshots[0].terminal.proofId, snapshots[0].terminal.proofId, snapshots[0].terminal.proofId]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.terminal.outcome), ["succeeded", "succeeded", "succeeded"]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.terminalConflict), [false, false, false]);
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
  await authorize(broker, startedEvent(rootSessionId, runId));
  await broker.observeStarted(startedEvent(rootSessionId, runId));

  assert.equal(broker.ownedRuns.get(runId)?.identityState, "unavailable");
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
  assert.equal(broker.inspectExecutionProof(runId), null, "facade runs are never execution-proof authority");
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
  await authorize(broker, startedEvent(rootSessionId, runId));
  await broker.observeStarted(startedEvent(rootSessionId, runId));
  const first = observedProof(runId);
  broker.observeTerminal(first);
  broker.observeTerminal({
    ...first,
    observedAt: first.observedAt + 1,
    instances: first.instances.map((instance) => ({ ...instance, closeObservedAt: instance.closeObservedAt + 1 })),
  });

  const snapshot = broker.inspectExecutionProof(runId);
  assert.equal(snapshot.terminalConflict, true);
  assert.equal(snapshot.terminal, null, "conflicting terminals never produce settlement proof");
});

test("Root broker promotes an exact started facade only from frozen Host authorization in both arrival orders", async () => {
  const rootSessionId = "root-facade-promotion";
  for (const order of ["started-first", "authorization-first"]) {
    const runId = `executor-${order}`;
    const broker = new RootBrokerServer({
      rootSessionId,
      lifecycleSessionId: rootSessionId,
      upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
      captureProcessBirthIdentity: async () => `birth-${runId}`,
      writeGrant: async () => `/tmp/${runId}-grant`,
    });
    const event = startedEvent(rootSessionId, runId);
    const authorization = createRunAuthorization({ kind: "coding", binding: { runId, asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid, agentProfile: event.agent }, goal: goalAuthority(rootSessionId, runId) && { ticketId: "d".repeat(64), goalId: "test-goal", taskId: "test-task", attempt: 1, contractHash: "c".repeat(64), workspaceId: "workspace-1", executionRevision: 1, expectedCriteria: ["criterion-1"] } });
    assert.equal(Object.isFrozen(authorization), true);
    if (order === "started-first") {
      await broker.observeStarted(event);
      broker.observeTerminal(observedProof(runId));
      assert.equal(broker.inspectFacadeTerminalProof(runId).state, "observed", order);
    }
    await broker.registerAuthorizedRun(authorization);
    if (order === "authorization-first") await broker.observeStarted(event);
    assert.equal(broker.facadeRuns.has(runId), false, order);
    assert.equal(broker.inspectExecutionProof(runId).terminal, null, `${order} pre-authorization facade terminal is not promoted`);
    assert.equal(broker.ownedRuns.get(runId)?.identityState, "verified", order);
    assert.deepEqual([...broker.ownedRuns.get(runId).capabilities].sort(), ["acceptance.submit", "root.subscribe"], order);
    broker.observeTerminal(observedProof(runId));
    assert.equal(broker.inspectExecutionProof(runId).terminal.outcome, "succeeded", order);
  }
});

test("Root broker fails closed rather than promoting facade identity or terminal facts that drift", async () => {
  const rootSessionId = "root-facade-promotion-conflict";
  const runId = "executor-conflict";
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} }, captureProcessBirthIdentity: async () => "birth", writeGrant: async () => "/tmp/conflict-grant" });
  const event = startedEvent(rootSessionId, runId);
  await broker.observeStarted(event);
  broker.observeTerminal(observedProof(runId));
  const authorization = createRunAuthorization({ kind: "coding", binding: { runId, asyncDir: "/tmp/other", sessionId: event.sessionId, pid: event.pid, agentProfile: event.agent }, goal: null });
  await assert.rejects(broker.registerAuthorizedRun(authorization), /Facade run identity conflicts/);
  assert.equal(broker.ownedRuns.has(runId), false);
  assert.equal(broker.principals.has(runId), false);
  assert.equal(broker.inspectFacadeTerminalProof(runId).state, "observed");
});

test("Root broker ignores untrusted started events and rejects binding drift", async () => {
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

  await authorize(broker, startedEvent("root-started", "executor-conflict"));
  await broker.observeStarted(startedEvent("root-started", "executor-conflict"));
  await broker.observeStarted({ ...startedEvent("root-started", "executor-conflict"), pid: 54321 });
  assert.equal(broker.ownedRuns.get("executor-conflict")?.identityState, "conflict");
  assert.deepEqual(captures, [43210]);
});

test("authoritative terminal events are delivered to the proof sink exactly once", async (t) => {
  const delivered = [];
  const broker = new RootBrokerServer({
    rootSessionId: "root-proof-sink",
    lifecycleSessionId: "root-proof-sink",
    captureProcessBirthIdentity: async () => "b".repeat(64),
    writeGrant: async () => "/tmp/proof-sink-grant",
    recordTerminalProof: (run, proof) => { delivered.push({ runId: run.runId, proof }); },
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  const event = startedEvent("root-proof-sink", "proof-sink-run");
  await broker.registerAuthorizedRun(createRunAuthorization({
    kind: "coding",
    binding: { runId: event.runId, asyncDir: event.asyncDir, sessionId: event.sessionId, pid: event.pid, agentProfile: event.agent },
    goal: null,
  }));
  await broker.observeStarted(event);
  const terminal = observedProof(event.runId);
  const authoritativeEvent = { ...terminal, sessionId: event.sessionId, pid: event.pid, asyncDir: event.asyncDir, agent: event.agent };
  broker.observeTerminal(authoritativeEvent);
  broker.observeTerminal(authoritativeEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].runId, event.runId);
  assert.deepEqual(delivered[0].proof, { runId: event.runId, ...terminal });
});

test("Root broker registry exposes only bound sync snapshots and the canonical settlement reader", async () => {
  assert.equal(typeof rootBrokerRegistry.inspectRootBrokerExecutionProof, "function");
  assert.equal(typeof rootBrokerRegistry.inspectExecutionProofForSettlement, "function");
  const pi = { events: {} };
  const broker = {
    rootSessionId: "root-registry-proof",
    inspectExecutionProof(runId) { assert.equal(runId, "run-1"); return null; },
    async inspectExecutionProofForSettlement(runId) { assert.equal(runId, "run-1"); return null; },
  };
  bindRootBroker(pi, broker);
  try {
    assert.deepEqual(rootBrokerRegistry.inspectRootBrokerExecutionProof(pi, "run-1"), null);
    assert.deepEqual(await rootBrokerRegistry.inspectExecutionProofForSettlement(pi, "run-1"), null);
  } finally {
    unbindRootBroker(pi, broker);
  }
  assert.throws(() => rootBrokerRegistry.inspectRootBrokerExecutionProof(pi, "run-1"), /unavailable/);
});

test("Goal executor coordinator resolves a session alias across ExtensionAPI wrappers and CAS-unbinds", () => {
  const goalPi = { events: {} };
  const subagentPi = { events: {} };
  const foreignPi = { events: {} };
  const coordinator = { prepareSpawn() {}, workspaceAllocated() {}, confirmSpawn() {}, bindSpawn() {} };
  bindGoalRunCoordinator(goalPi, coordinator);
  bindGoalRunCoordinatorSession(goalPi, "root-goal-alias", coordinator);
  assert.strictEqual(findGoalRunCoordinator(goalPi), coordinator, "same-wrapper lookup remains preferred");
  assert.strictEqual(findGoalRunCoordinator(subagentPi, "root-goal-alias"), coordinator);
  assert.equal(findGoalRunCoordinator(foreignPi, "root-other-session"), undefined);
  unbindGoalRunCoordinatorSession(goalPi, "root-goal-alias", { prepareSpawn() {}, workspaceAllocated() {}, confirmSpawn() {}, bindSpawn() {} });
  assert.strictEqual(findGoalRunCoordinator(subagentPi, "root-goal-alias"), coordinator, "foreign shutdown cannot delete the alias");
  unbindGoalRunCoordinatorSession(goalPi, "root-goal-alias", coordinator);
  assert.equal(findGoalRunCoordinator(goalPi), undefined, "correct shutdown clears the exact wrapper binding");
  assert.equal(findGoalRunCoordinator(subagentPi, "root-goal-alias"), undefined);
});

test("Goal executor coordinator session replacement does not resurrect the old generation", () => {
  const events = {};
  const goalPi = { events };
  const replacementPi = { events };
  const oldCoordinator = { prepareSpawn() {}, workspaceAllocated() {}, confirmSpawn() {}, bindSpawn() {} };
  const replacement = { prepareSpawn() {}, workspaceAllocated() {}, confirmSpawn() {}, bindSpawn() {} };
  bindGoalRunCoordinatorSession(goalPi, "root-goal-old", oldCoordinator);
  bindGoalRunCoordinatorSession(replacementPi, "root-goal-new", replacement);
  unbindGoalRunCoordinatorSession(goalPi, "root-goal-old", oldCoordinator);
  assert.strictEqual(findGoalRunCoordinator(goalPi), replacement);
  assert.strictEqual(findGoalRunCoordinator({ events: {} }, "root-goal-new"), replacement);
  assert.equal(findGoalRunCoordinator({ events: {} }, "root-goal-old"), undefined);
});

test("Root broker registry reload coexists with a legacy v1 WeakMap process slot", () => {
  const registryUrl = new URL("../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts", import.meta.url).href;
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

test("parseBrokerPush accepts recovery.event pushes with a recovery-event.v1 data payload", () => {
  // server 的 publishRecoveryEvent 推送 data=recovery-event.v1（含 schemaVersion 等 12 字段）；
  // client 侧 parseBrokerPush 曾强制 push.data 为空对象导致 BROKER_DISCONNECTED（R7 现场）。
  const push = parseBrokerPush({
    schemaVersion: "pi-root-subagent-broker-push.v1",
    rootSessionId: "root-1",
    callerRunId: "run-1",
    type: "recovery.event",
    data: {
      schemaVersion: "recovery-event.v1",
      rootSessionId: "root-1",
      recoveryIntentId: "ri-1",
      queueItemId: "qi-1",
      workspaceId: "ws-1",
      ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" },
      runId: "run-1",
      attempt: 1,
      reason: "integration recovery required",
      requiredAction: "preserve",
      generation: 0,
      delivery: { state: "delivered" },
    },
  });
  assert.equal(push.type, "recovery.event");
  assert.equal(push.data.schemaVersion, "recovery-event.v1");
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

// ===== P2-T3 owner authority over the real socket path =====

const SOCKET_TEST_TOKEN = "b".repeat(64);

function ownerEvent(rootSessionId, runId, pid) {
  return { runId, id: runId, agent: "executor", pid, asyncDir: `/tmp/${runId}`, sessionId: rootSessionId };
}

async function listenAt(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

async function flushIo(turns = 25) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("Root broker serves owner read, rebind and revoke over the real socket with caller-bound identity", async (t) => {
  const { AuthorityStore } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts");
  const rootSessionId = `root-owner-socket-${process.pid}-${Date.now()}`;
  const sourceRunId = "executor-owner-source";
  const resumedRunId = "executor-owner-resumed";
  const storeRoot = await mkdtemp(join(tmpdir(), "root-owner-socket-"));
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    authorityStore: new AuthorityStore({ root: storeRoot, rootSessionId }),
    captureProcessBirthIdentity: async (pid) => (pid === 43210 ? "birth-owner-source" : "birth-owner-resumed"),
    terminalTimeoutMs: 250,
    artifactPollIntervalMs: 5,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  const sourceGrant = brokerGrantPath(rootSessionId, sourceRunId);
  const resumedGrant = brokerGrantPath(rootSessionId, resumedRunId);
  let sourceClient;
  let resumedClient;
  t.after(async () => {
    sourceClient?.dispose();
    resumedClient?.dispose();
    await broker.closeRootSession();
    await rm(sourceGrant, { force: true });
    await rm(resumedGrant, { force: true });
    await rm(storeRoot, { recursive: true, force: true });
  });
  await broker.start();
  await authorize(broker, ownerEvent(rootSessionId, sourceRunId, 43210));
  await authorize(broker, ownerEvent(rootSessionId, resumedRunId, 43211));

  sourceClient = createRootBrokerClient({ rootSessionId, callerRunId: sourceRunId, timeoutMs: 2_000 });
  resumedClient = createRootBrokerClient({ rootSessionId, callerRunId: resumedRunId, timeoutMs: 2_000 });

  const sourceReceipt = await sourceClient.readOwnerReceipt(sourceRunId);
  assert.equal(sourceReceipt.runId, sourceRunId);
  assert.equal(sourceReceipt.ownerGeneration, 1);
  assert.equal(sourceReceipt.processBirth, "birth-owner-source");
  assert.equal(sourceReceipt.revision, 1);
  // A caller may only read its own owner receipt.
  await assert.rejects(resumedClient.readOwnerReceipt(sourceRunId), { code: "caller_unauthorized" });

  const resumedReceipt = await resumedClient.readOwnerReceipt(resumedRunId);
  // Only the current source owner may request a rebind.
  await assert.rejects(
    resumedClient.rebindRun({ sourceRunId, expectedGeneration: 1, expectedProcessBirth: "birth-owner-source", expectedRevision: sourceReceipt.revision, resumedRunId, expectedResumedRevision: resumedReceipt.revision }),
    { code: "caller_unauthorized" },
  );
  const rebound = await sourceClient.rebindRun({ sourceRunId, expectedGeneration: 1, expectedProcessBirth: "birth-owner-source", expectedRevision: sourceReceipt.revision, resumedRunId, expectedResumedRevision: resumedReceipt.revision });
  assert.equal(rebound.runId, resumedRunId);
  assert.equal(rebound.processBirth, "birth-owner-resumed");
  // The superseded source owner is fenced immediately.
  await assert.rejects(sourceClient.readOwnerReceipt(sourceRunId), { code: "unknown_run" });

  // Only the current owner itself may revoke.
  await assert.rejects(
    sourceClient.revokeOwner({ runId: resumedRunId, ownerGeneration: 1, processBirth: "birth-owner-resumed", expectedRevision: rebound.revision }),
    { code: "caller_unauthorized" },
  );
  assert.deepEqual(await resumedClient.revokeOwner({ runId: resumedRunId, ownerGeneration: 1, processBirth: "birth-owner-resumed", expectedRevision: rebound.revision }), { revoked: true });
  await assert.rejects(resumedClient.readOwnerReceipt(resumedRunId), { code: "unknown_run" });
  // Owner rebind/revocation fences authority only. Both broker-owned lifecycle
  // identities still require their own official terminal observations before
  // closeRootSession may release the socket server.
  broker.observeTerminal(observedProof(sourceRunId));
  broker.observeTerminal(observedProof(resumedRunId));
});

test("socket owner APIs fail closed with authority_store_unavailable when no authority store is injected", async (t) => {
  const rootSessionId = `root-owner-nostore-${process.pid}-${Date.now()}`;
  const runId = "executor-owner-nostore";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    captureProcessBirthIdentity: async () => "birth-owner-nostore",
    terminalTimeoutMs: 250,
    artifactPollIntervalMs: 5,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  const grantPath = brokerGrantPath(rootSessionId, runId);
  let client;
  t.after(async () => {
    client?.dispose();
    await broker.closeRootSession().catch(() => undefined);
    await rm(grantPath, { force: true });
  });
  await broker.start();
  await authorize(broker, startedEvent(rootSessionId, runId));
  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 2_000 });

  const error = await client.readOwnerReceipt(runId).then(
    () => { throw new Error("owner read must fail closed without an authority store"); },
    (failure) => failure,
  );
  assert.equal(error.code, "authority_store_unavailable");
  assert.match(error.message, /authority storage is unavailable/);
  assert.equal(error.message.includes("/"), false, "owner error must not leak private paths");
  await assert.rejects(
    client.rebindRun({ sourceRunId: runId, expectedGeneration: 1, expectedProcessBirth: "birth-owner-nostore", expectedRevision: 1, resumedRunId: "executor-owner-other", expectedResumedRevision: 1 }),
    { code: "authority_store_unavailable" },
  );
  await assert.rejects(
    client.revokeOwner({ runId, ownerGeneration: 1, processBirth: "birth-owner-nostore", expectedRevision: 1 }),
    { code: "authority_store_unavailable" },
  );
  broker.observeTerminal(observedProof(runId));
});

test("socket owner APIs reject a legacy authority layout with the stable error and no path leak", async (t) => {
  const { AuthorityStore } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts");
  const rootSessionId = `root-owner-legacy-${process.pid}-${Date.now()}`;
  const runId = "executor-owner-legacy";
  const storeRoot = await mkdtemp(join(tmpdir(), "root-owner-legacy-"));
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    authorityStore: new AuthorityStore({ root: storeRoot, rootSessionId }),
    captureProcessBirthIdentity: async () => "birth-owner-legacy",
    terminalTimeoutMs: 250,
    artifactPollIntervalMs: 5,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  const grantPath = brokerGrantPath(rootSessionId, runId);
  let client;
  t.after(async () => {
    client?.dispose();
    await broker.closeRootSession().catch(() => undefined);
    await rm(grantPath, { force: true });
    await rm(storeRoot, { recursive: true, force: true });
  });
  await broker.start();
  await authorize(broker, startedEvent(rootSessionId, runId));
  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 2_000 });

  // A legacy per-run owner file appears under the authority root: every owner
  // operation must fail closed with the stable layout error and preserve the
  // evidence instead of silently treating the root as an empty index.
  const legacyBytes = JSON.stringify({ runId: "run-someone", pid: 999 });
  await writeFile(join(storeRoot, "owner-run-someone.json"), legacyBytes, { mode: 0o600 });
  const error = await client.readOwnerReceipt(runId).then(
    () => { throw new Error("owner read must fail closed on a legacy layout"); },
    (failure) => failure,
  );
  assert.equal(error.code, "unsupported_layout");
  assert.equal(error.message, "unsupported_layout");
  assert.equal(error.message.includes("/"), false, "layout error must not leak the store root");
  // New registrations also fail closed while the legacy evidence stays intact.
  await assert.rejects(authorize(broker, startedEvent(rootSessionId, "executor-owner-legacy-2")), { code: "unsupported_layout" });
  assert.equal(await readFile(join(storeRoot, "owner-run-someone.json"), "utf8"), legacyBytes);
  broker.observeTerminal(observedProof(runId));
});

test("owner RPCs enforce the dedicated 5s deadline while generic requests keep the 10s default", async (t) => {
  const rootSessionId = `root-owner-deadline-${process.pid}-${Date.now()}`;
  const runId = "executor-owner-deadline";
  const socketPath = brokerSocketPath(rootSessionId);
  const grantPath = brokerGrantPath(rootSessionId, runId);
  const accepted = new Set();
  const hanging = createServer((socket) => { accepted.add(socket); socket.once("close", () => accepted.delete(socket)); });
  await listenAt(hanging, socketPath);
  await writeBrokerGrant({ schemaVersion: "pi-root-subagent-broker-grant.v2", rootSessionId, runId, callerToken: SOCKET_TEST_TOKEN, capabilities: ["root.subscribe"] });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: runId });
  t.after(async () => {
    client.dispose();
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => hanging.close(resolve));
    await rm(grantPath, { force: true });
    await rm(socketPath, { force: true });
  });

  const connections = Promise.all([once(hanging, "connection"), once(hanging, "connection"), once(hanging, "connection")]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const generic = { state: "pending", error: undefined };
  const ownerRead = { state: "pending", error: undefined };
  const ownerRebind = { state: "pending", error: undefined };
  const genericDone = client.ping().then(() => { generic.state = "resolved"; }, (error) => { generic.state = "rejected"; generic.error = error; });
  const readDone = client.readOwnerReceipt(runId).then(() => { ownerRead.state = "resolved"; }, (error) => { ownerRead.state = "rejected"; ownerRead.error = error; });
  const rebindDone = client.rebindRun({ sourceRunId: runId, expectedGeneration: 1, expectedProcessBirth: "birth", expectedRevision: 1, resumedRunId: "executor-owner-resumed-deadline", expectedResumedRevision: 1 }).then(() => { ownerRebind.state = "resolved"; }, (error) => { ownerRebind.state = "rejected"; ownerRebind.error = error; });
  await connections;
  await flushIo();

  // Neither the 5s owner deadline nor the 10s generic default has elapsed.
  t.mock.timers.tick(4_999);
  await flushIo();
  assert.equal(ownerRead.state, "pending");
  assert.equal(ownerRebind.state, "pending");
  assert.equal(generic.state, "pending");

  // The dedicated owner deadline is exactly 5s, not the 10s generic default.
  // Only the owner requests are awaited here: the generic request must still be
  // pending at mock time 5s, so awaiting it would deadlock the assertion.
  t.mock.timers.tick(1);
  await Promise.allSettled([readDone, rebindDone]);
  assert.equal(ownerRead.state, "rejected");
  assert.equal(ownerRead.error?.code, "BROKER_TIMEOUT");
  assert.equal(ownerRead.error?.message, "Root broker request timed out");
  assert.equal(ownerRebind.state, "rejected");
  assert.equal(ownerRebind.error?.code, "BROKER_TIMEOUT");
  assert.equal(generic.state, "pending");

  // The generic default remains 10s.
  t.mock.timers.tick(4_999);
  await flushIo();
  assert.equal(generic.state, "pending");
  t.mock.timers.tick(1);
  await genericDone;
  assert.equal(generic.state, "rejected");
  assert.equal(generic.error?.code, "BROKER_TIMEOUT");
});

test("coordinator registration challenge keeps its dedicated 5s deadline", async (t) => {
  const { challengeRootBroker } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts");
  const { captureProcessBirthIdentity } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts");
  const rootSessionId = `root-challenge-deadline-${process.pid}-${Date.now()}`;
  const socketPath = brokerSocketPath(rootSessionId);
  const accepted = new Set();
  const hanging = createServer((socket) => { accepted.add(socket); socket.once("close", () => accepted.delete(socket)); });
  await listenAt(hanging, socketPath);
  t.after(async () => {
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => hanging.close(resolve));
    await rm(socketPath, { force: true });
  });
  const registry = {
    protocol: "pi-root-subagent-broker-registry.v1",
    rootSessionId,
    endpoint: socketPath,
    pid: process.pid,
    processBirthIdentity: await captureProcessBirthIdentity(process.pid),
  };

  const connected = once(hanging, "connection");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const challenge = { state: "pending", error: undefined };
  const challengeDone = challengeRootBroker(registry, { nonce: SOCKET_TEST_TOKEN, repositoryId: "c".repeat(64), coordinatorInstanceId: "coordinator-deadline" }).then(
    () => { challenge.state = "resolved"; },
    (error) => { challenge.state = "rejected"; challenge.error = error; },
  );
  await connected;
  await flushIo();

  t.mock.timers.tick(4_999);
  await flushIo();
  assert.equal(challenge.state, "pending");
  t.mock.timers.tick(1);
  await challengeDone;
  assert.equal(challenge.state, "rejected");
  assert.equal(challenge.error?.code, "BROKER_TIMEOUT");
  assert.equal(challenge.error?.message, "Root Broker challenge timed out");
});
