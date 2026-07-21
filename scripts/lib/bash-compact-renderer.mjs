export function createCompactBashRendering({ Text, keyHint, truncateToWidth, visibleWidth }) {
  class CollapsedBashCall {
    constructor(command, hint, styleCommand) {
      this.command = command;
      this.hint = hint;
      this.styleCommand = styleCommand;
    }

    render(width) {
      const hintWidth = visibleWidth(this.hint);
      if (hintWidth >= width) return [truncateToWidth(this.hint, width, "")];
      const command = truncateToWidth(this.command, width - hintWidth, "...");
      return [this.styleCommand(command) + this.hint];
    }

    invalidate() {}
  }

  return {
    renderCall(args, theme, context) {
      const rawCommand = typeof args?.command === "string" && args.command.trim() ? args.command : "...";
      const timeout = args?.timeout ? ` (timeout ${args.timeout}s)` : "";
      if (context?.expanded) {
        return new Text(theme.fg("toolTitle", theme.bold(`$ ${rawCommand}`)) + theme.fg("muted", timeout), 0, 0);
      }

      const command = `$ ${rawCommand.replace(/\s+/g, " ").trim()}${timeout}`;
      const hint = ` (${keyHint("app.tools.expand", "to expand")})`;
      return new CollapsedBashCall(command, hint, (text) => theme.fg("toolTitle", theme.bold(text)));
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const text = result?.content?.find((item) => item?.type === "text")?.text;
      if (typeof text !== "string" || !text.trim()) return new Text("", 0, 0);
      const output = text.trim().split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
      return new Text(output, 0, 0);
    },
  };
}

export function createCompactBashTool({ createBashTool, initialCwd, rendering }) {
  const cache = new Map();
  const nativeFor = (cwd) => {
    if (!cache.has(cwd)) cache.set(cwd, createBashTool(cwd));
    return cache.get(cwd);
  };
  const initial = nativeFor(initialCwd);

  return {
    name: "bash",
    label: "bash",
    description: initial.description,
    promptSnippet: initial.promptSnippet,
    parameters: initial.parameters,
    prepareArguments: initial.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return nativeFor(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall: rendering.renderCall,
    renderResult: rendering.renderResult,
  };
}
