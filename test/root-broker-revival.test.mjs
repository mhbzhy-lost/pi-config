import assert from "node:assert/strict";
import test from "node:test";

import { parseBrokerRequest } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

async function createRevivalFixture() {
  const callerToken = "a".repeat(64);
  const resumeCalls = [];
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream: {
      resume: async (params) => {
        resumeCalls.push(params);
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
