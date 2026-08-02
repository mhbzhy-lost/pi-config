import assert from "node:assert/strict";
import test from "node:test";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, loadProjection, listGoals } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeEvent(type, data, goalId = "test-goal", schemaVersion = "goal-engine.event.v1", occurredAt = new Date().toISOString()) {
  return { schemaVersion, eventId: crypto.randomUUID(), goalId, type, occurredAt, data };
}

function created(goalId = "test-goal", schemaVersion = "goal-engine.event.v1") {
  return makeEvent("goal.created", { objective: "Workspace test", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } } }, goalId, schemaVersion);
}

function v2(type, data, goalId = "test-goal", occurredAt) {
  return makeEvent(type, data, goalId, "goal-engine.event.v2", occurredAt);
}

function dispatchV2(p) {
  return applyEvent(p, v2("task.dispatched", { taskId: "t1", contractHash: "h1", workspace: { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc" } }));
}

function succeed(p, schemaVersion = "goal-engine.event.v2") {
  return applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria" }, "test-goal", schemaVersion, "2026-01-02T03:04:05.000Z"));
}

test("goal.created initializes workspace and acceptance verification", () => {
  const p = applyEvent(createProjection(), created());
  assert.equal(p.tasks.get("t1").workspace, null);
  assert.equal(p.tasks.get("t1").acceptanceVerification, null);
});

test("goal.amended initializes workspace and acceptance verification", () => {
  let p = applyEvent(createProjection(), created());
  p = applyEvent(p, makeEvent("goal.amended", { reason: "Add a necessary implementation task to cover the new requirement", addTasks: { t2: { description: "more work", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] } } } }));
  assert.equal(p.tasks.get("t2").workspace, null);
  assert.equal(p.tasks.get("t2").acceptanceVerification, null);
});

test("v2 dispatched requires workspace and initializes active workspace", () => {
  let p = applyEvent(createProjection(), created("test-goal", "goal-engine.event.v2"));
  assert.throws(() => applyEvent(p, v2("task.dispatched", { taskId: "t1", contractHash: "h1" })), /workspace/);
  p = dispatchV2(p);
  assert.deepEqual(p.tasks.get("t1").workspace, { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc", phase: "active" });
  assert.throws(() => applyEvent(p, v2("task.workspace_disposition_started", { taskId: "t1", attempt: 2, requestedAction: "integrate", strategy: "merge", executorHead: "e", originHeadBefore: "o" })), /attempt/);
});

test("v2 disposition enforces three phases, attempt, and action", () => {
  let p = dispatchV2(applyEvent(createProjection(), created("test-goal", "goal-engine.event.v2")));
  const started = { taskId: "t1", attempt: 1, requestedAction: "integrate", strategy: "merge", executorHead: "e", originHeadBefore: "o" };
  assert.throws(() => applyEvent(p, v2("task.workspace_disposition_applied", { ...started, action: "integrate", originHead: "o2" })), /disposing/);
  p = applyEvent(p, v2("task.workspace_disposition_started", started));
  assert.equal(p.tasks.get("t1").workspace.phase, "disposing");
  assert.throws(() => applyEvent(p, v2("task.workspace_disposition_started", started)), /already started|phase/);
  assert.throws(() => applyEvent(p, v2("task.workspace_disposition_applied", { ...started, action: "discard", originHead: "o2" })), /action/);
  p = applyEvent(p, v2("task.workspace_disposition_applied", { ...started, action: "integrate", strategy: "merge", executorHead: "e2", originHead: "o2" }));
  assert.equal(p.tasks.get("t1").workspace.phase, "applied");
  assert.throws(() => applyEvent(p, v2("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "integrate", released: false })), /released/);
  p = applyEvent(p, v2("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "integrate", released: true }));
  assert.equal(p.tasks.get("t1").workspace.disposition, "integrated");
  assert.equal(p.tasks.get("t1").workspace.phase, "disposed");
});

test("v2 accept is rejected until integrated released workspace is disposed", () => {
  let p = succeed(dispatchV2(applyEvent(createProjection(), created("test-goal", "goal-engine.event.v2"))));
  assert.throws(() => applyEvent(p, v2("task.accepted", { taskId: "t1", workspaceAttempt: 1 })), /workspace.*disposed|integrated/i);
  const start = { taskId: "t1", attempt: 1, requestedAction: "integrate", strategy: "merge", executorHead: "e", originHeadBefore: "o" };
  p = applyEvent(p, v2("task.workspace_disposition_started", start));
  p = applyEvent(p, v2("task.workspace_disposition_applied", { ...start, action: "integrate", originHead: "o2" }));
  p = applyEvent(p, v2("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "integrate", released: true }));
  p = applyEvent(p, v2("task.accepted", { taskId: "t1", workspaceAttempt: 1 }));
  assert.equal(p.tasks.get("t1").acceptanceVerification, "integrated");
});

test("discarded resets succeeded task and preserved cannot be accepted", () => {
  for (const action of ["discard", "preserve"]) {
    let p = succeed(dispatchV2(applyEvent(createProjection(), created("test-goal", "goal-engine.event.v2"))));
    const start = { taskId: "t1", attempt: 1, requestedAction: action, strategy: "x", executorHead: "e", originHeadBefore: "o" };
    p = applyEvent(p, v2("task.workspace_disposition_started", start));
    p = applyEvent(p, v2("task.workspace_disposition_applied", { ...start, action, originHead: "o2" }));
    p = applyEvent(p, v2("task.workspace_disposed", { taskId: "t1", attempt: 1, action, released: action === "discard" }));
    if (action === "discard") assert.equal(p.tasks.get("t1").status, "pending");
    else assert.throws(() => applyEvent(p, v2("task.accepted", { taskId: "t1", workspaceAttempt: 1 })), /integrated/);
  }
});

test("legacy v1 accepted remains replayable and explicitly unverified", () => {
  let p = applyEvent(createProjection(), created());
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = succeed(p, "goal-engine.event.v1");
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));
  assert.equal(p.tasks.get("t1").acceptanceVerification, "legacy_unverified");
});

test("settled evidence timestamps are deterministic and store round-trips workspace fields", () => {
  const events = [created("store-goal", "goal-engine.event.v2"), v2("task.dispatched", { taskId: "t1", contractHash: "h1", workspace: { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc" } }, "store-goal", "2026-01-01T00:00:00.000Z"), makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria" }, "store-goal", "goal-engine.event.v2", "2026-01-02T03:04:05.000Z")];
  const replay = () => events.reduce(applyEvent, createProjection());
  assert.deepEqual(replay(), replay());
  assert.equal(replay().tasks.get("t1").evidence[0].ts, "2026-01-02T03:04:05.000Z");
  const root = tmpRoot(); let version = 0;
  for (const event of events) { appendEvent(root, event, version++); }
  const serialized = JSON.parse(readFileSync(join(root, "goals/store-goal/projection.json"), "utf8"));
  assert.equal(serialized.tasks.t1.workspace.phase, "active");
  assert.equal(loadProjection(root, "store-goal").tasks.get("t1").workspace.path, "/tmp/work");
});

function tmpRoot() { return mkdtempSync(join(tmpdir(), "ge-store-")); }
test("appendEvent writes events.jsonl and projection.json", () => { const root = tmpRoot(); const proj = appendEvent(root, created("store-goal"), 0); assert.ok(existsSync(join(root, "goals/store-goal/events.jsonl"))); assert.equal(proj.version, 1); });
test("listGoals returns active goal ids", () => { const root = tmpRoot(); appendEvent(root, created("list-goal"), 0); assert.deepEqual(listGoals(root), ["list-goal"]); });
