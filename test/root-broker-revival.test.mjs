import assert from "node:assert/strict";
import test from "node:test";

import { parseBrokerRequest } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

async function createRevivalFixture({ resume } = {}) {
  const callerToken = "a".repeat(64);
  const revivedCallerToken = "b".repeat(64);
  const tokens = [callerToken, revivedCallerToken];
  const grants = [];
  const resumeCalls = [];
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream: {
      resume: async (params) => {
        resumeCalls.push(params);
        if (resume) return await resume(params);
        return {
          text: "Revived",
          details: {
            mode: "single",
            results: [],
            asyncId: "plan-runner-2",
            asyncDir: "/async/plan-runner-2",
          },
        };
      },
    },
    writeGrant: async (grant) => {
      grants.push(grant);
      return `/tmp/root-broker-revival-grant-${grant.runId}`;
    },
    randomToken: () => tokens.shift(),
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

  return { grants, ownedRun, proof, request, resumeCalls, server };
}

const revivedResult = {
  text: "Revived",
  details: {
    mode: "single",
    results: [],
    asyncId: "plan-runner-2",
    asyncDir: "/async/plan-runner-2",
  },
};

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
  const result = revivedResult;
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
  const result = revivedResult;
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

test("grants the revived actual plan-runner while retaining its stable logical alias", async () => {
  const { grants, ownedRun, proof, request, server } = await createRevivalFixture();

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(grants, [
    {
      schemaVersion: "pi-root-subagent-broker-grant.v1",
      rootSessionId: "root-session-1",
      runId: "plan-runner-1",
      callerToken: "a".repeat(64),
      role: "plan-runner",
    },
    {
      schemaVersion: "pi-root-subagent-broker-grant.v1",
      rootSessionId: "root-session-1",
      runId: "plan-runner-2",
      callerToken: "b".repeat(64),
      role: "plan-runner",
    },
  ]);
  assert.deepEqual(server.logicalCallers.get("plan-runner-1"), { activeRunId: "plan-runner-2", generation: 1 });
  assert.equal(server.callerAliases.get("plan-runner-1"), "plan-runner-1");
  assert.equal(server.callerAliases.get("plan-runner-2"), "plan-runner-1");
  assert.deepEqual(server.principals.get("plan-runner-2"), { role: "plan-runner", callerToken: "b".repeat(64) });
  assert.deepEqual([...server.callers.keys()], ["plan-runner-1"]);
});

test("closes and removes the old actual subscription when its alias activates", async () => {
  const { ownedRun, proof, request, server } = await createRevivalFixture();
  let destroyCalls = 0;
  const socket = {
    destroyed: false,
    destroy() {
      destroyCalls += 1;
      this.destroyed = true;
    },
  };
  server.subscriptions.set("plan-runner-1", new Set([socket]));

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(destroyCalls, 1);
  assert.equal(socket.destroyed, true);
  assert.equal(server.subscriptions.has("plan-runner-1"), false);
  assert.deepEqual(server.logicalCallers.get("plan-runner-1"), { activeRunId: "plan-runner-2", generation: 1 });
  assert.deepEqual(server.principals.get("plan-runner-2"), { role: "plan-runner", callerToken: "b".repeat(64) });
});

test("routes an active plan-runner alias follow-up to its stable logical state", async () => {
  const { ownedRun, proof, request, resumeCalls, server } = await createRevivalFixture();

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  const activeRequest = parseBrokerRequest({
    ...request,
    requestId: "request-followup-fresh-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    params: { wakeId: "plan-opened-next", reason: "plan-opened" },
  });

  const response = await server.dispatch(activeRequest, {});

  assert.deepEqual(response, {
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "request-followup-fresh-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-2",
    success: true,
    data: { accepted: true, wakeId: "plan-opened-next" },
  });
  assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), [{ wakeId: "plan-opened-next", reason: "plan-opened" }]);
  assert.equal(server.callerFollowUps.has("plan-runner-2"), false);
  assert.deepEqual(resumeCalls, expectedResume);
});

test("rejects an old actual plan-runner after its revived alias is active", async () => {
  const { ownedRun, proof, request, server } = await createRevivalFixture();

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  const staleRequest = parseBrokerRequest({
    ...request,
    requestId: "request-followup-stale-1",
    params: { wakeId: "plan-opened-stale-1", reason: "plan-opened" },
  });

  const response = await server.dispatch(staleRequest, {});

  assert.deepEqual(response, {
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "request-followup-stale-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    success: false,
    error: { code: "caller_stale", message: "Caller generation is stale" },
  });
  assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), []);
});
