import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti, codingAgent, piTui } = await loadPiTestRuntime(import.meta.url);
const { SessionManager, initTheme } = codingAgent;
const { Text } = piTui;
const customFooterModule = await jiti.import("../packages/pi-subagents-enhanced/extensions/custom-footer.ts");
const footerRuntime = await jiti.import("../packages/pi-subagents-enhanced/src/tui/footer-runtime.ts");
const footerTui = { Key: piTui.Key, isKeyRelease: piTui.isKeyRelease, isKeyRepeat: piTui.isKeyRepeat, matchesKey: piTui.matchesKey, truncateToWidth: piTui.truncateToWidth, visibleWidth: piTui.visibleWidth };
const { SubagentSessionBrowserState } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/session-browser.ts");
const { getTitleRegistry } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts");

initTheme("dark", false);

test("browser selector keeps the selected item visible and accounts for hidden items with terminal widths", () => {
  assert.equal(typeof footerRuntime.formatBrowserSelector, "function");
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

  const narrow = footerRuntime.formatBrowserSelector(snapshot, 1, footerTui);
  assert.match(narrow, /›|\u2026/);

  const middle = footerRuntime.formatBrowserSelector(snapshot, 26, footerTui);
  assert.match(middle, /› \? 中文🙂 \(reviewer\)/);

  const last = footerRuntime.formatBrowserSelector({ ...snapshot, selectedKey: "run:2" }, 24, footerTui);
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
    assert.match(footerRuntime.formatBrowserSelector(snapshot, width, footerTui), /›/, `width ${width}`);
  }
});

test("main selector renders projected terminal-proof status as terminal", () => {
  const snapshot = {
    active: false,
    children: [{ key: "done:0", agent: "executor", state: "terminal-proof" }],
    activeChildren: [],
    recentChildren: [{ key: "done:0", agent: "executor", state: "terminal-proof" }],
  };
  assert.equal(footerRuntime.formatBrowserSelector(snapshot, 80, footerTui), "");
});

test("main selector projects negotiated retained status as active", () => {
  const snapshot = {
    active: false,
    children: [{ key: "active:0", agent: "executor", state: "retained" }],
    activeChildren: [{ key: "active:0", agent: "executor", state: "retained" }],
    recentChildren: [],
  };
  assert.equal(footerRuntime.formatBrowserSelector(snapshot, 80, footerTui), "● executor");
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

  const selector = footerRuntime.formatBrowserSelector(snapshot, 80, footerTui);
  assert.equal(selector, "● executor\n◯ history 2");
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
  assert.match(footerRuntime.formatBrowserSelector(snapshot, 80, footerTui), /◯ history 1$/);
});

test("main selector is empty when no child remains active", () => {
  const terminalChildren = [{ key: "done:0", runId: "done", agent: "reviewer", state: "completed" }];
  const snapshot = { active: false, children: terminalChildren, activeChildren: [], recentChildren: terminalChildren };
  assert.equal(footerRuntime.formatBrowserSelector(snapshot, 80, footerTui), "");
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

  const selector = footerRuntime.formatBrowserSelector(snapshot, 100, footerTui);
  const flattenedSelector = selector.replace(/\s+/g, " ");

  assert.match(selector, /This is an accidentally verbose/);
  assert.match(flattenedSelector, /original task text and keeps going/);
  assert.match(flattenedSelector, /history 1/);
  assert.deepEqual(snapshot, before);

  const childSelector = footerRuntime.formatBrowserSelector({
    ...snapshot,
    active: true,
    selectedKey: "long:0",
  }, 58, footerTui);
  assert.match(childSelector, /^› ● This is an accidentally verbose/);
  assert.deepEqual(snapshot, before);
});

test("selector wraps long child labels without ellipsis and aligns continuation text", () => {
  const selector = footerRuntime.formatBrowserSelector({
    active: true,
    selectedKey: "long:0",
    children: [{
      key: "long:0", agent: "executor", state: "running",
      label: "A very long dispatch title that must remain fully visible",
    }],
    activeChildren: [],
    recentChildren: [],
  }, 24, footerTui);
  const lines = selector.split("\n");
  assert.equal(lines.length > 2, true);
  assert.doesNotMatch(selector, /\.\.\./);
  assert.match(lines[0], /^› ● /);
  for (const line of lines.slice(1)) assert.match(line, /^    /);
  const flattened = lines.join(" ");
  assert.match(flattened, /A very long dispatch/);
  assert.match(flattened, /fully visible/);
});

test("main selector wraps a long active label while retaining history counter", () => {
  const selector = footerRuntime.formatBrowserSelector({
    active: false,
    selectedKey: undefined,
    children: [],
    activeChildren: [{ key: "main:0", runId: "main", agent: "executor", state: "running", label: "A long active dispatch title" }],
    recentChildren: [{ key: "done:0", runId: "done", agent: "reviewer", state: "completed" }],
  }, 18, footerTui);
  assert.doesNotMatch(selector, /\.\.\./);
  assert.match(selector, /A long active/);
  assert.match(selector, /dispatch title/);
  assert.match(selector, /history 1/);
  for (const line of selector.split("\n").slice(1).filter((line) => !line.includes("history"))) assert.match(line, /^  /);
});

test("main selector places history on its own physical row after wrapped active entries", () => {
  const selector = footerRuntime.formatBrowserSelector({
    active: false,
    selectedKey: undefined,
    children: [],
    activeChildren: [{ key: "main-long:0", runId: "main-long", agent: "executor", state: "running", label: "A long active dispatch title" }],
    recentChildren: [{ key: "done:0", runId: "done", agent: "reviewer", state: "completed" }],
  }, 18, footerTui);
  const lines = selector.split("\n");
  const historyIndex = lines.findIndex((line) => line.includes("◯ history 1"));
  assert.ok(historyIndex > 0);
  assert.doesNotMatch(lines[historyIndex - 1], /history/);
  assert.match(lines[historyIndex], /^●?\s*◯ history 1$/);
  for (const line of lines.slice(1, historyIndex)) assert.match(line, /^  /);
});

test("footer expands wrapped selector rows before the thinking row", () => {
  const snapshot = {
    active: true,
    selectedKey: "long:0",
    selected: { key: "long:0", agent: "executor", state: "running", label: "A very long dispatch title that needs wrapping", model: "provider/model" },
    children: [{ key: "long:0", agent: "executor", state: "running", label: "A very long dispatch title that needs wrapping" }],
    activeChildren: [{ key: "long:0", agent: "executor", state: "running", label: "A very long dispatch title that needs wrapping" }],
    recentChildren: [],
  };
  const component = footerRuntime.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }), getThinkingLevel: () => "medium",
    getSnapshot: () => snapshot, getViewportPosition: () => ({ start: 1, end: 1, total: 1 }), requestRender() {},
    theme: { fg: (_color, value) => value }, tui: footerTui,
  });
  const lines = component.render(40);
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines[2], /\n/);
  assert.match(lines[2], /thinking: medium$/);
});

test("footer keeps thinking on the fixed third row when main selector wraps with history", () => {
  const snapshot = {
    active: false,
    selectedKey: undefined,
    children: [],
    activeChildren: [{ key: "main-wrap:0", runId: "main-wrap", agent: "executor", state: "running", label: "A long active dispatch title that needs wrapping" }],
    recentChildren: [{ key: "done:0", runId: "done", agent: "reviewer", state: "completed" }],
  };
  const component = footerRuntime.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home", getModel: () => ({ provider: "provider", id: "long-model-name" }),
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }), getThinkingLevel: () => "xhigh",
    getSnapshot: () => snapshot, getViewportPosition: () => undefined, requestRender() {},
    theme: { fg: (_color, value) => value }, tui: footerTui,
  });
  const lines = component.render(40);
  assert.ok(lines.length > 3);
  assert.doesNotMatch(lines[2], /\n/);
  assert.match(lines[2], /thinking: xhigh$/);
  assert.match(lines.at(-1), /◯ history 1/);
});

test("main footer shows every active child without count folding", () => {
  const activeChildren = ["One long active dispatch title", "Second task", "Third task", "Fourth task"].map((label, index) => ({
    key: `active-${index}:0`, runId: `active-${index}`, agent: index === 0 ? "executor" : "delegate", state: "running", label,
  }));
  const snapshot = {
    active: false,
    selectedKey: undefined,
    children: activeChildren,
    activeChildren,
    recentChildren: [{ key: "done:0", runId: "done", agent: "reviewer", state: "completed" }],
  };
  const component = footerRuntime.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home", getModel: () => ({ provider: "provider", id: "model" }),
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }), getThinkingLevel: () => "xhigh",
    getSnapshot: () => snapshot, getViewportPosition: () => undefined, requestRender() {},
    theme: { fg: (_color, value) => value }, tui: footerTui,
  });
  const rendered = component.render(60).join("\n");
  for (const label of ["One long active dispatch title", "Second task", "Third task", "Fourth task"]) assert.match(rendered, new RegExp(label));
  assert.match(rendered, /◯ history 1/);
  assert.doesNotMatch(rendered, /\+\d/);
  assert.match(component.render(60)[2], /thinking: xhigh$/);
  assert.match(component.render(60).at(-1), /◯ history 1$/);
});

test("wide main selector never returns an early count-folded first item", () => {
  const activeChildren = ["First", "Second", "Third", "Fourth"].map((label, index) => ({
    key: `wide-${index}:0`, runId: `wide-${index}`, agent: "executor", state: "running", label,
  }));
  const selector = footerRuntime.formatBrowserSelector({
    active: false,
    selectedKey: undefined,
    children: activeChildren,
    activeChildren,
    recentChildren: [{ key: "wide-done:0", runId: "wide-done", agent: "reviewer", state: "completed" }],
  }, 30, footerTui);
  assert.doesNotMatch(selector, /\+\d/);
  for (const label of ["First", "Second", "Third", "Fourth"]) assert.match(selector, new RegExp(label));
  assert.match(selector.split("\n").at(-1), /◯ history 1/);
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

  const selector = footerRuntime.formatBrowserSelector(snapshot, 200, footerTui);
  assert.match(selector, /  ● executor/);
  assert.match(selector, /› ✓ 中文🙂 \(reviewer\)/);
  assert.match(selector, /  ! tester/);
  assert.match(selector, /  Ⅱ planner/);
  assert.match(selector, /  ■ writer/);
  assert.match(selector, /  \? observer/);
  assert.doesNotMatch(selector, /main|[◯⏺] [●✓✗Ⅱ■?]/);

  const first = footerRuntime.formatBrowserSelector({ ...snapshot, selectedKey: "active:0" }, 200, footerTui);
  assert.match(first, /^› ● executor/);

  const narrow = footerRuntime.formatBrowserSelector(snapshot, 18, footerTui);
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
  assert.equal(typeof footerRuntime.createFooterComponent, "function");
  const snapshot = {
    active: true,
    selectedKey: "child:0",
    selected: { key: "child:0", agent: "executor", state: "running", cwd: "/repo", tokens: 54_321, model: "provider/model" },
    children: [{ key: "child:0", agent: "executor", state: "running" }],
    activeChildren: [{ key: "child:0", agent: "executor", state: "running" }],
    recentChildren: [],
  };
  const component = footerRuntime.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home/test", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 70, contextWindow: 100_000 }), getThinkingLevel: () => "off",
    getSnapshot: () => snapshot, getViewportPosition: () => ({ start: 120, end: 139, total: 434 }),
    requestRender() {}, theme: { fg: (_color, text) => text }, tui: footerTui,
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
  const component = footerRuntime.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home/test", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 70, contextWindow: 100_000 }), getThinkingLevel: () => "off",
    getSnapshot: () => snapshot, getViewportPosition: () => position,
    requestRender() {}, theme: { fg: (_color, text) => text }, tui: footerTui,
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
  const component = footerRuntime.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home/test", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 70, contextWindow: 100_000 }), getThinkingLevel: () => "off",
    getSnapshot: () => snapshot, getViewportPosition: () => ({ start: 120, end: 139, total: 434 }),
    requestRender() {}, theme: { fg: (_color, text) => text }, tui: footerTui,
  });

  assert.equal(component.render(11)[0], "120-139/434");
  assert.match(component.render(10)[0], /^120-139\/4\x1b\[0m…\x1b\[0m$/);
});

test("footer displays only the adapter task summary on the third line without adding rows", () => {
  const extensionStatuses = new Map([["pi-scheduler", "⏱ Daily backup"]]);
  const snapshot = { active: false, selectedKey: undefined, selected: undefined, children: [], activeChildren: [], recentChildren: [] };
  const component = footerRuntime.createFooterComponent({
    getCwd: () => "/repo", getHome: () => "/home/test", getModel: () => ({ id: "main" }),
    getContextUsage: () => ({ percent: 1, contextWindow: 100 }), getThinkingLevel: () => "off",
    getSnapshot: () => snapshot, getViewportPosition: () => undefined,
    getExtensionStatuses: () => extensionStatuses,
    requestRender() {}, theme: { fg: (_color, text) => text }, tui: footerTui,
  });

  const active = component.render(80);
  assert.equal(active.length, 3);
  assert.match(active[2], /^⏱ Daily backup\s+thinking: off$/);

  extensionStatuses.set("pi-scheduler", "scheduler: idle");
  assert.doesNotMatch(component.render(80)[2], /scheduler|⏱/);
  extensionStatuses.set("pi-scheduler", "scheduler: active");
  assert.doesNotMatch(component.render(80)[2], /scheduler|⏱/);
  extensionStatuses.set("pi-scheduler", "⏱ Daily backup");
  assert.match(component.render(80)[2], /^⏱ Daily backup\s+thinking: off$/);
  extensionStatuses.set("pi-scheduler", "");
  assert.doesNotMatch(component.render(80)[2], /scheduler/);
  extensionStatuses.delete("pi-scheduler");
  assert.doesNotMatch(component.render(80)[2], /scheduler/);
});

// F2b-v fixture 身份：production 派发事件必带父 session 身份（F0 记录 §2/§4：缺失时
// asyncCtx 构造直接 throw），真实 SessionManager 公开接口含 getCwd/getSessionId/
// getSessionFile（session 落盘前 getSessionFile 返回 null）。旧 fixture manager 只有
// getSessionFile:null 且事件缺/伪造 sessionId（含字面量 "parent"），属类别 2 fixture
// 污染；此处只修 fixture 为真实公开接口投影，事件默认注入所属 manager 当前 UUID
//（file/UUID 双形态接受由 F2b provider 新测覆盖），production 无任何 fallback。
const FIXTURE_SESSION_UUID = "0e2ea6d2-9f2f-4a1c-8b70-6f1f2f3f4f5f";
const OTHER_SESSION_UUID = "99999999-9999-4999-8999-999999999999";

function fixtureSessionManager({ cwd = "/repo", sessionId = FIXTURE_SESSION_UUID, sessionFile = null } = {}) {
  return { getCwd: () => cwd, getSessionId: () => sessionId, getSessionFile: () => sessionFile };
}

function register(map, name, handler) {
  const handlers = map.get(name) ?? [];
  handlers.push(handler); map.set(name, handlers);
  return () => map.delete(name);
}

function setup(reason, options = {}) {
  const handlers = new Map(); const events = new Map(); let footerFactory; let shortcut;
  const pi = { on: (name, handler) => register(handlers, name, handler), events: { on: (name, handler) => register(events, name, handler) }, getThinkingLevel: () => "high", getAllTools: () => [], registerShortcut(_key, definition) { shortcut = definition; } };
  customFooterModule.default(pi);
  const ctx = {
    mode: "tui", hasUI: true, cwd: `${process.env.HOME}/workspace`, model: { provider: "codex-pool", id: "gpt-5.6-sol", contextWindow: 272_000 },
    getContextUsage: () => ({ tokens: 207_000, contextWindow: 272_000, percent: 76.1 }), sessionManager: options.manager ?? fixtureSessionManager({ cwd: `${process.env.HOME}/workspace` }),
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
  return { component, input: () => input, asyncStart: (event) => events.get("subagent:async-started")[0]({ sessionId: FIXTURE_SESSION_UUID, ...event }), complete: (event) => events.get("subagent:async-complete")[0]({ sessionId: FIXTURE_SESSION_UUID, ...event }), shutdown: (reason) => handlers.get("session_shutdown")[0]({ reason }, ctx), events };
}

test("footer renders a fixed three-line child status row", (t) => {
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  subject.asyncStart({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agents: ["executor", "reviewer"] });
  const lines = subject.component.render(58);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^● executor/);
  assert.match(lines[2], /^● reviewer/);
  assert.doesNotMatch(lines[1], /main/);
  assert.match(lines[1], /\(codex-pool\) gpt-5\.6-sol$/);
});

test("footer keeps the dispatch title when 0.62.0 redacts async-start task and omits title", (t) => {
  const registry = getTitleRegistry();
  registry.prepare({ agent: "executor", task: "Implement the footer fix", title: "Investigate footer" });
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  subject.asyncStart({ id: "redacted-title-run", asyncDir: "/tmp/redacted-title-run", cwd: "/repo", agent: "executor", task: "[prompt redacted]", goal: "[prompt redacted]" });
  assert.match(subject.component.render(80)[1], /Investigate footer \(executor\)/);
  assert.doesNotMatch(subject.component.render(80)[1], /typed-/);
});

test("footer does not consume the next pending title when runtime event already has a title", (t) => {
  const registry = getTitleRegistry();
  registry.prepare({ agent: "executor", task: "first prompt", title: "First concurrent title" });
  registry.prepare({ agent: "executor", task: "second prompt", title: "Second concurrent title" });
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  const emitThroughRuntime = (id, task) => {
    const raw = { id, asyncDir: `/tmp/${id}`, cwd: "/repo", agent: "executor", task };
    const title = registry.started(raw);
    subject.asyncStart(title ? { ...raw, title } : raw);
  };
  emitThroughRuntime("concurrent-first", "first prompt");
  emitThroughRuntime("concurrent-second", "second prompt");
  const rendered = subject.component.render(100).join("\n");
  assert.match(rendered, /First concurrent title \(executor\)/);
  assert.match(rendered, /Second concurrent title \(executor\)/);
  assert.doesNotMatch(rendered, /^● executor$/m);
});

test("selector recovers authoritative run titles after reload without rewriting persisted roster", () => {
  const registry = getTitleRegistry();
  registry.remember("reload-missing", "Recovered missing title");
  registry.remember("reload-wrong", "Recovered correct title");
  const activeChildren = [
    { key: "reload-missing:0", runId: "reload-missing", agent: "executor", state: "running" },
    { key: "reload-wrong:0", runId: "reload-wrong", agent: "executor", state: "running", label: "Stale wrong title" },
    { key: "untyped:0", runId: "untyped", agent: "delegate", state: "running", label: "Untyped label" },
  ];
  const snapshot = { active: false, selectedKey: undefined, children: activeChildren, activeChildren, recentChildren: [] };
  const before = structuredClone(snapshot);
  const rendered = footerRuntime.formatBrowserSelector(snapshot, 100, footerTui);
  assert.match(rendered, /Recovered missing title \(executor\)/);
  assert.match(rendered, /Recovered correct title \(executor\)/);
  assert.match(rendered, /Untyped label \(delegate\)/);
  assert.doesNotMatch(rendered, /Stale wrong title|^● executor$/m);
  assert.deepEqual(snapshot, before);
  assert.equal(registry.titleFor("reload-missing"), "Recovered missing title");
  assert.equal(registry.titleFor("reload-wrong"), "Recovered correct title");
});

test("child mode reserves the directional focus glyph when a long model label would otherwise take the second line", (t) => {
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  subject.asyncStart({ id: "narrow-run", asyncDir: "/tmp/narrow-run", cwd: "/repo", agent: "executor" });
  subject.input()("\x1bo");
  const lines = subject.component.render(14);
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes("›"));
});
test("browser input consumes Alt+O and legacy inspector input instead of rewriting shortcuts", (t) => {
  const subject = setup(); t.after(() => subject.shutdown("quit"));
  subject.asyncStart({ id: "run-2", asyncDir: "/tmp/run-2", cwd: "/repo", agent: "executor" });
  assert.deepEqual(subject.input()("\x1bo"), { consume: true });
  assert.deepEqual(subject.input()("\x1b\x06"), { consume: true });
  assert.deepEqual(subject.input()("\x1b"), { consume: true });
});

test("reload preserves the roster across factory recreation for the same manager and session", (t) => {
  // 旧 global 槽断言转 (manager, 逻辑 sessionID) 分区的外部行为：同一模块内重新
  // default(pi) 的 factory 重建 + 同 manager/session 重新 start，plain rows 恢复
  //（这是同模块 factory 重建证据；SDK moduleCache clear 的真实跨模块重载由 F2b
  // provider 新测以 jiti moduleCache:false 重 import 覆盖）；async listeners 仍在
  // shutdown 时退订清空。
  const manager = fixtureSessionManager({ cwd: `${process.env.HOME}/workspace` });
  const first = setup("startup", { manager }); t.after(() => first.shutdown("quit"));
  first.asyncStart({ id: "reload-run", asyncDir: "/tmp/reload-run", cwd: "/repo", agent: "reviewer" });
  first.shutdown("reload");
  assert.equal(first.events.size, 0);
  const second = setup("reload", { manager }); t.after(() => second.shutdown("quit"));
  assert.match(second.component.render(58)[1], /^● reviewer/);
  assert.doesNotMatch(second.component.render(58)[1], /main/);
});

test("a stale unpartitioned v2 global slot is neither inherited nor rewritten by the partitioned roster", (t) => {
  // F2b 分区设计不做旧未分区 v2 槽迁移（fresh restore 限制按 fail closed 处理）：
  // 预置旧槽后以全新 manager/session 启动，roster 保持为空（明确不继承未知 slot），
  // 旧槽对象原样保留（既不消费也不改写/删除）。roster 延续语义由 (manager, 逻辑
  // sessionID) 分区承担，见同 manager/session 跨 factory reload 用例。
  const key = Symbol.for("pi-config.custom-footer.subagents.v2");
  const previous = globalThis[key];
  const oldState = new SubagentSessionBrowserState();
  oldState.trackStarted({ id: "legacy-run", asyncDir: "/tmp/legacy-run", cwd: "/repo", agent: "executor" });
  const legacySlot = { browser: oldState };
  globalThis[key] = legacySlot;
  t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });

  const subject = setup("startup"); t.after(() => subject.shutdown("quit"));
  assert.doesNotMatch(subject.component.render(58)[1], /executor/);
  assert.equal(globalThis[key], legacySlot);
  assert.equal("browser" in globalThis[key], true);
});

function runtimeFixture(fixtureOptions = {}) {
  const handlers = new Map(); const events = new Map(); const timers = []; const cleared = []; const custom = []; const editorFactories = []; const notifications = [];
  let shortcut; let editor = function OriginalEditor() {}; let draft = "unsent draft"; let footerFactory; let footerInstalls = 0; let renders = 0;
  const originalSetInterval = globalThis.setInterval; const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback) => { const timer = { callback, unrefCalls: 0, unref() { this.unrefCalls += 1; } }; timers.push(timer); return timer; };
  globalThis.clearInterval = (timer) => { cleared.push(timer); };
  const pi = { on: (name, handler) => register(handlers, name, handler), events: { on: (name, handler) => register(events, name, handler) }, getThinkingLevel: () => "high", getAllTools() { throw new Error("ToolInfo must not be consumed as renderer"); }, registerShortcut(_key, definition) { shortcut = definition; } };
  customFooterModule.default(pi);
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/repo", model: { id: "model" }, getContextUsage: () => ({ percent: 1, contextWindow: 100 }), sessionManager: fixtureSessionManager(),
    ui: {
      onTerminalInput() { throw new Error("browser must not install a global terminal input listener"); }, setFooter(factory) { footerFactory = factory; footerInstalls += 1; },
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
    ctx, shortcut, timers, cleared, custom, editorFactories, notifications, events, input: () => input, component: () => footerFactory?.({ requestRender() {} }, { fg: (_c, value) => value }, {}), renders: () => renders, footerInstalls: () => footerInstalls,
    start: (next = ctx, reason) => handlers.get("session_start")[0]({ reason }, next), asyncStart: (event) => events.get("subagent:async-started")[0]({ sessionId: FIXTURE_SESSION_UUID, ...event }),
    shutdown: (reason = "quit") => handlers.get("session_shutdown")[0]({ reason }, ctx), poll: (index = timers.length - 1) => timers[index].callback(), restore() { globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; },
  };
}

test("footer polls raw workflow and leaf runs while rendering one canonical conversation", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-workflow-root-"));
  const leafDir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-workflow-leaf-"));
  const subject = runtimeFixture();
  t.after(() => {
    subject.shutdown(); subject.restore();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(leafDir, { recursive: true, force: true });
  });
  subject.asyncStart({ id: "workflow-root", mode: "workflow", agent: "workflow", asyncDir: rootDir, cwd: "/repo", workflowKey: "typed-key" });
  subject.asyncStart({ id: "workflow-leaf", mode: "single", agent: "reviewer", asyncDir: leafDir, cwd: "/repo", parentWorkflowRunId: "workflow-root", workflowKey: "typed-key", title: "审阅任务" });
  fs.writeFileSync(path.join(rootDir, "status.json"), JSON.stringify({ state: "complete", mode: "workflow", steps: [{ runId: "workflow-leaf", agent: "reviewer", workflowKey: "typed-key", status: "running" }] }));
  fs.writeFileSync(path.join(leafDir, "status.json"), JSON.stringify({ state: "running", mode: "single", parentWorkflowRunId: "workflow-root", workflowKey: "typed-key", steps: [{ agent: "reviewer", status: "running", model: "fixture/reviewer", thinking: "high", tokens: { total: 4321 }, sessionFile: path.join(leafDir, 'session.jsonl') }] }));
  const rootBytes = fs.readFileSync(path.join(rootDir, 'status.json'), 'utf8');
  const leafBytes = fs.readFileSync(path.join(leafDir, 'status.json'), 'utf8');
  subject.poll();

  const rendered = subject.component().render(100).join("\n");
  assert.match(rendered, /审阅任务 \(reviewer\)/);
  assert.doesNotMatch(rendered, /workflow-root|\(workflow\)/);
  assert.doesNotMatch(rendered, /history/);
  assert.equal((rendered.match(/审阅任务/g) ?? []).length, 1);
  assert.equal(fs.readFileSync(path.join(rootDir, 'status.json'), 'utf8'), rootBytes);
  assert.equal(fs.readFileSync(path.join(leafDir, 'status.json'), 'utf8'), leafBytes);
  subject.start(subject.ctx, 'reload');
  // 旧 global 槽 children 集合断言转外部行为：canonical workflow roster（root facade
  // 与 leaf 的确认关系）经 (manager, 逻辑 sessionID) 分区跨 reload 保留——root 被确认
  // 折叠、leaf 以 canonical 标签单次出现。
  const reloaded = subject.component().render(100).join('\n');
  assert.match(reloaded, /审阅任务 \(reviewer\)/);
  assert.equal((reloaded.match(/审阅任务/g) ?? []).length, 1);
  assert.doesNotMatch(reloaded, /workflow-root|\(workflow\)/);
  fs.writeFileSync(path.join(rootDir, 'status.json'), JSON.stringify({ state:'complete', mode:'workflow', steps:[
    {runId:'workflow-leaf',agent:'reviewer',workflowKey:'typed-key',status:'running'},
    {runId:'next-leaf',agent:'executor',workflowKey:'next-key',label:'后续步骤',status:'running'},
  ] }));
  subject.poll();
  subject.input()('\x1bo');
  const childFooter = subject.component().render(180).join('\n');
  assert.match(childFooter, /后续步骤/);
  assert.match(childFooter, /4.3k tokens/);
  assert.match(childFooter, /\(fixture\) reviewer/);
  assert.equal(subject.custom[0].done, 0);
  subject.asyncStart({ id:'next-leaf', mode:'single', agent:'executor', asyncDir:path.join(rootDir,'next'), cwd:'/repo', parentWorkflowRunId:'workflow-root', workflowKey:'next-key', title:'第二任务' });
  subject.poll();
  const folded = subject.component().render(180).join('\n');
  assert.match(folded, /第二任务/);
  assert.doesNotMatch(folded, /后续步骤/);
  assert.equal(subject.custom[0].done, 0);
});

test("Alt+O accepts a distinct shortcut context for the live session manager only", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "shortcut-run", asyncDir: "/tmp/shortcut-run", cwd: "/repo", agent: "executor" });

  subject.shortcut.handler({ sessionManager: subject.ctx.sessionManager });
  assert.equal(subject.custom.length, 1);
  subject.custom[0].component.handleInput("\x1b");
  subject.shortcut.handler({ sessionManager: fixtureSessionManager({ sessionId: OTHER_SESSION_UUID }) });
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

test("roster follows the manager/session partition: same session restarts keep it and a new manager starts empty", (t) => {
  // 旧「按 reason 清理」语义已被 F2b manager×逻辑 sessionID 分区取代：同 manager 同
  // session 的再次 start（无论 startup/reload）恢复分区；切 manager（new/fork/switch
  // 的新 SessionManager）取空分区且不串写原 manager 分区；旧代 poll 仍被隔离。
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "old-run", asyncDir: "/tmp/old-run", cwd: "/repo", agent: "executor" });
  const stalePoll = subject.timers[0].callback;
  subject.start(subject.ctx, "startup");
  assert.match(subject.component().render(58)[1], /^● executor/);
  const renders = subject.renders();
  stalePoll();
  assert.equal(subject.renders(), renders);
  subject.start({ ...subject.ctx, sessionManager: fixtureSessionManager({ sessionId: OTHER_SESSION_UUID }) }, "new");
  assert.doesNotMatch(subject.component().render(58)[1], /executor/);
  subject.start(subject.ctx, "reload");
  assert.match(subject.component().render(58)[1], /^● executor/, "原 manager 分区未被新 manager 会话串写");
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

test("an RPC session with UI support tears down the prior terminal browser without installing TUI", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "no-ui-run", asyncDir: "/tmp/no-ui-run", cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  subject.input()("\x1bo");
  const stalePoll = subject.timers[0].callback;

  subject.start({ mode: "rpc", hasUI: true }, "startup");

  assert.equal(subject.custom[0].done, 1);
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.ctx.ui.getEditorText(), "unsent draft");
  assert.equal(subject.cleared.length, 1);
  assert.equal(typeof subject.input(), "function");
  assert.equal(subject.events.size, 0);
  assert.equal(subject.footerInstalls(), 1, "RPC start 不安装 TUI footer");
  const renders = subject.renders();
  stalePoll();
  assert.equal(subject.renders(), renders);
  // 旧 global 槽 children:[] 断言转外部行为：非 TUI start 不清 (manager, 逻辑
  // sessionID) 分区（不 UI reload 清理），同 manager/session 的后续 TUI reload 恢复。
  subject.start(subject.ctx, "reload");
  assert.equal(subject.footerInstalls(), 2);
  assert.match(subject.component().render(58)[1], /^● executor/);
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

  assert.match(subject.custom[0].component.render(40).join("\n"), /Transcript is (?:outside trusted roots|unavailable)/);
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

test("x toggles native tool result visibility while consuming browser input", async (t) => {
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
  const { createChildConversationRenderers } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/tool-renderers.ts");
  const preview = createChildConversationRenderers("/repo");
  assert.equal(preview.resolveToolRenderer("third-party"), undefined);
  assert.deepEqual(Object.keys(preview.resolveToolRenderer("read")).sort(), ["renderCall", "renderResult", "renderShell"]);
  // 旧历史工具名仍可解析（只用于渲染历史），新每操作工具名同样可解析。
  assert.equal(typeof preview.resolveToolRenderer("subagent").renderCall, "function");
  assert.equal(typeof preview.resolveToolRenderer("subagent_supervisor").renderResult, "function");
  for (const name of ["subagent_roster", "subagent_start", "subagent_run_status", "subagent_run_steer", "subagent_run_interrupt", "subagent_run_resume", "subagent_run_stop"]) {
    assert.equal(typeof preview.resolveToolRenderer(name).renderCall, "function", `${name} renderCall`);
    assert.equal(typeof preview.resolveToolRenderer(name).renderResult, "function", `${name} renderResult`);
  }
  for (const name of ["supervisor_request_pending", "supervisor_request_status", "supervisor_request_reply"]) {
    assert.equal(typeof preview.resolveToolRenderer(name).renderResult, "function", `${name} renderResult`);
  }
  // workspace 四工具本 package 无自有 renderer，仍由 Host fallback 渲染（不伪造投影）。
  assert.equal(preview.resolveToolRenderer("managed_workspace_status"), undefined);
  assert.equal(preview.resolveToolRenderer("subagent_worktree"), undefined);
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
  assert.match(collapsed, /fixture\.txt/);
  assert.match(expanded, /expanded native tool result/);
  assert.equal(collapsedAgain, collapsed);
});

test("no-UI reload tears down browser resources while preserving the roster for the next UI session", (t) => {
  const subject = runtimeFixture(); t.after(() => { subject.shutdown(); subject.restore(); });
  subject.asyncStart({ id: "reload-no-ui-run", asyncDir: "/tmp/reload-no-ui-run", cwd: "/repo", agent: "executor" });
  const original = subject.ctx.ui.getEditorComponent();
  subject.input()("\x1bo");

  subject.start({ mode: "print", hasUI: false }, "reload");

  assert.equal(subject.custom[0].done, 1);
  assert.equal(subject.ctx.ui.getEditorComponent(), original);
  assert.equal(subject.cleared.length, 1);
  assert.equal(typeof subject.input(), "function");
  assert.equal(subject.events.size, 0);
  // 旧 global 槽 children[0].agent 断言转外部行为：非 UI reload 不清 (manager,
  // 逻辑 sessionID) 分区，roster 保留语义由下方同 manager/session TUI reload 的
  // 恢复断言承担。

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
