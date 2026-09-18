import assert from "node:assert/strict";
import test from "node:test";
import { createChildIntegrationLifecycle, resetChildIntegrationLifecyclesForTest } from "../packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts";

class Bus {
  handlers = new Map();
  on(type, fn) { const list = this.handlers.get(type) ?? []; list.push(fn); this.handlers.set(type, list); return () => list.splice(list.indexOf(fn), 1); }
  async emit(type) { for (const fn of [...this.handlers.get(type) ?? []]) await fn({}); }
}

function fixture(states) {
  const bus = new Bus(); const calls = []; const messages = [];
  const coordinator = {
    async prepareAutoIntegration() { calls.push("prepare"); return states.shift(); },
    async advanceAutoIntegration() { calls.push("advance"); return states.shift(); },
    async preserveIntegrationDebt() { calls.push("preserve"); return { queueState: "preserved", workspaceState: "preserved" }; },
  };
  const pi = { on: bus.on.bind(bus), async sendMessage(message, options) { messages.push({ message, options }); } };
  const lifecycle = createChildIntegrationLifecycle({ pi, coordinator, resolveBinding: () => ({ runId: "run" }), key: "root/run", managed: true, maxAdmissionPolls: 3, pollDelayMs: 0 });
  return { bus, calls, messages, lifecycle };
}

test("awaited agent_end completes clean child and later agent_settled only records", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const h = fixture([
    { queueState: "queued", workspaceState: "active" },
    { queueState: "admitted", workspaceState: "active" },
    { queueState: "completed", workspaceState: "active", integrationReceipt: true },
  ]);
  t.after(() => h.lifecycle.dispose());
  await h.bus.emit("agent_end");
  assert.deepEqual(h.calls, ["prepare", "advance", "advance"]);
  await h.bus.emit("agent_settled");
  assert.deepEqual(h.calls, ["prepare", "advance", "advance"]);
  assert.equal(h.messages.length, 0);
});

test("real conflict gets a bounded semantic continuation; next settled auto-continues", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const h = fixture([
    { queueState: "queued", workspaceState: "active" },
    { queueState: "resolving-conflict", workspaceState: "active", conflictDigest: "a", continuationAttempt: 1 },
    { queueState: "completed", workspaceState: "active", integrationReceipt: true },
  ]);
  t.after(() => h.lifecycle.dispose());
  await h.bus.emit("agent_end");
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].message.content, /current rebase conflict/); assert.doesNotMatch(h.messages[0].message.content, /workspace|lease|path/i);
  await h.bus.emit("agent_settled"); assert.equal(h.messages.length, 1);
  await h.bus.emit("agent_end"); await h.bus.emit("agent_settled");
  assert.equal(h.calls.filter(x => x === "prepare").length, 1);
  assert.equal(h.calls.filter(x => x === "advance").length, 2);
});

test("duplicate settled is inert and a confirmed non-retryable failure preserves debt", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const h = fixture([{ queueState: "queued", workspaceState: "active" }]);
  h.lifecycle.dispose();
  const failing = fixture([{ queueState: "queued", workspaceState: "active" }]);
  failing.lifecycle.dispose();
  const bus = new Bus(); const calls = [];
  const lifecycle = createChildIntegrationLifecycle({ pi: { on: bus.on.bind(bus), sendMessage: async () => {} }, managed: true, key: "failure", resolveBinding: () => ({}), coordinator: {
    async prepareAutoIntegration() { throw Object.assign(new Error("target identity is invalid"), { code: "MANAGED_WORKSPACE_BINDING" }); }, async preserveIntegrationDebt() { calls.push("preserve"); },
  }, pollDelayMs: 0 });
  t.after(() => lifecycle.dispose());
  await bus.emit("agent_end"); await bus.emit("agent_settled"); await bus.emit("agent_settled");
  assert.deepEqual(calls, ["preserve"]);
});

test("session shutdown leaves queued durable integration live for later completion", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const bus = new Bus(); const calls = []; let advances = 0;
  const lifecycle = createChildIntegrationLifecycle({
    pi: { on: bus.on.bind(bus), sendMessage: async () => {} }, managed: true, key: "shutdown-queued", resolveBinding: () => ({ runId: "run" }),
    coordinator: {
      async inspectAutoIntegration() { calls.push("inspect"); return { queueState: "queued" }; },
      async prepareAutoIntegration() { calls.push("prepare"); return { queueState: "queued" }; },
      async advanceAutoIntegration() { calls.push("advance"); advances++; return { queueState: "completed" }; },
      async preserveIntegrationDebt() { calls.push("preserve"); },
    }, pollDelayMs: 0,
  });
  t.after(() => lifecycle.dispose());
  await bus.emit("session_shutdown");
  assert.deepEqual(calls, ["inspect"]);
  await bus.emit("agent_end");
  assert.equal(advances, 1); assert.equal(calls.includes("preserve"), false);
});

test("shutdown with unavailable coordinator records explicit recovery debt", async (t) => {
  resetChildIntegrationLifecyclesForTest(); const bus = new Bus(); const reasons = [];
  const lifecycle = createChildIntegrationLifecycle({
    pi: { on: bus.on.bind(bus), sendMessage: async () => {} }, managed: true, key: "shutdown-unavailable", resolveBinding: () => ({ runId: "run" }),
    coordinator: { async inspectAutoIntegration() { throw Object.assign(new Error("transport closed"), { code: "COORDINATOR_UNAVAILABLE" }); }, async preserveIntegrationDebt(_binding, reason) { reasons.push(reason); } }, pollDelayMs: 0,
  });
  t.after(() => lifecycle.dispose());
  await bus.emit("session_shutdown");
  assert.deepEqual(reasons, ["coordinator-unavailable"]);
});

test("retryable intermediate agent_end failure stays live and a later agent_end completes integration", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const bus = new Bus(); const calls = []; let preparation = 0;
  const lifecycle = createChildIntegrationLifecycle({
    pi: { on: bus.on.bind(bus), sendMessage: async () => {} }, managed: true, key: "retry-then-complete", resolveBinding: () => ({ runId: "run" }),
    coordinator: {
      async prepareAutoIntegration() {
        calls.push("prepare");
        if (preparation++ === 0) throw Object.assign(new Error("Root broker disconnected before response"), { code: "BROKER_DISCONNECTED" });
        return { queueState: "queued", workspaceState: "active" };
      },
      async advanceAutoIntegration(input) { calls.push(["advance", input]); return { queueState: "completed", workspaceState: "active", integrationReceipt: true }; },
      async preserveIntegrationDebt() { calls.push("preserve"); },
    },
    pollDelayMs: 60_000,
  });
  t.after(() => lifecycle.dispose());
  await bus.emit("agent_end");
  assert.deepEqual(calls, ["prepare"]);
  await bus.emit("agent_end");
  assert.deepEqual(calls, ["prepare", "prepare", ["advance", {}]]);
});

test("workspace not-ready does not consume terminal guard or block a later completed agent_end", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const bus = new Bus(); const calls = []; let preparation = 0;
  const lifecycle = createChildIntegrationLifecycle({
    pi: { on: bus.on.bind(bus), sendMessage: async () => {} }, managed: true, key: "not-ready-then-complete", resolveBinding: () => ({ runId: "run" }),
    coordinator: {
      async prepareAutoIntegration() { calls.push("prepare"); return preparation++ === 0 ? { queueState: "not-ready", workspaceState: "not-ready" } : { queueState: "queued", workspaceState: "active" }; },
      async advanceAutoIntegration() { calls.push("advance"); return { queueState: "completed", workspaceState: "active", integrationReceipt: true }; },
      async preserveIntegrationDebt() { calls.push("preserve"); },
    },
    pollDelayMs: 60_000,
  });
  t.after(() => lifecycle.dispose());
  await bus.emit("agent_end"); await bus.emit("agent_end");
  assert.deepEqual(calls, ["prepare", "prepare", "advance"]);
});

test("resolving-conflict 状态下的 agent_end 直接驱动 advance（durable continue），而非仅发 follow-up", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const bus = new Bus(); const messages = []; const calls = [];
  // 场景：child 曾经历冲突（resolving-conflict 已 durable 记录），冲突已被
  // 模型解决（staged、无 unmerged）。下一个 agent_end 必须调用 advance 让
  // coordinator 执行 rebase --continue，而不是再发一个 no-op 冲突 follow-up
  // （后者会在空手 turn 上被 acceptance gate 拒绝并终止 run）。
  const states = [{ queueState: "resolving-conflict", conflictDigest: "a".repeat(64), continuationAttempt: 1 }];
  const coordinator = {
    async prepareAutoIntegration() { calls.push("prepare"); return states[0]; },
    async advanceAutoIntegration(input) { calls.push(["advance", input]); return { queueState: "completed", workspaceState: "active", integrationReceipt: true }; },
    async preserveIntegrationDebt() { calls.push("preserve"); },
  };
  const lifecycle = createChildIntegrationLifecycle({ pi: { on: bus.on.bind(bus), sendMessage: async () => { messages.push(1); } }, coordinator,
    resolveBinding: () => ({ runId: "run" }), key: "conflict-resolved-continue", managed: true, maxAdmissionPolls: 3, pollDelayMs: 0 });
  t.after(() => lifecycle.dispose());
  await bus.emit("agent_end");
  assert.deepEqual(calls, ["prepare", ["advance", {}]], "resolving-conflict 必须经 advance 驱动 durable continue");
  assert.equal(messages.length, 0, "冲突已解决时不发 CONFLICT follow-up");
});

test("真实未解决冲突（advance 返回 resolving-conflict 同 digest）时仍发 follow-up", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const bus = new Bus(); const messages = []; const calls = [];
  const coordinator = {
    async prepareAutoIntegration() { calls.push("prepare"); return { queueState: "resolving-conflict", conflictDigest: "a".repeat(64), continuationAttempt: 1 }; },
    async advanceAutoIntegration() { calls.push("advance"); return { queueState: "resolving-conflict", conflictDigest: "a".repeat(64), continuationAttempt: 1 }; },
    async preserveIntegrationDebt() { calls.push("preserve"); },
  };
  const lifecycle = createChildIntegrationLifecycle({ pi: { on: bus.on.bind(bus), sendMessage: async (message) => { messages.push(message); } }, coordinator,
    resolveBinding: () => ({ runId: "run" }), key: "conflict-unresolved-followup", managed: true, maxAdmissionPolls: 3, pollDelayMs: 0 });
  t.after(() => lifecycle.dispose());
  await bus.emit("agent_end");
  assert.ok(calls.includes("advance"), "仍需先经 advance 尝试 durable continue");
  assert.equal(messages.length, 1, "advance 后冲突未解决（同 digest）时才发 CONFLICT follow-up");
  assert.match(messages[0].content, /current rebase conflict/);
});
