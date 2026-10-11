import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createContextUsageSnapshot,
  createContextUsageToolResult,
  DEFAULT_HANDOFF_POLICY,
  ContextUsageOutputSchema,
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

  pi.registerTool(defineTool({
    name: "context_usage",
    label: "context_usage",
    description:
      "读取当前上下文窗口使用量估计。",
    promptSnippet: "读取当前上下文窗口估计量及 handoff 阈值状态。",
    promptGuidelines: ["需要判断当前上下文余量时使用 context_usage；结果是估计值，unknown 不代表余量充足。"],
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: ContextUsageOutputSchema,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return createContextUsageToolResult(ctx.getContextUsage?.(), DEFAULT_HANDOFF_POLICY);
    },
  }));

  if (typeof pi.on === "function") {
    pi.on("session_compact", () => {
      reminderState = createHandoffReminderState();
    });
    pi.on("agent_end", (_event, ctx) => {
      inspect(ctx);
    });
  }
}
