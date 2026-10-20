// T25A/T25B/T25C（H3）专项：新增 disposition settlement 的七个故障窗口、startup 恢复屏障与分区隔离。
//
// 覆盖边界（如实声明）：
// - 全部使用临时 Git origin、临时 state root 与本地 UNIX socket coordinator；无网络、无真实 provider、
//   无 SIGKILL/危险进程实验，不触碰仓库真实 `var/workspaces`。
// - 崩溃用既有 `fault` 注入点表达（`service.ts` 的 settlement 三点 + `disposition-settlement.ts` 的四点），
//   不为验证新增任何生产分支；重启 = 新建 coordinator 并 `listen()`（`finishStartupRecovery()` 内重放）。
// - 旧发布链四窗口（after-prepared/after-intent/after-merge/before-queue-complete）由
//   `managed-workspace-integration-queue.integration.mjs` 覆盖，本文件不重复也不替代它。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha64 = (value) => value.repeat(64);

function repositoryIdOf(originRoot) {
  const common = git(originRoot, "rev-parse", "--git-common-dir");
  return createHash("sha256").update(common.startsWith("/") ? common : join(originRoot, common)).digest("hex");
}

/** 一个 fixture 内可反复“重启” coordinator：同一 stateRoot/repositoryId，新 endpoint、新 instanceId。 */
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "disp-settle-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  const repositoryId = options.repositoryId ?? repositoryIdOf(originRoot);
  const coordinators = [];
  let sockets = 0;
  let fault = null;
  const create = (name) => {
    // macOS UNIX socket 路径有 sun_path 长度上限；用短序号避免 EINVAL，不用长窗口名。
    const endpoint = join(root, `c${++sockets}.sock`);
    const coordinator = createCoordinatorServer({
      endpoint, repositoryId, stateRoot, idleGraceMs: 10_000,
      challengeBroker: async (registry, challenge) => ({ ...challenge, rootSessionId: registry.rootSessionId, brokerProcessIdentity: sha64("b") }),
      fault: (event) => fault?.(event),
    });
    coordinator.endpointPath = endpoint;
    coordinators.push(coordinator);
    return coordinator;
  };
  const coordinator = create("coordinator");
  t.after(async () => {
    for (const entry of coordinators) await entry.close().catch(() => {});
    try {
      for (const line of git(originRoot, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ") && line.slice("worktree ".length) !== originRoot) {
          spawnSync("git", ["worktree", "remove", "--force", line.slice("worktree ".length)], { cwd: originRoot, stdio: "ignore" });
        }
      }
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, originRoot, stateRoot, repositoryId,
    baseCommit: git(originRoot, "rev-parse", "HEAD"),
    coordinator,
    /** 注入一次崩溃；null 表示恢复正常。 */
    setFault(value) { fault = value; },
    crashOnce(phase) {
      let injected = false;
      this.setFault((event) => {
        if (injected || event.operation !== "settlement" || event.phase !== phase) return;
        injected = true;
        const error = new Error(`crash at ${phase}`);
        error.code = "TEST_FAULT";
        throw error;
      });
    },
    record: (workspaceId) => createManagedWorkspaceLedger({ stateRoot }).load(workspaceId).record,
    /** 新建 coordinator 并 listen()：listen 内部执行 settlement replay → proof replay → resume pump → ready。 */
    async restart(name) { const next = create(name); await next.listen(); return next; },
    createOnly(name) { return create(name); },
    async connect(coordinatorInstance, rootSessionId) {
      const client = await connectRepositoryCoordinator(
        { repositoryId },
        { protocol: "pi-root-subagent-broker-registry.v1", rootSessionId, endpoint: "broker.sock", pid: process.pid, processBirthIdentity: sha64("b") },
        { metadata: { protocol: "repository-workspace-coordinator.v1", repositoryId, storageRepositoryId: repositoryId, endpoint: coordinatorInstance.endpointPath, instanceId: coordinatorInstance.instanceId, pid: process.pid, birthIdentity: sha64("c"), canonicalStateRoot: stateRoot } },
      );
      t.after(() => client.close().catch(() => {}));
      return client;
    },
  };
}

/**
 * 分配一个已绑定 run 的 coding workspace。
 * queue=true 时登记 queue item（用于覆盖 binding/queue 结算/handoff）；
 * proof=true 时写入 observed terminal proof（discard/release 的前置）。
 */
async function allocate(f, workspaceId, rootSessionId, { commit = true, queue = false, proof = false, resumeIntent = false } = {}) {
  const service = f.coordinator.internal.workspaceService;
  const receipt = service.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId,
    owner: { kind: "standalone-subagent", rootSessionId, toolCallId: `tool-${workspaceId}` },
    originRoot: f.originRoot,
    requestedCwd: join(f.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: sha64("a"),
    policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] },
  }));
  const asyncDir = join(f.root, `async-${workspaceId}`);
  await mkdir(asyncDir, { recursive: true });
  const run = { runId: `run-${workspaceId}`, asyncDir };
  service.bindRun({ workspaceId, run });
  if (commit) {
    await writeFile(join(receipt.path, "src", `${workspaceId}.txt`), `${workspaceId}\n`);
    git(receipt.path, "add", ".");
    git(receipt.path, "commit", "-m", workspaceId);
  }
  const head = git(receipt.path, "rev-parse", "HEAD");
  const ownerScope = { kind: "standalone-subagent", rootSessionId };
  const binding = { workspaceId, leaseId: receipt.leaseId, runId: run.runId, ownerScope };
  const terminalProof = { state: "observed", conflict: false, runId: run.runId, rootSessionId, asyncDir, processInstance: `runner-${workspaceId}`, proofId: sha64("e") };
  let item = null;
  if (queue) {
    item = f.coordinator.internal.enqueueIntegration({
      requestId: `request-${workspaceId}`, workspaceId, leaseId: receipt.leaseId,
      strategy: "rebase-ff", targetRef: "refs/heads/main",
      authorizedWorkspaceHead: head, observedTargetHead: f.baseCommit,
    }, binding);
    if (resumeIntent) {
      f.coordinator.internal.integrationQueue.requestChildResume({
        queueItemId: item.queueItemId, sourceRunId: run.runId, sourceAsyncDir: asyncDir, sourceProofId: terminalProof.proofId,
      });
    }
  }
  if (proof) service.recordTerminalProof({ workspaceId, ownerScope, proof: terminalProof });
  return { receipt, run, asyncDir, head, ownerScope, binding, terminalProof, item, path: receipt.path, branch: receipt.branchRef?.slice("refs/heads/".length) ?? `pi-managed/${workspaceId}` };
}

/** 取得一次性处置授权（public 路径，不经内部捷径）。 */
async function issueToken(f, client, candidate, operation) {
  const issued = await client.issueDisposition({ workspaceId: candidate.receipt.workspaceId, ...(operation === "preserve" ? {} : { terminalProof: candidate.terminalProof }) });
  assert.ok(issued.actionToken.startsWith("managed-workspace-action.v1:"), "必须取得真实一次性 token");
  assert.ok(issued.allowedDispositions.includes(operation), `${operation} 不在当次允许处置内：${issued.allowedDispositions}`);
  return issued.actionToken;
}

const WINDOWS = [
  // service.ts:743 / :762 / :771
  { phase: "after-workspace-prepare", operation: "preserve", queue: true, resumeIntent: true },
  { phase: "after-workspace-git-before-commit", operation: "discard", queue: false },
  { phase: "after-workspace-effect", operation: "preserve", queue: false },
  // disposition-settlement.ts:23 / :28 / :29 / :31
  { phase: "after-coordinator-intent", operation: "discard", queue: true },
  { phase: "after-queue-settlement", operation: "preserve", queue: true, resumeIntent: true },
  { phase: "before-settlement-receipt", operation: "discard", queue: true },
  { phase: "after-settlement-receipt", operation: "preserve", queue: false },
];

/**
 * 崩溃后、恢复前的 durable 中间态。
 * workspace 效果提交前必须仍是 `disposing`；提交后状态已按操作变为 preserved/released，
 * 但 settlement 未完成前 `pendingAction.phase` 只能停在 `effect-committed`，不得自行变成 settled。
 */
function assertCrashedIntermediate(f, candidate, operation, expectedPhase) {
  const record = f.record(candidate.receipt.workspaceId);
  const expectedState = expectedPhase === "prepared" ? "disposing" : (operation === "preserve" ? "preserved" : "released");
  assert.equal(record.state, expectedState, "崩溃后必须保留当前阶段的真实现场");
  assert.equal(record.pendingAction.schemaVersion, "workspace-disposition-prepare.v1");
  assert.equal(record.pendingAction.operation, operation);
  assert.equal(record.pendingAction.phase, expectedPhase);
  assert.equal(record.pendingAction.binding.workspaceId, candidate.receipt.workspaceId);
  assert.equal(record.pendingAction.binding.runId, candidate.run.runId);
  assert.equal(record.pendingAction.binding.asyncDir, candidate.asyncDir);
  assert.equal(record.pendingAction.proofHash, operation === "preserve" ? null : candidate.terminalProof.proofId);
  assert.equal(record.pendingAction.executorHead, candidate.head);
  return record.pendingAction.settlementId;
}

/** 恢复后：workspace/queue/intent/receipt 四方收敛，且副作用不重复。 */
function assertSettled(f, coordinator, candidate, operation, settlementId, { resumeIntent = false, queued = false } = {}) {
  const record = f.record(candidate.receipt.workspaceId);
  assert.equal(record.state, operation === "preserve" ? "preserved" : "released");
  assert.equal(record.pendingAction.phase, "settled");
  assert.equal(record.pendingAction.settlementId, settlementId);
  assert.equal(record.pendingAction.workspaceReceiptRef, `wsr-${settlementId}`);
  assert.equal(record.pendingAction.queueReceiptRef, `qsr-${settlementId}`);
  // Git 副作用与终态一致：preserve 保留 worktree 与受管分支（供后续 release），
  // discard/release 则清理两者；两种结果都不得遗留不一致的注册项。
  assert.equal(existsSync(candidate.path), operation === "preserve");
  const worktrees = git(f.originRoot, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, operation === "preserve" ? 2 : 1, JSON.stringify(worktrees));
  const branches = git(f.originRoot, "branch", "--list", candidate.branch);
  if (operation === "preserve") assert.ok(branches.includes(candidate.branch), `preserve 必须保留受管分支：${branches}`);
  else assert.equal(branches, "", "discard/release 后受管分支不得残留");
  // origin 不被结算改写：HEAD 与 clean 状态保持基线。
  assert.equal(git(f.originRoot, "rev-parse", "HEAD"), f.baseCommit);
  assert.equal(git(f.originRoot, "status", "--porcelain"), "");
  // 跨账本收敛：intent settled、prepared 列表清空、queue 终态与 receipt 对齐。
  const intents = coordinator.internal.integrationQueue.listDispositionIntents();
  assert.equal(intents.length, 1, JSON.stringify(intents));
  assert.equal(intents[0].phase, "settled");
  assert.equal(intents[0].prepared.settlementId, settlementId);
  assert.equal(intents[0].workspaceReceiptRef, `wsr-${settlementId}`);
  assert.equal(intents[0].queueReceiptRef, `qsr-${settlementId}`);
  assert.deepEqual(coordinator.internal.workspaceService.listPreparedDispositions(), []);
  if (queued) {
    const item = coordinator.internal.integrationQueue.getItem(candidate.item.queueItemId);
    assert.equal(item.state, operation === "preserve" ? "preserved" : "cancelled");
    assert.equal(item.dispositionSettlementId, settlementId);
    assert.equal(item.dispositionReceiptRef, `qsr-${settlementId}`);
  }
  if (resumeIntent) {
    const intentsForRun = coordinator.internal.integrationQueue.listResumeIntents(candidate.ownerScope.rootSessionId);
    assert.equal(intentsForRun.length, 1);
    assert.equal(intentsForRun[0].state, "completed", "结算必须关闭匹配的 handoff/resume intent");
  }
}

test("七个新增 settlement 故障窗口在重启后幂等收敛，且不重复 Git 副作用", async (t) => {
  for (const window of WINDOWS) {
    await t.test(`${window.phase}/${window.operation}`, async (t) => {
      const f = await fixture(t);
      await f.coordinator.listen();
      const workspaceId = `ws-${window.phase}`;
      const rootSessionId = `root-${window.phase}`;
      const candidate = await allocate(f, workspaceId, rootSessionId, { queue: window.queue, proof: window.operation !== "preserve", resumeIntent: Boolean(window.resumeIntent) });
      const client = await f.connect(f.coordinator, rootSessionId);
      const actionToken = await issueToken(f, client, candidate, window.operation);

      f.crashOnce(window.phase);
      await assert.rejects(
        () => client.dispose({ workspaceId, disposition: window.operation, actionToken, ...(window.operation === "preserve" ? { reason: "crash-window-probe" } : { terminalProof: candidate.terminalProof }) }),
        new RegExp(`crash at ${window.phase}`),
        "故障窗口必须真实抛出，而不是被吞掉",
      );
      f.setFault(null);

      // 中间态：授权已消费（同一 token 不可再用），durable prepare 保留。
      const expectedPhase = ["after-workspace-prepare", "after-workspace-git-before-commit", "after-coordinator-intent"].includes(window.phase)
        ? "prepared" : "effect-committed";
      const settlementId = assertCrashedIntermediate(f, candidate, window.operation, expectedPhase);
      await assert.rejects(
        () => client.dispose({ workspaceId, disposition: window.operation, actionToken, ...(window.operation === "preserve" ? { reason: "crash-window-probe" } : {}) }),
        (error) => Boolean(error) && /MANAGED_WORKSPACE|stale|replay|settled|disposing|state/i.test(`${error.code ?? ""} ${error.message}`),
        "崩溃后不得用旧 token 再走一条新的处置路径",
      );

      // 重启：listen() 内的 settlement replay 必须凭 durable prepare 收敛，不索要新 token。
      const restarted = await f.restart(`restart-${window.phase}`);
      assertSettled(f, restarted, candidate, window.operation, settlementId, { resumeIntent: Boolean(window.resumeIntent), queued: window.queue });

      // 再次重启：重放幂等，不产生第二个 intent、不重复清理或重复结算。
      const second = await f.restart(`restart2-${window.phase}`);
      assertSettled(f, second, candidate, window.operation, settlementId, { resumeIntent: Boolean(window.resumeIntent), queued: window.queue });
      assert.equal(second.internal.integrationQueue.listDispositionIntents().length, 1, "重放不得追加第二个 settlement intent");
    });
  }
});

test("workspace-only prepare（coordinator intent 之前崩溃）由重启扫描发现并补建 intent", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const candidate = await allocate(f, "ws-orphan-prepare", "root-orphan-prepare", { proof: false });
  const client = await f.connect(f.coordinator, "root-orphan-prepare");
  const actionToken = await issueToken(f, client, candidate, "preserve");
  f.crashOnce("after-workspace-prepare");
  await assert.rejects(() => client.dispose({ workspaceId: candidate.receipt.workspaceId, disposition: "preserve", actionToken, reason: "orphan-prepare" }), /crash at after-workspace-prepare/);
  f.setFault(null);
  // 崩溃发生在 recordDispositionIntent 之前：queue 侧没有任何 intent，只能靠 workspace 扫描发现。
  assert.deepEqual(f.coordinator.internal.integrationQueue.listDispositionIntents(), []);
  assert.equal(f.record(candidate.receipt.workspaceId).pendingAction.phase, "prepared");

  const restarted = await f.restart("restart-orphan");
  const settlementId = f.record(candidate.receipt.workspaceId).pendingAction.settlementId;
  const intents = restarted.internal.integrationQueue.listDispositionIntents();
  assert.equal(intents.length, 1, "恢复必须补建 coordinator intent");
  assert.equal(intents[0].phase, "settled");
  assert.equal(intents[0].prepared.settlementId, settlementId);
  assert.equal(f.record(candidate.receipt.workspaceId).state, "preserved");
});

test("startup 恢复未完成时 mutation 被拒，只读诊断仍可用", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const candidate = await allocate(f, "ws-barrier", "root-barrier", { proof: false });
  const client = await f.connect(f.coordinator, "root-barrier");
  const actionToken = await issueToken(f, client, candidate, "preserve");
  f.crashOnce("after-workspace-prepare");
  await assert.rejects(() => client.dispose({ workspaceId: candidate.receipt.workspaceId, disposition: "preserve", actionToken, reason: "barrier" }), /crash at after-workspace-prepare/);
  await client.close();

  // 重启时让 replay 自身失败：listen() 拒绝，startupReady 保持 false，但 socket 已在监听。
  f.crashOnce("after-coordinator-intent");
  const blocked = f.createOnly("barrier");
  await assert.rejects(() => blocked.listen(), /crash at after-coordinator-intent/);
  const blockedClient = await f.connect(blocked, "root-barrier");
  await assert.rejects(
    () => blockedClient.dispose({ workspaceId: candidate.receipt.workspaceId, disposition: "preserve", actionToken, reason: "barrier" }),
    (error) => error.code === "COORDINATOR_RECOVERY_NOT_READY",
    "恢复未就绪时写操作必须 fail closed",
  );
  const audit = await blockedClient.audit({});
  assert.equal(Array.isArray(audit.records ?? audit.workspaces ?? []), true, "queue.audit 属恢复期允许的只读诊断");
  f.setFault(null);

  // 恢复成功后的 listen 与失败重试路径一致：同一 durable prepare 最终收敛。
  const recovered = await f.restart("barrier-recovered");
  const settlementId = f.record(candidate.receipt.workspaceId).pendingAction.settlementId;
  assert.equal(f.record(candidate.receipt.workspaceId).state, "preserved");
  assert.equal(recovered.internal.integrationQueue.listDispositionIntents()[0].prepared.settlementId, settlementId);
});

test("跨 repository 分区的 prepared disposition 不被其它分区的启动恢复消费", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const candidate = await allocate(f, "ws-partition", "root-partition", { proof: false });
  const client = await f.connect(f.coordinator, "root-partition");
  const actionToken = await issueToken(f, client, candidate, "preserve");
  f.crashOnce("after-workspace-prepare");
  await assert.rejects(() => client.dispose({ workspaceId: candidate.receipt.workspaceId, disposition: "preserve", actionToken, reason: "partition" }), /crash at after-workspace-prepare/);
  f.setFault(null);

  // 同一 stateRoot、不同 repositoryId：另一个分区的恢复不得消费本分区的 prepare。
  const foreignRepositoryId = createHash("sha256").update("foreign-partition").digest("hex");
  const foreign = createCoordinatorServer({
    endpoint: join(f.root, "foreign.sock"), repositoryId: foreignRepositoryId, stateRoot: f.stateRoot, idleGraceMs: 10_000,
    challengeBroker: async (registry, challenge) => ({ ...challenge, rootSessionId: registry.rootSessionId, brokerProcessIdentity: sha64("b") }),
  });
  await foreign.listen();
  t.after(() => foreign.close().catch(() => {}));
  const untouched = f.record(candidate.receipt.workspaceId);
  assert.equal(untouched.state, "disposing", "其它分区不得结算本分区的处置");
  assert.equal(untouched.pendingAction.phase, "prepared");
  assert.deepEqual(foreign.internal.workspaceService.listPreparedDispositions(), []);

  const restarted = await f.restart("restart-partition");
  assert.equal(f.record(candidate.receipt.workspaceId).state, "preserved");
  assert.equal(restarted.internal.integrationQueue.listDispositionIntents().length, 1);
});

test("durable prepare 的不可变字段被篡改时恢复 fail closed，不猜测原意图", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const candidate = await allocate(f, "ws-tamper", "root-tamper", { queue: true, proof: true });
  const client = await f.connect(f.coordinator, "root-tamper");
  const actionToken = await issueToken(f, client, candidate, "discard");
  // 崩在 intent 之后：queue 侧留有未篡改的 prepared 副本，workspace 侧记录被篡改。
  f.crashOnce("after-coordinator-intent");
  await assert.rejects(
    () => client.dispose({ workspaceId: candidate.receipt.workspaceId, disposition: "discard", actionToken, terminalProof: candidate.terminalProof }),
    /crash at after-coordinator-intent/,
  );
  f.setFault(null);
  assert.equal(f.coordinator.internal.integrationQueue.listDispositionIntents()[0].phase, "authorized");

  const recordPath = join(f.stateRoot, "repositories", f.repositoryId, "records", `${candidate.receipt.workspaceId}.json`);
  const raw = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(raw.pendingAction.operation, "discard");
  raw.pendingAction.operation = "preserve";
  raw.pendingAction.reason = "tampered";
  await writeFile(recordPath, `${JSON.stringify(raw)}\n`);

  const tampered = f.createOnly("tampered");
  // queue 侧保留原始 prepared 副本，workspace 侧被篡改；无论哪一侧先被读取，
  // 恢复都必须在写任何效果前 fail closed，而不是挑选其中一个版本继续。
  await assert.rejects(() => tampered.listen(), /settlement intent identity mismatch|prepared workspace disposition identity changed|MANAGED_WORKSPACE_BINDING/i, "篡改不可变字段必须 fail closed");
  const stillDisposing = f.record(candidate.receipt.workspaceId);
  assert.equal(stillDisposing.state, "disposing", "fail closed 时不得推进为 released/preserved");
  assert.equal(existsSync(candidate.path), true, "fail closed 时不得执行 Git 清理");
  const record = await readFile(recordPath, "utf8");
  assert.match(record, /"operation":"preserve"|preserve/, "现场保留供人工取证，不被恢复覆盖");
});
