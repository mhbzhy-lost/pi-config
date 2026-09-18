import assert from "node:assert/strict";
import test from "node:test";

import integrationQueue, { resetIntegrationCompletionGuardsForTest } from "../packages/pi-subagents-enhanced/child-extensions/integration-queue.ts";

class ChildBus {
  handlers = new Map();
  on(type, handler) { const values = this.handlers.get(type) ?? []; values.push(handler); this.handlers.set(type, values); return () => { const i = values.indexOf(handler); if (i >= 0) values.splice(i, 1); }; }
  async emit(type, value = {}) { for (const handler of [...this.handlers.get(type) ?? []]) await handler(value); }
}

function host(states) {
  const events = new ChildBus(); const messages = []; const tools = [];
  const pi = {
    events,
    registerTool(tool) { tools.push(tool); },
    on: events.on.bind(events),
    getActiveTools() { return []; }, setActiveTools() {},
    async sendMessage(message, options) { messages.push({ message, options }); },
  };
  let index = 0; const preserved = [];
  const coordinator = {
    async inspectIntegrationState() { return states[Math.min(index++, states.length - 1)]; },
    async preserveIntegrationDebt(input) { preserved.push(input); return { queueState: "preserved", workspaceState: "preserved", integrationReceipt: false, proofState: "absent", revision: 1 }; },
  };
  return { pi, events, messages, preserved, coordinator };
}

const absent = { queueState: "absent", workspaceState: "active", integrationReceipt: false, proofState: "absent", revision: 0 };

test("managed child completion guard follows up once per settlement and preserves after two no-progress continuations", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const h = host([absent, absent, absent, absent, absent]);
  const extension = integrationQueue(h.pi, { coordinator: h.coordinator, completionGuardKey: "root-1/run-1", resolveBinding: () => ({ workspaceId: "workspace-1", leaseId: "lease-1", runId: "run-1", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" } }), managedCodingWorktree: true });
  t.after(() => extension.dispose());
  await h.events.emit("agent_end");
  assert.equal(h.messages.length, 1);
  await h.events.emit("agent_settled");
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(String(h.messages[0].message?.content ?? h.messages[0].message), /subagent_integration/);
  await h.events.emit("agent_end");
  assert.equal(h.messages.length, 2);
  await h.events.emit("agent_settled");
  assert.equal(h.messages.length, 2);
  await h.events.emit("agent_settled");
  assert.equal(h.messages.length, 2);
  assert.equal(h.preserved.length, 1);
});

test("completed receipt does not follow up and explicit preserved state is non-success", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const completed = host([{ queueState: "completed", workspaceState: "released", integrationReceipt: true, proofState: "accepted", revision: 4 }]);
  const a = integrationQueue(completed.pi, { coordinator: completed.coordinator, completionGuardKey: "root/completed", resolveBinding: () => ({ workspaceId: "w", leaseId: "l", runId: "r", ownerScope: { kind: "standalone-subagent", rootSessionId: "root" } }), managedCodingWorktree: true });
  t.after(() => a.dispose()); await completed.events.emit("agent_end"); await completed.events.emit("agent_settled"); assert.equal(completed.messages.length, 0);
  const failed = host([{ queueState: "preserved", workspaceState: "preserved", integrationReceipt: false, proofState: "absent", revision: 2 }]);
  const b = integrationQueue(failed.pi, { coordinator: failed.coordinator, completionGuardKey: "root/preserved", resolveBinding: () => ({ workspaceId: "w2", leaseId: "l2", runId: "r2", ownerScope: { kind: "standalone-subagent", rootSessionId: "root" } }), managedCodingWorktree: true });
  t.after(() => b.dispose()); await failed.events.emit("agent_end"); await failed.events.emit("agent_settled"); assert.equal(failed.messages.length, 0); assert.equal(failed.preserved.length, 0);
});

test("queue completion, model payload, or receipt alone cannot prove trusted success", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const incomplete = host([
    { queueState: "completed", workspaceState: "active", integrationReceipt: true, proofState: "absent", revision: 4 },
    { queueState: "completed", workspaceState: "active", integrationReceipt: true, proofState: "absent", revision: 4 },
  ]);
  const extension = integrationQueue(incomplete.pi, { coordinator: incomplete.coordinator, completionGuardKey: "root/incomplete", resolveBinding: () => ({ workspaceId: "w", leaseId: "l", runId: "r", ownerScope: { kind: "standalone-subagent", rootSessionId: "root" } }), managedCodingWorktree: true });
  t.after(() => extension.dispose());
  await incomplete.events.emit("agent_end", { content: "integration completed successfully", integrationReceipt: true });
  assert.equal(incomplete.messages.length, 1);
  assert.equal(incomplete.preserved.length, 0);
});

test("guard is disabled outside managed coding worktrees", async (t) => {
  resetIntegrationCompletionGuardsForTest(); const h = host([absent]);
  const extension = integrationQueue(h.pi, { coordinator: h.coordinator, resolveBinding: () => ({}), managedCodingWorktree: false });
  t.after(() => extension.dispose()); await h.events.emit("agent_end"); await h.events.emit("agent_settled"); assert.equal(h.messages.length, 0);
});

test("broker/query failure records bounded preservation and reload cannot duplicate continuation", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const h = host([absent]);
  h.coordinator.inspectIntegrationState = async () => { throw Object.assign(new Error("down"), { code: "BROKER_DISCONNECTED" }); };
  const options = { coordinator: h.coordinator, completionGuardKey: "root/failure", resolveBinding: () => ({ workspaceId: "w", leaseId: "l", runId: "r", ownerScope: { kind: "standalone-subagent", rootSessionId: "root" } }), managedCodingWorktree: true };
  const first = integrationQueue(h.pi, options); const second = integrationQueue(h.pi, options);
  t.after(() => { first.dispose(); second.dispose(); });
  await h.events.emit("agent_end"); await h.events.emit("agent_settled");
  assert.equal(h.messages.length, 0);
  assert.equal(h.preserved.length, 1);
  await h.events.emit("agent_end"); await h.events.emit("agent_settled");
  assert.equal(h.preserved.length, 1);
});

test("active auto lifecycle is the only shutdown path and leaves queued work unpreserved", async (t) => {
  resetIntegrationCompletionGuardsForTest();
  const h = host([absent]); const calls = [];
  Object.assign(h.coordinator, {
    async prepareAutoIntegration() { calls.push("prepare"); return { queueState: "queued" }; },
    async advanceAutoIntegration() { calls.push("advance"); return { queueState: "queued" }; },
    async inspectAutoIntegration() { calls.push("inspect-auto"); return { queueState: "queued" }; },
    async preserveIntegrationDebt(_binding, reason) { calls.push(["preserve", reason]); },
  });
  const extension = integrationQueue(h.pi, { coordinator: h.coordinator, completionGuardKey: "root/auto-shutdown", resolveBinding: () => ({ workspaceId: "w", leaseId: "l", runId: "r", ownerScope: { kind: "standalone-subagent", rootSessionId: "root" } }), managedCodingWorktree: true });
  t.after(() => extension.dispose());
  await h.events.emit("session_shutdown");
  assert.deepEqual(calls, ["inspect-auto"]);
  assert.deepEqual(h.preserved, []);
});
