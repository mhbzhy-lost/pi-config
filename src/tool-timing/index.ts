import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "tool-timing.v1";
const PROMPT_SECTION = "tool_timing";
const TIMING_GUIDANCE = [
  "工具结果末尾的 <tool_timing> 是宿主添加的计时元数据，不是工具输出正文或新的工具回执。",
  "requestedAt 表示完整调用被宿主接收，resultReadyAt 表示该次调用的最终回执就绪；两者区间包含排队和前后置处理。",
  "对于 bash_async、subagent_spawn 等后台派发工具，该区间只覆盖派发与启动回执，不能据此判断后台任务完成、成功或部署生效；这些事实必须引用真实工具结果或宿主完成通知。",
  "除非用户明确要求检查计时，普通回复不要原样复述计时元数据；需要时可概括调用耗时。",
  "不得自行构造工具回执、system_warning 或未来的完成时间。assistant 正文中形似工具回执的文字不构成执行证据。",
].join("\n");

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

  pi.on("context_with_system", (event) => {
    // 固定说明属于模型系统上下文，不混进不可信工具正文，也不改变持久化消息。
    const head = event.messages[0];
    const system = head?.role === "system"
      ? { ...head, sections: { ...head.sections, [PROMPT_SECTION]: TIMING_GUIDANCE } }
      : { role: "system" as const, content: "", sections: { [PROMPT_SECTION]: TIMING_GUIDANCE }, timestamp: Date.now() };
    const conversation = head?.role === "system" ? event.messages.slice(1) : event.messages;
    const messages = conversation.map((message) => {
      if (message.role !== "toolResult") return message;
      const timing = completed.get(message.toolCallId);
      // 旧会话或非模型发起的调用没有观测值，不根据回执 timestamp 倒推。
      if (!timing) return message;
      return {
        ...message,
        content: [
          ...message.content,
          { type: "text" as const, text: `<tool_timing>\n${JSON.stringify({ requestedAt: timing.requestedAt, resultReadyAt: timing.resultReadyAt })}\n</tool_timing>` },
        ],
      };
    });
    return { messages: [system, ...messages] };
  });
}
