import assert from "node:assert/strict";
import test from "node:test";
import * as graph from "../scripts/lib/goal-engine/graph.mjs";
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

function taskState(overrides = {}) {
  return {
    description: "work",
    deps: [],
    writePaths: ["src/x.ts"],
    acceptance: { criteria: ["works"], commands: ["true"] },
    workflow: "tdd",
    status: "pending",
    evidence: [],
    attempts: 0,
    lastSettledOutcome: null,
    contractHash: null,
    workspace: null,
    acceptanceVerification: null,
    ...overrides,
  };
}

function projectionState(tasks, { lifecycle = "active" } = {}) {
  return {
    goalId: "matrix-red-goal",
    version: 1,
    lifecycle,
    objective: "Matrix",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: new Map(Object.entries(tasks)),
    eventIds: new Set(),
    checkpointCount: 0,
    completionVerdict: null,
    blockedReason: null,
    nextAction: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    eventSchemaVersion: "goal-engine.event.v2",
  };
}

function assertActionCase(actual, expected, label = "") {
  assert.deepEqual(actual.allowedActions, expected.allowedActions, `${label}: allowedActions`);

  if (expected.requiredNextAction === null) {
    assert.equal(actual.requiredNextAction, null, `${label}: requiredNextAction`);
  } else {
    assert.equal(actual.requiredNextAction.tool, expected.requiredNextAction.tool, `${label}: requiredNextAction.tool`);
    assert.deepEqual(actual.requiredNextAction.params, expected.requiredNextAction.params, `${label}: requiredNextAction.params`);
    assert.equal(typeof actual.requiredNextAction.reason, "string", `${label}: requiredNextAction.reason type`);
    assert.ok(actual.requiredNextAction.reason.length > 0, `${label}: requiredNextAction.reason not empty`);
  }

  assert.equal(actual.blockingReason, expected.blockingReason, `${label}: blockingReason`);
}


test("validateDAG rejects cycle", () => {
  assert.throws(
    () => graph.validateDAG(new Map([
      ["a", { deps: ["b"] }],
      ["b", { deps: ["a"] }],
    ])),
    /cycle/,
  );
});

test("validateDAG rejects missing dep", () => {
  assert.throws(
    () => graph.validateDAG(new Map([["a", { deps: ["nonexistent"] }]])),
    /unknown dep/,
  );
});

test("runnableFrontier returns tasks with all deps accepted", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b", ["t1"]),
    t3: taskDef("c"),
  });

  let frontier = graph.runnableFrontier(p);
  assert.deepEqual(frontier.sort(), ["t1", "t3"]);

  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "x" }, nextAction: "Accept t1 and then dispatch t2 for the implementation phase" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  frontier = graph.runnableFrontier(p);
  assert.deepEqual(frontier.sort(), ["t2", "t3"]);
});

test("runnableFrontier excludes dispatched/succeeded/blocked tasks", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b"),
  });
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));

  const frontier = graph.runnableFrontier(p);
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

  const progress = graph.goalProgress(p);
  assert.equal(progress.total, 3);
  assert.equal(progress.accepted, 1);
  assert.equal(progress.pending, 2);
});

test("taskActionState returns action matrix for matrix states", () => {
  const cases = [
    {
      label: "runnable pending",
      projection: projectionState({
        task: taskState({ status: "pending" }),
      }),
      expected: {
        allowedActions: ["goal_dispatch"],
        requiredNextAction: { tool: "goal_dispatch", params: { task_id: "task" } },
        blockingReason: null,
      },
    },
    {
      label: "dispatched",
      projection: projectionState({
        task: taskState({ status: "dispatched" }),
      }),
      expected: {
        allowedActions: ["goal_settle"],
        requiredNextAction: { tool: "goal_settle", params: { task_id: "task" } },
        blockingReason: null,
      },
    },
    {
      label: "succeeded active",
      projection: projectionState({
        task: taskState({ status: "succeeded", workspace: { phase: "active", attempt: 1 } }),
      }),
      expected: {
        allowedActions: ["goal_integrate"],
        requiredNextAction: { tool: "goal_integrate", params: { task_id: "task", action: "integrate" } },
        blockingReason: null,
      },
    },
    {
      label: "disposing",
      projection: projectionState({
        task: taskState({ status: "succeeded", workspace: { phase: "disposing", requestedAction: "discard", strategy: "merge", attempt: 1 } }),
      }),
      expected: {
        allowedActions: ["goal_integrate"],
        requiredNextAction: { tool: "goal_integrate", params: { task_id: "task", action: "discard", strategy: "merge" } },
        blockingReason: null,
      },
    },
    {
      label: "applied",
      projection: projectionState({
        task: taskState({ status: "succeeded", workspace: { phase: "applied", requestedAction: "discard", strategy: "merge", disposition: "discarded", attempt: 1 } }),
      }),
      expected: {
        allowedActions: ["goal_integrate"],
        requiredNextAction: { tool: "goal_integrate", params: { task_id: "task", action: "discard", strategy: "merge" } },
        blockingReason: null,
      },
    },
    {
      label: "integrated released",
      projection: projectionState({
        task: taskState({ status: "succeeded", workspace: { phase: "disposed", disposition: "integrated", released: true, attempt: 1 } }),
      }),
      expected: {
        allowedActions: ["goal_accept"],
        requiredNextAction: { tool: "goal_accept", params: { task_id: "task" } },
        blockingReason: null,
      },
    },
    {
      label: "accepted",
      projection: projectionState({
        task: taskState({ status: "accepted", workspace: { phase: "disposed", disposition: "integrated", released: true, attempt: 1 } }),
      }),
      expected: {
        allowedActions: ["goal_accept"],
        requiredNextAction: { tool: "goal_accept", params: { task_id: "task" } },
        blockingReason: null,
      },
    },
    {
      label: "preserved",
      projection: projectionState({
        task: taskState({ status: "succeeded", workspace: { phase: "disposed", disposition: "preserved", released: false, attempt: 1, requestedAction: "preserve", strategy: "merge" } }),
      }),
      expected: {
        allowedActions: ["goal_amend"],
        requiredNextAction: { tool: "goal_amend", params: { task_id: "task" } },
        blockingReason: null,
      },
    },
  ];

  for (const { label, projection, expected } of cases) {
    const action = graph.taskActionState(projection, "task");
    assertActionCase(action, expected, label);
  }
});

test("pending task blocked by unaccepted dependencies has no allowed next action", () => {
  const projection = projectionState({
    dep: taskState({ status: "pending" }),
    task: taskState({ status: "pending", deps: ["dep"] }),
  });

  const action = graph.taskActionState(projection, "task");
  assertActionCase(action, {
    allowedActions: [],
    requiredNextAction: null,
    blockingReason: "task dependencies are not accepted: dep",
  });
});

test("failed settle pending + active workspace only allows goal_integrate discard", () => {
  const projection = projectionState({
    task: taskState({
      status: "pending",
      lastSettledOutcome: "failed",
      workspace: {
        phase: "active",
        attempt: 1,
      },
    }),
  });

  const action = graph.taskActionState(projection, "task");
  assertActionCase(action, {
    allowedActions: ["goal_integrate"],
    requiredNextAction: { tool: "goal_integrate", params: { task_id: "task", action: "discard" } },
    blockingReason: null,
  });
  assert.deepEqual(graph.runnableFrontier(projection), []);
});

test("blocked task requires workspace cleanup before amendment", () => {
  const active = projectionState({
    task: taskState({
      status: "blocked",
      lastSettledOutcome: "blocked",
      workspace: { phase: "active", attempt: 1 },
    }),
  });
  assertActionCase(graph.taskActionState(active, "task"), {
    allowedActions: ["goal_integrate"],
    requiredNextAction: { tool: "goal_integrate", params: { task_id: "task", action: "discard" } },
    blockingReason: null,
  });

  const cleaned = projectionState({
    task: taskState({
      status: "blocked",
      lastSettledOutcome: "blocked",
      workspace: { phase: "disposed", disposition: "discarded", released: true, attempt: 1 },
    }),
  });
  assertActionCase(graph.taskActionState(cleaned, "task"), {
    allowedActions: ["goal_amend"],
    requiredNextAction: { tool: "goal_amend", params: { task_id: "task" } },
    blockingReason: null,
  });
});

test("pending task only advertises dispatch for a redispatchable workspace", () => {
  const blockedWorkspaces = [
    { phase: "disposed", disposition: "integrated", released: true, attempt: 1 },
    { phase: "disposed", disposition: "discarded", released: false, attempt: 1 },
    { phase: "unknown", attempt: 1 },
  ];

  for (const workspace of blockedWorkspaces) {
    const projection = projectionState({ task: taskState({ status: "pending", workspace }) });
    const action = graph.taskActionState(projection, "task");
    assert.deepEqual(action.allowedActions, []);
    assert.equal(action.requiredNextAction, null);
    assert.match(action.blockingReason, /workspace.*not.*redispatch|workspace.*blocks.*dispatch/i);
    assert.deepEqual(graph.runnableFrontier(projection), []);
  }

  const redispatchable = projectionState({
    task: taskState({
      status: "pending",
      workspace: { phase: "disposed", disposition: "discarded", released: true, attempt: 1 },
    }),
  });
  assertActionCase(graph.taskActionState(redispatchable, "task"), {
    allowedActions: ["goal_dispatch"],
    requiredNextAction: { tool: "goal_dispatch", params: { task_id: "task" } },
    blockingReason: null,
  });
  assert.deepEqual(graph.runnableFrontier(redispatchable), ["task"]);
});

test("all accepted gives only the first Map task the final goal_accept action", () => {
  const projection = projectionState({
    first: taskState({ status: "accepted" }),
    second: taskState({ status: "accepted" }),
  });
  assertActionCase(graph.taskActionState(projection, "first"), {
    allowedActions: ["goal_accept"],
    requiredNextAction: { tool: "goal_accept", params: { task_id: "first" } },
    blockingReason: null,
  });
  assertActionCase(graph.taskActionState(projection, "second"), {
    allowedActions: [], requiredNextAction: null, blockingReason: null,
  });
});

test("terminal goal lifecycle makes every task non-runnable", () => {
  const cases = ["completed", "blocked", "cancelled"];

  for (const lifecycle of cases) {
    const projection = projectionState({
      pendingTask: taskState({ status: "pending" }),
      acceptedTask: taskState({ status: "accepted", workspace: { phase: "disposed", disposition: "integrated", released: true, attempt: 1 } }),
    }, { lifecycle });

    assert.deepEqual(graph.runnableFrontier(projection), [], `lifecycle=${lifecycle} runnable frontier`);
    for (const taskId of projection.tasks.keys()) {
      const action = graph.taskActionState(projection, taskId);
      assertActionCase(action, {
        allowedActions: [],
        requiredNextAction: null,
        blockingReason: null,
      }, `lifecycle=${lifecycle}, task=${taskId}`);
    }
  }
});
