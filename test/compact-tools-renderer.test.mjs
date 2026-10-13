import assert from "node:assert/strict";
import test from "node:test";

const rendererModule = await import("../src/compact-tools/renderer.ts").catch(() => undefined);

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

test("shared compact tool renderers use the self shell", () => {
  const renderers = setup();

  for (const name of ["read", "bash", "bash_async", "edit", "write", "find", "grep", "ls", "apply_patch"]) {
    assert.equal(renderers[name].renderShell, "self");
  }
});

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

for (const name of ["read", "bash", "bash_async", "edit", "write", "find", "grep", "ls", "apply_patch"]) {
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
  const installed = FakeSkillInvocationMessageComponent.prototype.updateDisplay;
  rendererModule.installCompactSkillRenderer({
    SkillInvocationMessageComponent: FakeSkillInvocationMessageComponent,
    Text: FakeText,
    Markdown: FakeMarkdown,
    theme: { bold: () => "不应替换", fg: () => "不应替换" },
  });
  assert.equal(FakeSkillInvocationMessageComponent.prototype.updateDisplay, installed);
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
    path: "/tmp/account-pool-fork-baseline-migration/.agent-state/contracts/tasks/sub2api/recovery.md",
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

test("错误转为成功skill读取时清理旧失败摘要", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const args = { path: "/tmp/test-driven-development/SKILL.md" };
  const context = { args, state: {}, isError: true, expanded: false };
  const failure = { content: [{ type: "text", text: "permission denied" }], details: undefined };
  const failed = renderers.read.renderResult(failure, { expanded: false }, plainTheme, context);
  assert.match(failed.render(100).join("\n"), /✗ permission denied/);
  context.isError = false;
  renderers.read.renderResult(result, { expanded: false }, plainTheme, context);
  assert.deepEqual(renderers.read.renderCall(args, plainTheme, context).render(100), ["∗ skill test-driven-development"]);
});

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

// bash_async 不加入 sampleArgs：其 launch 摘要是“已接受，待完成”语义，与七工具一行执行摘要循环前提不同，单独维护。
test("bash_async 合法launch回执折叠只显示已接受待完成摘要，展开显示完整身份且不改raw", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const args = { command: "sleep 5", cwd: "/tmp", timeout: 15 };
  const receipt = {
    kind: "bash-async-launch", jobId: "550e8400-e29b-41d4-a716-446655440000", toolCallId: "call-1",
    sessionId: "fixture-session", generation: 1, branchEpoch: 0, command: "sleep 5", cwd: "/tmp",
    acceptedAt: "2026-10-13T00:00:00.000Z",
  };
  const result = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
  const before = structuredClone({ args, result, receipt });
  const references = [result.content, result.details, result.content[0], args];
  const state = {};
  const ctx = { args, state, isError: false, expanded: false, isPartial: false };
  const call = renderers.bash_async.renderCall(args, plainTheme, ctx);
  const output = renderers.bash_async.renderResult(result, { expanded: false, isPartial: false }, plainTheme, ctx);
  const lines = [...call.render(120), ...output.render(120)].filter((line) => line.trim());
  assert.deepEqual(lines, ["∗ bash_async \"sleep 5\" · 已接受，待完成 (550e8400)"]);
  assert.doesNotMatch(lines.join("\n"), /succeeded|已完成|命令成功|exitCode|sessionId|generation|branchEpoch|acceptedAt/);
  // 展开显示完整身份（receipt JSON 原文），折叠摘要仍是接受语义。
  const expanded = renderers.bash_async.renderResult(result, { expanded: true, isPartial: false }, plainTheme, { ...ctx, expanded: true });
  assert.match(expanded.render(400).join("\n"), /550e8400-e29b-41d4-a716-446655440000/);
  assert.match(expanded.render(400).join("\n"), /acceptedAt/);
  assert.deepEqual({ args, result, receipt }, before);
  [result.content, result.details, result.content[0], args].forEach((value, index) => assert.equal(value, references[index]));
});

test("bash_async 错误以context.isError为准显示原因并清理旧接受摘要", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const args = { command: "sleep 5" };
  const state = {};
  const ctx = { args, state, isError: false, expanded: false, isPartial: false };
  const receipt = { kind: "bash-async-launch", jobId: "aabbccdd-1234", toolCallId: "call-2", command: "sleep 5", cwd: "/tmp", acceptedAt: "t" };
  const launch = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
  renderers.bash_async.renderResult(launch, { expanded: false, isPartial: false }, plainTheme, ctx);
  assert.equal(state.compactToolsSummary, "已接受，待完成 (aabbccdd)");

  const failure = { content: [{ type: "text", text: "cwd 不存在：/nope" }], details: undefined, isError: true };
  const before = structuredClone(failure);
  const failed = renderers.bash_async.renderResult(failure, { expanded: false, isPartial: false }, plainTheme, { ...ctx, isError: true });
  const lines = failed.render(100);
  assert.match(lines.join("\n"), /✗ cwd 不存在：\/nope/);
  assert.equal(state.compactToolsSummary, undefined);
  const expanded = renderers.bash_async.renderResult(failure, { expanded: true, isPartial: false }, plainTheme, { ...ctx, isError: true, expanded: true });
  assert.match(expanded.render(100).join("\n"), /cwd 不存在：\/nope/);
  assert.deepEqual(failure, before);

  // 直接result.isError调用兼容（无context.isError）。
  const direct = { content: [{ type: "text", text: "explicit failure" }], details: undefined, isError: true };
  const directOutput = renderers.bash_async.renderResult(direct, { expanded: false, isPartial: false }, plainTheme, ctx);
  assert.match(directOutput.render(100).join("\n"), /✗ explicit failure/);
});

test("bash_async partial与未知格式中性显示，不提前接受、不猜成功", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const args = { command: "sleep 5" };
  const state = {};
  const ctx = { args, state, isError: false, expanded: false, isPartial: false };

  // partial：即使携带 launch details 也不提前显示已接受。
  const receipt = { kind: "bash-async-launch", jobId: "aabbccdd-1234", toolCallId: "call-3", command: "sleep 5", cwd: "/tmp", acceptedAt: "t" };
  const partial = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
  const partialOutput = renderers.bash_async.renderResult(partial, { expanded: false, isPartial: true }, plainTheme, ctx);
  assert.doesNotMatch(partialOutput.render(120).join("\n"), /已接受/);
  assert.equal(state.compactToolsSummary, undefined);

  // 未知格式：中性显示原文，不猜接受/成功，也不伪装bash执行摘要。
  const unknown = { content: [{ type: "text", text: "{\"unexpected\":true}" }], details: { unexpected: true } };
  const unknownOutput = renderers.bash_async.renderResult(unknown, { expanded: false, isPartial: false }, plainTheme, ctx);
  const unknownVisible = unknownOutput.render(120).join("\n");
  assert.match(unknownVisible, /unexpected/);
  assert.doesNotMatch(unknownVisible, /已接受|succeeded|lines|done/);
  assert.equal(state.compactToolsSummary, undefined);

  // 空文本未知回执显示中性占位。
  const empty = { content: [], details: undefined };
  const emptyOutput = renderers.bash_async.renderResult(empty, { expanded: false, isPartial: false }, plainTheme, ctx);
  assert.match(emptyOutput.render(120).join("\n"), /未识别的回执格式/);
});

// apply_patch 不加入 sampleArgs：sampleArgs 的全局循环以七工具一行摘要为前提，期望单独维护。
test("apply_patch 调用折叠/展开都只显示工具名，不显示 patch 参数", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const args = { patch: "*** Begin Patch\n*** Add File: docs/secret.md\n+机密内容\n*** End Patch" };
  for (const expanded of [false, true]) {
    const lines = renderers.apply_patch.renderCall(args, plainTheme, { expanded, state: {} }).render(120);
    assert.deepEqual(lines, ["∗ apply_patch"]);
    assert.doesNotMatch(lines.join("\n"), /Begin Patch|Add File|secret|机密/);
  }
});

test("apply_patch 成功结果折叠/展开都显示完整 A/M/D 列表且不改写原始结果", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const details = { added: ["docs/a.md"], modified: ["test/b.ts", "src/c.ts"], deleted: ["old/d.txt"] };
  const result = {
    content: [{ type: "text", text: "A docs/a.md\nM test/b.ts\nM src/c.ts\nD old/d.txt" }],
    details,
    structuredContent: details,
  };
  const before = structuredClone(result);
  for (const expanded of [false, true]) {
    const lines = renderers.apply_patch
      .renderResult(result, { expanded, isPartial: false }, plainTheme, { isError: false, state: {}, args: { patch: "*** Begin Patch" } })
      .render(120);
    assert.deepEqual(lines, ["A docs/a.md", "M test/b.ts", "M src/c.ts", "D old/d.txt"]);
    assert.doesNotMatch(lines.join("\n"), /done|完成|Begin Patch|files? changed|entries|summary|详情/);
  }
  assert.deepEqual(result, before);
});

test("apply_patch details 缺数组时回退 content 原文，错误优先于成功列表", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const noDetails = { content: [{ type: "text", text: "A docs/a.md" }], details: undefined };
  const fallback = renderers.apply_patch
    .renderResult(noDetails, { expanded: false }, plainTheme, { isError: false, state: {} })
    .render(120);
  assert.deepEqual(fallback, ["A docs/a.md"]);

  const failure = {
    content: [{ type: "text", text: "Error: patch 不匹配" }],
    details: { added: ["x.md"], modified: [], deleted: [] },
    isError: true,
  };
  const failed = renderers.apply_patch
    .renderResult(failure, { expanded: false }, plainTheme, { isError: true, state: {} })
    .render(120);
  assert.match(failed.join("\n"), /✗ Error: patch 不匹配/);
  assert.doesNotMatch(failed.join("\n"), /x\.md/);

  const blankFailure = { content: [{ type: "text", text: "   " }], details: undefined, isError: true };
  const blank = renderers.apply_patch
    .renderResult(blankFailure, { expanded: false }, plainTheme, { isError: true, state: {} })
    .render(120);
  assert.match(blank.join("\n"), /✗ 工具执行失败/);

  const emptySuccess = { content: [{ type: "text", text: "" }], details: { added: [], modified: [], deleted: [] } };
  const emptyLines = renderers.apply_patch
    .renderResult(emptySuccess, { expanded: false }, plainTheme, { isError: false, state: {} })
    .render(120);
  assert.deepEqual(emptyLines, [""]);
});

test("apply_patch 渲染冻结的原始 args/result 后内容保持不变", () => {
  const renderers = setup();
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const args = Object.freeze({ patch: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch" });
  const result = Object.freeze({
    content: Object.freeze([{ type: "text", text: "M a.ts" }]),
    details: Object.freeze({ added: Object.freeze([]), modified: Object.freeze(["a.ts"]), deleted: Object.freeze([]) }),
    structuredContent: Object.freeze({ added: Object.freeze([]), modified: Object.freeze(["a.ts"]), deleted: Object.freeze([]) }),
  });
  const before = structuredClone({ args, result });
  for (const expanded of [false, true]) {
    renderers.apply_patch.renderCall(args, plainTheme, { expanded, state: {} }).render(120);
    renderers.apply_patch
      .renderResult(result, { expanded, isPartial: false }, plainTheme, { args, isError: false, state: {} })
      .render(120);
  }
  assert.deepEqual({ args, result }, before);
});
