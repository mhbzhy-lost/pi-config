import { Text } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";

const AGENT_NAME = "executor";
const titlesByRunId = new Map<string, string>();
const titlesByToolCallId = new Map<string, string>();

function compact(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : fallback;
}

function runIdFromResult(result: any): string | undefined {
  const value = result?.details?.runId ?? result?.details?.run_id ?? result?.structuredContent?.runId;
  return typeof value === "string" && value ? value : undefined;
}

function line(name: string, title: string, extra: string, theme: any, status?: string): string {
  const glyph = status === "failure" ? theme.fg("error", "✗") : status === "loading" ? theme.fg("warning", "…") : status === "success" ? theme.fg("success", "✓") : theme.fg("dim", "•");
  return `${glyph} ${theme.bold(name)} ${AGENT_NAME}${title ? ` ${title}` : ""}${extra}`;
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
        const title = name === "subagent_spawn"
          ? compact(args?.title, "")
          : compact(titlesByRunId.get(args?.runId), "");
        const extra = getExtra(args, context);
        return { render: () => [line(name, title, extra, theme, context?.state?.status)], invalidate() {} };
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        if (remember) remember(context?.args, result, context);
        const failed = context.isError || result?.isError === true;
        context.state.status = failed ? "failure" : options.isPartial ? "loading" : "success";
        context.invalidate();
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
      return renderTool(name, () => "", (args) => {
        const title = titlesByRunId.get(args?.runId);
        if (title && args?.runId) titlesByRunId.set(args.runId, title);
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
