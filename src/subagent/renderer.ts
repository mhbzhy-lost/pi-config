import { Text } from "@earendil-works/pi-tui";
import type { MessageRenderOptions, MessageRenderer, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatStandardReceipt } from "../async-receipt/format.ts";
import { resultStatus, setRenderStatus, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "../compact-tools/index.ts";

const AGENT_NAME = "executor";
const titlesByRunId = new Map<string, string>();
const titlesByToolCallId = new Map<string, string>();

export function rememberSubagentMessage(message: any): void {
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type !== "toolCall" || part.name !== "subagent_spawn") continue;
      const title = compact(part.arguments?.title, "");
      if (title && typeof part.id === "string") titlesByToolCallId.set(part.id, title);
    }
    return;
  }
  if (message?.role !== "toolResult" || !message.toolName || !message.details) return;
  const title = titlesByToolCallId.get(message.toolCallId);
  if (!title) return;
  const details = message.details;
  const sourceRunId = details.sourceRunId ?? details.sourceAsyncId;
  const resultRunId = details.runId ?? details.asyncId ?? details.resumedRunId;
  if (typeof sourceRunId === "string") titlesByRunId.set(sourceRunId, title);
  if (typeof resultRunId === "string") titlesByRunId.set(resultRunId, title);
}

function rawText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part: any) => typeof part?.text === "string" ? part.text : JSON.stringify(part)).join("\n");
}

function completionReceipt(run: any) {
  const agent = compact(run?.agent, AGENT_NAME);
  const runId = run?.runId ?? run?.asyncId ?? run?.id;
  const title = compact(titlesByRunId.get(runId) ?? run?.taskInfo ?? run?.title ?? run?.task, "未命名任务");
  return formatStandardReceipt({
    toolTitle: "subagent",
    id: runId,
    preview: `${agent} ${title}`,
    outcome: run?.outcome ?? run?.status ?? "unknown",
    elapsedMs: run?.elapsedMs,
    failureReason: run?.error ?? run?.reason ?? run?.failureMessage,
  }, truncateToWidth);
}

export function createSubagentCompletionRenderer(): MessageRenderer {
  return (message: any, options: MessageRenderOptions, theme: Theme): Component | undefined => {
    const runs = Array.isArray(message?.details?.runs) ? message.details.runs : [];
    if (runs.length === 0) return undefined;
    const projections = runs.map(completionReceipt);
    const folded = projections.map((projection) => projection.text).join("\n");
    const failed = projections.some((projection) => projection.failed);
    const content = options.expanded
      ? [folded, rawText(message), message.details === undefined ? "" : `details:\n${JSON.stringify(message.details, null, 2)}`].filter(Boolean).join("\n\n")
      : folded;
    return new Text(theme.fg(failed ? "error" : "dim", content), Math.max(0, Math.floor(options.outputPad ?? 1)), 0);
  };
}

function compact(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : fallback;
}

function runIdFromResult(result: any): string | undefined {
  const value = result?.details?.runId ?? result?.details?.run_id ?? result?.details?.asyncId ?? result?.structuredContent?.runId;
  return typeof value === "string" && value ? value : undefined;
}

function rememberControlResult(args: any, result: any): void {
  const sourceRunId = typeof args?.runId === "string" ? args.runId : undefined;
  const title = sourceRunId ? titlesByRunId.get(sourceRunId) : undefined;
  const resultRunId = runIdFromResult(result);
  if (title && resultRunId) titlesByRunId.set(resultRunId, title);
}

function line(name: string, title: string, extra: string, theme: any, status?: CompactRenderStatus): string {
  return `${statusGlyph(theme, status)} ${theme.bold(name)} ${AGENT_NAME}${title ? ` ${title}` : ""}${extra}`;
}

function renderTool(name: string, getExtra: (args: any, context: any) => string, remember?: (args: any, result: any, context: any) => void): any {
  return (toolName: string, next: () => any) => {
    if (toolName !== name) return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(args: any, theme: any, context: any) {
        if (remember) remember(args, undefined, context);
        syncStatusAnimation(context, context?.state?.status);
        const title = name === "subagent_spawn"
          ? compact(args?.title, "")
          : compact(titlesByRunId.get(args?.runId), "");
        const extra = getExtra(args, context);
        return { render: () => [line(name, title, extra, theme, context?.state?.status)], invalidate() {} };
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        if (remember) remember(context?.args, result, context);
        setRenderStatus(context, resultStatus(result, options, context));
        return new Text("", 0, 0);
      },
    };
  };
}

export function createSubagentRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name === "subagent_spawn") {
      return renderTool(name, () => "", (args, result, context) => {
        const title = compact(args?.title, "");
        const runId = runIdFromResult(result);
        if (title && runId) titlesByRunId.set(runId, title);
        if (title && context?.toolCallId) titlesByToolCallId.set(context.toolCallId, title);
      })(name, next);
    }
    if (["subagent_status", "subagent_stop", "subagent_resume"].includes(name)) {
      return renderTool(name, () => "", (args, result) => {
        const title = titlesByRunId.get(args?.runId);
        if (title && args?.runId) titlesByRunId.set(args.runId, title);
        rememberControlResult(args, result);
      })(name, next);
    }
    if (name === "subagent_steer") {
      return renderTool(name, (args) => {
        const message = compact(args?.message, "");
        return message ? ` ${message}` : "";
      }, (args) => {
        const title = titlesByRunId.get(args?.runId);
        if (title && args?.runId) titlesByRunId.set(args.runId, title);
      })(name, next);
    }
    return next();
  };
}
