import assert from "node:assert/strict";
import test from "node:test";
import { registerCompletionNotices } from "../packages/pi-subagents-enhanced/src/tui/completion-notices.ts";
import { openJointSession, sdk } from "./helpers/joint-upgrade-session.mjs";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

function harness() {
  const handlers = new Map();
  const notifications = [];
  const pi = { on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); } };
  const manager = {};
  const context = (mode = "tui") => ({ mode, sessionManager: manager, ui: { notify(text, level) { notifications.push({ text, level }); } } });
  return { pi, handlers, notifications, context, manager };
}

// 只替换终端 I/O；真实 session、agent loop、renderer 和 provider 流全部保留。
test("real InteractiveMode shows hidden completion without another model turn", async (t) => {
  const { jiti } = await loadPiTestRuntime(import.meta.url);
  const { createSubagentToolRenderers } = await jiti.import("../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
  let registration;
  const h = await openJointSession({ factories: [pi => {
    registration = registerCompletionNotices(pi);
    const renderer = createSubagentToolRenderers();
    pi.registerMessageRenderer("subagent-notify", (message, _options, theme) => renderer.renderCompletionNotification(message, theme));
  }] });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let mode;
  try {
    process.env.PI_CODING_AGENT_DIR = h.agentDir;
    const runtime = new sdk.AgentSessionRuntime(h.session, {
      cwd: h.cwd, agentDir: h.agentDir, settingsManager: h.session.settingsManager,
      modelRuntime: h.session.modelRuntime, resourceLoader: h.session.resourceLoader,
    }, async () => { throw new Error("禁止 session 切换"); });
    let starts = 0;
    const terminal = {
      columns: 100, rows: 30, kittyProtocolActive: false,
      start() { starts++; }, stop() {}, async drainInput() {}, write() {},
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    mode = new sdk.InteractiveMode(runtime, { tuiMode: "fullscreen", terminal });
    mode.subscribeToAgent();
    const ui = mode.createExtensionUIContext();
    await h.session.bindExtensions({ mode: "tui", uiContext: ui });
    const requests = [];
    const stream = h.session.modelRuntime.streamSimple.bind(h.session.modelRuntime);
    h.session.modelRuntime.streamSimple = (model, context, options) => {
      requests.push(structuredClone(context.messages));
      return stream(model, context, options);
    };
    const original = { customType: "subagent-notify", content: "Background task completed: **reviewer**\nfixture-output", display: false, details: { runId: "real-1" } };
    const before = structuredClone(original);
    await h.session.sendCustomMessage(original, { triggerTurn: true });
    const render = () => mode.chatContainer.render(100).join("\n");
    assert.match(render(), /reviewer/);
    assert.equal((render().match(/reviewer/g) ?? []).length, 1);
    assert.deepEqual(original, before);
    const saved = h.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].display, false);
    assert.equal(saved[0].content, original.content);
    assert.deepEqual(saved[0].details, original.details);
    assert.equal(h.session.messages.filter(message => message.role === "assistant").length, 1);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].some(message => JSON.stringify(message.content).includes("fixture-output")));
    assert.deepEqual(h.errors, []);

    // display:true 走当前真实卡片，observer 不得再追加同名状态行。
    await h.session.sendCustomMessage({ ...original, display: true, content: "Background task completed: **visible-card**" }, { triggerTurn: true });
    assert.equal((render().match(/visible-card/g) ?? []).length, 1);
    assert.equal(requests.length, 2);

    // 官方相邻 info 合并只保留最后一行，不承诺瞬时提示持久化。
    ui.notify("adjacent-first", "info");
    ui.notify("adjacent-second", "info");
    assert.doesNotMatch(render(), /adjacent-first/);
    assert.match(render(), /adjacent-second/);
    const branch = structuredClone(h.session.sessionManager.getBranch());
    registration.dispose();
    await h.session.sendCustomMessage({ ...original, content: "Background task completed: **disposed-notice**" }, { triggerTurn: true });
    assert.doesNotMatch(render(), /disposed-notice/);
    assert.equal(requests.length, 3);
    assert.deepEqual(h.session.sessionManager.getBranch().slice(0, branch.length), branch);
    t.diagnostic(`3 native sends => 3 provider calls, 3 assistant turns; first hidden message persisted once with display:false; terminal starts=${starts}`);
  } finally {
    registration?.dispose();
    mode?.unsubscribe?.();
    mode?.footer?.dispose();
    mode?.renderer?.stop();
    await h.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("hidden subagent completion is projected once without mutating the original message", async () => {
  const h = harness();
  const disposable = registerCompletionNotices(h.pi);
  const message = { role: "custom", customType: "subagent-notify", content: "Background task completed: **reviewer**", display: false, details: { runId: "r1" } };
  const before = structuredClone(message);
  await h.handlers.get("message_end")({ message }, h.context());
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].text, /reviewer/);
  assert.equal(h.notifications[0].level, "info");
  assert.deepEqual(message, before);
  disposable.dispose();
});

test("visible messages, non-TUI contexts, and non-notifications are not projected", async () => {
  const h = harness();
  const disposable = registerCompletionNotices(h.pi);
  const handler = h.handlers.get("message_end");
  await handler({ message: { role: "custom", customType: "subagent-notify", content: "Background task completed: **visible**", display: true } }, h.context());
  await handler({ message: { role: "custom", customType: "subagent-notify", content: "Background task completed: **print**", display: false } }, h.context("print"));
  await handler({ message: { role: "custom", customType: "subagent-notify", content: "Background task completed: **rpc**", display: false } }, h.context("rpc"));
  await handler({ message: { role: "custom", customType: "other", content: "Background task completed: **other**", display: false } }, h.context());
  assert.deepEqual(h.notifications, []);
  disposable.dispose();
});

test("same object is deduplicated but distinct messages with identical content are not", async () => {
  const h = harness();
  const disposable = registerCompletionNotices(h.pi);
  const handler = h.handlers.get("message_end");
  const first = { role: "custom", customType: "subagent-notify", content: "Background task completed: **same text**", display: false };
  const second = { ...first };
  await handler({ message: first }, h.context());
  await handler({ message: first }, h.context());
  await handler({ message: second }, h.context());
  assert.equal(h.notifications.length, 2);
  disposable.dispose();
});

test("session lifecycle starts a fresh identity set without crossing sessions", async () => {
  const h = harness();
  const disposable = registerCompletionNotices(h.pi);
  const handler = h.handlers.get("message_end");
  const first = { role: "custom", customType: "subagent-notify", content: "Background task completed: **same object**", display: false };
  await handler({ message: first }, h.context());
  await h.handlers.get("session_shutdown")({}, h.context());
  await handler({ message: first }, h.context());
  assert.equal(h.notifications.length, 2);
  disposable.dispose();
});

test("notification errors do not block message observation", async (t) => {
  const diagnostics = [];
  t.mock.method(console, "error", (...args) => diagnostics.push(args));
  const h = harness();
  h.context = () => ({ mode: "tui", sessionManager: h.manager, ui: { notify() { throw new Error("fixture notify failure"); } } });
  const disposable = registerCompletionNotices(h.pi);
  assert.doesNotThrow(() => h.handlers.get("message_end")({ message: { role: "custom", customType: "subagent-notify", content: "Background task completed: **diagnostic**", display: false } }, h.context()));
  assert.equal(diagnostics.length, 1);
  disposable.dispose();
});

test("dispose removes the observer", async () => {
  const h = harness();
  const disposable = registerCompletionNotices(h.pi);
  const message = { role: "custom", customType: "subagent-notify", content: "Background task completed: **after dispose**", display: false };
  disposable.dispose();
  assert.equal(h.handlers.has("message_end"), false);
});
