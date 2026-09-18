import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "managed-recovery-rebind-"));
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

// 场景：head 正常完成，follower child 退出 → proof 触发 durable resume intent（pending）。
async function resumedScenario(t) {
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
  const proof = { state: "observed", conflict: false, runId: follower.binding.runId, rootSessionId: "root-a", asyncDir: follower.asyncDir, processInstance: "runner-9", proofId: "9".repeat(64) };
  await assert.rejects(() => client.recordTerminalProof({ workspaceId: follower.binding.workspaceId, ownerScope: follower.binding.ownerScope, proof }), /pending|completed child integration/i);
  const intent = f.coordinator.internal.integrationQueue.listResumeIntents().at(-1);
  assert.equal(intent.state, "pending");
  const resumedRun = { runId: "run-follower-resumed", asyncDir: join(f.root, "async-follower-resumed"), sessionId: "session-resumed", pid: 4321, agentProfile: "executor" };
  const activation = { resumeIntentId: intent.resumeIntentId, workspaceId: follower.binding.workspaceId, leaseId: follower.binding.leaseId,
    sourceRunId: follower.binding.runId, resumedRun, ownerScope: follower.binding.ownerScope, generation: intent.generation, authorization: "root" };
  return { f, client, head, follower, headItem, followerItem, intent, resumedRun, activation };
}

test("activate-resume 原子重绑 workspace 与 queue 到 resumed run 并保留 lease/generation/sequencer", async (t) => {
  const { f, client, follower, followerItem, intent, resumedRun, activation } = await resumedScenario(t);
  const queue = f.coordinator.internal.integrationQueue;
  const before = queue.getItem(followerItem.queueItemId);

  const result = await client.activateResume(activation);
  assert.equal(result.resumeIntent.state, "activated");
  assert.deepEqual(result.resumeIntent.resumedRun, resumedRun);
  assert.equal(result.workspace.run.runId, resumedRun.runId);
  assert.equal(result.workspace.run.asyncDir, resumedRun.asyncDir);

  const item = queue.getItem(followerItem.queueItemId);
  assert.equal(item.childRunId, resumedRun.runId);
  assert.equal(item.queueLeaseId, before.queueLeaseId);
  assert.equal(item.admissionGeneration, before.admissionGeneration);
  assert.equal(item.sequence, before.sequence);
  assert.equal(item.revision, before.revision + 1);

  const owned = f.coordinator.internal.workspaceService.listOwned({ ownerScope: follower.binding.ownerScope });
  assert.equal(owned.find((entry) => entry.workspaceId === follower.binding.workspaceId).run.runId, resumedRun.runId);

  // 重放幂等：不再叠加 revision。
  const replay = await client.activateResume(activation);
  assert.equal(replay.resumeIntent.state, "activated");
  assert.equal(queue.getItem(followerItem.queueItemId).revision, before.revision + 1);
  assert.equal(intent.resumeIntentId, replay.resumeIntent.resumeIntentId);
});

test("resumed binding 能以新 run 找回原 queue item", async (t) => {
  const { f, client, follower, followerItem, resumedRun, activation } = await resumedScenario(t);
  await client.activateResume(activation);
  const resumedBinding = { workspaceId: follower.binding.workspaceId, leaseId: follower.binding.leaseId, ownerScope: follower.binding.ownerScope, runId: resumedRun.runId };
  const item = f.coordinator.internal.integrationQueue.findByBinding(resumedBinding);
  assert.equal(item.queueItemId, followerItem.queueItemId);
  assert.equal(item.childRunId, resumedRun.runId);
});

test("foreign root 与错误身份拒绝激活", async (t) => {
  const { f, follower, intent, resumedRun, activation } = await resumedScenario(t);
  const foreign = await connectRealClient(f, "root-b");
  t.after(() => foreign.close());
  await assert.rejects(() => foreign.activateResume(activation), /owner scope denied|root authorization|required for recovery/i);

  await assert.rejects(async () => f.coordinator.internal.workspaceService.rebindRunForRecovery(
    { ...activation, leaseId: "d".repeat(64) },
    { authorizeResumeIntent: () => undefined },
  ), /lease|activation|does not match/i);
  const client = await connectRealClient(f, "root-a");
  t.after(() => client.close());
  await assert.rejects(() => client.activateResume({ ...activation, leaseId: "d".repeat(64) }), /does not match|activation/i);
  await assert.rejects(() => client.activateResume({ ...activation, sourceRunId: "run-other" }), /does not match|activation/i);
  await assert.rejects(() => client.activateResume({ ...activation, generation: intent.generation + 1 }), /does not match|activation/i);
  await assert.rejects(() => client.activateResume({ ...activation, authorization: "child" }), /root authorization/i);
  await assert.rejects(() => client.activateResume({ ...activation, resumedRun: { ...resumedRun, runId: follower.binding.runId } }), /differ|does not match|activation/i);
});

test("crash window：starting 后重放收敛", async (t) => {
  const { f, client, followerItem, intent, resumedRun, activation } = await resumedScenario(t);
  const queue = f.coordinator.internal.integrationQueue;
  const before = queue.getItem(followerItem.queueItemId);
  queue.markResumeStarting(intent.resumeIntentId, resumedRun);

  const result = await client.activateResume(activation);
  assert.equal(result.resumeIntent.state, "activated");
  assert.equal(queue.getItem(followerItem.queueItemId).childRunId, resumedRun.runId);
  assert.equal(queue.getItem(followerItem.queueItemId).revision, before.revision + 1);
});

test("crash window：workspace 重绑后重放收敛", async (t) => {
  const { f, client, followerItem, intent, resumedRun, activation } = await resumedScenario(t);
  const queue = f.coordinator.internal.integrationQueue;
  const service = f.coordinator.internal.workspaceService;
  const before = queue.getItem(followerItem.queueItemId);
  queue.markResumeStarting(intent.resumeIntentId, resumedRun);
  service.rebindRunForRecovery(activation, { authorizeResumeIntent: (input) => {
    if (input.resumeIntentId !== intent.resumeIntentId) throw new Error("resume intent does not authorize this rebind");
  } });

  const result = await client.activateResume(activation);
  assert.equal(result.resumeIntent.state, "activated");
  assert.equal(queue.getItem(followerItem.queueItemId).childRunId, resumedRun.runId);
  assert.equal(queue.getItem(followerItem.queueItemId).revision, before.revision + 1, "queue 重绑只发生一次");
});

test("crash window：queue 重绑后重放收敛", async (t) => {
  const { f, client, followerItem, intent, resumedRun, activation } = await resumedScenario(t);
  const queue = f.coordinator.internal.integrationQueue;
  const service = f.coordinator.internal.workspaceService;
  const before = queue.getItem(followerItem.queueItemId);
  queue.markResumeStarting(intent.resumeIntentId, resumedRun);
  service.rebindRunForRecovery(activation, { authorizeResumeIntent: () => undefined });
  queue.rebindChildRunForRecovery({ queueItemId: followerItem.queueItemId, resumeIntentId: intent.resumeIntentId, sourceRunId: activation.sourceRunId, resumedRunId: resumedRun.runId, generation: intent.generation });

  const result = await client.activateResume(activation);
  assert.equal(result.resumeIntent.state, "activated");
  assert.equal(queue.getItem(followerItem.queueItemId).revision, before.revision + 1, "queue 重绑不重复");
});

test("crash window：activated 后重放幂等", async (t) => {
  const { f, client, followerItem, resumedRun, activation } = await resumedScenario(t);
  const queue = f.coordinator.internal.integrationQueue;
  await client.activateResume(activation);
  const settled = queue.getItem(followerItem.queueItemId);

  const replay = await client.activateResume(activation);
  assert.equal(replay.resumeIntent.state, "activated");
  assert.equal(queue.getItem(followerItem.queueItemId).revision, settled.revision);
  assert.equal(queue.getItem(followerItem.queueItemId).childRunId, resumedRun.runId);
});

test("重复激活不同 resumed run 拒绝", async (t) => {
  const { f, client, activation } = await resumedScenario(t);
  await client.activateResume(activation);
  await assert.rejects(() => client.activateResume({ ...activation, resumedRun: { ...activation.resumedRun, runId: "run-follower-resumed-2" } }), /another resumed run|does not match|activation/i);
});

test("原 bindRun 仍禁止普通换 run", async (t) => {
  const { f, follower } = await resumedScenario(t);
  await assert.rejects(async () => f.coordinator.internal.workspaceService.bindRun({ workspaceId: follower.binding.workspaceId, run: { runId: "run-other", asyncDir: join(f.root, "async-other") } }), /MANAGED_WORKSPACE_RUN_CONFLICT|already bound to another run/i);
});
