import { PRESENTATION_GLYPH, type SubagentPresentationStatus } from "../subagent-dispatch/presentation-status.ts";
import { getTitleRegistry } from "../subagent-dispatch/title-registry.ts";

const NOTIFICATION_STATUS = /^(?:Background tasks?|Detached foreground task) (completed|failed|paused|stopped)\b/;
const WORKFLOW_DISPATCH_COMPLETE = /\b(?:workflow\s+)?dispatch(?:ed)?\s+(?:is\s+)?complete\b/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textContent(value: unknown) {
  const input = record(value);
  if (!Array.isArray(input?.content)) return "";
  return input.content
    .filter((part) => record(part)?.type === "text")
    .map((part) => String(record(part)?.text ?? ""))
    .join("\n");
}

function notificationTitles(message: unknown, firstLine: string) {
  const details = record(record(message)?.details);
  const structured = Array.isArray(details?.titles)
    ? details.titles.filter((title): title is string => typeof title === "string" && Boolean(title.trim())).map((title) => title.trim())
    : [];
  if (structured.length > 0) return structured;
  const titled = [...firstLine.matchAll(/\[([^\]\r\n]+)\]/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
  if (titled.length > 0) return titled;
  return [...firstLine.matchAll(/\*\*([^*\r\n]+)\*\*/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
}

function presentations(message: unknown): SubagentPresentationStatus[] {
  const values = record(record(message)?.details)?.presentations;
  return Array.isArray(values) ? values.filter((value): value is SubagentPresentationStatus => typeof value === "string" && value in PRESENTATION_GLYPH) : [];
}

function workflowDispatchReceipt(firstLine: string): string | undefined {
  if (!/\*\*workflow\*\*/i.test(firstLine) || !WORKFLOW_DISPATCH_COMPLETE.test(firstLine)) return undefined;
  const count = firstLine.match(/dispatch(?:ed)?\s+(?:is\s+)?complete;\s*(\d+)\s+child\s+running\s+or\s+uncollected/i)?.[1];
  return count === undefined
    ? "派发完成，子任务仍运行或待收集（数量未知）"
    : `派发完成，${count}个子任务仍运行或待收集`;
}

export function formatCompactSubagentNotification(message: unknown) {
  const content = typeof record(message)?.content === "string" ? record(message)!.content as string : "";
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const receipt = workflowDispatchReceipt(firstLine);
  if (receipt) return receipt;
  const rawStatus = firstLine.match(NOTIFICATION_STATUS)?.[1] ?? "unknown";
  const titles = notificationTitles(message, firstLine);
  const labels = titles.length > 0 ? titles : ["subagent"];
  const states = presentations(message);
  return labels.map((title, index) => {
    const state = states[index];
    return state ? `${PRESENTATION_GLYPH[state]} ${title} · ${state}` : `${rawStatus === "completed" ? "✓" : rawStatus === "paused" ? "Ⅱ" : rawStatus === "stopped" ? "■" : rawStatus === "failed" ? "◇" : "?"} ${title} · ${rawStatus === "failed" ? "reported" : rawStatus}`;
  }).join("\n");
}

export function formatCompactSubagentWorkspaceReminder(message: unknown): string {
  const details = record(record(message)?.details);
  const workspaceId = typeof details?.workspaceId === "string" && details.workspaceId.trim()
    ? details.workspaceId.trim() : "workspace";
  return details?.workspaceState === "preserved"
    ? `↳ workspace ${workspaceId} · preserved; release when no longer needed`
    : `↳ workspace ${workspaceId} · awaiting disposition`;
}

export function formatCompactSubagentSpawnSummary(result: unknown, context?: { isError?: boolean }): string | undefined {
  const value = record(result);
  const details = record(value?.details);
  const agent = typeof details?.agent === "string" ? details.agent.trim() : "";
  const title = typeof details?.title === "string" ? details.title.trim() : "";
  if (!agent || !title) return undefined;
  return `* subagent ${value?.isError === true || context?.isError === true ? "failed" : "started"} ${agent}: ${title}`;
}

export function formatCompactSubagentSteerResult(result: unknown, args: unknown, context?: { isError?: boolean }): string {
  const input = record(args);
  const details = record(record(result)?.details);
  // isError 以 Host context 为权威（tool-execution.js 只透传 {content, details}），
  // 错误回执不渲染投递 header，避免把失败 steer 说成已发送；原文保 error 事实。
  if (record(result)?.isError === true || context?.isError === true) return textContent(result);
  // 目标辨识与 subagent-dispatch canonicalSteerTarget 同序：input.id → input.runId，
  // 上游回执 details.runId 兜底；有合法 runId 必须进 title registry lookup，
  // 缓存缺失（重启历史）时仍以 run: <id> 可辨目标，不得退化为裸 subagent。
  const runId = typeof input?.id === "string" && input.id.trim()
    ? input.id.trim()
    : typeof input?.runId === "string" && input.runId.trim() ? input.runId.trim()
    : typeof details?.runId === "string" && details.runId.trim() ? details.runId.trim() : "";
  const registry = getTitleRegistry();
  const title = (runId ? registry.titleFor(runId) : undefined)
    ?? (typeof details?.title === "string" && details.title.trim() ? details.title.trim() : undefined);
  const agent = (runId ? registry.agentFor(runId) : undefined)
    ?? (typeof details?.agent === "string" && details.agent.trim() ? details.agent.trim() : undefined);
  // 仅剩 dir（上游 schema 的合法定位字段）时投影精确目录目标，不虚构 run identity/agent；
  // 完全未提供目标标识才显示「目标未确认」。
  const dir = !runId && typeof input?.dir === "string" && input.dir.trim() ? input.dir.trim() : "";
  const dirLabel = dir ? `目标目录 ${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}` : "";
  const target = [agent ? `(${agent})` : undefined, title].filter(Boolean).join(" ")
    || (runId ? `run: ${runId}` : dirLabel || "目标未确认");
  const message = typeof input?.message === "string" ? input.message : "";
  return `→ [steer] ${target}：\n${message}`;
}

export function formatCompactSupervisorRequest(message: unknown): string {
  const value = record(message);
  const details = record(value?.details);
  const content = typeof value?.content === "string" ? value.content : "";
  const agent = typeof value?.agent === "string" && value.agent.trim()
    ? value.agent.trim()
    : typeof details?.agent === "string" && details.agent.trim()
    ? details.agent.trim()
    : typeof details?.targetAgent === "string" && details.targetAgent.trim()
      ? details.targetAgent.trim()
      : "subagent";
  const title = typeof details?.title === "string" ? details.title.trim() : "";
  const trimmedContent = content.trimEnd();
  const titleSuffix = title ? ` [${title}]` : "";
  const displayContent = titleSuffix && trimmedContent.endsWith(titleSuffix)
    ? trimmedContent.slice(0, -titleSuffix.length)
    : trimmedContent;
  const lines = displayContent.split(/\r?\n/);
  const replyHintIndex = lines.findIndex((line) => /^Reply with:\s*subagent_supervisor\s*\(/i.test(line.trim()));
  const body = (replyHintIndex >= 0 ? lines.slice(0, replyHintIndex) : lines)
    .filter((line) => !/^(?:Subagent (?:progress update|needs attention|needs a supervisor decision)\.?|Supervisor (?:progress update|request|needs decision)\.?|Agent|Run|Child index|Child intercom target|Intercom target|Supervisor request|Request id):?\s*/i.test(line.trim()))
    .join("\n")
    .trim();
  return `← (${agent})${title ? ` ${title}` : ""}:\n${body}`;
}

/**
 * 上游 subagent_supervisor_reply 自定义条目的纯展示回执。只投影 sender 写入的
 * 结构化归属字段（agent、短 run id），不展开 Reason/Child index/Child target/
 * Reply to 矩阵，也不读取 Reply 正文。该条目是 supervisor 侧的本地提交日志
 * （native-supervisor-channel.js 在 writeReply 落盘成功后才 appendEntry），
 * 不能据此断言 child 已送达或已消费，因此文案固定为「回复已提交」；结构化
 * 字段缺失时降级为中性行，不伪造确认。兼容 entry（.data 承载 payload）与
 * 直接传 payload 两种入参形状。
 */
export function formatCompactSupervisorReply(entry: unknown): string {
  const source = record(entry);
  const data = record(source?.data) ?? source;
  const agent = typeof data?.agent === "string" && data.agent.trim() ? data.agent.trim() : "";
  const runId = typeof data?.runId === "string" ? data.runId.trim() : "";
  if (agent) return `回复已提交 · ${agent}${runId ? ` · ${runId.slice(0, 8)}` : ""}`;
  if (runId) return `回复已提交 · run: ${runId.slice(0, 8)}`;
  return "↩ Supervisor 回复";
}

/**
 * subagent_supervisor tool-result 的纯展示投影。isError 以 Host context 为权威：
 * interactive tool-execution.js 调 renderResult 时只透传 {content, details}，
 * result.isError 不会到达本函数，错误必须经 context.isError 保可见（原文不折叠）。
 * reply 且明确成功时（details.replyTo 是 native writeReply 成功结果的结构化凭据），
 * 工具卡展示目标信息（agent、registry 既有 title 仅 lookup 不登记、完整 runId、
 * 完整 replyTo）与「回复内容」全文：正文取自原请求 input.message 原样拼入，不裁字、
 * 不摘要、不改字符；缺字段只省略对应行，不虚构 reason/child index 等未提供信息，
 * title 仅为展示装饰不作权威。独立 native entry 仍走 dim 简短回执，两者不重复正文。
 * 非错误但缺结构化凭据的未知成功形状显示原回复正文并标注「回复状态未确认」，
 * 不伪成功/ACK。
 */
export function formatCompactSupervisorToolResult(result: unknown, args: unknown, context?: { isError?: boolean }): string {
  const text = textContent(result);
  const input = record(args);
  const isError = record(result)?.isError === true || context?.isError === true;
  if (input?.action !== "reply" || isError) return text;
  const details = record(record(result)?.details);
  const message = typeof input?.message === "string" ? input.message : "";
  if (typeof details?.replyTo === "string" && details.replyTo.trim()) {
    const runId = typeof details?.runId === "string" && details.runId.trim() ? details.runId.trim() : "";
    const agent = (typeof details?.agent === "string" && details.agent.trim() ? details.agent.trim() : undefined)
      ?? (runId ? getTitleRegistry().agentFor(runId) : undefined)
      ?? (typeof input?.to === "string" && input.to.trim() ? input.to.trim() : undefined);
    const title = runId ? getTitleRegistry().titleFor(runId) : undefined;
    const target = [agent ? `(${agent})` : undefined, title].filter(Boolean).join(" ");
    const lines = [`→ [reply]${target ? ` ${target}` : ""}`];
    if (runId) lines.push(`Run: ${runId}`);
    lines.push(`Reply to: ${details.replyTo.trim()}`);
    if (message.length > 0) lines.push("", message);
    return lines.join("\n");
  }
  return message ? `回复状态未确认\n\n${message}` : "回复状态未确认";
}

export function formatCompactSubagentToolResult(result: unknown, args: unknown, context?: { isError?: boolean }) {
  const text = textContent(result);
  const input = record(args);
  const isError = record(result)?.isError === true || context?.isError === true;
  const action = input?.action;
  if (action === "steer") return formatCompactSubagentSteerResult(result, args, { isError });
  if (isError) return text;
  if (action === "interrupt") {
    const target = input?.id ?? input?.runId ?? input?.index ?? input?.dir;
    return `已中断${target !== undefined ? ` · ${String(target)}` : ""}`;
  }
  if (action === "resume") {
    const details = record(record(result)?.details);
    const sourceRunId = typeof input?.id === "string" && input.id.trim()
      ? input.id.trim()
      : typeof input?.runId === "string" && input.runId.trim() ? input.runId.trim() : "";
    const revivedRunId = typeof details?.runId === "string" && details.runId.trim()
      ? details.runId.trim()
      : typeof details?.asyncId === "string" && details.asyncId.trim() ? details.asyncId.trim() : "";
    const registry = getTitleRegistry();
    const title = registry.titleFor(sourceRunId) ?? registry.titleFor(revivedRunId);
    const agent = text.match(/^Agent:\s*(.+?)\s*$/im)?.[1]?.trim();
    const target = title ?? agent ?? (revivedRunId ? `run: ${revivedRunId}` : "subagent");
    return `▶ ${target} · resumed`;
  }
  if (action !== "status") {
    if (/^Validation failed for tool "subagent":\s*$/m.test(text.split(/\r?\n/, 1)[0] ?? "")) {
      return text.split(/^Received arguments:\s*$/m, 1)[0].trimEnd();
    }
    return text;
  }
  const details = record(record(result)?.details);
  const requestedArgs = record(args);
  const requestedId = typeof requestedArgs?.id === "string" ? requestedArgs.id.trim() : "";
  const reportedId = text.match(/^Run:\s*(\S+)\s*$/im)?.[1] ?? "";
  const runId = typeof details?.runId === "string" && details.runId.trim()
    ? details.runId.trim()
    : requestedId || reportedId;
  const title = runId ? getTitleRegistry().titleFor(runId) : undefined;
  const suffix = title ? ` · ${title}` : runId ? ` · run: ${runId}` : "";
  const state = text.match(/^State:\s*(.+?)\s*$/im)?.[1];
  if (state) return `Status: ${state}${suffix}`;
  const active = text.match(/^Active async runs:\s*(\d+)\s*$/im)?.[1];
  if (active) return `Status: ${active} active`;
  if (/^No active async runs\.\s*$/im.test(text)) return "Status: idle";
  return "Status: unknown";
}
