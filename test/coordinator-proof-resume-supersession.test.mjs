import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoordinatorProofOutbox } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const proof = (digit, runId = "run-source") => ({ state: "observed", conflict: false, runId, rootSessionId: "root-a", asyncDir: "/var/tmp/async", processInstance: `runner-${digit}`, proofId: `${digit}`.repeat(64) });

test("supersede 移除 pending 旧 proof：replay 不投递、不形成 debt、状态可审计", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "proof-supersession-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outbox = createCoordinatorProofOutbox(dir);
  await outbox.enqueue(proof(1));
  assert.equal((await outbox.status("1".repeat(64))).state, "pending");

  const record = await outbox.supersede({ sourceProofId: "1".repeat(64), sourceRunId: "run-source", resumedRunId: "run-resumed", resumeIntentId: "intent-1" });
  assert.equal(record.sourceRunId, "run-source");
  assert.equal(record.resumedRunId, "run-resumed");

  const status = await outbox.status("1".repeat(64));
  assert.equal(status.state, "superseded");
  assert.equal(status.supersession.resumeIntentId, "intent-1");
  const replay = await outbox.replay(async () => { throw new Error("must not deliver superseded proof"); });
  assert.equal(replay.delivered, 0);
  assert.equal(replay.pending, 0);
  assert.deepEqual(await outbox.debts(), []);
});

test("supersede 幂等；不同 resumedRun 拒绝；superseded proof 不可重新入队或记 debt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "proof-supersession-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outbox = createCoordinatorProofOutbox(dir);
  await outbox.enqueue(proof(2));
  const first = await outbox.supersede({ sourceProofId: "2".repeat(64), sourceRunId: "run-source", resumedRunId: "run-resumed", resumeIntentId: "intent-1" });
  const replayed = await outbox.supersede({ sourceProofId: "2".repeat(64), sourceRunId: "run-source", resumedRunId: "run-resumed", resumeIntentId: "intent-1" });
  assert.equal(replayed.supersededAt, first.supersededAt);
  await assert.rejects(() => outbox.supersede({ sourceProofId: "2".repeat(64), sourceRunId: "run-source", resumedRunId: "run-forged", resumeIntentId: "intent-1" }), /identity mismatch|different/i);
  await assert.rejects(() => outbox.supersede({ sourceProofId: "2".repeat(64), sourceRunId: "run-source", resumedRunId: "run-source", resumeIntentId: "intent-1" }), /different/i);

  await outbox.enqueue(proof(2));
  assert.equal((await outbox.status("2".repeat(64))).state, "superseded");
  await outbox.recordDebt({ proofId: "2".repeat(64), runId: "run-source", reason: "late debt" });
  assert.deepEqual(await outbox.debts(), []);
  const replay = await outbox.replay(async () => { throw new Error("must not deliver superseded proof"); });
  assert.equal(replay.pending, 0);
});

test("supersede 一并失效同一 source run 的其余 pending proof", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "proof-supersession-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outbox = createCoordinatorProofOutbox(dir);
  await outbox.enqueue(proof(3));
  await outbox.enqueue(proof(4));
  await outbox.supersede({ sourceProofId: "3".repeat(64), sourceRunId: "run-source", resumedRunId: "run-resumed", resumeIntentId: "intent-1" });
  assert.equal((await outbox.status("3".repeat(64))).state, "superseded");
  assert.equal((await outbox.status("4".repeat(64))).state, "superseded");
  const replay = await outbox.replay(async () => { throw new Error("must not deliver superseded proof"); });
  assert.equal(replay.pending, 0);
  assert.deepEqual(await outbox.debts(), []);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "managed-proof-supersession-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  const repositoryId = createHash("sha256").update(git(originRoot, "rev-parse", "--git-common-dir").startsWith("/")
    ? git(originRoot, "rev-parse", "--git-common-dir") : join(originRoot, git(originRoot, "rev-parse", "--git-common-dir"))).digest("hex");
  const coordinator = createCoordinatorServer({ endpoint: join(root, "coordinator.sock"), repositoryId, stateRoot, idleGraceMs: 10_000,
    challengeBroker: async (registry) => ({ nonce: "n", repositoryId: registry.repositoryId, coordinatorInstanceId: "i", rootSessionId: registry.rootSessionId, brokerProcessIdentity: "b".repeat(64) }) });
  t.after(async () => {
    await coordinator.close();
    try {
      for (const line of git(originRoot, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== originRoot) spawnSync("git", ["worktree", "remove", "--force", line.slice(9)], { cwd: originRoot });
      }
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return { root, originRoot, stateRoot, repositoryId, baseCommit: git(originRoot, "rev-parse", "HEAD"), coordinator };
}

async function connectRealClient(f, rootSessionId = "root-a") {
  return connectRepositoryCoordinator({ repositoryId: f.repositoryId }, { protocol: "pi-root-subagent-broker-registry.v1", rootSessionId, endpoint: "broker.sock", pid: process.pid, processBirthIdentity: "b".repeat(64) }, {
    metadata: { protocol: "repository-workspace-coordinator.v1", repositoryId: f.repositoryId, storageRepositoryId: f.repositoryId, endpoint: join(f.root, "coordinator.sock"), instanceId: f.coordinator.instanceId, pid: process.pid, birthIdentity: "c".repeat(64), canonicalStateRoot: f.stateRoot },
  });
}

function request(f, workspaceId, owner) {
  return createManagedWorkspaceRequestV2({
    workspaceId,
    owner: { kind: "standalone-subagent", rootSessionId: owner, toolCallId: `tool-${workspaceId}` },
    originRoot: f.originRoot,
    requestedCwd: join(f.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: "a".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] },
  });
}

async function allocateCandidate(f, workspaceId, owner, filename) {
  const receipt = f.coordinator.internal.workspaceService.ensureAllocated(request(f, workspaceId, owner));
  const asyncDir = join(f.root, `async-${workspaceId}`);
  const run = { runId: `run-${workspaceId}`, asyncDir };
  f.coordinator.internal.workspaceService.bindRun({ workspaceId, run });
  await writeFile(join(receipt.path, "src", filename), `${workspaceId}\n`);
  git(receipt.path, "add", ".");
  git(receipt.path, "commit", "-m", workspaceId);
  return { receipt, run, asyncDir, head: git(receipt.path, "rev-parse", "HEAD"), binding: { workspaceId, leaseId: receipt.leaseId, ownerScope: { kind: "standalone-subagent", rootSessionId: owner }, runId: run.runId } };
}

function enqueue(f, candidate) {
  return f.coordinator.internal.enqueueIntegration({
    requestId: `request-${candidate.receipt.workspaceId}`,
    workspaceId: candidate.receipt.workspaceId,
    leaseId: candidate.receipt.leaseId,
    strategy: "rebase-ff",
    targetRef: "refs/heads/main",
    authorizedWorkspaceHead: candidate.head,
    observedTargetHead: f.baseCommit,
  }, candidate.binding);
}

test("activation 后旧 proof superseded，新 run proof 正常结算并释放 workspace", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const client = await connectRealClient(f, "root-a");
  t.after(() => client.close());
  const head = await allocateCandidate(f, "head", "root-a", "head.txt");
  const follower = await allocateCandidate(f, "follower", "root-a", "follower.txt");
  const headItem = enqueue(f, head);
  const followerItem = enqueue(f, follower);
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(headItem.queueItemId, head.binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: headItem.queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: head.head }, head.binding);

  const oldProof = { state: "observed", conflict: false, runId: follower.binding.runId, rootSessionId: "root-a", asyncDir: follower.asyncDir, processInstance: "runner-9", proofId: "9".repeat(64) };
  await assert.rejects(() => client.recordTerminalProof({ workspaceId: follower.binding.workspaceId, ownerScope: follower.binding.ownerScope, proof: oldProof }), /pending|completed child integration/i);
  assert.equal((await f.coordinator.proofOutbox.status(oldProof.proofId)).state, "pending");

  const intent = f.coordinator.internal.integrationQueue.listResumeIntents().at(-1);
  const resumedRun = { runId: "run-follower-resumed", asyncDir: join(f.root, "async-follower-resumed"), sessionId: "session-resumed", pid: 4321, agentProfile: "executor" };
  await client.activateResume({ resumeIntentId: intent.resumeIntentId, workspaceId: follower.binding.workspaceId, leaseId: follower.binding.leaseId,
    sourceRunId: follower.binding.runId, resumedRun, ownerScope: follower.binding.ownerScope, generation: intent.generation, authorization: "root" });

  const superseded = await f.coordinator.proofOutbox.status(oldProof.proofId);
  assert.equal(superseded.state, "superseded");
  assert.equal(superseded.supersession.resumedRunId, resumedRun.runId);
  assert.deepEqual(await f.coordinator.proofOutbox.debts(), []);

  // resumed child 完成集成：以新 run binding 推进 FIFO。
  const resumedBinding = { workspaceId: follower.binding.workspaceId, leaseId: follower.binding.leaseId, ownerScope: follower.binding.ownerScope, runId: resumedRun.runId };
  const admission = f.coordinator.internal.awaitIntegrationAdmission(followerItem.queueItemId, resumedBinding);
  git(follower.receipt.path, "rebase", admission.targetHead);
  const rebasedHead = git(follower.receipt.path, "rev-parse", "HEAD");
  const completed = f.coordinator.internal.publishRebasedCandidate({ queueItemId: followerItem.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: rebasedHead }, resumedBinding);
  assert.equal(completed.state, "completed");

  // 旧 proof 的迟到投递保持 superseded，不形成 debt。
  await assert.rejects(() => client.recordTerminalProof({ workspaceId: follower.binding.workspaceId, ownerScope: follower.binding.ownerScope, proof: oldProof }), /pending/i);
  assert.equal((await f.coordinator.proofOutbox.status(oldProof.proofId)).state, "superseded");
  assert.deepEqual(await f.coordinator.proofOutbox.debts(), []);

  // 新 run 的 authoritative proof 正常结算并释放 workspace。
  const newProof = { state: "observed", conflict: false, runId: resumedRun.runId, rootSessionId: "root-a", asyncDir: resumedRun.asyncDir, processInstance: "runner-resumed", proofId: "8".repeat(64) };
  const receipt = await client.recordTerminalProof({ workspaceId: follower.binding.workspaceId, ownerScope: follower.binding.ownerScope, proof: newProof });
  assert.equal(receipt.accepted, true);
  const owned = f.coordinator.internal.workspaceService.listOwned({ ownerScope: follower.binding.ownerScope });
  assert.equal(owned.find((entry) => entry.workspaceId === follower.binding.workspaceId).state, "released");
});
