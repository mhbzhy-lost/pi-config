import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { brokerGrantPath, readBrokerGrant } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createRootBrokerClient } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

function authorization(rootSessionId, runId, agentProfile, kind = "coding", goal = null) {
  return createRunAuthorization({
    kind,
    binding: { runId, asyncDir: `/tmp/${runId}`, sessionId: rootSessionId, pid: 43210, agentProfile },
    goal,
  });
}

function goalAuthority(runId) {
  return {
    ticketId: "a".repeat(64),
    goalId: "goal-capabilities",
    taskId: "task-proof",
    attempt: 1,
    contractHash: "b".repeat(64),
    workspaceId: `workspace-${runId}`,
    executionRevision: 1,
    expectedCriteria: ["proof"],
  };
}

function observedTerminal(rootSessionId, runId, agentProfile, asyncDir = `/tmp/${runId}`) {
  const observedAt = 1_700_000_000_000;
  const runnerProcessInstanceId = `${runId}-runner`;
  return {
    version: 1,
    runId,
    sessionId: rootSessionId,
    asyncDir,
    agent: agentProfile,
    pid: 43210,
    runnerProcessInstanceId,
    state: "observed",
    observedAt,
    instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
  };
}

test("untrusted facade lifecycle is observable but cannot acquire capabilities or settlement proof", async (t) => {
  const rootSessionId = `root-name-${process.pid}-${Date.now()}`;
  const runId = "untrusted-executor";
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  const subscriber = createRootBrokerClient({ rootSessionId, callerRunId: runId, requiredCapability: "root.subscribe" });
  const acceptance = createRootBrokerClient({ rootSessionId, callerRunId: runId, requiredCapability: "acceptance.submit" });
  t.after(async () => { subscriber.dispose(); acceptance.dispose(); await broker.closeRootSession().catch(() => undefined); await rm(brokerGrantPath(rootSessionId, runId), { force: true }); });
  await broker.start();
  await broker.observeStarted({ runId, id: runId, agent: "executor", pid: 43210, asyncDir: `/tmp/${runId}`, sessionId: rootSessionId });
  broker.observeTerminal(observedTerminal(rootSessionId, runId, "executor"));
  assert.equal(broker.principals.has(runId), false);
  assert.equal(broker.inspectFacadeTerminalProof(runId).state, "observed");
  assert.equal(broker.inspectExecutionProof(runId), null);
  assert.equal(await broker.inspectExecutorProofAsync(runId), null);
  await assert.rejects(subscriber.subscribe(() => {}), { code: "GRANT_NOT_READY" });
  await assert.rejects(acceptance.submitAcceptanceEvidence({}), { code: "GRANT_NOT_READY" });
  await assert.rejects(readBrokerGrant(rootSessionId, runId), { code: "ENOENT" });
});

test("deep-frozen Host Goal authorization binds the positive executor settlement proof", async (t) => {
  const rootSessionId = `root-profile-${process.pid}-${Date.now()}`;
  const runId = "custom-profile-run";
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, captureProcessBirthIdentity: async () => "birth", upstream: { async ping() { return { alive: true }; }, async stop() {}, async dispose() {} } });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: runId, requiredCapability: "root.subscribe" });
  t.after(async () => { client.dispose(); await broker.closeRootSession(); });
  await broker.start();
  const hostAuthorization = authorization(rootSessionId, runId, "package.coder-alpha", "coding", goalAuthority(runId));
  assert.equal(Object.isFrozen(hostAuthorization), true);
  assert.equal(Object.isFrozen(hostAuthorization.binding), true);
  assert.equal(Object.isFrozen(hostAuthorization.goal), true);
  assert.equal(Object.isFrozen(hostAuthorization.goal.expectedCriteria), true);
  await broker.registerAuthorizedRun(hostAuthorization);
  assert.deepEqual((await readBrokerGrant(rootSessionId, runId)).capabilities, ["acceptance.submit", "root.subscribe"]);
  assert.deepEqual(await client.ping(), { alive: true });
  broker.observeTerminal(observedTerminal(rootSessionId, runId, "package.coder-alpha"));
  const proof = broker.inspectExecutionProof(runId);
  assert.equal(proof.authorization.state, "verified");
  assert.equal(proof.binding.agentProfile, "package.coder-alpha");
  assert.equal(proof.terminal.outcome, "succeeded");
  assert.equal(proof.terminal.proof.runId, runId);
});

test("generic authorization tracks terminals but cannot acquire a broker grant", async (t) => {
  const rootSessionId = `root-generic-${process.pid}-${Date.now()}`;
  const runId = "generic-run";
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  t.after(async () => { await broker.closeRootSession().catch(() => undefined); });
  await broker.registerAuthorizedRun(authorization(rootSessionId, runId, "any-profile", "generic"));
  assert.equal(broker.principals.has(runId), false);
  assert.equal(broker.inspectExecutionProof(runId), null);
  assert.equal(broker.inspectFacadeTerminalProof(runId).state, "pending");
  await assert.rejects(readBrokerGrant(rootSessionId, runId), { code: "ENOENT" });
});

test("persisted lifecycle binding grants only within the exact root and lifecycle namespaces", async (t) => {
  const rootSessionId = `root-persisted-${process.pid}-${Date.now()}`;
  const lifecycleSessionId = "/tmp/pi sessions/persisted-root.jsonl";
  const runId = "persisted-child";
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId, captureProcessBirthIdentity: async () => "birth", upstream: { async ping() { return { alive: true }; }, async stop() {}, async dispose() {} } });
  const client = createRootBrokerClient({ rootSessionId, callerRunId: runId, requiredCapability: "root.subscribe" });
  t.after(async () => { client.dispose(); broker.observeTerminal({ ...observedTerminal(lifecycleSessionId, runId, "coder-alpha"), sessionId: lifecycleSessionId }); await broker.closeRootSession(); });
  await broker.start();
  const authorized = createRunAuthorization({ kind: "coding", binding: { runId, asyncDir: `/tmp/${runId}`, sessionId: lifecycleSessionId, pid: 43210, agentProfile: "coder-alpha" }, goal: null });
  await broker.registerAuthorizedRun(authorized);
  assert.deepEqual(await client.ping(), { alive: true });
  assert.equal(broker.inspectExecutionProof(runId).binding.sessionId, lifecycleSessionId);
  assert.equal(broker.inspectExecutionProof(runId).binding.rootSessionId, rootSessionId);
  assert.deepEqual((await readBrokerGrant(rootSessionId, runId)).capabilities, ["root.subscribe"]);
  await assert.rejects(broker.registerAuthorizedRun(createRunAuthorization({ kind: "coding", binding: { ...authorized.binding, sessionId: "/tmp/foreign.jsonl" }, goal: null })), /session/);
  const foreignClient = createRootBrokerClient({ rootSessionId: `${rootSessionId}-foreign`, callerRunId: runId, requiredCapability: "root.subscribe" });
  try { await assert.rejects(foreignClient.ping()); } finally { foreignClient.dispose(); }
});

test("non-Goal rename canary keeps typed profiles and generic calls isolated from metadata", async (t) => {
  const rootSessionId = `root-rename-${process.pid}-${Date.now()}`;
  const lifecycleSessionId = "/tmp/pi sessions/rename-canary.jsonl";
  const alphaRun = "coder-alpha-run";
  const betaRun = "coder-beta-run";
  const genericRun = "coder-alpha-generic";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId,
    captureProcessBirthIdentity: async () => "birth",
    upstream: { async ping() { return { alive: true }; }, async stop() {}, async dispose() {} },
  });
  const alphaClient = createRootBrokerClient({ rootSessionId, callerRunId: alphaRun, requiredCapability: "root.subscribe" });
  const betaClient = createRootBrokerClient({ rootSessionId, callerRunId: betaRun, requiredCapability: "root.subscribe" });
  t.after(async () => {
    alphaClient.dispose();
    betaClient.dispose();
    await broker.closeRootSession().catch(() => undefined);
  });

  await broker.start();
  for (const [runId, agentProfile] of [[alphaRun, "coder-alpha"], [betaRun, "coder-beta"]]) {
    await broker.registerAuthorizedRun(createRunAuthorization({
      kind: "coding",
      binding: { runId, asyncDir: `/tmp/${runId}`, sessionId: lifecycleSessionId, pid: 43210, agentProfile },
      goal: null,
    }));
  }
  await broker.registerAuthorizedRun(createRunAuthorization({
    kind: "generic",
    binding: { runId: genericRun, asyncDir: `/tmp/${genericRun}`, sessionId: lifecycleSessionId, pid: 43210, agentProfile: "coder-alpha" },
    goal: null,
  }));
  await broker.observeStarted({ runId: alphaRun, id: alphaRun, agent: "coder-alpha", pid: 43210, asyncDir: `/tmp/${alphaRun}`, sessionId: lifecycleSessionId });
  await broker.observeStarted({ runId: betaRun, id: betaRun, agent: "coder-beta", pid: 43210, asyncDir: `/tmp/${betaRun}`, sessionId: lifecycleSessionId });
  await broker.observeStarted({ runId: "untrusted-executor", id: "untrusted-executor", agent: "executor", pid: 43210, asyncDir: "/tmp/untrusted-executor", sessionId: lifecycleSessionId });

  assert.deepEqual(await alphaClient.ping(), { alive: true });
  assert.deepEqual(await betaClient.ping(), { alive: true });
  await assert.rejects(readBrokerGrant(rootSessionId, genericRun), { code: "ENOENT" });
  await assert.rejects(readBrokerGrant(rootSessionId, "untrusted-executor"), { code: "ENOENT" });
  assert.throws(() => createRunAuthorization({
    kind: "generic",
    binding: { runId: "forged-frontmatter", asyncDir: "/tmp/forged-frontmatter", sessionId: lifecycleSessionId, pid: 43210, agentProfile: "coder-beta" },
    goal: null,
    frontmatter: { capabilities: ["acceptance.submit"] },
  }), /unknown|exact/i);
  for (const [runId, agentProfile] of [[alphaRun, "coder-alpha"], [betaRun, "coder-beta"], [genericRun, "coder-alpha"]]) {
    broker.observeTerminal(observedTerminal(lifecycleSessionId, runId, agentProfile));
  }
});
