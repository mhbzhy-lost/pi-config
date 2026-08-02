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

// v2 disposition invariant regressions (incremental to the restored v1 suite).
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
