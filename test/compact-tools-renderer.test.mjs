import assert from "node:assert/strict";
import test from "node:test";

const rendererModule = await import("../scripts/lib/compact-tools-renderer.mjs").catch(() => undefined);

class FakeText {
  constructor(text = "") {
    this.text = text;
  }
  render() {
    return this.text.split("\n");
  }
  invalidate() {}
}

class FakeContainer {
  constructor() {
    this.children = [];
  }
  addChild(child) {
    this.children.push(child);
  }
  render(width) {
    return this.children.flatMap((child) => child.render(width));
  }
  invalidate() {}
}

class FakeMarkdown extends FakeText {}

class FakeSkillInvocationMessageComponent {
  constructor(skillBlock) {
    this.children = [];
    this.paddingX = 1;
    this.paddingY = 1;
    this.bgFn = (text) => `<bg>${text}</bg>`;
    this.expanded = false;
    this.skillBlock = skillBlock;
    this.markdownTheme = {};
    this.updateDisplay();
  }
  addChild(child) {
    this.children.push(child);
  }
  clear() {
    this.children = [];
  }
  setBgFn(bgFn) {
    this.bgFn = bgFn;
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    this.updateDisplay();
  }
  updateDisplay() {
    this.clear();
    this.addChild(new FakeText(`[skill] ${this.skillBlock.name}`));
  }
  render(width) {
    const lines = this.children.flatMap((child) => child.render(width));
    const padded = [
      ...Array(this.paddingY).fill(""),
      ...lines.map((line) => `${" ".repeat(this.paddingX)}${line}`),
      ...Array(this.paddingY).fill(""),
    ];
    return this.bgFn ? padded.map((line) => this.bgFn(line)) : padded;
  }
}

const plainVisibleWidth = (text) => text.length;
const plainSliceByColumn = (text, start, length) => text.slice(start, start + length);
const plainTruncateToWidth = (text, width, ellipsis = "...") => {
  if (text.length <= width) return text;
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
};

function setup() {
  assert.ok(rendererModule, "compact tools renderer module should exist");
  return rendererModule.createCompactToolRenderers({
    Text: FakeText,
    Container: FakeContainer,
    visibleWidth: plainVisibleWidth,
    sliceByColumn: plainSliceByColumn,
    truncateToWidth: plainTruncateToWidth,
  });
}

const styles = [];
const theme = {
  bold(text) {
    styles.push(["bold", text]);
    return `<b>${text}</b>`;
  },
  fg(color, text) {
    styles.push(["fg", color, text]);
    return `<${color}>${text}</${color}>`;
  },
};

const result = { content: [{ type: "text", text: "first line\nsecond line" }] };

for (const name of ["read", "bash", "edit", "write", "find", "grep", "ls"]) {
  test(`${name} renders its tool name with the native bold tool-title style`, () => {
    styles.length = 0;
    const renderers = setup();
    renderers[name].renderCall(rendererModule.sampleArgs[name], theme).render(120);

    assert.ok(styles.some((entry) => entry[0] === "bold" && entry[1] === name));
    assert.ok(styles.some((entry) => entry[0] === "fg" && entry[1] === "toolTitle" && entry[2] === `<b>${name}</b>`));
  });
}

test("collapsed SKILL.md reads render as skill loads and expand back to read output", () => {
  const renderers = setup();
  const plainTheme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };
  const args = { path: "/tmp/test-driven-development/SKILL.md" };
  const collapsedCall = renderers.read.renderCall(args, plainTheme, { expanded: false });
  const collapsedResult = renderers.read.renderResult(result, { expanded: false }, plainTheme, { args });

  assert.deepEqual(collapsedCall.render(120), ["∗ skill test-driven-development"]);
  assert.deepEqual(collapsedResult.render(120), [""]);

  const expandedCall = renderers.read.renderCall(args, plainTheme, { expanded: true });
  const expandedResult = renderers.read.renderResult(result, { expanded: true }, plainTheme, { args });
  assert.match(expandedCall.render(120)[0], /^∗ read .*\/SKILL\.md$/);
  assert.deepEqual(expandedResult.render(120), [
    "│ first line",
    "│ second line",
    "└─",
  ]);
});

test("skill invocations use the compact tool shell in collapsed and expanded modes", () => {
  assert.equal(
    typeof rendererModule.installCompactSkillRenderer,
    "function",
    "compact skill renderer installer should exist",
  );
  rendererModule.installCompactSkillRenderer({
    SkillInvocationMessageComponent: FakeSkillInvocationMessageComponent,
    Text: FakeText,
    Markdown: FakeMarkdown,
    theme: {
      bold: (text) => text,
      fg: (_color, text) => text,
    },
  });
  const component = new FakeSkillInvocationMessageComponent({
    name: "test-driven-development",
    content: "first line\nsecond line",
  });

  assert.deepEqual(component.render(120), ["∗ skill test-driven-development"]);

  component.setExpanded(true);
  assert.deepEqual(component.render(120), [
    "∗ skill test-driven-development",
    "│ first line",
    "│ second line",
    "└─",
  ]);
});

test("narrow path calls stay on one line and preserve the file name", () => {
  const renderers = setup();
  const plainTheme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };
  const call = renderers.write.renderCall({
    path: "/tmp/account-pool-fork-baseline-migration/.agent-state/goal-contract/goals/sub2api/recovery.md",
  }, plainTheme);

  const lines = call.render(40);

  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 40, JSON.stringify(lines));
  assert.match(lines[0], /^∗ write …/);
  assert.match(lines[0], /recovery\.md$/);
});

for (const [name, expectedStatus] of Object.entries({
  read: "2 lines",
  bash: "2 lines",
  edit: "done",
  write: "done",
  find: "2 matches",
  grep: "2 matches",
  ls: "2 entries",
})) {
  test(`${name} keeps its collapsed call and result status on one line`, () => {
    const renderers = setup();
    const plainTheme = {
      bold: (text) => text,
      fg: (_color, text) => text,
    };
    const state = {};
    const args = rendererModule.sampleArgs[name];
    const call = renderers[name].renderCall(args, plainTheme, { expanded: false, state });
    const output = renderers[name].renderResult(result, { expanded: false }, plainTheme, { args, state });
    const lines = [...call.render(120), ...output.render(120)].filter((line) => line.trim());

    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], new RegExp(` · ${expectedStatus}$`));
  });
}

test("expanded output is bounded and never falls through to an undefined component", () => {
  const renderers = setup();
  const component = renderers.edit.renderResult(result, { expanded: true }, theme);

  assert.ok(component);
  assert.deepEqual(component.render(120), [
    "<dim>│</dim> <toolOutput>first line</toolOutput>",
    "<dim>│</dim> <toolOutput>second line</toolOutput>",
    "<dim>└─</dim>",
  ]);
});

test("expanded output removes trailing empty lines without removing internal empty lines", () => {
  const renderers = setup();
  const trailingNewlineResult = {
    content: [{ type: "text", text: "first line\n\nthird line\n" }],
  };

  const lines = renderers.bash.renderResult(trailingNewlineResult, { expanded: true }, theme).render(120);

  assert.deepEqual(lines, [
    "<dim>│</dim> <toolOutput>first line</toolOutput>",
    "<dim>│</dim> <toolOutput></toolOutput>",
    "<dim>│</dim> <toolOutput>third line</toolOutput>",
    "<dim>└─</dim>",
  ]);
});
