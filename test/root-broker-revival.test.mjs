import assert from "node:assert/strict";
import test from "node:test";

import { parseBrokerRequest } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

async function createRevivalFixture({ resume } = {}) {
  const callerToken = "a".repeat(64);
  const resumeCalls = [];
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream: {
      resume: async (params) => {
        resumeCalls.push(params);
        if (resume) return await resume(params);
        return { runId: "plan-runner-2", asyncDir: "/async/plan-runner-2" };
      },
    },
    writeGrant: async () => "/tmp/root-broker-revival-grant",
    randomToken: () => callerToken,
  });
  await server.grantCaller({
    callerRunId: "plan-runner-1",
    planId: "plan-1",
    cwd: "/workspace",
    originRoot: "/origin",
    stateRoot: "/state",
    role: "plan-runner",
  });

  const ownedRun = {
    rootSessionId: "root-session-1",
    runId: "plan-runner-1",
    role: "plan-runner",
    asyncDir: "/async/plan-runner-1",
    sessionId: "root-session-1",
    pid: 101,
    birthIdentity: "plan-runner-1-birth",
    identityState: "verified",
  };
  server.ownedRuns.set(ownedRun.runId, ownedRun);

  const request = parseBrokerRequest({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-followup-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    callerToken,
    method: "caller.followup",
    params: { wakeId: "plan-opened-1", reason: "plan-opened" },
  });
  const proof = {
    runId: "plan-runner-1",
    version: 1,
    runnerProcessInstanceId: "plan-runner-1-instance",
    state: "observed",
    observedAt: Date.now(),
    instances: [{
      processInstanceId: "plan-runner-1-instance",
      kind: "runner",
      closeObservedAt: Date.now(),
      exitCode: 0,
      signal: null,
    }],
  };

  return { ownedRun, proof, request, resumeCalls, server };
}

const expectedResume = [{
  id: "plan-runner-1",
  message: "A durable Root broker wake is pending.",
}];

test("revives a pending plan-runner wake only after its observed terminal proof", async () => {
  const { ownedRun, proof, request, resumeCalls, server } = await createRevivalFixture();

  await server.dispatch(request, {});
  assert.deepEqual(resumeCalls, []);

  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();

  assert.deepEqual(resumeCalls, expectedResume);
});

test("revives when a pending plan-runner wake follows its observed terminal proof", async () => {
  const { ownedRun, proof, request, resumeCalls, server } = await createRevivalFixture();

  server.acceptTerminalProof(ownedRun, proof);
  await Promise.resolve();
  assert.deepEqual(resumeCalls, []);

  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
});

test("coalesces concurrent pending wakes for the same plan-runner revival", async (t) => {
  let resolveResume;
  const result = { runId: "plan-runner-2", asyncDir: "/async/plan-runner-2" };
  const resumeDeferred = new Promise((resolve) => { resolveResume = resolve; });
  t.after(() => resolveResume(result));

  const { ownedRun, proof, request, resumeCalls, server } = await createRevivalFixture({
    resume: () => resumeDeferred,
  });
  const secondRequest = parseBrokerRequest({
    ...request,
    requestId: "request-followup-2",
  });

  server.acceptTerminalProof(ownedRun, proof);
  const responses = await Promise.all([
    server.dispatch(request, {}),
    server.dispatch(secondRequest, {}),
  ]);
  assert.deepEqual(responses.map((response) => response.data), [
    { accepted: true, wakeId: "plan-opened-1" },
    { accepted: true, wakeId: "plan-opened-1" },
  ]);
  await Promise.resolve();

  assert.deepEqual(resumeCalls, expectedResume);
  assert.equal(server.revivePromises.size, 1);

  resolveResume(result);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.revivePromises.size, 0);
  assert.deepEqual(server.callerFollowUps.get(ownedRun.runId), []);
  assert.deepEqual(server.reviveResults.get(ownedRun.runId), result);
});

test("releases the revival single-flight after resume rejects", async () => {
  const { ownedRun, proof, request, resumeCalls, server } = await createRevivalFixture({
    resume: async () => { throw new Error("resume unavailable"); },
  });

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
  assert.deepEqual(server.callerFollowUps.get(ownedRun.runId), [{ wakeId: "plan-opened-1", reason: "plan-opened" }]);
  assert.equal(server.revivePromises.size, 0);
});

test("retries a pending wake after the previous revival rejects", async () => {
  const result = { runId: "plan-runner-2", asyncDir: "/async/plan-runner-2" };
  let attempts = 0;
  const { ownedRun, proof, request, resumeCalls, server } = await createRevivalFixture({
    resume: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("resume unavailable");
      return result;
    },
  });
  const retryRequest = parseBrokerRequest({
    ...request,
    requestId: "request-followup-2",
  });

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));
  await server.dispatch(retryRequest, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, [...expectedResume, ...expectedResume]);
  assert.deepEqual(server.callerFollowUps.get(ownedRun.runId), []);
  assert.deepEqual(server.reviveResults.get(ownedRun.runId), result);
});
