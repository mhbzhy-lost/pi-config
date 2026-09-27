import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createContextUsageSnapshot,
  createContextUsageToolResult,
  DEFAULT_HANDOFF_POLICY,
} from "../../src/context-usage/snapshot.ts";
import {
  createHandoffReminderState,
  getHandoffReminder,
  type HandoffReminderState,
} from "../../src/context-usage/reminder.ts";

export default function contextUsageExtension(pi: ExtensionAPI) {
  let reminderState: HandoffReminderState = createHandoffReminderState();

  const inspect = (ctx: { getContextUsage?: () => Parameters<typeof createContextUsageSnapshot>[0] }) => {
    const usage = ctx.getContextUsage?.();
    const snapshot = createContextUsageSnapshot(usage, DEFAULT_HANDOFF_POLICY);
    const reminder = getHandoffReminder(snapshot, reminderState);
    reminderState = reminder.state;
    if (reminder.message) {
      pi.sendMessage(
        { customType: "context-usage-handoff", content: reminder.message, display: false },
        { triggerTurn: false },
      );
    }
    return snapshot;
  };

  pi.registerTool({
    name: "context_usage",
    label: "context_usage",
    description:
      "读取当前上下文窗口使用量估计。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return createContextUsageToolResult(ctx.getContextUsage?.(), DEFAULT_HANDOFF_POLICY);
    },
  } as any);

  if (typeof (pi as any).on === "function") {
    (pi as any).on("session_compact", () => {
      reminderState = createHandoffReminderState();
    });
    (pi as any).on("agent_end", (_event: unknown, ctx: { getContextUsage?: () => Parameters<typeof createContextUsageSnapshot>[0] }) => {
      inspect(ctx);
    });
  }
}
