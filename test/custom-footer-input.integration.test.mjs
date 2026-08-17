import assert from "node:assert/strict";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
import { createTestTui } from "./helpers/pi-tui.mjs";

const { jiti, piTui } = await loadPiTestRuntime(import.meta.url);
const { SubagentSessionBrowserState } = await jiti.import("../pi/extensions/lib/subagent-session-browser.ts");
const { createBrowserInputController } = await jiti.import("../pi/extensions/custom-footer.ts");

test("real TUI input chain routes child navigation, transcript scrolling, and tool expansion without forwarding editor input", () => {
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agents: ["executor", "reviewer"] });
  const calls = { enter: 0, exit: 0, moveChild: [], scrollLines: [], scrollPage: [], scrollHome: 0, scrollEnd: 0, toggleTools: 0 };
  const controller = createBrowserInputController({
    browser,
    enterBrowser: () => { calls.enter += 1; browser.enter(); },
    exitBrowser: () => { calls.exit += 1; browser.exit(); },
    moveChild: (direction) => { calls.moveChild.push(direction); browser.move(direction); },
    scrollLines: (direction) => { calls.scrollLines.push(direction); },
    scrollPage: (direction) => { calls.scrollPage.push(direction); },
    scrollHome: () => { calls.scrollHome += 1; },
    scrollEnd: () => { calls.scrollEnd += 1; },
    toggleTools: () => { calls.toggleTools += 1; },
  });
  const { tui, dispatchInput } = createTestTui(piTui);
  const forwarded = [];
  tui.setFocus({ render: () => [], handleInput: (data) => forwarded.push(data) });
  tui.addInputListener(controller.handleTerminalInput);

  dispatchInput("a");
  assert.deepEqual(forwarded, ["a"]);

  dispatchInput("\x1bo");
  assert.equal(browser.snapshot().active, true);
  assert.equal(calls.enter, 1);

  dispatchInput("\x1b[C");
  assert.equal(browser.snapshot().selectedKey, "run-1:1");
  dispatchInput("\x1b[1;1:3C");
  dispatchInput("\x1b[D");
  assert.equal(browser.snapshot().selectedKey, "run-1:0");

  dispatchInput("\x1b[A");
  dispatchInput("\x1b[1;1:2A");
  dispatchInput("\x1b[1;1:3A");
  dispatchInput("\x1b[B");
  dispatchInput("k");
  dispatchInput("j");
  dispatchInput("\x1b[5~");
  dispatchInput("\x1b[6~");
  dispatchInput("\x1b[H");
  dispatchInput("\x1b[F");
  dispatchInput("x");
  dispatchInput("\r");
  dispatchInput("\x1b\x06");
  assert.deepEqual(calls.moveChild, [1, -1]);
  assert.deepEqual(calls.scrollLines, [-1, -1, 1, -1, 1]);
  assert.deepEqual(calls.scrollPage, [-1, 1]);
  assert.equal(calls.scrollHome, 1);
  assert.equal(calls.scrollEnd, 1);
  assert.equal(calls.toggleTools, 1);
  assert.deepEqual(forwarded, ["a"]);

  dispatchInput("\x1b[111;3u");
  assert.equal(browser.snapshot().active, false);
  assert.equal(calls.exit, 1);
  dispatchInput("\x1b[111;3u");
  assert.equal(browser.snapshot().active, true);
  dispatchInput("\x1b");
  assert.equal(browser.snapshot().active, false);
  assert.equal(calls.exit, 2);
});

test("real TUI input chain lets Escape reach the restored editor while an agent turn is active", () => {
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agents: ["executor"] });
  const { tui, dispatchInput } = createTestTui(piTui);
  let aborts = 0;
  const mainEditor = {
    render: () => [],
    handleInput: (data) => { if (data === "\x1b") aborts += 1; },
  };
  const browserEditor = { render: () => [], handleInput: () => {} };
  tui.setFocus(mainEditor);

  const controller = createBrowserInputController({
    browser,
    enterBrowser: () => { browser.enter(); tui.setFocus(browserEditor); },
    exitBrowser: () => { browser.exit(); tui.setFocus(mainEditor); },
    shouldPropagateEscape: () => true,
    moveChild: () => {},
    scrollLines: () => {},
    scrollPage: () => {},
    scrollHome: () => {},
    scrollEnd: () => {},
    toggleTools: () => {},
  });
  tui.addInputListener(controller.handleTerminalInput);

  dispatchInput("\x1bo");
  assert.equal(browser.snapshot().active, true);
  dispatchInput("\x1b");

  assert.equal(browser.snapshot().active, false);
  assert.equal(aborts, 1);
});

test("real TUI input chain ignores Kitty releases while preserving browser navigation repeats", () => {
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agents: ["executor", "reviewer"] });
  const calls = { enter: 0, exit: 0, moveChild: [], scrollLines: [] };
  const controller = createBrowserInputController({
    browser,
    enterBrowser: () => { calls.enter += 1; browser.enter(); },
    exitBrowser: () => { calls.exit += 1; browser.exit(); },
    moveChild: (direction) => { calls.moveChild.push(direction); browser.move(direction); },
    scrollLines: (direction) => { calls.scrollLines.push(direction); },
    scrollPage: () => {},
    scrollHome: () => {},
    scrollEnd: () => {},
    toggleTools: () => {},
  });
  const { tui, dispatchInput } = createTestTui(piTui);
  const forwarded = [];
  tui.setFocus({ render: () => [], handleInput: (data) => forwarded.push(data) });
  tui.addInputListener(controller.handleTerminalInput);

  dispatchInput("\x1b[111;3:1u");
  assert.equal(browser.snapshot().active, true);

  dispatchInput("\x1b[1;1:1B");
  assert.deepEqual(calls.scrollLines, [1]);
  dispatchInput("\x1b[1;1:3B");
  assert.deepEqual(calls.scrollLines, [1]);

  dispatchInput("\x1b[1;1:1C");
  assert.equal(browser.snapshot().selectedKey, "run-1:1");
  dispatchInput("\x1b[1;1:2C");
  assert.equal(browser.snapshot().selectedKey, "run-1:0");
  dispatchInput("\x1b[1;1:3C");
  assert.equal(browser.snapshot().selectedKey, "run-1:0");
  assert.deepEqual(calls.moveChild, [1, 1]);
  assert.deepEqual(forwarded, []);
});

test("real TUI input chain toggles Alt+O only for Kitty press events", () => {
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agents: ["executor"] });
  const calls = { enter: 0, exit: 0 };
  const controller = createBrowserInputController({
    browser,
    enterBrowser: () => { calls.enter += 1; browser.enter(); },
    exitBrowser: () => { calls.exit += 1; browser.exit(); },
    moveChild: () => {},
    scrollLines: () => {},
    scrollPage: () => {},
    scrollHome: () => {},
    scrollEnd: () => {},
    toggleTools: () => {},
  });
  const { tui, dispatchInput } = createTestTui(piTui);
  const forwarded = [];
  tui.setFocus({ render: () => [], handleInput: (data) => forwarded.push(data) });
  tui.addInputListener(controller.handleTerminalInput);

  dispatchInput("\x1b[111;3:1u");
  assert.equal(browser.snapshot().active, true);
  dispatchInput("\x1b[111;3:2u");
  dispatchInput("\x1b[111;3:2u");
  dispatchInput("\x1b[111;3:3u");
  assert.equal(browser.snapshot().active, true);
  assert.deepEqual(calls, { enter: 1, exit: 0 });
  assert.deepEqual(forwarded, []);

  dispatchInput("\x1b[111;3:1u");
  assert.equal(browser.snapshot().active, false);
  assert.deepEqual(calls, { enter: 1, exit: 1 });
  assert.deepEqual(forwarded, []);
});
