import assert from "node:assert/strict";
import test from "node:test";

import { createPlanEventWriter } from "../scripts/lib/plan/plan-event-writer.mjs";

const workspace = { originRoot: "/repo", worktree: "/work", baseCommit: "base", headCommit: "base", planPath: "/repo/plan.md", planHash: "a".repeat(64) };
function created() { return { schemaVersion: "pi-plan-event.v1", eventId: "created", planId: "plan-1", occurredAt: "2026-01-01T00:00:00.000Z", type: "plan.created", data: { workspace, tasks: ["task-1"] } }; }
function writer(entries, append = async (entry) => entries.push(entry)) {
  let index = 0;
  return createPlanEventWriter({ readEntries: async () => entries, append, id: () => `event-${++index}`, now: () => "2026-01-01T00:00:01.000Z" });
}

test("serializes concurrent same-version submissions", async () => {
  const entries = [created()]; const subject = writer(entries);
  const results = await Promise.allSettled([
    subject.append({ expectedProjectionVersion: 1, planId: "plan-1", type: "task.accepted", data: { taskId: "task-1" } }),
    subject.append({ expectedProjectionVersion: 1, planId: "plan-1", type: "plan.blocked", data: { reason: "blocked" } }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(entries.length, 2);
});

test("rejects stale, reducer-invalid, and terminal writes before append", async () => {
  const entries = [created()]; const appended = []; const subject = writer(entries, async (entry) => { appended.push(entry); entries.push(entry); });
  await assert.rejects(subject.append({ expectedProjectionVersion: 0, planId: "plan-1", type: "task.accepted", data: { taskId: "task-1" } }), /version/i);
  await assert.rejects(subject.append({ expectedProjectionVersion: 1, planId: "plan-1", type: "attempt.bound", data: {} }), /attempt|invalid/i);
  await subject.append({ expectedProjectionVersion: 1, planId: "plan-1", type: "plan.blocked", data: { reason: "blocked" } });
  await assert.rejects(subject.append({ expectedProjectionVersion: 2, planId: "plan-1", type: "task.accepted", data: { taskId: "task-1" } }), /terminal/i);
  assert.equal(appended.length, 1);
});

test("recovers queue after append failure", async () => {
  const entries = [created()]; let failures = 1;
  const subject = writer(entries, async (entry) => { if (failures--) throw new Error("disk failed"); entries.push(entry); });
  await assert.rejects(subject.append({ expectedProjectionVersion: 1, planId: "plan-1", type: "task.accepted", data: { taskId: "task-1" } }), /disk failed/);
  await subject.append({ expectedProjectionVersion: 1, planId: "plan-1", type: "task.accepted", data: { taskId: "task-1" } });
  assert.equal(entries.length, 2);
});
