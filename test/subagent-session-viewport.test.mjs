import assert from "node:assert/strict";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
import { createTestTui } from "./helpers/pi-tui.mjs";
const { jiti, codingAgent, piTui } = await loadPiTestRuntime(import.meta.url);
const { visibleWidth } = piTui;
const { CustomEditor } = codingAgent;
const { ReadOnlyBrowserEditor, SubagentTranscriptViewport, parseSgrWheelDirection } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/session-viewport.ts");

const editorTheme = {
  borderColor: (text) => text,
  selectList: {},
};

test("read-only browser editor preserves its draft while rendering no lines", () => {
  const { tui } = createTestTui(piTui);
  const editor = new ReadOnlyBrowserEditor(tui, editorTheme, {});

  editor.setText("unsent parent draft");
  assert.equal(editor instanceof CustomEditor, true);
  assert.deepEqual(editor.render(80), []);
  editor.handleInput("x");
  assert.equal(editor.getText(), "unsent parent draft");
});

test("viewport covers every available row with exact-width transcript lines", () => {
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 24,
    reservedBottomRows: 4,
    getLines: () => ["line 1", "\x1b[31mline 2\x1b[0m"],
    requestRender: () => {},
  });

  const lines = viewport.render(80);
  assert.equal(lines.length, 20);
  assert.equal(lines[18].trimEnd(), "line 1");
  assert.equal(lines[19].replace(/\x1b\[[0-9;]*m/g, "").trimEnd(), "line 2");
  assert.ok(lines.every((line) => visibleWidth(line) === 80));
});

test("viewport supplies its actual render width to transcript rendering", () => {
  const widths = [];
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 3,
    reservedBottomRows: 2,
    getLines: (width) => { widths.push(width); return ["line"]; },
    requestRender: () => {},
  });

  viewport.render(40);
  viewport.render(120);
  assert.deepEqual(widths, [40, 120]);
});

test("viewport anchors the manual page across appended transcript lines and resumes following at the current bottom", () => {
  let transcript = ["one", "two", "three", "four", "five"];
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 5,
    reservedBottomRows: 2,
    getLines: () => transcript,
    requestRender: () => {},
  });

  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["three", "four", "five"]);
  viewport.scrollPage(-1);
  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["one", "two", "three"]);

  transcript = [...transcript, "six"];
  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["one", "two", "three"]);

  viewport.scrollPage(1);
  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["four", "five", "six"]);
  transcript = [...transcript, "seven"];
  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["five", "six", "seven"]);
});

test("viewport scrolls by line and reports 1-based positions through Home and End", () => {
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 10,
    reservedBottomRows: 4,
    getLines: () => Array.from({ length: 30 }, (_, index) => `line ${index + 1}`),
    requestRender: () => {},
  });

  viewport.render(40);
  assert.deepEqual(viewport.position(), { start: 25, end: 30, total: 30, autoFollow: true });
  viewport.scrollLines(-1);
  assert.deepEqual(viewport.position(), { start: 24, end: 29, total: 30, autoFollow: false });
  viewport.scrollHome();
  assert.equal(viewport.position().start, 1);
  viewport.scrollEnd();
  assert.deepEqual(viewport.position(), { start: 25, end: 30, total: 30, autoFollow: true });
});

test("viewport keeps manual line position across append and bounds position after shrink, reset, and empty content", () => {
  let transcript = ["one", "two", "three", "four", "five"];
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 5,
    reservedBottomRows: 2,
    getLines: () => transcript,
    requestRender: () => {},
  });

  viewport.render(20);
  viewport.scrollLines(-1);
  assert.deepEqual(viewport.position(), { start: 2, end: 4, total: 5, autoFollow: false });
  transcript = [...transcript, "six"];
  assert.deepEqual(viewport.position(), { start: 2, end: 4, total: 6, autoFollow: false });
  viewport.scrollEnd();
  transcript = [...transcript, "seven"];
  assert.deepEqual(viewport.position(), { start: 5, end: 7, total: 7, autoFollow: true });

  transcript = ["only"];
  assert.deepEqual(viewport.position(), { start: 1, end: 1, total: 1, autoFollow: true });
  viewport.resetScroll();
  assert.deepEqual(viewport.position(), { start: 1, end: 1, total: 1, autoFollow: true });
  transcript = [];
  assert.deepEqual(viewport.position(), { start: 0, end: 0, total: 0, autoFollow: true });
});

test("viewport preserves the anchored manual page through a transient getLines failure", () => {
  let transcript = ["one", "two", "three", "four", "five", "six"];
  let failRead = false;
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 5,
    reservedBottomRows: 2,
    getLines: () => {
      if (failRead) throw new Error("transient source failure");
      return transcript;
    },
    requestRender: () => {},
  });

  viewport.scrollPage(-1);
  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["one", "two", "three"]);

  failRead = true;
  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["one", "two", "three"]);

  failRead = false;
  transcript = [...transcript, "seven"];
  assert.deepEqual(viewport.render(8).map((line) => line.trimEnd()), ["one", "two", "three"]);
});

test("viewport truncates and pads ANSI CJK and emoji transcript lines to the exact visible width", () => {
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 4,
    reservedBottomRows: 2,
    getLines: () => ["\x1b[36m中🙂a\x1b[0m", "\x1b[35m中\x1b[0m"],
    requestRender: () => {},
  });

  const lines = viewport.render(4);
  assert.ok(lines.every((line) => visibleWidth(line) === 4));
  assert.equal(lines[0].replace(/\x1b\[[0-9;]*m/g, "").trimEnd(), "...");
  assert.equal(lines[1].replace(/\x1b\[[0-9;]*m/g, "").trimEnd(), "中");
});


test("viewport refresh preserves host cache while invalidate signals host cache invalidation", () => {
  let renders = 0;
  let invalidations = 0;
  const inputs = [];
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 3,
    reservedBottomRows: 2,
    getLines: () => ["one"],
    requestRender: () => { renders += 1; },
    onInvalidate: () => { invalidations += 1; },
    onInput: (data) => inputs.push(data),
  });

  viewport.refresh();
  assert.equal(renders, 1);
  assert.equal(invalidations, 0);
  viewport.invalidate();
  assert.equal(renders, 2);
  assert.equal(invalidations, 1);
  viewport.handleInput("x");
  assert.deepEqual(inputs, ["x"]);
  viewport.dispose();
  viewport.refresh();
  viewport.invalidate();
  viewport.handleInput("j");
  assert.equal(renders, 2);
  assert.equal(invalidations, 1);
  assert.deepEqual(inputs, ["x"]);
});

test("viewport parses complete SGR wheel presses including modifier bits", () => {
  assert.equal(parseSgrWheelDirection("\x1b[<64;10;5M"), -1);
  assert.equal(parseSgrWheelDirection("\x1b[<65;10;5M"), 1);
  assert.equal(parseSgrWheelDirection("\x1b[<80;10;5M"), -1);
  assert.equal(parseSgrWheelDirection("\x1b[<81;10;5M"), 1);
  assert.equal(parseSgrWheelDirection("\x1b[<64;10;5m"), undefined);
  assert.equal(parseSgrWheelDirection("\x1b[<64;10;5Mx"), undefined);
  assert.equal(parseSgrWheelDirection("x"), undefined);
});

test("viewport resets manual scrolling, requests renders, and ignores scroll mutators after disposal", () => {
  let renders = 0;
  const viewport = new SubagentTranscriptViewport({
    getTerminalRows: () => 5,
    reservedBottomRows: 2,
    getLines: () => ["one", "two", "three", "four", "five"],
    requestRender: () => { renders += 1; },
  });

  viewport.render(20);
  viewport.scrollHome();
  assert.equal(renders, 1);
  assert.deepEqual(viewport.position(), { start: 1, end: 3, total: 5, autoFollow: false });

  viewport.scrollLines(1);
  assert.equal(renders, 2);
  assert.deepEqual(viewport.position(), { start: 2, end: 4, total: 5, autoFollow: false });
  viewport.scrollLines(1);
  assert.equal(renders, 3);
  assert.deepEqual(viewport.position(), { start: 3, end: 5, total: 5, autoFollow: true });

  viewport.scrollPage(-1);
  assert.equal(renders, 4);
  assert.deepEqual(viewport.position(), { start: 1, end: 3, total: 5, autoFollow: false });
  viewport.resetScroll();
  assert.equal(renders, 5);
  assert.deepEqual(viewport.position(), { start: 3, end: 5, total: 5, autoFollow: true });
  viewport.scrollEnd();
  assert.equal(renders, 6);

  viewport.dispose();
  const positionAfterDispose = viewport.position();
  viewport.scrollLines(-1);
  viewport.scrollHome();
  viewport.scrollEnd();
  viewport.resetScroll();
  viewport.scrollPage(-1);
  assert.equal(renders, 6);
  assert.deepEqual(viewport.position(), positionAfterDispose);
});
