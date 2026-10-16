import { createRegistryStore, type RegistryStore } from "./registry.ts";
import {
  createSessionOwnerLifecycle,
  SessionOwnerTransitionError,
  type BeforeSwitchDecision,
  type SessionIdentity,
  type SessionOwnerLifecycleDeps,
  type SessionOwnerNoticeKind,
} from "./lifecycle.ts";

export type SessionOwnerExtensionDeps = Partial<Omit<SessionOwnerLifecycleDeps, "ownerId" | "pid" | "store">> & Readonly<{
  env?: NodeJS.ProcessEnv;
  pid?: number;
  store?: RegistryStore;
}>;

type SessionOwnerContext = Readonly<{
  sessionManager: Readonly<{ getCwd(): string; getSessionId(): string | null; getSessionFile(): string | null }>;
  ui: Readonly<{ notify(message: string, level?: string): void }>;
  shutdown?: () => Promise<void> | void;
}>;

export type ExtensionAPI = Readonly<{
  on(event: "session_start" | "session_shutdown" | "session_before_switch" | "session_before_fork", handler: (event: any, ctx: SessionOwnerContext) => Promise<unknown> | unknown): void;
}>;

// 通知文案按分类区分：只有确认另一 owner 占用时才说「另一个 Pi 窗口」；
// 身份不可验证、未完成切换、登记故障与内部异常各自独立说明，不统一误导。
const NOTICES: Readonly<Record<SessionOwnerNoticeKind, string>> = {
  "session-owned": "该会话正由另一个 Pi 窗口使用，已取消切换",
  "target-unverifiable": "无法验证目标会话身份，已取消本次切换",
  "source-unverifiable": "无法验证当前会话身份，已取消本次操作",
  transitioning: "当前会话存在未完成的切换，已取消本次操作；请重试同一目标或退出后重新启动",
  "registry-failure": "会话归属登记不可用，已取消本次操作",
  "unsupported-event": "收到不受支持的会话事件，已按保守策略取消本次操作",
  "internal-failure": "会话归属保护出现内部异常，已按保守策略取消本次操作",
};

function identity(ctx: SessionOwnerContext): SessionIdentity {
  return {
    cwd: ctx.sessionManager.getCwd(),
    sessionId: ctx.sessionManager.getSessionId() ?? null,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
  };
}

// ctx getter 本身抛错时保留原始异常作为 cause，同时给出准确分类。
function currentIdentity(ctx: SessionOwnerContext): SessionIdentity {
  try { return identity(ctx); }
  catch (error) {
    throw new SessionOwnerTransitionError({ kind: "source-unverifiable", reason: "session-identity-unreadable" }, "cannot read the current session identity", { cause: error });
  }
}

function noticeKind(error: unknown, fallback: SessionOwnerNoticeKind): SessionOwnerNoticeKind {
  return error instanceof SessionOwnerTransitionError ? error.kind : fallback;
}

function notify(ctx: SessionOwnerContext, kind: SessionOwnerNoticeKind): void {
  try { ctx.ui.notify(NOTICES[kind] ?? NOTICES["internal-failure"], "warning"); }
  catch (error) { console.error("[session-owner] notification failed:", error); /* UI 通知失败不能影响保护逻辑。 */ }
}

// lifecycle 返回的内部决策必须显式转换成 SDK 的 { cancel: true }；throw 不会取消切换。
function cancelOf(decision: BeforeSwitchDecision, label: string, ctx: SessionOwnerContext): { cancel: true } | undefined {
  if (!decision.cancel) return undefined;
  const { kind, reason, conflictingOwnerId } = decision;
  console.error(`[session-owner] ${label} cancelled:`, { kind, reason, conflictingOwnerId });
  notify(ctx, kind);
  return { cancel: true };
}

export function installSessionOwnerExtension(pi: ExtensionAPI, deps: SessionOwnerExtensionDeps = {}): void {
  const env = deps.env ?? process.env;
  if (env.PI_SUBAGENT_CHILD === "1" || env.PI_SUBAGENT_FANOUT_CHILD === "1") return;
  const ownerId = env.PI_SESSION_OWNER_ID;
  const root = env.PI_SESSION_OWNER_REGISTRY;
  if (!ownerId && !root) return;

  const lifecycle = ownerId && root ? createSessionOwnerLifecycle({
    store: deps.store ?? createRegistryStore(root), ownerId, pid: deps.pid ?? process.pid,
    listLiveRecords: deps.listLiveRecords, updateOwnRecord: deps.updateOwnRecord, releaseOwnRecord: deps.releaseOwnRecord,
    reserveSwitchTarget: deps.reserveSwitchTarget, commitSwitchTarget: deps.commitSwitchTarget, abortSwitchTarget: deps.abortSwitchTarget,
    readHeaderBytes: deps.readHeaderBytes,
  }) : null;

  pi.on("session_start", async (event, ctx) => {
    try {
      if (!lifecycle) throw new Error("session owner environment is incomplete");
      await lifecycle.start(currentIdentity(ctx), { reason: event?.reason, previousSessionFile: event?.previousSessionFile });
    } catch (error) {
      console.error("[session-owner] session_start failed:", error);
      notify(ctx, noticeKind(error, "internal-failure"));
      // session_start 返回 cancel 不是 SDK 支持的全局取消；真正的动作是请求有序 shutdown。
      try { await ctx.shutdown?.(); }
      catch (shutdownError) { console.error("[session-owner] shutdown after session_start failure failed:", shutdownError); /* 此时保护逻辑已按 fail closed 处理。 */ }
      return { cancel: true };
    }
  });
  pi.on("session_before_switch", async (event, ctx) => {
    let decision: BeforeSwitchDecision;
    try {
      // reserve 必须发生在 SessionManager.open 与旧 session teardown 之前，因此这里只做有界 header 验证。
      decision = lifecycle
        ? await lifecycle.beforeSwitch(event?.reason, event?.targetSessionFile, currentIdentity(ctx))
        : { cancel: true, kind: "registry-failure", reason: "lifecycle-unavailable" };
    } catch (error) {
      // runner 只报告 handler 异常并继续，throw 不取消切换；handler 必须自己 catch 并显式 cancel。
      console.error("[session-owner] session_before_switch failed:", error);
      decision = { cancel: true, kind: noticeKind(error, "internal-failure"), reason: "before-switch-failed" };
    }
    return cancelOf(decision, "session_before_switch", ctx);
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    let decision: BeforeSwitchDecision;
    try {
      decision = lifecycle
        ? await lifecycle.beforeFork(currentIdentity(ctx))
        : { cancel: true, kind: "registry-failure", reason: "lifecycle-unavailable" };
    } catch (error) {
      console.error("[session-owner] session_before_fork failed:", error);
      decision = { cancel: true, kind: noticeKind(error, "internal-failure"), reason: "before-fork-failed" };
    }
    return cancelOf(decision, "session_before_fork", ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    try {
      // identity 以 thunk 传入：quit 只释放自身 record，reload 不写记录，两者都不得依赖可能已失效的旧 ctx。
      await lifecycle?.shutdown(event?.reason, event?.targetSessionFile, () => currentIdentity(ctx));
    } catch (error) {
      // shutdown 不是可撤销事件：只能通知，不能通过 throw 阻止 teardown。
      console.error("[session-owner] session_shutdown failed:", error);
      notify(ctx, noticeKind(error, "internal-failure"));
    }
  });
}
