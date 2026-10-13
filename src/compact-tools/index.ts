import { basename, dirname } from "node:path";
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createCompactToolRenderers } from "./renderer.ts";

export { createCompactToolRenderers, installCompactSkillRenderer } from "./renderer.ts";

const COMPACT_SUMMARY_KEY = "compactToolsEntrySummary";
const SHARED_COMPACT_SUMMARY_KEY = "compactToolsSummary";
type Dependencies = Parameters<typeof createCompactToolRenderers>[0];
type ToolName = "read" | "edit" | "write" | "find" | "grep" | "ls";

function skillName(args: any): string | undefined {
  const path = args?.path || args?.file_path;
  return basename(path || "") === "SKILL.md" ? basename(dirname(path)) : undefined;
}

function compactSummary(name: ToolName, result: any): string {
  const text = result?.content?.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("\n") || "";
  const count = text ? text.split("\n").filter((line: string) => line.trim()).length : 0;
  if (name === "edit" || name === "write") return "done";
  if (name === "find" || name === "grep") return `${count} matches`;
  if (name === "ls") return `${count} entries`;
  return `${count} lines`;
}

export function collapseCollapsedCallLines(
  lines: string[],
  width: number,
  status: string,
  measureWidth: (text: string) => number,
  truncate: (text: string, width: number, ellipsis?: string) => string,
): string[] {
  const callWidth = Math.max(0, width - measureWidth(status));
  if (lines.length === 0) return status ? [truncate(status, width, "…")] : [];
  return [`${truncate(lines[0], callWidth, "…")}${status}`];
}

function installCollapsedSingleLineRenderer(name: ToolName, renderer: any, { Text, visibleWidth, truncateToWidth }: Dependencies) {
  const renderCall = renderer.renderCall;
  const renderResult = renderer.renderResult;

  renderer.renderCall = (args: any, theme: any, context: any) => {
    const component = renderCall(args, theme, context);
    if (context?.expanded) return component;
    return {
      render(width: number) {
        const summary = context?.state?.[COMPACT_SUMMARY_KEY];
        const status = summary ? theme.fg("dim", ` · ${summary}`) : "";
        const callWidth = Math.max(0, width - visibleWidth(status));
        return collapseCollapsedCallLines(component.render(callWidth), width, status, visibleWidth, truncateToWidth);
      },
      invalidate() { component.invalidate?.(); },
    };
  };

  renderer.renderResult = (result: any, options: any, theme: any, context: any) => {
    const failed = context?.isError === true || result?.isError === true;
    if (failed) {
      if (context?.state) {
        delete context.state[COMPACT_SUMMARY_KEY];
        delete context.state[SHARED_COMPACT_SUMMARY_KEY];
      }
      const output = renderResult(result, options, theme, context);
      // 外层消费共享错误组件后清理摘要，避免错误状态叠加旧成功摘要。
      if (context?.state) delete context.state[SHARED_COMPACT_SUMMARY_KEY];
      return output;
    }
    if (options.expanded) return renderResult(result, options, theme, context);
    if (!(name === "read" && skillName(context?.args)) && context?.state) {
      context.state[COMPACT_SUMMARY_KEY] = compactSummary(name, result);
    } else if (context?.state) {
      delete context.state[COMPACT_SUMMARY_KEY];
      delete context.state[SHARED_COMPACT_SUMMARY_KEY];
    }
    return new Text("", 0, 0);
  };
}

/**
 * 拥有 read/bash/edit/write/find/grep/ls/apply_patch 的显示字段，不注册、执行或激活工具。
 * apply_patch 不进入单行折叠：折叠与展开都显示工具名和完整 A/M/D 文件列表，失败原因单独可见。
 * Host 按注册顺序解析 next 链；前置 resolver 不调用 next 即可截断本 owner，非 last-wins。
 */
export function createCompactToolRendererResolver(dependencies: Dependencies): ToolRendererResolver {
  const renderers = createCompactToolRenderers(dependencies);
  for (const name of ["read", "edit", "write", "find", "grep", "ls"] as const) {
    installCollapsedSingleLineRenderer(name, renderers[name], dependencies);
  }
  const owned = new Map<string, ToolRenderers>(Object.entries(renderers));
  return (name, next) => {
    const mine = owned.get(name);
    if (!mine) return next();
    const base = next();
    // 有意覆盖本 owner 的显示字段，保留 base 其余字段；空 next 同样合法。
    return { ...(base ?? {}), ...mine };
  };
}
