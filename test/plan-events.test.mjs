import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";

const planId = "plan-1";
const workspace = {
  originRoot: "/repo",
  worktree: "/worktree",
  baseCommit: "base",
  headCommit: "head",
  planPath: "/origin/docs/release-plan.md",
  planHash: "a".repeat(64),
};

function event(type, data = {}, overrides = {}) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: crypto.randomUUID(),
    planId,
    occurredAt: "2026-07-15T00:00:00.000Z",
    type,
    data,
    ...overrides,
  };
}

function apply(projection, type, data, overrides) {
  return applyEvent(projection, event(type, data, overrides));
}

function createRunningProjection() {
  return apply(createProjection(), "plan.created", { workspace, tasks: ["task-1"] });
}

function acceptedTask(projection, taskId = "task-1") {
  return apply(projection, "task.accepted", { taskId });
}

function dispatchTool() {
  return { agent: "executor", task: "prompt", cwd: "/worktree", context: "fresh", async: true, clarify: false };
}

function requestAttempt(projection, attemptId, taskId = "task-1") {
  return apply(projection, "attempt.dispatch-requested", { attemptId, taskId, tool: dispatchTool() });
}

function bindAttempt(projection, attemptId, taskId = "task-1") {
  projection = requestAttempt(projection, attemptId, taskId);
  return apply(projection, "attempt.bound", {
    attemptId,
    taskId,
    runId: `${attemptId}-run`,
    asyncDir: `/${attemptId}`,
    sessionFile: `/${attemptId}.jsonl`,
  });
}

function passedGates(projection) {
  for (const type of ["deterministic", "plan-audit", "external-review", "final-completeness"]) {
    projection = apply(projection, "gate.finished", {
      type,
      status: "passed",
      inputHead: workspace.headCommit,
      gateId: `${type}-1`,
      changeSetHash: "changes-1",
      evidence: [{ command: "true" }],
      findings: [],
    });
  }
  return projection;
}

test("creates a created projection with every declared task pending", () => {
  const projection = createRunningProjection();

  assert.equal(projection.planId, planId);
  assert.equal(projection.lifecycle, "created");
  assert.deepEqual(projection.workspace, workspace);
  assert.equal(projection.validatedHead, null);
  assert.ok(projection.tasks instanceof Map);
  assert.ok(projection.attempts instanceof Map);
  assert.ok(projection.gates instanceof Map);
  assert.deepEqual(projection.tasks.get("task-1"), { status: "pending" });
});

test("requires a nonempty unique task list when creating a plan", () => {
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace, tasks: [] })),
    /tasks/,
  );
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace, tasks: ["task-1", "task-1"] })),
    /unique/,
  );
});

test("requires and preserves immutable approved plan identity", () => {
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace: { ...workspace, planPath: "" }, tasks: ["task-1"] })),
    /workspace.planPath/,
  );
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace: { ...workspace, planHash: "" }, tasks: ["task-1"] })),
    /workspace.planHash/,
  );
  assert.deepEqual(createRunningProjection().workspace, workspace);
});

test("rejects invalid envelopes, mixed plans, and duplicate event ids", () => {
  const created = createRunningProjection();

  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace }, { schemaVersion: "wrong" })),
    /schemaVersion/,
  );
  assert.throws(
    () => applyEvent(createProjection(), event("plan.created", { workspace }, { eventId: "" })),
    /eventId/,
  );
  assert.throws(
    () => applyEvent(created, event("task.accepted", { taskId: "task-1" }, { planId: "other" })),
    /planId/,
  );
  const duplicate = event("task.accepted", { taskId: "task-1" }, { eventId: "same" });
  const applied = applyEvent(created, duplicate);
  assert.throws(() => applyEvent(applied, duplicate), /duplicate eventId/);
});

test("attempt activity moves created plans to running and preserves transitions", () => {
  let projection = createRunningProjection();
  projection = bindAttempt(projection, "attempt-1");
  assert.equal(projection.lifecycle, "running");
  assert.equal(projection.attempts.get("attempt-1").taskId, "task-1");
  assert.equal(projection.attempts.get("attempt-1").status, "active");
  assert.equal(projection.attempts.get("attempt-1").runId, "attempt-1-run");

  assert.throws(
    () => apply(projection, "attempt.bound", { attemptId: "attempt-1", taskId: "task-1" }),
    /not dispatch-requested/,
  );
  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded" });
  assert.equal(projection.attempts.get("attempt-1").taskId, "task-1");
  assert.equal(projection.attempts.get("attempt-1").status, "succeeded");
  assert.equal(projection.attempts.get("attempt-1").runId, "attempt-1-run");
  assert.throws(
    () => apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "failed" }),
    /not active/,
  );
});

test("persists exactly one dispatch intent before its binding and preserves structured identifiers", () => {
  let projection = createRunningProjection();
  projection = apply(projection, "attempt.dispatch-requested", {
    attemptId: "attempt-1",
    taskId: "task-1",
    tool: { agent: "executor", task: "prompt", cwd: "/worktree", context: "fresh", async: true, clarify: false },
  });
  assert.deepEqual(projection.attempts.get("attempt-1"), {
    taskId: "task-1",
    status: "dispatch-requested",
    tool: { agent: "executor", task: "prompt", cwd: "/worktree", context: "fresh", async: true, clarify: false },
  });
  projection = apply(projection, "attempt.bound", {
    attemptId: "attempt-1",
    taskId: "task-1",
    runId: "run-1",
    asyncDir: "/async/1",
    sessionFile: "/sessions/one.jsonl",
  });
  assert.deepEqual(projection.attempts.get("attempt-1"), {
    taskId: "task-1",
    status: "active",
    tool: { agent: "executor", task: "prompt", cwd: "/worktree", context: "fresh", async: true, clarify: false },
    runId: "run-1",
    asyncDir: "/async/1",
    sessionFile: "/sessions/one.jsonl",
  });
});

test("rejects attempts for undeclared tasks and a second active mutating attempt", () => {
  let projection = apply(createProjection(), "plan.created", { workspace, tasks: ["task-1", "task-2"] });
  assert.throws(
    () => requestAttempt(projection, "unknown-attempt", "unknown"),
    /unknown task/,
  );

  projection = requestAttempt(projection, "attempt-1", "task-1");
  assert.throws(
    () => requestAttempt(projection, "attempt-2", "task-2"),
    /active attempt/,
  );
});

test("accepts a task once and keeps task values directly usable", () => {
  let projection = createRunningProjection();
  projection = acceptedTask(projection);

  assert.deepEqual(projection.tasks.get("task-1"), { status: "accepted" });
  assert.throws(() => acceptedTask(projection), /not pending/);
  assert.throws(() => apply(projection, "task.accepted", { taskId: "unknown" }), /unknown/);
});

test("records immutable GateAttempt values and enters verifying on the first gate", () => {
  let projection = createRunningProjection();

  assert.throws(
    () => apply(projection, "gate.finished", { type: "deterministic", status: "passed", inputHead: "stale", gateId: "stale", changeSetHash: "changes", evidence: [], findings: [] }),
    /inputHead/,
  );
  projection = apply(projection, "gate.finished", {
    type: "deterministic", status: "passed", inputHead: workspace.headCommit,
    gateId: "deterministic-1", changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
  });
  assert.equal(projection.lifecycle, "verifying");
  assert.deepEqual(projection.gates.get("deterministic"), {
    type: "deterministic", status: "passed", inputHead: workspace.headCommit,
    gateId: "deterministic-1", changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
  });
  assert.throws(
    () => apply(projection, "gate.finished", { type: "deterministic", status: "failed", inputHead: workspace.headCommit, gateId: "deterministic-2", changeSetHash: "changes-2", evidence: [], findings: [] }),
    /already finished/,
  );
});

test("observes a new HEAD, invalidates current gates, and permits replacement gate attempts", () => {
  let projection = createRunningProjection();
  projection = acceptedTask(projection);
  projection = passedGates(projection);
  projection = apply(projection, "workspace.head-observed", { headCommit: "new-head" });

  assert.equal(projection.workspace.headCommit, "new-head");
  assert.equal(projection.lifecycle, "running");
  assert.equal(projection.gates.size, 0);
  projection = apply(projection, "gate.finished", {
    type: "deterministic", status: "passed", inputHead: "new-head",
    gateId: "deterministic-2", changeSetHash: "changes-2", evidence: [{ command: "true" }], findings: [],
  });
  assert.equal(projection.gates.get("deterministic").inputHead, "new-head");
});

test("validates only fully accepted, settled, clean plans with four current passed gates", () => {
  let projection = createRunningProjection();
  projection = bindAttempt(projection, "attempt-1");
  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded" });
  projection = acceptedTask(projection);
  projection = passedGates(projection);

  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: false }), /worktree clean/);
  projection = apply(projection, "plan.validated", { worktreeClean: true });
  assert.equal(projection.lifecycle, "validated");
  assert.equal(projection.validatedHead, workspace.headCommit);
});

test("fails closed when validation has nonterminal tasks, active attempts, missing gates, or nonpassed gates", () => {
  let projection = createRunningProjection();
  projection = bindAttempt(projection, "attempt-1");
  projection = apply(projection, "task.accepted", { taskId: "task-1" });
  projection = apply(projection, "gate.finished", {
    type: "deterministic", status: "passed", inputHead: workspace.headCommit,
    gateId: "deterministic-1", changeSetHash: "changes-1", evidence: [], findings: [],
  });
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /active attempt/);

  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded" });
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /missing gate/);

  for (const type of ["plan-audit", "external-review", "final-completeness"]) {
    projection = apply(projection, "gate.finished", {
      type,
      status: "passed",
      inputHead: workspace.headCommit,
      gateId: `${type}-1`, changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
    });
  }
  projection.tasks.set("task-2", { status: "running" });
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /not accepted/);
});

test("rejects validation when a current gate failed or was unavailable", () => {
  let projection = acceptedTask(createRunningProjection());
  for (const [type, status] of [
    ["deterministic", "passed"],
    ["plan-audit", "passed"],
    ["external-review", "failed"],
    ["final-completeness", "unavailable"],
  ]) {
    projection = apply(projection, "gate.finished", {
      type, status, inputHead: workspace.headCommit,
      gateId: `${type}-1`, changeSetHash: "changes-1", evidence: [{ command: "true" }], findings: [],
    });
  }
  assert.throws(() => apply(projection, "plan.validated", { worktreeClean: true }), /gate did not pass/);
});

test("moves a running plan into explicit terminal lifecycle states only", () => {
  for (const type of ["plan.blocked", "plan.cancelled", "plan.interrupted"]) {
    let projection = createRunningProjection();
    projection = bindAttempt(projection, `${type}-attempt`);
    projection = apply(projection, "attempt.settled", { attemptId: `${type}-attempt`, outcome: "succeeded" });
    projection = apply(projection, type, {});
    assert.equal(projection.lifecycle, type.slice(5));
    assert.throws(() => apply(projection, "plan.cancelled", {}), /terminal/);
  }
});
