// 仅用于本地隔离显示验收；这些是公开 ActivitySource 显示 fixture，不是真实任务权威。
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import {
  BACKGROUND_ACTIVITY_CHANNELS as channels,
  createBackgroundActivityRegistrationId,
  isHostScope,
  type ActivityKind, type ActivityRow, type ActivitySource, type HostScope,
} from "pi-subagents-enhanced/tui/background-activity";

export const VISUAL_SCENARIOS = ["base", "long", "widths", "heights", "draft", "themes", "lifecycle", "rpc"] as const;
const kinds: ActivityKind[] = ["subagent", "bash_async", "scheduler"];

export default function visualFixture(pi: ExtensionAPI) {
  const root = process.env.PI_TEST_BG_ROOT;
  if (!root) throw new Error("visual fixture 只允许在显式隔离根内启动");
  const probeFile = join(root, "probe.jsonl");
  let context: ExtensionContext | undefined;
  let scope: HostScope | undefined;
  let epoch = 0;
  let variant = "base";
  let resumeFile: string | undefined;
  const subscribers = new Set<() => void>();
  const ids = new Map<ActivityKind, string>();
  const record = (event: string, extra: Record<string, unknown> = {}) => appendFileSync(probeFile,
    JSON.stringify({ fixture: true, event, epoch, mode: context?.mode, variant, sessionId: context?.sessionManager.getSessionId(), ...extra }) + "\n", { mode: 0o600 });
  const rows = (kind: ActivityKind): ActivityRow[] => {
    const count = variant === "overflow" ? 9 : 1;
    return Array.from({ length: count }, (_, index) => ({
      key: `fixture:${kind}:${index}`, kind, placement: index === 8 ? "recent" : "main",
      label: variant === "long" && kind === "subagent"
        ? "fixture:  在 /Users/fixture/brightness-control 只读诊断长标题换行测试 (delegate)"
        : `fixture:${kind}:${index}`,
      stateLabel: kind === "scheduler" ? "等待触发" : "running",
    }));
  };
  const sources: ActivitySource[] = kinds.map((kind) => ({
    kind,
    snapshot: () => ({ availability: variant === "stale" ? "stale" : variant === "unavailable" ? "unavailable" : "available", rows: rows(kind), observedAt: "2026-10-15T00:00:00.000Z", ...(variant === "stale" || variant === "unavailable" ? { errorLabel: "fixture:查询状态" } : {}) }),
    subscribe: (invalidate) => { subscribers.add(invalidate); return () => { subscribers.delete(invalidate); }; },
    detail: async (key, request) => {
      record("detail", { key, expanded: request.expanded, rawBlocks: 2 });
      return new Text(`fixture detail ${key}\nfixture 原始块一\nfixture 原始块二`, 0, 0);
    },
  }));
  const publish = () => {
    if (!scope || context?.mode !== "tui") return;
    for (const source of sources) pi.events.emit(channels.sourceRegister, { scope, source, registrationId: ids.get(source.kind) });
  };
  pi.events.on(channels.ownerReady, (value) => {
    const payload = value as { scope?: unknown };
    if (!isHostScope(payload?.scope) || !context || payload.scope.sessionManager !== context.sessionManager || payload.scope.sessionId !== context.sessionManager.getSessionId()) return;
    scope = payload.scope;
    publish();
  });
  pi.on("session_start", (_event, ctx) => {
    context = ctx; scope = undefined; epoch++;
    for (const kind of kinds) ids.set(kind, createBackgroundActivityRegistrationId());
    if (ctx.mode === "tui") {
      pi.events.emit(channels.ownerRequest, { sessionManager: ctx.sessionManager, sessionId: ctx.sessionManager.getSessionId(), hostKey: ctx.sessionManager });
    }
    record("start");
  });
  pi.on("session_shutdown", () => {
    if (scope) for (const kind of kinds) pi.events.emit(channels.sourceUnregister, { scope, kind, registrationId: ids.get(kind) });
    record("shutdown"); scope = undefined;
  });
  pi.registerShortcut(Key.alt("p"), {
    description: "记录隔离 fixture 草稿，不发送模型消息",
    handler: async (ctx) => { record("draft", { draft: ctx.ui.getEditorText() }); },
  });
  pi.registerCommand("fixture-bg", {
    description: "隔离显示 fixture 控制；无业务调度/删除能力",
    handler: async (args, ctx) => {
      const action = args.trim() || "base";
      context = ctx;
      if (["base", "long", "overflow", "stale", "unavailable"].includes(action)) {
        variant = action;
        for (const invalidate of subscribers) invalidate();
      } else if (action === "probe") {
        ctx.ui.setEditorText("fixture 草稿保留");
      } else if (action === "light" || action === "dark") {
        const changed = ctx.ui.setTheme(action);
        if (!changed.success) throw new Error("fixture theme unavailable");
      } else if (action === "new") {
        resumeFile = ctx.sessionManager.getSessionFile();
        await ctx.newSession({ withSession: async (fresh) => { context = fresh; } });
      } else if (action === "switch") {
        if (!resumeFile) throw new Error("fixture resume 需要已保存的合法会话");
        await ctx.switchSession(resumeFile, { withSession: async (fresh) => { context = fresh; } });
      } else if (action === "fork") {
        const user = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
        if (!user) throw new Error("fixture fork 需要真实 fake-provider seed user entry");
        await ctx.fork(user.id, { position: "at", withSession: async (fresh) => { context = fresh; } });
      } else if (action === "reload") {
        await ctx.reload(); return; // 不复用旧 ctx
      } else throw new Error(`未知 fixture action: ${action}`);
      record("command", { action, cwdExists: true });
    },
  });
}
