import assert from "node:assert/strict";
import test from "node:test";

const rendererModule = await import("../scripts/lib/bash-compact-renderer.mjs").catch(() => undefined);

class FakeText {
  constructor(text = "") {
    this.text = text;
  }
  setText(text) {
    this.text = text;
  }
  render(width) {
    return this.text.split("\n").flatMap((line) => {
      if (!line) return [""];
      const chunks = [];
      for (let i = 0; i < line.length; i += width) chunks.push(line.slice(i, i + width));
      return chunks;
    });
  }
  invalidate() {}
}

function setupRendering() {
  assert.ok(rendererModule, "bash compact renderer module should exist");
  return rendererModule.createCompactBashRendering({
    Text: FakeText,
    keyHint: (_id, description) => `ctrl+o ${description}`,
    truncateToWidth: (text, width, ellipsis = "...") =>
      text.length <= width ? text : text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis,
    visibleWidth: (text) => text.replace(/\x1b\[[0-9;]*m/g, "").length,
  });
}

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

const result = {
  content: [{ type: "text", text: "first line\nsecond line\nthird line" }],
  details: undefined,
};

test("collapsed bash rendering occupies exactly one visual line", () => {
  const rendering = setupRendering();
  const call = rendering.renderCall(
    { command: "printf 'a very long command that must not wrap across terminal rows'" },
    theme,
    { lastComponent: undefined },
  );
  const output = rendering.renderResult(result, { expanded: false, isPartial: false }, theme, {
    lastComponent: undefined,
  });

  const lines = [...call.render(32), ...output.render(32)].filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 32);
  assert.match(lines[0], /ctrl\+o to expand/);
});

test("collapsed ellipsis remains inside the command ANSI style", () => {
  const rendering = setupRendering();
  const ansiTheme = {
    bold: (text) => text,
    fg: (_color, text) => `\x1b[31m${text}\x1b[39m`,
  };
  const call = rendering.renderCall(
    { command: "printf a-command-long-enough-to-truncate" },
    ansiTheme,
    { expanded: false },
  );

  const line = call.render(32)[0];
  assert.ok(line.indexOf("...") < line.indexOf("\x1b[39m"), "ellipsis should be styled before ANSI foreground closes");
  assert.doesNotMatch(line, /\x1b\[0m\.\.\./, "ellipsis must not follow a full ANSI reset");
});

test("expanded bash rendering shows complete command and output without renderer ellipsis", () => {
  const rendering = setupRendering();
  const command = "printf a-very-long-command-that-wraps-in-expanded-mode";
  const call = rendering.renderCall({ command }, theme, { expanded: true });
  const output = rendering.renderResult(result, { expanded: true, isPartial: false }, theme, {
    lastComponent: undefined,
  });

  assert.equal(call.render(24).join(""), `$ ${command}`);
  assert.doesNotMatch(call.render(24).join(""), /\.\.\./);
  assert.deepEqual(output.render(80), ["first line", "second line", "third line"]);
});

test("bash override delegates execution to the native tool for the context cwd", async () => {
  assert.ok(rendererModule, "bash compact renderer module should exist");
  const calls = [];
  const nativeTools = new Map();
  const createBashTool = (cwd) => {
    const tool = {
      parameters: { type: "object" },
      async execute(...args) {
        calls.push({ cwd, args });
        return { content: [{ type: "text", text: "native" }] };
      },
    };
    nativeTools.set(cwd, tool);
    return tool;
  };
  const rendering = setupRendering();
  const tool = rendererModule.createCompactBashTool({
    createBashTool,
    initialCwd: "/initial",
    rendering,
  });

  const execution = await tool.execute("call-1", { command: "pwd" }, undefined, undefined, { cwd: "/work" });

  assert.equal(execution.content[0].text, "native");
  assert.equal(calls[0].cwd, "/work");
  assert.deepEqual(tool.parameters, nativeTools.get("/initial").parameters);
});
