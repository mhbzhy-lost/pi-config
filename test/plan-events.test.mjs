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

function dispatchTool(attemptId = "attempt-1") {
  return { agent: "executor", task: "prompt", cwd: `/attempts/${attemptId}`, context: "fresh", async: true, clarify: false, worktree: false };
}

function attemptWorkspace(attemptId) {
  return { path: `/attempts/${attemptId}`, branch: `pi-plan-attempt/plan-1/task-1/${attemptId}`, ownerToken: `${attemptId}-owner` };
}

function requestAttempt(projection, attemptId, taskId = "task-1") {
  const workspaceLease = attemptWorkspace(attemptId);
  projection = apply(projection, "attempt.workspace-allocated", {
    attemptId,
    taskId,
    baseCommit: workspace.headCommit,
    workspace: workspaceLease,
  });
  return apply(projection, "attempt.dispatch-requested", {
    attemptId,
    taskId,
    dispatchId: `${attemptId}-dispatch`,
    baseCommit: workspace.headCommit,
    workspace: workspaceLease,
    tool: dispatchTool(attemptId),
    toolHash: `${attemptId}-tool-hash`,
  });
}

function bindAttempt(projection, attemptId, taskId = "task-1") {
  projection = requestAttempt(projection, attemptId, taskId);
  return apply(projection, "attempt.bound", {
    attemptId,
    taskId,
    dispatchId: `${attemptId}-dispatch`,
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
    () => apply(projection, "attempt.bound", { attemptId: "attempt-1", taskId: "task-1", dispatchId: "attempt-1-dispatch" }),
    /not dispatch-requested/,
  );
  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded", resultCommit: "result-1" });
  assert.equal(projection.attempts.get("attempt-1").taskId, "task-1");
  assert.equal(projection.attempts.get("attempt-1").status, "succeeded");
  assert.equal(projection.attempts.get("attempt-1").runId, "attempt-1-run");
  assert.throws(
    () => apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "failed" }),
    /not active/,
  );
});

test("settles an explicitly blocked Attempt without inventing a result commit", () => {
  let projection = bindAttempt(createRunningProjection(), "attempt-1");

  projection = apply(projection, "attempt.settled", {
    attemptId: "attempt-1",
    outcome: "blocked",
    blockerReason: "real-module-candidates-not-ready",
    blockers: ["cocoapods", "tbctx7_code_auth"],
    evidenceSha256: "a".repeat(64),
  });

  assert.equal(projection.attempts.get("attempt-1").status, "blocked");
  assert.equal(projection.attempts.get("attempt-1").resultCommit, undefined);
  assert.equal(projection.attempts.get("attempt-1").blockerReason, "real-module-candidates-not-ready");
  assert.deepEqual(projection.attempts.get("attempt-1").blockers, ["cocoapods", "tbctx7_code_auth"]);
  assert.equal(projection.attempts.get("attempt-1").evidenceSha256, "a".repeat(64));
});

test("persists workspace ownership and exactly one dispatch intent before binding", () => {
  let projection = createRunningProjection();
  projection = apply(projection, "attempt.workspace-allocated", {
    attemptId: "attempt-1",
    taskId: "task-1",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
  });
  projection = apply(projection, "attempt.dispatch-requested", {
    attemptId: "attempt-1",
    taskId: "task-1",
    dispatchId: "attempt-1-dispatch",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "attempt-1-tool-hash",
  });
  assert.deepEqual(projection.attempts.get("attempt-1"), {
    taskId: "task-1",
    status: "dispatch-requested",
    dispatchId: "attempt-1-dispatch",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "attempt-1-tool-hash",
  });
  projection = apply(projection, "attempt.bound", {
    attemptId: "attempt-1",
    taskId: "task-1",
    dispatchId: "attempt-1-dispatch",
    runId: "run-1",
    asyncDir: "/async/1",
    sessionFile: "/sessions/one.jsonl",
  });
  assert.deepEqual(projection.attempts.get("attempt-1"), {
    taskId: "task-1",
    status: "active",
    dispatchId: "attempt-1-dispatch",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "attempt-1-tool-hash",
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
  // Different task can now have a parallel dispatch (task-level mutual exclusion)
  const parallel = requestAttempt(projection, "attempt-2", "task-2");
  assert.equal(parallel.attempts.get("attempt-2").taskId, "task-2");
  // Same task still rejected
  assert.throws(
    () => requestAttempt(projection, "attempt-3", "task-1"),
    /active attempt/,
  );
});

test("advances succeeded attempts through validation, integration, and workspace release", () => {
  let projection = bindAttempt(createRunningProjection(), "attempt-1");
  projection = apply(projection, "attempt.settled", {
    attemptId: "attempt-1",
    outcome: "succeeded",
    resultCommit: "result-commit",
  });
  projection = apply(projection, "attempt.validated", {
    attemptId: "attempt-1",
    resultCommit: "result-commit",
    validationHash: "validation-hash",
    diffSha256: "d".repeat(64),
    changedPaths: ["src/a.mjs"],
    evidence: [{ path: "evidence/validation.json", sha256: "e".repeat(64) }],
  });
  assert.equal(projection.attempts.get("attempt-1").status, "validated");
  assert.equal(projection.attempts.get("attempt-1").validationDiffSha256, "d".repeat(64));
  assert.deepEqual(projection.attempts.get("attempt-1").validationChangedPaths, ["src/a.mjs"]);
  projection = apply(projection, "integration.requested", {
    attemptId: "attempt-1",
    expectedHead: workspace.headCommit,
    resultCommit: "result-commit",
    diffSha256: "d".repeat(64),
  });
  projection = apply(projection, "integration.finished", {
    attemptId: "attempt-1",
    previousHead: workspace.headCommit,
    newHead: "integrated-head",
  });
  assert.equal(projection.attempts.get("attempt-1").status, "integrated");
  assert.equal(projection.attempts.get("attempt-1").resultCommit, "result-commit");
  assert.deepEqual(projection.tasks.get("task-1"), { status: "accepted" });
  projection = apply(projection, "attempt.workspace-released", {
    attemptId: "attempt-1",
    disposition: "integrated-cleanup",
    evidence: { path: "evidence/release.json", sha256: "r".repeat(64) },
  });
  assert.equal(projection.attempts.get("attempt-1").workspaceReleased, true);
});

test("rejects dispatch intents that do not match their allocated workspace", () => {
  let projection = createRunningProjection();
  projection = apply(projection, "attempt.workspace-allocated", {
    attemptId: "attempt-1",
    taskId: "task-1",
    baseCommit: workspace.headCommit,
    workspace: attemptWorkspace("attempt-1"),
  });
  assert.throws(() => apply(projection, "attempt.dispatch-requested", {
    attemptId: "attempt-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    baseCommit: "stale",
    workspace: attemptWorkspace("attempt-1"),
    tool: dispatchTool(),
    toolHash: "tool-hash",
  }), /baseCommit/);
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
  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded", resultCommit: "result-1" });
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

  projection = apply(projection, "attempt.settled", { attemptId: "attempt-1", outcome: "succeeded", resultCommit: "result-1" });
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
    projection = apply(projection, "attempt.settled", { attemptId: `${type}-attempt`, outcome: "succeeded", resultCommit: `${type}-result` });
    projection = apply(projection, type, {});
    assert.equal(projection.lifecycle, type.slice(5));
    assert.throws(() => apply(projection, "plan.cancelled", {}), /terminal/);
  }
});
