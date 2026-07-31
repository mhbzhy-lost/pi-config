import assert from "node:assert/strict";
import test from "node:test";

import { BROKER_METHODS, parseBrokerPush, parseBrokerRequest } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

async function createRevivalFixture({ preparePlanRunnerRecovery, recordRevivalDiagnostic, resume, spawn, writeGrant } = {}) {
  const callerToken = "a".repeat(64);
  const revivedCallerToken = "b".repeat(64);
  const executorToken = "c".repeat(64);
  const tokens = [callerToken, revivedCallerToken, executorToken];
  const grants = [];
  const resumeCalls = [];
  const upstream = {
    ...(preparePlanRunnerRecovery ? {
      preparePlanRunnerRecovery: async (params) => await preparePlanRunnerRecovery(params),
    } : {}),
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
    spawn: async (params) => {
      if (spawn) return await spawn(params);
      return { runId: "executor-1", asyncDir: "/async/executor-1" };
    },
  };
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream,
    writeGrant: async (grant) => {
      grants.push(grant);
      if (writeGrant) return await writeGrant(grant);
      return `/tmp/root-broker-revival-grant-${grant.runId}`;
    },
    randomToken: () => tokens.shift(),
    recordRevivalDiagnostic,
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

function assertRevivalDiagnostic(entry, { activeRunId, generation, logicalCallerRunId = "plan-runner-1", wakeId } = {}) {
  assert.equal(entry.customType, "pi-root-broker-revival-v1");
  assert.equal(entry.data.schemaVersion, "pi-root-broker-revival-diagnostic.v1");
  assert.equal(entry.data.rootSessionId, "root-session-1");
  assert.equal(entry.data.logicalCallerRunId, logicalCallerRunId);
  assert.equal(entry.data.activeRunId, activeRunId);
  assert.equal(entry.data.generation, generation);
  assert.equal(Number.isFinite(entry.data.observedAt), true);
  if (wakeId !== undefined) assert.equal(entry.data.wakeId, wakeId);
}

async function createActiveRevivedAliasFixture() {
  const fixture = await createRevivalFixture();
  const { ownedRun, proof, request, server } = fixture;

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  return fixture;
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

function queuedLifecyclePush({ dispatchId, runId }) {
  return parseBrokerPush({
    schemaVersion: "pi-root-subagent-broker-push.v1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    type: "execution.completed",
    data: {
      dispatchId,
      runId,
      asyncDir: `/async/${runId}`,
      cwd: "/workspace",
      sessionId: "root-session-1",
      state: "complete",
    },
  });
}

async function createLiveLifecycleFixture({ recordRevivalDiagnostic, resume } = {}) {
  let executorNumber = 0;
  const fixture = await createRevivalFixture({
    recordRevivalDiagnostic,
    resume,
    spawn: async () => {
      executorNumber += 1;
      return { runId: `executor-live-${executorNumber}`, asyncDir: `/async/executor-live-${executorNumber}` };
    },
  });
  const { request, server } = fixture;
  const writes = [];
  const socket = {
    destroyed: false,
    write(frame) { writes.push(parseBrokerPush(JSON.parse(frame))); return true; },
    once() {},
  };
  server.subscriptions.set("plan-runner-1", new Set([socket]));

  async function forwardCompletion(spawnKey, state = "complete") {
    const spawnResponse = await server.dispatch(parseBrokerRequest({
      ...request,
      requestId: `request-spawn-${spawnKey}`,
      method: "spawn",
      params: { agent: "executor", task: "run", spawnKey },
    }), {});
    assert.equal(spawnResponse.success, true);
    const entry = server.spawnLedger.get(`plan-1\u0000${spawnKey}`);
    assert.ok(entry?.binding, "spawn must create a bound spawnLedger entry");
    server.lifecycle({
      runId: entry.binding.runId,
      agent: "executor",
      asyncDir: entry.binding.asyncDir,
      cwd: "/workspace",
      sessionId: "root-session-1",
      state,
    }, "execution.completed", entry);
    return entry;
  }

  return { ...fixture, forwardCompletion, socket, writes };
}

const supervisorMessage = {
  customType: "subagent_supervisor_request",
  content: "Need approval",
  details: {
    id: "attention-1",
    runId: "executor-1",
    reason: "need_decision",
    expectsReply: true,
    agent: "executor",
    childIndex: 0,
  },
};

const supervisorContext = { source: "revival-test" };

const expectedPendingSupervisorData = {
  requestId: "attention-1",
  executorRunId: "executor-1",
  reason: "need_decision",
  expectsReply: true,
  agent: "executor",
  childIndex: 0,
  content: "Need approval",
};

async function createRevivedSupervisorFixture({ executeSupervisor } = {}) {
  const fixture = await createRevivalFixture();
  const { ownedRun, proof, request, server } = fixture;

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  const spawnResponse = await server.dispatch(parseBrokerRequest({
    ...request,
    requestId: "request-spawn-supervisor-revival-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "spawn",
    params: { agent: "executor", task: "run", spawnKey: "supervisor-revival-1" },
  }), {});
  assert.equal(spawnResponse.success, true);
  server.upstream.executeSupervisor = executeSupervisor;
  await server.routeSupervisorRequest(supervisorMessage, supervisorContext);

  return fixture;
}

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

test("wakeCaller accepts one durable Attention reply wake only after official proof and coalesces revival", async () => {
  let resolveResume;
  const resumeDeferred = new Promise((resolve) => { resolveResume = resolve; });
  const { ownedRun, proof, resumeCalls, server } = await createRevivalFixture({ resume: () => resumeDeferred });
  const intent = { wakeId: "attention-reply-request-1", reason: "attention-reply" };

  assert.equal(typeof server.wakeCaller, "function", "RootBrokerServer must expose the Root-only Attention wake API");
  assert.deepEqual(await server.wakeCaller("plan-runner-1", intent), { accepted: true, wakeId: intent.wakeId });
  assert.deepEqual(await server.wakeCaller("plan-runner-1", intent), { accepted: true, wakeId: intent.wakeId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, []);
  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, expectedResume);
  assert.equal(server.revivePromises.size, 1);
  resolveResume(revivedResult);
  await new Promise((resolve) => setImmediate(resolve));
});

test("assigns distinct queued Attention wakes to consecutive revived generations", async () => {
  let nextGeneration = 2;
  const { ownedRun, proof, resumeCalls, server } = await createRevivalFixture({
    resume: async () => ({
      text: "Revived",
      details: {
        mode: "single",
        results: [],
        asyncId: `plan-runner-${nextGeneration++}`,
        asyncDir: `/async/plan-runner-${nextGeneration - 1}`,
      },
    }),
  });
  server.upstream.ping = async () => ({});
  const firstWake = { wakeId: "attention-reply-attention-1", reason: "attention-reply" };
  const secondWake = { wakeId: "attention-reply-attention-2", reason: "attention-reply" };

  assert.deepEqual(await server.wakeCaller("plan-runner-1", firstWake), { accepted: true, wakeId: firstWake.wakeId });
  assert.deepEqual(await server.wakeCaller("plan-runner-1", secondWake), { accepted: true, wakeId: secondWake.wakeId });
  assert.deepEqual(resumeCalls, []);

  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
  assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), [secondWake]);
  const generationTwoPing = await server.dispatch(parseBrokerRequest({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-ping-generation-2",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "ping",
    params: {},
  }), {});
  assert.deepEqual(generationTwoPing.data.callerWake, firstWake);
  assert.deepEqual(await server.wakeCaller("plan-runner-1", firstWake), { accepted: true, wakeId: firstWake.wakeId });
  assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), [secondWake], "an exact retry of the generation-bound wake must not enqueue another generation");

  const generationTwoRun = { ...ownedRun, runId: "plan-runner-2", asyncDir: "/async/plan-runner-2", pid: 102, birthIdentity: "plan-runner-2-birth" };
  server.ownedRuns.set(generationTwoRun.runId, generationTwoRun);
  server.acceptTerminalProof(generationTwoRun, { ...proof, runId: "plan-runner-2" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, [...expectedResume, { id: "plan-runner-2", message: "A durable Root broker wake is pending." }]);
  const generationThreePing = await server.dispatch(parseBrokerRequest({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-ping-generation-3",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-3",
    callerToken: "c".repeat(64),
    method: "ping",
    params: {},
  }), {});
  assert.deepEqual(generationThreePing.data.callerWake, secondWake);
  assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), []);
});

test("wire caller.followup remains limited to the one-shot plan-opened wake", async () => {
  const { request } = await createRevivalFixture();
  assert.throws(() => parseBrokerRequest({
    ...request,
    requestId: "request-followup-attention-wire",
    params: { wakeId: "attention-reply-request-1", reason: "attention-reply" },
  }), /params.reason is unsupported/);
});

test("prepares private plan-runner recovery before resuming a proved wake", async () => {
  const calls = [];
  const { ownedRun, proof, request, server } = await createRevivalFixture({
    preparePlanRunnerRecovery: async (params) => calls.push({ method: "prepare", params }),
    resume: async (params) => {
      calls.push({ method: "resume", params });
      return revivedResult;
    },
  });

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    {
      method: "prepare",
      params: { role: "plan-runner", runId: "plan-runner-1", asyncDir: "/async/plan-runner-1" },
    },
    {
      method: "resume",
      params: { id: "plan-runner-1", message: "A durable Root broker wake is pending." },
    },
  ]);
});

test("keeps a wake pending when private plan-runner recovery preparation fails", async () => {
  const { ownedRun, proof, request, resumeCalls, server } = await createRevivalFixture({
    preparePlanRunnerRecovery: async () => { throw new Error("recovery denied"); },
  });

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();

  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(server.callerFollowUps.get(ownedRun.runId), [{ wakeId: "plan-opened-1", reason: "plan-opened" }]);
  assert.equal(server.revivePromises.size, 0);
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

test("persists sanitized revival diagnostics in proof-first order", async () => {
  const diagnostics = [];
  const { ownedRun, proof, request, server } = await createRevivalFixture({
    recordRevivalDiagnostic: (customType, data) => diagnostics.push({ customType, data }),
  });

  server.acceptTerminalProof(ownedRun, proof);
  await Promise.resolve();
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(diagnostics.map(({ data }) => data.phase), [
    "proof.accepted",
    "revival.blocked",
    "followup.accepted",
    "revival.started",
    "resume.invoked",
    "resume.succeeded",
    "grant.issued",
    "revival.succeeded",
  ]);
  assert.equal(diagnostics[1].data.reason, "wake-missing");
  for (const entry of diagnostics) {
    assertRevivalDiagnostic(entry, {
      activeRunId: entry.data.phase === "grant.issued" || entry.data.phase === "revival.succeeded" ? "plan-runner-2" : "plan-runner-1",
      generation: entry.data.phase === "grant.issued" || entry.data.phase === "revival.succeeded" ? 1 : 0,
      wakeId: entry.data.phase === "proof.accepted" || entry.data.phase === "revival.blocked" ? undefined : "plan-opened-1",
    });
  }
  const resumeSucceeded = diagnostics.find(({ data }) => data.phase === "resume.succeeded");
  assert.equal(resumeSucceeded?.data.revivedRunId, "plan-runner-2");
});

test("bounds and sanitizes revival failure diagnostics", async () => {
  const diagnostics = [];
  const secret = `resume-secret-${"x".repeat(1_500)}`;
  const { ownedRun, proof, request, server } = await createRevivalFixture({
    recordRevivalDiagnostic: (customType, data) => diagnostics.push({ customType, data }),
    resume: async () => { throw new Error(secret); },
  });

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  const failure = diagnostics.at(-1);
  assert.ok(failure, "expected revival.failed diagnostic");
  assert.equal(failure.data.phase, "revival.failed");
  assert.equal(failure.data.reason, "resume-failed");
  assert.equal(failure.data.errorMessage.length <= 512, true);
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
  assert.equal(JSON.stringify(diagnostics).includes("callerToken"), false);
  assert.equal(JSON.stringify(diagnostics).includes("params"), false);
  assertRevivalDiagnostic(failure, { activeRunId: "plan-runner-1", generation: 0, wakeId: "plan-opened-1" });
  assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), [{ wakeId: "plan-opened-1", reason: "plan-opened" }]);
});

test("isolates revival diagnostic sink failures", async () => {
  const unhandled = [];
  let sinkCalls = 0;
  const onUnhandledRejection = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const { grants, ownedRun, proof, request, server } = await createRevivalFixture({
      recordRevivalDiagnostic: () => {
        sinkCalls += 1;
        throw new Error("diagnostic sink unavailable");
      },
    });

    server.acceptTerminalProof(ownedRun, proof);
    await server.dispatch(request, {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(server.reviveResults.get("plan-runner-1"), revivedResult);
    assert.deepEqual(server.callerFollowUps.get("plan-runner-1"), []);
    assert.equal(grants.at(-1).runId, "plan-runner-2");
    assert.equal(sinkCalls, 8);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("records close diagnostics once across repeated close", async () => {
  const diagnostics = [];
  const { server } = await createRevivalFixture({
    recordRevivalDiagnostic: (customType, data) => diagnostics.push({ customType, data }),
  });
  server.ownedRuns.clear();

  await server.closeRootSession();
  await server.closeRootSession();

  assert.deepEqual(diagnostics.map(({ data }) => data.phase), ["close.started", "close.completed"]);
  for (const entry of diagnostics) {
    assert.equal(entry.customType, "pi-root-broker-revival-v1");
    assert.equal(entry.data.schemaVersion, "pi-root-broker-revival-diagnostic.v1");
    assert.equal(entry.data.rootSessionId, "root-session-1");
    assert.equal(Number.isFinite(entry.data.observedAt), true);
  }
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

test("publishes a revived caller wake atomically with its grant and rolls it back on failure", async () => {
  const callerWake = { wakeId: "attention-reply-grant-1", reason: "attention-reply" };
  let observedWake;
  let server;
  ({ server } = await createRevivalFixture({
    writeGrant: async (grant) => {
      if (grant.runId === "plan-runner-2") {
        observedWake = server.callerWakes.get(grant.runId);
        throw new Error("revived grant unavailable");
      }
      return `/tmp/root-broker-revival-grant-${grant.runId}`;
    },
  }));

  await assert.rejects(
    server.grantRevivedCaller("plan-runner-1", "plan-runner-2", callerWake),
    /revived grant unavailable/,
  );

  assert.equal(observedWake, callerWake);
  assert.equal(server.callerWakes.has("plan-runner-2"), false);
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

test("assigns revived executor domain ownership to the stable logical caller", async () => {
  const { grants, ownedRun, proof, request, server } = await createRevivalFixture();

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  const response = await server.dispatch(parseBrokerRequest({
    ...request,
    requestId: "request-dispatch-revived-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "spawn",
    params: { agent: "executor", task: "run", spawnKey: "dispatch-revived-1" },
  }), {});

  assert.equal(response.success, true);
  assert.deepEqual(grants.at(-1), {
    schemaVersion: "pi-root-subagent-broker-grant.v1",
    rootSessionId: "root-session-1",
    runId: "executor-1",
    callerToken: "c".repeat(64),
    role: "executor",
  });
  assert.equal(server.runOwners.get("executor-1"), "plan-runner-1");
  assert.equal(server.callers.get("plan-runner-1").ownedRunIds.has("executor-1"), true);
  const entry = server.spawnLedger.get("plan-1\u0000dispatch-revived-1");
  assert.equal(entry.callerRunId, "plan-runner-1");

  server.lifecycle({
    runId: "executor-1",
    agent: "executor",
    asyncDir: "/async/executor-1",
    cwd: "/workspace",
    sessionId: "root-session-1",
  }, "execution.started", entry);

  const queue = server.callerPushQueues.get("plan-runner-1");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].push.callerRunId, "plan-runner-1");
  assert.equal(server.callerPushQueues.has("plan-runner-2"), false);
});

test("allows an active plan-runner alias to control its executor", async () => {
  const { ownedRun, proof, request, server } = await createRevivalFixture();

  server.acceptTerminalProof(ownedRun, proof);
  await server.dispatch(request, {});
  await new Promise((resolve) => setImmediate(resolve));

  const spawnResponse = await server.dispatch(parseBrokerRequest({
    ...request,
    requestId: "request-spawn-active-alias-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "spawn",
    params: { agent: "executor", task: "run", spawnKey: "active-alias-control-1" },
  }), {});
  assert.equal(spawnResponse.success, true);

  const statusCalls = [];
  server.upstream.status = async (params) => {
    statusCalls.push(params);
    return { state: "running", runId: "executor-1" };
  };
  const statusRequest = parseBrokerRequest({
    ...request,
    requestId: "request-status-active-alias-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "status",
    params: { runId: "executor-1" },
  });

  const response = await server.dispatch(statusRequest, {});

  assert.deepEqual(response, {
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "request-status-active-alias-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-2",
    success: true,
    data: { state: "running", runId: "executor-1" },
  });
  assert.deepEqual(statusCalls, [{ runId: "executor-1" }]);
});

test("resolves statusCaller through a revived plan-runner alias", async () => {
  const { server } = await createActiveRevivedAliasFixture();
  const calls = [];
  server.upstream.status = async (params) => {
    calls.push(params);
    return { state: "status-result" };
  };

  assert.deepEqual(BROKER_METHODS, ["ping", "spawn", "spawn.lookup", "status", "steer", "interrupt", "stop", "supervisor.pending", "supervisor.ack", "supervisor.reply", "caller.followup", "subscribe"]);
  assert.deepEqual(await server.statusCaller("plan-runner-1"), { state: "status-result" });
  assert.deepEqual(calls, [{ runId: "plan-runner-2" }]);
});

test("resolves interruptCaller through a revived plan-runner alias", async () => {
  const { server } = await createActiveRevivedAliasFixture();
  const calls = [];
  server.upstream.interrupt = async (params) => {
    calls.push(params);
    return { state: "interrupt-result" };
  };

  assert.deepEqual(await server.interruptCaller("plan-runner-1"), { state: "interrupt-result" });
  assert.deepEqual(calls, [{ runId: "plan-runner-2" }]);
});

test("resolves stopCaller through a revived plan-runner alias", async () => {
  const { server } = await createActiveRevivedAliasFixture();
  const calls = [];
  server.upstream.stop = async (params) => {
    calls.push(params);
    return { state: "stop-result" };
  };

  assert.deepEqual(await server.stopCaller("plan-runner-1"), { state: "stop-result" });
  assert.deepEqual(calls, [{ runId: "plan-runner-2" }]);
});

test("lists a revived executor supervisor request for its active plan-runner alias", async () => {
  const { request, server } = await createRevivedSupervisorFixture();

  const response = await server.dispatch(parseBrokerRequest({
    ...request,
    requestId: "request-supervisor-pending-active-alias-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "supervisor.pending",
    params: {},
  }), {});

  assert.deepEqual(response, {
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "request-supervisor-pending-active-alias-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-2",
    success: true,
    data: { pending: [expectedPendingSupervisorData] },
  });
});

test("replies to a revived executor supervisor request from its active plan-runner alias", async () => {
  const calls = [];
  const { request, server } = await createRevivedSupervisorFixture({
    executeSupervisor: async (params, context) => {
      calls.push({ params, context });
      return { accepted: true };
    },
  });

  const response = await server.dispatch(parseBrokerRequest({
    ...request,
    requestId: "request-supervisor-reply-active-alias-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "supervisor.reply",
    params: { replyTo: "attention-1", message: "Proceed" },
  }), {});

  assert.deepEqual(response, {
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "request-supervisor-reply-active-alias-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-2",
    success: true,
    data: { accepted: true },
  });
  assert.deepEqual(calls, [{
    params: { action: "reply", replyTo: "attention-1", message: "Proceed" },
    context: supervisorContext,
  }]);
});

test("revives a proved plan-runner for a queued lifecycle push without an explicit follow-up", async () => {
  const { ownedRun, proof, resumeCalls, server } = await createRevivalFixture();
  const push = queuedLifecyclePush({ dispatchId: "dispatch-proof-first-1", runId: "executor-proof-first-1" });

  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, []);

  assert.equal(server.deliverOrQueuePush("plan-runner-1", push), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
  assert.deepEqual(server.callerPushQueues.get("plan-runner-1")?.map(({ push: queued }) => queued), [push]);
});

test("does not revive a queued lifecycle push until official terminal proof is accepted", async () => {
  const { ownedRun, proof, resumeCalls, server } = await createRevivalFixture();
  const push = queuedLifecyclePush({ dispatchId: "dispatch-queue-first-1", runId: "executor-queue-first-1" });

  assert.equal(server.deliverOrQueuePush("plan-runner-1", push), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, []);

  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
});

test("coalesces queued lifecycle pushes into one revival and flushes them FIFO after subscription activation", async (t) => {
  let resolveResume;
  const resumeDeferred = new Promise((resolve) => { resolveResume = resolve; });
  t.after(() => resolveResume(revivedResult));
  const { ownedRun, proof, resumeCalls, server } = await createRevivalFixture({
    resume: () => resumeDeferred,
  });
  const firstPush = queuedLifecyclePush({ dispatchId: "dispatch-fifo-1", runId: "executor-fifo-1" });
  const secondPush = queuedLifecyclePush({ dispatchId: "dispatch-fifo-2", runId: "executor-fifo-2" });

  server.acceptTerminalProof(ownedRun, proof);
  assert.equal(server.deliverOrQueuePush("plan-runner-1", firstPush), false);
  assert.equal(server.deliverOrQueuePush("plan-runner-1", secondPush), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
  assert.equal(server.revivePromises.size, 1);

  resolveResume(revivedResult);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(server.callerPushQueues.get("plan-runner-1")?.map(({ push }) => push), [firstPush, secondPush]);

  const writes = [];
  const socket = {
    destroyed: false,
    write(frame) { writes.push(frame); return true; },
    once() {},
  };
  const subscription = parseBrokerRequest({
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-subscribe-queued-revival-1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-2",
    callerToken: "b".repeat(64),
    method: "subscribe",
    params: {},
  });
  const acknowledgement = await server.dispatch(subscription, socket, { deferSubscription: true });
  assert.equal(acknowledgement.success, true);
  server.activateSubscription(subscription, socket);

  assert.deepEqual(writes.map((frame) => parseBrokerPush(JSON.parse(frame))), [
    { ...firstPush, callerRunId: "plan-runner-2" },
    { ...secondPush, callerRunId: "plan-runner-2" },
    {
      schemaVersion: "pi-root-subagent-broker-push.v1",
      rootSessionId: "root-session-1",
      callerRunId: "plan-runner-2",
      type: "subscription.ready",
      data: {},
    },
  ]);
  assert.deepEqual(server.callerPushQueues.get("plan-runner-1"), []);
});

test("live lifecycle completion creates post-proof revival debt after delivery", async () => {
  const { ownedRun, proof, resumeCalls, server, forwardCompletion, writes } = await createLiveLifecycleFixture();

  await forwardCompletion("live-post-proof-1");

  assert.deepEqual(writes.map((push) => push.type), ["execution.completed"]);
  assert.deepEqual(server.callerPushQueues.get("plan-runner-1"), [], "the live write must not depend on the payload FIFO");

  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
});

test("live lifecycle completions coalesce post-proof revival debt into one handoff", async (t) => {
  let resolveResume;
  const resumeDeferred = new Promise((resolve) => { resolveResume = resolve; });
  t.after(() => resolveResume(revivedResult));
  const { ownedRun, proof, resumeCalls, server, forwardCompletion } = await createLiveLifecycleFixture({
    resume: () => resumeDeferred,
  });

  await forwardCompletion("live-coalesce-1");
  await forwardCompletion("live-coalesce-2");
  assert.deepEqual(server.callerPushQueues.get("plan-runner-1"), []);

  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
  assert.equal(server.revivePromises.size, 1);
  resolveResume(revivedResult);
  await new Promise((resolve) => setImmediate(resolve));
});

test("live lifecycle revival debt is consumed after successful handoff without a new completion", async () => {
  const { ownedRun, proof, resumeCalls, request, server, forwardCompletion } = await createLiveLifecycleFixture();

  await forwardCompletion("live-consume-1");
  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, expectedResume);

  const revivedRun = { ...ownedRun, runId: "plan-runner-2", asyncDir: "/async/plan-runner-2", pid: 102, birthIdentity: "plan-runner-2-birth" };
  server.ownedRuns.set(revivedRun.runId, revivedRun);
  const socket = { destroyed: false, write() { return true; }, once() {} };
  const subscription = parseBrokerRequest({
    ...request,
    requestId: "request-subscribe-live-consume-2",
    callerRunId: "plan-runner-2",
    callerToken: "c".repeat(64),
    method: "subscribe",
    params: {},
  });
  const acknowledgement = await server.dispatch(subscription, socket, { deferSubscription: true });
  assert.equal(acknowledgement.success, true);
  server.activateSubscription(subscription, socket);

  server.acceptTerminalProof(revivedRun, { ...proof, runId: "plan-runner-2" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
});

test("live lifecycle completion creates revival debt after Plan Runner proof", async () => {
  const { ownedRun, proof, resumeCalls, server, forwardCompletion, writes } = await createLiveLifecycleFixture();

  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, []);

  await forwardCompletion("live-proof-first-1");
  assert.deepEqual(writes.map((push) => push.type), ["execution.completed"]);
  assert.deepEqual(server.callerPushQueues.get("plan-runner-1"), []);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, expectedResume);
});

test("live lifecycle completion received during resume transfers debt to the revived Plan Runner", async () => {
  let resolveFirstResume;
  const firstResume = new Promise((resolve) => { resolveFirstResume = resolve; });
  let resumeNumber = 0;
  const { ownedRun, proof, resumeCalls, server, forwardCompletion } = await createLiveLifecycleFixture({
    resume: async () => {
      resumeNumber += 1;
      if (resumeNumber === 1) return await firstResume;
      return {
        ...revivedResult,
        details: { ...revivedResult.details, asyncId: "plan-runner-3", asyncDir: "/async/plan-runner-3" },
      };
    },
  });

  await forwardCompletion("live-in-flight-1");
  server.acceptTerminalProof(ownedRun, proof);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, expectedResume, "the first resume must remain in flight");

  await forwardCompletion("live-in-flight-2");
  resolveFirstResume(revivedResult);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resumeCalls, expectedResume, "stale old debt must not start a second resume before plan-runner-2 proof");

  const revivedRun = {
    ...ownedRun,
    runId: "plan-runner-2",
    asyncDir: "/async/plan-runner-2",
    pid: 102,
    birthIdentity: "plan-runner-2-birth",
  };
  server.ownedRuns.set(revivedRun.runId, revivedRun);
  server.acceptTerminalProof(revivedRun, {
    ...proof,
    runId: "plan-runner-2",
    runnerProcessInstanceId: "plan-runner-2-instance",
    instances: [{
      ...proof.instances[0],
      processInstanceId: "plan-runner-2-instance",
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resumeCalls, [
    ...expectedResume,
    { id: "plan-runner-2", message: "A durable Root broker wake is pending." },
  ]);
});
