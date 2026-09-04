import assert from "node:assert/strict";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti, piTui } = await loadPiTestRuntime(import.meta.url);
const { matchesKey, Key } = piTui;
const { SubagentTranscriptViewport, parseSgrWheelDirection } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/session-viewport.ts");

test("TuiAltScreen gives focused child overlay input back after official search", (t) => {
  assert.equal(typeof piTui.TuiAltScreen, "function");
  let dispatchInput;
  const terminal = {
    columns: 80, rows: 8, kittyProtocolActive: false,
    start(onInput) { dispatchInput = onInput; }, stop() {}, async drainInput() {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = new piTui.TuiAltScreen(terminal);
  t.after(() => tui.stop({ preserveScreen: true }));
  tui.addChild({ render: () => ["primary transcript"], invalidate() {} });

  let viewport;
  viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => terminal.rows,
    reservedBottomRows: 2,
    getLines: () => Array.from({ length: 30 }, (_, index) => `child line ${index + 1}`),
    requestRender: () => tui.requestRender(),
    onInput: (data) => {
      const wheel = parseSgrWheelDirection(data);
      if (wheel !== undefined) viewport.scrollLines(wheel);
      else if (matchesKey(data, Key.pageUp)) viewport.scrollPage(-1);
      else if (matchesKey(data, Key.pageDown)) viewport.scrollPage(1);
    },
  });
  tui.start();
  const overlayHandle = tui.showOverlay(viewport, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
  overlayHandle.focus();
  viewport.render(80);
  assert.equal(overlayHandle.isFocused(), true);

  dispatchInput("\x1b[102;6u");
  dispatchInput("q");
  assert.match(tui.getFocusedComponent().render(40).join("\n"), /q/);
  dispatchInput("\x1b");
  assert.equal(overlayHandle.isFocused(), true);

  const beforePage = viewport.position();
  dispatchInput("\x1b[5~");
  assert.notDeepEqual(viewport.position(), beforePage);
  const beforeWheel = viewport.position();
  dispatchInput("\x1b[<65;10;5M");
  assert.notDeepEqual(viewport.position(), beforeWheel);
});
