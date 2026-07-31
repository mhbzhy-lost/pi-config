import assert from "node:assert/strict";
import test from "node:test";

import { parseBrokerRequest } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

async function withDeadline(promise, label, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observedTerminal(runId) {
  const observedAt = Date.now();
  const runnerProcessInstanceId = `${runId}-instance`;
  return {
    runId,
    version: 1,
    runnerProcessInstanceId,
    state: "observed",
    observedAt,
    instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
  };
}

test("close waits for an in-flight caller revival before disposing upstream", async (t) => {
  let resolveResume;
  let disposeCalls = 0;
  let closing;
  const rootSessionId = "root-session-revival-cleanup-1";
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
    rootSessionId,
    upstream: {
      resume: async () => await resumeDeferred,
      dispose: async () => { disposeCalls += 1; },
    },
    writeGrant: async (grant) => `/tmp/root-broker-revival-cleanup-${grant.runId}`,
    randomToken: () => "a".repeat(64),
    captureProcessBirthIdentity: async () => "plan-runner-2-birth",
    terminalTimeoutMs: 500,
  });
  const completeRevivedFacts = async () => {
    resolveResume(resumed);
    await server.observeStarted({ id: "plan-runner-2", agent: "plan-runner", asyncDir: "/async/plan-runner-2", sessionId: rootSessionId, pid: 202 });
    const revivedRun = server.ownedRuns.get("plan-runner-2");
    assert.ok(revivedRun, "revived Plan Runner ownership");
    if (!server.terminalProofs.has(revivedRun.runId)) server.acceptTerminalProof(revivedRun, observedTerminal(revivedRun.runId));
  };
  t.after(async () => {
    await completeRevivedFacts();
    await withDeadline(Promise.allSettled([...server.revivePromises.values()]), "revival cleanup");
    if (closing) await withDeadline(closing.catch(() => undefined), "Root close cleanup");
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
    rootSessionId,
    runId: "plan-runner-1",
    role: "plan-runner",
    asyncDir: "/async/plan-runner-1",
    sessionId: rootSessionId,
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
    rootSessionId,
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

  await completeRevivedFacts();
  await withDeadline(Promise.allSettled([...server.revivePromises.values()]), "in-flight revival");
  await withDeadline(closing, "Root close");

  assert.equal(disposeCalls, 1);
  assert.equal(server.teardown.released, true);
});
