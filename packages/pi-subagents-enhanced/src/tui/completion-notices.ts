import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCompactSubagentNotification } from "./compact-rendering.ts";

type CompletionNoticeApi = Pick<ExtensionAPI, "on">;
type SessionContext = { sessionManager?: object };

/** 将上游隐藏的 completion message 投影为 TUI 的瞬时状态行。 */
export function registerCompletionNotices(pi: CompletionNoticeApi) {
  const seenBySession = new WeakMap<object, WeakSet<object>>();
  let disposed = false;

  const reset = (_event: unknown, context: SessionContext) => {
    const manager = context?.sessionManager;
    if (manager && typeof manager === "object") seenBySession.delete(manager);
  };
  const offStart = pi.on("session_start", reset);
  const offShutdown = pi.on("session_shutdown", reset);
  const offMessage = pi.on("message_end", (event, context) => {
    if (disposed || context?.mode !== "tui") return;
    const message = event?.message;
    if (!message || typeof message !== "object") return;
    if (message.role !== "custom" || message.customType !== "subagent-notify" || message.display === true) return;

    const manager = context.sessionManager;
    if (!manager || typeof manager !== "object") return;
    let seen = seenBySession.get(manager);
    if (!seen) {
      seen = new WeakSet<object>();
      seenBySession.set(manager, seen);
    }
    if (seen.has(message)) return;
    seen.add(message);

    try {
      const text = formatCompactSubagentNotification(message);
      context.ui?.notify?.(text, "info");
    } catch (error) {
      // UI 投影失败不得改变原始消息消费或模型回合；诊断仅供现场排查。
      try { console.error("[subagent-completion-notices] UI projection failed", error); } catch { /* diagnostic sink is best effort */ }
    }
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      offMessage?.();
      offStart?.();
      offShutdown?.();
    },
  };
}
