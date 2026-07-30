import assert from "node:assert/strict";
import test from "node:test";

import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";

test("queues one lifecycle push for an unsubscribed caller without marking it delivered", async () => {
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream: { async ping() { return {}; } },
    randomToken: () => "a".repeat(64),
    writeGrant: async () => "/tmp/root-broker-push-fifo-grant.json",
  });
  await server.grantCaller({
    callerRunId: "plan-runner-1",
    planId: "plan-1",
    cwd: "/repo",
    originRoot: "/repo",
    stateRoot: "/state",
    role: "plan-runner",
  });
  const entry = {
    hash: "a".repeat(64),
    state: "spawned",
    spawnKey: "dispatch-1",
    callerRunId: "plan-runner-1",
    params: { agent: "executor", cwd: "/repo" },
    binding: { runId: "executor-1", asyncDir: "/async/executor-1" },
    pending: [],
    queued: new Set(),
    delivered: new Set(),
  };
  server.spawnLedger.set("plan-1\u0000dispatch-1", entry);

  const event = {
    runId: "executor-1",
    agent: "executor",
    asyncDir: "/async/executor-1",
    cwd: "/repo",
    sessionId: "root-session-1",
  };
  const push = {
    schemaVersion: "pi-root-subagent-broker-push.v1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    type: "execution.started",
    data: {
      dispatchId: "dispatch-1",
      runId: "executor-1",
      asyncDir: "/async/executor-1",
      cwd: "/repo",
      sessionId: "root-session-1",
      state: "running",
    },
  };

  server.lifecycle(event, "execution.started");
  server.lifecycle(event, "execution.started");

  const queue = server.callerPushQueues.get("plan-runner-1");
  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].push, push);
  assert.equal(entry.queued.size, 1);
  assert.equal(entry.delivered.size, 0);
});

test("queues an unsubscribed supervisor request after the lifecycle FIFO entry", async () => {
  const server = new RootBrokerServer({
    rootSessionId: "root-session-1",
    upstream: { async ping() { return {}; } },
    randomToken: () => "a".repeat(64),
    writeGrant: async () => "/tmp/root-broker-push-fifo-grant.json",
  });
  await server.grantCaller({
    callerRunId: "plan-runner-1",
    planId: "plan-1",
    cwd: "/repo",
    originRoot: "/repo",
    stateRoot: "/state",
    role: "plan-runner",
  });
  server.spawnLedger.set("plan-1\u0000dispatch-1", {
    hash: "a".repeat(64),
    state: "spawned",
    spawnKey: "dispatch-1",
    callerRunId: "plan-runner-1",
    params: { agent: "executor", cwd: "/repo" },
    binding: { runId: "executor-1", asyncDir: "/async/executor-1" },
    pending: [],
    queued: new Set(),
    delivered: new Set(),
  });
  server.lifecycle({
    runId: "executor-1",
    agent: "executor",
    asyncDir: "/async/executor-1",
    cwd: "/repo",
    sessionId: "root-session-1",
  }, "execution.started");
  server.runOwners.set("executor-1", "plan-runner-1");

  await server.routeSupervisorRequest({
    customType: "subagent_supervisor_request",
    content: "Need approval",
    details: {
      id: "attention-1",
      runId: "executor-1",
      reason: "need_decision",
      expectsReply: true,
      agent: "executor",
      childIndex: 0,
      parent: "parent-run-1",
      depth: 1,
      path: ["parent-run-1", "executor-1"],
    },
  });

  const queue = server.callerPushQueues.get("plan-runner-1");
  assert.deepEqual(queue.map(({ push }) => push.type), ["execution.started", "supervisor.request"]);
  assert.deepEqual(queue[1].push, {
    schemaVersion: "pi-root-subagent-broker-push.v1",
    rootSessionId: "root-session-1",
    callerRunId: "plan-runner-1",
    type: "supervisor.request",
    data: {
      requestId: "attention-1",
      executorRunId: "executor-1",
      reason: "need_decision",
      expectsReply: true,
      agent: "executor",
      childIndex: 0,
      content: "Need approval",
    },
  });
  assert.equal(server.supervisorRequests.has("attention-1"), true);
});
