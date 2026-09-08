import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveOwnedRunStopRequest } from "../src/goal-engine/suspension.ts";
import { appendEvent, loadProjection } from "../src/goal-engine/store.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../src/goal-engine/obligation-contract.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const goalId = "r10b-goal";
const ownerSessionId = "root-r10b-session";
const baseHead = "a".repeat(40);
const contractHash = "b".repeat(64);
const leaseId = "c".repeat(64);
const hash = (n) => String(n).padStart(64, "0");
const authority = (overrides = {}) => ({ goalId, taskId: "task-1", attempt: 1, runId: "r10b-executor", asyncDir: "/tmp/r10b-executor", workspacePath: "/tmp/r10b-workspace", leaseId, sessionId: ownerSessionId, baseHead, headAtDispatch: baseHead, executionRevision: 1, contractHash, expectedCriteria: ["contract"], agentProfile: "executor", ...overrides });
const hostRequest = ({ expectedCriteria: _expectedCriteria, agentProfile: _agentProfile, ...request } = authority()) => ({ ...request, agent: "executor" });

function event(type, data, number) {
  return { schemaVersion: "goal-runtime.v1", eventId: `r10b-${number}`, goalId, occurredAt: `2026-08-13T00:00:${String(number).padStart(2, "0")}.000Z`, type, data };
}

function append(root, projection, type, data, number) {
  return appendEvent(root, event(type, data, number), projection?.version ?? 0);
}

function approvalHash(executionContractHash) {
  return createHash("sha256").update(JSON.stringify({ baseHead, executionContractHash, goalId, proposalId: "r10b-approval", sessionId: ownerSessionId })).digest("hex");
}
async function authorize(broker, binding) {
  await broker.registerAuthorizedRun(createRunAuthorization({ kind: "coding", binding: { runId: binding.runId, asyncDir: binding.asyncDir, sessionId: binding.sessionId, pid: 43210, agentProfile: binding.agentProfile }, goal: { ticketId: "d".repeat(64), goalId: binding.goalId, taskId: binding.taskId, attempt: binding.attempt, contractHash: binding.contractHash, workspaceId: "r10b-workspace", executionRevision: binding.executionRevision, expectedCriteria: binding.expectedCriteria } }));
}

function persistedBoundRuntime() {
  const root = mkdtempSync(join(tmpdir(), "r10b-owned-stop-"));
  const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  let projection = append(root, null, "goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead, readiness: "draft" }, 1);
  projection = append(root, projection, "goal.session_bound", { sessionId: ownerSessionId, leafId: "r10b-leaf" }, 2);
  projection = append(root, projection, "goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 3);
  projection = append(root, projection, "goal.runtime_approval_recorded", { proposalId: "r10b-approval", proposalHash: approvalHash(projection.executionContractHash), executionContractHash: projection.executionContractHash, baseHead, sessionId: ownerSessionId, userEntryId: "r10b-entry", capabilityDigest: hash(4) }, 4);
  const observation = { runId: "r10b-calibration", conditionId: "condition-1", cycle: 0, head: baseHead, executionRevision: projection.executionRevision, executionContractHash: projection.executionContractHash, conditionHash: projection.conditions.get("condition-1").conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: hash(5), resourceClaimsHash: hash(6) };
  projection = append(root, projection, "condition.observation_requested", observation, 5);
  projection = append(root, projection, "condition.observation_lease_allocated", { runId: observation.runId, conditionId: observation.conditionId, allocationId: "r10b-allocation", leaseReceiptHash: hash(7) }, 6);
  projection = append(root, projection, "condition.observation_process_bound", { runId: observation.runId, conditionId: observation.conditionId, processIdentityHash: hash(8) }, 7);
  projection = append(root, projection, "condition.observation_terminal", { runId: observation.runId, conditionId: observation.conditionId, terminalProofHash: hash(9) }, 8);
  projection = append(root, projection, "condition.observation_recorded", { runId: observation.runId, conditionId: observation.conditionId, evidenceId: hash(10), verdict: { kind: "passed" }, evidence: { executionRevision: projection.executionRevision, executionContractHash: projection.executionContractHash, conditionHash: observation.conditionHash, head: baseHead, adapter: observation.adapter, environment: { ref: "local", fingerprint: "r10b-environment" }, fixtures: [{ ref: "sample", fingerprint: "r10b-fixture" }], artifact: { id: "r10b-artifact", hash: hash(11) } } }, 9);
  projection = append(root, projection, "goal.runtime_activated", {}, 10);
  projection = append(root, projection, "task.dispatched", { taskId: "task-1", contractHash, workspace: { attempt: 1, path: "/tmp/r10b-workspace", branch: "r10b-workspace", baseCommit: baseHead } }, 11);
  append(root, projection, "task.executor_bound", { taskId: "task-1", attempt: 1, runId: "r10b-executor", contractHash, asyncDir: "/tmp/r10b-executor", workspacePath: "/tmp/r10b-workspace", workspaceLeaseId: leaseId, headAtDispatch: baseHead }, 12);
  return { root, projection: loadProjection(root, goalId) };
}

test("RED: reload derives Root Broker request from event-sourced owner session and runtime base head", () => {
  const { root, projection } = persistedBoundRuntime();
  try {
    assert.equal(Object.hasOwn(projection, "sessionId"), false, "the reducer has no compatibility sessionId alias");
    assert.equal(Object.hasOwn(projection, "baseHead"), false, "the reducer has no compatibility baseHead alias");
    assert.deepEqual(deriveOwnedRunStopRequest({ projection, taskId: "task-1" }), {
      goalId,
      taskId: "task-1",
      attempt: 1,
      runId: "r10b-executor",
      asyncDir: "/tmp/r10b-executor",
      workspacePath: "/tmp/r10b-workspace",
      leaseId,
      sessionId: ownerSessionId,
      baseHead,
      headAtDispatch: baseHead,
      executionRevision: 1,
      contractHash: projection.executionContractHash,
      agent: "executor",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GREEN protection: Root Broker stops only the exact registered owned identity and reuses official proof", async (t) => {
  const calls = [];
  const broker = new RootBrokerServer({
    rootSessionId: ownerSessionId,
    lifecycleSessionId: ownerSessionId,
    captureProcessBirthIdentity: async () => "r10b-birth",
    writeGrant: async () => "/tmp/r10b-no-grant",
    terminalTimeoutMs: 20,
    upstream: {
      async ping() { return {}; },
      async stop(request) {
        calls.push(request);
        broker.observeTerminal({ version: 1, runId: "r10b-executor", runnerProcessInstanceId: "r10b-runner", state: "observed", observedAt: 1_700_000_000_000, instances: [{ processInstanceId: "r10b-runner", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 0, signal: null }] });
      },
      async dispose() {},
    },
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  const exact = authority({ contractHash, executionRevision: 1 });
  const request = hostRequest(exact);
  await authorize(broker, exact);
  broker.persistGoalBindingAuthority({ version: "root-broker.goal-run-binding-authority.v2", ticketId: "d".repeat(64), ...exact });
  await broker.observeStarted({ runId: "r10b-executor", id: "r10b-executor", agent: "executor", pid: 43210, asyncDir: "/tmp/r10b-executor", sessionId: ownerSessionId });
  for (const wrong of [{ ...request, runId: "other-run" }, { ...request, asyncDir: "/tmp/other" }, { ...request, sessionId: "other-session" }, { ...request, goalId: "other-goal" }, { ...request, taskId: "other-task" }, { ...request, attempt: 2 }, { ...request, contractHash: "e".repeat(64) }, { ...request, workspacePath: "/tmp/other-workspace" }, { ...request, leaseId: "e".repeat(64) }, { ...request, baseHead: "e".repeat(40) }, { ...request, headAtDispatch: "e".repeat(40) }, { ...request, executionRevision: 2 }]) {
    assert.equal((await broker.stopGoalOwnedRun(wrong)).state, "attention");
    assert.equal(calls.length, 0);
  }
  assert.equal((await broker.stopGoalOwnedRun(request)).state, "observed");
  assert.equal((await broker.stopGoalOwnedRun(request)).state, "observed");
  assert.deepEqual(calls, [{ runId: "r10b-executor", dir: "/tmp/r10b-executor" }]);
  assert.equal(broker.inspectExecutionProof("r10b-executor").terminal.outcome, "succeeded");
});


test("GREEN protection: facade-only and conflicted registrations cannot stop a 13-field Host request", async (t) => {
  const calls = [];
  const broker = new RootBrokerServer({ rootSessionId: ownerSessionId, lifecycleSessionId: ownerSessionId, captureProcessBirthIdentity: async () => "r10b-birth", writeGrant: async () => "/tmp/r10b-no-grant", upstream: { async ping() { return {}; }, async stop(request) { calls.push(request); }, async dispose() {} } });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  const exact = authority(); const request = hostRequest(exact);
  broker.registerFacadeRun({ runId: exact.runId, asyncDir: exact.asyncDir, sessionId: exact.sessionId, pid: 43210, agent: "executor", kind: "executor" });
  assert.equal((await broker.stopGoalOwnedRun(request)).state, "attention");
  const conflicted = new RootBrokerServer({ rootSessionId: ownerSessionId, lifecycleSessionId: ownerSessionId, captureProcessBirthIdentity: async () => "r10b-birth", writeGrant: async () => "/tmp/r10b-no-grant", upstream: { async ping() { return {}; }, async stop(request) { calls.push(request); }, async dispose() {} } });
  t.after(() => conflicted.closeRootSession().catch(() => undefined));
  await authorize(conflicted, exact); conflicted.persistGoalBindingAuthority({ version: "root-broker.goal-run-binding-authority.v2", ticketId: "d".repeat(64), ...exact });
  await conflicted.observeStarted({ runId: exact.runId, id: exact.runId, agent: "reviewer", pid: 43210, asyncDir: exact.asyncDir, sessionId: exact.sessionId });
  assert.equal((await conflicted.stopGoalOwnedRun(request)).state, "attention");
  assert.deepEqual(calls, []);
  conflicted.observeTerminal({ version: 1, runId: exact.runId, runnerProcessInstanceId: "r10b-conflict-runner", state: "observed", observedAt: 1_700_000_000_000, instances: [{ processInstanceId: "r10b-conflict-runner", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 1, signal: null }] });
});

test("GREEN protection: missing official proof returns attention without terminal fabrication", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId: "r10b-proof-missing", lifecycleSessionId: "r10b-proof-missing", captureProcessBirthIdentity: async () => "r10b-birth", writeGrant: async () => "/tmp/r10b-no-grant", terminalTimeoutMs: 5, artifactPollIntervalMs: 1, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await broker.registerAuthorizedRun(createRunAuthorization({ kind: "coding", binding: { runId: "r10b-missing", asyncDir: "/tmp/r10b-missing", sessionId: "r10b-proof-missing", pid: 43211, agentProfile: "executor" }, goal: null }));
  await broker.observeStarted({ runId: "r10b-missing", id: "r10b-missing", agent: "executor", pid: 43211, asyncDir: "/tmp/r10b-missing", sessionId: "r10b-proof-missing" });
  assert.deepEqual(await broker.stopGoalOwnedRun(hostRequest(authority({ runId: "r10b-missing", asyncDir: "/tmp/r10b-missing", sessionId: "r10b-proof-missing" }))), { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
  assert.equal(broker.inspectExecutionProof("r10b-missing").terminal, null);
});
