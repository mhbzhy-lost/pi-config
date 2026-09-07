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
  parseBrokerGrant,
  parseBrokerGrantV2,
  parseBrokerPush,
  parseBrokerRequest,
  parseBrokerResponse,
  readBrokerGrant,
  resolveRootSessionId,
  writeBrokerGrant,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";
import { readLegacyExecutorProof } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/legacy-executor-compat.ts";

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
  assert.deepEqual([...BROKER_METHODS], ["ping", "subscribe", "acceptance.submit"]);
  assert.equal(Object.isFrozen(BROKER_METHODS), true);
  assert.deepEqual(parseBrokerRequest(request("ping")), request("ping"));
  assert.deepEqual(parseBrokerRequest(request("subscribe")), request("subscribe"));
  for (const method of ["spawn", "spawn.lookup", "status", "steer", "interrupt", "stop", "supervisor.pending", "supervisor.ack", "supervisor.reply", "caller.followup", "acceptance.write"]) {
    assert.throws(() => parseBrokerRequest(request(method)), BrokerProtocolError);
  }
});

test("broker acceptance submission accepts only the exact bounded evidence payload", () => {
  const params = {
    outcome: "succeeded",
    criteria: [{ id: "criterion-1", status: "satisfied", evidence: [`sha256:${"1".repeat(64)}`] }],
    commandsRun: [{ command: "node --test", result: "passed", outputRef: `sha256:${"2".repeat(64)}` }],
    changedFiles: ["src/example.ts"],
  };
  assert.deepEqual(parseBrokerRequest({ ...request("acceptance.submit"), params }).params, params);
  for (const invalid of [
    { ...params, extra: true },
    { ...params, outcome: "unknown" },
    { ...params, criteria: [] },
    { ...params, criteria: [{ ...params.criteria[0], id: "" }] },
    { ...params, changedFiles: ["../outside"] },
    { ...params, commandsRun: [{ ...params.commandsRun[0], outputRef: "raw-secret" }] },
  ]) assert.throws(() => parseBrokerRequest({ ...request("acceptance.submit"), params: invalid }), BrokerProtocolError);
});

test("broker rejects unknown request fields and unsafe identities", () => {
  assert.throws(() => parseBrokerRequest({ ...request(), extra: true }), /unknown field/);
  assert.throws(() => parseBrokerRequest({ ...request(), callerRunId: "../executor" }), /safe non-path identity/);
  assert.throws(() => parseBrokerRequest({ ...request(), callerToken: "short" }), /64 lowercase hexadecimal/);
});

test("legacy grants are read-only normalized into canonical capabilities", async () => {
  const grant = { schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId: "root-1", runId: "executor-1", callerToken: token, role: "executor" };
  assert.deepEqual(parseBrokerGrant(grant), { schemaVersion: "pi-root-subagent-broker-grant.v2", rootSessionId: "root-1", runId: "executor-1", callerToken: token, capabilities: ["acceptance.submit", "root.subscribe"] });
  for (const invalid of [{ ...grant, extra: true }, { ...grant, role: "coordinator" }, { ...grant, callerToken: "short" }]) assert.throws(() => parseBrokerGrant(invalid), BrokerProtocolError);
  const v2 = { schemaVersion: "pi-root-subagent-broker-grant.v2", rootSessionId: "root-1", runId: "run-1", callerToken: token, capabilities: ["acceptance.submit", "root.subscribe"] };
  assert.deepEqual(parseBrokerGrantV2(v2), v2);
  assert.throws(() => parseBrokerGrantV2({ ...v2, capabilities: ["root.subscribe", "acceptance.submit"] }), /canonical order/);
  assert.throws(() => parseBrokerGrantV2({ ...v2, capabilities: ["root.subscribe", "root.subscribe"] }), /duplicates/);
  assert.throws(() => parseBrokerGrantV2({ ...v2, capabilities: [] }), /non-empty/);
  await assert.rejects(writeBrokerGrant(grant), BrokerProtocolError);
});

test("legacy executor proof normalization is exact and fail-closed", () => {
  const legacy = {
    schemaVersion: "root-broker.executor-proof.v1",
    ownership: { rootSessionId: "root-1", runId: "executor-1", role: "executor", asyncDir: "/tmp/executor-1", sessionId: "session-1", identityState: "verified" },
    terminal: { proofId: "e".repeat(64), observedAt: 1_700_000_000_000, outcome: "succeeded" },
    terminalConflict: false,
  };
  const fail = (message) => { throw new BrokerProtocolError(message); };
  assert.deepEqual(readLegacyExecutorProof(legacy, fail), {
    schemaVersion: "root-broker.execution-proof.v2",
    binding: { rootSessionId: "root-1", runId: "executor-1", asyncDir: "/tmp/executor-1", sessionId: "session-1", agentProfile: "executor" },
    capabilities: ["acceptance.submit", "root.subscribe"],
    terminal: { proofId: "e".repeat(64), observedAt: 1_700_000_000_000, outcome: "succeeded" },
    terminalConflict: false,
  });
  for (const invalid of [{ ...legacy, extra: true }, { ...legacy, terminalConflict: "false" }, { ...legacy, ownership: { ...legacy.ownership, identityState: "claimed" } }, { ...legacy, terminal: { ...legacy.terminal, proofId: "bad" } }]) assert.throws(() => readLegacyExecutorProof(invalid, fail), BrokerProtocolError);
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

test("broker grant storage remains exact and capability-bound", async (t) => {
  const rootSessionId = `root-${process.pid}-${Date.now()}`;
  const runId = "executor-1";
  const grant = { schemaVersion: "pi-root-subagent-broker-grant.v2", rootSessionId, runId, callerToken: token, capabilities: ["root.subscribe"] };
  const grantPath = brokerGrantPath(rootSessionId, runId);
  t.after(() => rm(grantPath, { force: true }));
  await writeBrokerGrant(grant);
  assert.deepEqual(await readBrokerGrant(rootSessionId, runId), grant);
  assert.equal((await stat(grantPath)).mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(brokerSocketPath(rootSessionId), "utf8") <= 103);
});

test("persisted legacy grants are only read through the canonical adapter", async (t) => {
  const rootSessionId = `legacy-root-${process.pid}-${Date.now()}`;
  const runId = "executor-1";
  const grantPath = brokerGrantPath(rootSessionId, runId);
  const canonical = { schemaVersion: "pi-root-subagent-broker-grant.v2", rootSessionId, runId, callerToken: token, capabilities: ["acceptance.submit", "root.subscribe"] };
  t.after(() => rm(grantPath, { force: true }));
  await writeBrokerGrant(canonical);
  await writeFile(grantPath, `${JSON.stringify({ schemaVersion: "pi-root-subagent-broker-grant.v1", rootSessionId, runId, callerToken: token, role: "executor" })}\n`);
  assert.deepEqual(await readBrokerGrant(rootSessionId, runId), canonical);
});

test("root identity comes only from the live session id", () => {
  assert.equal(resolveRootSessionId({ getSessionId: () => "root-session" }), "root-session");
  assert.throws(() => resolveRootSessionId({ getSessionId: () => "/tmp/session.jsonl" }), /safe non-path identity/);
});
