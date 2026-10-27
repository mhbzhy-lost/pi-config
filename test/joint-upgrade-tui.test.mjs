import assert from "node:assert/strict";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
const { jiti, piTui } = await loadPiTestRuntime(import.meta.url);
const { createCompactToolRenderers } = await jiti.import("../src/compact-tools/renderer.ts");
const { SubagentTranscriptViewport, parseSgrWheelDirection } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/session-viewport.ts");

// 捕捉 renderer 意外修改原始 content/details，以及窄宽度截断遗漏。
test("真实 compact renderer 在 40/120 宽度和 theme 切换后不改变 raw tool result", () => {
  const renderers = createCompactToolRenderers(piTui);
  const raw = { content: [{ type: "text", text: "中🙂输出\n".repeat(50) }], details: { source: "synthetic-display-only", nested: [1, 2] }, structuredContent: { output: "不可改写" }, isError: false };
  const before = structuredClone(raw);
  for (const width of [40, 120]) {
    for (const color of ["31", "36"]) {
      const theme = { bold: (text) => `\x1b[1m${text}\x1b[0m`, fg: (_token, text) => `\x1b[${color}m${text}\x1b[0m` };
      const component = renderers.bash.renderResult(raw, { expanded: true }, theme, { args: { command: "printf demo" } });
      const lines = component.render(width);
      assert.ok(lines.length > 0);
      assert.ok(lines.every((line) => piTui.visibleWidth(line) <= width));
      assert.deepEqual(raw, before);
    }
  }
});

// 捕捉 AltScreen 焦点恢复丢失、按键/滚轮不滚动以及关闭后继续消费输入。
test("真实 TuiAltScreen + production viewport 的 page/wheel、搜索 q/Escape 与关闭焦点", (t) => {
  let dispatch;
  const terminal = { columns: 40, rows: 8, kittyProtocolActive: false,
    start(onInput) { dispatch = onInput; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = new piTui.TuiAltScreen(terminal);
  t.after(() => tui.stop({ preserveScreen: true }));
  const parent = { render: () => ["parent"], invalidate() {}, handleInput() {} };
  tui.addChild(parent);
  tui.setFocus(parent);
  let viewport;
  const raw = Array.from({ length: 40 }, (_, i) => `child line ${i + 1} 中🙂`);
  const before = structuredClone(raw);
  viewport = new SubagentTranscriptViewport({ getTerminalRows: () => terminal.rows, reservedBottomRows: 2,
    getLines: () => raw, requestRender: () => tui.requestRender(), onInput: (data) => {
      const wheel = parseSgrWheelDirection(data);
      if (wheel !== undefined) viewport.scrollLines(wheel);
      else if (piTui.matchesKey(data, piTui.Key.pageUp)) viewport.scrollPage(-1);
      else if (piTui.matchesKey(data, piTui.Key.pageDown)) viewport.scrollPage(1);
    } });
  tui.start();
  const handle = tui.showOverlay(viewport, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
  handle.focus();
  // Pi 1.3 fullscreen：滚轮以归一化 mouse 事件只分发给已渲染出几何的 overlay（生产下
  // 宿主持续渲染，输入前必有帧）；这里同步渲染一帧，让滚轮走真实 handleMouse 协议。
  tui.renderNow();
  for (const width of [40, 120]) {
    terminal.columns = width;
    assert.ok(viewport.render(width).every((line) => piTui.visibleWidth(line) === width));
  }
  dispatch("\x1b[102;6u");
  dispatch("q");
  assert.match(tui.getFocusedComponent().render(40).join("\n"), /q/);
  dispatch("\x1b");
  assert.equal(handle.isFocused(), true);
  const bottom = viewport.position();
  dispatch("\x1b[5~");
  assert.ok(viewport.position().start < bottom.start);
  const page = viewport.position();
  dispatch("\x1b[<65;10;5M");
  assert.equal(viewport.position().start, page.start + 1);
  dispatch("\x1b[6~");
  assert.ok(viewport.position().start > page.start);
  handle.hide();
  viewport.dispose();
  assert.equal(tui.getFocusedComponent(), parent);
  assert.deepEqual(raw, before);
});
