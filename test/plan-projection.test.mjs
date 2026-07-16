import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
      event("attempt.dispatch-requested", {
        attemptId: "attempt-1",
        taskId: "task-1",
        tool: { agent: "executor", task: "prompt", cwd: "/worktree", context: "fresh", async: true, clarify: false },
      }),
      event("attempt.bound", {
        attemptId: "attempt-1",
        taskId: "task-1",
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
    headCommit: "head",
    validatedHead: null,
    tasks: [{ taskId: "task-1", status: "pending", attempts: [{
      attemptId: "attempt-1",
      status: "active",
      artifacts: {
        artifactDir: "/known/async-dir",
        status: { kind: "stable", value: { runId: "run-1", sessionId: "uuid", state: "running" } },
        results: [],
      },
    }] }],
    gates: [],
  });
});

test("writes the derived status through an atomic replacement under the plan run directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-projection-"));
  try {
    const status = createPlanStatus({ entries: [event("plan.created", { workspace, tasks: ["task-1"] })] });
    const outputFile = await writePlanStatus({ stateRoot: root, status });

    assert.equal(outputFile, path.join(root, "var", "plan-runs", "plan-8", "status.json"));
    assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), status);
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
