import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const contract = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-contract.ts");
const { createIntegrationResumeIntentV1, parseIntegrationResumeIntentV1, parseRecoveryResumeActivationV1, progressFingerprint } = contract;

const LEASE = "a".repeat(64);
const CONFLICT = "b".repeat(64);

function queueItem(overrides = {}) {
  return {
    version: "workspace-integration-queue-item.v1",
    queueItemId: "queue-item-1",
    requestId: "req-1",
    repositoryId: CONFLICT,
    sequence: 1,
    workspaceId: "ws-1",
    leaseId: LEASE,
    ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" },
    strategy: "rebase-ff",
    childRunId: "run-source-1",
    targetRef: "refs/heads/main",
    authorizedWorkspaceHead: "c".repeat(40),
    autoManaged: true,
    admissionGeneration: 2,
    attempt: 1,
    state: "queued",
    revision: 3,
    conflictDigest: null,
    ...overrides,
  };
}

function intentInput(overrides = {}) {
  return {
    queueItem: queueItem(),
    sourceAsyncDir: "/var/tmp/async/run-source-1",
    sourceProofId: "proof-1",
    ...overrides,
  };
}

function activationFor(intent, overrides = {}) {
  return {
    version: "recovery-resume-activation.v1",
    resumeIntentId: intent.resumeIntentId,
    queueItemId: intent.queueItemId,
    workspaceId: intent.workspaceId,
    leaseId: intent.leaseId,
    sourceRunId: intent.sourceRunId,
    resumedRun: {
      runId: "run-resumed-1",
      asyncDir: "/var/tmp/async/run-resumed-1",
      sessionId: "session-1",
      pid: 4321,
      agentProfile: "executor",
    },
    ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" },
    generation: intent.generation,
    authorization: "root",
    ...overrides,
  };
}

test("createIntegrationResumeIntentV1 构造冻结的 waiting-head intent", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  assert.equal(intent.version, "integration-resume-intent.v1");
  assert.equal(intent.resumeIntentId.length > 0, true);
  assert.equal(intent.queueItemId, "queue-item-1");
  assert.equal(intent.workspaceId, "ws-1");
  assert.equal(intent.leaseId, LEASE);
  assert.deepEqual(intent.ownerScope, { kind: "standalone-subagent", rootSessionId: "root-1" });
  assert.equal(intent.sourceRunId, "run-source-1");
  assert.equal(intent.sourceAsyncDir, "/var/tmp/async/run-source-1");
  assert.equal(intent.sourceProofId, "proof-1");
  assert.equal(intent.attempt, 1);
  assert.equal(intent.generation, 2);
  assert.equal(intent.queueRevision, 3);
  assert.equal(intent.queueState, "queued");
  assert.equal(intent.conflictDigest, null);
  assert.match(intent.progressFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(intent.noProgressCount, 0);
  assert.equal(intent.requiredAction, "resume-child");
  assert.equal(intent.state, "waiting-head");
  assert.equal(intent.resumedRun, null);
  assert.deepEqual(intent.delivery, { state: "pending", attempts: 0 });
  assert.ok(!Number.isNaN(Date.parse(intent.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(intent.updatedAt)));
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.ownerScope), true);
  assert.equal(Object.isFrozen(intent.delivery), true);
});

test("createIntegrationResumeIntentV1 透传冲突摘要与 attempt", () => {
  const intent = createIntegrationResumeIntentV1(intentInput({
    queueItem: queueItem({ state: "resolving-conflict", conflictDigest: CONFLICT, childRunId: "run-source-2" }),
    attempt: 3,
  }));
  assert.equal(intent.queueState, "resolving-conflict");
  assert.equal(intent.conflictDigest, CONFLICT);
  assert.equal(intent.attempt, 3);
  assert.equal(intent.sourceRunId, "run-source-2");
});

test("createIntegrationResumeIntentV1 拒绝非法输入", () => {
  assert.throws(() => createIntegrationResumeIntentV1(intentInput({ queueItem: queueItem({ childRunId: undefined }) })), TypeError);
  assert.throws(() => createIntegrationResumeIntentV1(intentInput({ queueItem: queueItem({ state: "completed" }) })), TypeError);
  assert.throws(() => createIntegrationResumeIntentV1(intentInput({ queueItem: queueItem({ state: "rebasing" }) })), TypeError);
  assert.throws(() => createIntegrationResumeIntentV1(intentInput({ sourceAsyncDir: "relative/path" })), TypeError);
  assert.throws(() => createIntegrationResumeIntentV1(intentInput({ sourceProofId: "" })), TypeError);
  assert.throws(() => createIntegrationResumeIntentV1(intentInput({ attempt: 0 })), TypeError);
  assert.throws(() => createIntegrationResumeIntentV1(intentInput({ queueItem: queueItem({ conflictDigest: "not-a-digest" }) })), TypeError);
});

test("intent JSON 往返 parse 保留全部字段并冻结", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  const parsed = parseIntegrationResumeIntentV1(JSON.parse(JSON.stringify(intent)));
  assert.deepEqual(parsed, intent);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.ownerScope), true);
});

test("parseIntegrationResumeIntentV1 拒绝未知字段（token/prompt 注入）", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  for (const key of ["ownerToken", "prompt", "capability", "extra"]) {
    const poisoned = { ...JSON.parse(JSON.stringify(intent)), [key]: "x" };
    assert.throws(() => parseIntegrationResumeIntentV1(poisoned), TypeError, `unknown field ${key} must be rejected`);
  }
});

test("parseIntegrationResumeIntentV1 拒绝 foreign owner", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  assert.throws(() => parseIntegrationResumeIntentV1(intent, { rootSessionId: "root-other" }), TypeError);
  assert.doesNotThrow(() => parseIntegrationResumeIntentV1(intent, { rootSessionId: "root-1" }));
});

test("parseIntegrationResumeIntentV1 拒绝非法状态与路径", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  const withState = (state) => JSON.parse(JSON.stringify({ ...intent, state }));
  assert.throws(() => parseIntegrationResumeIntentV1(withState("bogus")), TypeError);
  assert.throws(() => parseIntegrationResumeIntentV1(JSON.parse(JSON.stringify({ ...intent, sourceAsyncDir: "rel" }))), TypeError);
  assert.throws(() => parseIntegrationResumeIntentV1(JSON.parse(JSON.stringify({ ...intent, queueState: "rebasing" }))), TypeError);
  assert.throws(() => parseIntegrationResumeIntentV1(JSON.parse(JSON.stringify({ ...intent, delivery: { state: "bogus", attempts: 0 } }))), TypeError);
  assert.throws(() => parseIntegrationResumeIntentV1(JSON.parse(JSON.stringify({ ...intent, leaseId: "zz" }))), TypeError);
});

test("activation 合法往返并冻结", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  const activation = parseRecoveryResumeActivationV1(activationFor(intent), intent);
  assert.equal(activation.version, "recovery-resume-activation.v1");
  assert.equal(activation.authorization, "root");
  assert.equal(activation.resumedRun.runId, "run-resumed-1");
  assert.equal(activation.resumedRun.asyncDir, "/var/tmp/async/run-resumed-1");
  assert.equal(activation.resumedRun.pid, 4321);
  assert.equal(Object.isFrozen(activation), true);
  assert.equal(Object.isFrozen(activation.resumedRun), true);
  assert.deepEqual(JSON.parse(JSON.stringify(activation)), activationFor(intent));
});

test("activation 拒绝与 intent 不一致的身份字段", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { resumeIntentId: "other" }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { queueItemId: "other" }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { workspaceId: "other" }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { leaseId: "d".repeat(64) }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { sourceRunId: "run-other" }), intent), TypeError);
});

test("activation 拒绝 run 相同、generation 倒退与 foreign owner", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, {
    resumedRun: { runId: "run-source-1", asyncDir: "/var/tmp/async/x", sessionId: "s", pid: 1, agentProfile: "executor" },
  }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { generation: intent.generation - 1 }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { generation: intent.generation + 1 }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, {
    ownerScope: { kind: "standalone-subagent", rootSessionId: "root-other" },
  }), intent), TypeError);
});

test("activation 拒绝非 root 授权、未知字段与非法 resumedRun", () => {
  const intent = createIntegrationResumeIntentV1(intentInput());
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, { authorization: "child" }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1({ ...activationFor(intent), extra: 1 }, intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, {
    resumedRun: { runId: "run-resumed-1", asyncDir: "rel", sessionId: "s", pid: 1, agentProfile: "executor" },
  }), intent), TypeError);
  assert.throws(() => parseRecoveryResumeActivationV1(activationFor(intent, {
    resumedRun: { runId: "run-resumed-1", asyncDir: "/var/tmp/async/x", sessionId: "s", pid: -1, agentProfile: "executor" },
  }), intent), TypeError);
});

test("progressFingerprint 对进展字段敏感且对无关字段稳定", () => {
  const base = queueItem({ conflictDigest: CONFLICT, candidateHead: "e".repeat(40) });
  const fingerprint = progressFingerprint(base);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(progressFingerprint(queueItem({ conflictDigest: CONFLICT, candidateHead: "e".repeat(40) })), fingerprint);
  assert.notEqual(progressFingerprint(queueItem({ ...base, state: "admitted" })), fingerprint);
  assert.notEqual(progressFingerprint(queueItem({ ...base, revision: 4 })), fingerprint);
  assert.notEqual(progressFingerprint(queueItem({ ...base, admissionGeneration: 3 })), fingerprint);
  assert.notEqual(progressFingerprint(queueItem({ ...base, conflictDigest: "f".repeat(64) })), fingerprint);
  assert.notEqual(progressFingerprint(queueItem({ ...base, candidateHead: "a".repeat(40) })), fingerprint);
  assert.equal(progressFingerprint(queueItem({ ...base, sequence: 99, requestId: "req-other", queueItemId: "other" })), fingerprint);
});

test("progressFingerprint 拒绝非法 queue item", () => {
  assert.throws(() => progressFingerprint({}), TypeError);
  assert.throws(() => progressFingerprint(queueItem({ state: "bogus" })), TypeError);
  assert.throws(() => progressFingerprint(queueItem({ revision: -1 })), TypeError);
  assert.throws(() => progressFingerprint(queueItem({ admissionGeneration: "x" })), TypeError);
  assert.throws(() => progressFingerprint(queueItem({ conflictDigest: "nope" })), TypeError);
  assert.throws(() => progressFingerprint(queueItem({ candidateHead: "nope" })), TypeError);
});
