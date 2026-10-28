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
  const root = await mkdtemp(join(tmpdir(), "managed-resume-intent-"));
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
  const sinkEvents = [];
  const challengeBroker = async (registry) => ({ nonce: "n", repositoryId: registry.repositoryId, coordinatorInstanceId: "i", rootSessionId: registry.rootSessionId, brokerProcessIdentity: "b".repeat(64) });
  const coordinator = createCoordinatorServer({ endpoint: join(root, "coordinator.sock"), repositoryId, stateRoot, idleGraceMs: 10_000, challengeBroker,
    recoveryEventSink: (event) => { sinkEvents.push(structuredClone(event)); return { state: "delivered" }; } });
  t.after(async () => {
    await coordinator.close();
    try {
      for (const line of git(originRoot, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== originRoot) spawnSync("git", ["worktree", "remove", "--force", line.slice(9)], { cwd: originRoot });
      }
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return { root, originRoot, stateRoot, repositoryId, baseCommit: git(originRoot, "rev-parse", "HEAD"), coordinator, sinkEvents };
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

function terminalProof(f, candidate, digit) {
  const d = String(digit);
  return { state: "observed", conflict: false, runId: candidate.binding.runId, rootSessionId: candidate.binding.ownerScope.rootSessionId, asyncDir: candidate.asyncDir, processInstance: `runner-${d}`, proofId: d.repeat(64) };
}

test("五个 terminal follower 只投递当前队首一个 resume event，队首完成后精确投递下一项", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const client = await connectRealClient(f, "root-a");
  t.after(() => client.close());
  const queue = f.coordinator.internal.integrationQueue;

  const candidates = [];
  const items = [];
  for (let index = 0; index < 6; index += 1) {
    const candidate = await allocateCandidate(f, `c${index}`, "root-a", `c${index}.txt`);
    candidates.push(candidate);
    items.push(enqueue(f, candidate));
  }
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(items[0].queueItemId, candidates[0].binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: items[0].queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: candidates[0].head }, candidates[0].binding);

  for (let index = 1; index <= 5; index += 1) {
    await assert.rejects(() => client.recordTerminalProof({ workspaceId: candidates[index].binding.workspaceId, ownerScope: candidates[index].binding.ownerScope, proof: terminalProof(f, candidates[index], index) }), /pending|completed child integration/i);
  }
  let resumeEvents = f.sinkEvents.filter((event) => event.requiredAction === "resume-child");
  assert.equal(resumeEvents.length, 1, "只有当前队首的 follower 投递一个 resume event");
  assert.equal(resumeEvents[0].queueItemId, items[1].queueItemId);
  assert.equal(resumeEvents[0].state, "pending");
  assert.equal(resumeEvents[0].attempt, 1);

  const intents = queue.listResumeIntents();
  assert.equal(intents.length, 5);
  assert.equal(intents.filter((intent) => intent.state === "pending").length, 1);
  assert.equal(intents.filter((intent) => intent.state === "waiting-head").length, 4);
  assert.ok(intents.every((intent) => intent.requiredAction === "resume-child"));

  const followerAdmission = f.coordinator.internal.awaitIntegrationAdmission(items[1].queueItemId, candidates[1].binding);
  git(candidates[1].receipt.path, "rebase", followerAdmission.targetHead);
  const rebasedHead = git(candidates[1].receipt.path, "rev-parse", "HEAD");
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: items[1].queueItemId, queueLeaseId: followerAdmission.queueLeaseId, candidateHead: rebasedHead }, candidates[1].binding);

  resumeEvents = f.sinkEvents.filter((event) => event.requiredAction === "resume-child");
  assert.equal(resumeEvents.length, 2, "队首完成后精确投递下一项");
  assert.equal(resumeEvents[1].queueItemId, items[2].queueItemId);
  const after = queue.listResumeIntents();
  assert.equal(after.find((intent) => intent.queueItemId === items[1].queueItemId).state, "completed");
  assert.equal(after.find((intent) => intent.queueItemId === items[2].queueItemId).state, "pending");
  assert.equal(after.filter((intent) => intent.state === "waiting-head").length, 3);

  await assert.rejects(() => client.recordTerminalProof({ workspaceId: candidates[2].binding.workspaceId, ownerScope: candidates[2].binding.ownerScope, proof: terminalProof(f, candidates[2], 2) }), /pending|completed child integration/i);
  assert.equal(f.sinkEvents.filter((event) => event.requiredAction === "resume-child").length, 2, "重复 proof 幂等，不重复投递");
  assert.equal(queue.listResumeIntents().length, 5, "重复 proof 不新增 intent");
});

test("同一 source run 的重复 proof 幂等返回，不产生新 attempt", async (t) => {
  const f = await fixture(t);
  const queue = f.coordinator.internal.integrationQueue;
  const head = await allocateCandidate(f, "head", "root-a", "head.txt");
  const follower = await allocateCandidate(f, "follower", "root-a", "follower.txt");
  const headItem = enqueue(f, head);
  const followerItem = enqueue(f, follower);
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(headItem.queueItemId, head.binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: headItem.queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: head.head }, head.binding);

  const first = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: follower.binding.runId, sourceAsyncDir: follower.asyncDir, sourceProofId: "1".repeat(64) });
  const replay = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: follower.binding.runId, sourceAsyncDir: follower.asyncDir, sourceProofId: "2".repeat(64) });
  assert.equal(replay.resumeIntentId, first.resumeIntentId);
  assert.equal(replay.attempt, 1);
  assert.equal(queue.listResumeIntents().length, 1);
});

test("resumed child 再次退出时前一 intent 标记 failed 并递增 attempt", async (t) => {
  const f = await fixture(t);
  const queue = f.coordinator.internal.integrationQueue;
  const head = await allocateCandidate(f, "head", "root-a", "head.txt");
  const follower = await allocateCandidate(f, "follower", "root-a", "follower.txt");
  const headItem = enqueue(f, head);
  const followerItem = enqueue(f, follower);
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(headItem.queueItemId, head.binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: headItem.queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: head.head }, head.binding);

  const first = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: follower.binding.runId, sourceAsyncDir: follower.asyncDir, sourceProofId: "1".repeat(64) });
  assert.equal(first.state, "waiting-head");
  const promoted = queue.promoteRecoverableHead();
  assert.equal(promoted.resumeIntentId, first.resumeIntentId);
  assert.equal(promoted.state, "pending");
  const resumedRun = { runId: "run-follower-resumed", asyncDir: join(f.root, "async-resumed"), sessionId: "session-1", pid: 4321, agentProfile: "executor" };
  queue.markResumeStarting(first.resumeIntentId, resumedRun);
  const started = queue.listResumeIntents().find((intent) => intent.resumeIntentId === first.resumeIntentId);
  assert.equal(started.state, "starting");
  assert.deepEqual(started.resumedRun, resumedRun);

  const second = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: resumedRun.runId, sourceAsyncDir: resumedRun.asyncDir, sourceProofId: "3".repeat(64) });
  assert.equal(second.attempt, 2);
  assert.equal(second.noProgressCount, 1);
  assert.equal(queue.listResumeIntents().find((intent) => intent.resumeIntentId === first.resumeIntentId).state, "failed");
});

test("进展 fingerprint 变化重置 noProgressCount", async (t) => {
  const f = await fixture(t);
  const queue = f.coordinator.internal.integrationQueue;
  const head = await allocateCandidate(f, "head", "root-a", "head.txt");
  const follower = await allocateCandidate(f, "follower", "root-a", "follower.txt");
  const headItem = enqueue(f, head);
  const followerItem = enqueue(f, follower);
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(headItem.queueItemId, head.binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: headItem.queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: head.head }, head.binding);
  const followerAdmission = f.coordinator.internal.awaitIntegrationAdmission(followerItem.queueItemId, follower.binding);

  const first = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: follower.binding.runId, sourceAsyncDir: follower.asyncDir, sourceProofId: "1".repeat(64) });
  queue.promoteRecoverableHead();
  queue.markResumeStarting(first.resumeIntentId, { runId: "run-follower-r1", asyncDir: join(f.root, "async-r1"), sessionId: "s", pid: 1, agentProfile: "executor" });
  queue.markResolvingConflict({ queueItemId: followerItem.queueItemId, queueLeaseId: followerAdmission.queueLeaseId, conflictDigest: "c".repeat(64) });

  const second = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: "run-follower-r1", sourceAsyncDir: join(f.root, "async-r1"), sourceProofId: "2".repeat(64) });
  assert.equal(second.attempt, 2);
  assert.equal(second.noProgressCount, 0, "fingerprint 变化重置无进展计数");
});

test("两次无进展 fail closed preserve 并生成 legacy 人工债", async (t) => {
  const f = await fixture(t);
  const queue = f.coordinator.internal.integrationQueue;
  const head = await allocateCandidate(f, "head", "root-a", "head.txt");
  const follower = await allocateCandidate(f, "follower", "root-a", "follower.txt");
  const headItem = enqueue(f, head);
  const followerItem = enqueue(f, follower);
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(headItem.queueItemId, head.binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: headItem.queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: head.head }, head.binding);

  const first = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: follower.binding.runId, sourceAsyncDir: follower.asyncDir, sourceProofId: "1".repeat(64) });
  queue.promoteRecoverableHead();
  queue.markResumeStarting(first.resumeIntentId, { runId: "run-follower-r1", asyncDir: join(f.root, "async-r1"), sessionId: "s", pid: 1, agentProfile: "executor" });
  const second = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: "run-follower-r1", sourceAsyncDir: join(f.root, "async-r1"), sourceProofId: "2".repeat(64) });
  assert.equal(second.attempt, 2);
  assert.equal(second.noProgressCount, 1);
  assert.notEqual(second.state, "preserved");
  queue.promoteRecoverableHead();
  queue.markResumeStarting(second.resumeIntentId, { runId: "run-follower-r2", asyncDir: join(f.root, "async-r2"), sessionId: "s", pid: 2, agentProfile: "executor" });
  const third = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: "run-follower-r2", sourceAsyncDir: join(f.root, "async-r2"), sourceProofId: "3".repeat(64) });
  assert.equal(third.state, "preserved", "同一 fingerprint 连续两次无进展必须 fail closed");
  assert.equal(third.attempt, 3);

  const legacy = queue.listRecoveryIntents();
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].requiredAction, "preserve");
  assert.equal(legacy[0].queueItemId, followerItem.queueItemId);
  assert.equal(legacy[0].runId, "run-follower-r2");

  const replay = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: "run-follower-r3", sourceAsyncDir: join(f.root, "async-r3"), sourceProofId: "4".repeat(64) });
  assert.equal(replay.state, "preserved", "preserve 后的重复请求幂等返回");
  assert.equal(queue.listRecoveryIntents().length, 1);
});

test("总 attempt 超过 6 时 fail closed preserve", async (t) => {
  const f = await fixture(t);
  const queue = f.coordinator.internal.integrationQueue;
  const head = await allocateCandidate(f, "head", "root-a", "head.txt");
  const follower = await allocateCandidate(f, "follower", "root-a", "follower.txt");
  const headItem = enqueue(f, head);
  const followerItem = enqueue(f, follower);
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(headItem.queueItemId, head.binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: headItem.queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: head.head }, head.binding);
  const followerAdmission = f.coordinator.internal.awaitIntegrationAdmission(followerItem.queueItemId, follower.binding);

  let current = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: follower.binding.runId, sourceAsyncDir: follower.asyncDir, sourceProofId: "1".repeat(64) });
  for (let round = 1; round <= 6; round += 1) {
    queue.promoteRecoverableHead();
    queue.markResumeStarting(current.resumeIntentId, { runId: `run-follower-r${round}`, asyncDir: join(f.root, `async-r${round}`), sessionId: "s", pid: round, agentProfile: "executor" });
    queue.markResolvingConflict({ queueItemId: followerItem.queueItemId, queueLeaseId: followerAdmission.queueLeaseId, conflictDigest: `${round}`.repeat(64) });
    current = queue.requestChildResume({ queueItemId: followerItem.queueItemId, sourceRunId: `run-follower-r${round}`, sourceAsyncDir: join(f.root, `async-r${round}`), sourceProofId: `${round + 1}`.repeat(64) });
    if (round < 6) {
      assert.notEqual(current.state, "preserved");
      assert.equal(current.attempt, round + 1);
    }
  }
  assert.equal(current.attempt, 7);
  assert.equal(current.state, "preserved", "attempt 7 超过上限必须 fail closed");
  assert.equal(queue.listRecoveryIntents().length, 1);
});

test("resume intent 按重启持久化并保持 owner scope 过滤", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const client = await connectRealClient(f, "root-a");
  const head = await allocateCandidate(f, "head", "root-a", "head.txt");
  const follower = await allocateCandidate(f, "follower", "root-a", "follower.txt");
  const headItem = enqueue(f, head);
  const followerItem = enqueue(f, follower);
  const headAdmission = f.coordinator.internal.awaitIntegrationAdmission(headItem.queueItemId, head.binding);
  f.coordinator.internal.publishRebasedCandidate({ queueItemId: headItem.queueItemId, queueLeaseId: headAdmission.queueLeaseId, candidateHead: head.head }, head.binding);
  await assert.rejects(() => client.recordTerminalProof({ workspaceId: follower.binding.workspaceId, ownerScope: follower.binding.ownerScope, proof: terminalProof(f, follower, 9) }), /pending|completed child integration/i);

  const queue = f.coordinator.internal.integrationQueue;
  const intents = queue.listResumeIntents();
  assert.equal(intents.length, 1);
  assert.equal(intents[0].state, "pending");
  assert.equal(intents[0].delivery.state, "delivered");
  assert.equal(queue.listResumeIntents("root-a").length, 1);
  assert.equal(queue.listResumeIntents("root-b").length, 0);

  await client.close();
  await f.coordinator.close();
  const restartSink = [];
  const coordinator2 = createCoordinatorServer({ endpoint: join(f.root, "coordinator.sock"), repositoryId: f.repositoryId, stateRoot: f.stateRoot, idleGraceMs: 10_000,
    challengeBroker: async (registry) => ({ nonce: "n", repositoryId: registry.repositoryId, coordinatorInstanceId: "i", rootSessionId: registry.rootSessionId, brokerProcessIdentity: "b".repeat(64) }),
    recoveryEventSink: (event) => { restartSink.push(event); return { state: "delivered" }; } });
  t.after(async () => {
    await coordinator2.close();
    try {
      for (const line of git(f.originRoot, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== f.originRoot) spawnSync("git", ["worktree", "remove", "--force", line.slice(9)], { cwd: f.originRoot });
      }
    } catch {}
  });
  await coordinator2.listen();
  // 恢复后立即建立真实 client，避免隔离测试的同步 Git 操作耗尽空闲关闭窗口。
  const nextClient = await connectRealClient({ ...f, coordinator: coordinator2 }, "root-a");
  t.after(() => nextClient.close());
  const restored = coordinator2.internal.integrationQueue.listResumeIntents();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].resumeIntentId, intents[0].resumeIntentId);
  assert.equal(restored[0].state, "pending");
  assert.equal(restored[0].delivery.state, "delivered");
  assert.equal(restartSink.length, 0, "已 delivered 的 intent 不重复投递");
  // 同 Host 的前计划队首先完成，随后自动项的官方 proof 消费应接续机械集成。
  // 保留上面的手动队列语义；先以原准入/发布入口闭合该手动项。
  coordinator2.internal.advanceAutoIntegration({}, follower.binding);
  const nextFixture = { ...f, coordinator: coordinator2, baseCommit: git(f.originRoot, "rev-parse", "HEAD") };
  const nextHead = await allocateCandidate(nextFixture, "next-head", "root-a", "next-head.txt");
  const nextChild = await allocateCandidate(nextFixture, "next-child", "root-a", "next-child.txt");
  const nextHeadItem = enqueue(nextFixture, nextHead);
  const prepared = await nextClient.prepareAutoIntegration(nextChild.binding);
  const proof = terminalProof(nextFixture, nextChild, 8);
  await assert.rejects(() => nextClient.recordTerminalProof({ workspaceId: nextChild.binding.workspaceId, ownerScope: nextChild.binding.ownerScope, proof }), /pending/);
  const pending = coordinator2.internal.integrationQueue.listResumeIntents().find(entry => entry.queueItemId === prepared.queueItem.queueItemId);
  assert.equal(pending.state, "waiting-head");
  const admission = coordinator2.internal.awaitIntegrationAdmission(nextHeadItem.queueItemId, nextHead.binding);
  git(nextHead.receipt.path, "rebase", admission.targetHead);
  coordinator2.internal.publishRebasedCandidate({ queueItemId: nextHeadItem.queueItemId, queueLeaseId: admission.queueLeaseId,
    candidateHead: git(nextHead.receipt.path, "rev-parse", "HEAD") }, nextHead.binding);
  // 等待既有队首完成的 replay；不靠再次提交 proof 推进。
  for (let attempt = 0; attempt < 100 && (await coordinator2.proofOutbox.status(proof.proofId)).state !== "delivered"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await coordinator2.proofOutbox.status(proof.proofId)).state, "delivered");
  assert.equal(coordinator2.internal.integrationQueue.getItem(prepared.queueItem.queueItemId).state, "completed");
  assert.equal(coordinator2.internal.integrationQueue.listResumeIntents().find(entry => entry.resumeIntentId === pending.resumeIntentId).state, "completed");
  assert.equal(coordinator2.internal.inspectIntegrationState(nextChild.binding).workspaceState, "released");
  // 自动项仍受 dirty 门禁约束：终局 proof 不得把未提交内容冒充交付。
  const dirty = await allocateCandidate({ ...nextFixture, baseCommit: git(f.originRoot, "rev-parse", "HEAD") }, "dirty-child", "root-a", "dirty-child.txt");
  const dirtyItem = await nextClient.prepareAutoIntegration(dirty.binding);
  await writeFile(join(dirty.receipt.path, "src", "dirty-child.txt"), "未提交的变更\n");
  await assert.rejects(() => nextClient.recordTerminalProof({ workspaceId: dirty.binding.workspaceId, ownerScope: dirty.binding.ownerScope,
    proof: terminalProof(nextFixture, dirty, 7) }), /pending/);
  assert.equal(coordinator2.internal.integrationQueue.getItem(dirtyItem.queueItem.queueItemId).state, "queued");
  const handoff = coordinator2.internal.integrationQueue.listResumeIntents().find(entry => entry.queueItemId === dirtyItem.queueItem.queueItemId);
  assert.equal(handoff.state, "pending"); assert.equal(handoff.delivery.state, "delivered");
  assert.equal(coordinator2.internal.inspectIntegrationState(dirty.binding).workspaceState, "active");
});
