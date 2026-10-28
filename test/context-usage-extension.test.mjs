import test from "node:test";
import assert from "node:assert/strict";
import contextUsageExtension from "../pi/extensions/context-usage.ts";
import { ContextUsageOutputSchema } from "../src/context-usage/snapshot.ts";

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

test("达到高占用时重复查询仍不生成提醒", async () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  const ctx = { getContextUsage: () => ({ tokens: 102400, contextWindow: 128000, percent: 80 }) };
  const first = await pi.registered[0].execute("call-1", {}, undefined, undefined, ctx);
  const second = await pi.registered[0].execute("call-2", {}, undefined, undefined, ctx);
  assert.equal(first.details.status, "known");
  assert.deepEqual(first.details, second.details);
  assert.deepEqual(pi.sent, []);
});

test("未知状态与后续高占用均不发送压缩提醒", async () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  const unknown = await pi.registered[0].execute("call-1", {}, undefined, undefined, {});
  const urgent = await pi.registered[0].execute("call-2", {}, undefined, undefined, {
    getContextUsage: () => ({ tokens: 115200, contextWindow: 128000, percent: 90 }),
  });
  assert.equal(unknown.details.status, "unknown");
  assert.equal(urgent.details.status, "known");
  assert.deepEqual(pi.sent, []);
});

test("extension 注册无参数 context_usage 工具并返回完整快照", async () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  assert.equal(pi.registered.length, 1);
  assert.equal(pi.registered[0].name, "context_usage");
  assert.equal(pi.registered[0].label, "context_usage");
  assert.ok(pi.registered[0].promptSnippet.length > 0);
  assert.ok(pi.registered[0].promptGuidelines.length > 0);
  assert.doesNotMatch([pi.registered[0].promptSnippet, ...pi.registered[0].promptGuidelines].join("\n"), /handoff/i);
  assert.equal(pi.registered[0].outputSchema, ContextUsageOutputSchema);
  assert.equal(pi.registered[0].exposure, undefined);
  assert.deepEqual(pi.registered[0].parameters.properties, {});
  assert.equal(pi.registered[0].parameters.additionalProperties, false);

  const result = await pi.registered[0].execute("call-1", {}, undefined, undefined, {
    getContextUsage() {
      return { tokens: 64000, contextWindow: 128000, percent: 50 };
    },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.tokens, 64000);
  assert.equal(payload.remainingTokens, 64000);
  assert.equal(result.details.status, "known");
  assert.deepEqual(result.structuredContent, payload);
  assert.equal("note" in result.details, false);
});

test("extension 对未知上下文不发送误报提醒", async () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  const result = await pi.registered[0].execute("call-1", {}, undefined, undefined, {
    getContextUsage() {
      return { tokens: null, contextWindow: 128000, percent: null };
    },
  });
  assert.equal(pi.sent.length, 0);
  assert.equal(result.structuredContent.status, "unknown");
  assert.equal(result.structuredContent.remainingTokens, null);
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
});

test("agent_end 不再安装 handoff 提醒钩子", () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  assert.equal((pi.listeners ?? []).some(({ name }) => name === "agent_end"), false);
  assert.deepEqual(pi.sent, []);
});

test("session_compact 不再安装提醒重置钩子", () => {
  const pi = fakePi();
  contextUsageExtension(pi);
  assert.equal((pi.listeners ?? []).some(({ name }) => name === "session_compact"), false);
  assert.deepEqual(pi.sent, []);
});
