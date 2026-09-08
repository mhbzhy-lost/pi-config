import { createRegistryStore, type RegistryStore } from "./registry.ts";
import { createSessionOwnerLifecycle, type SessionIdentity, type SessionOwnerLifecycleDeps } from "./lifecycle.ts";

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

function identity(ctx: SessionOwnerContext): SessionIdentity {
  return {
    cwd: ctx.sessionManager.getCwd(),
    sessionId: ctx.sessionManager.getSessionId() ?? null,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
  };
}

function notify(ctx: SessionOwnerContext): void {
  try { ctx.ui.notify("该会话正由另一个 Pi 窗口使用，已取消切换", "warning"); } catch { /* UI 通知失败不能影响保护逻辑。 */ }
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
  }) : null;

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!lifecycle) throw new Error("session owner environment is incomplete");
      await lifecycle.start(identity(ctx));
    } catch {
      notify(ctx);
      try { await ctx.shutdown?.(); } catch { /* 此时保护逻辑已按 fail closed 处理。 */ }
      return { cancel: true };
    }
  });
  pi.on("session_before_switch", async (event, ctx) => {
    try {
      if (!lifecycle || await lifecycle.beforeSwitch(event.reason, event.targetSessionFile, identity(ctx))) {
        notify(ctx);
        return { cancel: true };
      }
    } catch {
      notify(ctx);
      return { cancel: true };
    }
    return undefined;
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    try {
      if (!lifecycle || await lifecycle.beforeFork(identity(ctx))) {
        notify(ctx);
        return { cancel: true };
      }
    } catch {
      notify(ctx);
      return { cancel: true };
    }
    return undefined;
  });
  pi.on("session_shutdown", async (event, ctx) => {
    try { await lifecycle?.shutdown(event.reason, identity(ctx)); }
    catch { notify(ctx); }
  });
}
