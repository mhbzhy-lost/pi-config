import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { PlanExecutionService } from "pi-subagents-enhanced/execution";
import { resolveRepositoryIdentity } from "pi-subagents-enhanced/workspace";
import { readPlanContract, type CheckReceipt, type GoalCheckEvidence, type PlanBinding } from "./contract.ts";
import { admitRepositoryCandidates, bindingSemanticInput, isMultiRepositoryBinding,
  resolveParticipatingRepositories, resolveTaskRepository, type RepositoryCandidate } from "./repository-resolution.ts";
import { decodeGoalRuntimeConfig, DEFAULT_GOAL_RUNTIME_CONFIG, type GoalRuntimeConfig } from "./config.ts";
import { createGoalRuntime, type NextAction } from "./scheduler.ts";
import { createGoalStateStore, GOAL_CHECK_EVIDENCE_CUSTOM_TYPE, type GoalStateStore } from "./session-state.ts";
import { captureSubject, verifyChecks } from "./verification.ts";
import { installGoalContinuity, reconcileGoalSession } from "./continuity.ts";

export { readGoalRuntimeConfig } from "./config.ts";
export type { GoalRuntimeConfig } from "./config.ts";

/** 字段名及必填性来自计划 §4.3；不接受 command、passed、model 或 action token。 */
export const PLAN_TOOL_PARAMETERS = {
  plan_execute: Type.Object({
    plan_path: Type.String({ minLength: 1 }), mode: Type.Literal("subagent-driven"),
  }, { additionalProperties: false }),
  plan_status: Type.Object({}, { additionalProperties: false }),
  plan_checkpoint: Type.Object({
    task_id: Type.Optional(Type.String({ minLength: 1 })),
    decisions: Type.Array(Type.String({ minLength: 1 })),
    source_refs: Type.Array(Type.String({ minLength: 1 })),
    next_action: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  plan_retry: Type.Object({
    task_id: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1, pattern: "\\S" }),
    expected_revision: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  plan_verify: Type.Object({
    check_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })),
  }, { additionalProperties: false }),
};

export type GoalRuntimeSession = {
  generation: number;
  sessionId: string;
  sessionFile: string | undefined;
  manager: ExtensionContext["sessionManager"];
  context: ExtensionContext;
  store: GoalStateStore;
  runtime: ReturnType<typeof createGoalRuntime> | null;
  execution: PlanExecutionService | null;
  unsubscribe: (() => void) | null;
  ready: Promise<void>;
  blockedReason: string | null;
  settled: boolean;
  pendingContinuation: boolean;
  goalTurn: boolean;
  suspended: boolean;
  lastWakeFingerprint: string | null;
  refreshing: Promise<void> | null;
  invalidated: boolean;
  compactPending: { reason: "manual" | "threshold" | "overflow"; willRetry: boolean } | null;
  recoveryPending: boolean;
  navigating: boolean;
  replacing: boolean;
  executionAvailabilityUnsubscribe: (() => void) | null;
};

export type InstallGoalRuntimeOptions = {
  config?: GoalRuntimeConfig;
  resolveExecution: (rootSessionId: string) => PlanExecutionService | undefined;
  subscribeExecution?: (rootSessionId: string, listener: () => void) => () => void;
  sessionEnabled?: () => boolean;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function result(details: unknown, isError = false): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details, isError };
}

/** 绑定时发现；重入只核验固定参与记录，绝不重扫目录库存。供后续恢复接线复用。 */
export async function resolvePlanBinding(input: {
  cwd: string; planPath: string; sessionId: string; sessionFile: string; previousBinding?: PlanBinding;
}, exec: ExtensionAPI["exec"]) {
  const located = await exec("git", ["-C", input.cwd, "rev-parse", "--show-toplevel"]);
  const repositoryRoot = await realpath(located.code === 0 ? located.stdout.trim() : input.cwd);
  const planPath = await realpath(resolve(input.cwd, input.planPath));
  const within = relative(repositoryRoot, planPath);
  if (isAbsolute(within) || within === ".." || within.startsWith("../")) fail("GOAL_PLAN_OUTSIDE_REPOSITORY", "计划文件必须位于当前仓库或超级根内");
  const { contract, contractHash } = await readPlanContract(planPath);
  const base = { planPath, contractHash, repositoryRoot, sessionId: input.sessionId, sessionFile: input.sessionFile };
  if (located.code === 0) {
    if (input.previousBinding && isMultiRepositoryBinding(input.previousBinding)
      && input.previousBinding.repositoryRoot === repositoryRoot) fail("GOAL_REPOSITORY_IDENTITY_CHANGED", "原超级根现在属于 Git 仓库");
    return { contract, binding: base };
  }

  async function inspect(repoId: string): Promise<RepositoryCandidate> {
    const root = join(repositoryRoot, repoId);
    try {
      const realRoot = await realpath(root);
      const top = await exec("git", ["-C", root, "rev-parse", "--show-toplevel"]);
      if (top.code !== 0) fail("GOAL_REPOSITORY_TOPOLOGY_INVALID", `${repoId} 不再是可用 Git 仓库`);
      const gitDir = await exec("git", ["-C", root, "rev-parse", "--absolute-git-dir"]);
      if (gitDir.code !== 0) fail("GOAL_REPOSITORY_TOPOLOGY_INVALID", `${repoId} 缺少 Git 目录`);
      const identity = await resolveRepositoryIdentity(root);
      return { repoId, root, realRoot, gitRoot: await realpath(top.stdout.trim()),
        gitDir: await realpath(gitDir.stdout.trim()), commonDir: identity.commonDir,
        originRoot: await realpath(identity.originRoot), migrationDebt: !!identity.migrationDebt,
        repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && String(error.code).startsWith("GOAL_")) throw error;
      fail("GOAL_REPOSITORY_TOPOLOGY_INVALID", `${repoId} 仓库准入失败：${messageOf(error)}`);
    }
  }
  const previous = input.previousBinding;
  if (previous && isMultiRepositoryBinding(previous) && previous.planPath === planPath
    && previous.repositoryRoot === repositoryRoot && previous.contractHash === contractHash) {
    const repositories = admitRepositoryCandidates(repositoryRoot, await Promise.all(previous.repositories.map(repository => inspect(repository.repoId))));
    const binding = { ...base, repositories: resolveParticipatingRepositories(contract, repositories) };
    if (JSON.stringify(bindingSemanticInput(binding)) !== JSON.stringify(bindingSemanticInput(previous))) {
      fail("GOAL_REPOSITORY_IDENTITY_CHANGED", "固定参与仓库身份与原 binding 不一致");
    }
    return { contract, binding };
  }
  const candidates: RepositoryCandidate[] = [];
  for (const entry of (await readdir(repositoryRoot, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // 只发现直接 Git 根；裸目录及其内部嵌套仓库不进入候选集合。
    try { await lstat(join(repositoryRoot, entry.name, ".git")); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
      throw error;
    }
    candidates.push(await inspect(entry.name));
  }
  const repositories = resolveParticipatingRepositories(contract, admitRepositoryCandidates(repositoryRoot, candidates));
  return { contract, binding: { ...base, repositories } };
}

/** 下一动作只提供工具指引；真正派发/检查始终在五个工具的 execute 内发生。 */
export function describeGoalNextAction(next: NextAction, planPath: string, revision: number): string {
  switch (next.kind) {
    case "advance": return `调用 plan_execute(${JSON.stringify({ plan_path: planPath, mode: "subagent-driven" })}) 推进 ready 任务：${next.taskIds.join("、")}。`;
    case "retry": return `任务 ${next.taskId} 需要修复。先核对失败证据，提供非空针对性 message，再调用 plan_retry；task_id=${JSON.stringify(next.taskId)}，expected_revision=${revision}。${next.reason}`;
    case "verify": return `调用 plan_verify(${JSON.stringify({ check_ids: next.checkIds })}) 运行契约检查。`;
    case "wait": return `未完成：${next.reason}；任务：${next.taskIds.join("、")}。等待事实通知，不轮询。`;
    case "blocked": return `未完成／阻塞：${next.reason}。依据 run/workspace 引用使用 subagent_run_status、managed_workspace_status 诊断，必要时请求人工处置。`;
    case "done": return "当前计划的终态检查已由 runtime 确认完成。";
  }
}

/** 仅组装 T1–T5 与 Host；不复制调度、资源管理或验证状态机。 */
export function installGoalRuntime(pi: ExtensionAPI, options: InstallGoalRuntimeOptions) {
  const config = decodeGoalRuntimeConfig(options.config ?? DEFAULT_GOAL_RUNTIME_CONFIG);
  if (!config.enabled) return undefined;
  let generation = 0;
  let current: GoalRuntimeSession | null = null;

  function isCurrent(session: GoalRuntimeSession): boolean {
    return current === session && generation === session.generation
      && session.manager.getSessionId() === session.sessionId
      && session.manager.getSessionFile() === session.sessionFile;
  }
  function assertCurrent(session: GoalRuntimeSession, ctx?: ExtensionContext): void {
    if (!isCurrent(session) || (ctx && (ctx.sessionManager !== session.manager
      || ctx.sessionManager.getSessionId() !== session.sessionId
      || ctx.sessionManager.getSessionFile() !== session.sessionFile))) {
      fail("GOAL_SESSION_CHANGED", "Goal 回调已不属于当前 Host session/generation");
    }
  }
  function dispose(): void {
    generation++;
    const previous = current;
    current = null;
    previous?.unsubscribe?.();
    previous?.executionAvailabilityUnsubscribe?.();
    if (previous) {
      previous.unsubscribe = null;
      previous.executionAvailabilityUnsubscribe = null;
    }
  }
  function status(session: GoalRuntimeSession) {
    const state = session.store.read();
    const next = state && session.runtime ? session.runtime.nextAction() : null;
    const multiBinding = state && isMultiRepositoryBinding(state.binding) ? state.binding : null;
    const tasks = state ? Object.fromEntries(state.contract.tasks.map(task => {
      const repoId = multiBinding ? resolveTaskRepository(task, multiBinding.repositories).repoId : undefined;
      return [task.id, { ...state.tasks[task.id], ...(repoId === undefined ? {} : { repoId }) }];
    })) : {};
    const checkpoint = state ? {
      ...state.checkpoint,
      ...(multiBinding && state.checkpoint.taskId
        ? { repoId: resolveTaskRepository(state.contract.tasks.find(task => task.id === state.checkpoint.taskId)!, multiBinding.repositories).repoId }
        : {}),
    } : null;
    return {
      state,
      // 这是只读展示投影；repoId 不写入 TaskState/checkpoint，始终由原合同与固定 binding 推导。
      tasks,
      checkpoint,
      storage: session.store.diagnose(), facts: session.runtime?.readFacts() ?? {}, next,
      blockedReason: session.blockedReason,
      guidance: state && next ? describeGoalNextAction(next, state.binding.planPath, state.revision) : "当前没有可推进的计划；核对存储与执行服务诊断。",
    };
  }
  function actionable(next: NextAction): boolean {
    return next.kind === "advance" || next.kind === "retry" || next.kind === "verify";
  }
  function wakeFingerprint(session: GoalRuntimeSession): string {
    const state = session.store.read()!;
    // revision、通知次数和时间戳不进入去重指纹。
    return createHash("sha256").update(JSON.stringify({ planId: state.planId,
      status: state.status, tasks: state.tasks, facts: session.runtime!.readFacts(), next: session.runtime!.nextAction(),
      checks: state.receipts.map(r => ({ checkId: r.checkId, subject: r.subject, outcome: r.outcome })),
    })).digest("hex");
  }
  function wakeIfIdle(session: GoalRuntimeSession): void {
    assertCurrent(session);
    const state = session.store.read();
    if (!state || state.status !== "active" || !session.runtime || session.blockedReason || session.suspended
      || !session.settled || session.compactPending || session.navigating || session.recoveryPending
      || !session.context.isIdle() || session.context.hasPendingMessages()
      || session.pendingContinuation || !session.store.diagnose().writable) return;
    const next = session.runtime.nextAction();
    if (!actionable(next)) return;
    const fingerprint = wakeFingerprint(session);
    if (fingerprint === session.lastWakeFingerprint) return;
    session.pendingContinuation = true;
    session.lastWakeFingerprint = fingerprint;
    try {
      // Pi 公共 sendMessage 返回 void：这里只记录请求，不把它当成已消费回执。
      pi.sendMessage({ customType: "goal-runtime.continue.v1", display: true,
        content: describeGoalNextAction(next, state.binding.planPath, state.revision),
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      if (isCurrent(session)) { session.pendingContinuation = false; session.blockedReason = messageOf(error); }
    }
  }
  async function reconcile(session: GoalRuntimeSession): Promise<void> {
    session.invalidated = true;
    if (session.replacing) return;
    if (session.refreshing) return session.refreshing;
    const flight = (async () => {
      while (session.invalidated && !session.replacing && isCurrent(session)) {
        session.invalidated = false;
        if (session.store.read() && session.runtime) await session.runtime.refreshRuns();
      }
      if (isCurrent(session)) wakeIfIdle(session);
    })();
    session.refreshing = flight;
    try { await flight; }
    finally {
      if (session.refreshing === flight) session.refreshing = null;
      // 最后一次 inspect 返回与清理 flight 之间仍可能收到新通知；只按该通知补刷，不轮询。
      if (session.invalidated && !session.replacing && isCurrent(session)) {
        void reconcile(session).catch(error => {
          if (isCurrent(session)) session.blockedReason = messageOf(error);
        });
      }
    }
  }
  function attachExecution(session: GoalRuntimeSession): void {
    assertCurrent(session);
    if (session.runtime) return;
    const execution = options.resolveExecution(session.sessionId);
    if (!execution) fail("GOAL_EXECUTION_UNAVAILABLE", "当前 root session 未绑定 PlanExecutionService，执行已阻塞；不得降级派发");
    session.execution = execution;
    session.runtime = createGoalRuntime({ store: session.store, execution, verify: verifyChecks, captureSubject,
      maxConcurrentTasks: config.maxConcurrentTasks, maxNoProgressTurns: config.maxNoProgressTurns });
    session.unsubscribe = execution.subscribe(() => {
      if (!isCurrent(session)) return;
      void reconcile(session).catch(error => {
        if (isCurrent(session)) session.blockedReason = messageOf(error);
      });
    });
  }
  async function start(ctx: ExtensionContext, checkGate = true): Promise<void> {
    const wasEnabled = current !== null;
    dispose();
    if (checkGate ? options.sessionEnabled && !options.sessionEnabled() : !wasEnabled) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) fail("GOAL_SESSION_ID_REQUIRED", "缺少真实 Host session 身份");
    const sessionFile = ctx.sessionManager.getSessionFile();
    const session: GoalRuntimeSession = {
      generation, sessionId, sessionFile, manager: ctx.sessionManager, context: ctx,
      store: undefined!, runtime: null, execution: null, unsubscribe: null, ready: Promise.resolve(),
      blockedReason: null, settled: ctx.isIdle(), pendingContinuation: false, goalTurn: false,
      suspended: false, lastWakeFingerprint: null, refreshing: null, invalidated: false,
      compactPending: null, recoveryPending: true, navigating: false, replacing: false,
      executionAvailabilityUnsubscribe: null,
    };
    session.store = createGoalStateStore({ sessionId, sessionFile,
      readBranch: () => { assertCurrent(session); return session.manager.getBranch(); },
      appendEntry: (customType, data) => { assertCurrent(session); pi.appendEntry(customType, data); },
    });
    current = session;
    session.executionAvailabilityUnsubscribe = options.subscribeExecution?.(sessionId, () => {
      if (!isCurrent(session)) return;
      session.ready = session.ready.then(async () => {
        if (!isCurrent(session) || session.runtime) return;
        try {
          await reconcileGoalSession(session.context, bridge);
          if (isCurrent(session)) {
            session.recoveryPending = false;
            wakeIfIdle(session);
          }
        } catch (error) {
          if (isCurrent(session)) session.blockedReason = messageOf(error);
        }
      });
    }) ?? null;
    session.ready = (async () => {
      try {
        await session.store.restore();
        assertCurrent(session);
        // package 可能在稍后的 session_start 才绑定；工具入口再解析，绝不构造替代服务。
        if (options.resolveExecution(sessionId)) await reconcileGoalSession(ctx, bridge);
        assertCurrent(session);
        session.recoveryPending = !!session.store.read() && !session.runtime;
        wakeIfIdle(session);
      } catch (error) { if (isCurrent(session)) session.blockedReason = messageOf(error); }
    })();
    await session.ready;
  }
  async function toolSession(ctx: ExtensionToolContext, executionRequired = true): Promise<GoalRuntimeSession> {
    const session = current;
    if (!session) fail("GOAL_SESSION_NOT_READY", "Goal session 尚未初始化");
    assertCurrent(session, ctx);
    await session.ready;
    assertCurrent(session, ctx);
    session.context = ctx;
    if (executionRequired) {
      session.store.assertWritable();
      if (session.compactPending || session.navigating) fail("GOAL_LIFECYCLE_BUSY", "正在压缩或导航，暂不执行 Goal 操作");
      if (session.blockedReason) fail("GOAL_SESSION_BLOCKED", session.blockedReason);
      if (!session.sessionFile) fail("GOAL_SESSION_FILE_REQUIRED", "Goal 不支持 --no-session");
      if (ctx.signal?.aborted) fail("GOAL_ABORTED", "当前工具已中断");
      const hadRuntime = !!session.runtime;
      attachExecution(session);
      if (!hadRuntime) await reconcileGoalSession(ctx, bridge);
      assertCurrent(session, ctx);
    }
    return session;
  }
  async function runTool(work: () => Promise<unknown>): Promise<AgentToolResult<unknown>> {
    try { return result(await work()); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "GOAL_TOOL_FAILED";
      return result({ error: { code, reason: messageOf(error) }, status: "blocked" }, true);
    }
  }
  function evidenceFor(session: GoalRuntimeSession, receipts: CheckReceipt[]) {
    const branch = session.manager.getBranch();
    const state = session.store.read()!;
    return receipts.filter(r => r.resultRef).map(receipt => {
      const match = /^(.*)#(\d+)$/.exec(receipt.resultRef);
      if (!match) fail("GOAL_EVIDENCE_REFERENCE_INVALID", "检查回执缺少精确的 entry/index 引用");
      const entries = branch.filter(entry => entry.type === "custom" && entry.customType === GOAL_CHECK_EVIDENCE_CUSTOM_TYPE && entry.id === match[1]);
      if (entries.length !== 1 || entries[0].type !== "custom") fail("GOAL_EVIDENCE_NOT_FOUND", "当前分支缺少唯一的检查证据条目");
      const evidence = entries[0].data as GoalCheckEvidence;
      const item = evidence.results[Number(match[2])];
      if (!evidence.evidenceId || evidence.sessionId !== session.sessionId
        || evidence.contractHash !== state.binding.contractHash || item?.checkId !== receipt.checkId
        || JSON.stringify(item.command) !== JSON.stringify(receipt.command)) {
        fail("GOAL_EVIDENCE_MISMATCH", "检查证据与当前 session/契约/回执不匹配");
      }
      return { resultRef: receipt.resultRef, evidenceId: evidence.evidenceId, ...item };
    });
  }

  pi.registerTool({
    name: "plan_execute", label: "plan_execute", parameters: PLAN_TOOL_PARAMETERS.plan_execute,
    exposure: "model-only", executionMode: "sequential",
    description: "用户已选择执行后，按 plan_path 与 mode:subagent-driven 绑定结构化计划并推进 ready 任务。重复调用推进同一实例；不支持 Inline，不推定执行授权。",
    async execute(_id, params, _signal, _onUpdate, ctx) { return runTool(async () => {
      if (params.mode !== "subagent-driven") fail("GOAL_MODE_UNSUPPORTED", "Goal v1 仅支持 subagent-driven");
      const session = await toolSession(ctx);
      const { contract, binding } = await resolvePlanBinding({ cwd: ctx.cwd, planPath: params.plan_path,
        sessionId: session.sessionId, sessionFile: session.sessionFile!, previousBinding: session.store.read()?.binding }, pi.exec.bind(pi));
      assertCurrent(session, ctx);
      if (session.store.read()?.status === "cancelled") {
        // 替换期间通知只标记失效；先排空旧核对，避免旧 plan 的 inspect 回调污染新实例。
        session.replacing = true;
        try {
          if (session.refreshing) await session.refreshing;
          assertCurrent(session, ctx);
          await session.runtime!.replaceCancelled(binding, contract);
          assertCurrent(session, ctx);
          session.suspended = false;
          session.pendingContinuation = false;
          session.lastWakeFingerprint = null;
        } finally {
          session.replacing = false;
          if (isCurrent(session)) await reconcile(session);
        }
      } else await session.runtime!.activate(binding, contract);
      const advanced = await session.runtime!.advance(ctx);
      assertCurrent(session, ctx);
      return { ...advanced, ...status(session) };
    }); },
  });
  pi.registerTool({
    name: "plan_status", label: "plan_status", parameters: PLAN_TOOL_PARAMETERS.plan_status,
    exposure: "direct", executionMode: "sequential", annotations: { readOnlyHint: true },
    description: "无参数，只读展示当前契约、任务、证据引用、等待与未满足条件；不刷新运行、不写 checkpoint、不改变 revision。",
    async execute(_id, _params, _signal, _onUpdate, ctx) { return runTool(async () => status(await toolSession(ctx, false))); },
  });
  pi.registerTool({
    name: "plan_checkpoint", label: "plan_checkpoint", parameters: PLAN_TOOL_PARAMETERS.plan_checkpoint,
    exposure: "model-only", executionMode: "sequential",
    description: "记录 decisions、source_refs、next_action 与可选 task_id 的结构化交接事实；不能设置 accepted、passed 或 completed。",
    async execute(_id, params, _signal, _onUpdate, ctx) { return runTool(async () => {
      const session = await toolSession(ctx);
      await session.runtime!.recordCheckpoint({ ...(params.task_id === undefined ? {} : { taskId: params.task_id }),
        decisions: params.decisions, sourceRefs: params.source_refs, nextAction: params.next_action });
      assertCurrent(session, ctx);
      return status(session);
    }); },
  });
  pi.registerTool({
    name: "plan_retry", label: "plan_retry", parameters: PLAN_TOOL_PARAMETERS.plan_retry,
    exposure: "model-only", executionMode: "sequential",
    description: "按 task_id、非空针对性 message 与 expected_revision 修复失败检查关联任务，或恢复权威失败 attempt；后者无需检查回执。不换模型、不扩大原合同。",
    async execute(_id, params, _signal, _onUpdate, ctx) { return runTool(async () => {
      const session = await toolSession(ctx);
      const dispatch = await session.runtime!.retryTask(params.task_id, params.message, params.expected_revision, ctx);
      assertCurrent(session, ctx);
      return { dispatch, ...status(session) };
    }); },
  });
  pi.registerTool({
    name: "plan_verify", label: "plan_verify", parameters: PLAN_TOOL_PARAMETERS.plan_verify,
    exposure: "model-only", executionMode: "sequential", reachesTools: () => ["bash"],
    description: "运行契约内检查，可选 check_ids；命令只经当前 bash 工具及 Host hooks，保留真实证据。不能传入 command、passed 或 evidence 覆盖。",
    async execute(id, params, _signal, _onUpdate, ctx) { return runTool(async () => {
      const session = await toolSession(ctx);
      const verified = await session.runtime!.verify(ctx, id, params.check_ids);
      assertCurrent(session, ctx);
      return { ...verified, evidence: evidenceFor(session, verified.receipts), ...status(session) };
    }); },
  });

  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", () => dispose());
  pi.on("agent_start", (_event, ctx) => {
    const session = current;
    if (!session || !isCurrent(session)) return;
    session.context = ctx;
    session.settled = false;
    session.goalTurn ||= session.pendingContinuation;
    session.pendingContinuation = false;
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    const session = current;
    if (!session || !isCurrent(session)) return;
    await session.ready;
    if (!isCurrent(session) || !session.store.read() || session.blockedReason) return;
    session.context = ctx;
    if (event.outcome !== "completed") { session.suspended = true; session.goalTurn = false; return; }
    const pending = event.context.pendingMessages.length > 0 || ctx.hasPendingMessages();
    if (pending || event.continue) { session.goalTurn = false; return; }
    if (session.suspended || session.compactPending || session.navigating || session.recoveryPending
      || !session.store.diagnose().writable) return;
    try {
      attachExecution(session);
      await reconcile(session);
      assertCurrent(session, ctx);
      const queuedAfterRefresh = ctx.hasPendingMessages();
      await session.runtime!.recordProgressTurn({ goalContinuation: session.goalTurn, pendingMessages: queuedAfterRefresh });
      session.goalTurn = false;
      if (queuedAfterRefresh) return;
      const state = session.store.read()!;
      const next = session.runtime!.nextAction();
      if (state.status !== "active" || !actionable(next) || !event.context.canContinue
        || ctx.hasPendingMessages() || session.pendingContinuation) return;
      session.pendingContinuation = true;
      session.lastWakeFingerprint = wakeFingerprint(session);
      return { entries: [...event.entries, { type: "custom_message" as const,
        customType: "goal-runtime.continue.v1", display: true,
        content: describeGoalNextAction(next, state.binding.planPath, state.revision),
      }], continue: true };
    } catch (error) { if (isCurrent(session)) session.blockedReason = messageOf(error); }
  });
  pi.on("agent_settled", (event, ctx) => {
    const session = current;
    if (!session || !isCurrent(session)) return;
    session.context = ctx;
    session.settled = true;
    session.pendingContinuation = false;
    if (event.aborted) session.suspended = true;
  });

  const bridge = { getSession: () => current, isCurrent, assertCurrent, start, dispose, reconcile, attachExecution, status };
  installGoalContinuity(pi, bridge);
  return bridge;
}
