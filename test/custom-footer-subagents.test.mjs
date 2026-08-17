import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti, codingAgent } = await loadPiTestRuntime(import.meta.url);
const { SessionManager, initTheme } = codingAgent;
const customFooterModule = await jiti.import("../pi/extensions/custom-footer.ts");
const { SubagentSessionBrowserState } = await jiti.import("../pi/extensions/lib/subagent-session-browser.ts");

initTheme("dark", false);

test("browser selector keeps the selected item visible and accounts for hidden items with terminal widths", () => {
  assert.equal(typeof customFooterModule.formatBrowserSelector, "function");
  const snapshot = {
    active: true,
    selectedKey: "run:1",
    children: [
      { key: "run:0", agent: "executor" },
      { key: "run:1", agent: "reviewer", label: "\u4e2d\u6587\ud83d\ude42" },
      { key: "run:2", agent: "tester" },
    ],
    activeChildren: [
      { key: "run:0", agent: "executor" },
      { key: "run:1", agent: "reviewer", label: "\u4e2d\u6587\ud83d\ude42" },
      { key: "run:2", agent: "tester" },
    ],
    recentChildren: [],
  };

  const narrow = customFooterModule.formatBrowserSelector(snapshot, 1);
  assert.match(narrow, /›|\u2026/);

  const middle = customFooterModule.formatBrowserSelector(snapshot, 26);
  assert.match(middle, /› \? 中文🙂 \(reviewer\)/);

  const last = customFooterModule.formatBrowserSelector({ ...snapshot, selectedKey: "run:2" }, 24);
  assert.match(last, /› \? tester/);
  assert.match(last, /\+\d/);
});

test("browser selector preserves the directional focus glyph at every glyph-sized width", () => {
  const snapshot = {
    active: true,
    selectedKey: "run:0",
    children: [{ key: "run:0", agent: "executor" }],
    activeChildren: [{ key: "run:0", agent: "executor" }],
    recentChildren: [],
  };

  for (const width of [1, 2, 3]) {
    assert.match(customFooterModule.formatBrowserSelector(snapshot, width), /›/, `width ${width}`);
  }
});

test("main selector expands active children and folds terminal children into display-only history", () => {
  const snapshot = {
    active: false,
    children: [
      { key: "active:0", agent: "executor", state: "running" },
      { key: "done:0", agent: "reviewer", state: "completed" },
      { key: "done:1", agent: "tester", state: "failed" },
    ],
    activeChildren: [{ key: "active:0", agent: "executor", state: "running" }],
    recentChildren: [
      { key: "done:0", agent: "reviewer", state: "completed" },
      { key: "done:1", agent: "tester", state: "failed" },
    ],
  };

  const selector = customFooterModule.formatBrowserSelector(snapshot, 80);
  assert.equal(selector, "● executor  ◯ history 2");
  assert.doesNotMatch(selector, /main|reviewer|tester/);
});

test("main history count folds multiple terminal children from one active run", () => {
  const terminalChildren = [
    { key: "done:0", runId: "done", agent: "reviewer", state: "completed" },
    { key: "done:1", runId: "done", agent: "tester", state: "failed" },
  ];
  const snapshot = {
    active: false,
    children: [{ key: "active:0", runId: "active", agent: "executor", state: "running" }, ...terminalChildren],
    activeChildren: [{ key: "active:0", runId: "active", agent: "executor", state: "running" }],
    recentChildren: terminalChildren,
  };
  assert.match(customFooterModule.formatBrowserSelector(snapshot, 80), /◯ history 1$/);
});

test("main selector is empty when no child remains active", () => {
  const terminalChildren = [{ key: "done:0", runId: "done", agent: "reviewer", state: "completed" }];
  const snapshot = { active: false, children: terminalChildren, activeChildren: [], recentChildren: terminalChildren };
  assert.equal(customFooterModule.formatBrowserSelector(snapshot, 80), "");
});

test("selector caps one long title without mutating the roster or hiding sibling status", () => {
  const longTitle = "This is an accidentally verbose subagent title that contains most of the original task text and keeps going";
  const activeChildren = [
    { key: "long:0", runId: "long", agent: "delegate", state: "running", label: longTitle },
    { key: "short:0", runId: "short", agent: "executor", state: "running", label: "Short check" },
  ];
  const recentChildren = [{ key: "done:0", runId: "done", agent: "delegate", state: "completed" }];
  const snapshot = {
    active: false,
    children: [...activeChildren, ...recentChildren],
    activeChildren,
    recentChildren,
  };
  const before = structuredClone(snapshot);

  const selector = customFooterModule.formatBrowserSelector(snapshot, 100);

  assert.match(selector, /This is an accidentally verbose/);
  assert.doesNotMatch(selector, /original task text and keeps going/);
  assert.match(selector, /Short check \(executor\)/);
  assert.match(selector, /history 1/);
  assert.deepEqual(snapshot, before);

  const childSelector = customFooterModule.formatBrowserSelector({
    ...snapshot,
    active: true,
    selectedKey: "long:0",
  }, 58);
  assert.match(childSelector, /^› ● This is an accidentally verbose/);
  assert.deepEqual(snapshot, before);
});

test("child selector separates selection from lifecycle glyphs and keeps selected child visible when narrow", () => {
  const children = [
    { key: "active:0", agent: "executor", state: "running" },
    { key: "complete:0", agent: "reviewer", state: "completed", label: "中文🙂" },
    { key: "failed:0", agent: "tester", state: "timed-out" },
    { key: "paused:0", agent: "planner", state: "paused" },
    { key: "stopped:0", agent: "writer", state: "detached" },
    { key: "unknown:0", agent: "observer", state: "mystery" },
  ];
  const snapshot = { active: true, selectedKey: "complete:0", children, activeChildren: children.slice(0, 1), recentChildren: children.slice(1) };

  const selector = customFooterModule.formatBrowserSelector(snapshot, 200);
  assert.match(selector, /  ● executor/);
  assert.match(selector, /› ✓ 中文🙂 \(reviewer\)/);
  assert.match(selector, /  ! tester/);
  assert.match(selector, /  Ⅱ planner/);
  assert.match(selector, /  ■ writer/);
  assert.match(selector, /  \? observer/);
  assert.doesNotMatch(selector, /main|[◯⏺] [●✓✗Ⅱ■?]/);

  const first = customFooterModule.formatBrowserSelector({ ...snapshot, selectedKey: "active:0" }, 200);
  assert.match(first, /^› ● executor/);

  const narrow = customFooterModule.formatBrowserSelector(snapshot, 18);
  assert.match(narrow, /› ✓/);
});

test("browser state keeps lifecycle titles separate from execution identity", () => {
  const state = new SubagentSessionBrowserState();
  state.trackStarted({ id: "titled", asyncDir: "/tmp/titled", cwd: "/repo", agent: "executor", title: "Investigate footer" });
  assert.deepEqual(state.snapshot().children[0].agent, "executor");
  assert.deepEqual(state.snapshot().children[0].label, "Investigate footer");

  state.reconcileRun("titled", { state: "running", steps: [{ agent: "executor", status: "running", title: "Keep status label" }] });
  assert.equal(state.snapshot().children[0].agent, "executor");
  assert.equal(state.snapshot().children[0].label, "Keep status label");
});


test("child footer combines tokens with viewport position and preserves position when token text is truncated", () => {
  assert.equal(typeof customFooterModule.createFooterComponent, "function");
  const snapshot = {
    active: true,
    selectedKey: "child:0",
    selected: { key: "child:0", agent: "executor", state: "running", cwd: "/repo", tokens: 54_321, model: "provider/model" },
    children: [{ key: "child:0", agent: "executor", state: "running" }],
    activeChildren: [{ key: "child:0", agent: "executor", state: "running" }],
    recentChildren: [],
  };
  const component = customFooterModule.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home/test", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 70, contextWindow: 100_000 }), getThinkingLevel: () => "off",
    getSnapshot: () => snapshot, getViewportPosition: () => ({ start: 120, end: 139, total: 434 }),
    requestRender() {}, theme: { fg: (_color, text) => text },
  });

  assert.match(component.render(80)[0], /54.3k tokens · 120-139\/434$/);
  snapshot.selected.tokens = 54_000;
  assert.match(component.render(80)[0], /54k tokens · 120-139\/434$/);
  assert.doesNotMatch(component.render(80)[0], /54\.0k tokens/);
  snapshot.selected.tokens = 54_321;
  const narrow = component.render(18)[0];
  assert.match(narrow, /120-139\/434$/);
  assert.doesNotMatch(narrow, /54.3k tokens/);
});

test("child footer reads changing viewport positions, including an empty transcript", () => {
  const snapshot = {
    active: true,
    selectedKey: "child:0",
    selected: { key: "child:0", agent: "executor", state: "running", cwd: "/repo", tokens: 54_321, model: "provider/model" },
    children: [{ key: "child:0", agent: "executor", state: "running" }],
    activeChildren: [{ key: "child:0", agent: "executor", state: "running" }],
    recentChildren: [],
  };
  let position = { start: 1, end: 20, total: 100 };
  const component = customFooterModule.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home/test", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 70, contextWindow: 100_000 }), getThinkingLevel: () => "off",
    getSnapshot: () => snapshot, getViewportPosition: () => position,
    requestRender() {}, theme: { fg: (_color, text) => text },
  });

  assert.match(component.render(80)[0], /54.3k tokens · 1-20\/100$/);
  position = { start: 41, end: 60, total: 100 };
  assert.match(component.render(80)[0], /54.3k tokens · 41-60\/100$/);
  position = { start: 0, end: 0, total: 0 };
  assert.match(component.render(80)[0], /54.3k tokens · 0\/0$/);
});


test("child footer preserves an exactly fitting position without an empty token separator", () => {
  const snapshot = {
    active: true,
    selectedKey: "child:0",
    selected: { key: "child:0", agent: "executor", state: "running", cwd: "/repo", tokens: 54_321, model: "provider/model" },
    children: [{ key: "child:0", agent: "executor", state: "running" }],
    activeChildren: [{ key: "child:0", agent: "executor", state: "running" }],
    recentChildren: [],
  };
  const component = customFooterModule.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home/test", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 70, contextWindow: 100_000 }), getThinkingLevel: () => "off",
    getSnapshot: () => snapshot, getViewportPosition: () => ({ start: 120, end: 139, total: 434 }),
    requestRender() {}, theme: { fg: (_color, text) => text },
  });

  assert.equal(component.render(11)[0], "120-139/434");
  assert.match(component.render(10)[0], /^120-139\/4\x1b\[0m…\x1b\[0m$/);
});

function register(map, name, handler) {
  const handlers = map.get(name) ?? [];
  handlers.push(handler); map.set(name, handlers);
  return () => map.delete(name);
}

function setup(reason) {
  const handlers = new Map(); const events = new Map(); let footerFactory; let shortcut;
  const pi = { on: (name, handler) => register(handlers, name, handler), events: { on: (name, handler) => register(events, name, handler) }, getThinkingLevel: () => "high", registerShortcut(_key, definition) { shortcut = definition; } };
  customFooterModule.default(pi);
  const ctx = {
    hasUI: true, cwd: `${process.env.HOME}/workspace`, model: { provider: "codex-pool", id: "gpt-5.6-sol", contextWindow: 272_000 },
    getContextUsage: () => ({ tokens: 207_000, contextWindow: 272_000, percent: 76.1 }), sessionManager: { getSessionFile: () => null },
    ui: {
      onTerminalInput() { throw new Error("browser must not install a global terminal input listener"); },
      setFooter(factory) { footerFactory = factory; }, getEditorComponent: () => undefined, setEditorComponent() {},
      custom() { return Promise.resolve(); },
    },
  };
  handlers.get("session_start")[0]({ reason }, ctx);
  const component = footerFactory({ requestRender() {} }, { fg: (_color, text) => text }, {});
  const input = (data) => {
    if (data === "\x1bo") shortcut?.handler(ctx);
    return { consume: true };
  };
  return { component, input: () => input, asyncStart: (event) => events.get("subagent:async-started")[0](event), complete: (event) => events.get("subagent:async-complete")[0](event), shutdown: (reason) => handlers.get("session_shutdown")[0]({ reason }, ctx), events };
}

test("footer renders a fixed three-line child status row", (t) => {
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  subject.asyncStart({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agents: ["executor", "reviewer"] });
  const lines = subject.component.render(58);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^● executor  ● reviewer/);
  assert.doesNotMatch(lines[1], /main/);
  assert.match(lines[1], /\(codex-pool\) gpt-5\.6-sol$/);
});

test("child mode reserves the directional focus glyph when a long model label would otherwise take the second line", (t) => {
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  subject.asyncStart({ id: "narrow-run", asyncDir: "/tmp/narrow-run", cwd: "/repo", agent: "executor", sessionId: "parent" });
  subject.input()("\x1bo");
  const lines = subject.component.render(14);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /›/);
});
test("browser input consumes Alt+O and legacy inspector input instead of rewriting shortcuts", (t) => {
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  subject.asyncStart({ id: "run-2", asyncDir: "/tmp/run-2", cwd: "/repo", agent: "executor" });
  assert.deepEqual(subject.input()("\x1bo"), { consume: true });
  assert.deepEqual(subject.input()("\x1b\x06"), { consume: true });
  assert.deepEqual(subject.input()("\x1b"), { consume: true });
});

test("reload preserves roster but disposes async listeners and restarts in main", (t) => {
  const first = setup(); t.after(() => first.shutdown("quit"));
  first.asyncStart({ id: "reload-run", asyncDir: "/tmp/reload-run", cwd: "/repo", agent: "reviewer" });
  first.shutdown("reload");
  assert.equal(first.events.size, 0);
  const second = setup("reload"); t.after(() => second.shutdown("quit"));
  assert.equal(globalThis[Symbol.for("pi-config.custom-footer.subagents.v2")].browser, undefined);
  assert.match(second.component.render(58)[1], /^● reviewer/);
  assert.doesNotMatch(second.component.render(58)[1], /main/);
});

test("migrates a pre-v1 browser class cache into a plain roster", (t) => {
  const key = Symbol.for("pi-config.custom-footer.subagents.v2");
  const previous = globalThis[key];
  const oldState = new SubagentSessionBrowserState();
  oldState.trackStarted({ id: "legacy-run", asyncDir: "/tmp/legacy-run", cwd: "/repo", agent: "executor" });
  globalThis[key] = { browser: oldState };
  t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });

  const handlers = new Map();
  customFooterModule.default({ on: (name, handler) => register(handlers, name, handler), events: { on() { return () => {}; } }, getThinkingLevel: () => "off", registerShortcut() {} });

  assert.deepEqual(globalThis[key], { version: 1, children: oldState.snapshot().children });
  assert.equal("browser" in globalThis[key], false);
});

function runtimeFixture(fixtureOptions = {}) {
  const handlers = new Map(); const events = new Map(); const timers = []; const cleared = []; const custom = []; const editorFactories = []; const notifications = [];
  let shortcut; let editor = function OriginalEditor() {}; let draft = "unsent draft"; let footerFactory; let renders = 0;
  const originalSetInterval = globalThis.setInterval; const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback) => { const timer = { callback, unrefCalls: 0, unref() { this.unrefCalls += 1; } }; timers.push(timer); return timer; };
  globalThis.clearInterval = (timer) => { cleared.push(timer); };
  const pi = { on: (name, handler) => register(handlers, name, handler), events: { on: (name, handler) => register(events, name, handler) }, getThinkingLevel: () => "high", registerShortcut(_key, definition) { shortcut = definition; } };
  customFooterModule.default(pi);
  const ctx = {
    hasUI: true, cwd: "/repo", model: { id: "model" }, getContextUsage: () => ({ percent: 1, contextWindow: 100 }), sessionManager: { getSessionFile: () => null },
    ui: {
      onTerminalInput() { throw new Error("browser must not install a global terminal input listener"); }, setFooter(factory) { footerFactory = factory; },
      getEditorComponent: () => { if (fixtureOptions.throwAt === "getEditorComponent") throw new Error("get editor failed"); return editor; }, getEditorText: () => { if (fixtureOptions.throwAt === "getEditorText") throw new Error("get text failed"); return draft; }, setEditorComponent(factory) { if (fixtureOptions.throwAt === "setEditorComponent") throw new Error("set editor failed"); editor = factory; editorFactories.push(factory); }, setEditorText(text) { draft = text; },
      custom(factory, overlayOptions) { if (fixtureOptions.throwAt === "custom") throw new Error("custom failed"); const handle = { focusCalls: 0, focus() { this.focusCalls += 1; } }; const call = { factory, options: overlayOptions, handle, done: 0, component: undefined }; custom.push(call); call.component = factory({ terminal: { rows: 24 }, requestRender() { renders += 1; } }, { fg: (_c, value) => value, bold: (value) => value }, {}, () => { call.done += 1; }); overlayOptions.onHandle(handle); return fixtureOptions.rejectCustom ? Promise.reject(new Error("overlay failed")) : Promise.resolve(); },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  handlers.get("session_start")[0]({}, ctx);
  const input = (data) => {
    if (data === "\x1bo") shortcut?.handler(ctx);
    else custom.at(-1)?.component?.handleInput(data);
    return { consume: true };
  };
  return {
    ctx, shortcut, timers, cleared, custom, editorFactories, notifications, events, input: () => input, component: () => footerFactory?.({ requestRender() {} }, { fg: (_c, value) => value }, {}), renders: () => renders,
    start: (next = ctx, reason) => handlers.get("session_start")[0]({ reason }, next), asyncStart: (event) => events.get("subagent:async-started")[0](event),
    shutdown: (reason = "quit") => handlers.get("session_shutdown")[0]({ reason }, ctx), poll: (index = timers.length - 1) => timers[index].callback(), restore() { globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; },
  };
}

test("Alt+O accepts a distinct shortcut context for the live session manager only", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "shortcut-run", asyncDir: "/tmp/shortcut-run", cwd: "/repo", agent: "executor" });

  subject.shortcut.handler({ sessionManager: subject.ctx.sessionManager });
  assert.equal(subject.custom.length, 1);
  subject.custom[0].component.handleInput("\x1b");
  subject.shortcut.handler({ sessionManager: { getSessionFile: () => null } });
  assert.equal(subject.custom.length, 1);
});

test("extension fixture focuses a capturing viewport then restores editor and draft", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "fixture-run", asyncDir: "/tmp/fixture-run", cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  assert.deepEqual(subject.input()("\x1bo"), { consume: true });
  assert.notEqual(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.custom.length, 1);
  assert.deepEqual(subject.custom[0].options.overlayOptions, { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: { bottom: 4 } });
  assert.equal(subject.custom[0].handle.focusCalls, 1);
  assert.equal(subject.custom[0].component.render(40).length, 20);
  assert.match(subject.custom[0].component.render(40).join("\n"), /Waiting for child output/);
  assert.deepEqual(subject.input()("\x1b"), { consume: true });
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.ctx.ui.getEditorText(), "unsent draft");
  assert.equal(subject.custom[0].done, 1);
});

test("polling an emptied real status roster exits the browser and restores the original editor", (t) => {
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-browser-"));
  const subject = runtimeFixture();
  t.after(() => { subject.shutdown(); subject.restore(); fs.rmSync(asyncDir, { recursive: true, force: true }); });
  subject.asyncStart({ id: "real-status", asyncDir, cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  subject.input()("\x1bo");
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", steps: [] }));
  subject.poll();
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.custom[0].done, 1);
  assert.doesNotMatch(subject.component().render(40)[1], /main|history/);
});

test("session starts clear roster except for reload and stale polls cannot access the former context", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "old-run", asyncDir: "/tmp/old-run", cwd: "/repo", agent: "executor" });
  const stalePoll = subject.timers[0].callback;
  subject.start(subject.ctx, "startup");
  assert.doesNotMatch(subject.component().render(58)[1], /main|executor/);
  const renders = subject.renders();
  stalePoll();
  assert.equal(subject.renders(), renders);
  subject.asyncStart({ id: "reload-run", asyncDir: "/tmp/reload-run", cwd: "/repo", agent: "reviewer" });
  subject.start(subject.ctx, "reload");
  assert.match(subject.component().render(58)[1], /^● reviewer/);
});
test("a repeated session start exits the browser and replaces timer and input listeners", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "restart-run", asyncDir: "/tmp/restart-run", cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  const firstInput = subject.input();
  subject.input()("\x1bo");
  assert.equal(subject.custom.length, 1);
  assert.equal(subject.timers.length, 1);
  subject.start();
  assert.equal(subject.cleared.length, 1);
  assert.equal(subject.timers.length, 2);
  assert.equal(subject.timers[1].unrefCalls, 1);
  assert.equal(subject.input(), firstInput);
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.ctx.ui.getEditorText(), "unsent draft");
  assert.equal(subject.custom[0].done, 1);
  assert.doesNotMatch(subject.component().render(58)[1], /main/);
});

test("a no-UI session start tears down the prior browser session and clears its roster", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "no-ui-run", asyncDir: "/tmp/no-ui-run", cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  subject.input()("\x1bo");
  const stalePoll = subject.timers[0].callback;

  subject.start({ hasUI: false }, "startup");

  assert.equal(subject.custom[0].done, 1);
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.ctx.ui.getEditorText(), "unsent draft");
  assert.equal(subject.cleared.length, 1);
  assert.equal(typeof subject.input(), "function");
  assert.equal(subject.events.size, 0);
  assert.deepEqual(globalThis[Symbol.for("pi-config.custom-footer.subagents.v2")].children, []);
  const renders = subject.renders();
  stalePoll();
  assert.equal(subject.renders(), renders);
});

test("empty-roster Alt+O is consumed without opening or changing the editor", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  const original = subject.ctx.ui.getEditorComponent();
  assert.deepEqual(subject.input()("\x1bo"), { consume: true });
  assert.deepEqual(subject.input()("\x1b[111;3u"), { consume: true });
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.custom.length, 0);
});

test("synchronous UI setup failures leave the browser closed and notify once", () => {
  for (const throwAt of ["getEditorComponent", "getEditorText", "setEditorComponent", "custom"]) {
    const subject = runtimeFixture({ throwAt });
    subject.asyncStart({ id: `sync-${throwAt}`, asyncDir: "/tmp/sync", cwd: "/repo", agent: "executor" });
    subject.input()("\x1bo");
    assert.equal(subject.custom.length, 0, throwAt);
    assert.equal(subject.notifications.length, 1, throwAt);
    subject.shutdown(); subject.restore();
  }
});
test("untrusted child transcript paths render a viewport warning", (t) => {
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-browser-status-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "footer-browser-outside-"));
  const subject = runtimeFixture();
  t.after(() => { subject.shutdown(); subject.restore(); fs.rmSync(asyncDir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  subject.asyncStart({ id: "untrusted-run", asyncDir, cwd: "/repo", agent: "executor" });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", steps: [{ agent: "executor", status: "completed", transcriptPath: path.join(outside, "child.jsonl") }] }));
  subject.poll();
  subject.input()("\x1bo");

  assert.match(subject.custom[0].component.render(40).join("\n"), /Transcript is outside trusted roots/);
});

test("relative child sessionFile resolves against asyncDir and renders native transcript before Fleet fallback", async (t) => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "footer-native-sessions-"));
  const asyncDir = fs.mkdtempSync(path.join(sessions, "footer-native-async-"));
  const parent = SessionManager.create("/repo", sessions);
  parent.appendMessage({ role: "user", content: "parent root", timestamp: Date.now() });
  const child = SessionManager.create("/repo", sessions);
  child.appendMessage({ role: "user", content: "native child message", timestamp: Date.now() });
  child.appendMessage({ role: "assistant", content: [{ type: "text", text: "native child reply" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, stopReason: "stop", timestamp: Date.now() });
  const sessionFile = child.getSessionFile();
  assert.ok(sessionFile);
  assert.ok(parent.getSessionFile());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(sessionFile), true);
  const transcriptPath = path.join(asyncDir, "fleet.jsonl");
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Fleet fallback message" }] } }) + "\n");
  const subject = runtimeFixture();
  subject.ctx.sessionManager.getSessionFile = () => parent.getSessionFile();
  t.after(() => { subject.shutdown(); subject.restore(); fs.rmSync(sessions, { recursive: true, force: true }); fs.rmSync(asyncDir, { recursive: true, force: true }); });

  subject.asyncStart({ id: "native-run", asyncDir, cwd: "/repo", agent: "executor" });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", steps: [{ agent: "executor", status: "completed", sessionFile: path.relative(asyncDir, sessionFile), transcriptPath }] }));
  subject.poll();
  subject.input()("\x1bo");
  const rendered = subject.custom[0].component.render(80).join("\n");

  assert.match(rendered, /native child message/);
  assert.doesNotMatch(rendered, /Fleet fallback message/);
});

test("overlay invalidate refreshes cached native child ANSI after a theme change", (t) => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "footer-native-theme-sessions-"));
  const asyncDir = fs.mkdtempSync(path.join(sessions, "footer-native-theme-async-"));
  const parent = SessionManager.create("/repo", sessions);
  const child = SessionManager.create("/repo", sessions);
  child.appendMessage({ role: "assistant", content: [{ type: "text", text: "# themed native child" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, stopReason: "stop", timestamp: Date.now() });
  const sessionFile = child.getSessionFile();
  assert.ok(sessionFile);
  initTheme("dark", false);
  const subject = runtimeFixture();
  subject.ctx.sessionManager.getSessionFile = () => parent.getSessionFile();
  t.after(() => { subject.shutdown(); subject.restore(); initTheme("dark", false); fs.rmSync(sessions, { recursive: true, force: true }); });

  subject.asyncStart({ id: "theme-run", asyncDir, cwd: "/repo", agent: "executor" });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", steps: [{ agent: "executor", status: "completed", sessionFile: path.relative(asyncDir, sessionFile) }] }));
  subject.poll();
  subject.input()("\x1bo");
  const dark = subject.custom[0].component.render(80).join("\n");
  initTheme("light", false);
  subject.custom[0].component.invalidate();
  const light = subject.custom[0].component.render(80).join("\n");

  assert.match(dark, /\x1b\[/);
  assert.match(light, /\x1b\[/);
  assert.notEqual(light, dark);
});

test("native session parse warning falls back once to valid Fleet output", (t) => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "footer-native-warning-sessions-"));
  const asyncDir = fs.mkdtempSync(path.join(sessions, "footer-native-warning-async-"));
  const parent = SessionManager.create("/repo", sessions);
  const brokenSession = path.join(sessions, "broken.jsonl");
  const transcriptPath = path.join(asyncDir, "fleet.jsonl");
  fs.writeFileSync(brokenSession, "not a Pi session\n");
  fs.writeFileSync(transcriptPath, JSON.stringify({ recordType: "message", role: "assistant", text: "Fleet warning fallback message" }) + "\n");
  const subject = runtimeFixture();
  subject.ctx.sessionManager.getSessionFile = () => parent.getSessionFile();
  t.after(() => { subject.shutdown(); subject.restore(); fs.rmSync(sessions, { recursive: true, force: true }); });

  subject.asyncStart({ id: "warning-run", asyncDir, cwd: "/repo", agent: "executor" });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", steps: [{ agent: "executor", status: "completed", sessionFile: path.relative(asyncDir, brokenSession), transcriptPath }] }));
  subject.poll();
  assert.deepEqual(subject.input()("\x1bo"), { consume: true });
  const rendered = subject.custom[0].component.render(80).join("\n");

  assert.match(rendered, /Fleet warning fallback message/);
  assert.equal((rendered.match(/\[Warning:/g) ?? []).length, 0);
});

test("x toggles native tool result visibility while consuming browser input", (t) => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "footer-native-tools-sessions-"));
  const asyncDir = fs.mkdtempSync(path.join(sessions, "footer-native-tools-async-"));
  const parent = SessionManager.create("/repo", sessions);
  const child = SessionManager.create("/repo", sessions);
  child.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: "footer-tool", name: "read", arguments: { path: "fixture.txt" } }],
    api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, stopReason: "toolUse", timestamp: Date.now(),
  });
  child.appendMessage({ role: "toolResult", toolCallId: "footer-tool", toolName: "read", content: [{ type: "text", text: "expanded native tool result" }], isError: false, timestamp: Date.now() });
  const sessionFile = child.getSessionFile();
  assert.ok(sessionFile);
  const subject = runtimeFixture();
  subject.ctx.sessionManager.getSessionFile = () => parent.getSessionFile();
  t.after(() => { subject.shutdown(); subject.restore(); fs.rmSync(sessions, { recursive: true, force: true }); });

  subject.asyncStart({ id: "tool-run", asyncDir, cwd: "/repo", agent: "executor" });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", steps: [{ agent: "executor", status: "completed", sessionFile: path.relative(asyncDir, sessionFile) }] }));
  subject.poll();
  subject.input()("\x1bo");
  const collapsed = subject.custom[0].component.render(80).join("\n");
  assert.deepEqual(subject.input()("x"), { consume: true });
  const expanded = subject.custom[0].component.render(80).join("\n");
  assert.deepEqual(subject.input()("x"), { consume: true });
  const collapsedAgain = subject.custom[0].component.render(80).join("\n");

  assert.notEqual(expanded, collapsed);
  assert.match(expanded, /expanded native tool result/);
  assert.equal(collapsedAgain, collapsed);
});

test("no-UI reload tears down browser resources while preserving the roster for the next UI session", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "reload-no-ui-run", asyncDir: "/tmp/reload-no-ui-run", cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  subject.input()("\x1bo");

  subject.start({ hasUI: false }, "reload");

  assert.equal(subject.custom[0].done, 1);
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.cleared.length, 1);
  assert.equal(typeof subject.input(), "function");
  assert.equal(subject.events.size, 0);
  assert.match(globalThis[Symbol.for("pi-config.custom-footer.subagents.v2")].children[0].agent, /executor/);

  subject.start(subject.ctx, "reload");
  assert.match(subject.component().render(58)[1], /^● executor/);
});

test("overlay promise rejection restores the editor and reports the failure", async (t) => {
  const subject = runtimeFixture({ rejectCustom: true }); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "rejected-run", asyncDir: "/tmp/rejected-run", cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  subject.input()("\x1bo");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.custom[0].done, 1);
  assert.deepEqual(subject.notifications, [{ message: "Subagent browser: overlay failed", level: "error" }]);
});
