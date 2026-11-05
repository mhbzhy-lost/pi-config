import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createWorkspaceDispositionSettlement } from "../packages/pi-subagents-enhanced/src/workspace/disposition-settlement.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { canonicalWorkspaceStateRoot } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { createCoordinatorProofOutbox } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts";
import { terminalProofId } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";

// Phase A（统一收敛通道）验证：只覆盖用户授权的四个场景
//   a) debt 重投：构造 debt → 重启 coordinator → 证明补齐后 pending 清空、workspace released
//   b) 后到证明补记：proofHash:null 结算 → 真证明后到 → settle 幂等接受；伪造 proofId 仍拒
//   c) coordinator 侧 release provider：terminalProof 记录缺失但 asyncDir process-terminal observed → release 成功
//   d) recoverClaims 接线：死 claim → 重启 → 项回 queued
// 全部在隔离 fixture（独立 tmp root / state root / 独立 Git 仓）内执行，不触碰真实 Host。

const REPOSITORY_ID = "a".repeat(64);
const STORAGE_REPOSITORY_ID = "b".repeat(64);
const OWNER_ROOT = "root-phase-a";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function fixture(t, { name = "pa" } = {}) {
  // 短前缀：候选 TMPDIR 下 UNIX socket 路径上限 104 字节。
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  const originRoot = path.join(root, "origin");
  const stateRoot = path.join(root, "state");
  await mkdir(originRoot, { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test");
  await writeFile(path.join(originRoot, "README.md"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, originRoot, stateRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

const ownerScope = { kind: "standalone-subagent", rootSessionId: OWNER_ROOT };

/** 官方 process-terminal 制品的 observed 形态（与 upstream 写盘形状一致）。 */
function processTerminalArtifact(runId, { observedAt = Date.now(), exitCode = 0 } = {}) {
  const runnerProcessInstanceId = `${runId}-runner`;
  return {
    version: 1, runId, runnerProcessInstanceId, state: "observed", observedAt,
    instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode, signal: null }],
  };
}

async function writeArtifact(asyncDir, artifact) {
  await mkdir(asyncDir, { recursive: true });
  await writeFile(path.join(asyncDir, "process-terminal.json"), JSON.stringify(artifact), { mode: 0o600 });
}

/** workspace 服务与队列都从 server.internal 取得：service 是进程级单例，避免二次 configure 覆盖注入项。 */
function internals(server) {
  assert.ok(server.internal, "coordinator internals must be available");
  return server.internal;
}

function allocate(child, { workspaceId, runId, writePaths = ["result.txt"] }) {
  const receipt = child.workspaceService.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId, owner: { kind: "standalone-subagent", rootSessionId: OWNER_ROOT, toolCallId: `tool-${workspaceId}` },
    originRoot: child.originRoot, requestedCwd: child.originRoot, originRef: "refs/heads/main",
    baseCommit: child.baseCommit, contractHash: "c".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths },
  }));
  const asyncDir = path.join(child.root, `async-${runId}`);
  child.workspaceService.bindRun({ workspaceId: receipt.workspaceId, run: { runId, asyncDir } });
  return {
    receipt, asyncDir,
    binding: { workspaceId: receipt.workspaceId, leaseId: receipt.leaseId, runId, ownerScope },
  };
}

function enqueue(child, allocated, { autoManaged = true } = {}) {
  const { receipt, binding } = allocated;
  return child.integrationQueue.enqueueIntegration({
    requestId: `request-${receipt.workspaceId}`, workspaceId: receipt.workspaceId, leaseId: receipt.leaseId,
    repositoryId: REPOSITORY_ID, ownerScope, childRunId: binding.runId, strategy: "rebase-ff",
    observedTargetHead: null, targetRef: "refs/heads/main",
    authorizedWorkspaceHead: git(receipt.path, "rev-parse", "HEAD"), autoManaged,
  });
}

function proofFor(artifact, asyncDir) {
  return {
    state: "observed", conflict: false, runId: artifact.runId, rootSessionId: OWNER_ROOT,
    asyncDir, processInstance: artifact.runnerProcessInstanceId, proofId: terminalProofId(artifact),
  };
}

function outboxFor(stateRoot) {
  return createCoordinatorProofOutbox(path.join(canonicalWorkspaceStateRoot(stateRoot), "repositories", STORAGE_REPOSITORY_ID, "terminal-proof-outbox"));
}

function coordinatorServer(root, stateRoot, extra = {}) {
  const endpoint = path.join(root, extra.endpointName ?? "c.sock");
  const { endpointName, ...rest } = extra;
  return createCoordinatorServer({
    endpoint, repositoryId: REPOSITORY_ID, storageRepositoryId: STORAGE_REPOSITORY_ID, stateRoot, ...rest,
  });
}

test("a) proof debt is re-injected from durable facts at startup and settles the workspace", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { name: "pa-debt" });
  const owner = await coordinatorServer(f.root, f.stateRoot);
  t.after(() => owner.close());
  const child = { ...internals(owner), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const allocated = allocate(child, { workspaceId: "workspace-debt", runId: "run-debt" });
  // 队列项必须已 completed：终态证明的结算是「已发布候选」的回收动作。
  const queued = enqueue(child, allocated);
  const claimed = child.integrationQueue.claimNext({ instanceId: "daemon-phase-a", pid: process.pid, birthIdentity: "d".repeat(64) });
  assert.equal(claimed.queueItemId, queued.queueItemId);
  assert.equal(child.integrationQueue.completeItem({ queueItemId: claimed.queueItemId, queueLeaseId: claimed.queueLeaseId, revision: claimed.revision }).state, "completed");

  // 债务记录发生在证明「无法绑定」的时刻：此时 durable 事实还没补齐。
  const artifact = processTerminalArtifact("run-debt");
  const hostOutbox = outboxFor(f.stateRoot);
  await hostOutbox.recordDebt({ proofId: terminalProofId(artifact), runId: "run-debt", reason: "trusted run binding is unavailable" });
  assert.deepEqual((await hostOutbox.debts()).map((debt) => debt.runId), ["run-debt"]);

  // 事实补齐：官方 process-terminal.json 落盘，随后 coordinator 重启。
  await writeArtifact(allocated.asyncDir, artifact);
  const restarted = coordinatorServer(f.root, f.stateRoot, { endpointName: "c1.sock" });
  t.after(() => restarted.close());
  await restarted.listen();

  const status = await restarted.proofOutbox.status(terminalProofId(artifact));
  assert.equal(status.state, "delivered", "debt 必须被重投并交付");
  assert.equal(status.receipt.receipt.state, "released");
  assert.deepEqual(await restarted.proofOutbox.debts(), [], "重投后 debts 清空");
  const durable = JSON.parse(await readFile(path.join(canonicalWorkspaceStateRoot(f.stateRoot), "repositories", STORAGE_REPOSITORY_ID, "terminal-proof-outbox", "terminal-proofs.json"), "utf8"));
  assert.deepEqual(durable.pending, [], "pending 清空");
  assert.deepEqual(durable.debts, {});
  assert.equal(internals(restarted).workspaceService.readOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope }).state, "released");
});

test("b) late proof for a proofHash:null settlement is recorded idempotently while forged proofs stay rejected", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { name: "pa-late" });
  const owner = await coordinatorServer(f.root, f.stateRoot);
  t.after(() => owner.close());
  const child = { ...internals(owner), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const allocated = allocate(child, { workspaceId: "workspace-late", runId: "run-late" });
  enqueue(child, allocated, { autoManaged: false });

  // 结算时证明尚未观察：disposition challenge 的 proofHash 为 null。
  const issued = child.workspaceService.issueOwnedDisposition({ workspaceId: allocated.receipt.workspaceId, ownerScope });
  assert.equal(issued.allowedDispositions.includes("preserve"), true);
  const settlementId = "settlement-late";
  const prepared = child.workspaceService.prepareOwnedDisposition(
    { workspaceId: allocated.receipt.workspaceId, ownerScope, operation: "preserve", reason: "child ended without an observed terminal", actionToken: issued.actionToken },
    { settlementId, queueItem: child.integrationQueue.findByBinding(allocated.binding) },
  );
  assert.equal(prepared.proofHash, null, "构造前提：结算时证明未观察");
  createWorkspaceDispositionSettlement({ workspaceService: child.workspaceService, integrationQueue: child.integrationQueue }).settlePrepared(prepared);
  assert.equal(child.workspaceService.readOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope }).state, "preserved");
  assert.equal(child.integrationQueue.getItem(prepared.binding.queueItemId).state, "preserved");

  // 真证明后到：binding 与 prepared.binding 全等时应补记并幂等收敛。
  const artifact = processTerminalArtifact("run-late");
  await writeArtifact(allocated.asyncDir, artifact);
  const realProof = proofFor(artifact, allocated.asyncDir);
  const hostOutbox = outboxFor(f.stateRoot);
  await hostOutbox.enqueue({ ...realProof, workspaceId: allocated.receipt.workspaceId, ownerScope });
  const restarted = coordinatorServer(f.root, f.stateRoot, { endpointName: "c1.sock" });
  t.after(() => restarted.close());
  await restarted.listen();
  const accepted = await restarted.proofOutbox.receipt(realProof.proofId);
  assert.equal(accepted.accepted, true, "后到真证明必须被接受");
  assert.equal(accepted.receipt.state, "preserved");
  const recorded = internals(restarted).workspaceService.readOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope });
  assert.equal(recorded.terminalProof.proofId, realProof.proofId, "证明必须补记到 workspace 记录");
  assert.equal(recorded.state, "preserved", "补记不改变既有 settle 终态");
  // 幂等重放：同一证明再次入队仍是 delivered（receipt 已存在即短路）。
  await hostOutbox.enqueue({ ...realProof, workspaceId: allocated.receipt.workspaceId, ownerScope });
  assert.equal((await hostOutbox.status(realProof.proofId)).state, "delivered");
  assert.equal((await restarted.proofOutbox.receipt(realProof.proofId)).accepted, true);

  // 伪造 proofId（binding 全等但身份不同）仍必须拒绝：保持 pending，不改写记录。
  const forgedArtifact = processTerminalArtifact("run-late", { observedAt: artifact.observedAt + 1 });
  const forgedProof = proofFor(forgedArtifact, allocated.asyncDir);
  assert.notEqual(forgedProof.proofId, realProof.proofId);
  await hostOutbox.enqueue({ ...forgedProof, workspaceId: allocated.receipt.workspaceId, ownerScope });
  const third = coordinatorServer(f.root, f.stateRoot, { endpointName: "c2.sock" });
  t.after(() => third.close());
  await third.listen();
  const forgedStatus = await third.proofOutbox.status(forgedProof.proofId);
  assert.equal(forgedStatus.state, "pending", "伪造 proofId 不得被接受");
  assert.equal((await third.proofOutbox.receipt(realProof.proofId)).accepted, true, "既有 receipt 不被伪造证明改写");
  assert.equal(internals(third).workspaceService.readOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope }).terminalProof.proofId, realProof.proofId);
});

test("b) settled proofHash that differs from the arriving proof is still rejected", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { name: "pa-forge" });
  const owner = await coordinatorServer(f.root, f.stateRoot);
  t.after(() => owner.close());
  const child = { ...internals(owner), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const allocated = allocate(child, { workspaceId: "workspace-forge", runId: "run-forge" });
  enqueue(child, allocated, { autoManaged: false });
  // 结算时证明已观察：proofHash 非空。
  const artifact = processTerminalArtifact("run-forge");
  await writeArtifact(allocated.asyncDir, artifact);
  const observed = proofFor(artifact, allocated.asyncDir);
  child.workspaceService.recordTerminalProof({ workspaceId: allocated.receipt.workspaceId, ownerScope, proof: observed });
  const issued = child.workspaceService.issueOwnedDisposition({ workspaceId: allocated.receipt.workspaceId, ownerScope, terminalProof: observed });
  const prepared = child.workspaceService.prepareOwnedDisposition(
    { workspaceId: allocated.receipt.workspaceId, ownerScope, operation: "preserve", reason: "settled with an observed proof", terminalProof: observed, actionToken: issued.actionToken },
    { settlementId: "settlement-forge", queueItem: child.integrationQueue.findByBinding(allocated.binding) },
  );
  assert.equal(prepared.proofHash, observed.proofId);
  createWorkspaceDispositionSettlement({ workspaceService: child.workspaceService, integrationQueue: child.integrationQueue }).settlePrepared(prepared);

  const forged = { ...observed, processInstance: "other-process", proofId: "f".repeat(64) };
  const hostOutbox = outboxFor(f.stateRoot);
  await hostOutbox.enqueue({ ...forged, workspaceId: allocated.receipt.workspaceId, ownerScope });
  const restarted = coordinatorServer(f.root, f.stateRoot, { endpointName: "c1.sock" });
  t.after(() => restarted.close());
  await restarted.listen();
  assert.equal((await restarted.proofOutbox.status(forged.proofId)).state, "pending", "proofHash 非空且不匹配必须拒绝");
  assert.equal(internals(restarted).workspaceService.readOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope }).terminalProof.proofId, observed.proofId);
});

test("c) coordinator release resolves the terminal proof from durable async facts", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { name: "pa-release" });
  const owner = await coordinatorServer(f.root, f.stateRoot);
  t.after(() => owner.close());
  const child = { ...internals(owner), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const allocated = allocate(child, { workspaceId: "workspace-release", runId: "run-release" });
  enqueue(child, allocated, { autoManaged: false });
  // 关键前提：ledger 没有 terminalProof 记录，只有 durable 异步事实。
  assert.equal(child.workspaceService.readOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope }).terminalProof, null);
  const artifact = processTerminalArtifact("run-release");
  await writeArtifact(allocated.asyncDir, artifact);
  const expected = terminalProofId(artifact);
  // status 与 release 必须消费同一事实（审计 #9 / INV-OWNER-UNIQ）：status 在
  // 同一条 durable 事实上报 observed，release 才能按同一 proofId 结算。
  const status = child.workspaceService.statusOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope });
  assert.equal(status.terminalProof?.proofId, expected, "status 必须从同一 durable 事实解析证明");
  assert.equal(status.allowedActions.includes("release"), true);
  child.workspaceService.preserveIntegrationDebt({ ...allocated.binding, ownerScope });

  const settlementId = "settlement-release";
  const prepared = child.workspaceService.prepareOwnedDisposition(
    { workspaceId: allocated.receipt.workspaceId, ownerScope, operation: "release" }, { settlementId },
  );
  assert.equal(prepared.proofHash, expected, "coordinator 侧必须从 durable 事实解析出同一 proofId");
  assert.equal(child.workspaceService.applyPreparedDisposition({ workspaceId: allocated.receipt.workspaceId, ownerScope, settlementId }).state, "released");
  child.workspaceService.markDispositionSettled({ workspaceId: allocated.receipt.workspaceId, ownerScope, settlementId, queueReceiptRef: `qsr-${settlementId}` });
  assert.equal(child.workspaceService.readOwned({ workspaceId: allocated.receipt.workspaceId, ownerScope }).terminalProof.proofId, expected);

  // 对照：同一 durable 事实在「无 provider」的 service 上仍然 fail-closed（原有不对称）。
  const plainStateRoot = path.join(f.root, "state-plain");
  const plain = createManagedWorkspaceService({ stateRoot: plainStateRoot, storageRepositoryId: STORAGE_REPOSITORY_ID });
  const plainReceipt = plain.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId: "workspace-release-plain", owner: { kind: "standalone-subagent", rootSessionId: OWNER_ROOT, toolCallId: "tool-plain" },
    originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit,
    contractHash: "c".repeat(64), policy: { publication: "allowed", application: "allowed", writePaths: ["result.txt"] },
  }));
  const plainAsyncDir = path.join(f.root, "async-run-release-plain");
  plain.bindRun({ workspaceId: plainReceipt.workspaceId, run: { runId: "run-release-plain", asyncDir: plainAsyncDir } });
  plain.preserveIntegrationDebt({ workspaceId: plainReceipt.workspaceId, leaseId: plainReceipt.leaseId, runId: "run-release-plain", ownerScope });
  await writeArtifact(plainAsyncDir, processTerminalArtifact("run-release-plain"));
  assert.throws(
    () => plain.prepareOwnedDisposition({ workspaceId: plainReceipt.workspaceId, ownerScope, operation: "release" }, { settlementId: "settlement-plain" }),
    (error) => error.code === "MANAGED_WORKSPACE_TERMINAL",
    "无 provider 时必须保持原 fail-closed 语义",
  );
});

test("d) startup recovery reclaims a dead daemon claim and then reconciles the reclaimed item", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { name: "pa-claims" });
  const owner = await coordinatorServer(f.root, f.stateRoot);
  t.after(() => owner.close());
  const child = { ...internals(owner), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const allocated = allocate(child, { workspaceId: "workspace-claim", runId: "run-claim" });
  enqueue(child, allocated);
  // 死 daemon：ESRCH 才是死亡证明，birthIdentity 仍是合法 sha256。
  const deadClaim = child.integrationQueue.claimNext({ instanceId: "daemon-dead", pid: 999_999, birthIdentity: "e".repeat(64) });
  assert.equal(deadClaim.state, "admitted");

  const diagnostics = [];
  const restarted = coordinatorServer(f.root, f.stateRoot, { instanceId: "daemon-restarted", endpointName: "c1.sock", diagnosticSink: (entry) => diagnostics.push(entry) });
  t.after(() => restarted.close());
  await restarted.listen();

  const recovery = diagnostics.find((entry) => entry?.phase === "coordinator-recover-claims");
  assert.ok(recovery, "启动恢复必须调用 recoverClaims");
  assert.equal(recovery.count >= 1, true, JSON.stringify(recovery));
  assert.deepEqual(recovery.recovered.map((entry) => [entry.queueItemId, entry.state]), [[deadClaim.queueItemId, "queued"]]);
  const durable = internals(restarted).integrationQueue.getItem(deadClaim.queueItemId);
  assert.equal(durable.daemonClaim, undefined, "死 claim 必须被清掉");
  assert.notEqual(durable.state, "admitted");
  // 回收后的项在同一轮启动对账里被处理（无候选 commit → preserve），并落诊断。
  const reconcile = diagnostics.find((entry) => entry?.phase === "coordinator-startup-reconcile");
  assert.ok(reconcile, "启动对账结果必须落诊断");
  assert.deepEqual(reconcile.results.map((entry) => [entry.queueItemId, entry.state]), [[deadClaim.queueItemId, "preserved"]]);
  assert.equal(internals(restarted).integrationQueue.getItem(deadClaim.queueItemId).state, "preserved");
});
