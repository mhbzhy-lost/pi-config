import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

// ask_user_question 渲染器单测：stub theme/context（fg/bold 返回原文），
// 宽度断言用 pi-tui 真实 visibleWidth（●/○ 为 ambiguous width 字符，不能按字符数断言）。
const rendererModule = await import("../src/ask-user-question/renderer.ts");

const plainTheme = { bold: (t) => t, fg: (_color, t) => t };

function createRenderer() {
  return rendererModule.createAskUserQuestionRenderer()("ask_user_question", () => undefined);
}

function makeContext(state = {}) {
  return { state };
}

test("单问未回答：1 问题行 + N 选项行，全 ○ 且问题行 glyph 为 loading 态", () => {
  const renderer = createRenderer();
  const context = makeContext();
  const args = {
    questions: [{
      question: "选择部署环境？",
      header: "env",
      options: [{ label: "生产" }, { label: "测试", description: "desc" }, { label: "开发", preview: "pv" }],
      multiSelect: false,
    }],
  };
  const card = renderer.renderCall(args, plainTheme, context);
  const lines = card.render(80);

  assert.equal(lines.length, 4, JSON.stringify(lines));
  assert.match(lines[0], /^… ask_user_question 选择部署环境？$/);
  assert.equal(lines[1], "   ○ 生产");
  assert.equal(lines[2], "   ○ 测试");
  assert.equal(lines[3], "   ○ 开发");
  // state 机制复用现状：renderCall 把 questions 写入 renderer state。
  assert.equal(context.state.questions, args.questions);
});

test("多选回答：selected 含两个 label → 恰好两个 ● 其余 ○，已回答问题 glyph 随成功态", () => {
  const renderer = createRenderer();
  const context = makeContext();
  const args = {
    questions: [{
      question: "启用哪些检查？",
      header: "checks",
      options: [{ label: "lint" }, { label: "test" }, { label: "audit" }],
      multiSelect: true,
    }],
  };
  const card = renderer.renderCall(args, plainTheme, context);
  const output = renderer.renderResult(
    {
      content: [{ type: "text", text: "User has answered your questions:" }],
      details: { answers: [{ selected: ["lint", "audit"] }], cancelled: false },
    },
    { expanded: false },
    plainTheme,
    context,
  );

  // 成功态结果区收空（真实 Text 对空文本渲染为空行集）；answers 落入 state 供卡片读取。
  assert.deepEqual(output.render(80), []);
  assert.equal(context.state.status, "success");
  assert.equal(context.state.answers.length, 1);

  const lines = card.render(80);
  assert.match(lines[0], /^✓ ask_user_question 启用哪些检查？$/);
  assert.equal(lines[1], "   ● lint");
  assert.equal(lines[2], "   ○ test");
  assert.equal(lines[3], "   ● audit");
  assert.equal(lines.filter((line) => line.includes("●")).length, 2);
  assert.equal(lines.filter((line) => line.includes("○")).length, 1);
});

test("选中标记配色：● 用 accent、○ 用 dim", () => {
  const calls = [];
  const recordingTheme = {
    bold: (t) => t,
    fg: (color, t) => {
      calls.push([color, t]);
      return t;
    },
  };
  const renderer = createRenderer();
  const context = makeContext();
  renderer.renderCall(
    { questions: [{ question: "配色？", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    recordingTheme,
    context,
  );
  context.state.answers = [{ answer: "B" }];
  renderer.renderCall(
    { questions: [{ question: "配色？", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    recordingTheme,
    context,
  ).render(80);

  assert.ok(calls.some(([color, t]) => color === "accent" && t === "●"), JSON.stringify(calls));
  assert.ok(calls.some(([color, t]) => color === "dim" && t === "○"), JSON.stringify(calls));
});

test("单选回答：answer 等于某 label → 恰好该 label ●", () => {
  const renderer = createRenderer();
  const context = makeContext();
  const args = {
    questions: [{
      question: "选择运行模式？",
      options: [{ label: "快速" }, { label: "完整" }],
      multiSelect: false,
    }],
  };
  const card = renderer.renderCall(args, plainTheme, context);
  renderer.renderResult(
    { details: { answers: [{ answer: "完整" }] } },
    { expanded: false },
    plainTheme,
    context,
  );
  const lines = card.render(80);

  assert.equal(lines[1], "   ○ 快速");
  assert.equal(lines[2], "   ● 完整");
  assert.equal(lines.filter((line) => line.includes("●")).length, 1);
});

test("单选自定义输入：该问全 ○ 且问题行尾追加 “ → 输入”（dim 色）", () => {
  const renderer = createRenderer();
  const context = makeContext();
  const args = {
    questions: [{
      question: "选择集群？",
      options: [{ label: "生产" }, { label: "测试" }],
      multiSelect: false,
    }],
  };
  const card = renderer.renderCall(args, plainTheme, context);
  renderer.renderResult(
    { details: { answers: [{ answer: "灰度集群" }] } },
    { expanded: false },
    plainTheme,
    context,
  );
  const lines = card.render(80);

  assert.match(lines[0], /^✓ ask_user_question 选择集群？ → 灰度集群$/);
  assert.equal(lines[1], "   ○ 生产");
  assert.equal(lines[2], "   ○ 测试");
  assert.equal(lines.filter((line) => line.includes("●")).length, 0);
});

test("多问连排：每问一块（问题行+选项行）顺序正确，混合回答态按问独立", () => {
  const renderer = createRenderer();
  const context = makeContext();
  const args = {
    questions: [
      { question: "第一问？", header: "h1", options: [{ label: "A1" }, { label: "A2" }], multiSelect: false },
      { question: "第二问？", header: "h2", options: [{ label: "B1" }, { label: "B2" }, { label: "B3" }], multiSelect: true },
    ],
  };
  const card = renderer.renderCall(args, plainTheme, context);
  // 仅第一问有回答数据：第一问按已回答渲染（status 未定时 glyph 为 •），第二问保持 loading 态。
  context.state.answers = [{ answer: "A1" }, null];

  assert.deepEqual(card.render(80), [
    "• ask_user_question 第一问？",
    "   ● A1",
    "   ○ A2",
    "… ask_user_question 第二问？",
    "   ○ B1",
    "   ○ B2",
    "   ○ B3",
  ]);
});

test("卡片不随 expanded 变化：renderCall 对 expanded 无感知", () => {
  const renderer = createRenderer();
  const args = { questions: [{ question: "问题？", options: [{ label: "甲" }, { label: "乙" }], multiSelect: false }] };
  const collapsed = renderer.renderCall(args, plainTheme, { expanded: false, state: {} }).render(80);
  const expanded = renderer.renderCall(args, plainTheme, { expanded: true, state: {} }).render(80);
  assert.deepEqual(expanded, collapsed);
});

test("options 缺失或 label 非 string：该问仅渲染问题行，不崩", () => {
  const renderer = createRenderer();
  const args = {
    questions: [
      { question: "没有选项的问法？", multiSelect: false },
      { question: "label 非法的问法？", options: [{ label: "正常" }, { label: 42 }], multiSelect: false },
    ],
  };
  const lines = renderer.renderCall(args, plainTheme, makeContext()).render(80);

  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.match(lines[0], /^… ask_user_question 没有选项的问法？$/);
  assert.match(lines[1], /^… ask_user_question label 非法的问法？$/);
});

test("questions 缺失：退化为仅标题行", () => {
  const renderer = createRenderer();
  const lines = renderer.renderCall({}, plainTheme, makeContext()).render(80);
  assert.deepEqual(lines, ["• ask_user_question"]);
});

test("窄宽度截断：各行不超宽（visibleWidth 度量）且截断以 … 收尾", () => {
  const renderer = createRenderer();
  const args = {
    questions: [{
      question: "这是一个非常长的问题文本用于验证窄宽度下的整行截断行为是否符合预期",
      options: [{ label: "一个相当长的选项标签用来验证选项行截断" }, { label: "短" }],
      multiSelect: false,
    }],
  };
  const width = 20;
  const lines = renderer.renderCall(args, plainTheme, makeContext()).render(width);

  assert.ok(lines.length >= 3, JSON.stringify(lines));
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
  }
  // 真实 truncateToWidth 会在 … 后补 ANSI 复位序列，断言前先剥离再匹配结尾省略号。
  assert.match(stripVTControlCharacters(lines[0]), /…$/);
  assert.match(stripVTControlCharacters(lines[1]), /…$/);
  assert.equal(stripVTControlCharacters(lines[2]), "   ○ 短");
});

test("answers 来源：details 优先，structuredContent 兜底", () => {
  const renderer = createRenderer();
  const args = { questions: [{ question: "来源？", options: [{ label: "生产" }, { label: "测试" }], multiSelect: false }] };

  const structuredContext = makeContext();
  const card = renderer.renderCall(args, plainTheme, structuredContext);
  renderer.renderResult(
    { structuredContent: { answers: [{ answer: "生产" }] } },
    { expanded: false },
    plainTheme,
    structuredContext,
  );
  assert.deepEqual(structuredContext.state.answers, [{ answer: "生产" }]);
  assert.equal(card.render(80)[1], "   ● 生产");

  const detailsContext = makeContext();
  renderer.renderResult(
    { details: { answers: [{ selected: ["测试"] }] }, structuredContent: { answers: [{ answer: "生产" }] } },
    { expanded: false },
    plainTheme,
    detailsContext,
  );
  assert.deepEqual(detailsContext.state.answers, [{ selected: ["测试"] }]);
});

test("partial 结果收空且状态为 loading", () => {
  const renderer = createRenderer();
  const context = makeContext();
  const output = renderer.renderResult(
    { content: [{ type: "text", text: "半截" }] },
    { expanded: false, isPartial: true },
    plainTheme,
    context,
  );
  assert.deepEqual(output.render(80), []);
  assert.equal(context.state.status, "loading");
});

test("失败折叠：failedResultLine 单行首行错误，不吞点击（无 handleMouse）", () => {
  const renderer = createRenderer();
  const context = makeContext();
  const failure = { content: [{ type: "text", text: "第一行错误\n第二行错误" }], isError: true };
  const component = renderer.renderResult(failure, { expanded: false }, plainTheme, context);

  assert.equal(component.handleMouse, undefined);
  const lines = component.render(80);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /第一行错误/);
  assert.doesNotMatch(lines[0], /第二行错误/);
  assert.equal(context.state.status, "failure");
});

test("失败展开：渲染 content 全文（text 块 join 换行的多行 Text）", () => {
  const renderer = createRenderer();
  const failure = {
    content: [{ type: "text", text: "第一行错误\n第二行错误" }, { type: "text", text: "第三行错误" }],
    isError: true,
  };
  const component = renderer.renderResult(failure, { expanded: true }, plainTheme, makeContext());
  const lines = component.render(80);

  assert.equal(lines.length, 3, JSON.stringify(lines));
  assert.equal(lines[0].trim(), "第一行错误");
  assert.equal(lines[1].trim(), "第二行错误");
  assert.equal(lines[2].trim(), "第三行错误");
});

test("卡片吞左键点击（MouseRegion handled），非左键/非 click 不吞", () => {
  const renderer = createRenderer();
  const args = { questions: [{ question: "问题？", options: [{ label: "甲" }], multiSelect: false }] };
  const card = renderer.renderCall(args, plainTheme, makeContext());

  assert.deepEqual(card.handleMouse({ type: "click", button: "left", x: 0, y: 0 }), { handled: true });
  assert.equal(card.handleMouse({ type: "click", button: "right", x: 0, y: 0 }), undefined);
  assert.equal(card.handleMouse({ type: "wheel", button: "left", x: 0, y: 0 }), undefined);
});

test("非 ask_user_question 工具名直接委托 next()", () => {
  const sentinel = { renderShell: "self" };
  const resolved = rendererModule.createAskUserQuestionRenderer()("read", () => sentinel);
  assert.equal(resolved, sentinel);
});

test("病态 label：显示层空白归一化不破坏单行，选中判定仍按原文比对", () => {
  const renderer = createRenderer();
  const args = {
    questions: [{
      question: "选哪个？",
      options: [{ label: "选项\n甲" }, { label: " 选项  乙 " }],
      multiSelect: true,
    }],
  };
  const ctx = makeContext();
  renderer.renderCall(args, plainTheme, ctx);
  // 回答用原文 label（含换行/多余空白）：判定按原文命中 → ●。
  ctx.state.answers = [{ selected: ["选项\n甲"] }];
  const lines = renderer.renderCall(args, plainTheme, ctx).render(120);
  const plainLines = lines.map(stripVTControlCharacters);
  // 每行恒单行：label 的换行/多余空白被折叠为单空格，不产生额外物理行。
  assert.equal(lines.length, 3, JSON.stringify(plainLines));
  assert.match(plainLines[1], /● 选项 甲$/);
  assert.equal(plainLines[1].includes("\n"), false);
  assert.match(plainLines[2], /○ 选项 乙$/);
  // 选中判定不受归一化影响：归一化后的文本不参与匹配，未命中者仍为 ○。
  assert.equal(plainLines[2].includes("●"), false);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120), JSON.stringify(plainLines));
});
