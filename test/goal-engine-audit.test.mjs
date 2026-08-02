import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent } from "../scripts/lib/goal-engine/store.mjs";
import { auditGoal } from "../scripts/lib/goal-engine/audit.mjs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeEvent(type, data, goalId, schemaVersion = "goal-engine.event.v1") {
  return {
    schemaVersion,
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

function makeV2Event(type, data, goalId) {
  return makeEvent(type, data, goalId, "goal-engine.event.v2");
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

test("auditGoal reports healthy for well-maintained goal (v2 integrated+released)", () => {
  const root = tmpRoot();
  const goalId = "healthy-goal";
  let v = 0;

  appendEvent(root, makeV2Event("goal.created", {
    objective: "Build feature X",
    scope: ["src/"],
    nonGoals: [],
    dod: ["Tests pass"],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.dispatched", {
    taskId: "t1",
    contractHash: "sha256aaa",
    workspace: { attempt: 1, path: "/tmp/goal-engine/audit-healthy", branch: "task/healthy", baseCommit: "base-healthy" },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.settled", {
    taskId: "t1",
    outcome: "succeeded",
    evidence: { type: "file", path: "src/x.ts" },
    evidenceSource: "pre_existing",
    nextAction: "Accept t1 and verify all acceptance criteria are satisfied",
  }, goalId), v++);

  appendEvent(root, makeV2Event("goal.checkpoint", {
    nextAction: "Review evidence quality and confirm task acceptance is valid",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposition_started", {
    taskId: "t1",
    attempt: 1,
    requestedAction: "integrate",
    strategy: "merge",
    executorHead: "executor-head-healthy",
    originHeadBefore: "origin-head-before-healthy",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposition_applied", {
    taskId: "t1",
    attempt: 1,
    action: "integrate",
    strategy: "merge",
    executorHead: "executor-head-healthy",
    originHead: "origin-head-after-healthy",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposed", {
    taskId: "t1",
    attempt: 1,
    action: "integrate",
    released: true,
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.accepted", { taskId: "t1", workspaceAttempt: 1 }, goalId), v++);

  appendEvent(root, makeV2Event("goal.completed", { verdict: "COMPLETE" }, goalId), v++);

  const report = auditGoal(goalId, root);
  assert.equal(report.verdict, "HEALTHY");
  assert.equal(report.signals.length, 0);
  assert.equal(report.goal_id, goalId);
  assert.equal(report.lifecycle, "completed");
  assert.equal(report.total_events, 9);
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

test("auditGoal detects all self-produced evidence (v2 integrated+released)", () => {
  const root = tmpRoot();
  const goalId = "self-produced-goal";
  let v = 0;

  appendEvent(root, makeV2Event("goal.created", {
    objective: "Self-verified work",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.dispatched", {
    taskId: "t1",
    contractHash: "sha256bbb",
    workspace: { attempt: 1, path: "/tmp/goal-engine/self-produced", branch: "task/self-produced", baseCommit: "base-self-produced" },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.settled", {
    taskId: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "self_produced",
    nextAction: "Accept t1 and verify goal completion criteria are satisfied",
  }, goalId), v++);

  appendEvent(root, makeV2Event("goal.checkpoint", {
    nextAction: "Review self-produced evidence and decide on task acceptance",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposition_started", {
    taskId: "t1",
    attempt: 1,
    requestedAction: "integrate",
    strategy: "merge",
    executorHead: "executor-head-self",
    originHeadBefore: "origin-head-before-self",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposition_applied", {
    taskId: "t1",
    attempt: 1,
    action: "integrate",
    strategy: "merge",
    executorHead: "executor-head-self",
    originHead: "origin-head-after-self",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposed", {
    taskId: "t1",
    attempt: 1,
    action: "integrate",
    released: true,
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.accepted", { taskId: "t1", workspaceAttempt: 1 }, goalId), v++);

  appendEvent(root, makeV2Event("goal.completed", { verdict: "DONE_WITHOUT_EXTERNAL_VERIFICATION" }, goalId), v++);

  const report = auditGoal(goalId, root);
  assert.ok(report.signals.includes("ALL_SELF_PRODUCED_EVIDENCE"));
  assert.equal(report.has_external_evidence, false);
  assert.equal(report.verdict, "AT_RISK");
});

test("auditGoal reports legacy unverified acceptance for v1 history", () => {
  const root = tmpRoot();
  const goalId = "legacy-acceptance-goal";
  let v = 0;

  appendEvent(root, makeEvent("goal.created", {
    objective: "Legacy acceptance regression",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  appendEvent(root, makeEvent("task.dispatched", { taskId: "t1", contractHash: "sha256-legacy" }, goalId), v++);

  appendEvent(root, makeEvent("task.settled", {
    taskId: "t1",
    outcome: "succeeded",
    evidence: { type: "file", path: "src/legacy.ts" },
    evidenceSource: "pre_existing",
    nextAction: "Verify the completed change against acceptance criteria and release notes",
  }, goalId), v++);

  appendEvent(root, makeEvent("task.accepted", { taskId: "t1" }, goalId), v++);

  appendEvent(root, makeEvent("goal.completed", { verdict: "COMPLETE" }, goalId), v++);

  const report = auditGoal(goalId, root);
  assert.ok(report.signals.includes("LEGACY_UNVERIFIED_ACCEPTANCE"));
  assert.notEqual(report.verdict, "HEALTHY");
  assert.equal(report.total_events, 5);
  assert.equal(report.has_external_evidence, true);
});

test("auditGoal detects incomplete workspace disposition while disposing", () => {
  const root = tmpRoot();
  const goalId = "disposing-workspace-goal";
  let v = 0;

  appendEvent(root, makeV2Event("goal.created", {
    objective: "Disposing workspace check",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.dispatched", {
    taskId: "t1",
    contractHash: "sha256-disposing",
    workspace: { attempt: 1, path: "/tmp/goal-engine/disposing", branch: "task/disposing", baseCommit: "base-disposing" },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.settled", {
    taskId: "t1",
    outcome: "succeeded",
    evidence: { type: "file", path: "src/x.ts" },
    evidenceSource: "pre_existing",
    nextAction: "Verify the completed change against acceptance criteria and release notes",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposition_started", {
    taskId: "t1",
    attempt: 1,
    requestedAction: "discard",
    strategy: "merge",
    executorHead: "executor-head-disposing",
    originHeadBefore: "origin-head-before-disposing",
  }, goalId), v++);

  const report = auditGoal(goalId, root);
  assert.ok(report.signals.includes("INCOMPLETE_WORKSPACE_DISPOSITION"));
  assert.equal(report.lifecycle, "active");
  assert.equal(report.total_events, 4);
  assert.notEqual(report.verdict, "HEALTHY");
});

test("auditGoal detects unreleased integrated workspace in applied phase", () => {
  const root = tmpRoot();
  const goalId = "applied-unreleased-workspace-goal";
  let v = 0;

  appendEvent(root, makeV2Event("goal.created", {
    objective: "Unreleased integrated workspace check",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: ["t1"],
    taskDefs: { t1: TASK_DEF },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.dispatched", {
    taskId: "t1",
    contractHash: "sha256-applied",
    workspace: { attempt: 1, path: "/tmp/goal-engine/applied", branch: "task/applied", baseCommit: "base-applied" },
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.settled", {
    taskId: "t1",
    outcome: "succeeded",
    evidence: { type: "file", path: "src/x.ts" },
    evidenceSource: "pre_existing",
    nextAction: "Verify the completed change against acceptance criteria and release notes",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposition_started", {
    taskId: "t1",
    attempt: 1,
    requestedAction: "integrate",
    strategy: "merge",
    executorHead: "executor-head-applied",
    originHeadBefore: "origin-head-before-applied",
  }, goalId), v++);

  appendEvent(root, makeV2Event("task.workspace_disposition_applied", {
    taskId: "t1",
    attempt: 1,
    action: "integrate",
    strategy: "merge",
    executorHead: "executor-head-applied",
    originHead: "origin-head-after-applied",
  }, goalId), v++);

  const report = auditGoal(goalId, root);
  assert.ok(report.signals.includes("INCOMPLETE_WORKSPACE_DISPOSITION"));
  assert.ok(report.signals.includes("UNRELEASED_INTEGRATED_WORKSPACE"));
  assert.equal(report.lifecycle, "active");
  assert.equal(report.total_events, 5);
  assert.notEqual(report.verdict, "HEALTHY");
});

test("auditGoal throws for nonexistent goal", () => {
  const root = tmpRoot();
  assert.throws(() => auditGoal("no-such-goal", root), /goal not found/);
});
