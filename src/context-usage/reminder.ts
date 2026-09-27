import type { ContextUsageSnapshot, HandoffStatus } from "./snapshot.ts";

export type HandoffReminderState = {
  lastStatus: HandoffStatus | null;
};

export function createHandoffReminderState(): HandoffReminderState {
  return { lastStatus: null };
}

export function getHandoffReminder(
  snapshot: Pick<ContextUsageSnapshot, "status" | "handoffPath" | "percent" | "remainingTokens">,
  state: HandoffReminderState,
): { message: string | null; state: HandoffReminderState } {
  if (snapshot.status !== "prepare-handoff" && snapshot.status !== "urgent-handoff") {
    return { message: null, state: { lastStatus: snapshot.status } };
  }
  if (state.lastStatus === snapshot.status) {
    return { message: null, state };
  }

  const urgent = snapshot.status === "urgent-handoff";
  const message = urgent
    ? `当前上下文已达到紧急 handoff 阈值（约 ${snapshot.percent ?? "未知"}%）。请立即使用 write 工具将关键状态写入 ${snapshot.handoffPath}，再继续非必要工作。`
    : `当前上下文已接近自动压缩风险区（约 ${snapshot.percent ?? "未知"}%）。请在继续工作前更新 handoff 文档：${snapshot.handoffPath}。剩余估计 token：${snapshot.remainingTokens ?? "未知"}。`;

  return { message, state: { lastStatus: snapshot.status } };
}
