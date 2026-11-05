import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createWorkspaceDispositionSettlement } from "../packages/pi-subagents-enhanced/src/workspace/disposition-settlement.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createIntegrationQueue } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { canonicalWorkspaceStateRoot, classifyCoordinatorOwner, createCoordinatorRegistry } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { ensureCoordinatorDaemon } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts";
import { createCoordinatorProofOutbox } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts";
import { terminalProofId } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";

// Phase D（审计 §五 INV-REACH / §六 Phase D）：故障注入可达性验收。
//
// 规格权威：docs/investigations/2026-11-04-lifecycle-recovery-ownership-audit.md
// ——「任何 durable 状态转移的验收必须包含『从每个失败出口仍能到达终态』的可达性检查（故障注入）」。
// 每个场景只注入一种真实故障（真实 killed 进程 / 真实 spawn 的 daemon / 缺事实的 proof / 死 claim /
// 半途 prepared），然后断言：注入后**存在**一条到达终态的路径，且恢复 owner 是自动泵（启动恢复
// 接线）而不是人工账本手术；拒绝回执必须带可归因 `next:`（Phase B 合同）。
//
// 场景与合同对应：
//   1. daemon 崩溃重启：kill 真实 spawned daemon → 重启后 claim 回收 / 孤儿对账 / debt 重投各自触发。
//   2. 证明延迟/丢失：child 已终止但证明后到（debt 路径）→ 重投后 released；伪造 proofId 仍拒绝。
//   3. Host 中途退出：workspace active + 队列项 prepared 时宿主进程被 kill → 新进程接手推进到 released。
//   4. 队列状态卡死：admitted + 死 daemon claim → recoverClaims 回 queued 后仍能收敛；
//      resolving-conflict + 无 child → reconcileIntegrations 的 preserve 兜底。
//   5. GAP-1 回归：resolving-conflict + child 已死 + workspace 健康 → 无进展耗尽后
//      reconcile 转 preserve 并生成 recovery intent（不再是静默空转）。
// 全部在隔离 fixture（独立 tmp root / state root / 独立 Git 仓 / 独立 daemon endpoint）内执行。

const REPOSITORY_ID = "a".repeat(64);
const STORAGE_REPOSITORY_ID = "b".repeat(64);
const OWNER_ROOT = "root-phase-d";
const TERMINAL_QUEUE_STATES = new Set(["completed", "cancelled", "preserved"]);
const TERMINAL_WORKSPACE_STATES = new Set(["released", "preserved", "discarded"]);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** 有界收敛等待：真实进程/异步 replay 的完成只以 durable 事实为准，不用固定 sleep 断言。 */
async function converge(read, accept, { timeoutMs = 60_000, label = "lifecycle terminal state" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) assert.fail(`${label} 在 ${timeoutMs}ms 内未收敛：${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function fixture(t, { name = "pd" } = {}) {
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
  return { root, originRoot, stateRoot, baseCommit: git(originRoot, "rev-parse", "HEAD"), commonDir: path.join(originRoot, ".git") };
}

const ownerScope = { kind: "standalone-subagent", rootSessionId: OWNER_ROOT };

/** 官方 process-terminal 制品的 observed 形态（与 upstream 写盘形状一致）。 */
function processTerminalArtifact(runId, { observedAt = 1_700_000_000_000, exitCode = 0 } = {}) {
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

/** child 自有 commit：admission 要求「授权头之后仍有 child commit」，纯文本 turn 不算可集成产物。 */
function commitChildWork(allocated, name = "result.txt") {
  execFileSync("sh", ["-c", `printf 'child result\\n' > ${name}`], { cwd: allocated.receipt.path });
  git(allocated.receipt.path, "add", ".");
  git(allocated.receipt.path, "commit", "-m", "child work");
  return git(allocated.receipt.path, "rev-parse", "HEAD");
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

/** 只读核验用：与 daemon 无关的旁观 service（同一 state root / storage partition）。 */
function observerService(stateRoot) {
  return createManagedWorkspaceService({ stateRoot, storageRepositoryId: STORAGE_REPOSITORY_ID });
}

/** 只读核验用：与恢复进程无关的旁观 queue（同一 storage partition，不做任何恢复动作）。 */
function observerQueueFor(stateRoot) {
  return createIntegrationQueue({ stateRoot, repositoryId: REPOSITORY_ID, storageRepositoryId: STORAGE_REPOSITORY_ID });
}

function queueState(queue, queueItemId) {
  return queue.getItem(queueItemId)?.state ?? "absent";
}

function workspaceState(service, workspaceId) {
  try { return service.readOwned({ workspaceId, ownerScope }).state; } catch { return "absent"; }
}

/** 全生命周期终态断言：队列项与 workspace 都必须落终态（INV-REACH 的显式形态）。 */
function assertTerminal(service, queue, pairs, label) {
  for (const { queueItemId, workspaceId } of pairs) {
    const item = queueState(queue, queueItemId);
    const workspace = workspaceState(service, workspaceId);
    assert.ok(TERMINAL_QUEUE_STATES.has(item), `${label}：队列项 ${workspaceId} 未达终态（state=${item}）`);
    assert.ok(TERMINAL_WORKSPACE_STATES.has(workspace), `${label}：workspace ${workspaceId} 未达终态（state=${workspace}）`);
  }
}

/** Phase B 合同：拒绝回执必须同时给出「为什么不行」与「下一步去哪」。 */
function assertAttributableRejection(error, { code } = {}) {
  assert.ok(error, "必须产生可观察的拒绝回执");
  if (code !== undefined) assert.equal(error.code, code);
  assert.match(String(error.message), /next: /, `拒绝回执必须携带可归因 next（Phase B 合同）：${error.message}`);
}

/**
 * 真实「宿主进程」fixture：独立进程持有 workspace/claim，随后被 SIGKILL。
 *
 * 用法差异只由 env 的 STAGE 决定：
 *   claim   —— allocate + enqueue + claim（场景 4a：死 claim）
 *   prepared —— 同 claim，另做真实 managedRebase + prepareCandidate（场景 3：集成半途）
 */
function spawnHostProcess(t, { stage, stateRoot, originRoot, baseCommit, workspaceId, runId }) {
  const script = `
    import { execFileSync } from "node:child_process";
    import { mkdir, writeFile } from "node:fs/promises";
    import path from "node:path";
    const pkg = ${JSON.stringify(path.resolve("packages/pi-subagents-enhanced/src"))};
    const imp = (name) => import("file://" + path.join(pkg, name));
    const { createManagedWorkspaceRequestV2 } = await imp("workspace/contract.ts");
    const { createManagedWorkspaceService } = await imp("workspace/service.ts");
    const { createIntegrationQueue } = await imp("workspace/integration-queue.ts");
    const { captureProcessBirthIdentity } = await imp("subagent-dispatch/process-birth-identity.ts");
    const env = process.env;
    const stateRoot = env.STATE_ROOT, originRoot = env.ORIGIN_ROOT, baseCommit = env.BASE_COMMIT;
    const workspaceId = env.WORKSPACE_ID, runId = env.RUN_ID;
    const ownerScope = { kind: "standalone-subagent", rootSessionId: env.OWNER_ROOT };
    const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const workspaceService = createManagedWorkspaceService({ stateRoot, storageRepositoryId: env.STORAGE_REPOSITORY_ID });
    const integrationQueue = createIntegrationQueue({ stateRoot, repositoryId: env.REPOSITORY_ID, storageRepositoryId: env.STORAGE_REPOSITORY_ID });
    const receipt = workspaceService.ensureAllocated(createManagedWorkspaceRequestV2({
      workspaceId, owner: { kind: "standalone-subagent", rootSessionId: env.OWNER_ROOT, toolCallId: "tool-" + workspaceId },
      originRoot, requestedCwd: originRoot, originRef: "refs/heads/main", baseCommit, contractHash: "c".repeat(64),
      policy: { publication: "allowed", application: "allowed", writePaths: ["result.txt"] },
    }));
    const asyncDir = path.join(env.FIXTURE_ROOT, "async-" + runId);
    workspaceService.bindRun({ workspaceId: receipt.workspaceId, run: { runId, asyncDir } });
    const binding = { workspaceId: receipt.workspaceId, leaseId: receipt.leaseId, runId, ownerScope };
    // child 自有 commit：admission 需要授权头之后的真实 child commit。
    await writeFile(path.join(receipt.path, "result.txt"), "child result\\n");
    git("-C", receipt.path, "add", ".");
    git("-C", receipt.path, "commit", "-m", "child work");
    const item = integrationQueue.enqueueIntegration({
      requestId: "request-" + receipt.workspaceId, workspaceId: receipt.workspaceId, leaseId: receipt.leaseId,
      repositoryId: env.REPOSITORY_ID, ownerScope, childRunId: runId, strategy: "rebase-ff",
      observedTargetHead: null, targetRef: "refs/heads/main",
      authorizedWorkspaceHead: git("-C", receipt.path, "rev-parse", "HEAD"), autoManaged: true,
    });
    const birthIdentity = await captureProcessBirthIdentity(process.pid);
    // 与 coordinator 的 awaitIntegrationAdmission 同形：claim 时写入权威 admittedTargetHead。
    const targetHead = git("-C", originRoot, "rev-parse", "refs/heads/main");
    const claimed = integrationQueue.claimNext(
      { instanceId: env.INSTANCE_ID, pid: process.pid, birthIdentity },
      () => ({ admittedTargetHead: targetHead }),
    );
    if (!claimed) throw new Error("HOST_FIXTURE_CLAIM_FAILED");
    if (env.STAGE === "prepared") {
      const candidate = workspaceService.managedRebase({ targetHead, queueLeaseId: claimed.queueLeaseId, admissionGeneration: claimed.admissionGeneration }, binding);
      if (candidate.state !== "rebased" && candidate.state !== "candidate" && typeof candidate.head !== "string") throw new Error("HOST_FIXTURE_REBASE_FAILED:" + JSON.stringify(candidate.state));
      integrationQueue.prepareCandidate({ queueItemId: claimed.queueItemId, queueLeaseId: claimed.queueLeaseId, admissionGeneration: claimed.admissionGeneration, candidateHead: candidate.head });
      await mkdir(asyncDir, { recursive: true });
      await writeFile(path.join(asyncDir, "process-terminal.json"), JSON.stringify({
        version: 1, runId, runnerProcessInstanceId: runId + "-runner", state: "observed", observedAt: 1700000000000,
        instances: [{ processInstanceId: runId + "-runner", kind: "runner", closeObservedAt: 1700000000000, exitCode: 0, signal: null }],
      }));
    }
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, instanceId: env.INSTANCE_ID, queueItemId: claimed.queueItemId, workspaceId: receipt.workspaceId, leaseId: receipt.leaseId, asyncDir }) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, STAGE: stage, STATE_ROOT: stateRoot, ORIGIN_ROOT: originRoot, BASE_COMMIT: baseCommit,
      WORKSPACE_ID: workspaceId, RUN_ID: runId, OWNER_ROOT, FIXTURE_ROOT: path.dirname(stateRoot),
      REPOSITORY_ID, STORAGE_REPOSITORY_ID, INSTANCE_ID: `host-${process.pid}-${Date.now().toString(16)}`,
    },
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } });
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => reject(new Error(`host fixture startup timed out: ${stderr}`)), 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve({ child, info: JSON.parse(stdout.slice(0, newline)), stderr: () => stderr });
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`host fixture exited ${code}: ${stderr}`)); });
  });
}

function killAndAwaitDeath(handle) {
  return converge(async () => {
    try { process.kill(handle.pid, 0); } catch (error) { if (error?.code === "ESRCH") return "dead"; }
    return "alive";
  }, (state) => state === "dead", { timeoutMs: 20_000, label: `process ${handle.pid} death` });
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景 1：真实 daemon 崩溃重启（claim 回收 + 孤儿对账 + debt 重投各自触发）
// ─────────────────────────────────────────────────────────────────────────────
test("1) killed daemon：重启后 claim 回收、孤儿对账与 proof debt 重投各自触发并收敛到终态", { timeout: 360_000 }, async (t) => {
  const f = await fixture(t, { name: "pd-crash" });
  const registry = createCoordinatorRegistry({ commonDir: f.commonDir, stateRoot: f.stateRoot });
  // 真实 spawned daemon：本用例的故障注入就是「这个进程被 kill -9」。
  const daemon = await ensureCoordinatorDaemon({
    stateRoot: f.stateRoot, repositoryId: REPOSITORY_ID, storageRepositoryId: STORAGE_REPOSITORY_ID,
    commonDir: f.commonDir, endpoint: registry.endpoint, idleExitGraceMs: 600_000, spawnTimeoutMs: 90_000,
  });
  t.after(() => { try { process.kill(daemon.metadata.pid, "SIGKILL"); } catch { /* 已退出 */ } });

  // durable 现场由测试侧直接构造（与 daemon 共享同一 state root / ledger partition）。
  const bootstrap = coordinatorServer(f.root, f.stateRoot, { endpointName: "boot.sock" });
  t.after(() => bootstrap.close());
  const child = { ...internals(bootstrap), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const hostOutbox = outboxFor(f.stateRoot);

  // c) debt 项：队列项在证明「无法绑定」前已完成，debt 记录时 durable 事实尚未落盘。
  const debt = allocate(child, { workspaceId: "workspace-debt", runId: "run-debt" });
  const debtItem = enqueue(child, debt);
  const debtClaim = child.integrationQueue.claimNext({ instanceId: "daemon-bootstrap", pid: process.pid, birthIdentity: "d".repeat(64) });
  assert.equal(debtClaim.queueItemId, debtItem.queueItemId);
  assert.equal(child.integrationQueue.completeItem({ queueItemId: debtClaim.queueItemId, queueLeaseId: debtClaim.queueLeaseId, revision: debtClaim.revision }).state, "completed");
  const debtArtifact = processTerminalArtifact("run-debt");
  await hostOutbox.recordDebt({ proofId: terminalProofId(debtArtifact), runId: "run-debt", reason: "trusted run binding is unavailable" });
  await writeArtifact(debt.asyncDir, debtArtifact);

  // a) claim 项：child 已终止并留下官方制品，集成本应继续；claim 记录在**真实 daemon 身份**下。
  const claimed = allocate(child, { workspaceId: "workspace-claim", runId: "run-claim" });
  commitChildWork(claimed);
  const claimItem = enqueue(child, claimed);
  const daemonClaim = child.integrationQueue.claimNext({
    instanceId: daemon.metadata.instanceId, pid: daemon.metadata.pid, birthIdentity: daemon.metadata.birthIdentity,
  });
  assert.equal(daemonClaim.queueItemId, claimItem.queueItemId);
  assert.equal(daemonClaim.state, "admitted");
  const claimArtifact = processTerminalArtifact("run-claim");
  await writeArtifact(claimed.asyncDir, claimArtifact);
  await hostOutbox.enqueue({ ...proofFor(claimArtifact, claimed.asyncDir), workspaceId: claimed.receipt.workspaceId, ownerScope });

  // b) 孤儿项：workspace 已 released，队列项仍 queued（审计 #6 的永久孤儿组合）。
  const orphan = allocate(child, { workspaceId: "workspace-orphan", runId: "run-orphan" });
  const orphanItem = enqueue(child, orphan, { autoManaged: false });
  const orphanArtifact = processTerminalArtifact("run-orphan");
  await writeArtifact(orphan.asyncDir, orphanArtifact);
  child.workspaceService.preserveIntegrationDebt({ ...orphan.binding });
  const orphanPrepared = child.workspaceService.prepareOwnedDisposition(
    { workspaceId: orphan.receipt.workspaceId, ownerScope, operation: "release" },
    { settlementId: "settlement-orphan" },
  );
  child.workspaceService.applyPreparedDisposition({ workspaceId: orphan.receipt.workspaceId, ownerScope, settlementId: "settlement-orphan" });
  child.workspaceService.markDispositionSettled({ workspaceId: orphan.receipt.workspaceId, ownerScope, settlementId: "settlement-orphan", queueReceiptRef: "qsr-settlement-orphan" });
  assert.equal(child.workspaceService.readOwned({ workspaceId: orphan.receipt.workspaceId, ownerScope }).state, "released");
  assert.equal(child.integrationQueue.getItem(orphanItem.queueItemId).state, "queued", "构造前提：released workspace 仍留 queued 孤儿项");
  assert.equal(orphanPrepared.proofHash, terminalProofId(orphanArtifact));

  // ── 故障注入：kill -9 真实 daemon（不优雅关闭，不做清理） ──
  process.kill(daemon.metadata.pid, "SIGKILL");
  await killAndAwaitDeath({ pid: daemon.metadata.pid });
  assert.equal(await classifyCoordinatorOwner({ pid: daemon.metadata.pid, birthIdentity: daemon.metadata.birthIdentity }), "dead");

  // ── 重启：拉起器发现死 owner → 清理陈旧 socket/metadata → spawn 新 daemon → 启动恢复 ──
  const restarted = await ensureCoordinatorDaemon({
    stateRoot: f.stateRoot, repositoryId: REPOSITORY_ID, storageRepositoryId: STORAGE_REPOSITORY_ID,
    commonDir: f.commonDir, endpoint: registry.endpoint, idleExitGraceMs: 600_000, spawnTimeoutMs: 90_000,
  });
  t.after(() => { try { process.kill(restarted.metadata.pid, "SIGKILL"); } catch { /* 已退出 */ } });
  assert.notEqual(restarted.metadata.instanceId, daemon.metadata.instanceId, "重启必须是新 daemon 实例");

  // 收敛只以 durable 事实为准：claim 项 completed + workspace released（proof 在完成路径异步重放）。
  const observer = observerService(f.stateRoot);
  const observerQueue = observerQueueFor(f.stateRoot);
  await converge(async () => ({
    claim: queueState(observerQueue, claimItem.queueItemId),
    claimWorkspace: workspaceState(observer, claimItem.workspaceId),
  }), (value) => value.claim === "completed" && value.claimWorkspace === "released", { label: "claim 项与 workspace" });

  const final = {
    debtQueue: queueState(observerQueue, debtItem.queueItemId),
    debtWorkspace: workspaceState(observer, debtItem.workspaceId),
    claimQueue: queueState(observerQueue, claimItem.queueItemId),
    claimWorkspace: workspaceState(observer, claimItem.workspaceId),
    orphanQueue: queueState(observerQueue, orphanItem.queueItemId),
    orphanWorkspace: workspaceState(observer, orphanItem.workspaceId),
  };
  // c) debt 重投：重投后 debt 清空、receipt 为 released。
  assert.deepEqual(await hostOutbox.debts(), [], "debt 重投后 debts 必须清空");
  const debtReceipt = await hostOutbox.receipt(terminalProofId(debtArtifact));
  assert.equal(debtReceipt?.receipt?.state, "released", "debt 重投后必须交付并 released");
  // a) claim 回收：新 daemon 回收死 claim，项回落 queued 后被对账推进到 completed。
  assert.equal(final.claimQueue, "completed", "死 daemon claim 回收后项必须仍可推进到终态");
  assert.equal(final.claimWorkspace, "released", "claim 项完成后 proof 重放必须把 workspace 收敛到 released");
  // b) 孤儿对账：released workspace 的 queued 项在启动对账里转 preserved。
  assert.equal(final.orphanQueue, "preserved", "孤儿项必须被启动对账收敛到 preserved");
  assert.match(observerQueue.getItem(orphanItem.queueItemId).preserveReason, /workspace released: orphan queue item unblocked at coordinator startup/, "孤儿对账必须留下可归因 preserve 原因");
  assertTerminal(observer, observerQueue, [debtItem, claimItem, orphanItem], "场景 1");

  // 三个自动泵都必须真实触发：结果只认 daemon 自身落盘的诊断（不是测试推断）。
  const logPath = path.join(canonicalWorkspaceStateRoot(f.stateRoot), "logs", `coordinator-${REPOSITORY_ID.slice(0, 16)}.log`);
  const log = await readFile(logPath, "utf8");
  const phases = log.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line.slice(line.indexOf("{"))).phase; } catch { return undefined; } }).filter(Boolean);
  assert.ok(phases.includes("coordinator-recover-claims"), `重启必须执行 claim 回收：${phases.join(",")}`);
  assert.ok(phases.includes("coordinator-proof-debt-reinjected"), `重启必须重投 proof debt：${phases.join(",")}`);
  assert.ok(phases.includes("coordinator-startup-reconcile"), `重启必须执行启动对账：${phases.join(",")}`);

  // Phase B 合同：终态后的处置请求仍是可归因拒绝（state + allowed actions + next）。
  const settled = observerService(f.stateRoot);
  assert.throws(
    () => settled.issueOwnedDisposition({ workspaceId: claimItem.workspaceId, ownerScope }),
    (error) => { assertAttributableRejection(error, { code: "MANAGED_WORKSPACE_STATE" }); return true; },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 场景 2：证明延迟 / 丢失注入（debt 重投 + 伪造 proofId 拒绝）
// ─────────────────────────────────────────────────────────────────────────────
test("2) 延迟到达的证明经 debt 重投交付并 released；伪造 proofId 仍被拒绝且回执带 next", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { name: "pd-delay" });
  const owner = coordinatorServer(f.root, f.stateRoot);
  t.after(() => owner.close());
  const child = { ...internals(owner), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };

  // 2a) child 已终止，但证明「无法绑定」的时刻 durable 事实还没落盘 → 记 debt。
  const delayed = allocate(child, { workspaceId: "workspace-delayed", runId: "run-delayed" });
  const delayedItem = enqueue(child, delayed);
  const delayedClaim = child.integrationQueue.claimNext({ instanceId: "daemon-phase-d", pid: process.pid, birthIdentity: "d".repeat(64) });
  child.integrationQueue.completeItem({ queueItemId: delayedClaim.queueItemId, queueLeaseId: delayedClaim.queueLeaseId, revision: delayedClaim.revision });
  const delayedArtifact = processTerminalArtifact("run-delayed");
  const hostOutbox = outboxFor(f.stateRoot);
  await hostOutbox.recordDebt({ proofId: terminalProofId(delayedArtifact), runId: "run-delayed", reason: "trusted run binding is unavailable" });
  assert.deepEqual((await hostOutbox.debts()).map((debt) => debt.runId), ["run-delayed"]);

  // 2b) 结算时证明未观察（proofHash:null）→ 后到的真证明必须补记；伪造 proofId 仍拒绝。
  const late = allocate(child, { workspaceId: "workspace-late", runId: "run-late" });
  enqueue(child, late, { autoManaged: false });
  const issued = child.workspaceService.issueOwnedDisposition({ workspaceId: late.receipt.workspaceId, ownerScope });
  const prepared = child.workspaceService.prepareOwnedDisposition(
    { workspaceId: late.receipt.workspaceId, ownerScope, operation: "preserve", reason: "child ended without an observed terminal", actionToken: issued.actionToken },
    { settlementId: "settlement-late", queueItem: child.integrationQueue.findByBinding(late.binding) },
  );
  assert.equal(prepared.proofHash, null, "构造前提：结算时证明未观察");
  createWorkspaceDispositionSettlement({ workspaceService: child.workspaceService, integrationQueue: child.integrationQueue }).settlePrepared(prepared);
  const lateArtifact = processTerminalArtifact("run-late");
  await writeArtifact(late.asyncDir, lateArtifact);
  const lateProof = proofFor(lateArtifact, late.asyncDir);
  await hostOutbox.enqueue({ ...lateProof, workspaceId: late.receipt.workspaceId, ownerScope });

  // ── 事实补齐（官方制品落盘）+ coordinator 重启：debt 重投与迟到证明在同一轮 replay 交付 ──
  await writeArtifact(delayed.asyncDir, delayedArtifact);
  const restarted = coordinatorServer(f.root, f.stateRoot, { endpointName: "c1.sock" });
  t.after(() => restarted.close());
  await restarted.listen();
  const observerQueue = internals(restarted).integrationQueue;
  const observer = observerService(f.stateRoot);
  await converge(async () => ({ debts: await hostOutbox.debts(), delayed: queueState(observerQueue, delayedItem.queueItemId), workspace: workspaceState(observer, delayedItem.workspaceId) }),
    (value) => value.debts.length === 0 && value.delayed === "completed" && value.workspace === "released", { label: "debt 重投收敛" });
  const delayedStatus = await restarted.proofOutbox.status(terminalProofId(delayedArtifact));
  assert.equal(delayedStatus.state, "delivered");
  assert.equal(delayedStatus.receipt.receipt.state, "released", "debt 重投交付后 workspace 必须 released");
  assert.equal((await hostOutbox.receipt(lateProof.proofId)).accepted, true, "后到真证明必须被接受");
  assert.equal(internals(restarted).workspaceService.readOwned({ workspaceId: late.receipt.workspaceId, ownerScope }).terminalProof.proofId, lateProof.proofId, "证明必须补记到 workspace 记录");

  // 伪造 proofId（binding 全等但身份不同）仍必须拒绝：保持 pending，不改写既有 receipt。
  const forgedArtifact = processTerminalArtifact("run-late", { observedAt: 1_700_000_000_001 });
  const forgedProof = proofFor(forgedArtifact, late.asyncDir);
  assert.notEqual(forgedProof.proofId, lateProof.proofId);
  await hostOutbox.enqueue({ ...forgedProof, workspaceId: late.receipt.workspaceId, ownerScope });
  const third = coordinatorServer(f.root, f.stateRoot, { endpointName: "c2.sock" });
  t.after(() => third.close());
  await third.listen();
  assert.equal((await third.proofOutbox.status(forgedProof.proofId)).state, "pending", "伪造 proofId 不得被接受");
  assert.equal((await third.proofOutbox.receipt(lateProof.proofId)).accepted, true, "既有 receipt 不被伪造证明改写");
  // Phase B 合同：同一注入场景内，终态 workspace 的处置请求必须可归因（state + allowed actions + next）。
  // （伪造证明本身的拒绝发生在 deliverTerminalProof 内部：reconcile 侧对已记录 observed 证明
  //   按 proofId 不等拒绝，回执文本含 next:；对 outbox 的可见效果就是『仍 pending + receipt 不变』。）
  assert.throws(
    () => internals(third).workspaceService.prepareOwnedDisposition(
      { workspaceId: delayedItem.workspaceId, ownerScope, operation: "release" },
      { settlementId: "settlement-after-release" },
    ),
    (error) => { assertAttributableRejection(error, { code: "MANAGED_WORKSPACE_STATE" }); return true; },
  );
  assertTerminal(observer, observerQueue, [delayedItem], "场景 2");
});

// ─────────────────────────────────────────────────────────────────────────────
// 场景 3：Host 中途退出（workspace active + 队列项 prepared）
// ─────────────────────────────────────────────────────────────────────────────
test("3) Host 进程在集成半途被 kill：新 coordinator 接手 prepared 项并推进到 released 终态", { timeout: 300_000 }, async (t) => {
  const f = await fixture(t, { name: "pd-host" });
  const host = await spawnHostProcess(t, {
    stage: "prepared", stateRoot: f.stateRoot, originRoot: f.originRoot, baseCommit: f.baseCommit,
    workspaceId: "workspace-host", runId: "run-host",
  });
  // 构造前提：workspace active、队列项 prepared（candidate 已发布但未完成）、宿主进程仍活着。
  const before = internals(coordinatorServer(f.root, f.stateRoot, { endpointName: "pre.sock" }));
  assert.equal(queueState(before.integrationQueue, host.info.queueItemId), "prepared", "构造前提：集成半途 prepared");
  assert.equal(workspaceState(before.workspaceService, host.info.workspaceId), "active", "构造前提：workspace active");
  await t.after(() => host.child.kill("SIGKILL"));

  // ── 故障注入：宿主进程被 kill -9（工作树与 durable 记录留在原地） ──
  host.child.kill("SIGKILL");
  await killAndAwaitDeath({ pid: host.info.pid });

  // proof 由「死掉的宿主」在退出前已投递（broker 侧异步事实已落盘时 Host 才可能死）。
  const artifact = processTerminalArtifact("run-host");
  const hostOutbox = outboxFor(f.stateRoot);
  await hostOutbox.enqueue({ ...proofFor(artifact, host.info.asyncDir), workspaceId: host.info.workspaceId, ownerScope });

  // ── 新进程接手：新的 coordinator 实例（新 instanceId）对同一 durable 状态做启动恢复 ──
  const takeover = coordinatorServer(f.root, f.stateRoot, { instanceId: "daemon-takeover", endpointName: "take.sock" });
  t.after(() => takeover.close());
  await takeover.listen();
  const observerQueue = internals(takeover).integrationQueue;
  const observer = observerService(f.stateRoot);
  const final = await converge(async () => ({
    queue: queueState(observerQueue, host.info.queueItemId),
    workspace: workspaceState(observer, host.info.workspaceId),
    proof: (await takeover.proofOutbox.status(terminalProofId(artifact))).state,
  }), (value) => value.queue === "completed" && value.workspace === "released" && value.proof === "delivered", { label: "prepared 项接手收敛" });
  assert.equal(final.workspace, "released", "prepared 项必须由接手进程推进到 released 终态");
  assertTerminal(observer, observerQueue, [host.info], "场景 3");
});

// ─────────────────────────────────────────────────────────────────────────────
// 场景 4：队列状态卡死注入（死 claim / resolving-conflict 无 child）
// ─────────────────────────────────────────────────────────────────────────────
test("4a) admitted 项 + 死 daemon claim：recoverClaims 回收后项回 queued 并继续收敛到终态", { timeout: 300_000 }, async (t) => {
  const f = await fixture(t, { name: "pd-stuck" });
  const host = await spawnHostProcess(t, {
    stage: "claim", stateRoot: f.stateRoot, originRoot: f.originRoot, baseCommit: f.baseCommit,
    workspaceId: "workspace-stuck", runId: "run-stuck",
  });
  await t.after(() => host.child.kill("SIGKILL"));
  // admitted claim 属于真实宿主进程：先把它 kill，claim 才是真正的死 claim。
  host.child.kill("SIGKILL");
  await killAndAwaitDeath({ pid: host.info.pid });
  // 模拟 Host 退出时工作树已被回收：workspace 落 released，队列项仍是 admitted（永久卡死形态）。
  const preparer = internals(coordinatorServer(f.root, f.stateRoot, { endpointName: "prep.sock" }));
  const artifact = processTerminalArtifact("run-stuck");
  await writeArtifact(host.info.asyncDir, artifact);
  preparer.workspaceService.preserveIntegrationDebt({ workspaceId: host.info.workspaceId, leaseId: host.info.leaseId, runId: "run-stuck", ownerScope });
  preparer.workspaceService.prepareOwnedDisposition(
    { workspaceId: host.info.workspaceId, ownerScope, operation: "release" },
    { settlementId: "settlement-stuck" },
  );
  preparer.workspaceService.applyPreparedDisposition({ workspaceId: host.info.workspaceId, ownerScope, settlementId: "settlement-stuck" });
  preparer.workspaceService.markDispositionSettled({ workspaceId: host.info.workspaceId, ownerScope, settlementId: "settlement-stuck", queueReceiptRef: "qsr-settlement-stuck" });
  assert.equal(workspaceState(preparer.workspaceService, host.info.workspaceId), "released", "构造前提：workspace 已 released");
  assert.equal(queueState(preparer.integrationQueue, host.info.queueItemId), "admitted", "构造前提：死 claim 卡住 admitted");

  const diagnostics = [];
  const takeOver = coordinatorServer(f.root, f.stateRoot, { instanceId: "daemon-stuck", endpointName: "stuck.sock", diagnosticSink: (entry) => diagnostics.push(entry) });
  t.after(() => takeOver.close());
  await takeOver.listen();
  const recovery = diagnostics.find((entry) => entry?.phase === "coordinator-recover-claims");
  assert.ok(recovery, "启动恢复必须调用 recoverClaims");
  assert.deepEqual(recovery.recovered.map((entry) => [entry.queueItemId, entry.state]), [[host.info.queueItemId, "queued"]], "死 claim 必须被回收为 queued（可推进）");
  const observerQueue = internals(takeOver).integrationQueue;
  const observer = observerService(f.stateRoot);
  const final = await converge(async () => queueState(observerQueue, host.info.queueItemId), (state) => state === "preserved", { label: "回收后推进" });
  assert.equal(final, "preserved", "回收后的项必须被对账推进到终态（不是重新卡死）");
  assertTerminal(observer, observerQueue, [host.info], "场景 4a");
  // Phase B 合同：对已 preserve 的项再推进集成必须是可归因拒绝。
  assert.throws(
    () => observerQueue.retryItem({ queueItemId: host.info.queueItemId, queueLeaseId: "stale-lease", revision: -1 }),
    (error) => { assert.match(String(error.message), /next: /); return true; },
  );
});

test("4b) resolving-conflict 项 + 无 child：reconcileIntegrations 的 preserve 兜底仍可达终态", { timeout: 240_000 }, async (t) => {
  const f = await fixture(t, { name: "pd-conflict" });
  const bootstrap = coordinatorServer(f.root, f.stateRoot, { endpointName: "boot.sock" });
  t.after(() => bootstrap.close());
  const child = { ...internals(bootstrap), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const conflict = allocate(child, { workspaceId: "workspace-conflict", runId: "run-conflict" });
  commitChildWork(conflict);
  const conflictItem = enqueue(child, conflict);
  const claim = child.integrationQueue.claimNext({ instanceId: "daemon-gone", pid: 999_999, birthIdentity: "e".repeat(64) });
  assert.equal(claim.queueItemId, conflictItem.queueItemId);
  // 真实冲突的 durable 事实：resolving-conflict + 冲突摘要被持久化。
  assert.equal(child.integrationQueue.markResolvingConflict({
    queueItemId: claim.queueItemId, queueLeaseId: claim.queueLeaseId, admissionGeneration: claim.admissionGeneration,
    conflictDigest: "1".repeat(64),
  }).state, "resolving-conflict");
  // 无 child 能继续 rebase：宿主已退出且工作树丢失（preserve 兜底的触发条件）。
  await rm(conflict.receipt.path, { recursive: true, force: true });

  const diagnostics = [];
  const takeOver = coordinatorServer(f.root, f.stateRoot, { instanceId: "daemon-conflict", endpointName: "conf.sock", diagnosticSink: (entry) => diagnostics.push(entry) });
  t.after(() => takeOver.close());
  await takeOver.listen();
  const reconcile = diagnostics.find((entry) => entry?.phase === "coordinator-startup-reconcile");
  assert.ok(reconcile, "启动对账必须执行");
  const result = reconcile.results.find((entry) => entry.queueItemId === conflictItem.queueItemId);
  assert.equal(result.state, "preserved", "无 child 可继续的 resolving-conflict 项必须由 preserve 兜底收敛");
  // 可归因性：拒绝原因必须具体到「工作树不可用」这一 durable 事实，不能是泛化失败。
  // GAP-2 已修：git-worktree.ts 的 failure() 现在也从 Phase B 的同一张 next 权威表取文案，
  // 因此这条**内部对账**错误文本同样带 `next:`（与用户入口 issueDisposition/status 一致）。
  assert.match(String(result.error), /worktree path is missing or unregistered/, `preserve 兜底必须保留可归因原因：${result.error}`);
  assert.match(String(result.error), /next: /, `内部对账拒绝也必须带 next 指引（Phase B 合同）：${result.error}`);
  const observerQueue = internals(takeOver).integrationQueue;
  const observer = observerService(f.stateRoot);
  assert.equal(queueState(observerQueue, conflictItem.queueItemId), "preserved");
  assert.equal(workspaceState(observer, conflictItem.workspaceId), "preserved");
  const intent = observerQueue.listRecoveryIntents().find((entry) => entry.queueItemId === conflictItem.queueItemId);
  assert.ok(intent, "preserve 兜底必须生成 recovery intent（恢复 owner 可见）");
  assert.equal(intent.requiredAction, "preserve");
  assert.equal(intent.delivery.state, "debt", "无 Host 投递通道时 intent 必须落 delivery debt 而不是静默丢弃");
  assertTerminal(observer, observerQueue, [conflictItem], "场景 4b");
  // Phase B 合同：终态之后从用户入口发起的处置仍必须可归因（state + allowed actions + next）。
  assert.throws(
    () => observer.issueOwnedDisposition({ workspaceId: conflictItem.workspaceId, ownerScope }),
    (error) => { assertAttributableRejection(error, { code: "MANAGED_WORKSPACE_STATE" }); return true; },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 场景 5：INV-REACH 缺口回归（GAP-1 修复后的终态断言）
//
// 组合：`resolving-conflict` 队列项 + child 已死（无人继续 rebase）+ workspace 健康可用。
// 修复前的现场（Phase D pin）：`reconcileIntegrations` → `advanceAutoIntegration({}, binding)` →
// 再次真实 rebase 仍冲突 → `markResolvingConflict` 以同一 conflictDigest 写入（noProgress=true，
// continuationAttempt 不递增）→ 无异常、无 preserve、无终态，每次重启重复同一空转，preserve
// 兜底只在「reconcile 抛错」时才发生（场景 4b）。
//
// 修复后的合同（noProgress → preserve，与 resume intent 耗尽路径同一收敛形态）：
// 1) 只有**无人认领**的推进计入无进展：`reconcileIntegrations` 在项记录的 daemon claim 已死
//    （或 pid 被复用 / 无 claim）时传 `countNoProgress`，同一 conflictDigest 的重复即一次空转续轮，
//    `continuationAttempt` 递增；child 主动 continue 的路径不计数（既有 guard 语义不回归）。
// 2) 达 `RESUME_MAX_NO_PROGRESS` 后转 preserve 并生成 recovery intent（delivery=debt），
//    与 resume intent 耗尽路径收敛到同一形态（preserveByBinding 与 recovery intent 均幂等，
//    因此两条路径不会产生双重 preserve / 两个 intent）。
// 断言：第一次重启对账即达终态；后续重启不再改写终态；workspace 仍可从用户入口按
// allowed actions + next 继续收口。
// ─────────────────────────────────────────────────────────────────────────────
test("5) GAP-1 回归：resolving-conflict + child 已死 + workspace 健康 → 重启对账收敛到 preserve 终态", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { name: "pd-gap" });
  const bootstrap = coordinatorServer(f.root, f.stateRoot, { endpointName: "boot.sock" });
  t.after(() => bootstrap.close());
  const child = { ...internals(bootstrap), root: f.root, originRoot: f.originRoot, baseCommit: f.baseCommit };
  const conflicted = allocate(child, { workspaceId: "workspace-gap", runId: "run-gap", writePaths: ["README.md"] });
  // workspace 侧与 origin 侧改同一行 → 真实 rebase 冲突（不是伪造的 state）。
  await writeFile(path.join(conflicted.receipt.path, "README.md"), "workspace side\n");
  git(conflicted.receipt.path, "add", ".");
  git(conflicted.receipt.path, "commit", "-m", "workspace work");
  const gapItem = enqueue(child, conflicted);
  await writeFile(path.join(f.originRoot, "README.md"), "origin side\n");
  git(f.originRoot, "add", ".");
  git(f.originRoot, "commit", "-m", "origin work");
  const targetHead = git(f.originRoot, "rev-parse", "refs/heads/main");
  // claim 属于已退出的 daemon（ESRCH 死身份）：child 不会再回来继续 rebase。
  const claim = child.integrationQueue.claimNext(
    { instanceId: "daemon-gap", pid: 999_998, birthIdentity: "d".repeat(64) },
    () => ({ admittedTargetHead: targetHead }),
  );
  const candidate = child.workspaceService.managedRebase({
    targetHead, queueLeaseId: claim.queueLeaseId, admissionGeneration: claim.admissionGeneration,
  }, conflicted.binding);
  assert.equal(candidate.state, "resolving-conflict", "构造前提：真实 rebase 冲突");
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(`${candidate.head}:${candidate.changedFiles?.join("\u0000") ?? ""}`).digest("hex");
  const marked = child.integrationQueue.markResolvingConflict({
    queueItemId: claim.queueItemId, queueLeaseId: claim.queueLeaseId,
    admissionGeneration: claim.admissionGeneration, conflictDigest: digest,
  });
  assert.equal(marked.state, "resolving-conflict");
  assert.equal(marked.continuationAttempt, 1);

  // child 不会再回来（真实 dead claim，宿主进程已退出）；workspace 保持健康可用。
  const restarts = [];
  for (const round of [1, 2, 3]) {
    const diagnostics = [];
    const restarted = coordinatorServer(f.root, f.stateRoot, { instanceId: `daemon-gap-${round}`, endpointName: `gap-${round}.sock`, diagnosticSink: (entry) => diagnostics.push(entry) });
    await restarted.listen();
    const queue = internals(restarted).integrationQueue;
    const item = queue.getItem(gapItem.queueItemId);
    const reconcile = diagnostics.find((entry) => entry?.phase === "coordinator-startup-reconcile");
    restarts.push({
      round, state: item.state, continuationAttempt: item.continuationAttempt ?? 0,
      reconcile: reconcile?.results?.find((entry) => entry.queueItemId === gapItem.queueItemId) ?? null,
    });
    await restarted.close();
  }

  // 第一次重启对账：同一 conflictDigest 的空转被计入 noProgress 上限并转 preserve。
  const first = restarts[0];
  assert.equal(first.reconcile?.state, "preserved", `reconcile 必须给出 preserve 终态结果：${JSON.stringify(first.reconcile)}`);
  assert.equal(first.reconcile?.reason, "conflict-no-progress-exhausted", "preserve 必须可归因到无进展耗尽");
  assert.equal(first.state, "preserved", "GAP-1：空转必须收敛到终态，不得停在 resolving-conflict");
  assert.equal(first.continuationAttempt, 2, "空转续轮必须计入 continuationAttempt（RESUME_MAX_NO_PROGRESS=2）");
  // 后续重启：终态不被改写，也不再出现在对账结果里（终态项不参与推进）。
  for (const entry of restarts.slice(1)) {
    assert.equal(entry.state, "preserved", `第 ${entry.round} 次重启不得改写既有终态`);
    assert.equal(entry.reconcile, null, `终态项不应对账推进（round ${entry.round}）`);
  }

  const observerQueue = observerQueueFor(f.stateRoot);
  const observer = observerService(f.stateRoot);
  assert.equal(queueState(observerQueue, gapItem.queueItemId), "preserved");
  assert.equal(workspaceState(observer, gapItem.workspaceId), "preserved");
  const intents = observerQueue.listRecoveryIntents().filter((entry) => entry.queueItemId === gapItem.queueItemId);
  assert.equal(intents.length, 1, "无进展 preserve 只生成一个 recovery intent（与 resume 耗尽路径收敛为单一语义）");
  assert.equal(intents[0].requiredAction, "preserve");
  assert.equal(intents[0].delivery.state, "debt", "无 Host 投递通道时 intent 必须落 delivery debt 而不是静默丢弃");
  assertTerminal(observer, observerQueue, [gapItem], "场景 5");
  // workspace 仍可继续收敛：preserved 的合法收口动作（release）与 next 指引在用户入口可见。
  assert.throws(
    () => observer.issueOwnedDisposition({ workspaceId: gapItem.workspaceId, ownerScope }),
    (error) => {
      assertAttributableRejection(error, { code: "MANAGED_WORKSPACE_STATE" });
      assert.match(String(error.message), /allowed actions: release/, `preserved 的收口动作必须可见：${error.message}`);
      return true;
    },
  );
});
