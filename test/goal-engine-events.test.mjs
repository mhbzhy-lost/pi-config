import assert from "node:assert/strict";
import test from "node:test";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, loadProjection, listGoals } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeEvent(type, data, goalId = "test-goal") {
  return {
    schemaVersion: "goal-engine.event.v1",
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

test("v2 reducers have no ambient cwd dependency", () => {
  const source = readFileSync(new URL("../scripts/lib/goal-engine/events.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.cwd\s*\(/);
});

test("v2 create and amend reject pending tasks that cannot compile dispatch IR atomically", () => {
  const created = {
    objective: "Valid objective",
    scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } },
  };
  assert.throws(() => applyEvent(createProjection(), { ...makeEvent("goal.created", created, "g".repeat(160)), schemaVersion: "goal-engine.event.v2" }), /taskId.*160/);
  assert.equal(createProjection().tasks.size, 0);

  let p = applyEvent(createProjection(), { ...makeEvent("goal.created", created), schemaVersion: "goal-engine.event.v2" });
  const before = p;
  assert.throws(() => applyEvent(p, { ...makeEvent("goal.amended", {
    reason: "Add a task whose derived requirements exceed the dispatch limit",
    updateTasks: { t1: { acceptance: { criteria: Array.from({ length: 32 }, (_, i) => `criterion ${i}`), commands: ["true"] } } },
  }), schemaVersion: "goal-engine.event.v2" }), /requirements.*32/);
  assert.equal(p, before);
  assert.equal(p.tasks.get("t1").acceptance.criteria.length, 1);
});

test("createProjection returns empty state", () => {
  const p = createProjection();
  assert.equal(p.goalId, null);
  assert.equal(p.version, 0);
  assert.equal(p.lifecycle, null);
  assert.equal(p.tasks.size, 0);
});

test("goal.created initializes projection", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Build auth module",
    scope: ["src/auth/"],
    nonGoals: ["UI changes"],
    dod: ["All auth tests pass", "No hardcoded secrets"],
    tasks: ["task-001", "task-002"],
    taskDefs: {
      "task-001": {
        description: "Token validation",
        deps: [],
        writePaths: ["src/auth/token.ts"],
        acceptance: { criteria: ["Handles expiry"], commands: ["node --test test/token.test.mjs"] },
        workflow: "tdd",
      },
      "task-002": {
        description: "Session management",
        deps: ["task-001"],
        writePaths: ["src/auth/session.ts"],
        acceptance: { criteria: ["Session persists"], commands: ["node --test test/session.test.mjs"] },
        workflow: "tdd",
      },
    },
  }));

  assert.equal(p.goalId, "test-goal");
  assert.equal(p.lifecycle, "active");
  assert.equal(p.version, 1);
  assert.equal(p.objective, "Build auth module");
  assert.deepEqual(p.dod, ["All auth tests pass", "No hardcoded secrets"]);
  assert.equal(p.tasks.size, 2);
  assert.equal(p.tasks.get("task-001").status, "pending");
  assert.deepEqual(p.tasks.get("task-001").writePaths, ["src/auth/token.ts"]);
  assert.deepEqual(p.tasks.get("task-001").acceptance.commands, ["node --test test/token.test.mjs"]);
  assert.deepEqual(p.tasks.get("task-002").deps, ["task-001"]);
});

test("goal.created must be first event", () => {
  let p = createProjection();
  assert.throws(
    () => applyEvent(p, makeEvent("task.dispatched", { taskId: "x" })),
    /goal\.created must be first/,
  );
});

test("duplicate eventId is rejected", () => {
  let p = createProjection();
  const event = makeEvent("goal.created", {
    objective: "X", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  });
  p = applyEvent(p, event);
  assert.throws(() => applyEvent(p, event), /duplicate eventId/);
});

test("terminal lifecycle rejects further events", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "X", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "abc123" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, evidenceSource: "self_produced", nextAction: "Accept t1 and verify goal completion criteria are satisfied" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));
  p = applyEvent(p, makeEvent("goal.completed", { verdict: "DONE_WITHOUT_EXTERNAL_VERIFICATION" }));
  assert.throws(
    () => applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "x" })),
    /goal is terminal/,
  );
});

test("task lifecycle: pending → dispatched → succeeded → accepted", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Lifecycle test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["node --test test/x.test.mjs"] }, workflow: "tdd" } },
  }));

  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "sha256abc" }));
  assert.equal(p.tasks.get("t1").status, "dispatched");
  assert.equal(p.tasks.get("t1").attempts, 1);
  assert.equal(p.tasks.get("t1").contractHash, "sha256abc");

  p = applyEvent(p, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "self_produced",
    nextAction: "Accept t1 and verify all acceptance criteria are met",
  }));
  assert.equal(p.tasks.get("t1").status, "succeeded");
  assert.equal(p.tasks.get("t1").evidence.length, 1);

  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));
  assert.equal(p.tasks.get("t1").status, "accepted");
});

test("task.settled failed resets to pending for retry", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Retry test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "failed", nextAction: "Retry t1 with a different approach to fix the failing test case" }));
  assert.equal(p.tasks.get("t1").status, "pending");
  assert.equal(p.tasks.get("t1").attempts, 1);
  assert.equal(p.tasks.get("t1").lastSettledOutcome, "failed");
});

test("task.settled rejects vague nextAction", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Vague test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  assert.throws(
    () => applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "continue" })),
    /at least 20 characters|specific/i,
  );
});

test("task.settled rejects illegal evidence sources and external non-review atomically", () => {
  const dispatched = () => {
    let projection = createProjection();
    projection = applyEvent(projection, makeEvent("goal.created", {
      objective: "Evidence source validation", scope: [], nonGoals: [], dod: [],
      tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
    }));
    return applyEvent(projection, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  };
  const settle = (evidenceSource, evidence = { type: "file", path: "a.ts" }) => makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded", evidence, evidenceSource,
    nextAction: "Accept the task and verify all acceptance criteria are met",
  });
  for (const [source, evidence, pattern] of [
    ["unknown", undefined, /invalid evidence source/i],
    ["external", { type: "file", path: "a.ts" }, /external evidence source requires external_review/i],
  ]) {
    const projection = dispatched();
    const version = projection.version;
    assert.throws(() => applyEvent(projection, settle(source, evidence)), pattern);
    assert.equal(projection.version, version);
    assert.equal(projection.tasks.get("t1").status, "dispatched");
    assert.equal(projection.tasks.get("t1").evidence.length, 0);
  }
  const external = applyEvent(dispatched(), settle("external", { type: "external_review", ref: "review-42" }));
  assert.equal(external.tasks.get("t1").evidence[0].source, "external");
  const legacy = applyEvent(dispatched(), settle(undefined));
  assert.equal(legacy.tasks.get("t1").evidence[0].source, "self_produced");
});

test("task.settled rejects command-type evidence", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Cmd evidence test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  assert.throws(
    () => applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "command", ref: "npm test" }, nextAction: "Accept the task and verify goal completion criteria are met" })),
    /evidence type must be one of/i,
  );
});

test("goal.completed rejects when tasks not all accepted", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Gate test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1", "t2"],
    taskDefs: {
      t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
      t2: { description: "b", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
    },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Accept t1 and then dispatch t2 for implementation" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  assert.throws(
    () => applyEvent(p, makeEvent("goal.completed", { verdict: "COMPLETE" })),
    /task not accepted: t2/,
  );
});

test("goal.amended adds and removes tasks", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Amend test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1", "t2"],
    taskDefs: {
      t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
      t2: { description: "b", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
    },
  }));

  p = applyEvent(p, makeEvent("goal.amended", {
    reason: "User changed direction: t2 no longer needed, adding t3 for new requirement",
    removeTasks: ["t2"],
    addTasks: { t3: { description: "new work", deps: ["t1"], writePaths: ["c.ts"], acceptance: { criteria: ["z"], commands: ["true"] }, workflow: "tdd" } },
  }));

  assert.equal(p.tasks.has("t2"), false);
  assert.equal(p.tasks.has("t3"), true);
  assert.deepEqual(p.tasks.get("t3").deps, ["t1"]);
});

test("historical v1 JSONL remove add update replacement replays in candidate order", () => {
  const goalId = "fixed-remove-add-replay";
  const created = {
    schemaVersion: "goal-engine.event.v1", eventId: "remove-add-created", goalId,
    occurredAt: "2025-02-04T05:06:07.000Z", type: "goal.created",
    data: {
      objective: "Replay a historical task replacement", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
      taskDefs: { t1: { description: "original", deps: [], writePaths: ["original.ts"], acceptance: { criteria: ["original"], commands: ["true"] }, workflow: "tdd" } },
    },
  };
  const replacement = {
    reason: "Replay historical remove add update task replacement in order",
    removeTasks: ["t1"],
    addTasks: { t1: { description: "replacement", deps: [], writePaths: ["replacement.ts"], acceptance: { criteria: ["replacement"], commands: ["true"] }, workflow: "tdd" } },
    updateTasks: { t1: { description: "refined", writePaths: ["refined.ts"], acceptance: { criteria: ["refined"], commands: ["node --test test/refined.test.mjs"] } } },
  };
  const root = tmpRoot();
  appendEvent(root, created, 0);
  appendEvent(root, { schemaVersion: "goal-engine.event.v1", eventId: "remove-add-amended", goalId, occurredAt: "2025-02-04T05:06:08.000Z", type: "goal.amended", data: replacement }, 1);
  const replayed = loadProjection(root, goalId);
  assert.equal(replayed.version, 2);
  assert.equal(replayed.tasks.get("t1").description, "refined");
  assert.deepEqual(replayed.tasks.get("t1").writePaths, ["refined.ts"]);
  assert.deepEqual(replayed.tasks.get("t1").acceptance.criteria, ["refined"]);
});

test("v1 duplicate remove amendments reject atomically in the store", () => {
  const goalId = "v1-duplicate-remove-goal";
  const root = tmpRoot();
  const created = {
    schemaVersion: "goal-engine.event.v1", eventId: "duplicate-remove-created", goalId,
    occurredAt: "2025-02-05T06:07:08.000Z", type: "goal.created",
    data: {
      objective: "Reject duplicate remove amendments without changing persisted state", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
      taskDefs: { t1: { description: "original", deps: [], writePaths: ["original.ts"], acceptance: { criteria: ["original"], commands: ["true"] }, workflow: "tdd" } },
    },
  };
  appendEvent(root, created, 0);
  const eventsPath = join(root, `goals/${goalId}/events.jsonl`);
  const projectionPath = join(root, `goals/${goalId}/projection.json`);
  const registryPath = join(root, "registry.json");
  const before = {
    events: readFileSync(eventsPath, "utf8"),
    projection: readFileSync(projectionPath, "utf8"),
    registry: readFileSync(registryPath, "utf8"),
  };

  for (const { eventId, data } of [
    { eventId: "duplicate-remove-only", data: { reason: "Reject duplicate v1 remove IDs before candidate construction", removeTasks: ["t1", "t1"] } },
    {
      eventId: "duplicate-remove-replacement",
      data: {
        reason: "Reject duplicate v1 replacement remove IDs before candidate construction",
        removeTasks: ["t1", "t1"],
        addTasks: { t1: { description: "replacement", deps: [], writePaths: ["replacement.ts"], acceptance: { criteria: ["replacement"], commands: ["true"] }, workflow: "tdd" } },
        updateTasks: { t1: { description: "refined replacement" } },
      },
    },
  ]) {
    assert.throws(
      () => appendEvent(root, { schemaVersion: "goal-engine.event.v1", eventId, goalId, occurredAt: "2025-02-05T06:07:09.000Z", type: "goal.amended", data }, 1),
      /duplicate remove task: t1/,
    );
    assert.equal(readFileSync(eventsPath, "utf8"), before.events);
    assert.equal(readFileSync(projectionPath, "utf8"), before.projection);
    assert.equal(readFileSync(registryPath, "utf8"), before.registry);
    const projection = loadProjection(root, goalId);
    assert.equal(projection.version, 1);
    assert.deepEqual([...projection.tasks.keys()], ["t1"]);
  }
});

test("historical v1 and v2 amendments update a task added by the same event", () => {
  const goalId = "fixed-add-update-replay";
  const created = {
    schemaVersion: "goal-engine.event.v1", eventId: "fixed-created", goalId,
    occurredAt: "2025-02-03T04:05:06.000Z", type: "goal.created",
    data: {
      objective: "Replay a same-event task amendment", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
      taskDefs: { t1: { description: "existing work", deps: [], writePaths: ["t1.ts"], acceptance: { criteria: ["t1"], commands: ["true"] }, workflow: "tdd" } },
    },
  };
  const amendmentData = {
    reason: "Replay historical add and update within one amendment event",
    addTasks: { t2: { description: "initial new work", deps: ["t1"], writePaths: ["t2.ts"], acceptance: { criteria: ["initial"], commands: ["true"] }, workflow: "tdd" } },
    updateTasks: { t2: { description: "updated new work", writePaths: ["updated-t2.ts"], acceptance: { criteria: ["updated"], commands: ["node --test test/t2.test.mjs"] } } },
  };
  const root = tmpRoot();
  appendEvent(root, created, 0);
  appendEvent(root, { schemaVersion: "goal-engine.event.v1", eventId: "fixed-amended", goalId, occurredAt: "2025-02-03T04:05:07.000Z", type: "goal.amended", data: amendmentData }, 1);
  const replayed = loadProjection(root, goalId);
  assert.equal(replayed.version, 2);
  assert.equal(replayed.tasks.get("t2").description, "updated new work");
  assert.deepEqual(replayed.tasks.get("t2").writePaths, ["updated-t2.ts"]);

  let v2 = applyEvent(createProjection(), { ...created, schemaVersion: "goal-engine.event.v2", eventId: "fixed-v2-created", goalId: "fixed-v2-add-update" });
  v2 = applyEvent(v2, { schemaVersion: "goal-engine.event.v2", eventId: "fixed-v2-amended", goalId: "fixed-v2-add-update", occurredAt: "2025-02-03T04:05:07.000Z", type: "goal.amended", data: amendmentData });
  assert.equal(v2.tasks.get("t2").description, "updated new work");
});

test("v2 dispatch requires downstream dependencies accepted", () => {
  const goalId = "dispatch-runnable-goal";
  let p = applyEvent(
    createProjection(),
    v2Event(
      "goal.created",
      {
        objective: "DAG gate test",
        scope: [],
        nonGoals: [],
        dod: [],
        tasks: ["t1", "t2"],
        taskDefs: {
          t1: { description: "task one", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
          t2: { description: "task two", deps: ["t1"], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
        },
      },
      goalId,
    ),
  );

  assert.throws(
    () =>
      applyEvent(
        p,
        v2Event(
          "task.dispatched",
          {
            taskId: "t2",
            contractHash: "dispatch-t2",
            workspace: { attempt: 1, path: "/tmp/work-t2", branch: "task/t2", baseCommit: "abc" },
          },
          goalId,
        ),
      ),
    /dependencies not accepted|not accepted|not runnable/i,
  );
});

test("rejected dispatch keeps task and workspace state unchanged", () => {
  const goalId = "dispatch-immutable-goal";
  let p = applyEvent(
    createProjection(),
    v2Event(
      "goal.created",
      {
        objective: "Immutable dispatch check",
        scope: [],
        nonGoals: [],
        dod: [],
        tasks: ["t1", "t2"],
        taskDefs: {
          t1: { description: "task one", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
          t2: { description: "task two", deps: ["t1"], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
        },
      },
      goalId,
    ),
  );

  const expectedVersion = p.version;
  const expectedTasks = new Map(
    [...p.tasks].map(([taskId, task]) => [
      taskId,
      {
        status: task.status,
        attempts: task.attempts,
        deps: [...task.deps],
        workspace: task.workspace ? { ...task.workspace } : null,
      },
    ]),
  );

  assert.throws(
    () =>
      applyEvent(
        p,
        v2Event(
          "task.dispatched",
          {
            taskId: "t2",
            contractHash: "dispatch-t2",
            workspace: { attempt: 1, path: "/tmp/work-t2", branch: "task/t2", baseCommit: "abc" },
          },
          goalId,
        ),
      ),
    /dependencies not accepted|not accepted|not runnable/i,
  );

  assert.equal(p.version, expectedVersion);
  for (const [taskId, expected] of expectedTasks) {
    const task = p.tasks.get(taskId);
    assert.equal(task.status, expected.status);
    assert.equal(task.attempts, expected.attempts);
    assert.deepEqual(task.deps, expected.deps);
    assert.deepEqual(task.workspace, expected.workspace);
  }
});

test("amendment updateTasks with dependency cycle is rejected and projection unchanged", () => {
  const goalId = "amend-cycle-goal";
  let p = applyEvent(
    createProjection(),
    makeEvent(
      "goal.created",
      {
        objective: "Amendment cycle test",
        scope: [],
        nonGoals: [],
        dod: [],
        tasks: ["t1", "t2"],
        taskDefs: {
          t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
          t2: { description: "b", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
        },
      },
      goalId,
    ),
  );

  const expectedVersion = p.version;
  const expectedTasks = new Map(
    [...p.tasks].map(([taskId, task]) => [
      taskId,
      {
        status: task.status,
        attempts: task.attempts,
        deps: [...task.deps],
        workspace: task.workspace ? { ...task.workspace } : null,
      },
    ]),
  );

  assert.throws(
    () =>
      applyEvent(
        p,
        makeEvent(
          "goal.amended",
          {
            reason: "Create an explicit dependency loop between t1 and t2 to validate cycle guard",
            updateTasks: {
              t1: { deps: ["t2"] },
              t2: { deps: ["t1"] },
            },
          },
          goalId,
        ),
      ),
    /cycle/i,
  );

  assert.equal(p.version, expectedVersion);
  for (const [taskId, expected] of expectedTasks) {
    const task = p.tasks.get(taskId);
    assert.equal(task.status, expected.status);
    assert.equal(task.attempts, expected.attempts);
    assert.deepEqual(task.deps, expected.deps);
    assert.deepEqual(task.workspace, expected.workspace);
  }
});

test("amendment unknown dependency is rejected and projection unchanged", () => {
  const goalId = "amend-unknown-goal";
  let p = applyEvent(
    createProjection(),
    makeEvent(
      "goal.created",
      {
        objective: "Amendment unknown dependency test",
        scope: [],
        nonGoals: [],
        dod: [],
        tasks: ["t1", "t2"],
        taskDefs: {
          t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
          t2: { description: "b", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
        },
      },
      goalId,
    ),
  );

  const expectedVersion = p.version;
  const expectedTasks = new Map(
    [...p.tasks].map(([taskId, task]) => [
      taskId,
      {
        status: task.status,
        attempts: task.attempts,
        deps: [...task.deps],
        workspace: task.workspace ? { ...task.workspace } : null,
      },
    ]),
  );

  assert.throws(
    () =>
      applyEvent(
        p,
        makeEvent(
          "goal.amended",
          {
            reason: "Add task t3 depending on a missing task to guard unknown deps",
            addTasks: {
              t3: {
                description: "new task",
                deps: ["t-missing"],
                writePaths: ["c.ts"],
                acceptance: { criteria: ["z"], commands: ["true"] },
                workflow: "tdd",
              },
            },
          },
          goalId,
        ),
      ),
    /unknown dep/i,
  );

  assert.equal(p.version, expectedVersion);
  for (const [taskId, expected] of expectedTasks) {
    const task = p.tasks.get(taskId);
    assert.equal(task.status, expected.status);
    assert.equal(task.attempts, expected.attempts);
    assert.deepEqual(task.deps, expected.deps);
    assert.deepEqual(task.workspace, expected.workspace);
  }
});

// --- Store tests ---

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "ge-store-"));
}

test("appendEvent writes events.jsonl and projection.json", () => {
  const root = tmpRoot();
  const event = makeEvent("goal.created", {
    objective: "Store test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "store-goal");

  const proj = appendEvent(root, event, 0);

  assert.ok(existsSync(join(root, "goals/store-goal/events.jsonl")));
  assert.ok(existsSync(join(root, "goals/store-goal/projection.json")));

  const lines = readFileSync(join(root, "goals/store-goal/events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);

  const serialized = JSON.parse(readFileSync(join(root, "goals/store-goal/projection.json"), "utf8"));
  assert.equal(serialized.goalId, "store-goal");
  assert.equal(serialized.lifecycle, "active");
  assert.equal(serialized.version, 1);
  assert.equal(proj.version, 1);
});

test("appendEvent rejects stale expectedVersion", () => {
  const root = tmpRoot();
  const e1 = makeEvent("goal.created", {
    objective: "Version test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "ver-goal");

  appendEvent(root, e1, 0);

  const e2 = makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }, "ver-goal");
  assert.throws(
    () => appendEvent(root, e2, 0),
    /projection version conflict: expected 0, current 1/,
  );
});

test("loadProjection rebuilds from events.jsonl", () => {
  const root = tmpRoot();
  const e1 = makeEvent("goal.created", {
    objective: "Load test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "load-goal");

  appendEvent(root, e1, 0);

  const proj = loadProjection(root, "load-goal");
  assert.equal(proj.goalId, "load-goal");
  assert.equal(proj.version, 1);
  assert.equal(proj.lifecycle, "active");
  assert.equal(proj.tasks.get("t1").status, "pending");
});

test("historical v1 dispatch JSONL replays downstream before dependency acceptance", () => {
  const root = tmpRoot();
  const goalId = "historical-v1-dispatch";
  const event = (eventId, occurredAt, type, data) => ({ schemaVersion: "goal-engine.event.v1", eventId, goalId, occurredAt, type, data });
  const events = [
    event("v1-created", "2025-03-01T00:00:00.000Z", "goal.created", {
      objective: "Replay legacy downstream dispatch", scope: [], nonGoals: [], dod: [], tasks: ["t1", "t2"],
      taskDefs: {
        t1: { description: "upstream", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["t1 works"], commands: ["true"] }, workflow: "tdd" },
        t2: { description: "downstream", deps: ["t1"], writePaths: ["src/t2.ts"], acceptance: { criteria: ["t2 works"], commands: ["true"] }, workflow: "tdd" },
      },
    }),
    event("v1-t2-dispatched", "2025-03-01T00:00:01.000Z", "task.dispatched", { taskId: "t2", contractHash: "legacy-t2" }),
    event("v1-t2-failed", "2025-03-01T00:00:02.000Z", "task.settled", { taskId: "t2", outcome: "failed", nextAction: "Retry downstream work after reviewing the historical failure details" }),
    event("v1-t1-dispatched", "2025-03-01T00:00:03.000Z", "task.dispatched", { taskId: "t1", contractHash: "legacy-t1" }),
  ];
  const goalDir = join(root, "goals", goalId);
  mkdirSync(goalDir, { recursive: true });
  writeFileSync(join(goalDir, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);

  const replayed = loadProjection(root, goalId);
  assert.equal(replayed.version, 4);
  assert.equal(replayed.eventSchemaVersion, "goal-engine.event.v1");
  assert.equal(replayed.tasks.get("t2").attempts, 1);
  assert.equal(replayed.tasks.get("t2").status, "pending");
  assert.equal(replayed.tasks.get("t1").attempts, 1);
  assert.equal(replayed.tasks.get("t1").status, "dispatched");
});

test("v2 dispatch dependency gate rejects downstream before acceptance atomically", () => {
  const goalId = "v2-dispatch-dependency";
  const created = fixedV2Event("goal.created", {
    objective: "Reject premature downstream dispatch", scope: [], nonGoals: [], dod: [], tasks: ["t1", "t2"],
    taskDefs: {
      t1: { description: "upstream", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["t1 works"], commands: ["true"] }, workflow: "tdd" },
      t2: { description: "downstream", deps: ["t1"], writePaths: ["src/t2.ts"], acceptance: { criteria: ["t2 works"], commands: ["true"] }, workflow: "tdd" },
    },
  }, goalId, "2025-03-02T00:00:00.000Z", "v2-created");
  const projection = applyEvent(createProjection(), created);
  const before = structuredClone({ version: projection.version, eventSchemaVersion: projection.eventSchemaVersion, tasks: [...projection.tasks] });
  assert.throws(() => applyEvent(projection, fixedV2Event("task.dispatched", {
    taskId: "t2", contractHash: "v2-t2", workspace: { attempt: 1, path: "/tmp/t2", branch: "ge/t2/1", baseCommit: "base" },
  }, goalId, "2025-03-02T00:00:01.000Z", "v2-t2-dispatched")), /dependencies are not accepted: t1/);
  assert.deepEqual(structuredClone({ version: projection.version, eventSchemaVersion: projection.eventSchemaVersion, tasks: [...projection.tasks] }), before);
});

test("dispatch downgrade rejects v1 after v2 history and v2 retains dependency gate after v1 history", () => {
  const goalId = "mixed-dispatch-history";
  const created = {
    schemaVersion: "goal-engine.event.v1", eventId: "mixed-v1-created", goalId, occurredAt: "2025-03-03T00:00:00.000Z", type: "goal.created",
    data: { objective: "Keep upgraded dependency gate", scope: [], nonGoals: [], dod: [], tasks: ["t1", "t2"], taskDefs: {
      t1: { description: "upstream", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["t1 works"], commands: ["true"] }, workflow: "tdd" },
      t2: { description: "downstream", deps: ["t1"], writePaths: ["src/t2.ts"], acceptance: { criteria: ["t2 works"], commands: ["true"] }, workflow: "tdd" },
    } },
  };
  let projection = applyEvent(createProjection(), created);
  assert.throws(() => applyEvent(projection, fixedV2Event("task.dispatched", {
    taskId: "t2", contractHash: "upgraded-t2", workspace: { attempt: 1, path: "/tmp/t2", branch: "ge/t2/1", baseCommit: "base" },
  }, goalId, "2025-03-03T00:00:01.000Z", "mixed-v2-t2")), /dependencies are not accepted: t1/);
  projection = applyEvent(projection, fixedV2Event("goal.checkpoint", {
    nextAction: "Keep the v2 upgrade marker while preserving all dependency protections",
  }, goalId, "2025-03-03T00:00:02.000Z", "mixed-v2-checkpoint"));
  assert.throws(() => applyEvent(projection, {
    schemaVersion: "goal-engine.event.v1", eventId: "mixed-v1-dispatch", goalId, occurredAt: "2025-03-03T00:00:03.000Z", type: "task.dispatched", data: { taskId: "t1", contractHash: "downgrade" },
  }), /schema downgrade/);
});

test("loadProjection returns null for nonexistent goal", () => {
  const root = tmpRoot();
  assert.equal(loadProjection(root, "no-such-goal"), null);
});

test("listGoals returns active goal ids", () => {
  const root = tmpRoot();
  assert.deepEqual(listGoals(root), []);

  const e1 = makeEvent("goal.created", {
    objective: "List test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "list-goal");

  appendEvent(root, e1, 0);
  assert.deepEqual(listGoals(root), ["list-goal"]);
});

// v2 disposition invariant regressions (incremental to the restored v1 suite).
test("amend rejects accepted and unreleased workspace tasks atomically", () => {
  const base = applyEvent(createProjection(), v2Created("amend-gate-goal"));
  const amend = (projection, data) => applyEvent(projection, v2Event("goal.amended", {
    reason: "Prevent rewriting executed task proof and workspace identity",
    ...data,
  }, "amend-gate-goal"));
  const snapshot = (projection) => structuredClone({
    version: projection.version,
    tasks: [...projection.tasks],
  });

  const accepted = structuredClone(base);
  accepted.tasks.get("t1").status = "accepted";
  for (const updates of [
    { description: "changed" },
    { deps: [] },
    { writePaths: ["other.ts"] },
    { acceptance: { criteria: ["changed"], commands: ["false"] } },
  ]) {
    const before = snapshot(accepted);
    assert.throws(() => amend(accepted, { updateTasks: { t1: updates } }), /pending|accepted|amend/i);
    assert.deepEqual(snapshot(accepted), before);
  }
  assert.throws(() => amend(accepted, { removeTasks: ["t1"] }), /pending|accepted|amend/i);

  for (const status of ["dispatched", "succeeded", "blocked", "pending"]) {
    const projection = structuredClone(base);
    const task = projection.tasks.get("t1");
    task.status = status;
    if (status === "pending") task.lastSettledOutcome = "failed";
    task.workspace = { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc", phase: "active" };
    for (const data of [{ removeTasks: ["t1"] }, { updateTasks: { t1: { description: "changed" } } }]) {
      const before = snapshot(projection);
      assert.throws(() => amend(projection, data), /pending|workspace|amend/i);
      assert.deepEqual(snapshot(projection), before);
    }
  }

  for (const disposition of ["preserved", "integrated"]) {
    const projection = structuredClone(base);
    const task = projection.tasks.get("t1");
    task.workspace = { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc", phase: "disposed", disposition, released: disposition === "integrated" };
    assert.throws(() => amend(projection, { removeTasks: ["t1"] }), /workspace|pending|amend/i);
    assert.throws(() => amend(projection, { updateTasks: { t1: { description: "changed" } } }), /workspace|pending|amend/i);
  }
});

test("v2 pending replacement succeeds while accepted and unreleased replacements reject atomically", () => {
  const replacement = {
    reason: "Replace the original task only after its removal gate allows it",
    removeTasks: ["t1"],
    addTasks: { t1: { description: "replacement", deps: [], writePaths: ["replacement.ts"], acceptance: { criteria: ["replacement"], commands: ["true"] }, workflow: "tdd" } },
    updateTasks: { t1: { description: "refined" } },
  };
  const amend = (projection) => applyEvent(projection, v2Event("goal.amended", replacement, "replacement-gate-goal"));
  const snapshot = (projection) => structuredClone({ version: projection.version, tasks: [...projection.tasks] });

  const pending = applyEvent(createProjection(), v2Created("replacement-gate-goal"));
  const replaced = amend(pending);
  assert.equal(replaced.version, 2);
  assert.equal(replaced.tasks.get("t1").description, "refined");

  const rejected = [
    { status: "accepted" },
    { status: "dispatched", phase: "active" },
    { status: "succeeded", phase: "disposing" },
    { status: "blocked", phase: "applied" },
    { status: "pending", phase: "disposed", disposition: "preserved", released: false },
    { status: "pending", phase: "disposed", disposition: "integrated", released: true },
    { status: "pending", phase: "disposed", disposition: "discarded", released: false },
  ];
  for (const fixture of rejected) {
    const projection = applyEvent(createProjection(), v2Created("replacement-gate-goal"));
    const task = projection.tasks.get("t1");
    task.status = fixture.status;
    if (fixture.phase) task.workspace = { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc", phase: fixture.phase, disposition: fixture.disposition, released: fixture.released };
    const before = snapshot(projection);
    assert.throws(() => amend(projection), /pending|workspace|remove/i);
    assert.deepEqual(snapshot(projection), before);
  }
});

test("amend allows never-dispatched and discarded released pending tasks", () => {
  const amend = (projection, data) => applyEvent(projection, v2Event("goal.amended", {
    reason: "Allow pending tasks after workspace resources are fully released",
    ...data,
  }, "amend-allowed-goal"));
  let neverDispatched = applyEvent(createProjection(), v2Created("amend-allowed-goal"));
  neverDispatched = amend(neverDispatched, { updateTasks: { t1: { description: "changed" } } });
  assert.equal(neverDispatched.tasks.get("t1").description, "changed");
  const neverDispatchedRemoval = applyEvent(createProjection(), v2Created("amend-allowed-goal"));
  assert.throws(() => amend(neverDispatchedRemoval, { removeTasks: ["t1"] }), /non-empty|tasks/i);
  assert.equal(neverDispatchedRemoval.tasks.has("t1"), true);

  let released = applyEvent(createProjection(), v2Created("amend-allowed-goal"));
  released.tasks.get("t1").workspace = { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc", phase: "disposed", disposition: "discarded", released: true };
  released = amend(released, { updateTasks: { t1: { description: "changed again" } } });
  assert.equal(released.tasks.get("t1").description, "changed again");
  assert.throws(() => amend(released, { removeTasks: ["t1"] }), /non-empty|tasks/i);
  assert.equal(released.tasks.has("t1"), true);
});

function v2Event(type, data, goalId = "v2-goal", occurredAt = "2026-01-02T03:04:05.000Z") {
  return { schemaVersion: "goal-engine.event.v2", eventId: crypto.randomUUID(), goalId, type, occurredAt, data };
}

function fixedV2Event(type, data, goalId, occurredAt, eventId) {
  return { schemaVersion: "goal-engine.event.v2", eventId, goalId, type, occurredAt, data };
}

function v2Created(goalId = "v2-goal") {
  return v2Event("goal.created", { objective: "Workspace disposition test", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } } }, goalId);
}

function v2Dispatched(p, goalId = "v2-goal") {
  return applyEvent(p, v2Event("task.dispatched", { taskId: "t1", contractHash: "h1", workspace: { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc" } }, goalId));
}

function v2Settled(p, outcome = "succeeded", goalId = "v2-goal") {
  return applyEvent(p, v2Event("task.settled", { taskId: "t1", outcome, evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria" }, goalId));
}

function started(action, goalId = "v2-goal") {
  return v2Event("task.workspace_disposition_started", { taskId: "t1", attempt: 1, requestedAction: action, strategy: "merge", executorHead: "executor-head", originHeadBefore: "origin-before" }, goalId);
}

test("schema downgrade rejects v1 accepted after a v2 event", () => {
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created())));
  assert.throws(() => applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }, "v2-goal")), /schema downgrade/);
});

test("legacy v1 history remains replayable and explicitly unverified", () => {
  let p = applyEvent(createProjection(), makeEvent("goal.created", { objective: "Legacy", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] } } } }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));
  p = applyEvent(p, makeEvent("goal.completed", { verdict: "COMPLETE" }));
  assert.equal(p.tasks.get("t1").acceptanceVerification, "legacy_unverified");
});

test("legacy v2 started without originRef replays with explicit legacy marker", () => {
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created())));
  p = applyEvent(p, started("integrate"));
  assert.equal(p.tasks.get("t1").workspace.legacyOriginRef, true);
  assert.equal(p.tasks.get("t1").workspace.originRef, undefined);
});

test("v2 started persists a valid originRef", () => {
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created())));
  const event = started("integrate"); event.data.originRef = "refs/heads/main";
  p = applyEvent(p, event);
  assert.equal(p.tasks.get("t1").workspace.originRef, "refs/heads/main");
  assert.equal(p.tasks.get("t1").workspace.legacyOriginRef, false);
});

test("historical v1 accepted amendment JSONL replays while v2 accepted amendment is rejected", () => {
  const goalId = "fixed-amendment-history";
  const event = (schemaVersion, eventId, occurredAt, type, data) => ({ schemaVersion, eventId, goalId, occurredAt, type, data });
  const created = (schemaVersion, eventId, occurredAt) => event(schemaVersion, eventId, occurredAt, "goal.created", {
    objective: "Replay frozen historical amendment", scope: [], nonGoals: [], dod: [], tasks: ["t1", "t2"],
    taskDefs: {
      t1: { description: "historical accepted work", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["original proof"], commands: ["node --test test/t1.test.mjs"] }, workflow: "tdd" },
      t2: { description: "remaining work", deps: [], writePaths: ["src/t2.ts"], acceptance: { criteria: ["t2 proof"], commands: ["node --test test/t2.test.mjs"] }, workflow: "tdd" },
    },
  });
  const v1Events = [
    created("goal-engine.event.v1", "v1-created", "2025-01-01T00:00:00.000Z"),
    event("goal-engine.event.v1", "v1-dispatched", "2025-01-01T00:00:01.000Z", "task.dispatched", { taskId: "t1", contractHash: "v1-contract" }),
    event("goal-engine.event.v1", "v1-settled", "2025-01-01T00:00:02.000Z", "task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/t1.ts" }, nextAction: "Review the fixed historical task evidence before accepting the replay result" }),
    event("goal-engine.event.v1", "v1-accepted", "2025-01-01T00:00:03.000Z", "task.accepted", { taskId: "t1" }),
    event("goal-engine.event.v1", "v1-amended", "2025-01-01T00:00:04.000Z", "goal.amended", { reason: "Preserve historical rewritten acceptance proof during v1 log replay", updateTasks: { t1: { acceptance: { criteria: ["historically rewritten proof"], commands: ["node --test test/historical.test.mjs"] } } } }),
  ];
  const root = tmpRoot();
  v1Events.forEach((item, index) => appendEvent(root, item, index));
  const replayed = loadProjection(root, goalId);
  assert.equal(replayed.version, 5);
  assert.equal(replayed.tasks.get("t1").status, "accepted");
  assert.equal(replayed.tasks.get("t1").acceptanceVerification, "legacy_unverified");
  assert.deepEqual(replayed.tasks.get("t1").acceptance, { criteria: ["historically rewritten proof"], commands: ["node --test test/historical.test.mjs"] });
  assert.throws(() => applyEvent(replayed, event("goal-engine.event.v1", "v1-remove-accepted", "2025-01-01T00:00:05.000Z", "goal.amended", { reason: "Keep the legacy accepted remove rejection during historical replay", removeTasks: ["t1"] })), /accepted|remove/i);
  const removedLegacyPending = applyEvent(replayed, event("goal-engine.event.v1", "v1-remove-pending", "2025-01-01T00:00:06.000Z", "goal.amended", { reason: "Replay the historical removal of a nonaccepted legacy task", removeTasks: ["t2"] }));
  assert.equal(removedLegacyPending.tasks.has("t2"), false);

  const v2GoalId = "fixed-v2-amendment-history";
  const v2 = (eventId, occurredAt, type, data) => ({ schemaVersion: "goal-engine.event.v2", eventId, goalId: v2GoalId, occurredAt, type, data });
  const v2Events = [
    { ...created("goal-engine.event.v2", "v2-created", "2025-01-02T00:00:00.000Z"), goalId: v2GoalId },
    v2("v2-dispatched", "2025-01-02T00:00:01.000Z", "task.dispatched", { taskId: "t1", contractHash: "v2-contract", workspace: { attempt: 1, path: "/tmp/fixed-v2", branch: "ge/fixed/t1/1", baseCommit: "base" } }),
    v2("v2-settled", "2025-01-02T00:00:02.000Z", "task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/t1.ts" }, nextAction: "Review the fixed v2 task evidence before accepting the replay result" }),
    v2("v2-disposition-started", "2025-01-02T00:00:03.000Z", "task.workspace_disposition_started", { taskId: "t1", attempt: 1, requestedAction: "integrate", strategy: "merge", executorHead: "executor", originHeadBefore: "origin" }),
    v2("v2-disposition-applied", "2025-01-02T00:00:04.000Z", "task.workspace_disposition_applied", { taskId: "t1", attempt: 1, action: "integrate", strategy: "merge", executorHead: "executor", originHead: "origin-after" }),
    v2("v2-disposed", "2025-01-02T00:00:05.000Z", "task.workspace_disposed", { taskId: "t1", attempt: 1, action: "integrate", released: true }),
    v2("v2-accepted", "2025-01-02T00:00:06.000Z", "task.accepted", { taskId: "t1", workspaceAttempt: 1 }),
  ];
  let v2Projection = createProjection();
  for (const item of v2Events) v2Projection = applyEvent(v2Projection, item);
  const before = structuredClone({ version: v2Projection.version, tasks: [...v2Projection.tasks] });
  assert.throws(() => applyEvent(v2Projection, v2("v2-amended", "2025-01-02T00:00:07.000Z", "goal.amended", { reason: "Reject rewriting accepted v2 task proof after the contract freeze", updateTasks: { t1: { acceptance: { criteria: ["rewritten"], commands: ["false"] } } } })), /pending|accepted|amend/i);
  assert.deepEqual(structuredClone({ version: v2Projection.version, tasks: [...v2Projection.tasks] }), before);
});

test("disposition requires settled status and compatible outcome", () => {
  let p = v2Dispatched(applyEvent(createProjection(), v2Created()));
  for (const action of ["integrate", "discard", "preserve"]) assert.throws(() => applyEvent(p, started(action)), /settled|status|succeeded/);
  p = v2Settled(p, "failed");
  assert.throws(() => applyEvent(p, started("integrate")), /succeeded/);
  for (const action of ["discard", "preserve"]) assert.doesNotThrow(() => applyEvent(p, started(action)));
  let blocked = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created("blocked-goal")), "blocked-goal"), "blocked", "blocked-goal");
  assert.throws(() => applyEvent(blocked, started("integrate", "blocked-goal")), /succeeded/);
  for (const action of ["discard", "preserve"]) assert.doesNotThrow(() => applyEvent(blocked, started(action, "blocked-goal")));
});

test("disposition applied preserves started identity", () => {
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created())));
  const start = started("integrate");
  p = applyEvent(p, start);
  const data = { ...start.data, action: "integrate", originHead: "origin-after" };
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...data, strategy: "rebase" })), /strategy/);
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...data, executorHead: "other-head" })), /executorHead/);
});

test("discarded succeeded resets pending and pending remains pending", () => {
  for (const outcome of ["succeeded", "failed"]) {
    let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created(`${outcome}-goal`)), `${outcome}-goal`), outcome, `${outcome}-goal`);
    const start = started("discard", `${outcome}-goal`);
    p = applyEvent(p, start);
    p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "discard", originHead: "origin-after" }, `${outcome}-goal`));
    p = applyEvent(p, v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "discard", released: true }, `${outcome}-goal`));
    assert.equal(p.tasks.get("t1").status, "pending");
  }
});

test("v1 projection upgrades on v2 and rejects every later v1 event", () => {
  let p = applyEvent(createProjection(), makeEvent("goal.created", { objective: "Upgrade", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] } } } }));
  p = applyEvent(p, v2Event("task.dispatched", { taskId: "t1", contractHash: "h1", workspace: { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc" } }, "test-goal"));
  assert.equal(p.eventSchemaVersion, "goal-engine.event.v2");
  assert.throws(() => applyEvent(p, makeEvent("goal.checkpoint", { nextAction: "Verify the complete implementation meets the required acceptance criteria" })), /schema downgrade/);
});

test("disposition applied retains attempt phase and action gates", () => {
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created())));
  const start = started("integrate"); p = applyEvent(p, start);
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, attempt: 2, action: "integrate", originHead: "origin-after" })), /attempt/);
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "discard", originHead: "origin-after" })), /action/);
  p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "integrate", originHead: "origin-after" }));
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "integrate", originHead: "origin-after" })), /disposing/);
});

test("redispatch attempt2 is rejected after failed settle when active workspace is still attempt1", () => {
  const goalId = "failed-active-redispatch-goal";
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created(goalId)), goalId), "failed", goalId);
  const failedWorkspace = p.tasks.get("t1").workspace;
  assert.equal(failedWorkspace.phase, "active");

  assert.throws(
    () =>
      applyEvent(
        p,
        v2Event(
          "task.dispatched",
          {
            taskId: "t1",
            contractHash: "h2",
            workspace: { attempt: failedWorkspace.attempt + 1, path: "/tmp/work-retry", branch: "task/t1/retry", baseCommit: "retry" },
          },
          goalId,
        ),
      ),
    /attempt|workspace|phase|attempt mismatch|active|disposed/,
  );
});

test("preserved terminal workspace blocks redispatch", () => {
  const goalId = "preserve-vs-discard-redispatch-goal";
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created(goalId)), goalId), "failed", goalId);

  const preserveStart = started("preserve", goalId);
  p = applyEvent(p, preserveStart);
  p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...preserveStart.data, action: "preserve", originHead: "origin-after" }, goalId));
  p = applyEvent(p, v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "preserve", released: false }, goalId));

  assert.equal(p.tasks.get("t1").workspace.phase, "disposed");
  assert.equal(p.tasks.get("t1").workspace.disposition, "preserved");
  assert.throws(
    () =>
      applyEvent(
        p,
        v2Event("task.dispatched", {
          taskId: "t1",
          contractHash: "h2",
          workspace: { attempt: 2, path: "/tmp/work-preserve", branch: "task/t1/preserve", baseCommit: "retry-preserve" },
        }, goalId),
      ),
    /attempt|workspace|phase|disposed|succeeded/,
  );
});

test("discarded released workspace allows redispatch retry", () => {
  const goalId = "discard-retry-redispatch-goal";
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created(goalId)), goalId), "failed", goalId);
  const start = started("discard", goalId);
  p = applyEvent(p, start);
  p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "discard", originHead: "origin-after" }, goalId));
  p = applyEvent(p, v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "discard", released: true }, goalId));

  p = applyEvent(
    p,
    v2Event("task.dispatched", {
      taskId: "t1",
      contractHash: "h2",
      workspace: { attempt: 2, path: "/tmp/work-discard", branch: "task/t1/discard", baseCommit: "retry-discard" },
    }, goalId),
  );
  const task = p.tasks.get("t1");
  assert.equal(task.attempts, 2);
  assert.equal(task.workspace.phase, "active");
  assert.equal(task.workspace.attempt, 2);
});

test("v2 without integrated or released succeeded rejects accept", () => {
  const goalId = "without-integrated-accept-goal";
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created(goalId)), goalId), "succeeded", goalId);

  const start = started("preserve", goalId);
  p = applyEvent(p, start);
  p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "preserve", originHead: "origin-after" }, goalId));
  p = applyEvent(p, v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "preserve", released: false }, goalId));

  assert.throws(() => applyEvent(p, v2Event("task.accepted", { taskId: "t1", workspaceAttempt: 1 }, goalId)), /workspace must be disposed, integrated, and released before acceptance/);
});

test("terminal dispose event is rejected when terminal state already emitted", () => {
  const goalId = "terminal-dispose-repeat-goal";
  let p = v2Settled(v2Dispatched(applyEvent(createProjection(), v2Created(goalId)), goalId), "succeeded", goalId);
  const start = started("integrate", goalId);
  p = applyEvent(p, start);
  p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "integrate", originHead: "origin-after" }, goalId));
  p = applyEvent(p, v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "integrate", released: true }, goalId));

  assert.throws(
    () =>
      applyEvent(
        p,
        v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "integrate", released: true }, goalId),
      ),
    /workspace must be applied/,
  );
});

test("v2 terminal disposition store round-trip preserves schema and acceptance", () => {
  const goalId = "round-trip-goal";
  const events = [
    fixedV2Event(
      "goal.created",
      {
        objective: "Workspace disposition test",
        scope: [],
        nonGoals: [],
        dod: [],
        tasks: ["t1"],
        taskDefs: {
          t1: {
            description: "work",
            deps: [],
            writePaths: ["a.ts"],
            acceptance: { criteria: ["x"], commands: ["true"] },
            workflow: "tdd",
          },
        },
      },
      goalId,
      "2026-01-02T03:04:05.000Z",
      "round-trip-goal-created",
    ),
    fixedV2Event(
      "task.dispatched",
      {
        taskId: "t1",
        contractHash: "h1",
        workspace: { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc" },
      },
      goalId,
      "2026-01-02T03:04:06.000Z",
      "round-trip-task-dispatched",
    ),
    fixedV2Event(
      "task.settled",
      {
        taskId: "t1",
        outcome: "succeeded",
        evidence: { type: "file", path: "a.ts" },
        nextAction: "Verify the complete implementation meets the required acceptance criteria",
      },
      goalId,
      "2026-01-02T03:04:07.000Z",
      "round-trip-task-settled",
    ),
    fixedV2Event(
      "task.workspace_disposition_started",
      {
        taskId: "t1",
        attempt: 1,
        requestedAction: "integrate",
        strategy: "merge",
        executorHead: "executor-head",
        originHeadBefore: "origin-before",
      },
      goalId,
      "2026-01-02T03:04:08.000Z",
      "round-trip-workspace-started",
    ),
    fixedV2Event(
      "task.workspace_disposition_applied",
      {
        taskId: "t1",
        attempt: 1,
        action: "integrate",
        strategy: "merge",
        executorHead: "executor-head",
        originHead: "origin-after",
      },
      goalId,
      "2026-01-02T03:04:09.000Z",
      "round-trip-workspace-applied",
    ),
    fixedV2Event(
      "task.workspace_disposed",
      {
        taskId: "t1",
        attempt: 1,
        action: "integrate",
        released: true,
      },
      goalId,
      "2026-01-02T03:04:10.000Z",
      "round-trip-workspace-disposed",
    ),
    fixedV2Event(
      "task.accepted",
      {
        taskId: "t1",
        workspaceAttempt: 1,
      },
      goalId,
      "2026-01-02T03:04:11.000Z",
      "round-trip-task-accepted",
    ),
  ];

  const expectedEvents = JSON.parse(JSON.stringify(events));
  let replayed = createProjection();
  let replayedTwice = createProjection();

  for (const event of events) {
    replayed = applyEvent(replayed, event);
  }

  for (const event of events) {
    replayedTwice = applyEvent(replayedTwice, event);
  }

  assert.deepEqual(replayed, replayedTwice);
  assert.deepEqual(expectedEvents, events);
  const root = tmpRoot();
  events.forEach((event, index) => appendEvent(root, event, index));
  const storedEvents = readFileSync(join(root, `goals/${goalId}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.deepEqual(storedEvents, expectedEvents);

  const loaded = loadProjection(root, goalId);
  const loadedTask = loaded.tasks.get("t1");
  assert.equal(loaded.eventSchemaVersion, "goal-engine.event.v2");
  assert.deepEqual(
    {
      phase: loadedTask.workspace.phase,
      disposition: loadedTask.workspace.disposition,
      released: loadedTask.workspace.released,
      acceptanceVerification: loadedTask.acceptanceVerification,
    },
    {
      phase: "disposed",
      disposition: "integrated",
      released: true,
      acceptanceVerification: "integrated",
    },
  );
  assert.equal(loadedTask.evidence[0].ts, events[2].occurredAt);
  assert.equal(loaded.version, events.length);
  assert.equal(replayed.version, events.length);
});

test("v2 creation rejects malformed task contracts atomically while v1 replay remains isolated", () => {
  const valid = { objective: "Validate new task contracts", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } } };
  const invalids = [
    { tasks: [], taskDefs: {} }, { tasks: ["t1", "t1"] },
    { taskDefs: { t1: { ...valid.taskDefs.t1, deps: ["missing"] } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, deps: ["t1"] } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, writePaths: ["../escape"] } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, acceptance: { criteria: [], commands: ["true"] } } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, acceptance: { criteria: ["works"], commands: ["cd /tmp && true"] } } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, workflow: "unsupported" } } },
  ];
  for (const patch of invalids) {
    const before = createProjection();
    assert.throws(() => applyEvent(before, v2Event("goal.created", { ...valid, ...patch }, "contract-gate")), /task|taskDefs|deps|dep|cycle|path|acceptance|workflow|command/i);
    assert.equal(before.version, 0); assert.equal(before.tasks.size, 0);
  }
  const legacy = applyEvent(createProjection(), makeEvent("goal.created", { ...valid, tasks: ["t1", "t1"] }, "legacy-contract-replay"));
  assert.equal(legacy.tasks.size, 1);
});

test("v2 amendment cannot bypass task contract validation or empty the DAG", () => {
  const projection = applyEvent(createProjection(), v2Created("amend-contract-gate"));
  const before = structuredClone({ version: projection.version, tasks: [...projection.tasks] });
  for (const data of [
    { reason: "Reject unsafe updated path through new amendment validator", updateTasks: { t1: { writePaths: ["/tmp/x"] } } },
    { reason: "Reject empty DAG through new amendment validator contract", removeTasks: ["t1"] },
    { reason: "Reject invalid added workflow through new amendment validator", addTasks: { t2: { description: "task", deps: [], writePaths: ["x.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "bad" } } },
  ]) {
    assert.throws(() => applyEvent(projection, v2Event("goal.amended", data, "amend-contract-gate")), /path|task|workflow|empty/i);
    assert.deepEqual(structuredClone({ version: projection.version, tasks: [...projection.tasks] }), before);
  }
});
