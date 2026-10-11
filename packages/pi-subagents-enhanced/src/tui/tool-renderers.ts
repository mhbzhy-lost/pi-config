import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EntryRenderer,
  type MessageRenderer,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  formatCompactSubagentNotification,
  formatCompactSubagentWorkspaceReminder,
  formatCompactSubagentSpawnSummary,
  formatCompactSubagentToolResult,
  formatCompactSupervisorRequest,
  formatCompactSupervisorReply,
  formatCompactSupervisorToolResult,
} from "./compact-rendering.ts";

const SUBAGENT_SPAWN_SUMMARY_KEY = "subagentSpawnSummary";

// 公开 ToolRenderers 回调的 args / context.args 静态为 unknown（AnyToolDefinition 的
// Static<any> 边界）；渲染只消费工具 schema 定义的合法对象入参，局部 guard 收窄即可，
// 不放宽回调签名也不引入兼容 fallback。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function spawnStartingSummary(args: unknown): string | undefined {
  if (!isRecord(args) || Object.hasOwn(args, "action")) return undefined;
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  return agent && title ? `subagent starting ${agent}: ${title}` : undefined;
}

export function createSubagentToolRenderers() {
  const messageBox = (text: string, background: string, theme: any, splitHeader = false) => {
    const box = new Box(1, 1, (line) => theme.bg(background, line));
    if (splitHeader) {
      const [header, ...body] = text.split("\n");
      box.addChild(new Text(header ?? "", 0, 0));
      box.addChild(new Text(body.join("\n"), 0, 0));
    } else box.addChild(new Text(text, 0, 0));
    return box;
  };
  const renderSubagentCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    const starting = spawnStartingSummary(args);
    if (!starting) {
      const record: Record<string, unknown> = isRecord(args) ? args : {};
      const action = typeof record.action === "string" ? record.action.trim() : "";
      const target = record.id ?? record.runId ?? record.index ?? record.dir;
      return new Text(theme.fg("dim", `subagent${action ? ` ${action}` : ""}${target !== undefined ? ` · ${String(target)}` : ""}`), 0, 0);
    }
    const summary = context?.state?.[SUBAGENT_SPAWN_SUMMARY_KEY] ?? starting;
    return new Text(typeof summary === "string" ? theme.fg("dim", summary) : "", 0, 0);
  };
  const renderSubagentResult: NonNullable<ToolRenderers["renderResult"]> = (result, _options, theme, context) => {
    const args = context?.args;
    const isError = context?.isError === true || (result as { isError?: boolean })?.isError === true;
    const summary = isRecord(args) && !Object.hasOwn(args, "action")
      ? formatCompactSubagentSpawnSummary(result, { isError })
      : undefined;
    if (summary) {
      if (context?.state) context.state[SUBAGENT_SPAWN_SUMMARY_KEY] = summary;
      if (!isError) return new Text(context?.state ? "" : theme.fg("dim", summary), 0, 0);
    }
    // context.args 是 Host 权威原入参；isError 同样用现有 context 正确传（Host 只
    // 透传 {content, details}），不向执行返回注入任何 TUI 字段。
    const text = formatCompactSubagentToolResult(result, args ?? {}, { isError });
    return new Text(theme.fg(isError ? "error" : "dim", text), 0, 0);
  };
  const renderSupervisorRequest: MessageRenderer = (message, options, theme) => {
    const text = formatCompactSupervisorRequest(message);
    void options;
    return messageBox(text, "toolPendingBg", theme, true);
  };
  const renderControlNotice: MessageRenderer = () => new Text("", 0, 0);
  const renderSupervisorCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme) => {
    const record: Record<string, unknown> = isRecord(args) ? args : {};
    const action = typeof record.action === "string" ? record.action.trim() : "";
    // call 标题只保简短动作 + 完整 replyTo；回复正文仅在 result 卡完整展示，
    // 避免同一绿色工具卡内 call 与 result 重复正文。
    const replyTo = typeof record.replyTo === "string" ? record.replyTo.trim() : "";
    return new Text(theme.fg("dim", `subagent_supervisor${action ? ` ${action}` : ""}${replyTo ? ` · request: ${replyTo}` : ""}`), 0, 0);
  };
  const renderSupervisorResult: NonNullable<ToolRenderers["renderResult"]> = (result, _options, theme, context) => {
    // Host 只透传 {content, details} 给 renderResult；isError 的权威信号在
    // context.isError（tool-execution.js），错误保 error 色且原文可见不折叠。
    const isError = (result as { isError?: boolean })?.isError === true || context?.isError === true;
    const text = formatCompactSupervisorToolResult(result, context?.args ?? {}, { isError });
    return new Text(theme.fg(isError ? "error" : "dim", text), 0, 0);
  };
  // runtime 主动回执只用 dim 无框投影；工具卡的状态背景由 Host 原生外壳负责。
  // 水平 padding 取 1 与原生 status 行一致（Host showStatus 以 ThemedText(…,1,0) 渲染），
  // 使「回复已提交」与其他 dim 回执左缘对齐；仅组件 padding，不改 entry 数据与文案。
  const renderSupervisorReplyEntry: EntryRenderer = (entry, options, theme) => {
    void options;
    return new Text(theme.fg("dim", formatCompactSupervisorReply(entry)), 1, 0);
  };
  // 可见 completion 回执（如「派发完成…」）同样对齐原生 status 行水平 padding，
  // 仅展示层统一左缘，不改消息数据与文案。
  const renderCompletionNotification = (message: any, theme: any) => {
    return new Text(theme.fg("dim", formatCompactSubagentNotification(message)), 1, 0);
  };
  return { renderSubagentCall, renderSubagentResult, renderSupervisorRequest, renderControlNotice, renderSupervisorCall, renderSupervisorResult, renderSupervisorReplyEntry, renderCompletionNotification };
}

/** 预览只消费本 package 和原生公开 renderer；不查询 Host 私有 registry。 */
export function createChildConversationRenderers(cwd: string) {
  const owned = createSubagentToolRenderers();
  const tools = new Map<string, ToolRenderers>([
    ["subagent", { renderCall: owned.renderSubagentCall, renderResult: owned.renderSubagentResult }],
    ["subagent_supervisor", { renderCall: owned.renderSupervisorCall, renderResult: owned.renderSupervisorResult }],
  ]);
  for (const factory of [createReadToolDefinition, createBashToolDefinition, createPowerShellToolDefinition, createEditToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]) {
    const { name, renderShell, renderCall, renderResult } = factory(cwd);
    tools.set(name, { renderShell, renderCall, renderResult });
  }
  const messages = new Map<string, MessageRenderer>([
    ["subagent_supervisor_request", owned.renderSupervisorRequest],
    ["subagent_control_notice", owned.renderControlNotice],
    ["subagent-notify", (message, _options, theme) => owned.renderCompletionNotification(message, theme)],
    ["subagent-workspace-reminder", (message, _options, theme) => new Text(theme.fg("dim", formatCompactSubagentWorkspaceReminder(message)), 0, 0)],
  ]);
  const entries = new Map<string, EntryRenderer>([
    ["subagent_supervisor_reply", owned.renderSupervisorReplyEntry],
  ]);
  return {
    resolveToolRenderer: (name: string): ToolRenderers | undefined => tools.get(name),
    resolveMessageRenderer: (customType: string): MessageRenderer | undefined => messages.get(customType),
    resolveEntryRenderer: (customType: string): EntryRenderer | undefined => entries.get(customType),
  };
}
