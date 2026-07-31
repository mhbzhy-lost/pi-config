import assert from "node:assert/strict";
import test from "node:test";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, loadProjection, listGoals } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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
