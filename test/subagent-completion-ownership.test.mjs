import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessSubagentApi } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const runtimeJiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { registerSubagentNotify } = await runtimeJiti.import("../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts");

function createPi() {
  const listeners = new Map();
  const messages = [];
  return {
    messages,
    events: {
      on(type, handler) {
        const handlers = listeners.get(type) ?? [];
        handlers.push(handler);
        listeners.set(type, handlers);
        return () => handlers.splice(handlers.indexOf(handler), 1);
      },
      emit(type, payload) {
        for (const handler of listeners.get(type) ?? []) handler(payload);
      },
    },
    sendMessage(message, options) { messages.push({ message, options }); },
  };
}

test("completion ownership trace distinguishes the existing foreground and async branches", () => {
  const pi = createPi();
  const trace = [];
  const api = createHeadlessSubagentApi(pi, {
    workingStateTrace(entry) { trace.push(entry); },
    getHostIdentity() { return { hostSessionId: "host-session", completionOwnerId: "host-owner" }; },
  });

  api.events.on("subagent:async-complete", () => {});
  api.events.on("subagent:foreground-complete", () => {});
  pi.events.emit("subagent:async-complete", {
    runId: "async-mismatch", sessionId: "host-session", completionOwnerId: "other-owner", source: "async",
  });
  pi.events.emit("subagent:foreground-complete", {
    runId: "foreground-match", sessionId: "host-session", completionOwnerId: "other-owner", source: "foreground",
  });
  pi.events.emit("subagent:foreground-complete", {
    runId: "foreground-mismatch", sessionId: "other-session", completionOwnerId: "host-owner", source: "foreground",
  });

  assert.deepEqual(trace.map((entry) => entry.event), [
    "completion-received", "ownership-mismatch",
    "completion-received", "ownership-match",
    "completion-received", "ownership-mismatch",
  ]);
  assert.equal(trace[1].ownershipDecision, "async-session-and-owner-mismatch");
  assert.equal(trace[3].ownershipDecision, "foreground-session-match");
  assert.equal(trace[5].ownershipDecision, "foreground-session-mismatch");
});

test("sendMessage trace captures triggerTurn without retaining message content", () => {
  const pi = createPi();
  const trace = [];
  const api = createHeadlessSubagentApi(pi, {
    workingStateTrace(entry) { trace.push(entry); },
    getHostIdentity() { return { hostSessionId: "host-session", completionOwnerId: "host-owner" }; },
  });

  api.sendMessage({ customType: "subagent-notify", content: "must not trace", display: false }, { triggerTurn: false });

  assert.deepEqual(trace.map(({ event, customType, triggerTurn, display }) => ({ event, customType, triggerTurn, display })), [
    { event: "send-message", customType: "subagent-notify", triggerTurn: false, display: false },
  ]);
  assert.doesNotMatch(JSON.stringify(trace), /must not trace/);
  assert.equal(pi.messages.length, 1);
});

test("completion batching, suppression, and failed sends never manufacture a delivery run identity", () => {
  const pi = createPi();
  const trace = [];
  const api = createHeadlessSubagentApi(pi, {
    workingStateTrace(entry) { trace.push(entry); },
    getHostIdentity() { return { hostSessionId: "host-session", completionOwnerId: "host-owner" }; },
    suppressSuccessfulCompletion(event) { return event.runId === "deduped-run"; },
  });
  api.events.on("subagent:async-complete", () => {});
  pi.events.emit("subagent:async-complete", { runId: "batched-run", sessionId: "host-session", completionOwnerId: "host-owner" });
  pi.events.emit("subagent:async-complete", { runId: "deduped-run", sessionId: "host-session", completionOwnerId: "host-owner" });
  api.sendMessage({ customType: "subagent-notify", content: "batched" }, { triggerTurn: true });

  const throwing = createHeadlessSubagentApi({ ...pi, sendMessage() { throw new Error("send failed"); } }, {
    workingStateTrace(entry) { trace.push(entry); },
    getHostIdentity() { return { hostSessionId: "host-session", completionOwnerId: "host-owner" }; },
  });
  assert.throws(() => throwing.sendMessage({ customType: "subagent-notify" }, { triggerTurn: true }), /send failed/);
  assert.equal(trace.some((entry) => entry.event === "delivery-result" || Object.hasOwn(entry, "runId") && entry.event === "send-message"), false);
});

test("the existing notifier keeps async owner matching, batch flush, triggerTurn, and dispose semantics", async () => {
  const pi = createPi();
  const timers = [];
  const notifier = registerSubagentNotify(pi, {
    currentSessionId: "host-session",
    completionOwnerId: "host-owner",
  }, {
    batchConfig: { enabled: true, debounceMs: 1, maxWaitMs: 10 },
    timers: {
      setTimeout(handler) { const entry = { handler }; timers.push(entry); return entry; },
      clearTimeout() {},
    },
  });

  assert.equal(await notifier.deliver({
    id: "wrong-owner", agent: "executor", success: true, summary: "ignored",
    sessionId: "host-session", completionOwnerId: "other-owner",
  }), false);
  const delivered = notifier.deliver({
    id: "batch-flush", agent: "executor", success: true, summary: "complete",
    sessionId: "host-session", completionOwnerId: "host-owner", triggerTurn: false,
  });
  assert.equal(pi.messages.length, 0);
  timers[0].handler();
  assert.equal(await delivered, true);
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].options.triggerTurn, false);
  notifier.dispose();
  assert.equal(await notifier.deliver({
    id: "after-dispose", agent: "executor", success: true, summary: "ignored",
    sessionId: "host-session", completionOwnerId: "host-owner",
  }), false);
});
