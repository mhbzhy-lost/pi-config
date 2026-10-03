import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecoveryResumeOrchestrator, RECOVERY_RESUME_PROMPT, recoverOrphanRun } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts";
import { createManualIntegrationHandoff } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-contract.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fakeEventBus() {
  const handlers = new Map();
  return {
    on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); return () => { const current = handlers.get(type) ?? []; const index = current.indexOf(handler); if (index >= 0) current.splice(index, 1); }; },
    emit(type, event) { for (const handler of [...(handlers.get(type) ?? [])]) handler(event); },
  };
}

function fakeRpc({ reject, resumedRunId = "run-resumed-1", resumedAsyncDir = "/var/tmp/async/resumed-1", bus } = {}) {
  const calls = [];
  return {
    calls,
    async resume(params) {
      calls.push(structuredClone(params));
      if (reject) throw new Error(reject);
      bus.emit("subagent:async-started", { id: resumedRunId, asyncDir: resumedAsyncDir, sessionId: "session-lifecycle", pid: 4321, agent: "executor" });
      return { content: [], details: { mode: "single", runId: resumedRunId, asyncDir: resumedAsyncDir } };
    },
  };
}

function fakeDeps(overrides = {}) {
  const bus = overrides.bus ?? fakeEventBus();
  const rpc = overrides.rpc ?? fakeRpc({ bus });
  const registered = [];
  const activations = [];
  const debts = [];
  const statusCalls = { count: 0, intents: overrides.statusIntents ?? [] };
  const deps = {
    bus,
    rpc,
    events: bus,
    coordinatorClient: {
      async recoveryStatus() { statusCalls.count += 1; return structuredClone(statusCalls.intents); },
      async resumeDebt(input) { debts.push(structuredClone(input)); return { state: "debt" }; },
    },
    registerAuthorizedRun: async (authorization) => { registered.push(structuredClone(authorization)); },
    activateResume: async (input) => { activations.push(structuredClone(input)); return { resumeIntent: { ...input, state: "activated" } }; },
    rootSessionId: "root-a",
    lifecycleSessionId: "session-lifecycle",
    ...overrides.deps,
  };
  return { ...deps, registered, activations, debts, statusCalls };
}

function resumeIntent(overrides = {}) {
  return {
    version: "integration-resume-intent.v1", resumeIntentId: "intent-1", queueItemId: "q1", workspaceId: "ws1", leaseId: "a".repeat(64),
    ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, sourceRunId: "run-source-1", sourceAsyncDir: "/var/tmp/async/source-1", sourceProofId: "1".repeat(64),
    attempt: 1, generation: 0, queueRevision: 3, queueState: "queued", conflictDigest: null, progressFingerprint: "f".repeat(64), noProgressCount: 0,
    requiredAction: "resume-child", state: "pending", resumedRun: null, delivery: { state: "delivered", attempts: 1 },
    createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z", ...overrides,
  };
}

function orchestratorFor(deps, options = {}) {
  return createRecoveryResumeOrchestrator({
    rpc: deps.rpc, events: deps.events, coordinatorClient: deps.coordinatorClient,
    registerAuthorizedRun: deps.registerAuthorizedRun, activateResume: deps.activateResume,
    rootSessionId: deps.rootSessionId, lifecycleSessionId: deps.lifecycleSessionId,
    pollIntervalMs: options.pollIntervalMs, startTimeoutMs: options.startTimeoutMs ?? 1000,
  });
}

test("结束 child 的 merge queue 未完成时生成主 agent 接管提示", () => {
  const message = createManualIntegrationHandoff({ resumeIntentId: "intent-1", sourceRunId: "run-source-1", workspaceId: "ws1", queueItemId: "q1" });
  assert.equal(message.customType, "subagent-integration-handoff");
  assert.match(message.content, /不会自动恢复/);
  assert.match(message.content, /主 Agent/);
  assert.match(message.content, /ws1/);
  assert.deepEqual(message.details, { resumeIntentId: "intent-1", sourceRunId: "run-source-1", workspaceId: "ws1", queueItemId: "q1" });
});

test("resume → child-start → 授权先于 activation，prompt 不含 model 覆盖", async () => {
  const deps = fakeDeps();
  const orchestrator = orchestratorFor(deps);
  const outcome = await orchestrator.submit(resumeIntent());
  assert.equal(outcome.state, "activated");
  assert.equal(deps.rpc.calls.length, 1);
  assert.equal(deps.rpc.calls[0].id, "run-source-1");
  assert.equal(deps.rpc.calls[0].message, RECOVERY_RESUME_PROMPT);
  assert.equal(Object.hasOwn(deps.rpc.calls[0], "model"), false);
  assert.deepEqual(deps.rpc.calls[0].chain ?? [], []);

  assert.equal(deps.registered.length, 1);
  assert.equal(deps.registered[0].kind, "coding");
  assert.equal(deps.registered[0].goal, null);
  assert.deepEqual(deps.registered[0].binding, { runId: "run-resumed-1", asyncDir: "/var/tmp/async/resumed-1", sessionId: "session-lifecycle", pid: 4321, agentProfile: "executor" });

  assert.equal(deps.activations.length, 1);
  assert.equal(deps.activations[0].resumeIntentId, "intent-1");
  assert.equal(deps.activations[0].authorization, "root");
  assert.equal(deps.activations[0].sourceRunId, "run-source-1");
  assert.deepEqual(deps.activations[0].resumedRun, { runId: "run-resumed-1", asyncDir: "/var/tmp/async/resumed-1", sessionId: "session-lifecycle", pid: 4321, agentProfile: "executor" });
  assert.deepEqual(deps.debts, []);
});

test("重复 submit（双通道重叠）去重为一次 resume 和一次 activation", async () => {
  const deps = fakeDeps();
  const orchestrator = orchestratorFor(deps);
  const intent = resumeIntent();
  const [first, second] = await Promise.all([orchestrator.submit(intent), orchestrator.submit(structuredClone(intent))]);
  assert.equal(first.state, "activated");
  assert.equal(second.state, "activated");
  assert.equal(deps.rpc.calls.length, 1);
  assert.equal(deps.activations.length, 1);
});

test("resume 失败（stopped/live/缺 session file 等）写 delivery debt，不注册不激活", async () => {
  const bus = fakeEventBus();
  const deps = fakeDeps({ rpc: fakeRpc({ bus, reject: "Async child 'run-source-1' is stopped and cannot be resumed" }) });
  const orchestrator = orchestratorFor(deps);
  const outcome = await orchestrator.submit(resumeIntent());
  assert.equal(outcome.state, "debt");
  assert.match(outcome.reason, /cannot be resumed/);
  assert.equal(deps.debts.length, 1);
  assert.equal(deps.debts[0].resumeIntentId, "intent-1");
  assert.equal(deps.debts[0].authorization, "root");
  assert.match(deps.debts[0].reason, /cannot be resumed/);
  assert.deepEqual(deps.registered, []);
  assert.deepEqual(deps.activations, []);
});

test("activation 失败也写 delivery debt", async () => {
  const deps = fakeDeps();
  deps.activateResume = async () => { throw new Error("root authorization required"); };
  const orchestrator = orchestratorFor(deps);
  const outcome = await orchestrator.submit(resumeIntent());
  assert.equal(outcome.state, "debt");
  assert.equal(deps.debts.length, 1);
  assert.match(deps.debts[0].reason, /root authorization/);
});

test("child-start 事件缺失（超时）写 debt", async () => {
  const bus = fakeEventBus();
  const rpc = {
    calls: [],
    async resume(params) {
      this.calls.push(params);
      return { details: { mode: "single", runId: "run-resumed-1", asyncDir: "/var/tmp/async/resumed-1" } };
    },
  };
  const deps = fakeDeps({ bus, rpc });
  const orchestrator = orchestratorFor(deps, { startTimeoutMs: 50 });
  const outcome = await orchestrator.submit(resumeIntent());
  assert.equal(outcome.state, "debt");
  assert.match(outcome.reason, /timed out/);
  assert.deepEqual(deps.activations, []);
});

test("child-start 事件身份与 resume reply 不一致写 debt", async () => {
  const bus = fakeEventBus();
  const rpc = {
    calls: [],
    async resume(params) {
      this.calls.push(params);
      bus.emit("subagent:async-started", { id: "run-resumed-1", asyncDir: "/var/tmp/async/other", sessionId: "session-lifecycle", pid: 4321, agent: "executor" });
      return { details: { mode: "single", runId: "run-resumed-1", asyncDir: "/var/tmp/async/resumed-1" } };
    },
  };
  const deps = fakeDeps({ bus, rpc });
  const orchestrator = orchestratorFor(deps);
  const outcome = await orchestrator.submit(resumeIntent());
  assert.equal(outcome.state, "debt");
  assert.match(outcome.reason, /asyncDir/);
});

test("starting 状态的 intent 重放：使用已记录 resumedRun，不再调用 resume RPC", async () => {
  const deps = fakeDeps();
  const orchestrator = orchestratorFor(deps);
  const recorded = { runId: "run-resumed-9", asyncDir: "/var/tmp/async/resumed-9", sessionId: "session-lifecycle", pid: 99, agentProfile: "executor" };
  const outcome = await orchestrator.submit(resumeIntent({ state: "starting", resumedRun: recorded }));
  assert.equal(outcome.state, "activated");
  assert.deepEqual(deps.rpc.calls, []);
  assert.deepEqual(deps.registered[0].binding, recorded);
  assert.deepEqual(deps.activations[0].resumedRun, recorded);
});

test("foreign root 的 intent 不处理", async () => {
  const deps = fakeDeps({ statusIntents: [resumeIntent({ ownerScope: { kind: "standalone-subagent", rootSessionId: "root-b" } })] });
  const orchestrator = orchestratorFor(deps);
  const outcome = await orchestrator.submit(resumeIntent({ ownerScope: { kind: "standalone-subagent", rootSessionId: "root-b" } }));
  assert.equal(outcome.state, "skipped");
  assert.deepEqual(deps.rpc.calls, []);
  assert.deepEqual(deps.activations, []);
  assert.deepEqual(deps.debts, []);
});

test("attempts 达上限的 intent 跳过", async () => {
  const deps = fakeDeps();
  const orchestrator = orchestratorFor(deps);
  const outcome = await orchestrator.submit(resumeIntent({ delivery: { state: "debt", attempts: 3 } }));
  assert.equal(outcome.state, "skipped");
  assert.deepEqual(deps.rpc.calls, []);
});

test("轮询发现本 root 的 pending intent 并完成 resume；dispose 后停止轮询", async () => {
  const deps = fakeDeps({ statusIntents: [resumeIntent()] });
  const orchestrator = orchestratorFor(deps, { pollIntervalMs: 20 });
  orchestrator.start();
  const deadline = Date.now() + 2000;
  while (deps.activations.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(deps.activations.length, 1);
  assert.equal(deps.rpc.calls.length, 1);

  orchestrator.dispose();
  const pollsAtDispose = deps.statusCalls.count;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(deps.statusCalls.count, pollsAtDispose, "dispose 后不再轮询");
});

test("轮询跳过 foreign root 与 attempts 超限的 intent", async () => {
  const deps = fakeDeps({ statusIntents: [
    resumeIntent({ resumeIntentId: "foreign", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-b" } }),
    resumeIntent({ resumeIntentId: "exhausted", delivery: { state: "debt", attempts: 3 } }),
  ] });
  const orchestrator = orchestratorFor(deps, { pollIntervalMs: 20 });
  orchestrator.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  orchestrator.dispose();
  assert.deepEqual(deps.rpc.calls, []);
  assert.deepEqual(deps.activations, []);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "resume-orchestrator-"));
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

test("recovery.status 返回 root 过滤后的 resume intent，resume-debt 记录投递债", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const client = await connectRealClient(f, "root-a");
  const foreign = await connectRealClient(f, "root-b");
  t.after(async () => { await client.close(); await foreign.close(); });
  const service = f.coordinator.internal.workspaceService;
  const queue = f.coordinator.internal.integrationQueue;
  const receipt = service.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId: "ws1", owner: { kind: "standalone-subagent", rootSessionId: "root-a", toolCallId: "tool-1" },
    originRoot: f.originRoot, requestedCwd: join(f.originRoot, "src"), originRef: "refs/heads/main", baseCommit: f.baseCommit,
    contractHash: "a".repeat(64), policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] },
  }));
  service.bindRun({ workspaceId: "ws1", run: { runId: "run-source-1", asyncDir: join(f.root, "async-1") } });
  const item = f.coordinator.internal.enqueueIntegration({
    requestId: "req-1", workspaceId: "ws1", leaseId: receipt.leaseId, strategy: "rebase-ff", targetRef: "refs/heads/main",
    authorizedWorkspaceHead: f.baseCommit, observedTargetHead: f.baseCommit,
  }, { workspaceId: "ws1", leaseId: receipt.leaseId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, runId: "run-source-1" });
  const intent = queue.requestChildResume({ queueItemId: item.queueItemId, sourceRunId: "run-source-1", sourceAsyncDir: join(f.root, "async-1"), sourceProofId: "1".repeat(64) });

  const owned = await client.recoveryStatus();
  assert.ok(owned.some((entry) => entry.resumeIntentId === intent.resumeIntentId && entry.requiredAction === "resume-child"));
  const other = await foreign.recoveryStatus();
  assert.ok(!other.some((entry) => entry.resumeIntentId === intent.resumeIntentId));

  const debt = await client.resumeDebt({ resumeIntentId: intent.resumeIntentId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, authorization: "root", reason: "resume failed: no session file" });
  assert.equal(debt.delivery.state, "debt");
  assert.match(debt.delivery.reason, /no session file/);
  assert.equal(debt.delivery.attempts, 1);
  await assert.rejects(() => foreign.resumeDebt({ resumeIntentId: intent.resumeIntentId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, authorization: "root", reason: "x" }), /root authorization|owner scope/i);
});

test("诊断日志：orchestrator 各阶段打点到 trace sink（供真实 LLM 验收现场定位）", async () => {
  const entries = [];
  const bus = fakeEventBus();
  const deps = fakeDeps({ bus });
  const orchestrator = createRecoveryResumeOrchestrator({
    rpc: deps.rpc, events: deps.events, coordinatorClient: deps.coordinatorClient,
    registerAuthorizedRun: deps.registerAuthorizedRun, activateResume: deps.activateResume,
    rootSessionId: deps.rootSessionId, lifecycleSessionId: deps.lifecycleSessionId,
    startTimeoutMs: 1000,
    trace: (entry) => entries.push(structuredClone(entry)),
  });
  const outcome = await orchestrator.submit(resumeIntent());
  assert.equal(outcome.state, "activated");
  const phases = entries.map((entry) => entry.phase);
  assert.deepEqual(phases.filter((phase) => phase.startsWith("recovery-resume")), [
    "recovery-resume-submit",
    "recovery-resume-resume-called",
    "recovery-resume-child-start-captured",
    "recovery-resume-registered",
    "recovery-resume-activated",
  ]);
  for (const entry of entries) {
    assert.equal(entry.version, 1);
    assert.equal(entry.resumeIntentId, "intent-1");
    assert.equal(entry.sourceRunId, "run-source-1");
  }
  // 失败路径也打点。
  const failingEntries = [];
  const failingBus = fakeEventBus();
  const failingDeps = fakeDeps({ bus: failingBus, rpc: fakeRpc({ bus: failingBus, reject: "stopped run" }) });
  const failing = createRecoveryResumeOrchestrator({
    rpc: failingDeps.rpc, events: failingDeps.events, coordinatorClient: failingDeps.coordinatorClient,
    registerAuthorizedRun: failingDeps.registerAuthorizedRun, activateResume: failingDeps.activateResume,
    rootSessionId: failingDeps.rootSessionId, lifecycleSessionId: failingDeps.lifecycleSessionId,
    trace: (entry) => failingEntries.push(structuredClone(entry)),
  });
  const debt = await failing.submit(resumeIntent());
  assert.equal(debt.state, "debt");
  assert.ok(failingEntries.some((entry) => entry.phase === "recovery-resume-resume-rejected"));
});

test("recoverOrphanRun exposes the standalone contract and fixed gate order", async () => {
  assert.equal(typeof recoverOrphanRun, "function");
  const calls = [];
  const input = {
    runId: "orphan-1", ownerReceiptId: "receipt-1", lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    gates: Object.fromEntries([
      ["runAuthorization", async () => { calls.push("RunAuthorization parse"); }],
      ["sessionEligibility", async () => { calls.push("P0 session eligibility"); }],
      ["identity", async () => { calls.push("identity/OwnerReceipt/processBirth"); }],
      ["broker", async () => { calls.push("broker generation/revision gate"); }],
      ["workspace", async () => { calls.push("workspace managed-workspace.v2 receipt"); }],
      ["inventory", async () => { calls.push("inventory match"); }],
      ["rebind", async () => { calls.push("CAS rebind"); }],
      ["lease", async () => { calls.push("issue/rebind lease"); }],
      ["barrier", async () => { calls.push("ReplayCursor barrier"); }],
      ["replay", async () => { calls.push("replay"); }],
      ["ack", async () => { calls.push("processing ACK"); }],
    ]),
    childStartTimeoutMs: 1,
  };
  const outcome = await recoverOrphanRun(input);
  assert.deepEqual(outcome, { kind: "rebound", runId: "orphan-1", ownerReceiptId: "receipt-1" });
  assert.deepEqual(calls, ["RunAuthorization parse", "P0 session eligibility", "identity/OwnerReceipt/processBirth", "broker generation/revision gate", "workspace managed-workspace.v2 receipt", "inventory match", "CAS rebind", "issue/rebind lease", "ReplayCursor barrier", "replay", "processing ACK"]);
});

test("recoverOrphanRun fails closed with debt/blocked-unknown and no heartbeat controls", async () => {
  const calls = [];
  const outcome = await recoverOrphanRun({ runId: "orphan-2", ownerReceiptId: "receipt-2", gates: {
    runAuthorization: async () => {},
    sessionEligibility: async () => { calls.push("gate"); throw new Error("secret token leaked"); },
  } });
  assert.equal(["blocked-unknown", "debt"].includes(outcome.kind), true);
  assert.equal(outcome.runId, "orphan-2");
  assert.equal(JSON.stringify(outcome).includes("secret token"), false);
  assert.deepEqual(calls, ["gate"]);
});

test("诊断日志：start watcher 事件被 lifecycleSessionId 过滤时打点跳过原因", async () => {
  const entries = [];
  const bus = fakeEventBus();
  // bus 不发事件 → child-start 超时，跳过原因可观测。
  const rpc = { calls: [], async resume(params) { this.calls.push(params); return { details: { runId: "run-resumed-1", asyncDir: "/var/tmp/async/resumed-1" } }; } };
  const deps = fakeDeps({ bus, rpc });
  const orchestrator = createRecoveryResumeOrchestrator({
    rpc: deps.rpc, events: deps.events, coordinatorClient: deps.coordinatorClient,
    registerAuthorizedRun: deps.registerAuthorizedRun, activateResume: deps.activateResume,
    rootSessionId: deps.rootSessionId, lifecycleSessionId: deps.lifecycleSessionId,
    startTimeoutMs: 30,
    trace: (entry) => entries.push(structuredClone(entry)),
  });
  const outcome = await orchestrator.submit(resumeIntent());
  assert.equal(outcome.state, "debt");
  assert.ok(entries.some((entry) => entry.phase === "recovery-resume-child-start-timeout"), JSON.stringify(entries.map((e) => e.phase)));
});
