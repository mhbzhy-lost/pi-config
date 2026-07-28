import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "@earendil-works/pi-tui": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
  },
});
const { TUI } = await jiti.import("@earendil-works/pi-tui");
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
  const tui = new TUI({ width: 80, height: 24 });
  tui.requestRender = () => {};
  const forwarded = [];
  tui.setFocus({ render: () => [], handleInput: (data) => forwarded.push(data) });
  tui.addInputListener(controller.handleTerminalInput);

  TUI.prototype.handleInput.call(tui, "a");
  assert.deepEqual(forwarded, ["a"]);

  TUI.prototype.handleInput.call(tui, "\x1bo");
  assert.equal(browser.snapshot().active, true);
  assert.equal(calls.enter, 1);

  TUI.prototype.handleInput.call(tui, "\x1b[C");
  assert.equal(browser.snapshot().selectedKey, "run-1:1");
  TUI.prototype.handleInput.call(tui, "\x1b[1;1:3C");
  TUI.prototype.handleInput.call(tui, "\x1b[D");
  assert.equal(browser.snapshot().selectedKey, "run-1:0");

  TUI.prototype.handleInput.call(tui, "\x1b[A");
  TUI.prototype.handleInput.call(tui, "\x1b[1;1:2A");
  TUI.prototype.handleInput.call(tui, "\x1b[1;1:3A");
  TUI.prototype.handleInput.call(tui, "\x1b[B");
  TUI.prototype.handleInput.call(tui, "k");
  TUI.prototype.handleInput.call(tui, "j");
  TUI.prototype.handleInput.call(tui, "\x1b[5~");
  TUI.prototype.handleInput.call(tui, "\x1b[6~");
  TUI.prototype.handleInput.call(tui, "\x1b[H");
  TUI.prototype.handleInput.call(tui, "\x1b[F");
  TUI.prototype.handleInput.call(tui, "x");
  TUI.prototype.handleInput.call(tui, "\r");
  TUI.prototype.handleInput.call(tui, "\x1b\x06");
  assert.deepEqual(calls.moveChild, [1, -1]);
  assert.deepEqual(calls.scrollLines, [-1, -1, 1, -1, 1]);
  assert.deepEqual(calls.scrollPage, [-1, 1]);
  assert.equal(calls.scrollHome, 1);
  assert.equal(calls.scrollEnd, 1);
  assert.equal(calls.toggleTools, 1);
  assert.deepEqual(forwarded, ["a"]);

  TUI.prototype.handleInput.call(tui, "\x1b[111;3u");
  assert.equal(browser.snapshot().active, false);
  assert.equal(calls.exit, 1);
  TUI.prototype.handleInput.call(tui, "\x1b[111;3u");
  assert.equal(browser.snapshot().active, true);
  TUI.prototype.handleInput.call(tui, "\x1b");
  assert.equal(browser.snapshot().active, false);
  assert.equal(calls.exit, 2);
});

test("real TUI input chain lets Escape reach the restored editor while an agent turn is active", () => {
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agents: ["executor"] });
  const tui = new TUI({ width: 80, height: 24 });
  tui.requestRender = () => {};
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

  TUI.prototype.handleInput.call(tui, "\x1bo");
  assert.equal(browser.snapshot().active, true);
  TUI.prototype.handleInput.call(tui, "\x1b");

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
  const tui = new TUI({ width: 80, height: 24 });
  tui.requestRender = () => {};
  const forwarded = [];
  tui.setFocus({ render: () => [], handleInput: (data) => forwarded.push(data) });
  tui.addInputListener(controller.handleTerminalInput);

  TUI.prototype.handleInput.call(tui, "\x1b[111;3:1u");
  assert.equal(browser.snapshot().active, true);

  TUI.prototype.handleInput.call(tui, "\x1b[1;1:1B");
  assert.deepEqual(calls.scrollLines, [1]);
  TUI.prototype.handleInput.call(tui, "\x1b[1;1:3B");
  assert.deepEqual(calls.scrollLines, [1]);

  TUI.prototype.handleInput.call(tui, "\x1b[1;1:1C");
  assert.equal(browser.snapshot().selectedKey, "run-1:1");
  TUI.prototype.handleInput.call(tui, "\x1b[1;1:2C");
  assert.equal(browser.snapshot().selectedKey, "run-1:0");
  TUI.prototype.handleInput.call(tui, "\x1b[1;1:3C");
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
  const tui = new TUI({ width: 80, height: 24 });
  tui.requestRender = () => {};
  const forwarded = [];
  tui.setFocus({ render: () => [], handleInput: (data) => forwarded.push(data) });
  tui.addInputListener(controller.handleTerminalInput);

  TUI.prototype.handleInput.call(tui, "\x1b[111;3:1u");
  assert.equal(browser.snapshot().active, true);
  TUI.prototype.handleInput.call(tui, "\x1b[111;3:2u");
  TUI.prototype.handleInput.call(tui, "\x1b[111;3:2u");
  TUI.prototype.handleInput.call(tui, "\x1b[111;3:3u");
  assert.equal(browser.snapshot().active, true);
  assert.deepEqual(calls, { enter: 1, exit: 0 });
  assert.deepEqual(forwarded, []);

  TUI.prototype.handleInput.call(tui, "\x1b[111;3:1u");
  assert.equal(browser.snapshot().active, false);
  assert.deepEqual(calls, { enter: 1, exit: 1 });
  assert.deepEqual(forwarded, []);
});
