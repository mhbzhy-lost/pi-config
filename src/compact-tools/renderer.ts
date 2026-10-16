import { basename, dirname } from "node:path";
import { homedir } from "node:os";

const TOOL_NAMES = ["read", "bash", "bash_async", "edit", "write", "find", "grep", "ls", "apply_patch"];
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
  return path?.startsWith(home) ? `~${path.slice(home.length)}` : path || ".";
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
  return `${theme.fg("dim", "∗")} ${theme.fg("toolTitle", theme.bold(name))}${detail ? ` ${detail}` : ""}`;
}

function expandedBlock(text, theme, Text, Container, maxLines) {
  const lines = text.split("\n");
  while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
  const container = new Container();
  for (const line of lines.slice(0, maxLines)) {
    container.addChild(new Text(`${theme.fg("dim", "│")} ${theme.fg("toolOutput", line)}`, 1, 0));
  }
  if (lines.length > maxLines) {
    container.addChild(new Text(theme.fg("dim", `│ ... (${lines.length} total lines)`), 1, 0));
  }
  container.addChild(new Text(theme.fg("dim", "└─"), 1, 0));
  return container;
}

// 失败原因组件：先按终端列宽换行，再限制物理行，原始结果始终不变；invalidate 后以当前主题重建。
function failedResult({ Text, truncateToWidth, text, theme }) {
  const errorText = `✗ ${text.trim() || "工具执行失败（未提供错误信息）"}`;
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

function resultRenderer({ Text, Container, truncateToWidth, summary, maxLines = 60 }) {
  return (result, options, theme, context) => {
    const text = textOutput(result);
    const failed = context?.isError === true || result?.isError === true;
    const resultSummary = failed ? "失败" : summary(text);
    if (options.expanded) {
      if (text) return expandedBlock(text, theme, Text, Container, maxLines);
      return new Text(theme.fg("dim", `  └ ${resultSummary}`), 1, 0);
    }
    if (context?.state) context.state[COMPACT_SUMMARY_KEY] = resultSummary;
    if (failed) return failedResult({ Text, truncateToWidth, text, theme });
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
      const status = summarySuffix(theme, context);
      const textBudget = Math.max(0, width - visibleWidth(status));
      return [`${truncateToWidth(text, textBudget, "…")}${status}`];
    },
    invalidate() {},
  });

  const pathCall = (name, path, suffix, theme, context) => ({
    render(width) {
      const prefix = `${title(name, "", theme)} `;
      const status = summarySuffix(theme, context);
      const fixedWidth = visibleWidth(prefix) + visibleWidth(suffix) + visibleWidth(status);
      const pathBudget = Math.max(0, width - fixedWidth);
      const pathWidth = visibleWidth(path);
      let displayedPath = path;
      if (pathWidth > pathBudget) {
        displayedPath = pathBudget <= 1
          ? "…".slice(0, pathBudget)
          : `…${sliceByColumn(path, pathWidth - pathBudget + 1, pathBudget - 1, true)}`;
      }
      const call = `${prefix}${theme.fg("accent", displayedPath)}${suffix}`;
      const callBudget = Math.max(0, width - visibleWidth(status));
      return [`${truncateToWidth(call, callBudget, "…")}${status}`];
    },
    invalidate() {},
  });

  // edit 的既有 compact result 渲染：折叠单行摘要、失败组件与展开文本块全部保留。
  const editCompactResultRenderer = resultRenderer({ Text, Container, truncateToWidth, summary: () => "done", maxLines: 30 });
  // 展开成功非 partial 且 resolver 注入了原生 edit renderResult 时委托原生（原生消费 details.diff 渲染 +/- diff，
  // 不自造 diff/parser/ANSI）；失败、partial、折叠或 native 缺失时保持 compact 语义，错误原因仍由失败组件可见。
  // 委托时浅拷贝 context 并置空 lastComponent：compact 上一帧组件可能是无 clear() 的 Text/普通对象，
  // 而原生会对其调用 component.clear()；不修改调用方 context 对象，也不触碰 raw result/details。
  const editRenderResult = (result, options, theme, context) => {
    const failed = context?.isError === true || result?.isError === true;
    const native = nativeEditRenderers?.current;
    if (
      options?.expanded === true
      && !failed
      && options?.isPartial !== true
      && typeof native?.renderResult === "function"
    ) {
      return native.renderResult(result, options, theme, { ...context, lastComponent: undefined });
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
          if (context?.state) delete context.state[COMPACT_SUMMARY_KEY];
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
        const command = truncate(String(args?.command || "...").replace(/\s+/g, " ").trim(), 70);
        return singleLine(title("bash", theme.fg("accent", `"${command}"`), theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} lines` }),
    },
    // bash_async 专用精简显示：不 alias 同步 bash（其 "1 lines" 摘要既无接受语义又用错标题）。
    bash_async: {
      renderCall(args, theme, context) {
        const command = truncate(String(args?.command || "...").replace(/\s+/g, " ").trim(), 70);
        return singleLine(title("bash_async", theme.fg("accent", `"${command}"`), theme), theme, context);
      },
      renderResult(result, options, theme, context) {
        const text = textOutput(result);
        const failed = context?.isError === true || result?.isError === true;
        // 已接受语义只来自合法 typed receipt：错误以 context.isError 为权威，partial 不提前接受。
        const launch = !failed && options.isPartial !== true && result?.details?.kind === "bash-async-launch"
          ? result.details
          : undefined;
        const shortJob = launch && typeof launch.jobId === "string" && launch.jobId
          ? ` (${launch.jobId.slice(0, 8)})`
          : "";
        const launchSummary = launch ? `已接受，待完成${shortJob}` : undefined;
        if (options.expanded) {
          // 展开态显示完整原文：launch 的完整身份（receipt JSON）仅在此可见；错误保留完整原因。
          if (text) return expandedBlock(text, theme, Text, Container, 60);
          return new Text(theme.fg("dim", `  └ ${failed ? "失败" : launchSummary || "（未识别的回执格式）"}`), 1, 0);
        }
        if (launch) {
          if (context?.state) context.state[COMPACT_SUMMARY_KEY] = launchSummary;
          return new Text("", 0, 0);
        }
        // 失败/未知回执不保留旧摘要，避免“已接受”叠加在失败或未识别状态上。
        if (context?.state) delete context.state[COMPACT_SUMMARY_KEY];
        if (failed) return failedResult({ Text, truncateToWidth, text, theme });
        // 未知格式中性显示原文：不猜接受/成功，也不做 production 执行输出兼容。
        return singleLine(
          theme.fg("dim", text ? truncate(text.replace(/\s+/g, " ").trim(), 100) : "（未识别的回执格式）"),
          theme,
          context,
        );
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
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: () => "done", maxLines: 20 }),
    },
    find: {
      renderCall(args, theme, context) {
        const pattern = args?.pattern || args?.glob || "*";
        const detail = `${theme.fg("accent", `"${pattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        return singleLine(title("find", detail, theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} matches`, maxLines: 40 }),
    },
    grep: {
      renderCall(args, theme, context) {
        const pattern = truncate(args?.pattern || "", 40);
        const detail = `${theme.fg("accent", `"${pattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        return singleLine(title("grep", detail, theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} matches`, maxLines: 40 }),
    },
    ls: {
      renderCall(args, theme, context) {
        return pathCall("ls", shortPath(args?.path), "", theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} entries`, maxLines: 40 }),
    },
    apply_patch: {
      // 折叠/展开都只显示工具名：不显示 patch 参数，也不读共享成功摘要。
      renderCall(_args, theme) {
        const call = title("apply_patch", "", theme);
        return {
          render(width) {
            return [truncateToWidth(call, width, "…")];
          },
          invalidate() {},
        };
      },
      renderResult(result, options, theme, context) {
        const failed = context?.isError === true || result?.isError === true;
        const text = textOutput(result);
        if (failed) {
          // 失败原因优先于文件列表：展开显示完整错误块（60 行上限），折叠显示 ✗ 并限四行；
          // 空成功列表不得掩盖失败原因。
          if (options.expanded) {
            if (text) return expandedBlock(text, theme, Text, Container, 60);
            return new Text(theme.fg("dim", "  └ 失败"), 1, 0);
          }
          return failedResult({ Text, truncateToWidth, text, theme });
        }
        // 成功直接显示完整 A/M/D 文件列表：由权威 details 数组生成，不限条数、不加计数/框线/JSON；
        // details 缺数组时回退 content 原文行；长路径由 Text 按终端列宽自然换行。
        const details = result?.details;
        const entries = [
          ...(Array.isArray(details?.added) ? details.added : []).map((path) => `A ${path}`),
          ...(Array.isArray(details?.modified) ? details.modified : []).map((path) => `M ${path}`),
          ...(Array.isArray(details?.deleted) ? details.deleted : []).map((path) => `D ${path}`),
        ];
        return new Text(entries.length > 0 ? entries.join("\n") : text, 1, 0);
      },
    },
  };

  for (const name of TOOL_NAMES) {
    if (!renderers[name]) throw new Error(`Missing renderer for ${name}`);
    renderers[name].renderShell = "self";
  }
  return renderers;
}
