import assert from "node:assert/strict";
import test from "node:test";

import { createPlanGraph, nextRunnableTask } from "../scripts/lib/plan/plan-graph.mjs";

const plan = (tasks) => ({ tasks });

test("createPlanGraph rejects cyclic dependencies", () => {
  assert.throws(() => createPlanGraph(plan([
    { id: "task-1", deps: ["task-2"] },
    { id: "task-2", deps: ["task-1"] },
  ])), /cycle.*task-1/i);
});

test("nextRunnableTask returns only the earliest pending task whose deps are accepted", () => {
  const graph = createPlanGraph(plan([
    { id: "task-1", deps: [] },
    { id: "task-2", deps: ["task-1"] },
    { id: "task-3", deps: [] },
  ]));

  assert.equal(nextRunnableTask({ graph, tasks: new Map([["task-1", { status: "pending" }], ["task-2", { status: "pending" }], ["task-3", { status: "pending" }]]) }).id, "task-1");
  assert.equal(nextRunnableTask({ graph, tasks: new Map([["task-1", { status: "accepted" }], ["task-2", { status: "pending" }], ["task-3", { status: "pending" }]]) }).id, "task-2");
});

test("nextRunnableTask returns undefined when no pending task has accepted dependencies", () => {
  const graph = createPlanGraph(plan([{ id: "task-1", deps: ["task-2"] }, { id: "task-2", deps: [] }]));

  assert.equal(nextRunnableTask({ graph, tasks: new Map([["task-1", { status: "pending" }], ["task-2", { status: "running" }]]) }), undefined);
});
