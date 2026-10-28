import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPlanContract, type GoalState } from "./contract.ts";
import type { GoalRuntimeSession } from "./index.ts";

/** 只消费组装层的同代绑定，不另建状态或资源账本。 */
export type GoalContinuityRuntime = {
  getSession(): GoalRuntimeSession | null;
  isCurrent(session: GoalRuntimeSession): boolean;
  assertCurrent(session: GoalRuntimeSession, ctx?: ExtensionContext): void;
  start(ctx: ExtensionContext, checkGate?: boolean): Promise<void>;
  attachExecution(session: GoalRuntimeSession): void;
  reconcile(session: GoalRuntimeSession): Promise<void>;
  status(session: GoalRuntimeSession): unknown;
};

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** 原合同与业务事实完整投影；不从摘要重建权威约束，也不把旧 passed 推断为当前通过。 */
export function buildRecoveryContext(state: GoalState): string {
  return [
    "以下为当前 session 已核验的 Goal 原始快照。合同、约束、来源与决策不得由会话摘要替代。",
    "paused/blocked/cancelled 不等于完成；未完成时仅按当前状态使用 plan 工具。运行与资源事实需由 execution service 核对。",
    JSON.stringify({
      state,
      unmetTasks: state.contract.tasks.filter(task => state.tasks[task.id]?.status !== "accepted"),
      terminalChecksRequiringCurrentProof: state.status === "completed" ? []
        : state.contract.checks.filter(check => state.contract.terminalCheckIds.includes(check.id)),
    }, null, 2),
  ].join("\n");
}

async function checkContract(session: GoalRuntimeSession, runtime: GoalContinuityRuntime): Promise<boolean> {
  const state = session.store.read();
  if (!state || state.status === "cancelled" || state.status === "completed") return true;
  let matches = false;
  try { matches = (await readPlanContract(state.binding.planPath)).contractHash === state.binding.contractHash; }
  catch { /* 来源不可读与契约漂移一样阻止自动执行，原合同保持不变。 */ }
  runtime.assertCurrent(session);
  if (matches) return true;
  session.suspended = true;
  const current = session.store.read()!;
  if (current.planId !== state.planId) throw new Error("契约核对期间计划已更换");
  if (current.status === "completed" || current.status === "cancelled") return true;
  const reason = "源契约变化或不可读；处理 live run 后 /plan cancel，再重新授权新版本";
  if (current.status !== "paused" || current.pauseReason !== reason) {
    await session.store.update(current.revision, value => {
      runtime.assertCurrent(session);
      if (!value || value.planId !== state.planId) throw new Error("契约核对期间计划已更换");
      if (value.status === "completed" || value.status === "cancelled") return value;
      return { ...value, status: "paused", pauseReason: reason };
    });
  }
  return false;
}

/** 调用方先 await store.restore；绑定时立即订阅，然后核对已知 run，补齐订阅竞争窗口。 */
export async function reconcileGoalSession(ctx: ExtensionContext, runtime: GoalContinuityRuntime): Promise<void> {
  const session = runtime.getSession();
  if (!session) return;
  runtime.assertCurrent(session, ctx);
  session.store.assertWritable();
  runtime.attachExecution(session);
  await checkContract(session, runtime);
  await runtime.reconcile(session);
  runtime.assertCurrent(session, ctx);
}

function runsClosed(session: GoalRuntimeSession): boolean {
  const state = session.store.read();
  if (!state) return true;
  // beforeNavigate 已 await reconcile；这些事实只由 scheduler 的 execution.inspect 刷新。
  // continuity 仅消费闭合字段，不读取 sidecar 或重建 package 的证明校验与仓库路由。
  const facts = session.runtime?.readFacts() ?? {};
  return Object.values(state.tasks).every(task => {
    if (!task.run) return !task.dispatchKey && !task.workspaceId && task.status !== "running";
    const fact = facts[task.run.runId];
    return !!fact && fact.run.runId === task.run.runId && fact.run.workspaceId === task.run.workspaceId
      && fact.run.rootSessionId === task.run.rootSessionId
      && (fact.terminal === "succeeded" || fact.terminal === "failed") && !!fact.terminalProofRef
      && ((fact.integration === "completed" && !!fact.integrationReceiptRef) || fact.integration === "not-applicable")
      && fact.workspaceState === "released" && fact.recovery === "none" && fact.blocker === null;
  });
}

export function installGoalContinuity(pi: ExtensionAPI, runtime: GoalContinuityRuntime): void {
  async function sessionFor(ctx: ExtensionContext): Promise<GoalRuntimeSession | null> {
    const session = runtime.getSession();
    if (!session) return null;
    runtime.assertCurrent(session, ctx);
    await session.ready;
    runtime.assertCurrent(session, ctx);
    session.context = ctx;
    return session;
  }
  function report(session: GoalRuntimeSession, error: unknown): void {
    if (!runtime.isCurrent(session)) return;
    session.blockedReason = errorText(error);
    session.context.ui.notify(`Goal 未完成：${session.blockedReason}`, "warning");
  }
  async function save(session: GoalRuntimeSession): Promise<void> {
    runtime.assertCurrent(session);
    session.store.assertWritable();
    const state = session.store.read();
    if (state) await session.store.update(state.revision, value => {
      runtime.assertCurrent(session);
      if (!value || value.planId !== state.planId) throw new Error("保存期间计划已更换");
      return { ...value, checkpoint: value.checkpoint };
    });
    runtime.assertCurrent(session);
  }
  async function control(session: GoalRuntimeSession, status: "paused" | "active" | "cancelled", reason: string | null) {
    runtime.assertCurrent(session);
    session.store.assertWritable();
    const state = session.store.read();
    if (!state) throw new Error("当前没有已激活计划");
    if (state.status === "completed" || state.status === "cancelled") {
      if (status === state.status) return;
      throw new Error("已结束的计划不能恢复或改写；取消计划须核实资源闭合后重新 plan_execute");
    }
    if (status === "active") {
      await reconcileGoalSession(session.context, runtime);
      if (!(await checkContract(session, runtime))) throw new Error("源契约已变化，不能恢复旧执行");
      if (session.blockedReason) throw new Error(session.blockedReason);
    }
    runtime.assertCurrent(session);
    const current = session.store.read()!;
    await session.store.update(current.revision, value => {
      runtime.assertCurrent(session);
      if (!value || value.planId !== state.planId) throw new Error("控制期间计划已变化");
      if (value.status === "completed" || value.status === "cancelled") throw new Error("控制期间计划已结束，拒绝覆盖终态");
      return { ...value, status, pauseReason: reason };
    });
    runtime.assertCurrent(session);
    session.suspended = status !== "active";
    session.pendingContinuation = false;
    session.goalTurn = false;
    session.lastWakeFingerprint = null;
    if (status === "active") await runtime.reconcile(session);
  }

  pi.registerCommand("plan", {
    description: "控制已激活计划：/plan pause | resume | cancel | status；取消不停止 child 或清理资源。",
    async handler(args, ctx) {
      const session = await sessionFor(ctx);
      if (!session) return;
      try {
        const command = args.trim();
        if (command === "status") {
          ctx.ui.notify(JSON.stringify(runtime.status(session), null, 2), "info");
          return;
        }
        if (command === "pause") await control(session, "paused", "用户通过 /plan pause 暂停");
        else if (command === "cancel") await control(session, "cancelled", "用户取消；既有 run/workspace 仍须经 typed 路径核实闭合");
        else if (command === "resume") await control(session, "active", null);
        else { ctx.ui.notify("用法：/plan pause | resume | cancel | status", "warning"); return; }
        runtime.assertCurrent(session, ctx);
        ctx.ui.notify(JSON.stringify(runtime.status(session), null, 2), "info");
      } catch (error) {
        if (runtime.isCurrent(session)) ctx.ui.notify(`Goal 控制未完成：${errorText(error)}`, "warning");
      }
    },
  });
  pi.on("input", async (event, ctx) => {
    // 普通消息和 steer 均暂停；不解析自然语言推测新授权，也不消费用户原始输入。
    if (event.source === "extension") return;
    const session = await sessionFor(ctx);
    if (!session || session.store.read()?.status !== "active") return;
    session.suspended = true;
    try { await control(session, "paused", "收到用户新消息或 steer，自动续跑已暂停；使用 /plan resume 恢复"); }
    catch (error) { report(session, error); }
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const session = runtime.getSession();
    if (!session) return;
    try {
      await sessionFor(ctx);
      if (session.store.read()) session.compactPending = { reason: event.reason, willRetry: event.willRetry };
      await save(session);
      // 不返回 compaction：保留 Pi 默认摘要，manual/threshold/overflow 共用保存路径。
    } catch (error) {
      session.compactPending = null;
      report(session, error);
      return { cancel: true };
    }
  });
  pi.on("session_compact", (event, ctx) => {
    const session = runtime.getSession();
    if (!session || !runtime.isCurrent(session) || ctx.sessionManager !== session.manager) return;
    const pending = session.compactPending;
    if (!pending || pending.reason !== event.reason || pending.willRetry !== event.willRetry) return;
    session.compactPending = null;
    session.recoveryPending = true;
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const session = runtime.getSession();
    if (!session || !runtime.isCurrent(session) || ctx.sessionManager !== session.manager) return;
    const pending = session.compactPending;
    if (pending?.reason === event.reason && pending.willRetry === event.willRetry) session.compactPending = null;
    // 失败不制造恢复锁；已有恢复需求和存储/业务阻塞都不清除，willRetry 不触发自造续跑。
  });
  pi.on("context", async (event, ctx) => {
    const session = await sessionFor(ctx);
    if (!session) return;
    try {
      if (session.recoveryPending && session.store.read()) await reconcileGoalSession(ctx, runtime);
      else if (session.store.read() && session.store.diagnose().writable) await checkContract(session, runtime);
      runtime.assertCurrent(session, ctx);
      session.recoveryPending = false;
    } catch (error) { report(session, error); }
    if (!runtime.isCurrent(session)) return;
    const state = session.store.read();
    if (!state && !session.blockedReason) return;
    const content = [state ? buildRecoveryContext(state) : "Goal 恢复未完成，禁止派发、修复或完成。",
      ...(session.blockedReason ? [`恢复阻塞：${session.blockedReason}；plan_status 保持只读诊断。`] : [])].join("\n");
    // 仅生成本次模型请求投影；不 append、不改写历史消息或默认摘要。
    return { messages: [...event.messages, { role: "custom" as const,
      customType: "goal-runtime.recovery.v1", content, display: false, timestamp: 0 }] };
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    const session = runtime.getSession();
    if (!session) return;
    try {
      await sessionFor(ctx);
      session.navigating = true;
      await save(session);
    }
    catch (error) { report(session, error); return { cancel: true }; }
    finally { session.navigating = false; }
  });
  async function beforeNavigate(ctx: ExtensionContext) {
    const session = runtime.getSession();
    if (!session) return;
    try {
      await sessionFor(ctx);
      session.store.assertWritable();
      const state = session.store.read();
      if (!state) return;
      if (state.status !== "completed" && state.status !== "cancelled") {
        throw new Error("存在非终态 Goal，禁止 fork/tree 回滚；可先 pause 诊断，完成或 cancel 并核实资源闭合后再导航");
      }
      await reconcileGoalSession(ctx, runtime);
      const checked = session.store.read();
      if (!checked || checked.planId !== state.planId || (checked.status !== "completed" && checked.status !== "cancelled")) {
        throw new Error("导航核对期间计划已变化，拒绝回滚");
      }
      if (!runsClosed(session)) throw new Error("Goal 仍有未闭合或未知运行/资源，禁止 fork/tree");
      await save(session);
    } catch (error) {
      if (runtime.isCurrent(session)) ctx.ui.notify(errorText(error), "warning");
      return { cancel: true };
    }
  }
  pi.on("session_before_fork", (_event, ctx) => beforeNavigate(ctx));
  pi.on("session_before_tree", (_event, ctx) => beforeNavigate(ctx));
  // tree 留在同一 Host runtime，但分支已变化，必须重新核验；不在导航时重新读取开关。
  pi.on("session_tree", (_event, ctx) => runtime.start(ctx, false));
}
