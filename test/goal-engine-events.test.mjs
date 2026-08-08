import assert from "node:assert/strict";
import test from "node:test";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";
import { issueActionOffer, verifyAndConsumeActionOffer } from "../scripts/lib/goal-engine/action-offer.mjs";
import { appendEvent, loadProjection, listGoals } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

function applyLegacyEvent(projection, event) {
  return applyEvent(projection, event, { replay: true });
}

function replayLegacyCreate(event) {
  return applyLegacyEvent(createProjection(), event);
}

function plannedCriterion(id, statement = id, evidenceKinds = ["tests"]) {
  return { id, statement, evidenceKinds };
}

function plannedEvent(type, data, goalId = "planned-goal", occurredAt = "2026-08-08T00:00:00.000Z") {
  return { schemaVersion: "planned.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt, data };
}

test("v2 reducers have no ambient cwd dependency", () => {
  const source = readFileSync(new URL("../scripts/lib/goal-engine/events.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.cwd\s*\(/);
});

test("historical v2 JSONL replays task-contract-gated create and amend while new mutations remain strict", () => {
  const root = mkdtempSync(join(tmpdir(), "ge-legacy-v2-"));
  const goalId = "legacy-v2";
  const created = { schemaVersion: "goal-engine.event.v2", eventId: "legacy-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Restore historical v2 goal", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["cd /tmp && true"] }, workflow: "tdd" } } } };
  const amended = { schemaVersion: "goal-engine.event.v2", eventId: "legacy-amend", goalId, occurredAt: "2024-01-01T00:00:01.000Z", type: "goal.amended", data: { reason: "Correct historical task command for later recovery", updateTasks: { t1: { acceptance: { criteria: ["works"], commands: ["cd /var/tmp && true"] } } } } };
  const eventsPath = join(root, "goals", goalId, "events.jsonl");
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(eventsPath, `${JSON.stringify(created)}\n${JSON.stringify(amended)}\n`);

  assert.throws(() => applyEvent(createProjection(), created), /replay-only/);
  const safeCreated = structuredClone(created);
  safeCreated.eventId = "new-safe-create";
  safeCreated.data.taskDefs.t1.acceptance.commands = ["true"];
  const safeProjection = replayLegacyCreate(safeCreated);
  assert.throws(() => applyEvent(safeProjection, amended), /must not use absolute cd/);

  const replayed = loadProjection(root, goalId);
  assert.equal(replayed.version, 2);
  assert.equal(replayed.lifecycle, "active");
  assert.deepEqual(replayed.tasks.get("t1").acceptance.commands, ["cd /var/tmp && true"]);

  const appendRoot = mkdtempSync(join(tmpdir(), "ge-legacy-v2-append-"));
  const unsafeCreate = structuredClone(created);
  unsafeCreate.eventId = "new-unsafe-create";
  assert.throws(() => appendEvent(appendRoot, unsafeCreate, 0), /replay-only/);
  assert.equal(existsSync(join(appendRoot, "goals", goalId, "events.jsonl")), false);
  assert.equal(existsSync(join(appendRoot, "goals", goalId, "projection.json")), false);
  assert.equal(existsSync(join(appendRoot, "registry.json")), false);

  const appendEventsPath = join(appendRoot, "goals", goalId, "events.jsonl");
  mkdirSync(join(appendRoot, "goals", goalId), { recursive: true });
  writeFileSync(appendEventsPath, `${JSON.stringify(safeCreated)}\n`);
  const before = readFileSync(appendEventsPath, "utf8");
  const unsafeAmend = structuredClone(amended);
  unsafeAmend.eventId = "new-unsafe-amend";
  assert.throws(() => appendEvent(appendRoot, unsafeAmend, 1), /must not use absolute cd/);
  assert.equal(readFileSync(appendEventsPath, "utf8"), before);
  assert.equal(existsSync(join(appendRoot, "goals", goalId, "projection.json")), false);
  assert.equal(existsSync(join(appendRoot, "registry.json")), false);
});

test("historical v2 create replay rejects cyclic and unknown dependencies while retaining absolute-cd compatibility", () => {
  const root = mkdtempSync(join(tmpdir(), "ge-legacy-v2-dag-"));
  const makeCreated = (goalId, taskDefs) => ({
    schemaVersion: "goal-engine.event.v2", eventId: `${goalId}-create`, goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created",
    data: { objective: "Validate persisted historical task graph", scope: [], nonGoals: [], dod: [], tasks: Object.keys(taskDefs), taskDefs },
  });
  const task = (deps) => ({ description: "legacy task", deps, writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["cd /tmp && true"] }, workflow: "tdd" });
  for (const [goalId, taskDefs, error] of [
    ["legacy-v2-cycle", { a: task(["b"]), b: task(["a"]) }, /dependency cycle at a|dependency cycle at b/],
    ["legacy-v2-unknown", { a: task(["missing"]) }, /unknown dep: a depends on missing/],
  ]) {
    const eventsPath = join(root, "goals", goalId, "events.jsonl");
    mkdirSync(join(root, "goals", goalId), { recursive: true });
    writeFileSync(eventsPath, `${JSON.stringify(makeCreated(goalId, taskDefs))}\n`);
    assert.throws(() => loadProjection(root, goalId), error);
  }

  const compatibleGoalId = "legacy-v2-absolute-cd";
  const compatible = makeCreated(compatibleGoalId, { a: task([]) });
  mkdirSync(join(root, "goals", compatibleGoalId), { recursive: true });
  writeFileSync(join(root, "goals", compatibleGoalId, "events.jsonl"), `${JSON.stringify(compatible)}\n`);
  assert.deepEqual(loadProjection(root, compatibleGoalId).tasks.get("a").acceptance.commands, ["cd /tmp && true"]);
});

test("unsafe historical v2 create recovers atomically through a safe amendment", () => {
  const root = mkdtempSync(join(tmpdir(), "ge-legacy-v2-recover-"));
  const goalId = "legacy-v2-recovery";
  const created = { schemaVersion: "goal-engine.event.v2", eventId: "legacy-unsafe-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Recover a persisted unsafe historical command", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["cd /tmp && true"] }, workflow: "tdd" } } } };
  const eventsPath = join(root, "goals", goalId, "events.jsonl");
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(eventsPath, `${JSON.stringify(created)}\n`);
  const historical = loadProjection(root, goalId);
  assert.equal(historical.version, 1);

  const amended = { schemaVersion: "goal-engine.event.v2", eventId: "safe-amendment", goalId, occurredAt: "2024-01-01T00:00:01.000Z", type: "goal.amended", data: { reason: "Replace unsafe historical command with safe relative command", updateTasks: { t1: { acceptance: { criteria: ["works"], commands: ["npm test"] } } } } };
  const projection = appendEvent(root, amended, historical.version);
  const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
  const persisted = JSON.parse(readFileSync(join(root, "goals", goalId, "projection.json"), "utf8"));
  const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
  assert.equal(events.length, 2);
  assert.equal(events[1].eventId, "safe-amendment");
  assert.equal(projection.version, 2);
  assert.deepEqual(projection.tasks.get("t1").acceptance.commands, ["npm test"]);
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.tasks.t1.acceptance.commands, ["npm test"]);
  assert.equal(registry.goals[goalId].lifecycle, "active");
  assert.deepEqual(registry.active_goal_ids, [goalId]);
  assert.equal(registry.goals[goalId].objective, projection.objective);
  assert.equal(registry.goals[goalId].updatedAt, projection.updatedAt);
});

test("historical v1 and v2 workflow amendments replay deterministically with legacy-only workflow values", () => {
  const illegalWorkflow = "unsafe";

  const v2GoalId = "legacy-v2-workflow-replay";
  const v2Root = mkdtempSync(join(tmpdir(), "ge-legacy-v2-workflow-"));
  const v2Created = { schemaVersion: "goal-engine.event.v2", eventId: "legacy-workflow-v2-created", goalId: v2GoalId, occurredAt: "2024-02-01T00:00:00.000Z", type: "goal.created", data: { objective: "Replay workflow change in historical goal", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } } } };
  const v2Amended = { schemaVersion: "goal-engine.event.v2", eventId: "legacy-workflow-v2-amendment", goalId: v2GoalId, occurredAt: "2024-02-01T00:00:01.000Z", type: "goal.amended", data: { reason: "Retain existing historical workflow when strict validator evolves", updateTasks: { t1: { workflow: illegalWorkflow } } } };
  const v2EventsPath = join(v2Root, "goals", v2GoalId, "events.jsonl");
  mkdirSync(join(v2Root, "goals", v2GoalId), { recursive: true });
  writeFileSync(v2EventsPath, `${JSON.stringify(v2Created)}\n${JSON.stringify(v2Amended)}\n`);
  const v2ReplayA = loadProjection(v2Root, v2GoalId);
  const v2ReplayB = loadProjection(v2Root, v2GoalId);
  assert.equal(v2ReplayA.version, 2);
  assert.equal(v2ReplayA.tasks.get("t1").workflow, illegalWorkflow);
  assert.deepEqual(v2ReplayB.tasks.get("t1").workflow, v2ReplayA.tasks.get("t1").workflow);
  assert.deepEqual(v2ReplayB.tasks.get("t1"), v2ReplayA.tasks.get("t1"));

  const v1GoalId = "legacy-v1-workflow-replay";
  const v1Root = mkdtempSync(join(tmpdir(), "ge-legacy-v1-workflow-"));
  const v1Created = { schemaVersion: "goal-engine.event.v1", eventId: "legacy-workflow-v1-created", goalId: v1GoalId, occurredAt: "2024-02-02T00:00:00.000Z", type: "goal.created", data: { objective: "Replay legacy workflow change in historical goal", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } } } };
  const v1Amended = { schemaVersion: "goal-engine.event.v1", eventId: "legacy-workflow-v1-amendment", goalId: v1GoalId, occurredAt: "2024-02-02T00:00:01.000Z", type: "goal.amended", data: { reason: "Retain historical workflow update semantics while replaying", updateTasks: { t1: { workflow: illegalWorkflow } } } };
  const v1EventsPath = join(v1Root, "goals", v1GoalId, "events.jsonl");
  mkdirSync(join(v1Root, "goals", v1GoalId), { recursive: true });
  writeFileSync(v1EventsPath, `${JSON.stringify(v1Created)}\n${JSON.stringify(v1Amended)}\n`);
  const v1ReplayA = loadProjection(v1Root, v1GoalId);
  const v1ReplayB = loadProjection(v1Root, v1GoalId);
  assert.equal(v1ReplayA.version, 2);
  assert.equal(v1ReplayA.tasks.get("t1").workflow, illegalWorkflow);
  assert.deepEqual(v1ReplayB.tasks.get("t1").workflow, v1ReplayA.tasks.get("t1").workflow);
  assert.deepEqual(v1ReplayB.tasks.get("t1"), v1ReplayA.tasks.get("t1"));
});

test("planned create and amend reject pending tasks that cannot compile dispatch IR atomically", () => {
  const created = {
    objective: "Valid objective",
    scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: [plannedCriterion("works")] }, workflow: "tdd" } },
  };
  assert.throws(() => applyEvent(createProjection(), plannedEvent("goal.created", created, "g".repeat(160))), /taskId.*160/);
  assert.equal(createProjection().tasks.size, 0);

  const p = applyEvent(createProjection(), plannedEvent("goal.created", created));
  const before = p;
  assert.throws(() => applyEvent(p, plannedEvent("goal.amended", {
    reason: "Add a task whose derived requirements exceed the dispatch limit",
    updateTasks: { t1: { acceptance: { criteria: Array.from({ length: 32 }, (_, i) => plannedCriterion(`criterion-${i}`, `criterion ${i}`)) } } },
  })), /requirements.*32/);
  assert.equal(p, before);
  assert.equal(p.tasks.get("t1").acceptance.criteria.length, 1);
});

test("planned metadata-derived create and amendment gates leave projections atomic", () => {
  const task = { description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: [plannedCriterion("works")] }, workflow: "existing-tests" };
  const createCases = [
    ["objective", { objective: "o".repeat(4097), scope: [], nonGoals: [], dod: [] }],
    ["scope", { objective: "scope", scope: ["s".repeat(4090)], nonGoals: [], dod: [] }],
    ["nonGoals", { objective: "non-goals", scope: [], nonGoals: Array.from({ length: 33 }, (_, i) => `n${i}`), dod: [] }],
    ["dod", { objective: "dod", scope: [], nonGoals: [], dod: ["proof"], taskDefs: { t1: { ...task, acceptance: { criteria: Array.from({ length: 32 }, (_, i) => plannedCriterion(`c${i}`)) } } } }],
    ["composite", { objective: "composite", scope: [], nonGoals: [], dod: [], goalId: "g".repeat(160) }],
  ];
  for (const [name, data] of createCases) {
    const projection = createProjection();
    const event = plannedEvent("goal.created", { ...data, tasks: ["t1"], taskDefs: data.taskDefs || { t1: task } }, data.goalId || "metadata-goal");
    assert.throws(() => applyEvent(projection, event), /objective|knownFacts|decisions|requirements|taskId|4096|32|160/i, name);
    assert.equal(projection.version, 0, `${name} must not mutate the original projection`);
    assert.equal(projection.tasks.size, 0);
  }
  const projection = applyEvent(createProjection(), plannedEvent("goal.created", { objective: "amend", scope: [], nonGoals: [], dod: ["proof"], tasks: ["t1"], taskDefs: { t1: task } }));
  const before = structuredClone({ version: projection.version, tasks: [...projection.tasks] });
  assert.throws(() => applyEvent(projection, plannedEvent("goal.amended", { reason: "Derived requirements must remain bounded during amendment", updateTasks: { t1: { acceptance: { criteria: Array.from({ length: 32 }, (_, i) => plannedCriterion(`criterion-${i}`, `criterion ${i}`)) } } } })), /requirements.*32/i);
  assert.deepEqual(structuredClone({ version: projection.version, tasks: [...projection.tasks] }), before);
});

test("legacy v1 create replays oversized historical shapes unchanged", () => {
  const goalId = "g".repeat(160);
  const taskId = "t".repeat(160);
  const taskDefs = Object.fromEntries(Array.from({ length: 33 }, (_, i) => {
    const id = i === 0 ? taskId : `legacy-${i}`;
    return [id, { description: i === 0 ? "d".repeat(4097) : "legacy task", deps: [], writePaths: [i === 0 ? "../unsafe-path" : `src/${i}.ts`], acceptance: { criteria: [], commands: [] }, workflow: "legacy-workflow" }];
  }));
  const tasks = Object.keys(taskDefs);
  const projection = replayLegacyCreate(makeEvent("goal.created", { objective: "legacy", scope: [], nonGoals: [], dod: [], tasks, taskDefs }, goalId));
  assert.equal(projection.version, 1);
  assert.equal(projection.eventSchemaVersion, "goal-engine.event.v1");
  assert.equal(projection.tasks.size, 33);
  assert.deepEqual(projection.tasks.get(taskId), { description: "d".repeat(4097), deps: [], writePaths: ["../unsafe-path"], acceptance: { criteria: [], commands: [] }, workflow: "legacy-workflow", status: "pending", evidence: [], attempts: 0, lastSettledOutcome: null, contractHash: null, workspace: null, acceptanceVerification: null, settlement: null });
});

test("v2 create and amend replay identically across child-process cwd values", () => {
  const events = [
    { schemaVersion: "goal-engine.event.v2", eventId: "create", goalId: "cwd-replay", occurredAt: "2025-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "cwd replay", scope: ["src"], nonGoals: ["docs"], dod: ["proof"], tasks: ["t1"], taskDefs: { t1: { description: "first", deps: [], writePaths: ["src/a.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "existing-tests" } } } },
    { schemaVersion: "goal-engine.event.v2", eventId: "amend", goalId: "cwd-replay", occurredAt: "2025-01-01T00:00:01.000Z", type: "goal.amended", data: { reason: "Add an independently replayable pending task", addTasks: { t2: { description: "second", deps: ["t1"], writePaths: ["src/b.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "existing-tests" } } } },
  ];
  const moduleUrl = pathToFileURL(new URL("../scripts/lib/goal-engine/events.mjs", import.meta.url).pathname).href;
  const program = `const {createProjection,applyEvent}=await import(process.argv[1]); let p=createProjection(); for (const e of JSON.parse(process.argv[2])) p=applyEvent(p,e,{replay:p.version===0}); console.log(JSON.stringify({goalId:p.goalId,version:p.version,objective:p.objective,scope:p.scope,nonGoals:p.nonGoals,dod:p.dod,tasks:[...p.tasks]}));`;
  const first = mkdtempSync(join(tmpdir(), "ge-replay-a-"));
  const second = mkdtempSync(join(tmpdir(), "ge-replay-b-"));
  const replay = (cwd) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", program, moduleUrl, JSON.stringify(events)], { cwd, encoding: "utf8", env: { ...process.env, GOAL_ENGINE_REPLAY_CWD: cwd } }));
  assert.deepEqual(replay(first), replay(second));
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
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
  p = applyLegacyEvent(p, event);
  assert.throws(() => applyEvent(p, event), /duplicate eventId/);
});

test("terminal lifecycle rejects further events", () => {
  let p = createProjection();
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
    projection = applyLegacyEvent(projection, makeEvent("goal.created", {
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
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
  p = applyLegacyEvent(p, makeEvent("goal.created", {
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
  const amended = { schemaVersion: "goal-engine.event.v1", eventId: "remove-add-amended", goalId, occurredAt: "2025-02-04T05:06:08.000Z", type: "goal.amended", data: replacement };
  writeLegacyEventLog(root, goalId, [created, amended]);
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
  writeLegacyEventLog(root, goalId, [created]);
  const eventsPath = join(root, `goals/${goalId}/events.jsonl`);
  const projectionPath = join(root, `goals/${goalId}/projection.json`);
  const registryPath = join(root, "registry.json");
  const before = readFileSync(eventsPath, "utf8");

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
    assert.equal(readFileSync(eventsPath, "utf8"), before);
    assert.equal(existsSync(projectionPath), false);
    assert.equal(existsSync(registryPath), false);
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
  const amended = { schemaVersion: "goal-engine.event.v1", eventId: "fixed-amended", goalId, occurredAt: "2025-02-03T04:05:07.000Z", type: "goal.amended", data: amendmentData };
  writeLegacyEventLog(root, goalId, [created, amended]);
  const replayed = loadProjection(root, goalId);
  assert.equal(replayed.version, 2);
  assert.equal(replayed.tasks.get("t2").description, "updated new work");
  assert.deepEqual(replayed.tasks.get("t2").writePaths, ["updated-t2.ts"]);

  let v2 = replayLegacyCreate({ ...created, schemaVersion: "goal-engine.event.v2", eventId: "fixed-v2-created", goalId: "fixed-v2-add-update" });
  v2 = applyEvent(v2, { schemaVersion: "goal-engine.event.v2", eventId: "fixed-v2-amended", goalId: "fixed-v2-add-update", occurredAt: "2025-02-03T04:05:07.000Z", type: "goal.amended", data: amendmentData });
  assert.equal(v2.tasks.get("t2").description, "updated new work");
});

test("v2 dispatch requires downstream dependencies accepted", () => {
  const goalId = "dispatch-runnable-goal";
  let p = applyLegacyEvent(
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
  let p = applyLegacyEvent(
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
  let p = applyLegacyEvent(
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
  let p = applyLegacyEvent(
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

function writeLegacyEventLog(root, goalId, events) {
  const goalDir = join(root, "goals", goalId);
  mkdirSync(goalDir, { recursive: true });
  writeFileSync(join(goalDir, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);
}

test("appendEvent writes events.jsonl and projection.json", () => {
  const root = tmpRoot();
  const event = plannedEvent("goal.created", {
    objective: "Store test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: [plannedCriterion("x")] }, workflow: "tdd" } },
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
  const e1 = plannedEvent("goal.created", {
    objective: "Version test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: [plannedCriterion("x")] }, workflow: "tdd" } },
  }, "ver-goal");

  appendEvent(root, e1, 0);

  const e2 = plannedEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }, "ver-goal");
  assert.throws(
    () => appendEvent(root, e2, 0),
    /projection version conflict: expected 0, current 1/,
  );
});

test("loadProjection rebuilds from events.jsonl", () => {
  const root = tmpRoot();
  const e1 = plannedEvent("goal.created", {
    objective: "Load test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: [plannedCriterion("x")] }, workflow: "tdd" } },
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
  const projection = replayLegacyCreate(created);
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
  let projection = replayLegacyCreate(created);
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

  const e1 = plannedEvent("goal.created", {
    objective: "List test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: [plannedCriterion("x")] }, workflow: "tdd" } },
  }, "list-goal");

  appendEvent(root, e1, 0);
  assert.deepEqual(listGoals(root), ["list-goal"]);
});

// v2 disposition invariant regressions (incremental to the restored v1 suite).
test("amend rejects accepted and unreleased workspace tasks atomically", () => {
  const base = replayLegacyCreate(v2Created("amend-gate-goal"));
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
    { workflow: "docs-only" },
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
    for (const data of [{ removeTasks: ["t1"] }, { updateTasks: { t1: { workflow: "docs-only" } } }]) {
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

  const pending = replayLegacyCreate(v2Created("replacement-gate-goal"));
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
    const projection = replayLegacyCreate(v2Created("replacement-gate-goal"));
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
  let neverDispatched = replayLegacyCreate(v2Created("amend-allowed-goal"));
  neverDispatched = amend(neverDispatched, { updateTasks: { t1: { description: "changed" } } });
  assert.equal(neverDispatched.tasks.get("t1").description, "changed");
  const neverDispatchedRemoval = replayLegacyCreate(v2Created("amend-allowed-goal"));
  assert.throws(() => amend(neverDispatchedRemoval, { removeTasks: ["t1"] }), /non-empty|tasks/i);
  assert.equal(neverDispatchedRemoval.tasks.has("t1"), true);

  let released = replayLegacyCreate(v2Created("amend-allowed-goal"));
  released.tasks.get("t1").workspace = { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc", phase: "disposed", disposition: "discarded", released: true };
  released = amend(released, { updateTasks: { t1: { description: "changed again" } } });
  assert.equal(released.tasks.get("t1").description, "changed again");
  assert.throws(() => amend(released, { removeTasks: ["t1"] }), /non-empty|tasks/i);
  assert.equal(released.tasks.has("t1"), true);
});

test("workflow amendments apply to never-dispatched and discarded released pending tasks", () => {
  const snapshot = (projection) => structuredClone({ version: projection.version, tasks: [...projection.tasks] });
  const amend = (projection, data) => applyEvent(projection, v2Event("goal.amended", {
    reason: "Allow pending task workflow changes after workspace release",
    ...data,
  }, "amend-allowed-goal"));
  let neverDispatched = replayLegacyCreate(v2Created("amend-allowed-goal"));
  neverDispatched = amend(neverDispatched, { updateTasks: { t1: { workflow: "existing-tests" } } });
  assert.equal(neverDispatched.tasks.get("t1").workflow, "existing-tests");

  let released = replayLegacyCreate(v2Created("amend-allowed-goal"));
  released.tasks.get("t1").workspace = { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc", phase: "disposed", disposition: "discarded", released: true };
  released = amend(released, { updateTasks: { t1: { workflow: "docs-only" } } });
  assert.equal(released.tasks.get("t1").workflow, "docs-only");

  const invalid = replayLegacyCreate(v2Created("amend-allowed-goal"));
  const before = snapshot(invalid);
  assert.throws(() => amend(invalid, { updateTasks: { t1: { workflow: "unsafe" } } }), /workflow/i);
  assert.deepEqual(snapshot(invalid), before);
  assert.equal(invalid.tasks.get("t1").workflow, "tdd");
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
  return applyEvent(p, v2Event("task.settled", { taskId: "t1", outcome, evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria", ...(outcome === "succeeded" ? { attempt: 1, executorHead: "executor-head" } : {}) }, goalId));
}

function started(action, goalId = "v2-goal") {
  return v2Event("task.workspace_disposition_started", { taskId: "t1", attempt: 1, requestedAction: action, strategy: "merge", executorHead: "executor-head", originHeadBefore: "origin-before" }, goalId);
}

test("settlement identity strictly binds succeeded v2 attempt and HEAD", () => {
  const dispatched = v2Dispatched(replayLegacyCreate(v2Created()));
  const base = { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria" };
  assert.throws(() => applyEvent(dispatched, v2Event("task.settled", base)), /attempt|executorHead|settlement/i);
  assert.throws(() => applyEvent(dispatched, v2Event("task.settled", { ...base, attempt: 2, executorHead: "head-1" })), /attempt/i);
  const settled = applyEvent(dispatched, v2Event("task.settled", { ...base, attempt: 1, executorHead: "head-1" }));
  assert.deepEqual(settled.tasks.get("t1").settlement, { attempt: 1, executorHead: "head-1" });
  assert.throws(() => applyEvent(settled, started("integrate")), /settlement|executorHead/i);
  const matching = started("integrate"); matching.data.executorHead = "head-1";
  assert.doesNotThrow(() => applyEvent(settled, matching));
});

test("redispatch clears stale settlement identity", () => {
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created())));
  const task = p.tasks.get("t1");
  // A discarded settled task is the reducer's redispatchable recovery state.
  Object.assign(task.workspace, { phase: "disposed", disposition: "discarded", released: true });
  task.status = "pending";
  p = applyEvent(p, v2Event("task.dispatched", { taskId: "t1", contractHash: "h2", workspace: { attempt: 2, path: "/tmp/work-2", branch: "task/t1/2", baseCommit: "def" } }));
  assert.equal(p.tasks.get("t1").settlement, null);
});

test("schema downgrade rejects v1 accepted after a v2 event", () => {
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created())));
  assert.throws(() => applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }, "v2-goal")), /schema downgrade/);
});

test("legacy v1 history remains replayable and explicitly unverified", () => {
  let p = replayLegacyCreate(makeEvent("goal.created", { objective: "Legacy", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] } } } }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));
  p = applyEvent(p, makeEvent("goal.completed", { verdict: "COMPLETE" }));
  assert.equal(p.tasks.get("t1").acceptanceVerification, "legacy_unverified");
});

test("legacy v2 started without originRef replays with explicit legacy marker", () => {
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created())));
  p = applyEvent(p, started("integrate"));
  assert.equal(p.tasks.get("t1").workspace.legacyOriginRef, true);
  assert.equal(p.tasks.get("t1").workspace.originRef, undefined);
});

test("v2 started persists a valid originRef", () => {
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created())));
  const event = started("integrate"); event.data.originRef = "refs/heads/main";
  p = applyEvent(p, event);
  assert.equal(p.tasks.get("t1").workspace.originRef, "refs/heads/main");
  assert.equal(p.tasks.get("t1").workspace.legacyOriginRef, false);
});

test("workspace disposition rebase advances only the exact disposing origin identity", () => {
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created())));
  const start = started("integrate");
  start.data.originRef = "refs/heads/main";
  p = applyEvent(p, start);

  const rebase = (overrides = {}) => v2Event("task.workspace_disposition_rebased", {
    taskId: "t1",
    attempt: 1,
    previousOriginHeadBefore: "origin-before",
    originHeadBefore: "origin-forward",
    originRef: "refs/heads/main",
    reason: "clean-forward-origin-advance",
    ...overrides,
  });

  assert.throws(() => applyEvent(p, rebase({ attempt: 2 })), /attempt|workspace/i);
  assert.throws(() => applyEvent(p, rebase({ previousOriginHeadBefore: "wrong-old-head" })), /previous|origin.*head|identity/i);
  assert.throws(() => applyEvent(p, rebase({ originRef: "refs/heads/other" })), /origin.*ref|identity/i);
  assert.throws(() => applyEvent(p, rebase({ originHeadBefore: "origin-before" })), /advance|different|origin.*head/i);
  assert.throws(() => applyEvent(p, rebase({ reason: "agent-decided" })), /reason/i);

  p = applyEvent(p, rebase());
  const workspace = p.tasks.get("t1").workspace;
  assert.equal(workspace.phase, "disposing");
  assert.equal(workspace.originHeadBefore, "origin-forward");
  assert.equal(workspace.originRef, "refs/heads/main");
  assert.throws(() => applyEvent(p, rebase()), /previous|origin.*head|identity/i);
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
  writeLegacyEventLog(root, goalId, v1Events);
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
    v2("v2-settled", "2025-01-02T00:00:02.000Z", "task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/t1.ts" }, nextAction: "Review the fixed v2 task evidence before accepting the replay result", attempt: 1, executorHead: "executor" }),
    v2("v2-disposition-started", "2025-01-02T00:00:03.000Z", "task.workspace_disposition_started", { taskId: "t1", attempt: 1, requestedAction: "integrate", strategy: "merge", executorHead: "executor", originHeadBefore: "origin" }),
    v2("v2-disposition-applied", "2025-01-02T00:00:04.000Z", "task.workspace_disposition_applied", { taskId: "t1", attempt: 1, action: "integrate", strategy: "merge", executorHead: "executor", originHead: "origin-after" }),
    v2("v2-disposed", "2025-01-02T00:00:05.000Z", "task.workspace_disposed", { taskId: "t1", attempt: 1, action: "integrate", released: true }),
    v2("v2-accepted", "2025-01-02T00:00:06.000Z", "task.accepted", { taskId: "t1", workspaceAttempt: 1 }),
  ];
  let v2Projection = createProjection();
  for (const [index, item] of v2Events.entries()) v2Projection = applyEvent(v2Projection, item, { replay: index === 0 });
  const before = structuredClone({ version: v2Projection.version, tasks: [...v2Projection.tasks] });
  assert.throws(() => applyEvent(v2Projection, v2("v2-amended", "2025-01-02T00:00:07.000Z", "goal.amended", { reason: "Reject rewriting accepted v2 task proof after the contract freeze", updateTasks: { t1: { acceptance: { criteria: ["rewritten"], commands: ["false"] } } } })), /pending|accepted|amend/i);
  assert.deepEqual(structuredClone({ version: v2Projection.version, tasks: [...v2Projection.tasks] }), before);
});

test("disposition requires settled status and compatible outcome", () => {
  let p = v2Dispatched(replayLegacyCreate(v2Created()));
  for (const action of ["integrate", "discard", "preserve"]) assert.throws(() => applyEvent(p, started(action)), /settled|status|succeeded/);
  p = v2Settled(p, "failed");
  assert.throws(() => applyEvent(p, started("integrate")), /succeeded/);
  for (const action of ["discard", "preserve"]) assert.doesNotThrow(() => applyEvent(p, started(action)));
  let blocked = v2Settled(v2Dispatched(replayLegacyCreate(v2Created("blocked-goal")), "blocked-goal"), "blocked", "blocked-goal");
  assert.throws(() => applyEvent(blocked, started("integrate", "blocked-goal")), /succeeded/);
  for (const action of ["discard", "preserve"]) assert.doesNotThrow(() => applyEvent(blocked, started(action, "blocked-goal")));
});

test("disposition applied preserves started identity", () => {
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created())));
  const start = started("integrate");
  p = applyEvent(p, start);
  const data = { ...start.data, action: "integrate", originHead: "origin-after" };
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...data, strategy: "rebase" })), /strategy/);
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...data, executorHead: "other-head" })), /executorHead/);
});

test("discarded succeeded resets pending and pending remains pending", () => {
  for (const outcome of ["succeeded", "failed"]) {
    let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(`${outcome}-goal`)), `${outcome}-goal`), outcome, `${outcome}-goal`);
    const start = started("discard", `${outcome}-goal`);
    p = applyEvent(p, start);
    p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "discard", originHead: "origin-after" }, `${outcome}-goal`));
    p = applyEvent(p, v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "discard", released: true }, `${outcome}-goal`));
    assert.equal(p.tasks.get("t1").status, "pending");
  }
});

test("v1 projection upgrades on v2 and rejects every later v1 event", () => {
  let p = replayLegacyCreate(makeEvent("goal.created", { objective: "Upgrade", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] } } } }));
  p = applyEvent(p, v2Event("task.dispatched", { taskId: "t1", contractHash: "h1", workspace: { attempt: 1, path: "/tmp/work", branch: "task/t1", baseCommit: "abc" } }, "test-goal"));
  assert.equal(p.eventSchemaVersion, "goal-engine.event.v2");
  assert.throws(() => applyEvent(p, makeEvent("goal.checkpoint", { nextAction: "Verify the complete implementation meets the required acceptance criteria" })), /schema downgrade/);
});

test("disposition applied retains attempt phase and action gates", () => {
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created())));
  const start = started("integrate"); p = applyEvent(p, start);
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, attempt: 2, action: "integrate", originHead: "origin-after" })), /attempt/);
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "discard", originHead: "origin-after" })), /action/);
  p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "integrate", originHead: "origin-after" }));
  assert.throws(() => applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "integrate", originHead: "origin-after" })), /disposing/);
});

test("redispatch attempt2 is rejected after failed settle when active workspace is still attempt1", () => {
  const goalId = "failed-active-redispatch-goal";
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(goalId)), goalId), "failed", goalId);
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
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(goalId)), goalId), "failed", goalId);

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
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(goalId)), goalId), "failed", goalId);
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
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(goalId)), goalId), "succeeded", goalId);

  const start = started("preserve", goalId);
  p = applyEvent(p, start);
  p = applyEvent(p, v2Event("task.workspace_disposition_applied", { ...start.data, action: "preserve", originHead: "origin-after" }, goalId));
  p = applyEvent(p, v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "preserve", released: false }, goalId));

  assert.throws(() => applyEvent(p, v2Event("task.accepted", { taskId: "t1", workspaceAttempt: 1 }, goalId)), /workspace must be disposed, integrated, and released before acceptance/);
});

test("terminal dispose event is rejected when terminal state already emitted", () => {
  const goalId = "terminal-dispose-repeat-goal";
  let p = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(goalId)), goalId), "succeeded", goalId);
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
        attempt: 1,
        executorHead: "executor-head",
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

  for (const [index, event] of events.entries()) {
    replayed = applyEvent(replayed, event, { replay: index === 0 });
  }

  for (const [index, event] of events.entries()) {
    replayedTwice = applyEvent(replayedTwice, event, { replay: index === 0 });
  }

  assert.deepEqual(replayed, replayedTwice);
  assert.deepEqual(expectedEvents, events);
  const root = tmpRoot();
  writeLegacyEventLog(root, goalId, events);
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

test("planned creation rejects malformed task contracts atomically while v1 replay remains isolated", () => {
  const valid = { objective: "Validate new task contracts", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: [plannedCriterion("works")] }, workflow: "tdd" } } };
  const invalids = [
    { tasks: [], taskDefs: {} }, { tasks: ["t1", "t1"] },
    { taskDefs: { t1: { ...valid.taskDefs.t1, deps: ["missing"] } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, deps: ["t1"] } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, writePaths: ["../escape"] } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, acceptance: { criteria: [] } } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, acceptance: { criteria: [plannedCriterion("works")], commands: ["true"] } } } },
    { taskDefs: { t1: { ...valid.taskDefs.t1, workflow: "unsupported" } } },
  ];
  for (const patch of invalids) {
    const before = createProjection();
    assert.throws(() => applyEvent(before, plannedEvent("goal.created", { ...valid, ...patch }, "contract-gate")), /task|taskDefs|deps|dep|cycle|path|acceptance|workflow|command/i);
    assert.equal(before.version, 0); assert.equal(before.tasks.size, 0);
  }
  const legacyTask = { ...valid.taskDefs.t1, acceptance: { criteria: ["works"], commands: ["true"] } };
  const legacy = replayLegacyCreate(makeEvent("goal.created", { ...valid, tasks: ["t1", "t1"], taskDefs: { t1: legacyTask } }, "legacy-contract-replay"));
  assert.equal(legacy.tasks.size, 1);
});

test("v2 amendment cannot bypass task contract validation or empty the DAG", () => {
  const projection = replayLegacyCreate(v2Created("amend-contract-gate"));
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

test("historical settled replay retains legacy settlement marker while strict v2 mutations require an exact binding", () => {
  const root = mkdtempSync(join(tmpdir(), "ge-settlement-history-"));
  const goalId = "historical-settled-identity";
  const events = [
    fixedV2Event("goal.created", v2Created(goalId).data, goalId, "2024-01-01T00:00:00.000Z", "history-created"),
    fixedV2Event("task.dispatched", { taskId: "t1", contractHash: "h", workspace: { attempt: 1, path: "/tmp/history", branch: "ge/history/t1/1", baseCommit: "base" } }, goalId, "2024-01-01T00:00:01.000Z", "history-dispatched"),
    fixedV2Event("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria" }, goalId, "2024-01-01T00:00:02.000Z", "history-settled"),
  ];
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);
  const replayed = loadProjection(root, goalId);
  assert.equal(replayed.tasks.get("t1").status, "succeeded");
  assert.equal(replayed.tasks.get("t1").settlement ?? null, null);
  for (const action of ["integrate", "discard", "preserve"]) {
    assert.throws(() => applyEvent(replayed, { ...started(action, goalId), eventId: crypto.randomUUID() }), /settlement|identity|attempt|executorHead/i);
  }
  assert.throws(() => appendEvent(root, v2Event("task.workspace_disposition_started", { ...started("integrate", goalId).data }, goalId), replayed.version), /settlement|identity|attempt|executorHead/i);
});

function replaySettlementHistory(goalId, settlementIdentity = {}, startedIdentity = null) {
  const root = mkdtempSync(join(tmpdir(), "ge-settlement-replay-matrix-"));
  const events = [
    fixedV2Event("goal.created", v2Created(goalId).data, goalId, "2024-01-01T00:00:00.000Z", `${goalId}-created`),
    fixedV2Event("task.dispatched", { taskId: "t1", contractHash: "h", workspace: { attempt: 1, path: "/tmp/history", branch: "ge/history/t1/1", baseCommit: "base", originRef: "refs/heads/main" } }, goalId, "2024-01-01T00:00:01.000Z", `${goalId}-dispatched`),
    fixedV2Event("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Verify the complete implementation meets the required acceptance criteria", ...settlementIdentity }, goalId, "2024-01-01T00:00:02.000Z", `${goalId}-settled`),
  ];
  if (startedIdentity) events.push(fixedV2Event("task.workspace_disposition_started", { taskId: "t1", attempt: 1, requestedAction: "integrate", strategy: "merge", executorHead: "executor-head", originHeadBefore: "origin-before", ...startedIdentity }, goalId, "2024-01-01T00:00:03.000Z", `${goalId}-started`));
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);
  return loadProjection(root, goalId);
}

test("historical pre-gate v2 unbound settlement and started disposition remain replayable", () => {
  const projection = replaySettlementHistory("unbound-started-replay", {}, {});
  const task = projection.tasks.get("t1");
  assert.equal(task.status, "succeeded");
  assert.equal(task.settlement ?? null, null);
  assert.equal(task.workspace.phase, "disposing");
  assert.equal(task.workspace.requestedAction, "integrate");
});

test("historical v2 complete settlement binding replays and remains exact through disposition", () => {
  const projection = replaySettlementHistory("bound-started-replay", { attempt: 1, executorHead: "executor-head" }, {});
  const task = projection.tasks.get("t1");
  assert.deepEqual(task.settlement, { attempt: 1, executorHead: "executor-head" });
  assert.equal(task.workspace.phase, "disposing");
});

test("historical v2 half-bound settlement identity fails closed", () => {
  for (const [goalId, identity] of [
    ["attempt-only-settlement", { attempt: 1 }],
    ["head-only-settlement", { executorHead: "executor-head" }],
  ]) assert.throws(() => replaySettlementHistory(goalId, identity), /settlement|attempt|executorHead|identity/i);
});

test("historical v2 contradictory settlement and disposition identities fail closed", () => {
  assert.throws(() => replaySettlementHistory("wrong-settlement-attempt", { attempt: 2, executorHead: "executor-head" }), /settlement|attempt|workspace|identity/i);
  assert.throws(() => replaySettlementHistory("wrong-started-head", { attempt: 1, executorHead: "executor-head" }, { executorHead: "different-head" }), /settlement|executorHead|identity|mismatch/i);
});

test("historical v1 dispatched and succeeded settled JSONL remains readable", () => {
  const root = mkdtempSync(join(tmpdir(), "ge-v1-settled-replay-"));
  const goalId = "v1-dispatched-succeeded";
  const created = { schemaVersion: "goal-engine.event.v1", eventId: "created", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Legacy dispatched settlement", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } } } };
  const dispatched = { schemaVersion: "goal-engine.event.v1", eventId: "dispatched", goalId, occurredAt: "2024-01-01T00:00:01.000Z", type: "task.dispatched", data: { taskId: "t1", contractHash: "legacy" } };
  const settled = { schemaVersion: "goal-engine.event.v1", eventId: "settled", goalId, occurredAt: "2024-01-01T00:00:02.000Z", type: "task.settled", data: { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Review the legacy settled evidence and choose integration or preservation based on verification" } };
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${[created, dispatched, settled].map(JSON.stringify).join("\n")}\n`);
  const projection = loadProjection(root, goalId);
  assert.equal(projection.version, 3);
  assert.equal(projection.tasks.get("t1").status, "succeeded");
  assert.equal(projection.tasks.get("t1").settlement ?? null, null);
});

test("strict disposition settlement identity matrix permits only matching succeeded bindings", () => {
  for (const action of ["integrate", "discard", "preserve"]) {
    const succeeded = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(`strict-${action}`)), `strict-${action}`), "succeeded", `strict-${action}`);
    for (const mutation of [
      (event) => { delete event.data.executorHead; },
      (event) => { event.data.attempt = 2; },
      (event) => { event.data.executorHead = "wrong-head"; },
    ]) {
      const event = started(action, `strict-${action}`); mutation(event);
      assert.throws(() => applyEvent(succeeded, event), /settlement|attempt|executorHead|identity/i, `${action} must reject mismatched succeeded settlement`);
    }
    assert.doesNotThrow(() => applyEvent(succeeded, started(action, `strict-${action}`)));
  }
  for (const outcome of ["failed", "blocked"]) for (const action of ["discard", "preserve"]) {
    const goalId = `${outcome}-${action}-unbound`;
    const projection = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(goalId)), goalId), outcome, goalId);
    assert.doesNotThrow(() => applyEvent(projection, started(action, goalId)));
  }
});

function eventSnapshot(projection) {
  return structuredClone({
    version: projection.version,
    lifecycle: projection.lifecycle,
    eventIds: [...projection.eventIds],
    tasks: [...projection.tasks],
  });
}

function orphanRecoveredEvent(data = {}, goalId = "orphan-recovery-goal", schemaVersion = "goal-engine.event.v2") {
  return {
    schemaVersion,
    eventId: crypto.randomUUID(),
    goalId,
    type: "task.workspace_orphan_recovered",
    occurredAt: "2026-02-03T04:05:06.000Z",
    data: {
      taskId: "t1",
      attempt: 1,
      workspace: {
        attempt: 1,
        path: "/tmp/recovered",
        branch: "ge/t1/1",
        baseCommit: "base-1",
        originRef: "refs/heads/main",
      },
      executorHead: "recovered-head",
      reason: "Verified orphan workspace recovery before resource cleanup.",
      ...data,
    },
  };
}

function orphanRecoveryBaseline(goalId = "orphan-recovery-goal") {
  return replayLegacyCreate(v2Created(goalId));
}

function discardAttemptOne(goalId = "orphan-attempt-two-goal") {
  let projection = v2Dispatched(orphanRecoveryBaseline(goalId), goalId);
  projection = v2Settled(projection, "failed", goalId);
  const discard = started("discard", goalId);
  projection = applyEvent(projection, discard);
  projection = applyEvent(projection, v2Event(
    "task.workspace_disposition_applied",
    { ...discard.data, action: "discard", originHead: "origin-after" },
    goalId,
  ));
  return applyEvent(projection, v2Event(
    "task.workspace_disposed",
    { taskId: "t1", attempt: 1, action: "discard", released: true },
    goalId,
  ));
}

function workspaceIdentity(projection) {
  const task = projection.tasks.get("t1");
  return { goalId: projection.goalId, taskId: "t1", attempt: task.workspace.attempt, executorHead: task.workspace.executorHead };
}

function preservationReleasedEvent(projection, data = {}, schemaVersion = "goal-engine.event.v2") {
  const identity = workspaceIdentity(projection);
  return {
    schemaVersion,
    eventId: crypto.randomUUID(),
    goalId: identity.goalId,
    type: "task.workspace_preservation_released",
    occurredAt: "2026-02-03T04:05:07.000Z",
    data: { taskId: identity.taskId, attempt: identity.attempt, executorHead: identity.executorHead, released: true, ...data },
  };
}

function dispositionStartedEvent(projection, requestedAction, executorHead = workspaceIdentity(projection).executorHead) {
  const identity = workspaceIdentity(projection);
  return v2Event("task.workspace_disposition_started", {
    taskId: identity.taskId,
    attempt: identity.attempt,
    requestedAction,
    strategy: "merge",
    executorHead,
    originHeadBefore: "origin-before",
  }, identity.goalId);
}

function preserveWorkspace(projection, goalId, executorHead) {
  const task = projection.tasks.get("t1");
  const disposition = v2Event("task.workspace_disposition_started", {
    taskId: "t1",
    attempt: task.workspace.attempt,
    requestedAction: "preserve",
    strategy: "merge",
    executorHead,
    originHeadBefore: "origin-before",
  }, goalId);
  projection = applyEvent(projection, disposition);
  projection = applyEvent(projection, v2Event("task.workspace_disposition_applied", {
    ...disposition.data,
    action: "preserve",
    originHead: "origin-after",
  }, goalId));
  return applyEvent(projection, v2Event("task.workspace_disposed", {
    taskId: "t1",
    attempt: task.workspace.attempt,
    action: "preserve",
    released: false,
  }, goalId));
}

function preservedReleaseFixture(goalId = "preservation-release-goal", kind = "succeeded") {
  if (kind === "recovered-pending") {
    const recovered = applyEvent(orphanRecoveryBaseline(goalId), orphanRecoveredEvent({}, goalId));
    return preserveWorkspace(recovered, goalId, "recovered-head");
  }
  let projection = v2Dispatched(orphanRecoveryBaseline(goalId), goalId);
  projection = v2Settled(projection, "succeeded", goalId);
  return preserveWorkspace(projection, goalId, "executor-head");
}

test("orphan recovery restores the Task4 attempt-one rollback baseline", () => {
  const baseline = orphanRecoveryBaseline();
  assert.deepEqual(baseline.tasks.get("t1").workspace, null);
  assert.equal(baseline.tasks.get("t1").status, "pending");
  assert.equal(baseline.tasks.get("t1").attempts, 0);

  const recovered = applyEvent(baseline, orphanRecoveredEvent());
  const task = recovered.tasks.get("t1");
  assert.equal(task.status, "pending");
  assert.equal(task.attempts, 1);
  assert.equal(task.lastSettledOutcome, "failed");
  assert.equal(task.settlement, null);
  assert.deepEqual(task.workspace, {
    attempt: 1,
    path: "/tmp/recovered",
    branch: "ge/t1/1",
    baseCommit: "base-1",
    originRef: "refs/heads/main",
    executorHead: "recovered-head",
    phase: "active",
    recovery: "orphaned",
  });
});

test("orphan recovery accepts attempt two after a real failed-discard chain", () => {
  const projection = discardAttemptOne();
  assert.equal(projection.tasks.get("t1").attempts, 1);
  assert.equal(projection.tasks.get("t1").workspace.released, true);

  const recovered = applyEvent(projection, orphanRecoveredEvent({
    attempt: 2,
    workspace: {
      attempt: 2,
      path: "/tmp/recovered-two",
      branch: "ge/t1/2",
      baseCommit: "base-2",
      originRef: "refs/heads/main",
    },
  }, projection.goalId));
  assert.equal(recovered.tasks.get("t1").attempts, 2);
  assert.equal(recovered.tasks.get("t1").workspace.attempt, 2);
});

test("orphan recovery rejects invalid states and exact-shape data atomically", () => {
  const cases = [
    ["v1", () => [orphanRecoveryBaseline(), orphanRecoveredEvent({}, undefined, "goal-engine.event.v1")]],
    ["wrong attempt", () => [orphanRecoveryBaseline(), orphanRecoveredEvent({ attempt: 2 })]],
    ["workspace attempt mismatch", () => [orphanRecoveryBaseline(), orphanRecoveredEvent({ workspace: { ...orphanRecoveredEvent().data.workspace, attempt: 2 } })]],
    ["missing executorHead", () => { const event = orphanRecoveredEvent(); delete event.data.executorHead; return [orphanRecoveryBaseline(), event]; }],
    ["missing reason", () => { const event = orphanRecoveredEvent(); delete event.data.reason; return [orphanRecoveryBaseline(), event]; }],
    ["unknown data field", () => [orphanRecoveryBaseline(), orphanRecoveredEvent({ unexpected: true })]],
    ["unknown workspace field", () => [orphanRecoveryBaseline(), orphanRecoveredEvent({ workspace: { ...orphanRecoveredEvent().data.workspace, unexpected: true } })]],
    ...["path", "branch", "baseCommit", "originRef"].map((field) => [
      `missing workspace ${field}`,
      () => {
        const event = orphanRecoveredEvent();
        delete event.data.workspace[field];
        return [orphanRecoveryBaseline(), event];
      },
    ]),
    ["nonpending dispatched", () => {
      const projection = orphanRecoveryBaseline();
      return [v2Dispatched(projection, projection.goalId), orphanRecoveredEvent({}, projection.goalId)];
    }],
    ["active workspace", () => {
      const projection = orphanRecoveryBaseline();
      return [v2Dispatched(projection, projection.goalId), orphanRecoveredEvent({}, projection.goalId)];
    }],
    ["terminal goal", () => {
      const projection = orphanRecoveryBaseline();
      return [applyEvent(projection, v2Event("goal.blocked", {
        reason: "Stop recovery after a verified terminal operational incident.",
      }, projection.goalId)), orphanRecoveredEvent({}, projection.goalId)];
    }],
  ];

  for (const [label, makeCase] of cases) {
    const [projection, event] = makeCase();
    const before = eventSnapshot(projection);
    assert.throws(() => applyEvent(projection, event), /unsupported|v2|attempt|workspace|pending|terminal|unknown|field/i, label);
    assert.deepEqual(eventSnapshot(projection), before, label);
  }
});

test("orphan recovery duplicate follows a real first recovery", () => {
  const recovered = applyEvent(orphanRecoveryBaseline(), orphanRecoveredEvent());
  const duplicate = orphanRecoveredEvent({}, recovered.goalId);
  const before = eventSnapshot(recovered);
  assert.throws(() => applyEvent(recovered, duplicate), /duplicate|recovery|workspace|active/i);
  assert.deepEqual(eventSnapshot(recovered), before);
});

test("orphan recovery store round-trip uses only legal history before recovery", () => {
  const root = tmpRoot();
  let projection = discardAttemptOne("orphan-store");
  const recovery = orphanRecoveredEvent({ attempt: 2, workspace: { attempt: 2, path: "/tmp/recovered-two", branch: "ge/t1/2", baseCommit: "base-2", originRef: "refs/heads/main" } }, "orphan-store");
  projection = applyEvent(projection, recovery);
  const history = [
    v2Created("orphan-store"),
    v2Event("task.dispatched", { taskId: "t1", contractHash: "h1", workspace: { attempt: 1, path: "/tmp/work", branch: "ge/t1/1", baseCommit: "base-1" } }, "orphan-store"),
    v2Event("task.settled", { taskId: "t1", outcome: "failed", evidence: { type: "file", path: "a.ts" }, nextAction: "Discard the failed workspace before attempting any recovery action." }, "orphan-store"),
  ];
  const discard = started("discard", "orphan-store");
  history.push(discard, v2Event("task.workspace_disposition_applied", { ...discard.data, action: "discard", originHead: "origin-after" }, "orphan-store"), v2Event("task.workspace_disposed", { taskId: "t1", attempt: 1, action: "discard", released: true }, "orphan-store"), recovery);
  writeLegacyEventLog(root, "orphan-store", history);
  assert.deepEqual(loadProjection(root, "orphan-store").tasks.get("t1"), projection.tasks.get("t1"));
});

function assertReleasedPreservation(task) {
  assert.equal(task.status, "pending");
  assert.equal(task.settlement, null);
  assert.equal(task.workspace.disposition, "preserved");
  assert.equal(task.workspace.released, false);
  assert.equal(task.workspace.preservedResourcesReleased, true);
  assert.equal(Object.hasOwn(task, "preservedResourcesReleased"), false);
}

test("preservation release follows the normal succeeded preserve chain", () => {
  const projection = preservedReleaseFixture("release-succeeded", "succeeded");
  const task = applyEvent(projection, preservationReleasedEvent(projection)).tasks.get("t1");
  assertReleasedPreservation(task);
});

test("preservation release follows the recovered pending preserve chain", () => {
  const projection = preservedReleaseFixture("release-recovered", "recovered-pending");
  const task = applyEvent(projection, preservationReleasedEvent(projection)).tasks.get("t1");
  assertReleasedPreservation(task);
});

test("preservation release rejects invalid exact-shape data atomically", () => {
  const cases = [
    ["v1", (projection) => preservationReleasedEvent(projection, {}, "goal-engine.event.v1")],
    ["unknown field", (projection) => preservationReleasedEvent(projection, { unexpected: true })],
    ["wrong attempt", (projection) => preservationReleasedEvent(projection, { attempt: 2 })],
    ["wrong head", (projection) => preservationReleasedEvent(projection, { executorHead: "other-head" })],
    ["wrong released", (projection) => preservationReleasedEvent(projection, { released: false })],
  ];
  for (const [label, makeEvent] of cases) {
    const projection = preservedReleaseFixture();
    const before = eventSnapshot(projection);
    assert.throws(() => applyEvent(projection, makeEvent(projection)), /unsupported|v2|preserv|attempt|executorHead|released|unknown/i, label);
    assert.deepEqual(eventSnapshot(projection), before, label);
  }
});

test("preservation release rejects wrong workspace phase, disposition, duplicate, and v1", () => {
  const cases = [
    ["wrong phase", (projection) => { projection.tasks.get("t1").workspace.phase = "active"; }],
    ["wrong disposition", (projection) => { projection.tasks.get("t1").workspace.disposition = "discarded"; }],
    ["duplicate", (projection) => { projection.tasks.get("t1").workspace.preservedResourcesReleased = true; }],
  ];
  for (const [label, tamper] of cases) {
    const projection = preservedReleaseFixture();
    tamper(projection);
    const before = eventSnapshot(projection);
    assert.throws(() => applyEvent(projection, preservationReleasedEvent(projection)), /unsupported|preserv|disposed|released/i, label);
    assert.deepEqual(eventSnapshot(projection), before, label);
  }
});

test("orphan recovery binds later disposition starts to the recovered HEAD", () => {
  const recovered = applyEvent(orphanRecoveryBaseline(), orphanRecoveredEvent());
  for (const action of ["discard", "preserve"]) {
    const before = eventSnapshot(recovered);
    assert.throws(() => applyEvent(recovered, dispositionStartedEvent(recovered, action, "wrong-head")), /unsupported|executorHead|identity/i);
    assert.deepEqual(eventSnapshot(recovered), before);
    assert.doesNotThrow(() => applyEvent(recovered, dispositionStartedEvent(recovered, action)));
  }
});

test("preserved work becomes amendable and redispatchable only after preservation release", () => {
  let projection = preservedReleaseFixture("release-availability", "succeeded");
  const amendEvent = () => v2Event("goal.amended", {
    reason: "Allow the safely released preserved task to receive a revised description.",
    updateTasks: { t1: { description: "released preserved work" } },
  }, projection.goalId);
  const dispatchEvent = () => v2Event("task.dispatched", {
    taskId: "t1", contractHash: "h2",
    workspace: { attempt: 2, path: "/tmp/work-2", branch: "task/t1/2", baseCommit: "def" },
  }, projection.goalId);
  assert.throws(() => applyEvent(projection, amendEvent()), /non-pending|succeeded|preserv|released|workspace/i);
  assert.throws(() => applyEvent(projection, dispatchEvent()), /status|pending|succeeded|preserv|released|workspace/i);
  projection = applyEvent(projection, preservationReleasedEvent(projection));
  assert.equal(projection.tasks.get("t1").status, "pending");
  assert.equal(projection.tasks.get("t1").settlement, null);
  projection = applyEvent(projection, amendEvent());
  assert.equal(projection.tasks.get("t1").description, "released preserved work");
  assert.equal(applyEvent(projection, dispatchEvent()).tasks.get("t1").attempts, 2);
});

function v3Event(type, data, goalId = "test-goal", occurredAt = "2026-08-05T00:00:00.000Z") {
  return { schemaVersion: "goal-engine.event.v3", eventId: crypto.randomUUID(), goalId, type, occurredAt, data };
}

function completedEpochProjection() {
  let projection = createProjection();
  projection = applyLegacyEvent(projection, makeEvent("goal.created", {
    objective: "Preserve a completed milestone while accepting follow-up work",
    scope: ["src/"], nonGoals: [], dod: ["All accepted evidence remains immutable"],
    tasks: ["t1"],
    taskDefs: { t1: { description: "original work", deps: [], writePaths: ["src/a.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } },
  }));
  projection = applyEvent(projection, makeEvent("goal.checkpoint", {
    nextAction: "Dispatch the original task after checking the authoritative status",
  }));
  projection = applyEvent(projection, makeEvent("task.dispatched", { taskId: "t1", contractHash: "legacy-contract" }));
  projection = applyEvent(projection, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/a.ts" },
    evidenceSource: "self_produced", nextAction: "Accept the original task after reviewing its evidence carefully",
  }));
  projection = applyEvent(projection, makeEvent("task.accepted", { taskId: "t1" }));
  return applyEvent(projection, makeEvent("goal.completed", { verdict: "COMPLETE" }));
}

test("completed goal clears stale actions and records immutable epoch history", () => {
  const projection = completedEpochProjection();

  assert.equal(projection.lifecycle, "completed");
  assert.equal(projection.epoch, 1);
  assert.equal(projection.nextAction, null);
  assert.equal(projection.blockedReason, null);
  assert.equal(projection.actionOffer, null);
  assert.deepEqual(projection.completionHistory, [{
    epoch: 1,
    verdict: "COMPLETE",
    completedAt: projection.updatedAt,
    eventVersion: projection.version,
  }]);
  assert.equal(projection.coordinationState, "quiescent");
});

test("completed goal records discovery and reopens into a new immutable epoch", () => {
  let projection = completedEpochProjection();
  projection = applyEvent(projection, v3Event("goal.session_bound", { sessionId: "session-1", leafId: "leaf-1" }));
  projection = applyEvent(projection, v3Event("goal.discovery_recorded", {
    id: "obs-1", summary: "Follow up the completed implementation", paths: ["src/b.ts"],
    source: "user_intent", sessionId: "session-1", userEntryId: "entry-1",
  }));
  projection = applyEvent(projection, v3Event("goal.discovery_resolved", {
    id: "obs-1", disposition: "tasked", taskId: "t2", reason: "The follow-up belongs to this goal",
  }));
  projection = applyEvent(projection, v3Event("goal.reopened", {
    reason: "Turn the related follow-up into a new task", observationIds: ["obs-1"],
  }));
  projection = applyEvent(projection, v3Event("goal.amended", {
    reason: "Add the follow-up task without changing accepted history",
    addTasks: { t2: { description: "follow-up", deps: ["t1"], writePaths: ["src/b.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } },
  }));

  assert.equal(projection.lifecycle, "active");
  assert.equal(projection.epoch, 2);
  assert.equal(projection.tasks.get("t1").status, "accepted");
  assert.equal(projection.tasks.get("t1").evidence.length, 1);
  assert.equal(projection.tasks.get("t2").status, "pending");
  assert.equal(projection.continuity.observations["obs-1"].status, "tasked");
  assert.equal(projection.continuity.observations["obs-1"].taskId, "t2");
  assert.equal(projection.completionHistory.length, 1);

  assert.throws(() => applyEvent(projection, v3Event("goal.amended", {
    reason: "Accepted task definitions must remain frozen forever",
    updateTasks: { t1: { description: "rewrite history" } },
  })), /non-pending|accepted/);
  assert.throws(() => applyEvent(projection, v3Event("goal.amended", {
    reason: "Accepted tasks cannot be removed from a later epoch",
    removeTasks: ["t1"],
  })), /non-pending|accepted/);
});

test("reopen rejects untriaged discoveries and non-accepted historical tasks", () => {
  let completed = completedEpochProjection();
  completed = applyEvent(completed, v3Event("goal.discovery_recorded", {
    id: "obs-open", summary: "Untriaged follow-up", paths: ["src/c.ts"], source: "user_intent", sessionId: "session-1",
  }));
  assert.throws(() => applyEvent(completed, v3Event("goal.reopened", {
    reason: "Cannot reopen before tasking the discovery", observationIds: ["obs-open"],
  })), /tasked/);

  const notCompleted = replayLegacyCreate({ ...v2Created("active-v3"), goalId: "active-v3" });
  assert.throws(() => applyEvent(notCompleted, v3Event("goal.reopened", {
    reason: "An active goal cannot open another epoch", observationIds: ["obs"],
  }, "active-v3")), /completed/);
});

test("v3 session continuity events are durable and detached sessions stop watching", () => {
  let projection = completedEpochProjection();
  projection = applyEvent(projection, v3Event("goal.session_bound", { sessionId: "session-1", leafId: "leaf-1" }));
  assert.equal(projection.coordinationState, "watching");
  assert.deepEqual(projection.sessionBindings, [{ sessionId: "session-1", leafId: "leaf-1", state: "watching", boundAt: projection.updatedAt }]);

  projection = applyEvent(projection, v3Event("goal.continuity_checkpointed", {
    sessionId: "session-1", reason: "manual", modifiedFiles: ["src/a.ts", "src/a.ts"],
    nextAction: "Inspect goal status before changing any follow-up implementation",
  }));
  assert.equal(projection.continuity.lastCheckpoint.sessionId, "session-1");
  assert.deepEqual(projection.continuity.lastCheckpoint.modifiedFiles, ["src/a.ts"]);

  projection = applyEvent(projection, v3Event("goal.session_detached", {
    sessionId: "session-1", reason: "The user moved this session to unrelated work",
  }));
  assert.equal(projection.sessionBindings[0].state, "detached");
  assert.equal(projection.coordinationState, "quiescent");
});

test("goal contract amendment requires a real approval identity and preserves old metadata", () => {
  let projection = replayLegacyCreate(v2Created("contract-v3"));
  const proposalHash = "a".repeat(64);
  const changes = { objective: "Updated objective", scope: ["src/", "test/"] };
  const event = (approval) => v3Event("goal.contract_amended", { proposalHash, changes, approval }, "contract-v3");

  assert.throws(() => applyEvent(projection, event(undefined)), /approval/);
  assert.throws(() => applyEvent(projection, event({ entryId: "entry-1", sessionId: "session-1", source: "extension" })), /interactive|rpc/);

  projection = applyEvent(projection, event({ entryId: "entry-1", sessionId: "session-1", source: "interactive" }));
  assert.equal(projection.objective, "Updated objective");
  assert.deepEqual(projection.scope, ["src/", "test/"]);
  assert.deepEqual(projection.contractHistory, [{
    proposalHash,
    approval: { entryId: "entry-1", sessionId: "session-1", source: "interactive" },
    previous: { objective: "Workspace disposition test", scope: [], nonGoals: [], dod: [] },
    updated: { objective: "Updated objective", scope: ["src/", "test/"], nonGoals: [], dod: [] },
  }]);
});

test("released blocked task can retry or supersede but active workspace fails closed", () => {
  const goalId = "blocked-v3";
  let blocked = v2Settled(v2Dispatched(replayLegacyCreate(v2Created(goalId)), goalId), "blocked", goalId);
  assert.equal(blocked.coordinationState, "blocked");
  assert.throws(() => applyEvent(blocked, v3Event("task.block_resolved", {
    taskId: "t1", resolution: "retry", reason: "Retry after resolving the external blocker",
  }, goalId)), /workspace.*released/i);

  const disposition = started("discard", goalId);
  blocked = applyEvent(blocked, disposition);
  blocked = applyEvent(blocked, v2Event("task.workspace_disposition_applied", {
    taskId: "t1", attempt: 1, action: "discard", strategy: "merge", executorHead: "executor-head", originHead: "origin-after",
  }, goalId));
  blocked = applyEvent(blocked, v2Event("task.workspace_disposed", {
    taskId: "t1", attempt: 1, action: "discard", released: true,
  }, goalId));

  const retried = applyEvent(blocked, v3Event("task.block_resolved", {
    taskId: "t1", resolution: "retry", reason: "Retry after resolving the external blocker",
  }, goalId));
  assert.equal(retried.tasks.get("t1").status, "pending");
  assert.equal(retried.tasks.get("t1").blockedReason, undefined);
  assert.equal(retried.coordinationState, "ready");

  const superseded = applyEvent(blocked, v3Event("task.block_resolved", {
    taskId: "t1", resolution: "supersede", replacementTaskId: "t2", reason: "Replace the obsolete blocked implementation",
  }, goalId));
  assert.equal(superseded.tasks.get("t1").status, "superseded");
  assert.equal(superseded.tasks.get("t1").supersededBy, "t2");
});

test("store projection snapshot serializes v3 epoch and continuity fields", () => {
  const root = tmpRoot();
  const goalId = "v3-store-snapshot";
  writeLegacyEventLog(root, goalId, [v2Created(goalId)]);
  appendEvent(root, v3Event("goal.session_bound", { sessionId: "session-store", leafId: "leaf-store" }, goalId), 1);

  const persisted = JSON.parse(readFileSync(join(root, "goals", goalId, "projection.json"), "utf8"));
  assert.equal(persisted.epoch, 1);
  assert.equal(persisted.coordinationState, "ready");
  assert.deepEqual(persisted.sessionBindings, [{
    sessionId: "session-store", leafId: "leaf-store", state: "watching", boundAt: persisted.updatedAt,
  }]);
  assert.deepEqual(persisted.continuity, { observations: {}, lastCheckpoint: null });
  assert.deepEqual(persisted.completionHistory, []);
  assert.deepEqual(persisted.contractHistory, []);
  assert.equal(persisted.actionOffer, null);
});

test("new_goal discovery disposition closes continuity debt without reopening the completed epoch", () => {
  let projection = completedEpochProjection();
  projection = applyEvent(projection, v3Event("goal.discovery_recorded", {
    id: "obs-new-goal", summary: "A separate project request", paths: ["docs/new-project.md"],
    source: "user_intent", sessionId: "session-1",
  }));

  projection = applyEvent(projection, v3Event("goal.discovery_resolved", {
    id: "obs-new-goal", disposition: "new_goal", reason: "User chose a separate Goal for unrelated work",
  }));

  assert.equal(projection.lifecycle, "completed");
  assert.equal(projection.epoch, 1);
  assert.equal(projection.continuity.observations["obs-new-goal"].status, "new_goal");
  assert.equal(projection.coordinationState, "quiescent");
  assert.equal(projection.tasks.get("t1").status, "accepted");
});

test("v3 action offer persists and can be consumed exactly once", () => {
  let projection = replayLegacyCreate(v3Event("goal.created", {
    objective: "Persist status action offers", scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "work", deps: [], writePaths: ["src/a.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } },
  }));
  const offer = issueActionOffer(projection, {
    tool: "goal_dispatch", params: { goal_id: projection.goalId, task_id: "t1" },
  }, "session-1");
  projection = applyEvent(projection, v3Event("goal.action_offered", offer));
  assert.deepEqual(projection.actionOffer, offer);

  const consumed = verifyAndConsumeActionOffer(projection, {
    token: offer.token, tool: offer.tool, params: offer.params, sessionId: "session-1",
  });
  projection = applyEvent(projection, v3Event("goal.action_consumed", consumed));
  assert.equal(projection.actionOffer.consumed, true);
  assert.throws(() => applyEvent(projection, v3Event("goal.action_consumed", consumed)), /consumed/);
});

test("completed Planned goals keep continuity events in planned.v1", () => {
  const goalId = "planned-continuity";
  let projection = applyEvent(createProjection(), plannedEvent("goal.created", {
    objective: "Finish one Planned epoch and record related follow-up work",
    scope: [], nonGoals: [], dod: [], tasks: ["t1"],
    taskDefs: { t1: { description: "planned work", deps: [], writePaths: ["src/x.mjs"], acceptance: { criteria: [plannedCriterion("proof")] }, workflow: "tdd" } },
  }, goalId));
  const contractHash = "a".repeat(64);
  const baseCommit = "b".repeat(40);
  const executorHead = "c".repeat(40);
  projection = applyEvent(projection, plannedEvent("task.dispatched", {
    taskId: "t1", contractHash,
    workspace: { attempt: 1, path: "/tmp/planned-work", branch: "ge/planned/t1/1", baseCommit },
  }, goalId));
  projection = applyEvent(projection, plannedEvent("task.executor_bound", {
    taskId: "t1", attempt: 1, runId: "run-planned-continuity", contractHash,
    asyncDir: "/tmp/run-planned-continuity", workspacePath: "/tmp/planned-work",
    workspaceLeaseId: "d".repeat(64), headAtDispatch: baseCommit,
  }, goalId));
  projection = applyEvent(projection, plannedEvent("task.settled", {
    taskId: "t1", outcome: "succeeded", evidence: { type: "test_output", ref: "planned-tests" },
    evidenceSource: "self_produced", nextAction: "Integrate the verified Planned task before accepting its evidence", attempt: 1, executorHead,
    executorProof: { runId: "run-planned-continuity", proofId: "e".repeat(64), rootSessionId: "root-planned", observedAt: 1_700_000_000_000, outcome: "succeeded" },
  }, goalId));
  projection = applyEvent(projection, plannedEvent("task.workspace_disposition_started", {
    taskId: "t1", attempt: 1, requestedAction: "integrate", strategy: "merge", executorHead, originHeadBefore: baseCommit,
  }, goalId));
  projection = applyEvent(projection, plannedEvent("task.workspace_disposition_applied", {
    taskId: "t1", attempt: 1, action: "integrate", strategy: "merge", executorHead, originHead: "f".repeat(40),
  }, goalId));
  projection = applyEvent(projection, plannedEvent("task.workspace_disposed", {
    taskId: "t1", attempt: 1, action: "integrate", released: true,
  }, goalId));
  projection = applyEvent(projection, plannedEvent("task.accepted", { taskId: "t1", workspaceAttempt: 1 }, goalId));
  projection = applyEvent(projection, plannedEvent("goal.completed", { verdict: "COMPLETE" }, goalId));

  const continued = applyEvent(projection, plannedEvent("goal.session_bound", {
    sessionId: "session-planned", leafId: "leaf-planned",
  }, goalId));
  assert.equal(continued.eventSchemaVersion, "planned.v1");
  assert.equal(continued.lifecycle, "completed");
  assert.equal(continued.sessionBindings[0].state, "watching");
});

test("planned.v1 is an isolated persisted generation with strict criteria", () => {
  const created = { schemaVersion: "planned.v1", eventId: "planned-created", goalId: "planned-generation", occurredAt: "2026-08-08T00:00:00.000Z", type: "goal.created", data: { objective: "Create a planned goal", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "Implement planned core", deps: [], writePaths: ["src/x.mjs"], acceptance: { criteria: [{ id: "proof", statement: "Prove behavior", evidenceKinds: ["tests", "changed-files"] }] }, workflow: "tdd" } } } };
  const projection = applyEvent(createProjection(), created);
  assert.equal(projection.eventSchemaVersion, "planned.v1");
  assert.deepEqual(projection.tasks.get("t1").acceptance, created.data.taskDefs.t1.acceptance);

  const checkpointed = applyEvent(projection, plannedEvent("goal.checkpoint", {
    nextAction: "Inspect the Planned task contract before dispatching task t1 with its exact hash",
  }, created.goalId));
  assert.equal(checkpointed.eventSchemaVersion, "planned.v1");
  assert.equal(checkpointed.version, 2);

  assert.throws(() => applyEvent(checkpointed, { ...created, eventId: "legacy-mix", type: "goal.checkpoint", data: { nextAction: "Use the isolated planned generation for every future event" }, schemaVersion: "goal-engine.event.v3" }), /mixed event generations/);
  assert.throws(() => applyEvent(createProjection(), { ...created, eventId: "legacy-new", schemaVersion: "goal-engine.event.v3" }), /replay-only/);
  assert.throws(() => applyEvent(createProjection(), { ...created, eventId: "unknown-new", schemaVersion: "planned.v2" }), /invalid schemaVersion/);

  const legacy = replayLegacyCreate(v2Created("legacy-generation"));
  assert.throws(() => applyEvent(legacy, plannedEvent("goal.checkpoint", {
    nextAction: "Reject a Planned event appended to an active legacy generation",
  }, legacy.goalId)), /mixed event generations/);

  const malformed = structuredClone(created);
  malformed.eventId = "planned-malformed";
  malformed.data.taskDefs.t1.acceptance.commands = ["true"];
  assert.throws(() => applyEvent(createProjection(), malformed), /only criteria/);
});
