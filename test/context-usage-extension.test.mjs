import test from "node:test";
import assert from "node:assert/strict";
import contextUsageExtension from "../pi/extensions/context-usage.ts";
import {
  createHandoffReminderState,
  getHandoffReminder,
} from "../src/context-usage/reminder.ts";

function fakePi() {
  const registered = [];
  const sent = [];
  return {
    registered,
    sent,
    registerTool(definition) {
      registered.push(definition);
    },
      on(name, listener) {
      this.listeners ??= [];
      this.listeners.push({ name, listener });
      return () => {};
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
}

test("达到 handoff 阈值时只生成一次提醒", () => {
  let state = createHandoffReminderState();
  const snapshot = {
    status: "prepare-handoff",
    tokens: 102400,
    contextWindow: 128000,
    percent: 80,
    remainingTokens: 25600,
    remainingRatio: 0.2,
    tokensBeforeHandoff: 0,
    tokensBeforeUrgentHandoff: 12800,
    estimated: true,
    shouldPrepareHandoff: true,
    shouldUrgentlyPrepareHandoff: false,
    handoffPath: ".pi/handoff/context-handoff.md",
  };

  const first = getHandoffReminder(snapshot, state);
  state = first.state;
  const second = getHandoffReminder(snapshot, state);

  assert.ok(first.message);
  assert.equal(second.message, null);
});

test("未知状态不会误发压缩提醒，恢复后可以再次提醒", () => {
  let state = createHandoffReminderState();
  const unknown = getHandoffReminder({ status: "unknown" }, state);
  state = unknown.state;
  assert.equal(unknown.message, null);

  const urgent = getHandoffReminder({
    status: "urgent-handoff",
    tokens: 115200,
    contextWindow: 128000,
    percent: 90,
    remainingTokens: 12800,
    remainingRatio: 0.1,
    handoffPath: ".pi/handoff/context-handoff.md",
  }, state);
  assert.match(urgent.message, /立即/);
});

test("extension 注册无参数 context_usage 工具并返回完整快照", async () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  assert.equal(pi.registered.length, 1);
  assert.equal(pi.registered[0].name, "context_usage");

  const result = await pi.registered[0].execute("call-1", {}, undefined, undefined, {
    getContextUsage() {
      return { tokens: 64000, contextWindow: 128000, percent: 50 };
    },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.tokens, 64000);
  assert.equal(payload.remainingTokens, 64000);
  assert.equal(result.details.status, "normal");
});

test("extension 对未知上下文不发送误报提醒", async () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  await pi.registered[0].execute("call-1", {}, undefined, undefined, {
    getContextUsage() {
      return { tokens: null, contextWindow: 128000, percent: null };
    },
  });
  assert.equal(pi.sent.length, 0);
});

test("agent_end 达到阈值时发送一次非展示性 handoff 提醒", () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  const listener = pi.listeners.find(({ name }) => name === "agent_end").listener;
  const ctx = {
    getContextUsage() {
      return { tokens: 115200, contextWindow: 128000, percent: 90 };
    },
  };

  listener({}, ctx);
  listener({}, ctx);

  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.display, false);
  assert.match(pi.sent[0].message.content, /立即/);
});

test("session_compact 后相同阈值状态可以再次发送 handoff 提醒", () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  const agentEnd = pi.listeners.find(({ name }) => name === "agent_end").listener;
  const sessionCompact = pi.listeners.find(({ name }) => name === "session_compact").listener;
  const ctx = {
    getContextUsage() {
      return { tokens: 115200, contextWindow: 128000, percent: 90 };
    },
  };

  agentEnd({}, ctx);
  sessionCompact({}, ctx);
  agentEnd({}, ctx);

  assert.equal(pi.sent.length, 2);
});
