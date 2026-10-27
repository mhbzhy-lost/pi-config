// 统一执行计划 F5b / footer 子计划 T5b 验收：根详情壳 controller/presenter 测试。
//
// 本文件是 display/交互 fixture 验证：registry source、TUI、editor 都是明确的测试替身，
// 不充当 production 数据来源证明；不启动真实 Host/任务/终端，不读取 session/settings，
// 不发消息、不执行业务操作。运行需 unit-runner 授权（占用期间不得执行 node --test）。
//
// 覆盖清单（派发合同）：
//   - 详情稳定 key/source/token/request epoch fence 防晚回；x/source invalidate/theme
//     重取与 dispose 幂等；scroll anchor 保持；
//   - 只读输入、draft/editor 恢复、Esc 不传播、无业务操作；presenter 不 setFooter、
//     不重复 shortcut、不安装全局 terminal input listener；
//   - 静态 overlay margin 4、详情 footer <= 3、too-small 不挂载、resize 高度不双扣；
//   - main metadata/layout + source availability + 历史（recent）完整导航，raw 不变。

import assert from "node:assert/strict";
import test from "node:test";
import {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createActivityRegistry } from "pi-subagents-enhanced/tui/background-activity";

import {
  createActivityDetailShell,
  parseSgrWheelDirection,
} from "../src/background-activity/detail-controller.ts";
import {
  activityPresenterFactoryFor,
  createActivityPresenter,
  defaultActivityPresenterUiDependencies,
} from "../src/background-activity/presenter.ts";
import {
  DETAIL_FOOTER_MAX_ROWS,
  DETAIL_RESERVED_BOTTOM_ROWS,
  TOO_SMALL_TERMINAL_ROWS,
} from "../src/background-activity/layout.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 真实 pi-tui 输入/宽度工具（与 defaultActivityPresenterUiDependencies 同源）。
const REAL_TUI = {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  visibleWidth,
  truncateToWidth,
  stripTerminalSequences,
};

// 输入序列（与 package 既有 fixture 同一编码约定）。
const ESC = "\x1b";
const ALT_O = "\x1bo";
const ALT_O_KITTY = "\x1b[111;3u";
const ALT_O_KITTY_REPEAT = "\x1b[111;3:2u";
const ALT_O_KITTY_RELEASE = "\x1b[111;3:3u";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const DOWN_KITTY_REPEAT = "\x1b[1;1:2B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const X_KEY = "x";
const X_KITTY_REPEAT = "\x1b[120;1:2u";
const X_KITTY_RELEASE = "\x1b[120;1:3u";
const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";

/** 显示 fixture：冻结行对象（label/state 是显示输入，不含真实任务数据）。 */
function row(kind, key, label, stateLabel = "运行中", placement = "main") {
  return Object.freeze({ key, kind, label, stateLabel, placement });
}

/** 计数型 detail 组件：记录 dispose/invalidate 次数，render 输出固定行。 */
function createCountedComponent(lineCount, marker, options = {}) {
  let disposed = 0;
  let invalidated = 0;
  let renderThrows = false;
  const lines = Array.from({ length: lineCount }, (_, index) => `${marker} 内容行 ${index + 1}`);
  const component = {
    render(width) {
      if (renderThrows) throw new Error("render boom");
      if (options.ansi) return lines.map((line) => `\u001b[31m${line}\u001b[0m${" ".repeat(0)}`);
      return [...lines];
    },
    invalidate() {
      invalidated += 1;
    },
    dispose() {
      disposed += 1;
    },
  };
  return {
    component,
    marker,
    get disposed() {
      return disposed;
    },
    get invalidated() {
      return invalidated;
    },
    failRender() {
      renderThrows = true;
    },
  };
}

/** 可控 deferred detail source：detail 请求手动 resolve，用于 fence/晚回验证。 */
function createDeferredSource(kind, rows) {
  const calls = [];
  const pending = [];
  const listeners = new Set();
  let snapshot = { availability: "available", rows };
  const source = {
    kind,
    snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    detail(key, request) {
      calls.push({ key, request });
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  return {
    source,
    calls,
    setSnapshot(next) {
      snapshot = next;
    },
    invalidate() {
      for (const listener of [...listeners]) listener();
    },
    resolveNext(component) {
      const resolve = pending.shift();
      if (resolve) resolve(component);
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

function createScope() {
  return {
    sessionManager: { marker: "session-manager" },
    sessionId: "session-1",
    token: { marker: "token-1" },
    hostKey: { marker: "host-key-1" },
  };
}

/** 直接 shell fixture（presenter 不参与，聚焦 controller 语义）。 */
function createShellFixture({ sources = [], terminalRows = 24 } = {}) {
  const registry = createActivityRegistry();
  for (const bundle of sources) registry.register(bundle.source);
  const scope = createScope();
  const terminal = { rows: terminalRows };
  let renders = 0;
  let doneCalls = 0;
  let closedCalls = 0;
  const shell = createActivityDetailShell({
    registry,
    scope,
    tui: REAL_TUI,
    onClosed() {
      closedCalls += 1;
    },
  });
  const openShell = () =>
    shell.open({
      getTerminalRows: () => terminal.rows,
      requestRender() {
        renders += 1;
      },
      theme: undefined,
      done() {
        doneCalls += 1;
      },
    });
  return {
    registry,
    scope,
    terminal,
    shell,
    openShell,
    renders: () => renders,
    doneCalls: () => doneCalls,
    closedCalls: () => closedCalls,
    sources,
  };
}

/** presenter fixture：fake ctx.ui（custom 同步执行 factory，与 SDK 行为一致）。 */
function createPresenterFixture({
  sources = [],
  terminalRows = 24,
  throwAt,
  rejectCustom = false,
  mode = "tui",
} = {}) {
  const registry = createActivityRegistry();
  for (const bundle of sources) registry.register(bundle.source);
  const scope = createScope();
  const terminal = { rows: terminalRows };
  const overlayCalls = [];
  const notifications = [];
  let editor = function OriginalEditor() {};
  let draft = "unsent draft";
  const ctx = {
    mode,
    hasUI: mode === "tui",
    cwd: "/repo",
    model: { provider: "anthropic", id: "claude-test", contextWindow: 272_000 },
    getContextUsage: () => ({ tokens: 207_000, contextWindow: 272_000, percent: 76.1 }),
    thinkingLevel: "high",
    sessionManager: scope.sessionManager,
    ui: {
      setFooter() {
        throw new Error("presenter must not call setFooter");
      },
      registerShortcut() {
        throw new Error("presenter must not register shortcuts");
      },
      onTerminalInput() {
        throw new Error("presenter must not install a global terminal input listener");
      },
      getEditorComponent() {
        if (throwAt === "getEditorComponent") throw new Error("get editor failed");
        return editor;
      },
      getEditorText() {
        if (throwAt === "getEditorText") throw new Error("get text failed");
        return draft;
      },
      setEditorComponent(factory) {
        if (throwAt === "setEditorComponent") throw new Error("set editor failed");
        editor = factory;
      },
      setEditorText(text) {
        draft = text;
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
      custom(factory, options) {
        if (throwAt === "custom") throw new Error("custom failed");
        if (rejectCustom) return Promise.reject(new Error("overlay failed"));
        const call = { factory, options, handle: { focusCalls: 0 }, done: 0, component: undefined, renders: 0 };
        call.handle.focus = () => {
          call.handle.focusCalls += 1;
        };
        overlayCalls.push(call);
        call.component = factory(
          { terminal, requestRender() { call.renders += 1; } },
          { fg: (_color, text) => text },
          {},
          () => {
            call.done += 1;
          },
        );
        options?.onHandle?.(call.handle);
        return Promise.resolve();
      },
    },
  };
  const bindings = {
    scope,
    registry,
    ctx,
    fallback: () => {
      throw new Error("fallback must not be used in this fixture");
    },
  };
  const view = createActivityPresenter(bindings, { tui: REAL_TUI });
  return {
    registry,
    scope,
    ctx,
    terminal,
    overlayCalls,
    notifications,
    view,
    get editor() {
      return editor;
    },
    get draft() {
      return draft;
    },
  };
}

// ---------------------------------------------------------------------------
// presenter 表面与接线
// ---------------------------------------------------------------------------

test("presenter 只返回 createFooter/openDetails/dispose，不 setFooter、不注册快捷键", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  assert.deepEqual(
    Object.keys(fixture.view).sort(),
    ["createFooter", "dispose", "openDetails"],
    "MountedActivityView 只暴露三个成员",
  );
  assert.equal(typeof fixture.view.createFooter, "function");
  assert.equal(typeof fixture.view.openDetails, "function");
  assert.equal(typeof fixture.view.dispose, "function");
  // fixture 的 setFooter/registerShortcut/onTerminalInput 均 throw：完整走一遍生命周期
  // 即证明 presenter 从未调用它们。
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  assert.equal(footer.render(80).length, 3, "main footer 元数据1行 + 分隔空行 + 条目1行");
  await fixture.view.openDetails();
  assert.equal(fixture.overlayCalls.length, 1);
  assert.equal(footer.render(80).length, DETAIL_FOOTER_MAX_ROWS, "detail footer 最多 3 行");
  fixture.overlayCalls[0].component.handleInput(ESC);
  fixture.view.dispose();
  assert.equal(fixture.notifications.length, 0, "无失败路径时不 notify");
});

test("curried factory 与默认 UI 依赖：ActivityPresenterFactory 形状可消费", async () => {
  const defaults = defaultActivityPresenterUiDependencies();
  // Key 是 pi-tui 导出的 const 对象（Key.alt/Key.escape 等成员是函数），不是函数本身。
  assert.equal(typeof defaults.tui.Key, "object", "默认依赖包含 Key 常量对象");
  for (const name of ["isKeyRelease", "isKeyRepeat", "matchesKey", "visibleWidth", "truncateToWidth", "stripTerminalSequences"]) {
    assert.equal(typeof defaults.tui[name], "function", `默认依赖包含 ${name}`);
  }
  assert.equal(typeof defaults.tui.Key.alt, "function");
  const factory = activityPresenterFactoryFor({ tui: REAL_TUI });
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  const view = factory({
    scope: fixture.scope,
    registry: fixture.registry,
    ctx: fixture.ctx,
    fallback: () => {
      throw new Error("fallback not used");
    },
  });
  assert.deepEqual(Object.keys(view).sort(), ["createFooter", "dispose", "openDetails"]);
  // presenter 不调 setFooter：footer factory 由 owner（package runtime）显式消费。
  view.createFooter({ terminal: fixture.terminal, requestRender() {} }, { fg: (_color, text) => text }, {});
  await view.openDetails();
  assert.equal(fixture.overlayCalls.length, 1, "curried closure 视图可打开详情");
  view.dispose();
  fixture.view.dispose();
});

test("根 index 只导出已创建模块：协议 re-export、layout、detail-controller、presenter", async () => {
  const rootIndex = await import("../src/background-activity/index.ts");
  assert.equal(typeof rootIndex.createActivityRegistry, "function", "package 协议 re-export");
  assert.equal(typeof rootIndex.renderActivityLayout, "function", "F5a layout");
  assert.equal(typeof rootIndex.createActivityDetailShell, "function", "F5b detail-controller");
  assert.equal(typeof rootIndex.createActivityPresenter, "function", "F5b presenter");
  assert.equal(typeof rootIndex.activityPresenterFactoryFor, "function");
  assert.equal(rootIndex.DETAIL_RESERVED_BOTTOM_ROWS, 4);
  assert.equal(rootIndex.TOO_SMALL_TERMINAL_ROWS, 4);
  assert.equal(rootIndex.DETAIL_FOOTER_MAX_ROWS, 3);
});

// ---------------------------------------------------------------------------
// main footer：metadata/layout + source availability + raw 不变
// ---------------------------------------------------------------------------

test("main footer：cwd/context、连续元数据行、entry 块与 selection 高亮", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const bash = createDeferredSource("bash_async", [row("bash_async", "bash:b", "命令B", "成功(exit 0)")]);
  const rowsBefore = JSON.stringify([subagent.source.snapshot(), bash.source.snapshot()]);
  const fixture = createPresenterFixture({ sources: [subagent, bash] });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  const lines = footer.render(80);
  // §2 冻结合同：元数据连续渲染（不留空 activity 槽），活动区在元数据之后连续绘制。
  assert.equal(lines.length, 4, "meta 1 行 + 分隔空行 + 2 条 entry 块");
  assert.ok(lines[0].includes("/repo") && lines[0].includes("76.1%/272k"), `cwd/context：${lines[0]}`);
  assert.ok(
    lines[0].includes("anthropic/claude-test") && lines[0].includes("high") && lines[0].includes("76.1%/272k"),
    `第一元数据行压缩 provider/model · thinking · context：${lines[0]}`,
  );
  assert.equal(lines[1], "", "常驻元数据与动态内容之间恰一个空行");
  assert.ok(lines[2].includes("任务A") && lines[2].endsWith("运行中"), `entry 块状态真右列：${lines[2]}`);
  assert.ok(lines[3].includes("命令B") && lines[3].includes("成功(exit 0)"), `entry 块：${lines[3]}`);
  assert.ok(!lines.some((line) => line.includes("›")), "未打开过详情时无选中标记");

  // 打开并右移到 B，关闭后主视图恢复选中 key 高亮（搜索焦点返回恢复选中 key）。
  await fixture.view.openDetails();
  fixture.overlayCalls[0].component.handleInput(RIGHT);
  fixture.overlayCalls[0].component.handleInput(ESC);
  const after = footer.render(80);
  const bashLine = after.find((line) => line.includes("命令B"));
  assert.ok(bashLine.startsWith("⌘ "), `关闭后主视图选中 B（selected key 保留但无选择列）：${bashLine}`);
  assert.equal(JSON.stringify([subagent.source.snapshot(), bash.source.snapshot()]), rowsBefore, "raw snapshot 不变");
});

test("source availability：stale/unavailable 独立状态行，旧行不进主视图、不虚构任务", () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const bash = createDeferredSource("bash_async", [row("bash_async", "bash:b", "旧命令", "成功(exit 0)")]);
  bash.setSnapshot({
    availability: "stale",
    rows: [row("bash_async", "bash:b", "旧命令", "成功(exit 0)")],
    observedAt: "2026-10-13T00:00:00Z",
    errorLabel: "30 秒未刷新",
  });
  const scheduler = createDeferredSource("scheduler", []);
  scheduler.setSnapshot({ availability: "unavailable", rows: [], errorLabel: "source 查询失败" });
  const fixture = createPresenterFixture({ sources: [subagent, bash, scheduler] });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  const lines = footer.render(80);
  assert.ok(lines.some((line) => line.includes("⌘") && line.includes("过期观察") && line.includes("30 秒未刷新")), "stale 独立状态行");
  assert.ok(lines.some((line) => line.includes("⏱") && line.includes("暂不可用")), "unavailable 独立状态行");
  assert.ok(!lines.some((line) => line.includes("旧命令")), "stale 旧行不进入主视图");
  assert.ok(lines.some((line) => line.includes("任务A")), "available 行正常显示");
});

// ---------------------------------------------------------------------------
// openDetails / overlay / editor/draft
// ---------------------------------------------------------------------------

test("openDetails：静态 overlay options、focus、editor 替换、detail 首请求 expanded=false", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  const originalEditor = fixture.editor;
  await fixture.view.openDetails();
  assert.equal(fixture.overlayCalls.length, 1, "custom 恰好一次");
  assert.equal(fixture.overlayCalls[0].options.overlay, true);
  assert.deepEqual(fixture.overlayCalls[0].options.overlayOptions, {
    row: 0,
    col: 0,
    width: "100%",
    maxHeight: "100%",
    margin: { bottom: DETAIL_RESERVED_BOTTOM_ROWS },
  }, "静态 overlayOptions（margin.bottom=4，无动态函数）");
  assert.equal(typeof fixture.overlayCalls[0].options.onHandle, "function");
  assert.equal(fixture.overlayCalls[0].handle.focusCalls, 1, "overlay handle focus 一次");
  assert.notEqual(fixture.editor, originalEditor, "editor 已替换为只读 factory");
  assert.equal(fixture.draft, "unsent draft", "draft 未被改写");
  assert.equal(subagent.calls.length, 1, "detail 首请求一次");
  assert.equal(subagent.calls[0].key, "subagent:a");
  assert.equal(subagent.calls[0].request.expanded, false, "初始 expanded=false");
  assert.equal(typeof subagent.calls[0].request.requestRender, "function");
  assert.equal(footer.render(80).length, 3, "footer 切换 detail mode（<=3 行）");
  assert.equal(footer.render(80)[0].includes("1/1"), true, "detail footer 显示条目位置");

  const first = createCountedComponent(10, "A1");
  subagent.resolveNext(first.component);
  await flush();
  const body = fixture.overlayCalls[0].component.render(80);
  assert.ok(body.some((line) => line.includes("A1 内容行 1")), "组件内容进入正文");

  // 已挂载时重复 openDetails 无效果（不重复挂载/remount）。
  await fixture.view.openDetails();
  assert.equal(fixture.overlayCalls.length, 1);
  fixture.view.dispose();
});

test("Esc 关闭：done 一次、editor/draft 恢复、footer 回 main mode；重复 Esc 幂等", async () => {
  const subagent = createDeferredSource("subagent", [
    row("subagent", "subagent:a", "任务A"),
    row("subagent", "subagent:b", "任务B"),
  ]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  const originalEditor = fixture.editor;
  await fixture.view.openDetails();
  subagent.resolveNext(createCountedComponent(10, "A1").component);
  await flush();
  fixture.overlayCalls[0].component.handleInput(ESC);
  assert.equal(fixture.overlayCalls[0].done, 1, "done 恰好一次");
  assert.equal(fixture.editor, originalEditor, "editor 恢复");
  assert.equal(fixture.draft, "unsent draft", "draft 恢复");
  assert.ok(footer.render(80).length >= 3 && !footer.render(80)[0].includes("1/2"), "footer 回 main mode");
  // Esc 不传播：关闭后同一组件再收 Esc 只是无效果 consume，不产生第二个 done。
  fixture.overlayCalls[0].component.handleInput(ESC);
  assert.equal(fixture.overlayCalls[0].done, 1, "重复 Esc 不重复关闭");
  assert.equal(fixture.editor, originalEditor);
  // 重开后选中 key 恢复（默认第一项），Alt+O 也可关闭。
  await fixture.view.openDetails();
  assert.equal(fixture.overlayCalls.length, 2, "恢复后可重开");
  assert.equal(subagent.calls.length, 2, "重开按恢复的选中 key 重新请求");
  assert.equal(subagent.calls[1].key, "subagent:a");
  fixture.overlayCalls[1].component.handleInput(ALT_O_KITTY);
  assert.equal(fixture.overlayCalls[1].done, 1, "Alt+O（kitty 编码）关闭");
  fixture.view.dispose();
});

test("too-small：开前不挂 overlay、不改 editor/draft；恢复尺寸后可重开", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent], terminalRows: 4 });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  const originalEditor = fixture.editor;
  await fixture.view.openDetails();
  assert.equal(fixture.overlayCalls.length, 0, "terminalRows<=4 不挂 overlay");
  assert.equal(fixture.editor, originalEditor, "editor 不切换");
  assert.equal(fixture.draft, "unsent draft", "draft 不动");
  assert.equal(subagent.calls.length, 0, "未发起详情请求");
  // terminalRows=4：主视图预算 max(0, 4-6)=0，footer 无物理行，不虚构内容。
  assert.equal(footer.render(80).length, 0, "footer 保持 main mode 且预算为 0");
  // 恢复尺寸后可重开。
  fixture.terminal.rows = 24;
  await fixture.view.openDetails();
  assert.equal(fixture.overlayCalls.length, 1, "恢复后可重开");
  assert.notEqual(fixture.editor, originalEditor);
  fixture.view.dispose();
});

test("打开中变小：正文空数组、关闭输入仍可用、无负高度；resize 不双扣且不 remount", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  fixture.view.createFooter({ terminal: fixture.terminal, requestRender() {} }, { fg: (_color, text) => text }, {});
  await fixture.view.openDetails();
  subagent.resolveNext(createCountedComponent(10, "A1").component);
  await flush();
  // 24 行终端：terminalRows-4=20（1 滚动信息行 + 19 正文），不得再扣详情 footer 3 行。
  assert.equal(fixture.overlayCalls[0].component.render(80).length, 20, "高度 = terminalRows-4，不双扣");
  // resize 变小：每 render 实时适应，不 remount。
  fixture.terminal.rows = 10;
  assert.equal(fixture.overlayCalls[0].component.render(80).length, 6, "10 行终端 → 6 行（bodyBudget 6：1 滚动信息行 + 5 正文）");
  fixture.terminal.rows = 5;
  assert.equal(fixture.overlayCalls[0].component.render(80).length, 1, "5 行终端 → 仅滚动信息行 1 行");
  fixture.terminal.rows = TOO_SMALL_TERMINAL_ROWS;
  assert.deepEqual(fixture.overlayCalls[0].component.render(80), [], "4 行终端 → 正文空（无负高度）");
  assert.equal(fixture.overlayCalls.length, 1, "resize 不触发 remount");
  // 关闭输入仍可用。
  fixture.overlayCalls[0].component.handleInput(ESC);
  assert.equal(fixture.overlayCalls[0].done, 1);
  fixture.view.dispose();
});

test("editor/draft 获取与替换失败：保持关闭、固定文案 notify 一次", async () => {
  for (const throwAt of ["getEditorComponent", "getEditorText", "setEditorComponent", "custom"]) {
    const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
    const fixture = createPresenterFixture({ sources: [subagent], throwAt });
    fixture.view.createFooter({ terminal: fixture.terminal, requestRender() {} }, { fg: (_color, text) => text }, {});
    await fixture.view.openDetails();
    assert.equal(fixture.overlayCalls.length, 0, `未挂载（${throwAt}）`);
    assert.equal(fixture.notifications.length, 1, `notify 恰好一次（${throwAt}）`);
    assert.equal(fixture.notifications[0].message, "后台活动详情打开失败", "固定文案，不透传异常正文");
    fixture.view.dispose();
  }
});

test("custom 拒绝：rollback 恢复 editor/draft 并 notify 一次", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent], rejectCustom: true });
  const originalEditor = fixture.editor;
  fixture.view.createFooter({ terminal: fixture.terminal, requestRender() {} }, { fg: (_color, text) => text }, {});
  await fixture.view.openDetails();
  await flush();
  assert.equal(fixture.editor, originalEditor, "editor 回滚恢复");
  assert.equal(fixture.draft, "unsent draft", "draft 不变");
  assert.equal(fixture.notifications.length, 1, "notify 一次");
  fixture.view.dispose();
});

test("dispose：关闭 overlay、恢复 editor、退订 registry、幂等", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  const originalEditor = fixture.editor;
  await fixture.view.openDetails();
  const component = createCountedComponent(10, "A1");
  subagent.resolveNext(component.component);
  await flush();
  fixture.view.dispose();
  assert.equal(fixture.overlayCalls[0].done, 1, "dispose 关闭 overlay");
  assert.equal(fixture.editor, originalEditor, "dispose 恢复 editor");
  assert.equal(component.disposed, 1, "当前详情组件 dispose 一次");
  // 退订后 source invalidate 不再触发任何动作（不抛错、无新请求）。
  subagent.invalidate();
  await flush();
  assert.equal(subagent.calls.length, 1);
  // dispose 幂等。
  fixture.view.dispose();
  assert.equal(fixture.overlayCalls[0].done, 1);
  assert.ok(Array.isArray(footer.render(80)));
});

test("空 registry：open 显示空状态、Esc 可关、不虚构任务", async () => {
  const fixture = createPresenterFixture({});
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  await fixture.view.openDetails();
  assert.equal(fixture.overlayCalls.length, 1);
  const lines = fixture.overlayCalls[0].component.render(80);
  assert.ok(lines.some((line) => line.includes("当前无后台活动")), "空状态正文");
  assert.ok(lines[0].includes("当前无后台活动"), `空态时 header 不留行，首行就是正文空态：${lines[0]}`);
  assert.equal(lines.length, 24 - DETAIL_RESERVED_BOTTOM_ROWS, "空态也按 terminalRows-4 铺满（不双扣 footer）");
  assert.equal(lines[0].includes("行 "), false, `空态不得渲染滚动信息行（无可滚动内容）：${lines[0]}`);
  assert.ok(footer.render(80)[0].includes("当前无后台活动"), "detail footer 空状态行");
  fixture.overlayCalls[0].component.handleInput(ESC);
  assert.equal(fixture.overlayCalls[0].done, 1, "空状态仍可关闭");
  fixture.view.dispose();
});

// ---------------------------------------------------------------------------
// 详情请求生命周期：fence / x / source invalidate / theme / dispose 幂等
// ---------------------------------------------------------------------------

test("state 机：closed → loading → open → closed；markTooSmall → too-small", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createShellFixture({ sources: [subagent] });
  assert.equal(fixture.shell.state, "closed");
  fixture.openShell();
  assert.equal(fixture.shell.state, "loading", "首请求在途");
  assert.ok(fixture.shell.render(80).some((line) => line.includes("加载中…")));
  const component = createCountedComponent(10, "A1");
  subagent.resolveNext(component.component);
  await flush();
  assert.equal(fixture.shell.state, "open");
  fixture.shell.close();
  assert.equal(fixture.shell.state, "closed");
  assert.equal(fixture.doneCalls(), 1);
  assert.equal(fixture.closedCalls(), 1, "onClosed 每次 open 周期恰好一次");

  const small = createShellFixture({ sources: [subagent] });
  small.shell.markTooSmall();
  assert.equal(small.shell.state, "too-small");
  small.terminal.rows = 24;
  small.openShell();
  assert.equal(small.shell.state, "loading", "恢复尺寸后可重开");
});

test("晚回 fence：过期请求的组件 dispose 一次且不应用", async () => {
  const subagent = createDeferredSource("subagent", [
    row("subagent", "subagent:a", "任务A"),
    row("subagent", "subagent:b", "任务B"),
  ]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  assert.equal(subagent.calls.length, 1);
  fixture.shell.handleInput(RIGHT); // 切到 B：旧请求仍在途
  assert.equal(subagent.calls.length, 2);
  const late = createCountedComponent(10, "LATE");
  subagent.resolveNext(late.component); // 晚回的是 A 的请求
  await flush();
  assert.equal(late.disposed, 1, "晚回组件 dispose 一次");
  assert.ok(fixture.shell.render(80).some((line) => line.includes("加载中…")), "晚回不覆盖当前选择");
  const current = createCountedComponent(10, "B1");
  subagent.resolveNext(current.component);
  await flush();
  assert.ok(fixture.shell.render(80).some((line) => line.includes("B1 内容行")), "当前请求正常应用");
  assert.equal(current.disposed, 0);
});

test("x 展开重取：同 key 新请求 expanded=true、旧组件保留到新到达、dispose 一次、anchor 保持", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  const first = createCountedComponent(30, "A1");
  subagent.resolveNext(first.component);
  await flush();
  assert.equal(fixture.shell.position().start, 12, "30 行内容 autoFollow 底部（1-based）");
  fixture.shell.handleInput(HOME);
  assert.equal(fixture.shell.position().start, 1, "手动滚动到顶部");
  assert.equal(fixture.shell.position().autoFollow, false);
  fixture.shell.handleInput(X_KEY);
  assert.equal(subagent.calls.length, 2, "x 触发同 key 新请求");
  assert.equal(subagent.calls[1].key, "subagent:a");
  assert.equal(subagent.calls[1].request.expanded, true, "新请求 expanded=true");
  assert.ok(fixture.shell.render(80).some((line) => line.includes("A1 内容行")), "旧组件保留到新组件到达");
  assert.equal(first.disposed, 0, "替换前不 dispose");
  const second = createCountedComponent(30, "A2");
  subagent.resolveNext(second.component);
  await flush();
  assert.equal(first.disposed, 1, "旧组件替换时 dispose 一次");
  assert.ok(fixture.shell.render(80).some((line) => line.includes("A2 内容行")));
  assert.equal(fixture.shell.position().start, 1, "scroll anchor 保持（手动顶部不被重置）");
  assert.equal(fixture.shell.expanded(), true);
});

test("x repeat/release 忽略：按住 x 不连续切换", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  subagent.resolveNext(createCountedComponent(10, "A1").component);
  await flush();
  assert.deepEqual(fixture.shell.handleInput(X_KITTY_REPEAT), { consume: true });
  assert.deepEqual(fixture.shell.handleInput(X_KITTY_RELEASE), { consume: true });
  assert.equal(fixture.shell.expanded(), false, "repeat/release 不切换展开");
  assert.equal(subagent.calls.length, 1, "repeat 不发起新请求");
});

test("重取合法返回 undefined：旧组件不保留，正文显示该任务暂无详情", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  const first = createCountedComponent(10, "A1");
  subagent.resolveNext(first.component);
  await flush();
  assert.ok(fixture.shell.render(80).some((line) => line.includes("A1 内容行")));
  // x 重取后 source 合法返回 undefined：旧组件被 dispose，不保留过期展示。
  fixture.shell.handleInput(X_KEY);
  subagent.resolveNext(undefined);
  await flush();
  assert.equal(first.disposed, 1, "旧组件 dispose 一次");
  assert.ok(fixture.shell.render(80).some((line) => line.includes("该任务暂无详情")));
});

test("registry invalidate 重取保 anchor；同 kind source 对象替换同 key 也发新请求", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  await fixture.view.openDetails();
  const first = createCountedComponent(30, "A1");
  subagent.resolveNext(first.component);
  await flush();
  fixture.overlayCalls[0].component.handleInput(HOME);
  assert.ok(footer.render(80)[1].includes("行 1-19/30"), `anchor 到顶：${footer.render(80)[1]}`);
  // source invalidate → registry notify → presenter 转发 shell 重取。
  subagent.invalidate();
  await flush();
  assert.equal(subagent.calls.length, 2, "invalidate 触发重取");
  assert.ok(footer.render(80)[1].includes("行 1-19/30"), "重取请求在途时 anchor 保持");
  const second = createCountedComponent(30, "A2");
  subagent.resolveNext(second.component);
  await flush();
  assert.equal(first.disposed, 1, "替换 dispose 一次");
  assert.ok(footer.render(80)[1].includes("行 1-19/30"), "新组件到达后 anchor 仍保持");
  // 同 kind source 对象替换（同 key）：即使 key 相同也按新 source 发起新请求。
  const replacement = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  fixture.registry.register(replacement.source);
  await flush();
  assert.equal(replacement.calls.length, 1, "新 source 对象接手同 key 请求");
  assert.equal(replacement.calls[0].key, "subagent:a");
  const third = createCountedComponent(30, "A3");
  replacement.resolveNext(third.component);
  await flush();
  assert.equal(second.disposed, 1);
  assert.ok(footer.render(80)[1].includes("行 1-19/30"), "source 替换后 anchor 仍保持");
  fixture.view.dispose();
});

test("主题身份变化：footer factory 以新 theme 对象重入 → 重取详情；同对象重入不重取", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createPresenterFixture({ sources: [subagent] });
  const themeA = { fg: (_color, text) => text };
  fixture.view.createFooter({ terminal: fixture.terminal, requestRender() {} }, themeA, {});
  await fixture.view.openDetails();
  subagent.resolveNext(createCountedComponent(10, "A1").component);
  await flush();
  assert.equal(subagent.calls.length, 1);
  // owner 重新安装 footer（同 theme 身份）：不重取。
  fixture.view.createFooter({ terminal: fixture.terminal, requestRender() {} }, themeA, {});
  await flush();
  assert.equal(subagent.calls.length, 1, "同 theme 对象重入不重取");
  // 主题切换后 owner 以新 theme 对象重装 footer：重取详情保 anchor。
  fixture.view.createFooter({ terminal: fixture.terminal, requestRender() {} }, { fg: (_color, text) => text }, {});
  await flush();
  assert.equal(subagent.calls.length, 2, "新 theme 对象重入触发重取");
  subagent.resolveNext(createCountedComponent(10, "A2").component);
  await flush();
  assert.ok(fixture.overlayCalls[0].component.render(80).some((line) => line.includes("A2 内容行")));
  fixture.view.dispose();
});

test("detail 失败与成功混合：失败保留已确认组件/固定失败文案，同步 throw 同样隔离", async () => {
  // 异步 reject：无可展示组件时正文显示固定失败文案，不透传异常正文。
  const failing = {
    source: {
      kind: "bash_async",
      snapshot: () => ({ availability: "available", rows: [row("bash_async", "bash:b", "命令B")] }),
      subscribe() {
        return () => undefined;
      },
      detail() {
        return Promise.reject(new Error("detail boom"));
      },
    },
  };
  const fixtureA = createShellFixture({ sources: [failing] });
  fixtureA.openShell();
  await flush();
  assert.ok(fixtureA.shell.render(80).some((line) => line.includes("详情读取失败")), "固定失败文案");
  fixtureA.shell.close();

  // 同步 throw：同样走失败路径，不向调用方传播。
  const throwing = {
    source: {
      kind: "bash_async",
      snapshot: () => ({ availability: "available", rows: [row("bash_async", "bash:b", "命令B")] }),
      subscribe() {
        return () => undefined;
      },
      detail() {
        throw new Error("sync detail boom");
      },
    },
  };
  const fixtureB = createShellFixture({ sources: [throwing] });
  fixtureB.openShell();
  await flush();
  assert.ok(fixtureB.shell.render(80).some((line) => line.includes("详情读取失败")));
  fixtureB.shell.close();

  // provider render 瞬态失败：保留上次确认行，不改 raw。
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixtureC = createShellFixture({ sources: [subagent] });
  fixtureC.openShell();
  const first = createCountedComponent(10, "A1");
  subagent.resolveNext(first.component);
  await flush();
  assert.ok(
    fixtureC.shell.render(80).some((line) => line.includes("A1 内容行")),
    "先成功渲染一次",
  );
  first.failRender();
  assert.ok(
    fixtureC.shell.render(80).some((line) => line.includes("A1 内容行")),
    "provider render 瞬态失败保留上次确认行",
  );
});

test("provider render/invalidate 仅 display：ANSI 保留、按宽截断补空、行数组不改写", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  const ansi = createCountedComponent(3, "ANSI", { ansi: true });
  subagent.resolveNext(ansi.component);
  await flush();
  const lines = fixture.shell.render(40);
  // 标题 1 行（滚动信息）+ 正文 3 行（顶部对齐）+ 补空 16 行 = 20。
  // 位置行/键位提示行恒为单行（不参与换行展开），width=40 时 footer 仍为 3 行、动态 reserve 为 4。
  assert.equal(lines.length, 20);
  const bodyLines = lines.slice(1);
  for (const line of bodyLines) {
    assert.ok(visibleWidth(line) <= 40, `行宽不越界：${JSON.stringify(line)}`);
  }
  assert.ok(bodyLines.some((line) => line.includes("\u001b[31m")), "provider ANSI 主题色保留");
  assert.ok(bodyLines[0].includes("ANSI 内容行 1"), "正文首行来自 provider（顶部对齐，不足高度在下方补空）");
  // invalidate 转发给 provider 组件（display 缓存清理）。
  fixture.shell.invalidate();
  assert.equal(ansi.invalidated, 1);
  // provider 行数组不被改写：render 输出是新数组。
  const again = fixture.shell.render(40);
  assert.notEqual(again, lines);
  assert.equal(ansi.component.render(40).length, 3);
});

// ---------------------------------------------------------------------------
// 导航与输入语义（直接 shell）
// ---------------------------------------------------------------------------

test("导航覆盖 main/recent 全量与 stale 分组，kind 固定顺序、key 身份", async () => {
  const subagent = createDeferredSource("subagent", [
    row("subagent", "subagent:a", "任务A"),
    row("subagent", "subagent:r1", "旧任务1", "已完成", "recent"),
    row("subagent", "subagent:r2", "旧任务2", "已完成", "recent"),
  ]);
  const bash = createDeferredSource("bash_async", [row("bash_async", "bash:b", "命令B")]);
  const scheduler = createDeferredSource("scheduler", [row("scheduler", "scheduler:s", "旧定时", "等待触发")]);
  scheduler.setSnapshot({
    availability: "stale",
    rows: [row("scheduler", "scheduler:s", "旧定时", "等待触发")],
    observedAt: "2026-10-13T00:00:00Z",
  });
  const fixture = createShellFixture({ sources: [subagent, bash, scheduler] });
  fixture.openShell();
  assert.equal(fixture.shell.entries().length, 5, "main+recent 全量 + stale 分组");
  assert.deepEqual(
    fixture.shell.entries().map((entry) => entry.key),
    ["subagent:a", "subagent:r1", "subagent:r2", "bash:b", "scheduler:s"],
    "kind 固定顺序（subagent→bash_async→scheduler），recent 不受主视图历史折叠影响",
  );
  assert.equal(fixture.shell.selectedKey(), "subagent:a");
  // 跨类型连续右移到 stale 分组末尾；在途详情请求不阻断导航。
  for (let step = 0; step < 4; step += 1) {
    fixture.shell.handleInput(RIGHT);
  }
  assert.equal(fixture.shell.selectedKey(), "scheduler:s", "右移到 stale 分组条目");
  const header = fixture.shell.render(80)[0];
  assert.equal(header.includes("›"), false, `header 不再渲染身份行：${header}`);
  assert.equal(header.includes("旧定时"), false, `header 不再渲染 label：${header}`);
  assert.ok(header.includes("过期观察"), `stale 条目在 header 滚动信息行上标记：${header}`);
  assert.ok(header.includes("行 ") && header.includes("x 展开"), `header 只剩滚动信息行：${header}`);
  // 左移回到 bash（跨 kind 导航）。
  fixture.shell.handleInput(LEFT);
  assert.equal(fixture.shell.selectedKey(), "bash:b");
  // 连续左移逐项回到首项（相邻条目导航），到达首项后再左移钳制在首项。
  fixture.shell.handleInput(LEFT);
  assert.equal(fixture.shell.selectedKey(), "subagent:r2");
  fixture.shell.handleInput(LEFT);
  assert.equal(fixture.shell.selectedKey(), "subagent:r1");
  fixture.shell.handleInput(LEFT);
  assert.equal(fixture.shell.selectedKey(), "subagent:a");
  fixture.shell.handleInput(LEFT);
  assert.equal(fixture.shell.selectedKey(), "subagent:a", "边界：左移钳制在首项");
});

test("同 label 异 key 不去重；stable key 消失选择相邻项或空状态", async () => {
  const subagent = createDeferredSource("subagent", [
    row("subagent", "subagent:x1", "同名任务"),
    row("subagent", "subagent:x2", "同名任务"),
  ]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  assert.equal(fixture.shell.entries().length, 2, "同 label 异 key 共存");
  fixture.shell.handleInput(RIGHT);
  subagent.resolveNext(undefined);
  await flush();
  assert.equal(fixture.shell.selectedKey(), "subagent:x2");
  // x2 消失：选择相邻项（按上次索引钳制到 x1），不按标题复活。
  subagent.setSnapshot({ availability: "available", rows: [row("subagent", "subagent:x1", "同名任务")] });
  fixture.shell.handleRegistryInvalidated();
  assert.equal(fixture.shell.selectedKey(), "subagent:x1");
  assert.equal(subagent.calls.at(-1).key, "subagent:x1", "相邻项发起新请求");
  // 全部消失：空状态。
  subagent.setSnapshot({ availability: "available", rows: [] });
  fixture.shell.handleRegistryInvalidated();
  assert.equal(fixture.shell.selectedKey(), undefined);
  assert.ok(fixture.shell.render(80).some((line) => line.includes("当前无后台活动")));
});

test("输入语义：导航键 repeat 重复、release 忽略、未知吞掉、关闭键不重复 dispose", async () => {
  const subagent = createDeferredSource("subagent", [
    row("subagent", "subagent:a", "任务A"),
    row("subagent", "subagent:b", "任务B"),
  ]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  const component = createCountedComponent(30, "A1");
  subagent.resolveNext(component.component);
  await flush();
  // 30 行内容、高度 19（24-4-1 滚动信息行）：autoFollow 底部 start=11（1-based 12）。
  assert.equal(fixture.shell.position().start, 12);
  // 未知键吞掉。
  assert.deepEqual(fixture.shell.handleInput("q"), { consume: true });
  assert.deepEqual(fixture.shell.handleInput("\x01"), { consume: true });
  assert.equal(fixture.doneCalls(), 0);
  // repeat 允许重复导航：down repeat 滚动。
  assert.deepEqual(fixture.shell.handleInput(DOWN_KITTY_REPEAT), { consume: true });
  // release 忽略：Esc release 不关闭。
  assert.deepEqual(fixture.shell.handleInput("\x1b[27;1:3u"), { consume: true });
  assert.equal(fixture.doneCalls(), 0);
  // Alt+O repeat/release 不关闭；右移发起 b 的详情请求（在途），press 关闭一次。
  fixture.shell.handleInput(RIGHT);
  assert.deepEqual(fixture.shell.handleInput(ALT_O_KITTY_REPEAT), { consume: true });
  assert.deepEqual(fixture.shell.handleInput(ALT_O_KITTY_RELEASE), { consume: true });
  assert.equal(fixture.doneCalls(), 0);
  assert.deepEqual(fixture.shell.handleInput(ALT_O), { consume: true });
  assert.equal(fixture.doneCalls(), 1, "Alt+O 关闭一次");
  assert.equal(component.disposed, 1, "关闭 dispose 一次");
  // 关闭后的晚回请求被 fence 丢弃。
  const late = createCountedComponent(10, "LATE");
  subagent.resolveNext(late.component);
  await flush();
  assert.equal(late.disposed, 1, "关闭后晚回组件 dispose 一次");
});

test("滚动与 wheel：autoFollow/manual、j/k、page/home/end、SGR 轨球", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createShellFixture({ sources: [subagent] });
  fixture.openShell();
  subagent.resolveNext(createCountedComponent(30, "A1").component);
  await flush();
  // 高度 19、30 行内容：maxStart=11。
  assert.deepEqual(fixture.shell.position(), { start: 12, end: 30, total: 30, autoFollow: true });
  fixture.shell.handleInput(UP);
  // start 0-based 10 → 1-based 11；end = min(30, 10+19) = 29（可见窗口 11..29 行）。
  assert.deepEqual(fixture.shell.position(), { start: 11, end: 29, total: 30, autoFollow: false });
  assert.deepEqual(fixture.shell.handleInput(WHEEL_UP), { consume: true });
  assert.equal(fixture.shell.position().start, 10, "SGR 轨球向上滚动");
  assert.deepEqual(fixture.shell.handleInput(WHEEL_DOWN), { consume: true });
  assert.equal(fixture.shell.position().start, 11, "SGR 轨球向下滚动");
  fixture.shell.handleInput("k");
  assert.equal(fixture.shell.position().start, 10, "k 向上");
  fixture.shell.handleInput("j");
  assert.equal(fixture.shell.position().start, 11, "j 向下");
  fixture.shell.handleInput(PAGE_UP);
  assert.equal(fixture.shell.position().start, 1, "PgUp 到顶（0-based 0）");
  fixture.shell.handleInput(PAGE_DOWN);
  assert.deepEqual(fixture.shell.position(), { start: 12, end: 30, total: 30, autoFollow: true }, "PgDn 回到跟随底部");
  fixture.shell.handleInput(HOME);
  assert.equal(fixture.shell.position().start, 1);
  fixture.shell.handleInput(END);
  assert.equal(fixture.shell.position().autoFollow, true, "End 回到跟随底部");
  // 轮球方向解析 helper。
  assert.equal(parseSgrWheelDirection(WHEEL_UP), -1);
  assert.equal(parseSgrWheelDirection(WHEEL_DOWN), 1);
  assert.equal(parseSgrWheelDirection("\x1b[<0;1;1M"), undefined);
  assert.equal(parseSgrWheelDirection("x"), undefined);
});

test("geometry：正文预算 = terminalRows-4-标题实际行数，不双扣 footer；窄宽不越界", async () => {
  const subagent = createDeferredSource("subagent", [row("subagent", "subagent:a", "任务A")]);
  const fixture = createShellFixture({ sources: [subagent], terminalRows: 24 });
  fixture.openShell();
  subagent.resolveNext(createCountedComponent(10, "A1").component);
  await flush();
  assert.equal(fixture.shell.render(40).length, 20, "宽度 40 时单行 chrome 不涨 reserve，正文不重叠");
  const headerOnly = fixture.shell.render(80).slice(0, 2);
  assert.equal(headerOnly[0].includes("›"), false, `标题不得再有身份行（›）：${headerOnly[0]}`);
  assert.equal(headerOnly[0].includes("任务A"), false, `标题不得再渲染 label：${headerOnly[0]}`);
  assert.equal(headerOnly[0].includes("运行中"), false, `标题不得再渲染 state：${headerOnly[0]}`);
  assert.ok(
    headerOnly[0].includes("行 1-10/10") && headerOnly[0].includes("x 展开"),
    `标题只剩滚动信息行：${headerOnly[0]}`,
  );
  assert.ok(headerOnly[1].includes("A1 内容行 1"), `身份行删除后正文紧随标题：${headerOnly[1]}`);
  fixture.terminal.rows = 10;
  assert.equal(fixture.shell.render(80).length, 6, "10 行 → 6（bodyBudget 6：1 滚动信息行 + 5 正文）");
  fixture.terminal.rows = 6;
  assert.equal(fixture.shell.render(80).length, 2, "6 行 → 2（bodyBudget 2：1 滚动信息行 + 1 正文）");
  assert.ok(fixture.shell.render(80)[0].includes("x 展开"), "bodyBudget 2 时滚动信息行仍保留");
  fixture.terminal.rows = 5;
  assert.equal(fixture.shell.render(80).length, 1, "5 行 → 1（bodyBudget 1：仅滚动信息行）");
  assert.ok(fixture.shell.render(80)[0].includes("跟随底部"), "小终端下 bodyBudget 门控仍成立");
  fixture.terminal.rows = 0;
  assert.deepEqual(fixture.shell.render(80), []);
  // 窄宽：标题行按终端列截断不越界。
  fixture.terminal.rows = 24;
  for (const line of fixture.shell.render(8)) {
    assert.ok(visibleWidth(line) <= 8, `窄宽行不越界：${JSON.stringify(line)}`);
  }
});

test("header 不渲染身份行：label/state/模型全由 detail footer 首行承载，缺省不留悬空分隔", async () => {
  const withMeta = Object.freeze({
    key: "subagent:m", kind: "subagent", label: "任务M", stateLabel: "运行中", placement: "main",
    metaLabel: "模型 (codex-pool) gpt-6.1-sol · thinking: high",
  });
  const withoutMeta = Object.freeze({
    key: "subagent:n", kind: "subagent", label: "任务N", stateLabel: "已完成", placement: "main",
  });
  const subagent = createDeferredSource("subagent", [withMeta, withoutMeta]);
  const fixture = createPresenterFixture({ sources: [subagent], terminalRows: 24 });
  const footer = fixture.view.createFooter(
    { terminal: fixture.terminal, requestRender() {} },
    { fg: (_color, text) => text },
    {},
  );
  await fixture.view.openDetails();
  subagent.resolveNext(createCountedComponent(4, "M1").component);
  await flush();
  const component = fixture.overlayCalls[0].component;
  const header = component.render(80)[0];
  // 新合同：overlay header 只有滚动信息行，不再有 `› glyph label · state · meta` 身份行。
  assert.equal(header.includes("›"), false, `header 不得再有身份行前缀：${header}`);
  assert.equal(header.includes("任务M"), false, `header 不得再渲染 label：${header}`);
  assert.equal(header.includes("运行中"), false, `header 不得再渲染 state：${header}`);
  assert.equal(header.includes("模型"), false, `header 不得再渲染模型段：${header}`);
  assert.ok(header.includes("行 1-4/4") && header.includes("x 展开"), `header 只剩滚动信息行：${header}`);
  // 同一事实搬到 detail footer 首行（`n/N glyph label · state` + 可选 ` · metaLabel`）。
  const footerLines = footer.render(80);
  const footerFirst = footerLines[0];
  assert.equal(footerFirst, "1/2 ● 任务M · 模型 (codex-pool) gpt-6.1-sol · thinking: high", `footer 首行承载身份：${footerFirst}`);
  assert.ok(
    footerFirst.includes("模型 (codex-pool) gpt-6.1-sol") && footerFirst.includes("thinking: high"),
    `footer 首行承载模型/thinking：${footerFirst}`,
  );
  // 追加模型段不得挤掉既有 3 行（位置行 + 键位提示行）。
  assert.equal(footerLines.length, 3, "宽度 80 下详情 footer 仍为 3 行");
  assert.ok(footerLines[1].includes("行 1-4/4") && footerLines[1].includes("x 展开"), `位置行仍在：${footerLines[1]}`);
  assert.ok(footerLines[2].includes("Esc/Alt+O 关闭"), `键位提示行仍在：${footerLines[2]}`);
  // 切到没有 metaLabel 的行：footer 跟随新身份，不出现模型段，也不留悬空 `·`。
  component.handleInput(RIGHT);
  subagent.resolveNext(createCountedComponent(4, "N1").component);
  await flush();
  const secondHeader = component.render(80)[0];
  assert.equal(secondHeader.includes("任务M"), false, `切行后 header 仍无身份段：${secondHeader}`);
  assert.equal(secondHeader.includes("模型"), false, `切行后 header 仍无模型段：${secondHeader}`);
  assert.equal(secondHeader.includes("··"), false, `不得遗留空分隔：${secondHeader}`);
  const secondFooter = footer.render(80)[0];
  assert.equal(secondFooter, "2/2 ● 任务N · 已完成", `无 metaLabel 时 footer 不追加任何段：${JSON.stringify(secondFooter)}`);
  assert.equal(secondFooter.includes("模型"), false, `无 metaLabel 时不得出现模型段：${secondFooter}`);
  assert.equal(/\s·$/.test(secondFooter), false, `尾部不得悬空分隔：${JSON.stringify(secondFooter)}`);
  // 窄宽仍按终端列截断（header + footer），不越界。
  for (const line of [...component.render(24), ...footer.render(24)]) {
    assert.ok(visibleWidth(line) <= 24, `窄宽行不越界：${JSON.stringify(line)}`);
  }
  component.handleInput(ESC);
  fixture.view.dispose();
});

test("raw 不变：行对象冻结、请求对象形状固定、registry/source 状态不被改写", async () => {
  const rows = [
    Object.freeze(row("subagent", "subagent:a", "\u001b[31m红\u001b[0m色任务", "运行中")),
  ];
  const subagent = createDeferredSource("subagent", rows);
  const fixture = createShellFixture({ sources: [subagent] });
  const before = JSON.stringify({ rows, snapshot: subagent.source.snapshot() });
  fixture.openShell();
  subagent.resolveNext(createCountedComponent(5, "A1").component);
  await flush();
  fixture.shell.handleInput(RIGHT);
  fixture.shell.handleInput(X_KEY);
  fixture.shell.render(80);
  fixture.shell.handleRegistryInvalidated();
  fixture.shell.close();
  assert.equal(JSON.stringify({ rows, snapshot: subagent.source.snapshot() }), before, "raw 行与快照不变");
  assert.ok(Object.isFrozen(rows[0]), "行对象保持冻结");
  const request = subagent.calls[0].request;
  assert.deepEqual(Object.keys(request).sort(), ["expanded", "requestRender"], "DetailRequest 形状固定");
  assert.equal(request.expanded, false);
  assert.equal(typeof request.requestRender, "function");
  // registry 状态未被 shell 改写（sourceSnapshot 仍透传 availability）。
  assert.equal(fixture.registry.sourceSnapshot("subagent").availability, "available");
});
