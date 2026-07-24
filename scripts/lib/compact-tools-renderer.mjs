import { basename, dirname } from "node:path";
import { homedir } from "node:os";

const TOOL_NAMES = ["read", "bash", "edit", "write", "find", "grep", "ls"];
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

function resultRenderer({ Text, Container, summary, maxLines = 60 }) {
  return (result, options, theme, context) => {
    const text = textOutput(result);
    const resultSummary = summary(text);
    if (options.expanded) {
      if (text) return expandedBlock(text, theme, Text, Container, maxLines);
      return new Text(theme.fg("dim", `  └ ${resultSummary}`), 1, 0);
    }
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

export function createCompactToolRenderers({ Text, Container, visibleWidth, sliceByColumn, truncateToWidth }) {
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
        if (!options.expanded && skillName(context?.args)) return new Text("", 0, 0);
        return resultRenderer({ Text, Container, summary: (text) => `${nonEmptyLineCount(text)} lines` })(
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
      renderResult: resultRenderer({ Text, Container, summary: (text) => `${nonEmptyLineCount(text)} lines` }),
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
      renderResult: resultRenderer({ Text, Container, summary: () => "done", maxLines: 30 }),
    },
    write: {
      renderCall(args, theme, context) {
        return pathCall("write", shortPath(args?.path || args?.file_path), "", theme, context);
      },
      renderResult: resultRenderer({ Text, Container, summary: () => "done", maxLines: 20 }),
    },
    find: {
      renderCall(args, theme, context) {
        const pattern = args?.pattern || args?.glob || "*";
        const detail = `${theme.fg("accent", `"${pattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        return singleLine(title("find", detail, theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, summary: (text) => `${nonEmptyLineCount(text)} matches`, maxLines: 40 }),
    },
    grep: {
      renderCall(args, theme, context) {
        const pattern = truncate(args?.pattern || "", 40);
        const detail = `${theme.fg("accent", `"${pattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        return singleLine(title("grep", detail, theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, summary: (text) => `${nonEmptyLineCount(text)} matches`, maxLines: 40 }),
    },
    ls: {
      renderCall(args, theme, context) {
        return pathCall("ls", shortPath(args?.path), "", theme, context);
      },
      renderResult: resultRenderer({ Text, Container, summary: (text) => `${nonEmptyLineCount(text)} entries`, maxLines: 40 }),
    },
  };

  for (const name of TOOL_NAMES) {
    if (!renderers[name]) throw new Error(`Missing renderer for ${name}`);
  }
  return renderers;
}
