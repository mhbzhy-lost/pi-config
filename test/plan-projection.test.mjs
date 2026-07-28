import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanStatus, writePlanStatus } from "../scripts/lib/plan/plan-projection.mjs";

const workspace = { originRoot: "/repo", worktree: "/worktree", baseCommit: "base", headCommit: "head", planPath: "/repo/docs/plan.md", planHash: "a".repeat(64) };

function event(type, data = {}) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: crypto.randomUUID(),
    planId: "plan-8",
    occurredAt: "2026-07-15T00:00:00.000Z",
    type,
    data,
  };
}

test("replays append-only plan entries into a stable JSON status projection with artifact references", () => {
  const status = createPlanStatus({
    entries: [
      event("plan.created", { workspace, tasks: ["task-1"] }),
      event("attempt.workspace-allocated", {
        attemptId: "attempt-1",
        taskId: "task-1",
        baseCommit: "head",
        workspace: { path: "/attempts/attempt-1", branch: "pi-plan-attempt/plan-8/task-1/1", ownerToken: "owner-1" },
      }),
      event("attempt.dispatch-requested", {
        attemptId: "attempt-1",
        taskId: "task-1",
        dispatchId: "dispatch-1",
        baseCommit: "head",
        workspace: { path: "/attempts/attempt-1", branch: "pi-plan-attempt/plan-8/task-1/1", ownerToken: "owner-1" },
        tool: { agent: "executor", task: "prompt", cwd: "/attempts/attempt-1", context: "fresh", async: true, clarify: false, worktree: false },
        toolHash: "tool-hash",
      }),
      event("attempt.bound", {
        attemptId: "attempt-1",
        taskId: "task-1",
        dispatchId: "dispatch-1",
        runId: "run-1",
        asyncDir: "/known/async-dir",
        sessionFile: "/sessions/worker.jsonl",
      }),
    ],
    artifacts: new Map([["attempt-1", {
      artifactDir: "/known/async-dir",
      status: { kind: "stable", value: { runId: "run-1", sessionId: "uuid", state: "running" } },
      results: [],
    }]]),
  });

  assert.deepEqual(status, {
    schemaVersion: "pi-plan-status.v1",
    derived: true,
    planId: "plan-8",
    lifecycle: "running",
    projectionVersion: 4,
    headCommit: "head",
    validatedHead: null,
    tasks: [{ taskId: "task-1", status: "pending", attempts: [{
      attemptId: "attempt-1",
      status: "active",
      dispatchId: "dispatch-1",
      baseCommit: "head",
      workspace: { path: "/attempts/attempt-1", branch: "pi-plan-attempt/plan-8/task-1/1" },
      runId: "run-1",
      attention: null,
      resultCommit: null,
      workspaceReleased: false,
      workspaceDisposition: null,
      artifacts: {
        artifactDir: "/known/async-dir",
        status: { kind: "stable", value: { runId: "run-1", sessionId: "uuid", state: "running" } },
        results: [],
      },
    }] }],
    gates: [],
  });
});

test("redacts attention messages while preserving fencing and evidence references", () => {
  const secret = "sensitive supervisor question";
  const status = createPlanStatus({
    entries: [
      event("plan.created", { workspace, tasks: ["task-1"] }),
      event("attempt.workspace-allocated", {
        attemptId: "attempt-1", taskId: "task-1", baseCommit: "head",
        workspace: { path: "/attempts/attempt-1", branch: "attempt/1", ownerToken: "owner-1" },
      }),
      event("attempt.dispatch-requested", {
        attemptId: "attempt-1", taskId: "task-1", dispatchId: "dispatch-1", baseCommit: "head",
        workspace: { path: "/attempts/attempt-1", branch: "attempt/1", ownerToken: "owner-1" },
        tool: { agent: "executor", task: "prompt", cwd: "/attempts/attempt-1", context: "fresh", async: true, clarify: false, worktree: false },
        toolHash: "tool-hash",
      }),
      event("attempt.bound", {
        attemptId: "attempt-1", taskId: "task-1", dispatchId: "dispatch-1", runId: "run-1",
        asyncDir: "/async/run-1", sessionFile: "/sessions/run-1.jsonl",
      }),
      event("attempt.attention-requested", {
        requestId: "request-1", taskId: "task-1", attemptId: "attempt-1", runId: "run-1",
        kind: "need_decision", message: secret, projectionVersion: 5,
        createdAt: "2026-07-26T00:00:01.000Z",
        evidence: { bodyPath: "attention/request-1.md", bodySha256: "b".repeat(64) },
      }),
    ],
  });

  assert.equal(status.projectionVersion, 5);
  assert.equal(status.tasks[0].attempts[0].status, "waiting-attention");
  assert.deepEqual(status.tasks[0].attempts[0].attention, {
    requestId: "request-1",
    kind: "need_decision",
    blocking: true,
    status: "pending",
    messageSha256: "d6ddffde5e887df0c7b030af199c3697622418a5ffe5bae6329fc6e7518db766",
    projectionVersion: 5,
    createdAt: "2026-07-26T00:00:01.000Z",
    evidence: { bodyPath: "attention/request-1.md", bodySha256: "b".repeat(64) },
  });
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(JSON.stringify(status).includes("/sessions/run-1.jsonl"), false);
});

test("projects a validated blocked disposition into the derived status", () => {
  const attemptId = "attempt-1";
  const attempt = {
    attemptId,
    taskId: "task-1",
    baseCommit: "head",
    workspace: { path: "/attempts/attempt-1", branch: "attempt/1", ownerToken: "owner-1" },
  };
  const status = createPlanStatus({
    entries: [
      event("plan.created", { workspace, tasks: ["task-1"] }),
      event("attempt.workspace-allocated", attempt),
      event("attempt.dispatch-requested", {
        ...attempt,
        dispatchId: "dispatch-1",
        tool: { agent: "executor", task: "prompt", cwd: attempt.workspace.path, context: "fresh", async: true, clarify: false, worktree: false },
        toolHash: "tool-hash",
      }),
      event("attempt.bound", {
        attemptId,
        taskId: "task-1",
        dispatchId: "dispatch-1",
        runId: "run-1",
        asyncDir: "/async/run-1",
        sessionFile: "/sessions/run-1.jsonl",
      }),
      event("attempt.settled", {
        attemptId,
        outcome: "blocked",
        blockerReason: "real-module-candidates-not-ready",
        blockers: ["cocoapods", "tbctx7_code_auth"],
        evidenceSha256: "a".repeat(64),
      }),
      event("plan.blocked", { reason: "executor_blocked" }),
    ],
  });

  assert.equal(status.lifecycle, "blocked");
  assert.deepEqual(status.tasks[0].attempts[0].blocked, {
    reason: "real-module-candidates-not-ready",
    blockers: ["cocoapods", "tbctx7_code_auth"],
    evidenceSha256: "a".repeat(64),
  });
});

test("writes the derived status through an atomic replacement under the plan run directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-projection-"));
  try {
    const status = createPlanStatus({ entries: [event("plan.created", { workspace, tasks: ["task-1"] })] });
    const outputFile = await writePlanStatus({ stateRoot: root, status });

    assert.equal(outputFile, path.join(root, "var", "plan-runs", "plan-8", "status.json"));
    assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), status);
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(outputFile))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a plan id that escapes the plan-runs directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-projection-"));
  try {
    await assert.rejects(
      writePlanStatus({ stateRoot: root, status: { planId: "../escape", derived: true } }),
      /planId|escape/i,
    );
    await assert.rejects(access(path.join(root, "var", "escape", "status.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
