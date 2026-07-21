import assert from "node:assert/strict";
import test from "node:test";
import { createPlanCapsuleExtension } from "../scripts/lib/plan/plan-capsule-extension.mjs";

function createMockPi() {
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const tools = ["plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block", "read", "bash"];
  return {
    handlers,
    entries,
    messages,
    tools,
    on(name, handler) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    appendEntry(type, data) { entries.push({ type, customType: type, data }); },
    sendMessage(msg, opts) { messages.push({ msg, opts }); },
    getActiveTools() { return [...tools]; },
    setActiveTools(t) { tools.length = 0; tools.push(...t); },
    registerTool() {},
  };
}

function mockCtx(entries = []) {
  return {
    sessionManager: {
      getBranch() { return entries; },
    },
  };
}

function planCreatedEntry(planId = "plan-1", headCommit = "aaa") {
  return {
    type: "custom",
    customType: "pi-plan-event-v1",
    data: {
      schemaVersion: "pi-plan-event.v1",
      eventId: "e1",
      planId,
      occurredAt: new Date().toISOString(),
      type: "plan.created",
      data: {
        workspace: { originRoot: "/o", worktree: "/w", baseCommit: "base", headCommit, planPath: "/p.md", planHash: "h" },
        tasks: ["task-1"],
      },
    },
  };
}

test("agent_settled injects plan_verify follow-up when HEAD changed but lifecycle is still running", async () => {
  const pi = createMockPi();
  const createdEntry = planCreatedEntry("plan-1", "aaa");

  let headCommitForCheck = "bbb"; // HEAD has advanced
  createPlanCapsuleExtension(pi, {
    validateBinding: async () => ({ planId: "plan-1", originRoot: "/o", worktree: "/w", baseCommit: "base", headCommit: "aaa", planPath: "/p.md", planHash: "h", tasks: [{ id: "task-1" }] }),
    canContinue: () => false,
    getHeadCommit: async () => headCommitForCheck,
  });

  // Simulate session_start with plan already opened
  const sessionStartHandlers = pi.handlers.get("session_start");
  const ctx = mockCtx([createdEntry]);
  for (const h of sessionStartHandlers) await h({}, ctx);

  // Simulate agent_settled
  pi.messages.length = 0;
  const settledHandlers = pi.handlers.get("agent_settled");
  for (const h of settledHandlers) await h({}, ctx);

  // Should inject a follow-up forcing plan_verify
  const verifyMsg = pi.messages.find((m) => m.msg?.content?.includes("plan_verify"));
  assert.ok(verifyMsg, "should inject plan_verify follow-up when HEAD advanced but lifecycle is running");
  assert.equal(verifyMsg.opts?.triggerTurn, true);
});

test("agent_settled does NOT inject plan_verify when HEAD has not changed", async () => {
  const pi = createMockPi();
  const createdEntry = planCreatedEntry("plan-1", "aaa");

  createPlanCapsuleExtension(pi, {
    validateBinding: async () => ({ planId: "plan-1", originRoot: "/o", worktree: "/w", baseCommit: "base", headCommit: "aaa", planPath: "/p.md", planHash: "h", tasks: [{ id: "task-1" }] }),
    canContinue: () => true,
    getHeadCommit: async () => "aaa", // HEAD unchanged
  });

  const sessionStartHandlers = pi.handlers.get("session_start");
  const ctx = mockCtx([createdEntry]);
  for (const h of sessionStartHandlers) await h({}, ctx);

  pi.messages.length = 0;
  const settledHandlers = pi.handlers.get("agent_settled");
  for (const h of settledHandlers) await h({}, ctx);

  // Should NOT mention plan_verify (normal canContinue follow-up is fine)
  const verifyMsg = pi.messages.find((m) => m.msg?.content?.includes("plan_verify"));
  assert.equal(verifyMsg, undefined, "should not force verify when HEAD unchanged");
});

test("agent_settled does NOT inject plan_verify when lifecycle is already terminal", async () => {
  const pi = createMockPi();
  const createdEntry = planCreatedEntry("plan-1", "aaa");
  const blockedEntry = {
    type: "custom",
    customType: "pi-plan-event-v1",
    data: {
      schemaVersion: "pi-plan-event.v1",
      eventId: "e2",
      planId: "plan-1",
      occurredAt: new Date().toISOString(),
      type: "plan.blocked",
      data: { reason: "external review unavailable" },
    },
  };

  createPlanCapsuleExtension(pi, {
    validateBinding: async () => ({ planId: "plan-1", originRoot: "/o", worktree: "/w", baseCommit: "base", headCommit: "aaa", planPath: "/p.md", planHash: "h", tasks: [{ id: "task-1" }] }),
    canContinue: () => false,
    getHeadCommit: async () => "bbb",
  });

  const sessionStartHandlers = pi.handlers.get("session_start");
  const ctx = mockCtx([createdEntry, blockedEntry]);
  for (const h of sessionStartHandlers) await h({}, ctx);

  pi.messages.length = 0;
  const settledHandlers = pi.handlers.get("agent_settled");
  for (const h of settledHandlers) await h({}, ctx);

  // Should just report blocked, not force verify
  const verifyMsg = pi.messages.find((m) => m.msg?.content?.includes("plan_verify"));
  assert.equal(verifyMsg, undefined, "should not force verify when already in terminal state");
});
