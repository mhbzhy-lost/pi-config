import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "tool-timing.v1";

type ToolTiming = {
  toolCallId: string;
  requestedAt: string;
  resultReadyAt: string;
};

export function createToolTimingExtension(pi: ExtensionAPI): void {
  const pending = new Map<string, { wallMs: number; monotonicMs: number }>();
  const completed = new Map<string, ToolTiming>();

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    pending.clear();
    completed.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as Partial<ToolTiming> | undefined;
      if (typeof data?.toolCallId === "string" && typeof data.requestedAt === "string" && typeof data.resultReadyAt === "string") {
        completed.set(data.toolCallId, data as ToolTiming);
      }
    }
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => { pending.clear(); completed.clear(); });
  pi.on("agent_end", () => { pending.clear(); });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    // 完整调用到达时统一采样，串行调度中等待前一个调用的时间也计入本次区间。
    const wallMs = Date.now();
    const monotonicMs = performance.now();
    for (const part of event.message.content) {
      if (part.type === "toolCall") pending.set(part.id, { wallMs, monotonicMs });
    }
  });

  pi.on("tool_execution_end", (event) => {
    const start = pending.get(event.toolCallId);
    if (!start) return;
    pending.delete(event.toolCallId);
    // 此事件在后置处理完成后、并行批次统一创建回执前到达。
    // 用单调时钟计算区间，再映射到接收时的墙钟，避免系统校时改变耗时。
    const timing: ToolTiming = {
      toolCallId: event.toolCallId,
      requestedAt: new Date(start.wallMs).toISOString(),
      resultReadyAt: new Date(start.wallMs + performance.now() - start.monotonicMs).toISOString(),
    };
    completed.set(event.toolCallId, timing);
    // 独立元数据支持 reload/续接；不改写工具调用、原始结果或既有会话记录。
    pi.appendEntry(ENTRY_TYPE, timing);
  });

  pi.on("context", (event) => {
    const assistantIndex = event.messages.findLastIndex((message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "toolCall"));
    if (assistantIndex < 0) return;

    const timingByToolCall = new Map<string, ToolTiming>();
    for (const message of event.messages.slice(assistantIndex + 1)) {
      if (message.role !== "toolResult") break;
      const timing = completed.get(message.toolCallId);
      // 旧会话或非模型发起的调用没有观测值，不根据回执 timestamp 倒推。
      if (!timing) continue;
      timingByToolCall.set(message.toolCallId, timing);
    }
    if (timingByToolCall.size === 0) return;

    return {
      messages: event.messages.map((message) => {
        if (message.role !== "toolResult") return message;
        const timing = timingByToolCall.get(message.toolCallId);
        if (!timing) return message;
        const timingText = `调用接收时间：${timing.requestedAt}\n结果就绪时间：${timing.resultReadyAt}`;
        if (message.content.some((part) => part.type === "text" && part.text === timingText)) return message;
        return {
          ...message,
          content: [
            ...message.content,
            { type: "text" as const, text: timingText },
          ],
        };
      }),
    };
  });
}
