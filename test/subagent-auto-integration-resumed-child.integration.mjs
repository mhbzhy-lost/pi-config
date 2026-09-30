import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { auditManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createCoordinatorRegistry } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { resolveRepositoryIdentity } from "../packages/pi-subagents-enhanced/src/workspace/repository-identity.ts";
import { AcceptanceRpcHost, buildAcceptanceEnvironment, createAcceptanceRootRpcArgs, isAcceptanceAuditSettled } from "../scripts/probes/repository-merge-queue-acceptance.ts";
import { startScriptedModelServer } from "./fixtures/recovery-resume/scripted-model-server.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const piBinary = process.env.PI_REAL_BIN ?? "/opt/homebrew/bin/pi";
const runtimePath = resolve("packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
const asyncRunsRoot = () => join(tmpdir(), `pi-subagents-uid-${process.getuid()}`, "async-subagent-runs");

const EXECUTOR_PROFILE = `---
name: executor
description: R8 scripted coding executor for the recovery resume fixture
model: fake/deterministic
---

You are the R8 scripted executor. Perform the assigned work with the bash tool when asked; Auto Integration owns queue admission, rebase, conflict continuation, and publication.
`;

const REVIEWER_PROFILE = `---
name: reviewer
description: R8 scripted reviewer for the recovery resume fixture
model: fake/deterministic
---

You are the R8 scripted reviewer. Review deterministically.
`;

async function childPid(runId) {
  const statusPath = join(asyncRunsRoot(), runId, "status.json");
  try {
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    return Number.isSafeInteger(status.pid) && status.pid > 0 ? status.pid : undefined;
  } catch {
    return undefined;
  }
}

async function startScenario(t, { tasks, originAdvance = false, faultControl }) {
  const root = await mkdtemp(join(tmpdir(), "r8-resumed-child-"));
  const repository = join(root, "repository");
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(join(repository, ".pi", "agents"), { recursive: true });
  await writeFile(join(repository, "src", "pipeline.ts"), 'export const PIPELINE=["base"]\n');
  await writeFile(join(repository, ".pi", "agents", "executor.md"), EXECUTOR_PROFILE);
  await writeFile(join(repository, ".pi", "agents", "reviewer.md"), REVIEWER_PROFILE);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "r8@example.test");
  git(repository, "config", "user.name", "R8");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "r8 base");

  const modelServer = await startScriptedModelServer({ tasks });
  const configRoot = join(root, "config");
  await mkdir(join(configRoot, "extensions"), { recursive: true });
  // 生产接线要求 PI_CODING_AGENT_DIR/agents 存在 delegate/executor/reviewer 三个
  // 内置 profile：registerBuiltinAgentsViaEvents 在扩展加载期同步读取，缺文件即
  // ENOENT 使 Host 退出 1。注意不能直接复制 pi/agents 生产 profile：其 models 链
  // 在本测试的 fake 目录下全部不可用，resolveSpawnModel 的 declared-chain 预检
  // （resolveModelCandidates）会对带 model 的派发直接抛 MODEL_NOT_AVAILABLE；
  // 因此采用与 fake catalog 兼容的最小 profile（等价于 triage 第 2 节诊断用的
  // variant C wrapper 形态，见 var/upgrade/orphaned-integration-triage.md）。
  await mkdir(join(configRoot, "agents"), { recursive: true });
  for (const name of ["delegate", "executor", "reviewer"]) {
    await writeFile(join(configRoot, "agents", `${name}.md`), `---\nname: ${name}\ndescription: R8 scripted builtin ${name} for the recovery resume fixture\nmodel: fake/deterministic\n---\nR8 scripted builtin ${name} profile for the recovery resume fixture.\n`);
  }
  await writeFile(join(configRoot, "settings.json"), "{}\n");
  await writeFile(join(configRoot, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "r8-recovery-test" } }, null, 2));
  await writeFile(join(configRoot, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${modelServer.port}/v1`,
        api: "openai-completions",
        models: [{ id: "deterministic", name: "R8 scripted recovery", input: ["text"], contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  }, null, 2));

  const stateRoot = join(root, "state");
  const workspaceDir = join(stateRoot, "workspaces");
  await mkdir(workspaceDir, { recursive: true });

  const identity = await resolveRepositoryIdentity(repository);
  const registry = createCoordinatorRegistry({ commonDir: identity.commonDir, stateRoot: workspaceDir });
  const metadata = await registry.claim({ repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId });
  const faultControlState = faultControl ?? {};
  const recoveryEvents = [];
  const server = createCoordinatorServer({
    endpoint: metadata.endpoint,
    repositoryId: identity.repositoryId,
    storageRepositoryId: identity.storageRepositoryId,
    instanceId: metadata.instanceId,
    stateRoot: metadata.canonicalStateRoot,
    idleGraceMs: 120_000,
    challengeBroker: async (registryInput) => ({ nonce: "n", repositoryId: registryInput.repositoryId, coordinatorInstanceId: "i", rootSessionId: registryInput.rootSessionId, brokerProcessIdentity: "b".repeat(64) }),
    // 生产 daemon 恒有 broker sink；测试 daemon 提供同语义的 sink（记录事件并
    // 确认投递），避免 pump 反复记 debt 耗尽轮询通道的 attempt 预算。
    recoveryEventSink: (intent) => { recoveryEvents.push(structuredClone(intent)); return { state: "delivered" }; },
    fault: (event) => {
      if (event?.operation !== "integration") return;
      // after-admission fault：首次 claim 后抛出可重试错误，child 在 admitted
      // 阶段退出（turn 已结束、无重排定时器，进程排空后真实退出）。
      if (event.phase === "after-admission" && faultControlState.throwAfterAdmission === true) {
        throw new Error("coordinator transport temporarily unavailable");
      }
      if (event.phase === "after-prepared" && faultControlState.blockPublish === true) {
        throw new Error("coordinator transport temporarily unavailable");
      }
    },
  });
  await server.listen();

  const environment = buildAcceptanceEnvironment(process.env, stateRoot, configRoot);
  // spawn 形态必须携带真实 session：0.71 能力协商契约（rpc-client.ts 的
  // negotiateCapabilities，fail closed）要求 ping 投影的 session.sessionId/
  // sessionFile/cwd 三字段非空；--no-session 下 sessionFile=null，所有派发在
  // spawn 前即 CAPABILITY_NEGOTIATION_FAILED; missing: session.sessionFile。
  // 真实 session 环境由 buildAcceptanceEnvironment 已注入的
  // PI_CODING_AGENT_SESSION_DIR=stateRoot/sessions 提供，Host 自建会话文件
  // （绿先例 subagent-completion-notification 同一形态，无 --no-session）。
  const host = new AcceptanceRpcHost(piBinary, ["--mode", "rpc", "--no-extensions", "--approve", "-e", runtimePath, "--provider", "fake", "--model", "fake/deterministic"], {
    cwd: repository,
    env: {
      ...environment,
      PI_MODEL_EXCLUSIONS_PATH: join(root, "model-exclusions.json"),
    },
    prompt: JSON.stringify({ note: "r8 dispatch" }),
    startupTimeoutMs: 20_000,
    firstToolTimeoutMs: 60_000,
    diagnosticsDir: join(root, "diagnostics"),
    settlementTimeoutMs: 240_000,
    tempPath: root,
  }).start();

  t.after(async () => {
    await host.close().catch(() => undefined);
    await server.close();
    await registry.release().catch(() => undefined);
    await modelServer.close();
    try {
      for (const line of git(repository, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== repository) spawnSync("git", ["worktree", "remove", "--force", line.slice(9)], { cwd: repository });
      }
    } catch {}
    await rm(root, { recursive: true, force: true });
  });

  const scenario = {
    root, repository, host, server, modelServer,
    queue: () => server.internal.integrationQueue.listQueue(),
    intents: () => server.internal.integrationQueue.listResumeIntents(),
    audit: () => auditManagedWorkspaces({ stateRoot: workspaceDir, originRoot: repository }),
    childPid,
    async waitFor(check, label, timeoutMs = 180_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await host.assertHealthyAsync();
        const value = await check();
        if (value) return value;
        if (Date.now() >= deadline) {
          const queue = server.internal.integrationQueue.listQueue().map((item) => `${item.state}@r${item.revision}:${item.childRunId?.slice(0, 8)}`);
          const intents = server.internal.integrationQueue.listResumeIntents().map((intent) => `${intent.state}/${intent.attempt}/${intent.queueState}:${intent.sourceRunId?.slice(0, 8)}->${intent.resumedRun?.runId?.slice(0, 8) ?? "-"}(delivery=${intent.delivery?.state}/${intent.delivery?.attempts}:${String(intent.delivery?.reason ?? "").slice(0, 120)})`);
          const audit = scenario.audit();
          const workspaces = audit.inventory.workspaces.map((entry) => `${entry.receipt.state}:${entry.receipt.terminalProof?.state ?? "?"}`);
          throw new Error(`r8 wait timed out: ${label}; queue=[${queue}] intents=[${intents}] workspaces=[${workspaces}] serverRequests=${modelServer.requests.length}; auditCoordinator=${JSON.stringify(audit.coordinator)} auditDebts=${JSON.stringify(audit.debts)} orphan=${JSON.stringify(audit.inventory.orphanRegistrations)} legacy=${JSON.stringify(audit.inventory.legacy)} items=${JSON.stringify(audit.queue.items.map((item) => ({ s: item.state, seq: item.sequence, ath: (item.admittedTargetHead ?? "").slice(0, 8), ch: (item.candidateHead ?? "").slice(0, 8), ii: Boolean(item.integrationIntentId), wd: Boolean(item.workspaceDispositionReceiptId), ca: Boolean(item.completedAt) })))}`);
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    },
    async settle(expectedCount, label = "settlement") {
      return scenario.waitFor(async () => {
        const audit = scenario.audit();
        return isAcceptanceAuditSettled(audit, expectedCount) ? audit : null;
      }, label, 240_000);
    },
  };
  if (originAdvance) {
    // 等 workspace 完成分配（run 绑定完成）后推进 origin，制造 rebase 冲突。
    await scenario.waitFor(() => {
      const workspaces = auditManagedWorkspaces({ stateRoot: workspaceDir, originRoot: repository }).inventory.workspaces;
      return workspaces.some((entry) => entry.receipt?.run?.runId) ? true : null;
    }, "workspace allocation before origin advance");
    await writeFile(join(repository, "src", "pipeline.ts"), 'export const PIPELINE=["origin"]\n');
    git(repository, "add", ".");
    git(repository, "commit", "-m", "origin advance");
  }
  return scenario;
}

async function assertRecoveredCompletion(scenario, settledAudit, { expectedQueueState, allowRetryChain = false }) {
  const intents = settledAudit.queue.resumeIntents;
  assert.ok(intents.length >= 1, "至少一个 resume intent");
  const latestByItem = new Map();
  for (const intent of intents) {
    const current = latestByItem.get(intent.queueItemId);
    if (!current || intent.attempt > current.attempt) latestByItem.set(intent.queueItemId, intent);
  }
  const recovered = [...latestByItem.values()];
  assert.equal(recovered.length, 1, `期望一个恢复过的 queue item，实际 ${JSON.stringify(intents.map((intent) => ({ state: intent.state, attempt: intent.attempt })))}`);
  const intent = recovered[0];
  assert.equal(intent.state, "completed");
  assert.equal(intent.queueState, expectedQueueState);
  if (!allowRetryChain) assert.equal(intents.length, 1, `非重试链场景期望单一 intent，实际 ${JSON.stringify(intents.map((i) => ({ state: i.state, attempt: i.attempt })))}`);
  else assert.ok(intents.length >= 1, "重试链场景至少一个 intent");
  assert.ok(intent.resumedRun?.runId, "intent 必须记录 resumed run");
  const recoveredItem = settledAudit.queue.items.find((item) => item.workspaceId === intent.workspaceId);
  assert.ok(recoveredItem, "恢复的 queue item 必须在审计中");
  assert.equal(recoveredItem.childRunId, intent.resumedRun.runId, "queue item 必须重绑到 resumed run");
  assert.equal(recoveredItem.state, "completed");
  const supersessions = await scenario.server.proofOutbox.supersessions();
  assert.ok(supersessions.some((entry) => entry.resumedRunId === intent.resumedRun.runId), "旧 proof 必须 superseded");
  assert.deepEqual(await scenario.server.proofOutbox.debts(), []);
  assert.ok(settledAudit.inventory.workspaces.every((entry) => entry.receipt.terminalProof?.state === "observed" && entry.receipt.terminalProof?.conflict === false), "新 proof 必须 observed");
  assert.ok(settledAudit.inventory.workspaces.every((entry) => entry.receipt.state === "released"), "workspace 必须 released");
  // resumed child 真实启动过：其 async 运行目录存在。
  const resumedStatus = join(asyncRunsRoot(), intent.resumedRun.runId, "status.json");
  await assert.doesNotReject(() => readFile(resumedStatus, "utf8"), "resumed child 必须真实启动");
  return intent;
}

test("queued 阶段退出的 follower 经真实 resume 后完成集成", async (t) => {
  // 首个 claim 在 after-admission 抛出可重试错误：head 在 admitted 阶段自然
  // 退出（与五 child 现场一致），follower 在 queued 状态下被终止；两者均经
  // 真实 resume 收敛。
  const faultControl = { throwAfterAdmission: true };
  const scenario = await startScenario(t, { tasks: ["head", "follower"], faultControl });
  const queuedItem = await scenario.waitFor(() => {
    const queue = scenario.queue();
    return queue.some((item) => item.state === "admitted") && queue.some((item) => item.state === "queued")
      ? queue.find((item) => item.state === "queued") : null;
  }, "queued follower while head admitted");
  faultControl.throwAfterAdmission = false;
  const pid = await scenario.waitFor(() => scenario.childPid(queuedItem.childRunId), "follower pid");
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  const settled = await scenario.settle(2);
  const intents = settled.queue.resumeIntents;
  assert.equal(intents.length, 2, `head 与 follower 各一个 resume intent，实际 ${JSON.stringify(intents.map((intent) => ({ state: intent.state, queueState: intent.queueState })))}`);
  for (const intent of intents) {
    assert.equal(intent.state, "completed");
    assert.ok(intent.resumedRun?.runId);
    const recovered = settled.queue.items.find((item) => item.workspaceId === intent.workspaceId);
    assert.equal(recovered.childRunId, intent.resumedRun.runId);
    assert.equal(recovered.state, "completed");
  }
  const followerIntent = intents.find((intent) => intent.queueState === "queued");
  assert.ok(followerIntent, "follower 的 queued intent 必须存在");
  const supersessions = await scenario.server.proofOutbox.supersessions();
  for (const intent of intents) {
    assert.ok(supersessions.some((entry) => entry.resumedRunId === intent.resumedRun.runId), "旧 proof 必须 superseded");
  }
  assert.deepEqual(await scenario.server.proofOutbox.debts(), []);
});

test("admitted 阶段退出的 child 经真实 resume 后完成集成", async (t) => {
  // after-admission 可重试错误使 child 在 admitted 阶段自然退出（turn 已结束、
  // 无重排定时器，进程排空后真实退出），无需外部终止。
  const faultControl = { throwAfterAdmission: true };
  const scenario = await startScenario(t, { tasks: ["solo"], faultControl });
  await scenario.waitFor(() => scenario.queue().find((item) => item.state === "admitted") ?? null, "admission");
  faultControl.throwAfterAdmission = false;
  await scenario.waitFor(() => scenario.intents().find((intent) => intent.state === "pending") ?? null, "pending resume intent");
  const settled = await scenario.settle(1);
  await assertRecoveredCompletion(scenario, settled, { expectedQueueState: "admitted" });
});

test("resolving-conflict 阶段退出的 child 由 resumed child 解决冲突并完成集成", async (t) => {
  const scenario = await startScenario(t, { tasks: ["conflict"], originAdvance: true });
  const settled = await scenario.settle(1);
  const intent = await assertRecoveredCompletion(scenario, settled, { expectedQueueState: "resolving-conflict", allowRetryChain: true });
  assert.ok(intent.conflictDigest, "冲突场景必须记录 conflictDigest");
});

test("prepared 阶段退出的 child 经真实 resume 后完成集成", async (t) => {
  const faultControl = { blockPublish: true };
  const scenario = await startScenario(t, { tasks: ["prepared"], faultControl });
  await scenario.waitFor(() => scenario.queue().find((item) => item.state === "prepared") ?? null, "prepared item");
  await scenario.waitFor(() => scenario.intents().find((intent) => intent.state === "pending") ?? null, "pending resume intent");
  faultControl.blockPublish = false;
  const settled = await scenario.settle(1);
  await assertRecoveredCompletion(scenario, settled, { expectedQueueState: "prepared" });
});
