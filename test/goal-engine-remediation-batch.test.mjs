import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, appendEventBatch } from "../scripts/lib/goal-engine/store.mjs";
import { remediationSubjectHash, taskContractHash } from "../scripts/lib/goal-engine/task-definition.mjs";

const task = { description: "Repair", deps: [], writePaths: ["src/**"], acceptance: { criteria: [{ id: "repair", statement: "Repair passes", evidenceKinds: ["tests"] }] }, workflow: "tdd" };
function event(type, data, n) { return { schemaVersion: "goal-runtime.v1", eventId: `batch-${n}`, goalId: "runtime-goal", occurredAt: "2026-08-13T00:00:00.000Z", type, data }; }
function plan() {
  const metadata = { kind: "remediation", goalId: "runtime-goal", executionRevision: 1, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], subjectHash: remediationSubjectHash({ goalId: "runtime-goal", executionRevision: 1, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], task }), taskDefHash: taskContractHash(task) };
  const taskDef = { ...task, metadata };
  return [event("goal.amended", { addTasks: { "repair-task-1": taskDef }, removeTasks: [], updateTasks: {}, reason: "Materialize canonical remediation task", hostInternalRemediation: true }, 1), event("repair.task_linked", { episodeId: "episode-1", taskId: "repair-task-1", challengeId: null }, 2)];
}
test("store rejects split remediation materialization before any write and accepts only canonical ordering", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-remediation-batch-"));
  try {
    const events = plan();
    assert.throws(() => appendEvent(root, events[0], 0), /batch/);
    assert.equal(existsSync(join(root, "goals")), false);
    assert.throws(() => appendEventBatch(root, [events[1], events[0]], 0), /batch/);
    // This reaches reducer validation (the goal has not yet been drafted), proving the store gate accepted the exact autonomous sequence.
    assert.throws(() => appendEventBatch(root, events, 0), /goal.created must be first/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
