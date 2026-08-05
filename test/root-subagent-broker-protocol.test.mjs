import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import test from "node:test";

import {
  BROKER_METHODS,
  BrokerProtocolError,
  brokerGrantPath,
  brokerSocketPath,
  createBrokerFailureResponse,
  createBrokerSuccessResponse,
  parseBrokerGrant,
  parseBrokerPush,
  parseBrokerRequest,
  parseBrokerResponse,
  readBrokerGrant,
  resolveRootSessionId,
  writeBrokerGrant,
} from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";

const token = "a".repeat(64);
const request = (method = "ping") => ({
  schemaVersion: "pi-root-subagent-broker-request.v1",
  requestId: "request-1",
  rootSessionId: "root-1",
  callerRunId: "executor-1",
  callerToken: token,
  method,
  params: {},
});

test("broker accepts only direct-owner health and subscription requests", () => {
  assert.deepEqual([...BROKER_METHODS], ["ping", "subscribe"]);
  assert.equal(Object.isFrozen(BROKER_METHODS), true);
  assert.deepEqual(parseBrokerRequest(request("ping")), request("ping"));
  assert.deepEqual(parseBrokerRequest(request("subscribe")), request("subscribe"));
  for (const method of ["spawn", "spawn.lookup", "status", "steer", "interrupt", "stop", "supervisor.pending", "supervisor.ack", "supervisor.reply", "caller.followup"]) {
    assert.throws(() => parseBrokerRequest(request(method)), BrokerProtocolError);
  }
});

test("broker rejects unknown request fields and unsafe identities", () => {
  assert.throws(() => parseBrokerRequest({ ...request(), extra: true }), /unknown field/);
  assert.throws(() => parseBrokerRequest({ ...request(), callerRunId: "../executor" }), /safe non-path identity/);
  assert.throws(() => parseBrokerRequest({ ...request(), callerToken: "short" }), /64 lowercase hexadecimal/);
});

test("broker grants only direct executors", () => {
  const grant = { schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: "root-1", runId: "executor-1", callerToken: token, role: "executor" };
  assert.deepEqual(parseBrokerGrant(grant), grant);
  assert.throws(() => parseBrokerGrant({ ...grant, role: "plan-runner" }), /role/);
  assert.throws(() => parseBrokerGrant({ ...grant, role: "caller" }), /role/);
});

test("broker push protocol exposes only readiness and root shutdown", () => {
  for (const type of ["subscription.ready", "root.closing"]) {
    const push = { schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: "root-1", callerRunId: "executor-1", type, data: {} };
    assert.deepEqual(parseBrokerPush(push), push);
  }
  assert.throws(() => parseBrokerPush({
    schemaVersion: "pi-root-subagent-broker-push.v1",
    rootSessionId: "root-1",
    callerRunId: "executor-1",
    type: "execution.completed",
    data: { dispatchId: "dispatch-1", runId: "executor-1", asyncDir: "/tmp/executor-1", cwd: "/repo", sessionId: "root-1", state: "pending" },
  }), /type/);
  assert.throws(() => parseBrokerPush({ schemaVersion: "pi-root-subagent-broker-push.v1", rootSessionId: "root-1", callerRunId: "executor-1", type: "root.closing", data: { extra: true } }), /data/);
});

test("broker responses remain bound to the exact request identity", () => {
  const success = createBrokerSuccessResponse({ requestId: "request-1", rootSessionId: "root-1", callerRunId: "executor-1", data: { alive: true } });
  assert.deepEqual(parseBrokerResponse(success, request()), success);
  const failure = createBrokerFailureResponse({ requestId: "request-1", rootSessionId: "root-1", callerRunId: "executor-1", code: "DENIED", message: "denied" });
  assert.deepEqual(parseBrokerResponse(failure, request()), failure);
  assert.throws(() => parseBrokerResponse(success, { ...request(), requestId: "request-2" }), /identity/);
});

test("broker grant storage remains exact and owner-only", async (t) => {
  const rootSessionId = `root-${process.pid}-${Date.now()}`;
  const runId = "executor-1";
  const grant = { schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId, runId, callerToken: token, role: "executor" };
  const grantPath = brokerGrantPath(rootSessionId, runId);
  t.after(() => rm(grantPath, { force: true }));
  await writeBrokerGrant(grant);
  assert.deepEqual(await readBrokerGrant(rootSessionId, runId), grant);
  assert.equal((await stat(grantPath)).mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(brokerSocketPath(rootSessionId), "utf8") <= 103);
});

test("root identity comes only from the live session id", () => {
  assert.equal(resolveRootSessionId({ getSessionId: () => "root-session" }), "root-session");
  assert.throws(() => resolveRootSessionId({ getSessionId: () => "/tmp/session.jsonl" }), /safe non-path identity/);
});
