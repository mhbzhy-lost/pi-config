import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import upstreamTodoExtension from "../npm/node_modules/@juicesharp/rpiv-todo/index.js";

export const TODO_CALL_PREFIX = "∗ ";
export const TODO_RESULT_PREFIX = "  └ ";

const TODO_COMPACT_STATUS_KEY = "todoCompactStatus";

const COMPACT_ACTION_LABELS: Record<string, string> = {
  create: "+",
  update: "→",
  delete: "×",
  get: "›",
  list: "list",
  clear: "clear",
};

const COMPACT_STATUS_LABELS: Record<string, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "completed",
  deleted: "deleted",
};

const STATUS_GLYPHS: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  deleted: "⊘",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "dim",
  in_progress: "warning",
  completed: "success",
  deleted: "muted",
};

export function formatCompactAction(action: string): string {
  return COMPACT_ACTION_LABELS[action] || action;
}

export function formatCompactResultSummary(details: any, contentText: string): string {
  const params = details?.params || {};
  const tasks = Array.isArray(details?.tasks) ? details.tasks : [];

  if (details?.action === "list") {
    const visible = tasks.filter(
      (task: any) => task.status !== "deleted" && (!params.status || task.status === params.status),
    );
    const status = params.status ? `${COMPACT_STATUS_LABELS[params.status] || params.status} ` : "";
    return `${visible.length} ${status}task${visible.length === 1 ? "" : "s"}`;
  }

  if (details?.action === "get") {
    const task = tasks.find((item: any) => item.id === params.id);
    if (task) return `${COMPACT_STATUS_LABELS[task.status] || task.status} · ${task.subject}`;
  }

  return String(contentText || "").split("\n")[0] || "done";
}

function textOutput(result: any): string {
  return result?.content
    ?.filter((item: any) => item?.type === "text")
    .map((item: any) => item.text || "")
    .join("\n") || "";
}

function resultStatus(details: any): string | undefined {
  if (!details) return undefined;
  const params = details.params || {};

  switch (details.action) {
    case "create":
      return details.tasks?.[details.tasks.length - 1]?.status;
    case "update":
      return params.status ?? details.tasks?.find((task: any) => task.id === params.id)?.status;
    case "delete":
      return details.tasks?.find((task: any) => task.id === params.id)?.status;
    default:
      return undefined;
  }
}

function readableActionLine(lines: string[], action: string): string[] {
  if (action === "list") return lines.map((line) => line.replace("☰", "list"));
  if (action === "clear") return lines.map((line) => line.replace("∅", "clear"));
  return lines;
}

function singleLine(text: string): Component {
  return {
    render(width: number): string[] {
      return [truncateToWidth(text, width, "…")];
    },
    invalidate() {},
  };
}

export function createCompactTodoDefinition(upstream: any): any {
  if (typeof upstream?.renderCall !== "function") {
    throw new Error("rpiv-todo no longer exposes renderCall");
  }

  return {
    ...upstream,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any): Component {
      const component = upstream.renderCall(args, theme, context);

      return {
        render(width: number): string[] {
          const marker = theme.fg("dim", TODO_CALL_PREFIX);
          const status = context?.state?.[TODO_COMPACT_STATUS_KEY];
          const suffix = typeof status === "string" ? theme.fg("dim", " · ") + status : "";
          const bodyWidth = Math.max(0, width - visibleWidth(marker) - visibleWidth(suffix));
          const lines = readableActionLine(component.render(bodyWidth), args.action);
          const body = (lines[0] || theme.fg("toolTitle", theme.bold(`todo ${formatCompactAction(args.action)}`))).trimEnd();
          return [`${marker}${truncateToWidth(body, bodyWidth, "…")}${suffix}`];
        },
        invalidate() {
          component.invalidate?.();
        },
      };
    },
    renderResult(result: any, options: any, theme: any, context: any): Component {
      const details = result?.details;
      const status = resultStatus(details);
      const renderedStatus = status
        ? theme.fg(STATUS_COLORS[status] || "dim", `${STATUS_GLYPHS[status] || status} ${COMPACT_STATUS_LABELS[status] || status}`)
        : theme.fg(details?.error ? "error" : "dim", formatCompactResultSummary(details, textOutput(result)));

      if (!options?.expanded) {
        if (context?.state) context.state[TODO_COMPACT_STATUS_KEY] = renderedStatus;
        return new Text("", 0, 0);
      }

      return singleLine(theme.fg("dim", TODO_RESULT_PREFIX) + renderedStatus);
    },
  };
}

function withCompactTodoTool(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (definition: any) => {
          target.registerTool(
            definition?.name === "todo" ? createCompactTodoDefinition(definition) : definition,
          );
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function todoCompactRenderer(pi: ExtensionAPI): void {
  upstreamTodoExtension(withCompactTodoTool(pi));
}
