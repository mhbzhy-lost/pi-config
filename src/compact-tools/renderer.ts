import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { COMPACT_STATUS_KEY, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "./status.ts";
import { createExpandedToolText } from "./expanded-content.ts";

const TOOL_NAMES = ["read", "bash", "bash_async", "edit", "write", "find", "grep", "ls", "tool_search"];
const COMPACT_SKILL_PATCH = Symbol.for("pi-config.compact-skill-renderer");
const COMPACT_SUMMARY_KEY = "compactToolsSummary";

export const sampleArgs = {
  read: { path: "/tmp/file.txt", offset: 2, limit: 3 },
  bash: { command: "printf hello" },
  edit: { path: "/tmp/file.txt", edits: [{ oldText: "a", newText: "b" }] },
  write: { path: "/tmp/file.txt", content: "hello" },
  find: { pattern: "*.ts", path: "/tmp" },
  grep: { pattern: "hello", path: "/tmp" },
  ls: { path: "/tmp" },
};

function shortPath(path) {
  const home = homedir();
  return path === home || path?.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path || ".";
}

function skillName(args) {
  const path = args?.path || args?.file_path;
  return basename(path || "") === "SKILL.md" ? basename(dirname(path)) : undefined;
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function textOutput(result) {
  return result?.content?.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n") || "";
}

function nonEmptyLineCount(text) {
  return text ? text.split("\n").filter((line) => line.trim()).length : 0;
}

function title(name, detail, theme) {
  return `${theme.fg("toolTitle", theme.bold(name))}${detail ? ` ${detail}` : ""}`;
}

function expandedBlock(text, theme, Text, Container) {
  return createExpandedToolText(Text, theme.fg("toolOutput", text));
}

function serializedBlock(block) {
  if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
    const keys = Object.keys(block);
    if (keys.every((key) => key === "type" || key === "text")) return block.text;
    return `${block.text}\ncontentBlock:\n${serializedValue(block)}`;
  }
  const serialized = JSON.stringify(block, null, 2);
  return serialized === undefined ? String(block) : serialized;
}

function serializedValue(value) {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

function fullResultText(result) {
  const content = typeof result?.content === "string"
    ? [result.content]
    : Array.isArray(result?.content) ? result.content.map(serializedBlock) : [];
  const sections = [...content];
  if (result?.details !== undefined) sections.push(`details:\n${serializedValue(result.details)}`);
  // structuredContent is a machine-readable mirror of the human output. The
  // expanded view must show the complete content, not duplicate it as JSON.
  // Keep the raw result untouched for consumers and persistence.
  return sections.join("\n");
}

function setStatus(context, status) {
  if (!context?.state) return;
  context.state[COMPACT_STATUS_KEY] = status;
  syncStatusAnimation(context, status);
}

// 失败原因组件：先按终端列宽换行，再限制物理行，原始结果始终不变；invalidate 后以当前主题重建。
function failedResult({ Text, truncateToWidth, text, theme }) {
  const errorText = text.trim() || "工具执行失败（未提供错误信息）";
  let body = new Text(theme.fg("error", errorText), 1, 0);
  return {
    render(width) {
      const lines = body.render(width);
      return lines.length <= 4 ? lines : [
        ...lines.slice(0, 3),
        truncateToWidth(theme.fg("dim", "… 展开查看完整错误"), width, "…"),
      ];
    },
    invalidate() {
      body = new Text(theme.fg("error", errorText), 1, 0);
    },
  };
}

function resultRenderer({ Text, Container, truncateToWidth, summary }) {
  return (result, options, theme, context) => {
    const text = textOutput(result);
    const failed = context?.isError === true || result?.isError === true;
    const partial = options?.isPartial === true;
    const resultSummary = failed ? "失败" : summary(text);
    if (context?.state) {
      setStatus(context, failed ? "failure" : partial ? "loading" : "success");
      if (failed || partial || options.expanded) delete context.state[COMPACT_SUMMARY_KEY];
    }
    if (options.expanded) {
      const expanded = fullResultText(result);
      if (expanded) return expandedBlock(expanded, theme, Text, Container);
      return new Text(theme.fg("dim", `  └ ${resultSummary}`), 1, 0);
    }
    if (failed) return failedResult({ Text, truncateToWidth, text, theme });
    if (partial) return new Text("", 0, 0);
    if (context?.state) context.state[COMPACT_SUMMARY_KEY] = resultSummary;
    return new Text("", 0, 0);
  };
}

export function installCompactSkillRenderer({ SkillInvocationMessageComponent, Text, Markdown, theme }) {
  const prototype = SkillInvocationMessageComponent.prototype;
  if (prototype[COMPACT_SKILL_PATCH]) return;

  Object.defineProperty(prototype, COMPACT_SKILL_PATCH, { value: true });
  prototype.updateDisplay = function updateCompactSkillDisplay() {
    this.clear();
    this.paddingX = 0;
    this.paddingY = 0;
    this.setBgFn(undefined);

    this.addChild(new Text(title("skill", theme.fg("accent", this.skillBlock.name), theme), 0, 0));
    if (!this.expanded) return;

    const markdown = new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
      color: (text) => theme.fg("toolOutput", text),
    });
    this.addChild({
      render(width) {
        const lines = markdown.render(Math.max(1, width - 2));
        return [
          ...lines.map((line) => `${theme.fg("dim", "│")} ${line}`),
          theme.fg("dim", "└─"),
        ];
      },
      invalidate() {
        markdown.invalidate?.();
      },
    });
  };
}

export function createCompactToolRenderers({ Text, Container, visibleWidth, sliceByColumn, truncateToWidth, nativeEditRenderers = undefined as { current?: import("@earendil-works/pi-coding-agent").ToolRenderers } | undefined }) {
  const summarySuffix = (theme, context) => {
    const summary = !context?.expanded ? context?.state?.[COMPACT_SUMMARY_KEY] : undefined;
    return summary ? theme.fg("dim", ` · ${summary}`) : "";
  };

  const singleLine = (text, theme, context) => ({
    render(width) {
      const status = context?.state?.[COMPACT_STATUS_KEY] as CompactRenderStatus | undefined;
      syncStatusAnimation(context, status);
      const glyph = statusGlyph(theme, status);
      const summary = summarySuffix(theme, context);
      const textBudget = Math.max(0, width - visibleWidth(glyph) - 1 - visibleWidth(summary));
      return [`${glyph} ${truncateToWidth(text, textBudget, "…")}${summary}`];
    },
    invalidate() {},
  });

  // 展开态的 tool call 不能复用折叠态的 truncate 逻辑；Text 负责按终端宽度换行，
  // 但保留完整原始文本，确保长 Bash 命令可被查看。
  const expandedLine = (text, theme, context) => ({
    render(width) {
      const status = context?.state?.[COMPACT_STATUS_KEY] as CompactRenderStatus | undefined;
      syncStatusAnimation(context, status);
      const glyph = statusGlyph(theme, status);
      return new Text(`${glyph} ${text}`, 0, 0).render(width);
    },
    invalidate() {},
  });

  const pathCall = (name, path, suffix, theme, context) => ({
    render(width) {
      const prefix = `${title(name, "", theme)} `;
      const status = context?.state?.[COMPACT_STATUS_KEY] as CompactRenderStatus | undefined;
      syncStatusAnimation(context, status);
      const glyph = statusGlyph(theme, status);
      const summary = summarySuffix(theme, context);
      const fixedWidth = visibleWidth(glyph) + 1 + visibleWidth(prefix) + visibleWidth(suffix) + visibleWidth(summary);
      const pathBudget = Math.max(0, width - fixedWidth);
      const pathWidth = visibleWidth(path);
      let displayedPath = path;
      if (pathWidth > pathBudget) {
        displayedPath = pathBudget <= 1
          ? "…".slice(0, pathBudget)
          : `…${sliceByColumn(path, pathWidth - pathBudget + 1, pathBudget - 1, true)}`;
      }
      const call = `${prefix}${theme.fg("accent", displayedPath)}${suffix}`;
      const callBudget = Math.max(0, width - visibleWidth(summary));
      return [`${glyph} ${truncateToWidth(call, Math.max(0, callBudget - visibleWidth(glyph) - 1), "…")}${summary}`];
    },
    invalidate() {},
  });

  // edit 的既有 compact result 渲染：折叠单行摘要、失败组件与展开文本块全部保留。
  const editCompactResultRenderer = resultRenderer({ Text, Container, truncateToWidth, summary: () => "done" });
  // 展开成功非 partial 且 resolver 注入了原生 edit renderResult 时委托原生（原生消费 details.diff 渲染 +/- diff，
  // 不自造 diff/parser/ANSI）；失败、partial、折叠或 native 缺失时保持 compact 语义，错误原因仍由失败组件可见。
  // 委托时浅拷贝 context 并置空 lastComponent：compact 上一帧组件可能是无 clear() 的 Text/普通对象，
  // 而原生会对其调用 component.clear()；不修改调用方 context 对象，也不触碰 raw result/details。
  const editRenderResult = (result, options, theme, context) => {
    const failed = context?.isError === true || result?.isError === true;
    const partial = options?.isPartial === true;
    const native = nativeEditRenderers?.current;
    setStatus(context, failed ? "failure" : partial ? "loading" : "success");
    if (
      options?.expanded === true
      && !failed
      && !partial
      && typeof native?.renderResult === "function"
    ) {
      const nativeComponent = native.renderResult(result, options, theme, { ...context, lastComponent: undefined });
       const raw = fullResultText(result);
      if (!raw) return nativeComponent;
      const container = new Container();
      if (nativeComponent) container.addChild(nativeComponent);
      container.addChild(expandedBlock(raw, theme, Text, Container));
      return container;
    }
    return editCompactResultRenderer(result, options, theme, context);
  };

  const renderers = {
    read: {
      renderCall(args, theme, context) {
        const loadedSkill = !context?.expanded && skillName(args);
        if (loadedSkill) return singleLine(title("skill", theme.fg("accent", loadedSkill), theme), theme, context);

        const start = args?.offset;
        const end = args?.limit ? (start || 1) + args.limit - 1 : undefined;
        const range = start || end ? theme.fg("warning", `:${start || 1}${end ? `-${end}` : ""}`) : "";
        return pathCall("read", shortPath(args?.path || args?.file_path), range, theme, context);
      },
      renderResult(result, options, theme, context) {
        if (!options.expanded && skillName(context?.args) && context?.isError !== true && result?.isError !== true) {
          if (context?.state) {
            setStatus(context, options.isPartial === true ? "loading" : "success");
            delete context.state[COMPACT_SUMMARY_KEY];
          }
          return new Text("", 0, 0);
        }
           return resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} lines` })(
          result,
          options,
          theme,
          context,
        );
      },
    },
    bash: {
      renderCall(args, theme, context) {
        const rawCommand = String(args?.command || "...");
        if (context?.expanded) {
          return expandedLine(title("bash", theme.fg("accent", `"${rawCommand}"`), theme), theme, context);
        }
        const command = truncate(rawCommand.replace(/\s+/g, " ").trim(), 70);
        return singleLine(title("bash", theme.fg("accent", `"${command}"`), theme), theme, context);
      },
       renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} lines` }),
    },
    // bash_async 专用精简显示：不 alias 同步 bash（其 "1 lines" 摘要既无接受语义又用错标题）。
    bash_async: {
      renderCall(args, theme, context) {
        const rawCommand = String(args?.command || "...");
        if (context?.expanded) {
          return expandedLine(title("bash_async", theme.fg("accent", `"${rawCommand}"`), theme), theme, context);
        }
        const command = truncate(rawCommand.replace(/\s+/g, " ").trim(), 70);
        return singleLine(title("bash_async", theme.fg("accent", `"${command}"`), theme), theme, context);
      },
      renderResult(result, options, theme, context) {
        const text = textOutput(result);
        const failed = context?.isError === true || result?.isError === true;
        const partial = options.isPartial === true;
        // 已接受语义只来自合法 typed receipt：错误以 context.isError 为权威，partial 不提前接受。
        const launch = !failed && !partial && result?.details?.kind === "bash-async-launch"
          ? result.details
          : undefined;
        const shortJob = launch && typeof launch.jobId === "string" && launch.jobId
          ? ` (${launch.jobId.slice(0, 8)})`
          : "";
        const launchSummary = launch ? `已接受，待完成${shortJob}` : undefined;
        if (options.expanded) {
          // launch 回执即终态 success：loading 只覆盖「动作发出→任务开始执行」的实际执行窗口，
          // 接受后不再动画，避免永久 spinner 定时器泄漏。
          setStatus(context, failed || (!launch && !partial) ? "failure" : launch ? "success" : "loading");
          const expanded = fullResultText(result);
          if (expanded) return expandedBlock(expanded, theme, Text, Container);
          return new Text(theme.fg("dim", `  └ ${failed ? "失败" : launchSummary || "（未识别的回执格式）"}`), 1, 0);
        }
        if (launch) {
          if (context?.state) {
            // 发出即成功：launch 回执是终态，「已接受，待完成」仅作信息摘要，不起永久 loading 动画。
            setStatus(context, "success");
            context.state[COMPACT_SUMMARY_KEY] = launchSummary;
          }
          return new Text("", 0, 0);
        }
        // 失败/未知回执不保留旧摘要，避免“已接受”叠加在失败或未识别状态上。
        setStatus(context, failed || !partial ? "failure" : "loading");
        if (context?.state) delete context.state[COMPACT_SUMMARY_KEY];
        if (failed) return failedResult({ Text, truncateToWidth, text, theme });
        // 未知格式中性显示原文：不猜接受/成功，也不做 production 执行输出兼容。
        const unknownText = text ? truncate(text.replace(/\s+/g, " ").trim(), 100) : "（未识别的回执格式）";
        return new Text(theme.fg("dim", unknownText), 1, 0);
      },
    },
    edit: {
      renderCall(args, theme, context) {
        const count = Array.isArray(args?.edits) ? args.edits.length : 1;
        return pathCall(
          "edit",
          shortPath(args?.path || args?.file_path),
          ` ${theme.fg("dim", `(${count} edit${count === 1 ? "" : "s"})`)}`,
          theme,
          context,
        );
      },
      renderResult: editRenderResult,
    },
    write: {
      renderCall(args, theme, context) {
        return pathCall("write", shortPath(args?.path || args?.file_path), "", theme, context);
      },
       renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: () => "done" }),
    },
    find: {
      renderCall(args, theme, context) {
        const pattern = args?.pattern || args?.glob || "*";
        const detail = `${theme.fg("accent", `"${pattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        return singleLine(title("find", detail, theme), theme, context);
      },
       renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} matches` }),
    },
    grep: {
      renderCall(args, theme, context) {
        const rawPattern = String(args?.pattern || "");
        const pattern = context?.expanded ? rawPattern : truncate(rawPattern, 40);
        const detail = `${theme.fg("accent", `"${pattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        if (context?.expanded) return expandedLine(title("grep", detail, theme), theme, context);
        return singleLine(title("grep", detail, theme), theme, context);
      },
       renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} matches` }),
    },
    ls: {
      renderCall(args, theme, context) {
        return pathCall("ls", shortPath(args?.path), "", theme, context);
      },
       renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} entries` }),
    },
    tool_search: {
      renderCall(args, theme, context) {
        const query = truncate(String(args?.query || ""), 100);
        return singleLine(title("tool_search", theme.fg("accent", query), theme), theme, context);
      },
       renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: () => "done" }),
    },
  };

  for (const name of TOOL_NAMES) {
    if (!renderers[name]) throw new Error(`Missing renderer for ${name}`);
    renderers[name].renderShell = "self";
  }
  return renderers;
}
