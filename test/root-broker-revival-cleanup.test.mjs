import assert from "node:assert/strict";
import test from "node:test";

import { parseBrokerRequest } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

test("close waits for an in-flight caller revival before disposing upstream", async (t) => {
  let resolveResume;
  let disposeCalls = 0;
  let closing;
  const resumed = {
    text: "Revived",
    details: {
      mode: "single",
      results: [],
      asyncId: "plan-runner-2",
      asyncDir: "/async/plan-runner-2",
    },
  };
  const resumeDeferred = new Promise((resolve) => { resolveResume = resolve; });
  const server = new RootBrokerServer({
    rootSessionId: "root-session-revival-cleanup-1",
    upstream: {
      resume: async () => await resumeDeferred,
      dispose: async () => { disposeCalls += 1; },
    },
    writeGrant: async (grant) => `/tmp/root-broker-revival-cleanup-${grant.runId}`,
    randomToken: () => "a".repeat(64),
  });
  t.after(async () => {
    resolveResume(resumed);
    await Promise.allSettled([...server.revivePromises.values()]);
    await closing?.catch(() => undefined);
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
    rootSessionId: "root-session-revival-cleanup-1",
    runId: "plan-runner-1",
    role: "plan-runner",
    asyncDir: "/async/plan-runner-1",
    sessionId: "root-session-revival-cleanup-1",
    pid: 101,
    birthIdentity: "plan-runner-1-birth",
    identityState: "verified",
  };
  server.ownedRuns.set(ownedRun.runId, ownedRun);
  server.acceptTerminalProof(ownedRun, {
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
  });
  await server.dispatch(parseBrokerRequest({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-followup-1",
    rootSessionId: "root-session-revival-cleanup-1",
    callerRunId: "plan-runner-1",
    callerToken: "a".repeat(64),
    method: "caller.followup",
    params: { wakeId: "plan-opened-1", reason: "plan-opened" },
  }), {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.revivePromises.size, 1);
  let closeSettled = false;
  closing = server.closeRootSession().finally(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(closeSettled, false);
  assert.equal(disposeCalls, 0);
  assert.equal(server.teardown.released, false);

  resolveResume(resumed);
  await Promise.allSettled([...server.revivePromises.values()]);
  await closing;

  assert.equal(disposeCalls, 1);
  assert.equal(server.teardown.released, true);
});
