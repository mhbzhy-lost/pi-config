import assert from "node:assert/strict";
import test from "node:test";
import { runnableFrontier, validateDAG, goalProgress } from "../scripts/lib/goal-engine/graph.mjs";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";

function makeEvent(type, data, goalId = "dag-test") {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function taskDef(description, deps = []) {
  return { description, deps, writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" };
}

function buildProjection(taskDefs) {
  const ids = Object.keys(taskDefs);
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "DAG test", scope: [], nonGoals: [], dod: [],
    tasks: ids, taskDefs,
  }));
  return p;
}

test("validateDAG rejects cycle", () => {
  assert.throws(
    () => validateDAG(new Map([
      ["a", { deps: ["b"] }],
      ["b", { deps: ["a"] }],
    ])),
    /cycle/,
  );
});

test("validateDAG rejects missing dep", () => {
  assert.throws(
    () => validateDAG(new Map([["a", { deps: ["nonexistent"] }]])),
    /unknown dep/,
  );
});

test("runnableFrontier returns tasks with all deps accepted", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b", ["t1"]),
    t3: taskDef("c"),
  });

  let frontier = runnableFrontier(p);
  assert.deepEqual(frontier.sort(), ["t1", "t3"]);

  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "x" }, nextAction: "Accept t1 and then dispatch t2 for the implementation phase" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  frontier = runnableFrontier(p);
  assert.deepEqual(frontier.sort(), ["t2", "t3"]);
});

test("runnableFrontier excludes dispatched/succeeded/blocked tasks", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b"),
  });
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));

  const frontier = runnableFrontier(p);
  assert.deepEqual(frontier, ["t2"]);
});

test("goalProgress returns counts", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b"),
    t3: taskDef("c"),
  });
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "x" }, nextAction: "Accept t1 and then move to the remaining task in queue" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  const progress = goalProgress(p);
  assert.equal(progress.total, 3);
  assert.equal(progress.accepted, 1);
  assert.equal(progress.pending, 2);
});
