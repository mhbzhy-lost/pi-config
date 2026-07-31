import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent } from "../scripts/lib/goal-engine/store.mjs";
import { auditGoal } from "../scripts/lib/goal-engine/audit.mjs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeEvent(type, data, goalId) {
  return {
    schemaVersion: "goal-engine.event.v1",
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "ge-audit-"));
}

const TASK_DEF = {
  description: "Implement feature",
  deps: [],
  writePaths: ["src/x.ts"],
  acceptance: { criteria: ["works"], commands: ["true"] },
  workflow: "tdd",
};

test("auditGoal reports healthy for well-maintained goal", () => {
  const root = tmpRoot();
  const goalId = "healthy-goal";
  let v = 0;

  appendEvent(root, makeEvent("goal.created", {
    objective: "Build feature X",
    scope: ["src/"],
    nonGoals: [],
    dod: ["Tests pass"],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  appendEvent(root, makeEvent("task.dispatched", { taskId: "t1", contractHash: "sha256aaa" }, goalId), v++);

  appendEvent(root, makeEvent("task.settled", {
    taskId: "t1",
    outcome: "succeeded",
    evidence: { type: "file", path: "src/x.ts" },
    evidenceSource: "pre_existing",
    nextAction: "Accept t1 and verify all acceptance criteria are satisfied",
  }, goalId), v++);

  appendEvent(root, makeEvent("goal.checkpoint", {
    nextAction: "Review evidence quality and confirm task acceptance is valid",
  }, goalId), v++);

  appendEvent(root, makeEvent("task.accepted", { taskId: "t1" }, goalId), v++);

  appendEvent(root, makeEvent("goal.completed", { verdict: "COMPLETE" }, goalId), v++);

  const report = auditGoal(goalId, root);
  assert.equal(report.verdict, "HEALTHY");
  assert.equal(report.signals.length, 0);
  assert.equal(report.goal_id, goalId);
  assert.equal(report.lifecycle, "completed");
  assert.equal(report.total_events, 6);
  assert.equal(report.checkpoint_count, 1);
  assert.deepEqual(report.progress, { total: 1, accepted: 1 });
  assert.equal(report.failed_attempts, 0);
  assert.equal(report.has_external_evidence, true);
});

test("auditGoal detects high retry rate", () => {
  const root = tmpRoot();
  const goalId = "retry-goal";
  let v = 0;

  appendEvent(root, makeEvent("goal.created", {
    objective: "Flaky task",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  for (let i = 0; i < 3; i++) {
    appendEvent(root, makeEvent("task.dispatched", { taskId: "t1", contractHash: `hash-${i}` }, goalId), v++);
    appendEvent(root, makeEvent("task.settled", {
      taskId: "t1",
      outcome: "failed",
      nextAction: `Retry t1 attempt ${i + 2} with adjusted implementation strategy`,
    }, goalId), v++);
    appendEvent(root, makeEvent("goal.checkpoint", {
      nextAction: `Diagnose failure cause and prepare attempt ${i + 2} for t1`,
    }, goalId), v++);
  }

  const report = auditGoal(goalId, root);
  assert.ok(report.signals.includes("HIGH_RETRY_RATE"));
  assert.equal(report.failed_attempts, 3);
  assert.equal(report.verdict, "AT_RISK");
});

test("auditGoal detects all self-produced evidence", () => {
  const root = tmpRoot();
  const goalId = "self-produced-goal";
  let v = 0;

  appendEvent(root, makeEvent("goal.created", {
    objective: "Self-verified work",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  appendEvent(root, makeEvent("task.dispatched", { taskId: "t1", contractHash: "sha256bbb" }, goalId), v++);

  appendEvent(root, makeEvent("task.settled", {
    taskId: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "self_produced",
    nextAction: "Accept t1 and verify goal completion criteria are satisfied",
  }, goalId), v++);

  appendEvent(root, makeEvent("goal.checkpoint", {
    nextAction: "Review self-produced evidence and decide on task acceptance",
  }, goalId), v++);

  appendEvent(root, makeEvent("task.accepted", { taskId: "t1" }, goalId), v++);

  appendEvent(root, makeEvent("goal.completed", { verdict: "DONE_WITHOUT_EXTERNAL_VERIFICATION" }, goalId), v++);

  const report = auditGoal(goalId, root);
  assert.ok(report.signals.includes("ALL_SELF_PRODUCED_EVIDENCE"));
  assert.equal(report.has_external_evidence, false);
  assert.equal(report.verdict, "AT_RISK");
});

test("auditGoal throws for nonexistent goal", () => {
  const root = tmpRoot();
  assert.throws(() => auditGoal("no-such-goal", root), /goal not found/);
});
