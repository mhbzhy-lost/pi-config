import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  BROKER_METHODS,
  BrokerProtocolError,
  brokerGrantPath,
  brokerSocketPath,
  createBrokerFailureResponse,
  createBrokerSuccessResponse,
  createSupervisorRequestPush,
  ensureBrokerSocketDirectory,
  parseBrokerGrant,
  parseBrokerPush,
  parseBrokerRequest,
  parseBrokerResponse,
  readBrokerGrant,
  resolveRootSessionId,
  serializeBrokerGrant,
  setBrokerSocketPermissions,
  writeBrokerGrant,
} from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";

const token = "a".repeat(64);
const rootSessionId = "root-session-1";
const callerRunId = "plan-run-1";

function request(overrides = {}) {
  return {
    schemaVersion: "pi-root-subagent-broker-request.v1",
    requestId: "request-1",
    rootSessionId,
    callerRunId,
    callerToken: token,
    method: "spawn",
    params: { agent: "executor", task: "execute", async: true },
    ...overrides,
  };
}

function grant(overrides = {}) {
  return {
    schemaVersion: "pi-root-subagent-broker-grant.v1",
    rootSessionId,
    runId: callerRunId,
    callerToken: token,
    role: "plan-runner",
    ...overrides,
  };
}

function response(overrides = {}) {
  return {
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "request-1",
    rootSessionId,
    callerRunId,
    success: true,
    data: { executionId: "execution-1" },
    ...overrides,
  };
}

function expectInvalid(operation, expression) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof BrokerProtocolError, true);
    assert.match(error.message, expression);
    return true;
  });
}

test("parses only exact flat broker request envelopes", () => {
  assert.deepEqual(parseBrokerRequest(request()), request());

  for (const field of ["parentRunId", "parentDepth", "parentPath", "fanout", "runtimeParent"]) {
    expectInvalid(() => parseBrokerRequest({ ...request(), [field]: "x" }), /unknown|additional|unsupported/i);
  }
  expectInvalid(() => parseBrokerRequest(request({ method: "unknown" })), /method/);
  expectInvalid(() => parseBrokerRequest(request({ callerToken: "short" })), /callerToken/);
  expectInvalid(() => parseBrokerRequest(request({ requestId: "." })), /requestId/);
  expectInvalid(() => parseBrokerRequest(request({ rootSessionId: "../other" })), /rootSessionId/);
  expectInvalid(() => parseBrokerRequest(request({ callerRunId: "run/other" })), /callerRunId/);
  expectInvalid(() => parseBrokerRequest(request({ params: [] })), /params/);
});

test("allows the fixed broker method set", () => {
  for (const method of ["ping", "spawn", "status", "steer", "interrupt", "stop", "supervisor.pending", "supervisor.reply", "subscribe"]) {
    const params = method === "supervisor.reply" ? { replyTo: "upstream-request-1", answer: "yes" } : request().params;
    assert.equal(parseBrokerRequest(request({ method, params })).method, method);
  }
});

test("keeps the exported broker method set frozen and fail closed", () => {
  assert.equal(Object.isFrozen(BROKER_METHODS), true);
  assert.throws(() => BROKER_METHODS.push("nested.spawn"), TypeError);
  expectInvalid(() => parseBrokerRequest(request({ method: "nested.spawn" })), /method/);
});

test("creates and parses exact broker response envelopes bound to request identity", () => {
  const expectedIdentity = { requestId: "request-1", rootSessionId, callerRunId };
  const success = createBrokerSuccessResponse({ ...expectedIdentity, data: { executionId: "execution-1" } });
  const failure = createBrokerFailureResponse({ ...expectedIdentity, code: "execution_failed", message: "Execution failed" });
  const { data: _data, ...failureBase } = response({ success: false });

  assert.deepEqual(success, response());
  assert.deepEqual(parseBrokerResponse(success, expectedIdentity), success);
  assert.deepEqual(failure, {
    schemaVersion: "pi-root-subagent-broker-response.v1",
    requestId: "request-1",
    rootSessionId,
    callerRunId,
    success: false,
    error: { code: "execution_failed", message: "Execution failed" },
  });
  assert.deepEqual(parseBrokerResponse(failure, expectedIdentity), failure);

  expectInvalid(() => parseBrokerResponse(null), /response.*object/i);
  expectInvalid(() => parseBrokerResponse(response({ extra: true })), /unknown/i);
  expectInvalid(() => parseBrokerResponse(response({ schemaVersion: "pi-root-subagent-broker-response.v2" })), /schemaVersion/);
  expectInvalid(() => parseBrokerResponse(response({ requestId: "other-request" }), expectedIdentity), /requestId/);
  expectInvalid(() => parseBrokerResponse(response({ rootSessionId: "other-root" }), expectedIdentity), /rootSessionId/);
  expectInvalid(() => parseBrokerResponse(response({ callerRunId: "other-run" }), expectedIdentity), /callerRunId/);
  expectInvalid(() => parseBrokerResponse(response({ success: "true" })), /success/);
  expectInvalid(() => parseBrokerResponse(response({ data: undefined })), /data/);
  expectInvalid(() => parseBrokerResponse({ ...failureBase, error: { code: "bad/code", message: "failed" } }), /error.code/);
  expectInvalid(() => parseBrokerResponse({ ...failureBase, error: { code: "failed", message: "" } }), /error.message/);
  expectInvalid(() => parseBrokerResponse({ ...failureBase, error: { code: "failed", message: "x".repeat(1025) } }), /error.message/);
  expectInvalid(() => parseBrokerResponse({ ...failureBase, error: { code: "failed", message: "failed", extra: true } }), /unknown/i);
  expectInvalid(() => parseBrokerResponse({ ...response(), error: { code: "failed", message: "failed" } }), /unknown|success/i);
  expectInvalid(() => parseBrokerResponse(failureBase), /error/);
});

test("fixes supervisor push and reply identities to upstream request identity", () => {
  const push = createSupervisorRequestPush({
    rootSessionId,
    callerRunId,
    upstreamDetails: { id: "upstream-request-1", runId: "executor-run-1", question: "Continue?" },
  });
  assert.deepEqual(push, {
    schemaVersion: "pi-root-subagent-broker-push.v1",
    rootSessionId,
    callerRunId,
    type: "supervisor.request",
    data: { requestId: "upstream-request-1", executorRunId: "executor-run-1", question: "Continue?" },
  });
  assert.deepEqual(parseBrokerPush(push), push);
  assert.equal(parseBrokerRequest(request({ method: "supervisor.reply", params: { replyTo: "upstream-request-1", answer: "yes" } })).params.replyTo, "upstream-request-1");
  expectInvalid(() => parseBrokerRequest(request({ method: "supervisor.reply", params: { replyTo: "broker-request-1", answer: "yes" } }), { supervisorRequestId: "upstream-request-1" }), /replyTo/);
  expectInvalid(() => parseBrokerPush({ ...push, data: { ...push.data, brokerRequestId: "second-id" } }), /unknown|additional|secondary identity/i);
  expectInvalid(() => createSupervisorRequestPush({ rootSessionId, callerRunId, upstreamDetails: { id: "upstream-request-1", runId: "executor/run" } }), /runId/);
});

test("reload identity uses the safe session ID instead of the session file path", () => {
  const sessionManager = {
    getSessionFile: () => "/tmp/pi/sessions/2026-07-30_root-session-1.jsonl",
    getSessionId: () => rootSessionId,
  };

  assert.equal(resolveRootSessionId(sessionManager), rootSessionId);
});

test("uses deterministic short socket paths and enforces directory and socket permissions", async () => {
  const socketPath = brokerSocketPath(rootSessionId);
  assert.match(socketPath, /^\/tmp\/pi-root-subagent-\d+\/[a-f0-9]{64}\.sock$/);
  assert.equal(socketPath, brokerSocketPath(rootSessionId));
  assert.ok(Buffer.byteLength(socketPath, "utf8") <= 103);
  assert.notEqual(socketPath, brokerSocketPath("other-root"));

  const directory = await ensureBrokerSocketDirectory(rootSessionId);
  assert.equal(directory, socketPath.slice(0, socketPath.lastIndexOf("/")));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await writeFile(socketPath, "socket-placeholder", { mode: 0o644 });
  await setBrokerSocketPermissions(socketPath);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  await rm(socketPath, { force: true });
});

test("serializes strict grants under the short root with owner-only permissions", async () => {
  const path = brokerGrantPath(rootSessionId, callerRunId);
  assert.match(path, /^\/tmp\/pi-root-subagent-\d+\/grants\/[a-f0-9]{64}\.json$/);
  assert.ok(Buffer.byteLength(path, "utf8") <= 103);
  assert.deepEqual(parseBrokerGrant(JSON.parse(serializeBrokerGrant(grant()))), grant());
  expectInvalid(() => parseBrokerGrant({ ...grant(), extra: true }), /unknown|additional/i);
  expectInvalid(() => brokerGrantPath(rootSessionId, "../other"), /runId/);
  expectInvalid(() => parseBrokerGrant(grant({ rootSessionId: "root/other" })), /rootSessionId/);

  await writeBrokerGrant(grant());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readBrokerGrant(rootSessionId, callerRunId), grant());
  await writeFile(path, serializeBrokerGrant(grant({ runId: "other-run" })), { mode: 0o600 });
  await assert.rejects(readBrokerGrant(rootSessionId, callerRunId), /identity/);
  await rm(path, { force: true });
  await rm(path.slice(0, path.lastIndexOf("/")), { recursive: true, force: true });
});
