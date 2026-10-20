// 统一执行计划 F1（docs/plans/2026-10-15-runtime-closeout.md §2 冻结显示合同）验收：
// 统一左基线 / 状态公共右列 / 词边界优先换行 / 元数据不留空槽 / 公平完整 block 预算。
//
// 本文件是纯 display fixture 验证：所有输入都是冻结的显示 fixture，不充当 production
// 数据来源证明；不启动真实 Host/任务/终端，不读取 session/settings，不发消息。
// 截图同形 label 仅作为显示 fixture（用户截图标题精确原文 unknown，见
// docs/bugs/2026-10-15-background-activity-footer-alignment.md）。
//
// 覆盖清单（派发合同）：
//   - 截图同形长 label 保留完整 `(delegate)`、状态真右列、续行同标题列且无断点空格；
//   - 前导空格/换行边界空白消费（续行不以前导空格开始）；
//   - ASCII 词、长路径、CJK、ZWJ emoji、ANSI/C0 清理、双空格；
//   - selected/unselected 单选择 cell；三 kind 公共 glyph cell 与标题列公式 3+glyphWidth；
//   - state 超宽转 stacked `状态：` 挂标题列；极窄 glyph-only 降级；
//   - 元数据连续渲染（provider/model 左 + thinking 右；放不下分别换行 col1），无空槽；
//   - 三 kind 同帧可见 + 预算紧时每 kind 首个完整 block 的公平策略、整块 overflow；
//   - widths {0,1,3,12,20,40,78,80,120} × heights {0,4,7,10,24} 不越界/不超预算/确定性；
//   - recent 汇总单行、stale/unavailable 独立状态行、available 空不虚构；
//   - geometry：main/detail 预算、详情 reserve 4、too-small；
//   - raw rows/meta 前后 deepEqual + 引用不变。

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  ACTIVITY_KIND_GLYPHS,
  ACTIVITY_KIND_ORDER,
  computeActivityGeometry,
  renderActivityLayout,
  renderActivityRows,
  DETAIL_FOOTER_MAX_ROWS,
  DETAIL_RESERVED_BOTTOM_ROWS,
  MAIN_VIEW_RESERVED_BOTTOM_ROWS,
  TOO_SMALL_TERMINAL_ROWS,
} from "../src/background-activity/layout.ts";

// 显示 fixture：冻结行对象，label/state 为显示输入（不含真实任务数据）。
function row(kind, key, label, stateLabel = "运行中", placement = "main") {
  return Object.freeze({ key, kind, label, stateLabel, placement });
}

const META = Object.freeze({
  cwd: "/tmp/proj",
  contextLabel: "12.3%/1.0M",
  providerModelLabel: "anthropic/claude-test",
  thinkingLabel: "medium",
});

// §2 冻结网格常量（与 layout 内部一致；fixture 环境三 glyph 宽均为 1 → 公共 glyph cell 1）。
const GLYPH_CELL = 1;
const PREFIX_WIDTH = 1 + GLYPH_CELL + 1; // 选择 cell + glyph cell + gap
const PREFIX_SPACES = " ".repeat(PREFIX_WIDTH);

/** 主题替身：记录 (color, text) 调用并原样返回文本，不影响可见宽度。 */
function createRecordingTheme() {
  const calls = [];
  return {
    calls,
    fg(color, text) {
      calls.push([color, text]);
      return text;
    },
  };
}

function layoutWith(rows, overrides = {}) {
  return renderActivityLayout({
    rows,
    width: 80,
    terminalRows: 24,
    meta: META,
    ...overrides,
  });
}

/** 条目首行去掉右列状态后的标题正文（状态是真右列，拼接正文时剔除）。 */
function titleBody(lines, state = "运行中") {
  const first = lines[0].slice(PREFIX_WIDTH);
  const stripped = state === "" ? first : first.replace(new RegExp(`\\s*${state}$`), "");
  return stripped + lines.slice(1).map((line) => line.slice(PREFIX_WIDTH)).join("");
}

function tokens(text) {
  return text.split(/\s+/).filter((part) => part !== "");
}

test("公开签名与常量：类型图标映射、固定顺序与宽高预算常量", () => {
  assert.equal(typeof renderActivityRows, "function");
  assert.equal(typeof renderActivityLayout, "function");
  assert.equal(typeof computeActivityGeometry, "function");
  assert.deepEqual(ACTIVITY_KIND_GLYPHS, { subagent: "●", bash_async: "⌘", scheduler: "⏱" });
  assert.deepEqual(ACTIVITY_KIND_ORDER, ["subagent", "bash_async", "scheduler"]);
  assert.equal(MAIN_VIEW_RESERVED_BOTTOM_ROWS, 6);
  assert.equal(DETAIL_RESERVED_BOTTOM_ROWS, 4);
  assert.equal(DETAIL_FOOTER_MAX_ROWS, 3);
  assert.equal(TOO_SMALL_TERMINAL_ROWS, 4);
  for (const glyph of Object.values(ACTIVITY_KIND_GLYPHS)) {
    assert.equal(visibleWidth(glyph), GLYPH_CELL, "fixture 环境三 glyph 宽均为 1（标题列 col4）");
  }
});

test("§2 左基线网格：单选择 cell + 公共 glyph cell + gap，标题列 = 3 + glyphWidth", () => {
  const rows = [
    row("scheduler", "scheduler:s1", "定时C", "等待触发"),
    row("subagent", "subagent:a1", "任务A", "待处置"),
    row("bash_async", "bash_async:b1", "命令B", "成功(exit 0)"),
    row("subagent", "subagent:a2", "任务D", "运行中"),
    row("scheduler", "scheduler:s2", "定时E", "已禁用"),
    row("bash_async", "bash_async:b2", "命令F", "失败(exit 1)"),
  ];
  const first = renderActivityRows(rows, 80);
  assert.deepEqual(first, renderActivityRows(rows, 80), "相同输入重复渲染输出一致");
  assert.equal(first.length, 6, "三类型各两项共 6 行，不去重不折叠");
  // 类型固定顺序：subagent×2 → bash_async×2 → scheduler×2。
  const orderedGlyphs = ["●", "●", "⌘", "⌘", "⏱", "⏱"];
  const orderedStates = ["待处置", "运行中", "成功(exit 0)", "失败(exit 1)", "等待触发", "已禁用"];
  first.forEach((line, index) => {
    assert.equal(line[0], " ", `行 ${index} col1 是单选择 cell（未选中空格）`);
    assert.equal(line[1], orderedGlyphs[index], `行 ${index} col2 是类型图标`);
    assert.equal(line[2], " ", `行 ${index} col3 是 1 列 gap`);
    assert.equal(visibleWidth(line), 80, `状态真右列右对齐到 width：${line}`);
    assert.ok(line.endsWith(orderedStates[index]), `行 ${index} 状态在首行真右列`);
    const stateIndex = line.lastIndexOf(orderedStates[index]);
    assert.equal(line.slice(stateIndex - 2, stateIndex), "  ", `标题/状态间隔>=2 列：${line}`);
  });
  assert.equal(first[0].indexOf("任务A"), PREFIX_WIDTH, "标题列 = 3 + glyphWidth（col4）");
  assert.equal(first[2].indexOf("命令B"), PREFIX_WIDTH);
  assert.equal(first[4].indexOf("定时C"), PREFIX_WIDTH);
});

test("选择 cell：selection 按 key 精确命中 col1 显示 ›，其余行留空且同网格", () => {
  const rows = [
    row("subagent", "subagent:a1", "任务A"),
    row("bash_async", "bash_async:b1", "命令B"),
    row("scheduler", "scheduler:s1", "定时C"),
  ];
  const lines = renderActivityRows(rows, 80, "bash_async:b1");
  const selected = lines.find((line) => line.includes("命令B"));
  assert.ok(selected.startsWith("›⌘ "), "选中行 col1=›、col2=glyph、col3=gap");
  for (const line of lines) {
    if (!line.includes("命令B")) {
      assert.ok(line.startsWith(" "), "未选中行选择 cell 留空");
      assert.ok(!line.includes("›"), "未选中行不出现选择标记");
    }
  }
  const unselected = renderActivityRows(rows, 80);
  assert.ok(unselected.every((line) => line.startsWith(" ")), "无 selection 时全部留空");
});

test("截图同形 label（width 78）：(delegate) 不拆、状态真右列、续行同标题列无断点空格", () => {
  // 显示 fixture：与用户截图同形（双空格、长路径、CJK、尾随 (delegate)）；
  // 截图标题精确原文 unknown，本串只是同形显示输入，不称精确原文。
  const label = "在  /Users/leshi.zhy/brightness-control 只读诊断用户刚报告的 bug (delegate)";
  const meta = Object.freeze({
    cwd: "/Users/leshi.zhy/brightness-control",
    home: "/Users/leshi.zhy",
    contextLabel: "1.4%/900k",
    providerModelLabel: "codex-pool/gpt-6.1-sol",
    thinkingLabel: "low",
  });
  const { lines } = renderActivityLayout({
    rows: [row("subagent", "subagent:1", label, "运行中")],
    width: 78,
    terminalRows: 24,
    meta,
    selection: "subagent:1",
  });
  assert.equal(lines.length, 4, "压缩单行元数据 + 分隔空行 + 条目 2 行");
  assert.equal(lines[0], `${"~/brightness-control"}${" ".repeat(78 - 20 - visibleWidth("codex-pool/gpt-6.1-sol · low · 1.4%/900k"))}codex-pool/gpt-6.1-sol · low · 1.4%/900k`, "第一行压缩元数据右对齐");
  assert.ok(lines[0].endsWith("codex-pool/gpt-6.1-sol · low · 1.4%/900k"), "任意provider/model均合并到右侧");
  assert.equal(lines[1], "", "常驻元数据后恰一个空行");
  const entryFirst = lines[2];
  assert.ok(entryFirst.startsWith("›● "), "选中 + glyph + gap");
  assert.equal(visibleWidth(entryFirst), 78, "状态右对齐到 78 列右边界");
  assert.ok(entryFirst.endsWith("运行中"), "状态在首行真右列");
  assert.ok(!entryFirst.includes("(delegate)"), "首行标题不含被换行的词");
  const continuation = lines[3];
  assert.equal(continuation, `${PREFIX_SPACES}(delegate)`, "完整词 (delegate) 不被拆且对齐标题列");
  assert.notEqual(continuation[PREFIX_WIDTH], " ", "续行不保留断点空格");
  const stateIndex = entryFirst.lastIndexOf("运行中");
  assert.equal(entryFirst.slice(stateIndex - 2, stateIndex), "  ", "标题/状态间隔>=2 列");
});

test("词边界优先：ASCII 词/完整词不拆，换行边界空白被消费，词内部双空格保留", () => {
  const kept = renderActivityRows([row("subagent", "s:1", "aaaa  bbbb", "运行中")], 40);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].includes("aaaa  bbbb"), "行内部双空格保留");

  const label = "aaaa bbbb cccc dddd";
  const lines = renderActivityRows([row("subagent", "s:1", label, "运行中")], 20);
  const bodyLines = [
    lines[0].slice(PREFIX_WIDTH).replace(/\s*运行中$/, ""),
    ...lines.slice(1).map((line) => line.slice(PREFIX_WIDTH)),
  ];
  assert.deepEqual(tokens(bodyLines.join(" ")), tokens(label), "拼接按去空白 token 序列比较");
  for (const continuation of lines.slice(1)) {
    assert.notEqual(continuation[PREFIX_WIDTH], " ", `续行无断点空格：${JSON.stringify(continuation)}`);
    assert.ok(continuation.startsWith(PREFIX_SPACES), "续行对齐标题列");
  }

  const leading = renderActivityRows([row("subagent", "s:2", "  前导 空格 aaaa bbbb", "运行中")], 20);
  for (const continuation of leading.slice(1)) {
    assert.notEqual(continuation[PREFIX_WIDTH], " ", `续行无前导空格：${JSON.stringify(continuation)}`);
  }

  const longToken = "x".repeat(40);
  const broken = renderActivityRows([row("subagent", "s:3", longToken, "运行中")], 20);
  for (const line of broken) assert.ok(visibleWidth(line) <= 20, "长 token 字素兜底不越界");
  assert.equal(titleBody(broken), longToken, "长 token 字素兜底拼回原文不丢字");
});

test("CJK/emoji ZWJ/ANSI/C0 清理只生成新显示串：raw label/state 不写回", () => {
  const rawLabel = "\u001b[31m部署\u001b[0m 中文\u{1F469}\u200D\u{1F4BB}\u0007x\ty";
  const rawState = "运行\u001b[32m中";
  const original = row("bash_async", "bash_async:1", rawLabel, rawState);
  const rows = Object.freeze([original]);

  const lines = renderActivityRows(rows, 80);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line.includes("部署"), "CJK 保留");
  assert.ok(line.includes("\u{1F469}\u200D\u{1F4BB}"), "ZWJ emoji 字素簇不拆");
  assert.ok(line.includes("x y"), "tab 清理为空格、C0 控制符移除");
  assert.ok(!line.includes("\u001b"), "ANSI 序列被剥离");
  assert.ok(!line.includes("\u0007") && !line.includes("\t"));
  assert.ok(line.endsWith("运行中"), "state ANSI 清理后独立右列");
  assert.equal(visibleWidth(line), 80, "状态右对齐");

  assert.equal(original.label, rawLabel);
  assert.equal(original.stateLabel, rawState);
  assert.ok(Object.is(rows[0], original));
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { key: "bash_async:1", kind: "bash_async", label: rawLabel, stateLabel: rawState, placement: "main" },
  ]);
});

test("CJK 长 label 换行不丢字：续行对齐标题列，宽度不越界", () => {
  const label = "部署".repeat(15); // 60 终端列
  const lines = renderActivityRows([row("subagent", "subagent:1", label)], 30);
  assert.ok(lines.length > 1, "长 CJK label 换行");
  for (const line of lines) assert.ok(visibleWidth(line) <= 30, `行宽 ${visibleWidth(line)} 不越界`);
  assert.ok(lines[0].endsWith("运行中"), "首行状态真右列");
  for (const continuation of lines.slice(1)) {
    assert.ok(continuation.startsWith(PREFIX_SPACES), "续行挂起缩进 = 前缀宽");
  }
  assert.equal(titleBody(lines), label, "换行不丢字：分段拼回等于原 label");
});

test("state 超宽转 stacked：独立 `状态：` 行挂标题列并换行，不静默隐藏", () => {
  const longState = "等待触发中且非常长的状态词";
  const lines = renderActivityRows([row("scheduler", "s:1", "每日巡检", longState)], 20);
  assert.ok(lines.length >= 2, "stacked 至少标题行 + 状态行");
  assert.ok(!lines[0].includes(longState), "首行不夹状态");
  const stateBody = lines.slice(1).map((line) => line.slice(PREFIX_WIDTH)).join("");
  assert.equal(stateBody, `状态：${longState}`, "独立状态行挂标题列、全文可见（换行不丢字）");
  assert.ok(lines[1].startsWith(`${PREFIX_SPACES}状态：`), "状态行前缀 = 标题列");
  for (const line of lines) assert.ok(visibleWidth(line) <= 20, "stacked 不越界");
});

test("极窄降级阶梯：width 0 空 / 1 glyph-only / 3 选择cell+glyph，均不越界", () => {
  const rows = [
    row("subagent", "subagent:1", "任务A"),
    row("bash_async", "bash_async:1", "命令B"),
    row("scheduler", "scheduler:1", "定时C"),
  ];
  assert.deepEqual(renderActivityRows(rows, 0), [], "width 0 返回空显示");
  assert.deepEqual(renderActivityRows(rows, 1), ["●", "⌘", "⏱"], "width 1 glyph-only 降级");
  const three = renderActivityRows(rows, 3, "bash_async:1");
  assert.deepEqual(three, [" ●", "›⌘", " ⏱"], "width 3 选择 cell + glyph，无标题列");
  for (const width of [1, 3]) {
    for (const line of renderActivityRows(rows, width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width} 行宽不越界`);
    }
  }
  const layout = layoutWith(rows, { width: 1, terminalRows: 24 });
  for (const line of layout.lines) {
    assert.ok(visibleWidth(line) <= 1, `布局 width 1 行宽 ${visibleWidth(line)} 不越界`);
  }
});

test("三 kind 同帧可见：充足预算按类型固定顺序整块渲染，glyph/标题列一致", () => {
  const rows = [
    row("subagent", "subagent:a1", "任务A"),
    row("bash_async", "bash_async:b1", "命令B"),
    row("scheduler", "scheduler:s1", "定时C", "等待触发"),
  ];
  const { lines, geometry } = layoutWith(rows);
  assert.equal(lines.length, 5, "压缩单行元数据 + 分隔空行 + 三 kind 各 1 行");
  assert.ok(lines[0].startsWith("/tmp/proj") && lines[0].endsWith("anthropic/claude-test · medium · 12.3%/1.0M"), "第一行压缩元数据");
  assert.equal(lines[1], "");
  assert.ok(lines[2].startsWith(" ● 任务A"), "subagent 行网格");
  assert.ok(lines[3].startsWith(" ⌘ 命令B"), "bash 行网格");
  assert.ok(lines[4].startsWith(" ⏱ 定时C"), "scheduler 行网格");
  const withThird = layoutWith(rows, { terminalRows: 12 });
  assert.ok(withThird.lines.some((line) => line.includes("定时C")), "三 kind 同帧可见");
  assert.equal(geometry.overflowCount, 0);
});

test("元数据连续渲染不留空 activity 槽：放不下时分别换行且 col1 共同左基线", () => {
  const rows = [row("subagent", "subagent:1", "长".repeat(40))]; // 需要换行 → 不再下移留空槽
  const fit = layoutWith(rows, { width: 40 });
  assert.ok(fit.lines.some((line) => line.includes("anthropic/claude-test")), "provider/model保留");
  assert.ok(fit.lines.some((line) => line.includes("medium")), "thinking保留");
  assert.ok(fit.lines.some((line) => line.includes("12.3%/1.0M")), "context保留");
  assert.ok(fit.lines.some((line) => line.startsWith(" ● ")), "活动区紧跟元数据连续绘制");
  assert.ok(!fit.lines.some((line) => line.trim() === "(anthropic) claude-test"), "不存在旧的第二元数据槽行");

  const split = layoutWith(rows, { width: 30 });
  assert.ok(split.lines[0].includes("anthropic/claude-test") || split.lines[1].includes("anthropic/claude-test"), "窄宽仍保留provider/model");
  assert.ok(split.lines.some((line) => line.includes("medium")), "窄宽仍保留thinking");
  assert.ok(split.lines.some((line) => line.includes("12.3%/1.0M")), "窄宽仍保留context");
  assert.ok(split.lines.some((line) => line.startsWith(" ● ")), "活动区仍在元数据之后");
  for (const line of split.lines) assert.ok(visibleWidth(line) <= 30, "换行后不越界");
});

test("公平完整 block 预算：预算紧时每 kind 首个完整 block 优先，整块 overflow 不截断", () => {
  // 同 kind 两条 + 另两 kind 各一条：公平顺序 = 每 kind 首块 → 同 kind 剩余 → 信息行。
  const rows = [
    row("subagent", "subagent:a1", "任务A"),
    row("subagent", "subagent:a2", "任务A2"),
    row("bash_async", "bash_async:b1", "命令B"),
    row("scheduler", "scheduler:s1", "定时C"),
  ];
  const { lines, geometry } = layoutWith(rows, { terminalRows: 11 }); // 预算 5 → 可用 3
  assert.equal(lines.length, 5, "压缩meta + 空行 + 两个公平首块 + 溢出提示");
  assert.equal(lines[1], "");
  assert.ok(lines[2].includes("任务A") && !lines[2].includes("任务A2"), "subagent 首块入选");
  assert.ok(lines[2].includes("命令B") || lines[3].includes("命令B"), "bash 首块入选（先于同 kind 剩余）");
  assert.equal(lines.some((line) => line.includes("定时C")), false, "分隔行计入预算，第三种类首块溢出");
  assert.ok(lines.at(-1).startsWith("还有 2 项"));
  assert.equal(lines.some((line) => line.includes("任务A2")), false, "同kind剩余项不能抢占另一kind首块");
  assert.equal(geometry.overflowCount, 2);

  // 2 行整块 vs 1 行块：整块取舍，放不下的 1 行块计 overflow 而不截 2 行块。
  const blocky = [
    row("subagent", "subagent:a1", "长".repeat(20)), // 2 行整块
    row("bash_async", "bash_async:b1", "命令B"),
    row("scheduler", "scheduler:s1", "定时C"),
  ];
  const tight = layoutWith(blocky, { width: 40, terminalRows: 10 }); // 预算 4 → 可用 2
  assert.equal(tight.lines.length, 4, "窄宽metadata三行 + overflow提示");
  assert.ok(tight.lines[1].includes("anthropic/claude-test"), "provider/model完整保留");
  assert.ok(tight.lines[2].includes("12.3%/1.0M"), "context完整保留");
  assert.ok(tight.lines[3].startsWith("还有 3 项 · Alt+O"), `metadata占预算后的整块让位提示：${tight.lines[3]}`);
  assert.ok(!tight.lines.some((line) => line.includes("命令B") || line.includes("定时C")), "活动整块让位不截block");
  assert.equal(tight.geometry.overflowCount, 3);

  const roomy = layoutWith(blocky, { width: 40, terminalRows: 24 });
  assert.ok(roomy.lines.some((line) => line.includes("命令B")), "充足预算整块渲染");
  assert.equal(roomy.geometry.overflowCount, 0);
});

test("widths × heights 矩阵：不越界、不超预算、确定性、预算 0 不虚构", () => {
  const rows = [
    row("subagent", "subagent:a1", "在  /Users/leshi.zhy/brightness-control 只读诊断 bug (delegate)"),
    row("subagent", "subagent:a2", "\u001b[31m部署\u001b[0m 中文\u{1F469}\u200D\u{1F4BB} 长路径/aaaaaaaaaaaaaaaaaaaa"),
    row("bash_async", "bash_async:b1", "命令B", "成功(exit 0)"),
    row("scheduler", "scheduler:s1", "定时C", "等待触发"),
    row("subagent", "recent:r1", "旧任务", "已完成", "recent"),
  ];
  const sourceStatuses = [{ kind: "bash_async", availability: "unavailable" }];
  for (const width of [0, 1, 3, 12, 20, 40, 78, 80, 120]) {
    const rowLines = renderActivityRows(rows, width);
    for (const line of rowLines) {
      assert.ok(visibleWidth(line) <= width, `rows width=${width} 行宽 ${visibleWidth(line)} 越界`);
    }
    for (const terminalRows of [0, 4, 7, 10, 24]) {
      const result = layoutWith(rows, { width, terminalRows, sourceStatuses });
      const budget = Math.max(0, terminalRows - MAIN_VIEW_RESERVED_BOTTOM_ROWS);
      assert.ok(result.lines.length <= budget, `width=${width} rows=${terminalRows} 超预算`);
      for (const line of result.lines) {
        assert.ok(visibleWidth(line) <= width, `layout width=${width} 行宽越界：${line}`);
      }
      assert.deepEqual(
        layoutWith(rows, { width, terminalRows, sourceStatuses }).lines,
        result.lines,
        "同输入重复渲染确定",
      );
      if (budget === 0) {
        assert.deepEqual(result.lines, [], "预算 0 不渲染物理行");
        assert.equal(result.geometry.overflowCount, 4, "预算 0 时 main 条目计入 overflow（recent 不计）");
      }
    }
  }
});

test("resize：宽度变化后内容重新适配，行宽始终不越界且换行不丢字", () => {
  const label = "命令".repeat(10); // 40 终端列
  const rows = [row("subagent", "subagent:1", label)];
  const wide = layoutWith(rows, { width: 80 });
  const narrow = layoutWith(rows, { width: 24 });
  for (const line of wide.lines) assert.ok(visibleWidth(line) <= 80);
  for (const line of narrow.lines) assert.ok(visibleWidth(line) <= 24);
  assert.equal(wide.lines.length, 3, "宽屏：meta 1 行 + 分隔空行 + 单行条目");
  assert.ok(wide.lines[2].includes(label) && wide.lines[2].endsWith("运行中"), "宽屏条目状态右列");
  assert.ok(narrow.lines.length > wide.lines.length, "窄屏换行后行数增加");
  assert.ok(narrow.lines.some((line) => line.includes("/tmp/proj")), "窄宽仍保留cwd");
  assert.ok(narrow.lines.some((line) => line.includes("anthropic/claude-test")), "窄宽仍保留provider/model");
  assert.ok(narrow.lines.some((line) => line.includes("12.3%/1.0M")), "窄宽仍保留context");
  const entryLines = narrow.lines.slice(narrow.lines.findIndex((line) => line.startsWith(" ● ")));
  assert.equal(titleBody(entryLines), label, "resize 后换行不丢字");
});

test("超多 overflow：主视图预算 terminalRows-6，最后一行 col1 显示还有 N 项 · Alt+O", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    row("subagent", `subagent:${index}`, `任务${index}`),
  );
  const { lines, geometry } = layoutWith(rows, { terminalRows: 10 }); // 预算 4
  assert.equal(geometry.mainBudgetRows, 4);
  assert.equal(lines.length, 4, "meta1 + 公平首块 + 溢出提示行");
  assert.equal(lines[1], "");
  assert.ok(lines[2].includes("任务0"), "公平首项为类型内首条");
  assert.ok(lines[3].startsWith("还有 19 项 · Alt+O"), `实际最后一行：${lines[3]}`);
  assert.ok(!lines.some((line) => line.includes("任务19")), "预算外条目不渲染");
  assert.equal(geometry.footerRows, 4);
  assert.equal(geometry.overflowCount, 19);
  assert.ok(!lines.some((line) => line.includes("recent")), "recent 未配置时不虚构汇总行");
});

test("recent 汇总单行：main 优先逐条显示，recent 按 key 去重且文本对齐标题列", () => {
  const rows = [
    row("subagent", "recent:r1", "旧任务1", "已完成", "recent"),
    row("subagent", "recent:r2", "旧任务2", "已完成", "recent"),
    row("subagent", "recent:r2", "旧任务2", "已完成", "recent"), // 重复 key
    row("subagent", "subagent:1", "任务A"),
  ];
  const { lines } = layoutWith(rows);
  const recentLines = lines.filter((line) => line.includes("recent"));
  assert.equal(recentLines.length, 1, "recent 折叠为单行提示");
  assert.ok(recentLines[0].startsWith(" ◯ "), "信息行保留空选择 cell + 图标");
  assert.ok(recentLines[0].includes("recent 2"), "N 按统一列表 key 去重");
  assert.equal(recentLines[0].indexOf("recent 2"), PREFIX_WIDTH, "信息行文本对齐标题列");
  assert.ok(!lines.some((line) => line.includes("旧任务")), "recent 不逐条进入主视图");
  const mainLine = lines.find((line) => line.includes("任务A"));
  assert.ok(lines.indexOf(mainLine) < lines.indexOf(recentLines[0]), "main 优先于 recent 汇总");
});

test("recent 在预算紧张时先被折叠，不计入溢出项数", () => {
  const rows = [
    row("subagent", "subagent:1", "任务A"),
    row("subagent", "subagent:2", "任务B"),
    row("subagent", "subagent:3", "长".repeat(50)), // 需要换行：整块预算大
    row("subagent", "recent:r1", "旧任务", "已完成", "recent"),
  ];
  const { lines, geometry } = layoutWith(rows, { terminalRows: 11 }); // 预算 5 → 可用 3
  assert.equal(lines.length, 5, "meta1 + 空行 + 两个首块 + 溢出提示");
  assert.ok(lines[4].startsWith("还有 1 项 · Alt+O"), "全宽阶段条目被折叠并提示");
  assert.ok(!lines.some((line) => line.includes("recent")), "recent 汇总行被折叠");
  assert.ok(!lines.some((line) => line.includes("长".repeat(2))), "预算外条目不渲染");
  assert.equal(geometry.overflowCount, 1, "溢出项数只统计 activity 条目");
});

test("stale/unavailable 独立 source 状态行：旧行不进入主视图、不计入 main/recent", () => {
  const rows = [row("subagent", "subagent:1", "任务A")];
  const sourceStatuses = [
    { kind: "scheduler", availability: "stale", errorLabel: "30 秒未刷新", lastObservedCount: 2 },
    { kind: "bash_async", availability: "unavailable" },
  ];
  const { lines, geometry } = layoutWith(rows, { terminalRows: 11, sourceStatuses }); // 预算 5
  assert.equal(lines.length, 5, "压缩meta + 空行 + 条目 + 两条状态行");
  // 状态行按类型固定顺序排序：bash_async 在 scheduler 之前。
  assert.ok(lines[3].includes("⌘") && lines[3].includes("暂不可用"), "unavailable 显示独立状态行");
  assert.ok(lines[4].includes("⏱") && lines[4].includes("过期观察"), "第二条状态行按类型顺序");
  assert.equal(geometry.overflowCount, 0, "状态行不计入溢出项数");

  const roomy = layoutWith(rows, { terminalRows: 12, sourceStatuses });
  assert.equal(roomy.lines.length, 5);
  assert.ok(
    roomy.lines[4].includes("⏱") &&
      roomy.lines[4].includes("过期观察") &&
      roomy.lines[4].includes("30 秒未刷新") &&
      roomy.lines[4].includes("上次观察 2 项"),
    `stale 行完整内容：${roomy.lines[4]}`,
  );
  assert.equal(roomy.lines[3].indexOf("暂不可用"), PREFIX_WIDTH, "状态行文本对齐标题列");

  const tight = layoutWith(rows, { terminalRows: 9, sourceStatuses }); // 预算 3
  assert.equal(tight.lines.length, 2, "极低预算只保留meta与溢出提示，不留悬空空行");
  assert.equal(tight.geometry.overflowCount, 1);
});

test("available 且无任务：只显示元数据行，不虚构任务/汇总/溢出", () => {
  const { lines, geometry } = layoutWith([]);
  assert.equal(lines.length, 1, "cwd + 压缩模型元信息共 1 行");
  for (const glyph of ["●", "⌘", "⏱", "◯"]) {
    assert.ok(!lines.some((line) => line.includes(glyph)), `不虚构 ${glyph} 行`);
  }
  assert.ok(!lines.some((line) => line.includes("recent")));
  assert.ok(!lines.some((line) => line.includes("还有")));
  assert.equal(geometry.overflowCount, 0);
});

test("zero height / 低预算：不渲染物理行、不越界，geometry 报告隐藏条目", () => {
  const rows = [
    row("subagent", "subagent:1", "任务A"),
    row("bash_async", "bash_async:1", "命令B"),
    row("scheduler", "scheduler:1", "定时C"),
  ];
  const zero = layoutWith(rows, { terminalRows: 6 }); // 预算 0
  assert.deepEqual(zero.lines, []);
  assert.equal(zero.geometry.footerRows, 0);
  assert.equal(zero.geometry.mainBudgetRows, 0);
  assert.equal(zero.geometry.overflowCount, 3, "全部条目被隐藏并计入 overflowCount");

  const zeroRows = layoutWith(rows, { terminalRows: 0 });
  assert.deepEqual(zeroRows.lines, []);
  assert.equal(zeroRows.geometry.tooSmall, true);

  const zeroWidth = layoutWith(rows, { width: 0, terminalRows: 24 });
  assert.deepEqual(zeroWidth.lines, []);

  const oneLine = layoutWith(rows, { terminalRows: 7 }); // 预算 1：仅 cwd/context
  assert.equal(oneLine.lines.length, 1);
  assert.ok(oneLine.lines[0].includes("/tmp/proj"));
  assert.ok(!oneLine.lines.some((line) => line.includes("还有")), "无溢出提示槽位时不虚构");
  assert.equal(oneLine.geometry.overflowCount, 3, "隐藏条目入账");
});

test("geometry：main/detail 预算、详情 reserve 4、too-small 明确", () => {
  const main = computeActivityGeometry({ terminalRows: 24 });
  assert.deepEqual(
    { ...main },
    {
      footerRows: 18,
      reservedBottomRows: 6,
      bodyRows: 0,
      mode: "main",
      mainBudgetRows: 18,
      detailFooterMaxRows: 3,
      detailReservedBottomRows: 4,
      tooSmall: false,
      overflowCount: 0,
    },
  );
  const detail = computeActivityGeometry({ terminalRows: 24, mode: "detail", renderedFooterRows: 2 });
  assert.equal(detail.footerRows, 2);
  assert.equal(detail.reservedBottomRows, 4, "详情静态 viewport reserve 恒为 4");
  assert.equal(detail.bodyRows, 20, "详情 bodyRows = max(0, terminalRows-4)");
  assert.equal(detail.overflowCount, 0);
  const detailDefault = computeActivityGeometry({ terminalRows: 24, mode: "detail" });
  assert.equal(detailDefault.footerRows, 3, "详情 footer 默认上限 3 行");
  const tooSmall = computeActivityGeometry({ terminalRows: 4, mode: "detail" });
  assert.equal(tooSmall.tooSmall, true, "terminalRows<=4 标记 too-small（F5b 不挂 overlay）");
  assert.equal(tooSmall.bodyRows, 0);
  const tiny = computeActivityGeometry({ terminalRows: 3 });
  assert.equal(tiny.tooSmall, true);
  assert.equal(tiny.mainBudgetRows, 0);
  assert.equal(tiny.footerRows, 0);
});

test("raw rows/meta 不写回：deepEqual 前后一致且引用不变（layout 与 rows 双路径）", () => {
  const originalRow = row("subagent", "subagent:1", "\u001b[31m红\u001b[0m色任务", "运行中");
  const rows = Object.freeze([originalRow]);
  const meta = META;
  const before = JSON.stringify({ rows: [...rows], meta: { ...meta } });

  const rendered = renderActivityRows(rows, 80);
  const laidOut = layoutWith(rows, { terminalRows: 10 });
  assert.ok(rendered[0].includes("红色任务"));
  assert.ok(laidOut.lines.some((line) => line.includes("红色任务")));

  assert.equal(JSON.stringify({ rows: [...rows], meta: { ...meta } }), before, "输入未变化");
  assert.ok(Object.is(rows[0], originalRow), "行对象引用不变");
  assert.equal(originalRow.label, "\u001b[31m红\u001b[0m色任务", "raw label 不被改写");
  assert.ok(!rendered[0].includes("\u001b[31m"), "显示串是新文本，不含 raw ANSI 色");
});

test("theme 端口：选择标记 accent、其余 dim；主题替换不改变可见内容与宽度", () => {
  const rows = [
    row("subagent", "subagent:1", "任务A"),
    row("bash_async", "bash_async:b1", "命令B"),
  ];
  const plain = layoutWith(rows, { selection: "subagent:1" });
  const theme = createRecordingTheme();
  const themed = layoutWith(rows, { selection: "subagent:1", theme });
  assert.deepEqual(themed.lines, plain.lines, "主题替身原样返回文本时输出一致");
  assert.ok(theme.calls.some(([color, text]) => color === "accent" && text === "›"), "选中标记走 accent");
  assert.ok(theme.calls.some(([color, text]) => color === "dim" && text === plain.lines[0]), "元数据行走 dim");
  for (const line of themed.lines) assert.ok(visibleWidth(line) <= 80);
});
