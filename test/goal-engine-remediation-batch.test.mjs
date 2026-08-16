import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, appendEventBatch } from "../scripts/lib/goal-engine/store.mjs";
import { remediationSubjectHash, taskContractHash } from "../scripts/lib/goal-engine/task-definition.mjs";
import { validateRemediationTask } from "../scripts/lib/goal-engine/repair-policy.mjs";

const task = { description: "Repair", deps: [], writePaths: ["src/**"], acceptance: { criteria: [{ id: "repair", statement: "Repair passes", evidenceKinds: ["tests"] }] }, workflow: "tdd" };
function event(type, data, n) { return { schemaVersion: "goal-runtime.v1", eventId: `batch-${n}`, goalId: "runtime-goal", occurredAt: "2026-08-13T00:00:00.000Z", type, data }; }
function clone(value) { return structuredClone(value); }
function plan({ approved = false, actionPrefix = false } = {}) {
  const metadata = { kind: "remediation", goalId: "runtime-goal", executionRevision: 1, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], subjectHash: remediationSubjectHash({ goalId: "runtime-goal", executionRevision: 1, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], task }), taskDefHash: taskContractHash(task) };
  const taskDef = { ...task, metadata };
  const amendment = event("goal.amended", { addTasks: { "repair-task-1": taskDef }, removeTasks: [], updateTasks: {}, reason: "Materialize canonical remediation task", hostInternalRemediation: true }, 1);
  const link = event("repair.task_linked", { episodeId: "episode-1", taskId: "repair-task-1", challengeId: approved ? "challenge-1" : null }, 3);
  const events = approved
    ? [amendment, event("repair.capability_consumed", { nonceDigest: "a".repeat(64), consumedAt: 1, challengeId: "challenge-1", episodeId: "episode-1", action: "authorize_task", subjectHash: metadata.subjectHash, sessionId: "session-1", userEntryId: "entry-1", decisionId: "b".repeat(64), executionRevision: 1, executionContractHash: "c".repeat(64), baseHead: "d".repeat(40), taskId: "repair-task-1", taskDefHash: metadata.taskDefHash, userEntryHash: "e".repeat(64), branchBindingHash: "f".repeat(64) }, 2), link]
    : [amendment, link];
  return actionPrefix ? [event("goal.action_consumed", { offerId: "offer-1", token: "token-1", tool: "goal", sessionId: "session-1" }, 0), ...events] : events;
}
function assertNoWrite(events) {
  const root = mkdtempSync(join(tmpdir(), "goal-remediation-batch-"));
  try {
    assert.throws(() => appendEventBatch(root, events, 0), /remediation|batch|added task|binding/i);
    assert.equal(existsSync(join(root, "goals")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("store accepts only canonical autonomous and user-approved remediation batches before reducer replay", () => {
  for (const options of [{}, { approved: true }]) {
    const root = mkdtempSync(join(tmpdir(), "goal-remediation-batch-"));
    try { assert.throws(() => appendEventBatch(root, plan(options), 0), /goal.created must be first/); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("store passes canonical remediation without optional deps to reducer validation", () => {
  const projection = {
    goalId: "runtime-goal", executionRevision: 1,
    writePolicy: { allowedPaths: ["src/**"] },
    conditions: new Map([["condition-1", { definition: { remediation: { policy: "autonomous", allowed_paths: ["src/**"] } } }]]),
    findings: new Map(), repairEpisodes: new Map([["episode-1", { episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], remediationTaskIds: [], status: "active" }]]),
    repairChallenges: new Map(), tasks: new Map(), observationRuns: new Map(), evidenceHistory: [],
  };
  const plan = validateRemediationTask({
    projection, episodeId: "episode-1", findingIds: ["finding-1"],
    taskDef: { description: "Repair", writePaths: ["src/**"], acceptance: { criteria: [{ id: "repair", statement: "Repair passes", evidenceKinds: ["tests"] }] }, workflow: "tdd" },
  });
  assert.equal(Object.hasOwn(plan.taskDef, "deps"), false);
  const root = mkdtempSync(join(tmpdir(), "goal-remediation-batch-"));
  try { assert.throws(() => appendEventBatch(root, plan.events.map((entry, index) => event(entry.type, entry.data, index + 1)), 0), /goal.created must be first/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("store rejects split or standalone authorize_task consumption before any write", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-remediation-batch-"));
  try {
    assert.throws(() => appendEvent(root, plan()[0], 0), /batch/);
    assert.throws(() => appendEventBatch(root, plan({ approved: true }).slice(1, 2), 0), /canonical remediation batch/);
    assert.equal(existsSync(join(root, "goals")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("store rejects every malformed Host remediation batch before any goals write", () => {
  const cases = [
    ["reordered", () => { const [amendment, link] = plan(); return [link, amendment]; }],
    ["missing link", () => plan().slice(0, 1)],
    ["extra event", () => [...plan(), event("task.accepted", { taskId: "repair-task-1" }, 4)]],
    ["second amendment", () => [...plan(), clone(plan()[0])]],
    ["multiple additions", () => { const events = plan(); events[0].data.addTasks.second = clone(events[0].data.addTasks["repair-task-1"]); return events; }],
    ["task removal", () => { const events = plan(); events[0].data.removeTasks = ["other-task"]; return events; }],
    ["task update", () => { const events = plan(); events[0].data.updateTasks = { "other-task": {} }; return events; }],
    ["extra amendment data", () => { const events = plan(); events[0].data.extra = true; return events; }],
    ["extra task data", () => { const events = plan(); events[0].data.addTasks["repair-task-1"].extra = true; return events; }],
    ["missing required workflow", () => { const events = plan(); delete events[0].data.addTasks["repair-task-1"].workflow; return events; }],
    ["commands are not criteria-only", () => { const events = plan(); events[0].data.addTasks["repair-task-1"].acceptance.commands = ["npm test"]; return events; }],
    ["extra metadata", () => { const events = plan(); events[0].data.addTasks["repair-task-1"].metadata.extra = true; return events; }],
    ["task drift", () => { const events = plan(); events[1].data.taskId = "other-task"; return events; }],
    ["episode drift", () => { const events = plan({ approved: true }); events[1].data.episodeId = "other-episode"; return events; }],
    ["condition drift", () => { const events = plan(); events[0].data.addTasks["repair-task-1"].metadata.conditionId = "other-condition"; return events; }],
    ["finding drift", () => { const events = plan(); events[0].data.addTasks["repair-task-1"].metadata.findingIds = ["other-finding"]; return events; }],
    ["subject drift", () => { const events = plan({ approved: true }); events[1].data.subjectHash = "b".repeat(64); return events; }],
    ["challenge drift", () => { const events = plan({ approved: true }); events[2].data.challengeId = "other-challenge"; return events; }],
    ["task definition hash drift", () => { const events = plan(); events[0].data.addTasks["repair-task-1"].metadata.taskDefHash = "b".repeat(64); return events; }],
    ["extra link data", () => { const events = plan(); events[1].data.extra = true; return events; }],
    ["extra consume data", () => { const events = plan({ approved: true }); events[1].data.extra = true; return events; }],
  ];
  for (const [name, malformed] of cases) assertNoWrite(malformed(), name);
});
