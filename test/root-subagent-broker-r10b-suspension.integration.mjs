import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveOwnedExecutorStopRequest } from "../src/goal-engine/suspension.ts";
import { appendEvent, loadProjection } from "../src/goal-engine/store.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../src/goal-engine/obligation-contract.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const goalId = "r10b-goal";
const ownerSessionId = "root-r10b-session";
const baseHead = "a".repeat(40);
const contractHash = "b".repeat(64);
const leaseId = "c".repeat(64);
const hash = (n) => String(n).padStart(64, "0");
const authority = (overrides = {}) => ({ goalId, taskId: "task-1", attempt: 1, runId: "r10b-executor", asyncDir: "/tmp/r10b-executor", workspacePath: "/tmp/r10b-workspace", leaseId, sessionId: ownerSessionId, baseHead, headAtDispatch: baseHead, executionRevision: 1, contractHash, agent: "executor", ...overrides });

function writeRecoveryArtifacts(authority, terminal) {
  const runtimeTerminal = { ...terminal, sessionId: authority.sessionId, asyncDir: authority.asyncDir, agent: "executor" };
  const sidecar = { version: "root-broker.goal-binding-authority.v1", ticketId: "d".repeat(64), ...authority };
  for (const [name, value] of [["root-broker.goal-binding-authority.v1.json", sidecar], ["status.json", { runId: authority.runId, sessionId: authority.sessionId, asyncDir: authority.asyncDir, agent: "executor", state: "failed", processTerminal: runtimeTerminal }], ["process-terminal.json", runtimeTerminal]]) {
    const file = join(authority.asyncDir, name); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); chmodSync(file, 0o600);
  }
}

function event(type, data, number) {
  return { schemaVersion: "goal-runtime.v1", eventId: `r10b-${number}`, goalId, occurredAt: `2026-08-13T00:00:${String(number).padStart(2, "0")}.000Z`, type, data };
}

function append(root, projection, type, data, number) {
  return appendEvent(root, event(type, data, number), projection?.version ?? 0);
}

function approvalHash(executionContractHash) {
  return createHash("sha256").update(JSON.stringify({ baseHead, executionContractHash, goalId, proposalId: "r10b-approval", sessionId: ownerSessionId })).digest("hex");
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
    assert.deepEqual(deriveOwnedExecutorStopRequest({ projection, taskId: "task-1" }), {
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
  await broker.observeStarted({ runId: "r10b-executor", id: "r10b-executor", agent: "executor", pid: 43210, asyncDir: "/tmp/r10b-executor", sessionId: ownerSessionId });
  const exact = authority({ contractHash, executionRevision: 1 });
  for (const wrong of [{ ...exact, runId: "other-run" }, { ...exact, asyncDir: "/tmp/other" }, { ...exact, sessionId: "other-session" }]) {
    assert.equal((await broker.stopGoalOwnedRun(wrong)).state, "attention");
    assert.equal(calls.length, 0);
  }
  assert.equal((await broker.stopGoalOwnedRun(exact)).state, "observed");
  assert.equal((await broker.stopGoalOwnedRun(exact)).state, "observed");
  assert.deepEqual(calls, [{ runId: "r10b-executor", dir: "/tmp/r10b-executor" }]);
  assert.equal(broker.inspectExecutorProof("r10b-executor").terminal.outcome, "succeeded");
});

test("RED: fresh Broker recovers an exact failed Executor terminal artifact without an owned-run memory entry", async (t) => {
  const asyncDir = mkdtempSync(join(tmpdir(), "r10b-restart-terminal-"));
  const runId = "r10b-restart-failed";
  const sessionId = "r10b-restart-session";
  const terminal = { version: 1, runId, runnerProcessInstanceId: "r10b-restart-runner", state: "observed", observedAt: 1_700_000_000_000, instances: [{ processInstanceId: "r10b-restart-runner", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 1, signal: null }] };
  const recoveredAuthority = authority({ runId, asyncDir, sessionId, contractHash, executionRevision: 1 });
  writeRecoveryArtifacts(recoveredAuthority, terminal);
  const stopped = [];
  const upstream = { async ping() { return {}; }, async stop(request) { stopped.push(request); }, async dispose() {} };
  const brokerA = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, captureProcessBirthIdentity: async () => "restart-birth", writeGrant: async () => "/tmp/r10b-no-grant", upstream });
  await brokerA.observeStarted({ runId, id: runId, agent: "executor", pid: 43212, asyncDir, sessionId });
  brokerA.observeTerminal(terminal);
  await brokerA.closeRootSession();
  const broker = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, writeGrant: async () => "/tmp/r10b-no-grant", upstream });
  t.after(async () => { await broker.closeRootSession().catch(() => undefined); rmSync(asyncDir, { recursive: true, force: true }); });
  assert.equal(broker.ownedRuns.has(runId), false, "fresh Broker has no old owned run");
  const recovered = await broker.stopGoalOwnedRun(recoveredAuthority);
  assert.equal(recovered.state, "observed");
  assert.equal(recovered.proof.runId, runId);
  assert.equal(recovered.proof.instances[0].exitCode, 1, "failed is still a terminal observation");
  assert.deepEqual(stopped, [], "terminal recovery never stops a process");
});

test("GREEN protection: terminal recovery fails closed for identity, nonterminal, conflict, and missing-artifact drift", async (t) => {
  const asyncDir = mkdtempSync(join(tmpdir(), "r10b-recovery-matrix-"));
  const runId = "r10b-recovery-matrix";
  const sessionId = "r10b-recovery-session";
  const terminal = { version: 1, runId, runnerProcessInstanceId: "matrix-runner", state: "observed", observedAt: 1_700_000_000_000, instances: [{ processInstanceId: "matrix-runner", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 1, signal: null }] };
  const stopped = [];
  const broker = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, writeGrant: async () => "/tmp/r10b-no-grant", upstream: { async ping() { return {}; }, async stop(request) { stopped.push(request); }, async dispose() {} } });
  t.after(async () => { await broker.closeRootSession().catch(() => undefined); rmSync(asyncDir, { recursive: true, force: true }); });
  for (const [label, status, sidecar] of [
    ["active", { ...authority({ runId, asyncDir, sessionId }), state: "running", steps: [{ agent: "executor" }], processTerminal: { ...terminal, sessionId, asyncDir, agent: "executor" } }, { ...terminal, sessionId, asyncDir, agent: "executor" }],
    ["session", { ...authority({ runId, asyncDir, sessionId }), sessionId: "foreign", state: "failed", steps: [{ agent: "executor" }], processTerminal: { ...terminal, sessionId, asyncDir, agent: "executor" } }, { ...terminal, sessionId, asyncDir, agent: "executor" }],
    ["agent", { runId, sessionId, asyncDir, agent: "reviewer", state: "failed", processTerminal: { ...terminal, sessionId, asyncDir, agent: "executor" } }, { ...terminal, sessionId, asyncDir, agent: "executor" }],
    ["conflict", { ...authority({ runId, asyncDir, sessionId }), state: "failed", steps: [{ agent: "executor" }], processTerminal: { ...terminal, sessionId, asyncDir, agent: "executor", observedAt: terminal.observedAt + 1 } }, { ...terminal, sessionId, asyncDir, agent: "executor" }],
    ["terminal-identity-missing", { ...authority({ runId, asyncDir, sessionId }), state: "failed", steps: [{ agent: "executor" }], processTerminal: terminal }, terminal],
    ["missing", { ...authority({ runId, asyncDir, sessionId }), state: "failed", steps: [{ agent: "executor" }] }, undefined],
  ]) {
    writeFileSync(join(asyncDir, "root-broker.goal-binding-authority.v1.json"), JSON.stringify({ version: "root-broker.goal-binding-authority.v1", ticketId: "d".repeat(64), ...authority({ runId, asyncDir, sessionId }) }), { mode: 0o600 }); chmodSync(join(asyncDir, "root-broker.goal-binding-authority.v1.json"), 0o600);
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify(status), { mode: 0o600 }); chmodSync(join(asyncDir, "status.json"), 0o600);
    if (sidecar) { writeFileSync(join(asyncDir, "process-terminal.json"), JSON.stringify(sidecar), { mode: 0o600 }); chmodSync(join(asyncDir, "process-terminal.json"), 0o600); } else rmSync(join(asyncDir, "process-terminal.json"), { force: true });
    assert.deepEqual(await broker.stopGoalOwnedRun(authority({ runId, asyncDir, sessionId })), { state: "attention", code: "OWNED_STOP_RECOVERY_UNAVAILABLE" }, label);
    assert.equal(broker.ownedRuns.size, 0, `${label} did not register an owner`);
  }
  assert.deepEqual(stopped, []);
});

test("GREEN protection: missing official proof returns attention without terminal fabrication", async (t) => {
  const broker = new RootBrokerServer({ rootSessionId: "r10b-proof-missing", lifecycleSessionId: "r10b-proof-missing", captureProcessBirthIdentity: async () => "r10b-birth", writeGrant: async () => "/tmp/r10b-no-grant", terminalTimeoutMs: 5, artifactPollIntervalMs: 1, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await broker.observeStarted({ runId: "r10b-missing", id: "r10b-missing", agent: "executor", pid: 43211, asyncDir: "/tmp/r10b-missing", sessionId: "r10b-proof-missing" });
  assert.deepEqual(await broker.stopGoalOwnedRun(authority({ runId: "r10b-missing", asyncDir: "/tmp/r10b-missing", sessionId: "r10b-proof-missing" })), { state: "attention", code: "OWNED_STOP_TIMEOUT" });
  assert.equal(broker.inspectExecutorProof("r10b-missing").terminal, null);
});
