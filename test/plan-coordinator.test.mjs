import assert from "node:assert/strict";
import test from "node:test";

import { createPlanCoordinator } from "../scripts/lib/plan/coordinator.mjs";

const workspace = {
  originRoot: "/repo",
  worktree: "/worktree",
  baseCommit: "base",
  headCommit: "head",
  planPath: "/repo/docs/plan.md",
  planHash: "a".repeat(64),
};

function plan(tasks = [
  { id: "task-1", deps: [], agent: "executor", title: "创建 smoke test 文件", files: ["sandbox/smoke.txt"], body: "**Files:**\n- Create: `sandbox/smoke.txt`" },
  { id: "task-2", deps: [], agent: "reviewer", title: "审查结果", files: ["sandbox/smoke.txt"], body: "**Files:**\n- Modify: `sandbox/smoke.txt`" },
]) {
  return { tasks };
}

function createdEntry(tasks = ["task-1", "task-2"]) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: "created",
    planId: "plan-1",
    occurredAt: "2026-07-15T00:00:00.000Z",
    type: "plan.created",
    data: { workspace, tasks },
  };
}

function coordinator({ entries = [createdEntry()], nestedResults = [], statuses = new Map() } = {}) {
  const appended = [];
  const result = createPlanCoordinator({
    plan: plan(),
    entries,
    append: (entry) => appended.push(entry),
    id: (() => {
      let index = 0;
      return () => `event-${++index}`;
    })(),
    now: () => "2026-07-15T00:00:01.000Z",
    nestedResults: () => nestedResults,
    readStatus: (asyncDir) => statuses.get(asyncDir),
  });
  return { ...result, appended };
}

test("authorizes only the earliest runnable task with exact fresh async parameters", () => {
  const { coordinator: subject, appended } = coordinator();

  const intent = subject.authorizeNext();

  assert.deepEqual(intent.tool, {
    agent: "executor",
    task: intent.tool.task,
    cwd: "/worktree",
    context: "fresh",
    async: true,
    clarify: false,
    acceptance: { level: "none", reason: "plan-runner manages verification through dedicated gates" },
  });
  assert.match(intent.tool.task, /task-1/);
  assert.equal(appended[0].type, "attempt.dispatch-requested");
  assert.equal(appended[0].data.taskId, "task-1");
});

test("allows exactly the persisted nested subagent intent once and rejects deviations", () => {
  const { coordinator: subject } = coordinator();
  const intent = subject.authorizeNext();

  assert.throws(() => subject.authorizeNestedSubagent({ ...intent.tool, agent: "other" }), /does not match/);
  assert.throws(() => subject.authorizeNestedSubagent({ ...intent.tool, cwd: "/other" }), /does not match/);
  assert.throws(() => subject.authorizeNestedSubagent({ ...intent.tool, async: false }), /does not match/);
  assert.equal(subject.authorizeNestedSubagent(intent.tool), true);
  assert.throws(() => subject.authorizeNestedSubagent(intent.tool), /already consumed/);
});

test("authorizeNestedSubagent tolerates LLM-rephrased task text", () => {
  const { coordinator: subject } = coordinator();
  const intent = subject.authorizeNext();

  assert.equal(subject.authorizeNestedSubagent({ ...intent.tool, task: "Rephrased by LLM: do task-1 now" }), true);
});

test("binds foreground and async structured nested results without parsing display text", () => {
  const { coordinator: subject, appended } = coordinator();
  subject.authorizeNext();

  subject.bindNestedResult({
    details: {
      runId: "foreground-run",
      results: [{ sessionFile: "/sessions/foreground.jsonl", artifactPaths: ["/artifacts/foreground"] }],
    },
    text: "runId: wrong-text-value",
  });
  assert.deepEqual(appended.at(-1).data, {
    attemptId: "attempt-plan-1-task-1-1",
    taskId: "task-1",
    runId: "foreground-run",
    asyncDir: null,
    sessionFile: "/sessions/foreground.jsonl",
  });

  const { coordinator: asyncSubject, appended: asyncAppended } = coordinator();
  asyncSubject.authorizeNext();
  asyncSubject.bindNestedResult({ details: { runId: "async-run", asyncDir: "/async/run", results: [{ sessionFile: "/sessions/async.jsonl" }] } });
  assert.deepEqual(asyncAppended.at(-1).data, {
    attemptId: "attempt-plan-1-task-1-1",
    taskId: "task-1",
    runId: "async-run",
    asyncDir: "/async/run",
    sessionFile: "/sessions/async.jsonl",
  });
});

test("does not accept a terminal attempt until explicit review acceptance", () => {
  const { coordinator: subject, appended } = coordinator();
  subject.authorizeNext();
  subject.bindNestedResult({ details: { runId: "run-1", asyncDir: "/async" } });
  subject.settleBoundAttempt("succeeded");

  assert.equal(appended.some((entry) => entry.type === "task.accepted"), false);
  subject.acceptReviewedTask("task-1");
  assert.equal(appended.at(-1).type, "task.accepted");
});

test("creates a distinct retry attempt only after a failed attempt settles", () => {
  const { coordinator: subject } = coordinator();
  const first = subject.authorizeNext();
  subject.bindNestedResult({ details: { runId: "run-1", asyncDir: "/async/1" } });
  subject.settleBoundAttempt("failed");
  const retry = subject.authorizeNext();

  assert.notEqual(first.attemptId, retry.attemptId);
  assert.equal(retry.attemptId, "attempt-plan-1-task-1-2");
});

test("blocks rather than resending an unbound persisted dispatch request", () => {
  const { coordinator: subject, appended } = coordinator({
    entries: [
      createdEntry(),
      {
        schemaVersion: "pi-plan-event.v1", eventId: "requested", planId: "plan-1", occurredAt: "2026-07-15T00:00:01.000Z",
        type: "attempt.dispatch-requested",
        data: { attemptId: "attempt-plan-1-task-1-1", taskId: "task-1", tool: { agent: "executor", task: "prompt", cwd: "/worktree", context: "fresh", async: true, clarify: false } },
      },
    ],
  });

  assert.equal(subject.recover().state, "blocked");
  assert.equal(appended.at(-1).type, "plan.blocked");
  assert.equal(appended.at(-1).data.reason, "dispatch_uncertain");
});

test("recovery binds persisted nested result, settles clear terminal status, and never respawns it", () => {
  const { coordinator: subject, appended } = coordinator({
    entries: [
      createdEntry(),
      {
        schemaVersion: "pi-plan-event.v1", eventId: "requested", planId: "plan-1", occurredAt: "2026-07-15T00:00:01.000Z",
        type: "attempt.dispatch-requested",
        data: { attemptId: "attempt-plan-1-task-1-1", taskId: "task-1", tool: { agent: "executor", task: "prompt", cwd: "/worktree", context: "fresh", async: true, clarify: false } },
      },
    ],
    nestedResults: [{ details: { runId: "run-1", asyncDir: "/async/1", results: [{ sessionFile: "/sessions/one.jsonl" }] } }],
    statuses: new Map([["/async/1", { state: "complete" }]]),
  });

  const recovery = subject.recover();

  assert.equal(recovery.state, "recovered");
  assert.deepEqual(appended.map((entry) => entry.type), ["attempt.bound", "attempt.settled"]);
  assert.throws(() => subject.authorizeNext(), /awaiting review/);
});

test("buildExecutionPrompt includes task title, files, and commit instruction", () => {
  const { coordinator: subject } = coordinator();
  const intent = subject.authorizeNext();
  assert.match(intent.tool.task, /smoke test/);
  assert.match(intent.tool.task, /sandbox\/smoke\.txt/);
  assert.match(intent.tool.task, /commit/i);
});

test("dispatch disables acceptance so plan gates control quality", () => {
  const { coordinator: subject } = coordinator();
  const intent = subject.authorizeNext();
  assert.ok(intent.tool.acceptance, "dispatch should set acceptance");
  assert.equal(intent.tool.acceptance.level, "none");
  assert.equal(typeof intent.tool.acceptance.reason, "string");
  assert.ok(intent.tool.acceptance.reason.length > 0);
});
