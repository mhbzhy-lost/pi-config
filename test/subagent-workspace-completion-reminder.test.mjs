import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceCompletionReminder } from "../packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts";

function events() {
  const listeners = [];
  return {
    on(type, listener) {
      listeners.push({ type, listener });
      return () => listeners.splice(listeners.findIndex((entry) => entry.type === type && entry.listener === listener), 1);
    },
    async emit(type, event) {
      for (const entry of [...listeners]) if (entry.type === type) await entry.listener(event);
    },
  };
}

test("workspace reminder queues one standalone terminal completion before its notifier turn", async () => {
  const bus = events();
  const messages = [];
  const calls = [];
  const source = { runId: "leaf-run", sessionId: "lifecycle-session", agent: "executor", state: "complete" };
  const before = structuredClone(source);
  const reminder = createWorkspaceCompletionReminder({
    events: bus,
    sendMessage(message, options) { messages.push({ message, options }); },
    getContext() { return { rootSessionId: "root-session", lifecycleSessionId: "lifecycle-session", service: {
      listOwned(input) {
        calls.push(input);
        return [{ workspaceId: "workspace-a", state: "active", owner: { kind: "standalone-subagent", rootSessionId: "root-session" }, run: { runId: "leaf-run" } }];
      },
    } }; },
  });

  await bus.emit("subagent:async-complete", source);
  await bus.emit("subagent:async-complete", source);

  assert.deepEqual(source, before);
  assert.deepEqual(calls, [
    { ownerScope: { kind: "standalone-subagent", rootSessionId: "root-session" }, runId: "leaf-run" },
    { ownerScope: { kind: "standalone-subagent", rootSessionId: "root-session" }, runId: "leaf-run" },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.customType, "subagent-workspace-reminder");
  assert.match(messages[0].message.content, /workspace-a/);
  // S5：reminder 只指向实时状态权威，不再无条件建议 integrate/discard；
  // details 字段与发送/去重合同保持逐字不变（下方 deepEqual 仍成立）。
  assert.match(messages[0].message.content, /managed_workspace_status\(\{workspace_id:"workspace-a"\}\)/);
  assert.match(messages[0].message.content, /act only on the allowed_dispositions and one-time token that call returns for the current state/);
  assert.match(messages[0].message.content, /do not assume integrate or discard\./);
  assert.match(messages[0].message.content, /CHILD_OWNS_INTEGRATION/);
  assert.match(messages[0].message.content, /a released workspace needs no further action/);
  assert.doesNotMatch(messages[0].message.content, /subagent_worktree/);
  assert.doesNotMatch(messages[0].message.content, /then integrate or discard to finish/);
  assert.deepEqual(messages[0].message.details, {
    schemaVersion: "subagent-workspace-reminder.v1", rootSessionId: "root-session", runId: "leaf-run", workspaceId: "workspace-a", workspaceState: "active", mode: "standalone-subagent",
  });
  assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: false });
  reminder.dispose();
});

test("workspace reminder ignores foreign, wrapper, closed, ambiguous, and malformed completions", async () => {
  const bus = events();
  const messages = [];
  let receipts = [];
  const reminder = createWorkspaceCompletionReminder({
    events: bus,
    sendMessage(message) { messages.push(message); },
    getContext() { return { rootSessionId: "root-session", lifecycleSessionId: "lifecycle-session", service: { listOwned() { return receipts; } } }; },
  });
  for (const event of [
    {},
    { runId: "run", sessionId: "foreign" },
    { runId: "run", sessionId: "lifecycle-session", agent: "workflow" },
  ]) await bus.emit("subagent:async-complete", event);
  receipts = [{ workspaceId: "released", state: "released", run: { runId: "run" } }];
  await bus.emit("subagent:async-complete", { runId: "run", sessionId: "lifecycle-session" });
  receipts = [{ workspaceId: "a", state: "active", run: { runId: "run" } }, { workspaceId: "b", state: "active", run: { runId: "run" } }];
  await bus.emit("subagent:async-complete", { runId: "run", sessionId: "lifecycle-session" });
  assert.deepEqual(messages, []);
  reminder.dispose();
});

test("workspace reminder records delivery debt and retries instead of losing the notification", async () => {
  const bus = events();
  const diagnostics = [];
  const messages = [];
  let fail = true;
  const reminder = createWorkspaceCompletionReminder({
    events: bus,
    sendMessage(message) {
      if (fail) { fail = false; throw new Error("delivery unavailable"); }
      messages.push(message);
    },
    onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
    getContext() { return { rootSessionId: "root-session", lifecycleSessionId: "lifecycle-session", service: {
      listOwned() { return [{ workspaceId: "workspace-debt", state: "active", run: { runId: "run-debt" } }]; },
    } }; },
  });
  const completion = { runId: "run-debt", sessionId: "lifecycle-session", state: "complete" };
  await assert.doesNotReject(() => bus.emit("subagent:async-complete", completion));
  assert.equal(messages.length, 0);
  assert.deepEqual(diagnostics, [{
    code: "SUBAGENT_WORKSPACE_REMINDER_DELIVERY_DEBT", rootSessionId: "root-session", runId: "run-debt",
    workspaceId: "workspace-debt", message: "delivery unavailable",
  }]);
  await bus.emit("subagent:async-complete", completion);
  assert.equal(messages.length, 1);
  reminder.dispose();
});
