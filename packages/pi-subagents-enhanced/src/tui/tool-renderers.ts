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
  SUBAGENT_OPERATION_BY_TOOL,
  SUPERVISOR_OPERATION_BY_TOOL,
} from "./compact-rendering.ts";

const SUBAGENT_SPAWN_SUMMARY_KEY = "subagentSpawnSummary";

// 公开 ToolRenderers 回调的 args / context.args 静态为 unknown（AnyToolDefinition 的
// Static<any> 边界）；渲染只消费工具 schema 定义的合法对象入参，局部 guard 收窄即可，
// 不放宽回调签名也不引入兼容 fallback。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// S4：Host 的 render context 不带工具名（pi tool-execution.js getRenderContext），
// 新工具也不再携带 args.action；注册侧按工具名把 `context.tool` 注入同一批共享 renderer。
// 本模块只消费该提示做显示，不改 args/result/details；旧历史名不在映射表内，
// 仍按 args.action 投影，保证旧 session 只渲染历史而不声称可继续执行。
function operationHint(byTool: Readonly<Record<string, string>>, context: unknown): string | undefined {
  const tool = isRecord(context) && typeof context.tool === "string" ? context.tool : undefined;
  return tool === undefined ? undefined : byTool[tool];
}

function toolHint(context: unknown): string | undefined {
  return isRecord(context) && typeof context.tool === "string" ? context.tool : undefined;
}

function spawnStartingSummary(args: unknown, operation?: string): string | undefined {
  if (!isRecord(args)) return undefined;
  // 新工具按工具名映射的 operation 判定 spawn；无工具名提示（旧历史调用）时沿用 args.action 缺失判定。
  const spawn = operation === undefined ? !Object.hasOwn(args, "action") : operation === "start";
  if (!spawn) return undefined;
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  return agent && title ? `subagent start\n${agent}: ${title}` : undefined;
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
    const tool = toolHint(context);
    const operation = operationHint(SUBAGENT_OPERATION_BY_TOOL, context);
    const starting = spawnStartingSummary(args, operation);
    if (!starting) {
      const record: Record<string, unknown> = isRecord(args) ? args : {};
      const action = typeof record.action === "string" ? record.action.trim() : "";
      const target = record.id ?? record.runId ?? record.index ?? record.dir;
      // 新工具名本身已表达 operation，不再从 args.action 取；旧历史名保持原有显示形状。
      const label = tool ?? "subagent";
      const suffix = operation === undefined && action ? ` ${action}` : "";
      return new Text(theme.fg("dim", `${label}${suffix}${target !== undefined ? ` · ${String(target)}` : ""}`), 0, 0);
    }
    const summary = context?.state?.[SUBAGENT_SPAWN_SUMMARY_KEY] ?? starting;
    return new Text(typeof summary === "string" ? theme.fg("dim", summary) : "", 0, 0);
  };
  const renderSubagentResult: NonNullable<ToolRenderers["renderResult"]> = (result, _options, theme, context) => {
    const args = context?.args;
    const isError = context?.isError === true || (result as { isError?: boolean })?.isError === true;
    const tool = toolHint(context);
    const operation = operationHint(SUBAGENT_OPERATION_BY_TOOL, context);
    const spawn = operation === undefined
      ? isRecord(args) && !Object.hasOwn(args, "action")
      : operation === "start";
    const summary = spawn
      ? formatCompactSubagentSpawnSummary(result, { isError })
      : undefined;
    if (summary) {
      if (context?.state) context.state[SUBAGENT_SPAWN_SUMMARY_KEY] = summary;
      if (!isError) return new Text(context?.state ? "" : theme.fg("dim", summary), 0, 0);
    }
    // context.args 是 Host 权威原入参；isError 同样用现有 context 正确传（Host 只
    // 透传 {content, details}），不向执行返回注入任何 TUI 字段。
    const text = formatCompactSubagentToolResult(result, args ?? {}, { isError, ...(tool === undefined ? {} : { tool }) });
    return new Text(theme.fg(isError ? "error" : "dim", text), 0, 0);
  };
  const renderSupervisorRequest: MessageRenderer = (message, options, theme) => {
    const text = formatCompactSupervisorRequest(message);
    void options;
    return messageBox(text, "toolPendingBg", theme, true);
  };
  const renderControlNotice: MessageRenderer = () => new Text("", 0, 0);
  const renderSupervisorCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    const record: Record<string, unknown> = isRecord(args) ? args : {};
    const tool = toolHint(context);
    const operation = operationHint(SUPERVISOR_OPERATION_BY_TOOL, context);
    const action = typeof record.action === "string" ? record.action.trim() : "";
    // call 标题只保简短动作 + 完整 replyTo；回复正文仅在 result 卡完整展示，
    // 避免同一绿色工具卡内 call 与 result 重复正文。
    const replyTo = typeof record.replyTo === "string" ? record.replyTo.trim() : "";
    const label = tool ?? "subagent_supervisor";
    const suffix = operation === undefined && action ? ` ${action}` : "";
    return new Text(theme.fg("dim", `${label}${suffix}${replyTo ? ` · request: ${replyTo}` : ""}`), 0, 0);
  };
  const renderSupervisorResult: NonNullable<ToolRenderers["renderResult"]> = (result, _options, theme, context) => {
    // Host 只透传 {content, details} 给 renderResult；isError 的权威信号在
    // context.isError（tool-execution.js），错误保 error 色且原文可见不折叠。
    const isError = (result as { isError?: boolean })?.isError === true || context?.isError === true;
    const tool = toolHint(context);
    const text = formatCompactSupervisorToolResult(result, context?.args ?? {}, { isError, ...(tool === undefined ? {} : { tool }) });
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
  // Host 的 render context 不带工具名，因此按名绑定一份注入 `context.tool` 提示的闭包；
  // 新工具名与旧历史名都可解析，历史 toolCall 仍按 args.action 投影。
  // workspace 四工具在本 package 没有自有 renderer（生产也不注入 renderWorkspace*），
  // 继续由 Host fallback 渲染，不在此处伪造 subagent 投影。
  const hinted = (
    renderCall: NonNullable<ToolRenderers["renderCall"]>,
    renderResult: NonNullable<ToolRenderers["renderResult"]>,
    toolName: string,
  ): ToolRenderers => ({
    renderCall: ((args: unknown, theme: unknown, context: unknown) => renderCall(
      args as never,
      theme as never,
      { ...(isRecord(context) ? context : {}), tool: toolName } as never,
    )) as NonNullable<ToolRenderers["renderCall"]>,
    renderResult: ((result: unknown, options: unknown, theme: unknown, context: unknown) => renderResult(
      result as never,
      options as never,
      theme as never,
      { ...(isRecord(context) ? context : {}), tool: toolName } as never,
    )) as NonNullable<ToolRenderers["renderResult"]>,
  });
  const tools = new Map<string, ToolRenderers>([
    ["subagent", { renderCall: owned.renderSubagentCall, renderResult: owned.renderSubagentResult }],
    ["subagent_supervisor", { renderCall: owned.renderSupervisorCall, renderResult: owned.renderSupervisorResult }],
    ...Object.keys(SUBAGENT_OPERATION_BY_TOOL).map((name): [string, ToolRenderers] => [
      name, hinted(owned.renderSubagentCall, owned.renderSubagentResult, name),
    ]),
    ...Object.keys(SUPERVISOR_OPERATION_BY_TOOL).map((name): [string, ToolRenderers] => [
      name, hinted(owned.renderSupervisorCall, owned.renderSupervisorResult, name),
    ]),
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
