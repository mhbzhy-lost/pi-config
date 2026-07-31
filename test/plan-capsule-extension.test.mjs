import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { createPlanCapsuleExtension } from "../scripts/lib/plan/plan-capsule-extension.mjs";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";

const created = {
  schemaVersion: "pi-plan-event.v1", eventId: "one", planId: "release-11", occurredAt: "2026-07-15T00:00:00.000Z", type: "plan.created",
  data: { workspace: { originRoot: "/origin", worktree: "/worktrees/release-11", baseCommit: "base", headCommit: "base", planPath: "/origin/docs/release.md", planHash: "a".repeat(64) }, tasks: ["task-1"] },
};

const attemptWorkspace = { path: "/attempts/attempt-1", branch: "pi-plan-attempt/release-11/task-1/1", ownerToken: "owner-1" };
const activeEvents = [
  created,
  { schemaVersion: "pi-plan-event.v1", eventId: "allocated", planId: "release-11", occurredAt: "2026-07-15T00:00:01.000Z", type: "attempt.workspace-allocated", data: { attemptId: "attempt-1", taskId: "task-1", baseCommit: "base", workspace: attemptWorkspace } },
  { schemaVersion: "pi-plan-event.v1", eventId: "requested", planId: "release-11", occurredAt: "2026-07-15T00:00:02.000Z", type: "attempt.dispatch-requested", data: { attemptId: "attempt-1", taskId: "task-1", dispatchId: "dispatch-1", baseCommit: "base", workspace: attemptWorkspace, tool: { agent: "executor", task: "prompt", cwd: attemptWorkspace.path, context: "fresh", async: true, clarify: false, worktree: false }, toolHash: "hash" } },
  { schemaVersion: "pi-plan-event.v1", eventId: "bound", planId: "release-11", occurredAt: "2026-07-15T00:00:03.000Z", type: "attempt.bound", data: { attemptId: "attempt-1", taskId: "task-1", dispatchId: "dispatch-1", runId: "run-1", asyncDir: "/async/run-1", sessionFile: "/sessions/run-1.jsonl" } },
];
const waitingAttentionEvents = [
  ...activeEvents,
  {
    schemaVersion: "pi-plan-event.v1", eventId: "attention-requested", planId: "release-11",
    occurredAt: "2026-07-15T00:00:04.000Z", type: "attempt.attention-requested",
    data: {
      requestId: "request-1", taskId: "task-1", attemptId: "attempt-1", runId: "run-1",
      kind: "need_decision", message: "Choose the target", projectionVersion: 5,
      createdAt: "2026-07-15T00:00:04.000Z",
      evidence: { bodyPath: "attention/request-1.md", bodySha256: "b".repeat(64) },
    },
  },
  {
    schemaVersion: "pi-plan-event.v1", eventId: "attention-escalated", planId: "release-11",
    occurredAt: "2026-07-15T00:00:05.000Z", type: "attempt.attention-escalated",
    data: {
      attemptId: "attempt-1", requestId: "request-1", runId: "run-1", expectedProjectionVersion: 5,
      evidence: { bodyPath: "attention/request-1.md", bodySha256: "b".repeat(64) },
    },
  },
];

function mixedInFlightValidatedEvents(inFlightStatus) {
  const mixedCreated = {
    ...created,
    eventId: "mixed-created",
    data: { ...created.data, tasks: ["task-1", "task-2"] },
  };
  const taskOneEvents = activeEvents.slice(1).map((event) => ({
    ...event,
    eventId: `mixed-task-1-${event.eventId}`,
    data: { ...event.data },
  }));
  if (inFlightStatus === "dispatch-requested") taskOneEvents.splice(2);
  if (inFlightStatus === "waiting-attention") {
    taskOneEvents.push({
      ...waitingAttentionEvents[4],
      eventId: "mixed-task-1-attention-requested",
      data: { ...waitingAttentionEvents[4].data, projectionVersion: 5 },
    });
  }
  const taskTwoWorkspace = { path: "/attempts/attempt-2", branch: "pi-plan-attempt/release-11/task-2/1", ownerToken: "owner-2" };
  return [
    mixedCreated,
    ...taskOneEvents,
    { schemaVersion: "pi-plan-event.v1", eventId: "mixed-task-2-allocated", planId: "release-11", occurredAt: "2026-07-15T00:00:06.000Z", type: "attempt.workspace-allocated", data: { attemptId: "attempt-2", taskId: "task-2", baseCommit: "base", workspace: taskTwoWorkspace } },
    { schemaVersion: "pi-plan-event.v1", eventId: "mixed-task-2-requested", planId: "release-11", occurredAt: "2026-07-15T00:00:07.000Z", type: "attempt.dispatch-requested", data: { attemptId: "attempt-2", taskId: "task-2", dispatchId: "dispatch-2", baseCommit: "base", workspace: taskTwoWorkspace, tool: { agent: "executor", task: "prompt", cwd: taskTwoWorkspace.path, context: "fresh", async: true, clarify: false, worktree: false }, toolHash: "hash-2" } },
    { schemaVersion: "pi-plan-event.v1", eventId: "mixed-task-2-bound", planId: "release-11", occurredAt: "2026-07-15T00:00:08.000Z", type: "attempt.bound", data: { attemptId: "attempt-2", taskId: "task-2", dispatchId: "dispatch-2", runId: "run-2", asyncDir: "/async/run-2", sessionFile: "/sessions/run-2.jsonl" } },
    { schemaVersion: "pi-plan-event.v1", eventId: "mixed-task-2-settled", planId: "release-11", occurredAt: "2026-07-15T00:00:09.000Z", type: "attempt.settled", data: { attemptId: "attempt-2", outcome: "succeeded", resultCommit: "result-2" } },
    { schemaVersion: "pi-plan-event.v1", eventId: "mixed-task-2-validated", planId: "release-11", occurredAt: "2026-07-15T00:00:10.000Z", type: "attempt.validated", data: { attemptId: "attempt-2", resultCommit: "result-2", validationHash: "validation-2", evidence: [{ path: "evidence/task-2-validation.json", sha256: "v".repeat(64) }] } },
  ];
}

function openBinding() {
  return { planId: "release-11", revision: 1, manifestSha256: "a".repeat(64), planIrHash: "b".repeat(64), baseCommit: "base", worktree: "/worktree", allowPlanCommits: true };
}

function context(branch = []) {
  return { sessionManager: { getBranch: () => branch } };
}

function setup(options = {}) {
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  let activeTools = options.activeTools ?? ["read", "grep", "bash", "subagent", "contact_supervisor", "subagent_wait", "subagent_supervisor", "plan_open"];
  let extensionLoading = options.rejectActionMethodsDuringLoading === true;
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    getActiveTools() { return activeTools; },
    setActiveTools(next) {
      if (extensionLoading) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      activeTools = next;
    },
    sendMessage(message, sendOptions) { messages.push({ message, options: sendOptions }); },
  };
  createPlanCapsuleExtension(pi, {
    appendPlanEvent: async (_ctx, type, data) => {
      const events = _ctx?.sessionManager?.getBranch?.() ?? [];
      const existing = events.find((entry) => entry?.customType === "pi-plan-event-v1")?.data;
      pi.appendEntry("pi-plan-event-v1", {
        schemaVersion: "pi-plan-event.v1", eventId: options.id?.() ?? crypto.randomUUID(),
        planId: existing?.planId ?? "release-11", occurredAt: options.now?.() ?? new Date().toISOString(), type, data,
      });
    },
    writeCurrentRevision: async () => {},
    ...options,
  });
  extensionLoading = false;
  return { tools, handlers, entries, messages, activeTools: () => activeTools };
}

async function execute(tool, params, ctx = context()) {
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

function executorContract() {
  const compiled = compileCodingDispatchIR({
    version: "dispatch-ir.v1", taskId: "task-1", title: "Execute task", agent: "executor", risk: "low", objective: "Execute the approved task.",
    requirements: ["Change one file."], context: { knownFacts: [], decisions: [], relevantFiles: ["src/task-1.mjs"] },
    boundaries: { writePaths: ["src/task-1.mjs"], excludedWork: [], forbiddenActions: [] }, workflow: { mode: "tdd" },
    acceptance: { criteria: ["Tests pass."], commands: ["node --test"] }, execution: { timeoutMs: 1000, cwd: attemptWorkspace.path },
  }, { cwd: attemptWorkspace.path });
  const { hash, ...input } = compiled;
  assert.equal(Object.hasOwn(input, "hash"), false);
  assert.equal(compileCodingDispatchIR(input, { cwd: attemptWorkspace.path }).hash, hash);
  return { input, hash };
}

test("plan-runner alone uses the real subagentOnlyExtensions profile field", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const profiles = await Promise.all(["plan-runner", "plan-reviewer", "executor", "spark"].map((name) => readFile(resolve(root, "pi", "agents", `${name}.md`), "utf8")));
  assert.match(profiles[0], /^subagentOnlyExtensions: \.pi-subagents\/plan-runner-entry\.mjs$/m);
  assert.match(profiles[0], /^tools: plan_open,read,grep$/m);
  assert.match(profiles[0], /plan_read_revision[\s\S]*plan_amend/);
  assert.doesNotMatch(profiles[0], /\bbash\b|approvedHash|contact_supervisor/);
  assert.doesNotMatch(profiles[0], /(?:check|Supervisor)\s+Supervisor pending|subagent_wait with timeoutMs 1000ms|timeoutMs: 1000/);
  for (const value of ["plan_continue", "dispatch-required", "dispatches", "subagent", "contract"]) assert.match(profiles[0], new RegExp(`\\b${value}\\b`));
  assert.match(profiles[0], /each[\s\S]*dispatch[\s\S]*subagent[\s\S]*exact[\s\S]*contract/i);
  assert.match(profiles[0], /no pending dispatch[\s\S]*not call/i);
  assert.doesNotMatch(profiles[0], /attemptId|dispatchId|contractHash/);
  assert.doesNotMatch(profiles[0], /subagent_wait|local wait loop/i);
  assert.doesNotMatch(profiles[0], /^tools:.*(?:^|,)subagent(?:,|$)/m);
  assert.match(profiles[2], /^tools: .*contact_supervisor$/m);
  assert.doesNotMatch(profiles[2], /^tools:.*(?:^|,)subagent(?:,|$)/m);
  for (const profile of profiles) assert.doesNotMatch(profile, /^extensions:/m);
  for (const profile of profiles.slice(1)) assert.doesNotMatch(profile, /plan-capsule/);
});

test("capsule statically registers plan lifecycle tools and declares actual bootstrap fields", () => {
  const { tools } = setup();
  assert.deepEqual([...tools.keys()], [
    "plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block", "plan_read_revision", "plan_amend",
  ]);
  assert.deepEqual(Object.keys(tools.get("plan_open").parameters.properties).sort(), ["allowPlanCommits", "baseCommit", "manifestSha256", "planId", "planIrHash", "revision", "worktree"]);
});

test("capsule factory does not call action methods during extension loading", () => {
  assert.doesNotThrow(() => setup({ rejectActionMethodsDuringLoading: true }));
});

test("capsule pre-open active tools are limited to plan_open and read-only tools", async () => {
  const { activeTools, handlers } = setup();
  await handlers.get("session_start")({}, context());
  assert.deepEqual(activeTools(), ["plan_open", "read", "grep"]);
});

test("runtime capability check waits until plan_open after extension session handlers settle", async () => {
  const calls = [];
  const binding = openBinding();
  const { tools, handlers } = setup({
    assertRuntimeCapabilities: async () => calls.push("assert"),
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
  });

  await handlers.get("session_start")({ reason: "startup" }, context());
  assert.deepEqual(calls, []);
  await handlers.get("before_agent_start")({}, context());
  assert.deepEqual(calls, ["assert"]);

  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);
  assert.deepEqual(calls, ["assert"]);
});

test("before_agent_start checks capabilities before recovering an opened Plan", async () => {
  const calls = [];
  const { handlers } = setup({
    assertRuntimeCapabilities: async () => calls.push("capabilities"),
    prepareExecutionLifecycle: async () => calls.push("prepare"),
    recoverSupersededAttempts: async () => calls.push("recovery"),
  });
  const ctx = context([{
    customType: "pi-plan-event-v1",
    data: created,
  }]);

  await handlers.get("session_start")({}, ctx);
  await handlers.get("before_agent_start")({}, ctx);

  assert.deepEqual(calls, ["capabilities", "prepare", "recovery"]);
});

test("before_agent_start prepares an empty durable projection without supersede recovery", async () => {
  const calls = [];
  const { handlers } = setup({
    assertRuntimeCapabilities: async () => calls.push("capabilities"),
    prepareExecutionLifecycle: async () => calls.push("prepare"),
    recoverSupersededAttempts: async () => { calls.push("recovery"); throw new Error("empty projection must not recover superseded attempts"); },
  });

  await handlers.get("before_agent_start")({}, context());

  assert.deepEqual(calls, ["capabilities", "prepare"]);
});

test("before_agent_start reactivates tools from a revived durable Plan", async () => {
  const { activeTools, handlers } = setup();
  const ctx = context([{
    customType: "pi-plan-event-v1",
    data: created,
  }]);

  await handlers.get("before_agent_start")({}, ctx);

  assert.deepEqual(activeTools(), [
    "plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block", "plan_read_revision", "plan_amend",
    "subagent", "plan_executor_supervisor", "read", "grep",
  ]);
});

test("plan_open fails before binding when runtime capability remains unavailable", async () => {
  const binding = openBinding();
  let bindingCalled = false;
  const { tools, entries } = setup({
    assertRuntimeCapabilities: async () => {
      throw new Error("runtime tool unavailable");
    },
    validateBinding: async () => {
      bindingCalled = true;
      throw new Error("must not run");
    },
  });

  const result = await execute(tools.get("plan_open"), binding);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /runtime tool unavailable/);
  assert.equal(bindingCalled, false);
  assert.deepEqual(entries, []);
});

test("plan_open fails closed when the Task 12 binding dependency is absent", async () => {
  const { tools } = setup();
  const result = await execute(tools.get("plan_open"), openBinding());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /binding validation is unavailable/i);
});

test("plan_open validates then persists and activates the lifecycle tools", async () => {
  const binding = openBinding();
  const { tools, entries, activeTools } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
  });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(entries[0].customType, "pi-plan-event-v1");
  assert.equal(entries[0].data.type, "plan.created");
  assert.equal(entries[0].data.data.workspace.planPath, undefined);
  assert.equal(entries[0].data.data.workspace.planHash, undefined);
  assert.deepEqual([...tools.keys()], ["plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block", "plan_read_revision", "plan_amend"]);
  assert.deepEqual(activeTools(), [
    "plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block", "plan_read_revision", "plan_amend",
    "subagent", "plan_executor_supervisor", "read", "grep",
  ]);
});

test("plan_open tool result registers a durable Root wake", async () => {
  const binding = openBinding();
  const calls = [];
  const { tools, handlers, messages } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    requestCallerFollowUp: async (request) => calls.push(request),
  });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);

  await handlers.get("tool_result")({ toolName: "plan_open", isError: false }, context());

  assert.deepEqual(calls, [{ wakeId: "plan-opened", reason: "plan-opened" }]);
  assert.deepEqual(messages, []);
});

test("plan_open tool result deduplicates repeated durable Root wakes", async () => {
  const binding = openBinding();
  const calls = [];
  const { tools, handlers, messages } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    requestCallerFollowUp: async (request) => calls.push(request),
  });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);

  await handlers.get("tool_result")({ toolName: "plan_open", isError: false }, context());
  await handlers.get("tool_result")({ toolName: "plan_open", isError: false }, context());

  assert.deepEqual(calls, [{ wakeId: "plan-opened", reason: "plan-opened" }]);
  assert.deepEqual(messages, []);
});

test("plan_open tool result retries a durable Root wake after request failure", async () => {
  const binding = openBinding();
  const calls = [];
  const { tools, handlers, messages } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    requestCallerFollowUp: async (request) => {
      calls.push(request);
      if (calls.length === 1) throw new Error("wake unavailable");
    },
  });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);

  await assert.rejects(
    handlers.get("tool_result")({ toolName: "plan_open", isError: false }, context()),
    /wake unavailable/,
  );
  await handlers.get("tool_result")({ toolName: "plan_open", isError: false }, context());

  assert.deepEqual(calls, [
    { wakeId: "plan-opened", reason: "plan-opened" },
    { wakeId: "plan-opened", reason: "plan-opened" },
  ]);
  assert.deepEqual(messages, []);
});

test("plan_open appends plan.created before writing the current revision", async () => {
  const calls = [];
  const { tools } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    appendPlanEvent: async (_ctx, type, _data, expectedProjectionVersion) => calls.push(["appendPlanEvent", type, expectedProjectionVersion]),
    writeCurrentRevision: async (revision) => calls.push(["writeCurrentRevision", revision]),
  });

  const result = await execute(tools.get("plan_open"), openBinding());

  assert.equal(result.isError, false, result.content[0].text);
  assert.deepEqual(calls, [["appendPlanEvent", "plan.created", 0], ["writeCurrentRevision", 1]]);
});

test("plan_open does not write the current revision when plan.created append rejects", async () => {
  const calls = [];
  const { tools } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    appendPlanEvent: async () => {
      calls.push("appendPlanEvent");
      throw new Error("append rejected");
    },
    writeCurrentRevision: async () => calls.push("writeCurrentRevision"),
  });

  const result = await execute(tools.get("plan_open"), openBinding());

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /append rejected/);
  assert.deepEqual(calls, ["appendPlanEvent"]);
});

test("plan_open leaves durable plan.created intact when current revision write rejects", async () => {
  const calls = [];
  const durableEvents = [];
  const { tools } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    appendPlanEvent: async (_ctx, type, data, expectedProjectionVersion) => {
      calls.push(["appendPlanEvent", type, expectedProjectionVersion]);
      durableEvents.push({ type, data });
    },
    writeCurrentRevision: async () => {
      calls.push(["writeCurrentRevision", 1]);
      throw new Error("pointer rejected");
    },
  });

  const result = await execute(tools.get("plan_open"), openBinding());

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /pointer rejected/);
  assert.deepEqual(calls, [["appendPlanEvent", "plan.created", 0], ["writeCurrentRevision", 1]]);
  assert.deepEqual(durableEvents.map(({ type }) => type), ["plan.created"]);
});

test("plan_open does not allow an approved hash override", async () => {
  const binding = openBinding();
  const { tools } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }) });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);
});

test("plan_open starts child control only after persisting plan.created and session shutdown stops it", async () => {
  const calls = [];
  const binding = openBinding();
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

test("session shutdown runs both cleanups best-effort without throwing", async () => {
  const calls = [];
  const binding = openBinding();
  const { tools, handlers } = setup({
    stopActiveRuns: async () => {
      calls.push("runs");
      await new Promise((resolve) => setImmediate(resolve));
      calls.push("runs-done");
      throw new Error("run stop failed");
    },
    disposeExecutionBackend: async () => calls.push("backend"),
    startPlanControl: async () => () => {
      calls.push("control");
      throw new Error("control stop failed");
    },
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
  });
  await execute(tools.get("plan_open"), binding);
  await handlers.get("session_shutdown")({}, context());
  assert.deepEqual(calls, ["control", "runs", "runs-done", "backend"]);
});

test("capsule forwards one complete typed Executor contract and preserves authorizer errors", async (t) => {
  const calls = [];
  const { handlers } = setup({
    authorizeExecutorDispatch: async (input, value) => { calls.push([input, value]); },
  });
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({ type: "session_start" }, ctx);
  const { input, hash } = executorContract();
  assert.equal(await handlers.get("tool_call")({ toolName: "subagent", toolCallId: "dispatch-1", input }, ctx), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], input);
  assert.equal(calls[0][1].toolCallId, "dispatch-1");
  assert.equal(calls[0][1].ctx, ctx);
  assert.equal(calls[0][1].projection.attempts.get("attempt-1").dispatchId, "dispatch-1");
  assert.equal(compileCodingDispatchIR(input, { cwd: attemptWorkspace.path }).hash, hash);

  await t.test("returns the authorizer error unchanged", async () => {
    const rejecting = setup({
      authorizeExecutorDispatch: async () => { throw new Error("Executor dispatch contract required"); },
    });
    await rejecting.handlers.get("session_start")({}, ctx);
    assert.deepEqual(
      await rejecting.handlers.get("tool_call")({ toolName: "subagent", toolCallId: "dispatch-2", input }, ctx),
      { block: true, reason: "Executor dispatch contract required" },
    );
  });
});

test("capsule blocks generic subagent and non-Supervisor control tools", async () => {
  const { handlers } = setup();
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({}, ctx);
  for (const event of [
    { toolName: "subagent", input: { action: "status", id: "run-1" } },
    { toolName: "contact_supervisor", input: { message: "bypass" } },
    { toolName: "bash", input: { command: "true" } },
    { toolName: "subagent_wait", input: { timeoutMs: 1000 } },
    { toolName: "subagent_supervisor", input: { action: "send", to: "other", message: "bypass" } },
  ]) {
    const denied = await handlers.get("tool_call")(event, ctx);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /authorization boundary|limited to pending and fenced reply/i);
  }
});

test("capsule blocking reason names the Plan dispatch authorization boundary", async () => {
  const { handlers } = setup();
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({}, ctx);
  const denied = await handlers.get("tool_call")({ toolName: "subagent", input: { agent: "executor" } }, ctx);
  assert.match(denied.reason, /Plan dispatch authorization boundary/);
  assert.doesNotMatch(denied.reason, /Standalone/);
});

test("capsule persists native Supervisor requests through the injected Attention boundary", async () => {
  const recorded = [];
  const { handlers } = setup({
    recordSupervisorRequest: async (request, { ctx }) => recorded.push({ request, ctx }),
  });
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({ type: "session_start" }, ctx);
  const message = {
    customType: "subagent_supervisor_request",
    content: "Choose the target",
    display: true,
    details: { id: "request-1", reason: "need_decision", expectsReply: true, runId: "run-1", agent: "executor", childIndex: 0 },
  };

  await handlers.get("message_end")({ message }, ctx);
  assert.deepEqual(recorded, [{ request: message, ctx }]);
});

test("capsule resolves only the authorized successful project Supervisor reply", async () => {
  const authorized = [];
  const resolved = [];
  const { handlers } = setup({
    authorizeSupervisorReply: async (input) => {
      authorized.push(input);
      return { requestId: input.replyTo, runId: "run-1" };
    },
    resolveSupervisorReply: async (authorization) => resolved.push(authorization),
  });
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({ type: "session_start" }, ctx);
  const input = { action: "reply", replyTo: "request-1", to: "executor", message: "Use target A" };
  const call = { toolName: "plan_executor_supervisor", toolCallId: "reply-call-1", input };
  assert.equal(await handlers.get("tool_call")(call, ctx), undefined);
  const result = { toolName: "plan_executor_supervisor", toolCallId: "reply-call-1", input, isError: false };
  await handlers.get("tool_result")(result, ctx);
  await handlers.get("tool_result")(result, ctx);

  assert.deepEqual(authorized, [input]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].requestId, "request-1");
  assert.equal(resolved[0].message, "Use target A");
});

test("capsule retains a Supervisor authorization when result resolution fails and retries it once", async () => {
  let resolveCalls = 0;
  const { handlers } = setup({
    authorizeSupervisorReply: async (input) => ({ requestId: input.replyTo, runId: "run-1" }),
    resolveSupervisorReply: async () => {
      resolveCalls++;
      if (resolveCalls === 1) throw new Error("ack unavailable");
    },
  });
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({ type: "session_start" }, ctx);
  const input = { action: "reply", replyTo: "request-1", to: "executor", message: "Use target A" };
  const call = { toolName: "plan_executor_supervisor", toolCallId: "reply-call-retry", input };
  const result = { toolName: "plan_executor_supervisor", toolCallId: "reply-call-retry", input, isError: false };
  assert.equal(await handlers.get("tool_call")(call, ctx), undefined);
  await assert.rejects(handlers.get("tool_result")(result, ctx), /ack unavailable/);
  await handlers.get("tool_result")(result, ctx);
  await handlers.get("tool_result")(result, ctx);
  assert.equal(resolveCalls, 2);
});

test("capsule submits one Executor tool result and retries an unresolved result", async () => {
  let calls = 0;
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  const { handlers } = setup({
    authorizeExecutorDispatch: async () => {},
    resolveExecutorDispatchResult: async () => {
      calls += 1;
      if (calls === 1) throw new Error("result persistence unavailable");
    },
  });
  await handlers.get("session_start")({}, ctx);
  const { input } = executorContract();
  const call = { toolName: "subagent", toolCallId: "executor-result-call", input };
  assert.equal(await handlers.get("tool_call")(call, ctx), undefined);
  const event = { ...call, isError: false, details: { runId: "run-1", asyncDir: "/async/run-1" } };
  await assert.rejects(handlers.get("tool_result")(event, ctx), /result persistence unavailable/);
  await handlers.get("tool_result")(event, ctx);
  await handlers.get("tool_result")(event, ctx);
  assert.equal(calls, 2);
});

test("capsule routes each authorized Executor success and error event with its raw event and current context", async (t) => {
  for (const isError of [false, true]) await t.test(isError ? "error" : "success", async () => {
    const calls = []; const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
    const { handlers } = setup({ authorizeExecutorDispatch: async () => {}, resolveExecutorDispatchResult: async (...args) => calls.push(args) });
    await handlers.get("session_start")({}, ctx);
    const { input } = executorContract();
    const event = { toolName: "subagent", toolCallId: `route-${isError}`, input, isError, details: { runId: "run-1", asyncDir: "/async/run-1" } };
    assert.equal(await handlers.get("tool_call")(event, ctx), undefined);
    await handlers.get("tool_result")(event, ctx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], event);
    assert.equal(calls[0][1].ctx, ctx);
    assert.equal(calls[0][1].projection.attempts.get("attempt-1").dispatchId, "dispatch-1");
  });
});

test("capsule fails closed for an authorized Executor result when result resolution is unavailable", async () => {
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  const { handlers } = setup({ authorizeExecutorDispatch: async () => {} });
  await handlers.get("session_start")({}, ctx);
  const { input } = executorContract(); const event = { toolName: "subagent", toolCallId: "missing-result-capability", input, isError: false };
  assert.equal(await handlers.get("tool_call")(event, ctx), undefined);
  await assert.rejects(handlers.get("tool_result")(event, ctx), /result.*unavailable|resolution.*unavailable/i);
});

test("capsule blocks legacy Supervisor pending and reply without invoking its authorizer", async () => {
  const authorized = [];
  const { handlers } = setup({ authorizeSupervisorReply: async (input) => authorized.push(input) });
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({}, ctx);
  for (const input of [
    { action: "pending" },
    { action: "reply", replyTo: "request-1", to: "executor", message: "Use target A" },
  ]) {
    const denied = await handlers.get("tool_call")({ toolName: "subagent_supervisor", toolCallId: `legacy-${input.action}`, input }, ctx);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /authorization boundary|limited to pending and fenced reply/i);
  }
  assert.deepEqual(authorized, []);
});

test("project Supervisor preserves authorizer errors while pending bypasses reply authorization", async () => {
  const authorized = [];
  const { handlers } = setup({
    authorizeSupervisorReply: async (input) => {
      authorized.push(input);
      throw new Error("project Supervisor authorization failed");
    },
  });
  const ctx = context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data })));
  await handlers.get("session_start")({}, ctx);
  assert.equal(await handlers.get("tool_call")({ toolName: "plan_executor_supervisor", toolCallId: "pending-1", input: { action: "pending" } }, ctx), undefined);
  assert.deepEqual(authorized, []);
  assert.deepEqual(
    await handlers.get("tool_call")({ toolName: "plan_executor_supervisor", toolCallId: "reply-1", input: { action: "reply", replyTo: "request-1", to: "executor", message: "Use target A" } }, ctx),
    { block: true, reason: "project Supervisor authorization failed" },
  );
  assert.equal(authorized.length, 1);
});

test("plan revision tools use exact schemas and forward only params plus context", async () => {
  const calls = [];
  const { tools } = setup({
    validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] }),
    readCurrentRevision: async (value) => { calls.push(["read", value]); return { revision: 1 }; },
    amendPlan: async (params, value) => { calls.push(["amend", params, value]); return { revision: 2 }; },
  });
  await execute(tools.get("plan_open"), openBinding());
  const amend = tools.get("plan_amend");
  assert.deepEqual(tools.get("plan_read_revision").parameters, { type: "object", properties: {}, additionalProperties: false });
  assert.deepEqual(Object.keys(amend.parameters.properties).sort(), ["baseRevision", "expectedProjectionVersion", "reason", "requestId", "source"]);
  assert.deepEqual(amend.parameters.required, ["expectedProjectionVersion", "baseRevision", "requestId", "reason", "source"]);
  assert.equal(amend.parameters.additionalProperties, false);
  const ctx = context();
  await execute(tools.get("plan_read_revision"), {}, ctx);
  await execute(amend, { expectedProjectionVersion: 1, baseRevision: 1, requestId: "amend-1", reason: "fix", source: "# Plan" }, ctx);
  assert.deepEqual(calls, [
    ["read", { ctx }],
    ["amend", { expectedProjectionVersion: 1, baseRevision: 1, requestId: "amend-1", reason: "fix", source: "# Plan" }, { ctx }],
  ]);
});


test("plan lifecycle tools fail closed until their domain dependencies are injected", async () => {
  const { tools } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }) });
  await execute(tools.get("plan_open"), openBinding());
  for (const name of ["plan_status", "plan_continue", "plan_verify", "plan_block"]) {
    const result = await execute(tools.get(name), {});
    assert.equal(result.isError, true, name);
  }
});

test("plan_status returns the injected derived projection", async () => {
  const { tools } = setup({ status: async () => ({ lifecycle: "running", planId: "release-11" }) });
  await execute(tools.get("plan_open"), openBinding()).catch(() => {});
  const opened = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), status: async () => ({ lifecycle: "running", planId: "release-11" }) });
  await execute(opened.tools.get("plan_open"), openBinding());
  const result = await execute(opened.tools.get("plan_status"), {});
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /"lifecycle": "running"/);
});

test("plan_continue invokes only the injected one-step coordinator", async () => {
  const calls = [];
  const { tools } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), continuePlan: async (value) => calls.push(value) });
  await execute(tools.get("plan_open"), openBinding());
  const result = await execute(tools.get("plan_continue"), { reason: "resume" });
  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{ reason: "resume" }]);
});

test("plan_verify invokes verifier without appending plan.validated", async () => {
  const { tools, entries } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), verifyPlan: async () => ({ lifecycle: "verifying" }) });
  await execute(tools.get("plan_open"), openBinding());
  entries.length = 0;
  const result = await execute(tools.get("plan_verify"), {});
  assert.equal(result.isError, false);
  assert.deepEqual(entries, []);
});

test("plan_block delegates a legal block intent without accepting work", async () => {
  const calls = [];
  const { tools } = setup({ validateBinding: async (input) => ({ ...input, originRoot: "/origin", headCommit: "base", tasks: ["task-1"] }), blockPlan: async (value) => calls.push(value) });
  await execute(tools.get("plan_open"), openBinding());
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

test("agent_settled stays idle while an Attempt is active", async () => {
  const { handlers, messages } = setup({ canContinue: () => true });
  await handlers.get("agent_settled")(
    { type: "agent_settled" },
    context(activeEvents.map((data) => ({ customType: "pi-plan-event-v1", data }))),
  );
  assert.deepEqual(messages, []);
});

test("agent_settled stays idle while an Attempt awaits dispatch execution", async () => {
  const { handlers, messages } = setup({ canContinue: () => true });
  await handlers.get("agent_settled")(
    { type: "agent_settled" },
    context(activeEvents.slice(0, 3).map((data) => ({ customType: "pi-plan-event-v1", data }))),
  );
  assert.deepEqual(messages, []);
});

test("agent_settled stays idle while every active Attempt waits for Root Attention", async () => {
  const { handlers, messages } = setup({ canContinue: () => true });
  await handlers.get("agent_settled")(
    { type: "agent_settled" },
    context(waitingAttentionEvents.map((data) => ({ customType: "pi-plan-event-v1", data }))),
  );
  assert.deepEqual(messages, []);
});

for (const inFlightStatus of ["dispatch-requested", "active", "waiting-attention"]) {
  test(`agent_settled continues coordinator work with ${inFlightStatus} and validated Attempts`, async () => {
    const { handlers, messages } = setup({ canContinue: () => true });
    await handlers.get("agent_settled")(
      { type: "agent_settled" },
      context(mixedInFlightValidatedEvents(inFlightStatus).map((data) => ({ customType: "pi-plan-event-v1", data }))),
    );
    assert.deepEqual(messages, [{
      message: { customType: "pi-plan-follow-up-v1", content: "Continue the plan coordinator.", details: { planId: "release-11" } },
      options: { triggerTurn: true, deliverAs: "followUp" },
    }]);
    const contents = messages.map(({ message }) => message.content).join("\n");
    assert.doesNotMatch(contents, /subagent_wait|Supervisor pending|executor-control-loop/);
  });
}

test("agent_settled uses a valid custom follow-up payload for runnable work", async () => {
  const { handlers, messages } = setup({ canContinue: () => true });
  await handlers.get("agent_settled")({ type: "agent_settled" }, context([{ customType: "pi-plan-event-v1", data: created }]));
  assert.deepEqual(messages, [{
    message: { customType: "pi-plan-follow-up-v1", content: "Continue the plan coordinator.", details: { planId: "release-11" } },
    options: { triggerTurn: true, deliverAs: "followUp" },
  }]);
});

test("agent_settled durable runnable work does not rearm the consumed plan-opened wake", async () => {
  const calls = [];
  const { handlers, messages } = setup({
    canContinue: () => true,
    requestCallerFollowUp: async (request) => calls.push(request),
  });

  await handlers.get("agent_settled")({ type: "agent_settled" }, context([{ customType: "pi-plan-event-v1", data: created }]));

  assert.deepEqual(calls, []);
  assert.deepEqual(messages, []);
});

test("agent_settled durable gate-required continuation does not rearm the consumed plan-opened wake", async () => {
  const calls = [];
  const { handlers, messages } = setup({
    canContinue: () => false,
    getHeadCommit: async () => "advanced",
    requestCallerFollowUp: async (request) => calls.push(request),
  });

  await handlers.get("agent_settled")({ type: "agent_settled" }, context([{ customType: "pi-plan-event-v1", data: created }]));

  assert.deepEqual(calls, []);
  assert.deepEqual(messages, []);
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

test("plan_open rejects legacy planPath input before validateBinding", async () => {
  let called = false;
  const { tools } = setup({ validateBinding: async () => { called = true; } });
  const result = await execute(tools.get("plan_open"), { ...openBinding(), planPath: "docs/plans/my-plan.md" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid plan_open input/);
  assert.equal(called, false);
});
