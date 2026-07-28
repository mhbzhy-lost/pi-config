import { basename, dirname } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  SkillInvocationMessageComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, sliceByColumn, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createCompactToolRenderers } from "../../scripts/lib/compact-tools-renderer.mjs";

const COMPACT_SKILL_PATCH = Symbol.for("pi-config.compact-skill-renderer");
const COMPACT_SUMMARY_KEY = "compactToolsEntrySummary";

function textOutput(result: any): string {
  return result?.content?.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("\n") || "";
}

function nonEmptyLineCount(text: string): number {
  return text ? text.split("\n").filter((line) => line.trim()).length : 0;
}

function compactSummary(name: ToolName, result: any): string {
  const text = textOutput(result);
  if (name === "edit" || name === "write") return "done";
  if (name === "find" || name === "grep") return `${nonEmptyLineCount(text)} matches`;
  if (name === "ls") return `${nonEmptyLineCount(text)} entries`;
  return `${nonEmptyLineCount(text)} lines`;
}

function skillName(args: any): string | undefined {
  const path = args?.path || args?.file_path;
  return basename(path || "") === "SKILL.md" ? basename(dirname(path)) : undefined;
}

function installCompactReadSkillRenderer(readRenderer: any) {
  const renderCall = readRenderer.renderCall;
  const renderResult = readRenderer.renderResult;

  readRenderer.renderCall = (args: any, theme: any, context: any) => {
    const loadedSkill = !context?.expanded && skillName(args);
    if (!loadedSkill) return renderCall(args, theme, context);

    const marker = theme.fg("dim", "∗");
    const name = theme.fg("toolTitle", theme.bold("skill"));
    const detail = theme.fg("accent", loadedSkill);
    const text = `${marker} ${name} ${detail}`;
    return {
      render(width: number) {
        return [truncateToWidth(text, width, "…")];
      },
      invalidate() {},
    };
  };

  readRenderer.renderResult = (result: any, options: any, theme: any, context: any) => {
    if (!options.expanded && skillName(context?.args)) return new Text("", 0, 0);
    return renderResult(result, options, theme, context);
  };
}

export function collapseCollapsedCallLines(
  lines: string[],
  width: number,
  status: string,
  measureWidth = visibleWidth,
  truncate = truncateToWidth,
): string[] {
  const callWidth = Math.max(0, width - measureWidth(status));
  if (lines.length === 0) return status ? [truncate(status, width, "…")] : [];
  return [`${truncate(lines[0], callWidth, "…")}${status}`];
}

function installCollapsedSingleLineRenderer(name: ToolName, renderer: any) {
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
        const lines = component.render(callWidth);
        return collapseCollapsedCallLines(lines, width, status);
      },
      invalidate() {
        component.invalidate?.();
      },
    };
  };

  renderer.renderResult = (result: any, options: any, theme: any, context: any) => {
    if (options.expanded) return renderResult(result, options, theme, context);
    if (!(name === "read" && skillName(context?.args)) && context?.state) {
      context.state[COMPACT_SUMMARY_KEY] = compactSummary(name, result);
    }
    return new Text("", 0, 0);
  };
}

function installCompactSkillRenderer(theme: any) {
  const prototype = SkillInvocationMessageComponent.prototype as any;
  if (prototype[COMPACT_SKILL_PATCH]) return;

  Object.defineProperty(prototype, COMPACT_SKILL_PATCH, { value: true });
  prototype.updateDisplay = function updateCompactSkillDisplay(this: any) {
    this.clear();
    this.paddingX = 0;
    this.paddingY = 0;
    this.setBgFn(undefined);

    const marker = theme.fg("dim", "∗");
    const name = theme.fg("toolTitle", theme.bold("skill"));
    const detail = theme.fg("accent", this.skillBlock.name);
    this.addChild(new Text(`${marker} ${name} ${detail}`, 0, 0));
    if (!this.expanded) return;

    const markdown = new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
      color: (text: string) => theme.fg("toolOutput", text),
    });
    this.addChild({
      render(width: number) {
        const lines = markdown.render(Math.max(1, width - 2));
        return [
          ...lines.map((line: string) => `${theme.fg("dim", "│")} ${line}`),
          theme.fg("dim", "└─"),
        ];
      },
      invalidate() {
        markdown.invalidate?.();
      },
    });
  };
}

const factories = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  find: createFindTool,
  grep: createGrepTool,
  ls: createLsTool,
} as const;

type ToolName = keyof typeof factories;

const cache = new Map<string, Record<ToolName, any>>();

function nativeTools(cwd: string): Record<ToolName, any> {
  let tools = cache.get(cwd);
  if (!tools) {
    tools = Object.fromEntries(
      Object.entries(factories).map(([name, factory]) => [name, factory(cwd)]),
    ) as Record<ToolName, any>;
    cache.set(cwd, tools);
  }
  return tools;
}

export default function compactTools(pi: ExtensionAPI) {
  const initialTools = nativeTools(process.cwd());
  const renderers = createCompactToolRenderers({
    Text,
    Container,
    visibleWidth,
    sliceByColumn,
    truncateToWidth,
  });
  installCompactReadSkillRenderer(renderers.read);
  for (const name of Object.keys(renderers) as ToolName[]) {
    installCollapsedSingleLineRenderer(name, renderers[name]);
  }

  pi.on("session_start", (_event, ctx) => {
    installCompactSkillRenderer(ctx.ui.theme);
  });

  for (const name of Object.keys(factories) as ToolName[]) {
    const native = initialTools[name];
    const rendering = renderers[name];

    pi.registerTool({
      name,
      label: native.label || name,
      description: native.description,
      promptSnippet: native.promptSnippet,
      parameters: native.parameters,
      prepareArguments: native.prepareArguments,
      renderShell: "self",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return nativeTools(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate);
      },
      renderCall: rendering.renderCall,
      renderResult: rendering.renderResult,
    } as any);
  }
}
