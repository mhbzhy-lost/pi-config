import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { createPlanCapsuleExtension } from "../scripts/lib/plan/plan-capsule-extension.mjs";

const created = {
  schemaVersion: "pi-plan-event.v1", eventId: "one", planId: "release-11", occurredAt: "2026-07-15T00:00:00.000Z", type: "plan.created",
  data: { workspace: { originRoot: "/origin", worktree: "/worktrees/release-11", baseCommit: "base", headCommit: "base", planPath: "/origin/docs/release.md", planHash: "a".repeat(64) }, tasks: ["task-1"] },
};

function context(branch = []) {
  return { sessionManager: { getBranch: () => branch } };
}

function setup(options = {}) {
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  let activeTools = options.activeTools ?? ["read", "grep", "bash", "subagent", "plan_open"];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    getActiveTools() { return activeTools; },
    setActiveTools(next) { activeTools = next; },
    sendMessage(message, sendOptions) { messages.push({ message, options: sendOptions }); },
  };
  createPlanCapsuleExtension(pi, options);
  return { tools, handlers, entries, messages, activeTools: () => activeTools };
}

async function execute(tool, params, ctx = context()) {
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("plan-runner alone uses the real subagentOnlyExtensions profile field", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const profiles = await Promise.all(["plan-runner", "plan-reviewer", "executor", "spark"].map((name) => readFile(resolve(root, "pi", "agents", `${name}.md`), "utf8")));
  assert.match(profiles[0], /^subagentOnlyExtensions: \.pi-subagents\/plan-runner-entry\.mjs$/m);
  for (const profile of profiles) assert.doesNotMatch(profile, /^extensions:/m);
  for (const profile of profiles.slice(1)) assert.doesNotMatch(profile, /plan-capsule/);
});

test("capsule registers only plan_open and declares actual bootstrap fields", () => {
  const { tools } = setup();
  assert.deepEqual([...tools.keys()], ["plan_open"]);
  assert.deepEqual(Object.keys(tools.get("plan_open").parameters.properties).sort(), ["allowPlanCommits", "baseCommit", "planHash", "planId", "planPath", "worktree"]);
});

test("plan_open fails closed when the Task 12 binding dependency is absent", async () => {
  const { tools } = setup();
  const result = await execute(tools.get("plan_open"), { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /binding validation is unavailable/i);
});

test("plan_open validates then persists and activates the lifecycle tools", async () => {
  const binding = { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree", allowPlanCommits: true };
  const { tools, entries, activeTools } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
  });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(entries[0].customType, "pi-plan-event-v1");
  assert.equal(entries[0].data.type, "plan.created");
  assert.equal(entries[0].data.data.workspace.planPath, binding.planPath);
  assert.equal(entries[0].data.data.workspace.planHash, binding.planHash);
  assert.deepEqual([...tools.keys()], ["plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block"]);
  assert.deepEqual(activeTools().filter((name) => name.startsWith("plan_")), ["plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block"]);
});

test("plan_open starts child control only after persisting plan.created and session shutdown stops it", async () => {
  const calls = [];
  const binding = { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree", allowPlanCommits: true };
  const { tools, handlers, entries } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    startPlanControl: async ({ binding: opened }) => {
      calls.push(["start", opened.planId, entries[0]?.data.type]);
      return () => calls.push(["stop"]);
    },
  });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false);
  assert.deepEqual(calls, [["start", "release-11", "plan.created"]]);
  await handlers.get("session_shutdown")({}, context());
  assert.deepEqual(calls, [["start", "release-11", "plan.created"], ["stop"]]);
});

test("session shutdown runs both cleanups and aggregates failures", async () => {
  const calls = [];
  const binding = { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree", allowPlanCommits: true };
  const { tools, handlers } = setup({
    stopActiveRuns: async () => {
      calls.push("runs");
      throw new Error("run stop failed");
    },
    startPlanControl: async () => () => {
      calls.push("control");
      throw new Error("control stop failed");
    },
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
  });
  await execute(tools.get("plan_open"), binding);
  await assert.rejects(handlers.get("session_shutdown")({}, context()), AggregateError);
  assert.deepEqual(calls, ["control", "runs"]);
});

test("capsule hook authorizes exactly one matching nested subagent call", async () => {
  const calls = [];
  const { handlers } = setup({
    authorizeNestedSubagent: (input, { ctx }) => {
      calls.push({ input, ctx });
      if (input.agent !== "executor") throw new Error("intent differs");
      return true;
    },
  });
  const ctx = context([{ customType: "pi-plan-event-v1", data: created }]);
  await handlers.get("session_start")({ type: "session_start" }, ctx);
  const event = { toolName: "subagent", input: { agent: "executor" } };

  assert.equal(await handlers.get("tool_call")(event, ctx), undefined);
  assert.deepEqual(calls, [{ input: event.input, ctx }]);
  const denied = await handlers.get("tool_call")({ toolName: "subagent", input: { agent: "other" } }, ctx);
  assert.equal(denied.block, true);
  assert.match(denied.reason, /intent differs/i);
});

test("capsule allows subagent management actions without dispatch authorization", async () => {
  const { handlers } = setup({
    authorizeNestedSubagent: () => { throw new Error("should not be called"); },
  });
  const ctx = context([{ customType: "pi-plan-event-v1", data: created }]);
  await handlers.get("session_start")({ type: "session_start" }, ctx);

  for (const action of ["status", "interrupt", "resume", "steer", "list", "get"]) {
    const result = await handlers.get("tool_call")({ toolName: "subagent", input: { action, id: "run-1" } }, ctx);
    assert.equal(result, undefined, `action '${action}' should not be blocked`);
  }
});

test("capsule forwards only one authorized structured subagent tool_result and triggers a follow-up", async () => {
  const received = [];
  const { handlers, messages } = setup({
    authorizeNestedSubagent: () => true,
    handleNestedResult: async (event, { ctx }) => {
      received.push({ event, ctx });
      return { state: "succeeded" };
    },
  });
  const ctx = context([{ customType: "pi-plan-event-v1", data: created }]);
  await handlers.get("session_start")({ type: "session_start" }, ctx);
  const call = { toolName: "subagent", input: { agent: "executor" } };
  const result = { toolName: "subagent", input: call.input, details: { runId: "run-1", results: [] }, isError: false };

  await handlers.get("tool_call")(call, ctx);
  await handlers.get("tool_result")(result, ctx);
  await handlers.get("tool_result")(result, ctx);
  await handlers.get("tool_result")({ ...result, isError: true }, ctx);
  await handlers.get("tool_result")({ ...result, details: {} }, ctx);
  await handlers.get("tool_result")({ ...result, toolName: "bash" }, ctx);

  assert.deepEqual(received, [{ event: result, ctx }]);
  assert.deepEqual(messages, [{
    message: { customType: "pi-plan-follow-up-v1", content: "Continue the plan coordinator.", details: { planId: "release-11" } },
    options: { triggerTurn: true, deliverAs: "followUp" },
  }]);
});

test("plan lifecycle tools fail closed until their domain dependencies are injected", async () => {
  const { tools } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }) });
  await execute(tools.get("plan_open"), { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree" });
  for (const name of ["plan_status", "plan_continue", "plan_verify", "plan_block"]) {
    const result = await execute(tools.get(name), {});
    assert.equal(result.isError, true, name);
  }
});

test("plan_status returns the injected derived projection", async () => {
  const { tools } = setup({ status: async () => ({ lifecycle: "running", planId: "release-11" }) });
  await execute(tools.get("plan_open"), { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree" }).catch(() => {});
  const opened = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), status: async () => ({ lifecycle: "running", planId: "release-11" }) });
  await execute(opened.tools.get("plan_open"), { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree" });
  const result = await execute(opened.tools.get("plan_status"), {});
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /"lifecycle": "running"/);
});

test("plan_continue invokes only the injected one-step coordinator", async () => {
  const calls = [];
  const { tools } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), continuePlan: async (value) => calls.push(value) });
  await execute(tools.get("plan_open"), { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree" });
  const result = await execute(tools.get("plan_continue"), { reason: "resume" });
  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{ reason: "resume" }]);
});

test("plan_verify invokes verifier without appending plan.validated", async () => {
  const { tools, entries } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), verifyPlan: async () => ({ lifecycle: "verifying" }) });
  await execute(tools.get("plan_open"), { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree" });
  entries.length = 0;
  const result = await execute(tools.get("plan_verify"), {});
  assert.equal(result.isError, false);
  assert.deepEqual(entries, []);
});

test("plan_block delegates a legal block intent without accepting work", async () => {
  const calls = [];
  const { tools } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), blockPlan: async (value) => calls.push(value) });
  await execute(tools.get("plan_open"), { planId: "release-11", planPath: "/plan.md", planHash: "hash", baseCommit: "base", worktree: "/worktree" });
  const result = await execute(tools.get("plan_block"), { reason: "needs approval" });
  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{ reason: "needs approval" }]);
});

test("session handlers read the current branch only from real handler context", async () => {
  const { handlers, tools } = setup();
  await handlers.get("session_start")({ type: "session_start", reason: "resume" }, context([{ customType: "pi-plan-event-v1", data: created }]));
  assert.equal(tools.has("plan_status"), true);
  await assert.rejects(
    () => handlers.get("session_start")({ type: "session_start", reason: "resume" }, context([
      { customType: "pi-plan-event-v1", data: created },
      { customType: "pi-plan-event-v1", data: { ...created, eventId: "two", planId: "another" } },
    ])),
    /multiple planId/,
  );
});

test("session tree with no plan stops coordination and records recovery needed", async () => {
  const stops = [];
  const recovery = [];
  const { handlers } = setup({ stopCoordinator: async () => stops.push(true), markRecoveryNeeded: async () => recovery.push(true) });
  await handlers.get("session_tree")({ type: "session_tree", newLeafId: "leaf", oldLeafId: "old" }, context());
  assert.deepEqual(stops, [true]);
  assert.deepEqual(recovery, [true]);
});

test("agent_settled uses a valid custom follow-up payload for runnable work", async () => {
  const { handlers, messages } = setup({ canContinue: () => true });
  await handlers.get("agent_settled")({ type: "agent_settled" }, context([{ customType: "pi-plan-event-v1", data: created }]));
  assert.deepEqual(messages, [{
    message: { customType: "pi-plan-follow-up-v1", content: "Continue the plan coordinator.", details: { planId: "release-11" } },
    options: { triggerTurn: true, deliverAs: "followUp" },
  }]);
});

test("agent_settled fails closed when continuation capability is not injected", async () => {
  const { handlers, messages, entries } = setup();
  await handlers.get("agent_settled")({ type: "agent_settled" }, context([{ customType: "pi-plan-event-v1", data: created }]));
  assert.deepEqual(messages, []);
  assert.equal(entries[0].data.type, "plan.interrupted");
});

test("agent_settled reports terminal summaries and interrupts only unsafe active work", async () => {
  const blocked = { ...created, eventId: "two", type: "plan.blocked", data: { reason: "approval required" } };
  const { handlers, messages, entries } = setup({ canContinue: () => false });
  await handlers.get("agent_settled")({ type: "agent_settled" }, context([
    { customType: "pi-plan-event-v1", data: created },
    { customType: "pi-plan-event-v1", data: blocked },
  ]));
  assert.match(messages[0].message.content, /blocked/i);
  assert.deepEqual(entries, []);
  await handlers.get("agent_settled")({ type: "agent_settled" }, context([{ customType: "pi-plan-event-v1", data: created }]));
  assert.equal(entries[0].data.type, "plan.interrupted");
});
