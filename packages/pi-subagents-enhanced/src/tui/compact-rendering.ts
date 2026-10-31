import { PRESENTATION_GLYPH, type SubagentPresentationStatus } from "../subagent-dispatch/presentation-status.ts";
import { getTitleRegistry } from "../subagent-dispatch/title-registry.ts";

const NOTIFICATION_STATUS = /^(?:Background tasks?|Detached foreground task) (completed|failed|paused|stopped)\b/;
const WORKFLOW_DISPATCH_COMPLETE = /\b(?:workflow\s+)?dispatch(?:ed)?\s+(?:is\s+)?complete\b/i;

// S4：每操作独立工具注册后，模型 args 不再携带 action；显示层按工具名映射固定 operation。
// 旧历史工具名（subagent/subagent_worktree/subagent_supervisor）不在表内，其历史 toolCall
// 仍按 args.action 投影，因此旧 session 只用于渲染历史，不表示旧调用还能执行。
export const SUBAGENT_OPERATION_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  subagent_roster: "list",
  subagent_start: "start",
  subagent_run_status: "status",
  subagent_run_steer: "steer",
  subagent_run_interrupt: "interrupt",
  subagent_run_resume: "resume",
  subagent_run_stop: "stop",
});

export const WORKSPACE_OPERATION_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  managed_workspace_list: "list",
  managed_workspace_status: "status",
  managed_workspace_dispose: "dispose",
  managed_workspace_release: "release",
});

export const SUPERVISOR_OPERATION_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  supervisor_request_pending: "pending",
  supervisor_request_status: "status",
  supervisor_request_reply: "reply",
});

/** 旧 union 工具名：仅用于历史显示与校验失败文案识别，不再是可注册模型工具名。 */
export const LEGACY_OPERATION_TOOL_NAMES: readonly string[] = Object.freeze([
  "subagent",
  "subagent_worktree",
  "subagent_supervisor",
]);

// Host 校验失败文案形如 `Validation failed for tool "<name>":`（pi-ai validation.js），
// 新旧工具名都要能识别，否则新名的校验失败会在工具卡里整段展开。
const VALIDATION_FAILED_TOOL_NAMES: readonly string[] = Object.freeze([
  ...Object.keys(SUBAGENT_OPERATION_BY_TOOL),
  ...Object.keys(WORKSPACE_OPERATION_BY_TOOL),
  ...Object.keys(SUPERVISOR_OPERATION_BY_TOOL),
  ...LEGACY_OPERATION_TOOL_NAMES,
]);
const VALIDATION_FAILED_FIRST_LINE = new RegExp(
  `^Validation failed for tool "(?:${VALIDATION_FAILED_TOOL_NAMES.join("|")})":\\s*$`,
  "m",
);

/** 工具名优先，其次回落到历史 args.action；两者都缺时返回 undefined（按未知操作投影原文）。 */
function resolveOperation(byTool: Readonly<Record<string, string>>, tool: unknown, input: Record<string, unknown> | undefined) {
  if (typeof tool === "string" && typeof byTool[tool] === "string") return byTool[tool];
  return input?.action;
}

function contextTool(context?: { tool?: unknown }): unknown {
  return record(context as unknown)?.tool;
}

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

// membrane 修复后不再装饰 completion message（raw boundary）：新通知的 title
// 只能在显示层按原始 correlation 行中的稳定 run 标识只读解析（titleForRun）。
// asyncDir 是 upstream single completion 的权威关联字段；只取其末段合法 run UUID，
// 不扫描目录、不读取文件，也不从正文任意短 UUID 猜测。grouped 通知不把一个 root
// 映射给多个 agent；Child 行仅按对应通知形态消费。
const SINGLE_TASK_HEADER = /^(?:Background task|Detached foreground task) (?:completed|failed|paused|stopped): \*\*/;
const CHILD_COMPLETION_HEADER = /^Workflow child /;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validRunId(value: unknown): string | undefined {
  return typeof value === "string" && RUN_ID.test(value) ? value : undefined;
}

function runIdFromAsyncDir(content: string): string | undefined {
  const raw = content.match(/^Retention-managed async directory:\s*(\S+)\s*$/m)?.[1];
  if (!raw || /[\\\0-\x1f\x7f-\x9f]/.test(raw)) return undefined;
  const path = raw.replace(/\/+$/, "");
  if (!path.startsWith("/") || path.includes("//")) return undefined;
  return validRunId(path.split("/").pop());
}

function notificationRunId(message: unknown, firstLine: string, content: string): string | undefined {
  const details = record(record(message)?.details);
  const single = SINGLE_TASK_HEADER.test(firstLine) && !/^Background tasks completed \(\d+\):/.test(firstLine);
  if (CHILD_COMPLETION_HEADER.test(firstLine)) {
    return validRunId(content.match(/^Child run:\s*(\S+)\s*$/m)?.[1])
      ?? validRunId(content.match(/^Workflow run:\s*(\S+)\s*$/m)?.[1]);
  }
  if (!single) return undefined;
  return runIdFromAsyncDir(content)
    ?? validRunId(details?.runId)
    ?? validRunId(details?.eventRunId)
    ?? validRunId(record(details?.event)?.runId);
}

function notificationTitles(message: unknown, firstLine: string, content: string) {
  const details = record(record(message)?.details);
  const runId = notificationRunId(message, firstLine, content);
  if (runId) {
    const title = getTitleRegistry().titleForRun(runId);
    if (title) return [title];
    const agent = firstLine.match(/:\s*\*\*([^*\r\n]+)\*\*/)?.[1]?.trim();
    return [agent ? `${agent} · ${runId.slice(0, 8)}` : `run: ${runId.slice(0, 8)}`];
  }
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
  const titles = notificationTitles(message, firstLine, content);
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
  // 成功/失败已由工具卡背景色表达，回执只保身份 + `·` + 状态，不带 glyph 前缀。
  return value?.isError === true || context?.isError === true
    ? `${agent}: ${title} · failed`
    : `${agent}: ${title} · started`;
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
export function formatCompactSupervisorToolResult(result: unknown, args: unknown, context?: { isError?: boolean; tool?: string }): string {
  const text = textContent(result);
  const input = record(args);
  const isError = record(result)?.isError === true || context?.isError === true;
  // 新工具名 supervisor_request_reply 固定 operation=reply；旧历史调用仍读 args.action。
  if (resolveOperation(SUPERVISOR_OPERATION_BY_TOOL, contextTool(context), input) !== "reply" || isError) return text;
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

/**
 * action=list 成功回执的 TUI 投影。roster JSON 是模型选择入口的原始数据，完整
 * frontmatter 由主 agent/模型消费；工具卡只展示 agent name + description 供一眼
 * 识别，不截断 description（换行由 UI 组件负责），不展示 model/tools/thinking/
 * systemPrompt 等原 JSON 字段。展示层优先消费结构化 details.agents；缺 details
 * 时只读 parse 原 content JSON 的 name/frontmatter.description 映射，不改
 * result/content/details。名单为空或不可解析时给中性占位，不伪造数据。
 */
function compactAgentRoster(result: unknown, text: string): string {
  const details = record(record(result)?.details);
  const structured = Array.isArray(details?.agents) ? details.agents : undefined;
  const rows: Array<{ name: string; description: string }> = [];
  if (structured) {
    for (const agent of structured) {
      const entry = record(agent);
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name) continue;
      rows.push({ name, description: typeof entry?.description === "string" ? entry.description : "" });
    }
  } else if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      for (const agent of Array.isArray(parsed) ? parsed : []) {
        const entry = record(agent);
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (!name) continue;
        const frontmatter = record(entry?.frontmatter);
        rows.push({ name, description: typeof frontmatter?.description === "string" ? frontmatter.description : "" });
      }
    } catch {
      // 非 JSON 文本：不伪造名单，保持中性占位。
    }
  }
  if (rows.length === 0) return "(no roster)";
  return rows.map(({ name, description }) => `• ${name}${description ? `：${description}` : ""}`).join("\n");
}

export function formatCompactSubagentToolResult(result: unknown, args: unknown, context?: { isError?: boolean; tool?: string }) {
  const text = textContent(result);
  const input = record(args);
  const isError = record(result)?.isError === true || context?.isError === true;
  // 新工具名固定 operation（roster=list、start=spawn、run_*=对应控制动作）；
  // 旧历史调用继续按 args.action 投影，raw/details 一律不改写。
  const action = resolveOperation(SUBAGENT_OPERATION_BY_TOOL, contextTool(context), input);
  if (action === "steer") return formatCompactSubagentSteerResult(result, args, { isError });
  if (isError) return text;
  // list 成功回执只投影 name+description 简名册（见 compactAgentRoster）；错误在
  // 上方原样返回，不误标成功。
  if (action === "list") return compactAgentRoster(result, text);
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
    if (VALIDATION_FAILED_FIRST_LINE.test(text.split(/\r?\n/, 1)[0] ?? "")) {
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
