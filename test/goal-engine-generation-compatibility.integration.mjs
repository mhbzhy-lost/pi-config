import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createGoalEngineExtension } from "../src/goal-engine/extension.ts";
import { applyEvent, createProjection, schemaVersionForMutation } from "../src/goal-engine/events.ts";
import { generationCapabilities, isWritableGoalGeneration } from "../src/goal-engine/generation-capabilities.ts";
import { appendEvent, appendEventBatch, loadProjection } from "../src/goal-engine/store.ts";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../src/goal-engine/obligation-contract.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";
import { legacyExecutorProfile, legacyExecutorTaskFields } from "../src/goal-engine/legacy-executor-compat.ts";

const at = (n) => `2026-08-13T00:00:${String(n).padStart(2, "0")}.000Z`;
const hash = (n) => String(n).padStart(64, "0");
const head = "a".repeat(40);
const legacyDef = { description: "historical task", deps: [], writePaths: ["src/**"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" };
const plannedDef = { description: "planned task", deps: [], writePaths: ["src/**"], acceptance: { criteria: [{ id: "works", statement: "works", evidenceKinds: ["tests"] }] }, workflow: "tdd" };
const legacyCreated = (schemaVersion, goalId) => ({ schemaVersion, eventId: `${goalId}-created`, goalId, occurredAt: at(1), type: "goal.created", data: { objective: "historical goal", scope: [], nonGoals: [], dod: [], tasks: ["task-1"], taskDefs: { "task-1": schemaVersion === "planned.v1" ? plannedDef : legacyDef } } });
function seed(root, rows) {
  const goalId = rows[0].goalId;
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${rows.map(JSON.stringify).join("\n")}\n`);
}
function event(type, data, n, goalId = "runtime-compat") {
  return { schemaVersion: "goal-runtime.v1", eventId: `${goalId}-${n}-${type}`, goalId, occurredAt: at(n), type, data };
}
function approvalHash(data) {
  return createHash("sha256").update(JSON.stringify({ baseHead: data.baseHead, executionContractHash: data.executionContractHash, goalId: "runtime-compat", proposalId: data.proposalId, sessionId: data.sessionId })).digest("hex");
}
function runtimeFixture() {
  const contract = normalizeRuntimeGoalInit({ ...runtimeInit(), execution: { ...runtimeInit().execution, conditions: [] } }, runtimeRegistries);
  let p = createProjection();
  const rows = [];
  const apply = (row) => { rows.push(row); p = applyEvent(p, row); };
  apply(event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: head }, 1));
  apply(event("goal.session_bound", { sessionId: "owner", leafId: "leaf" }, 2));
  apply(event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 3));
  const approval = { proposalId: "proposal", executionContractHash: p.executionContractHash, baseHead: head, sessionId: "owner" };
  apply(event("goal.runtime_approval_recorded", { ...approval, proposalHash: approvalHash(approval), userEntryId: "entry", capabilityDigest: hash(4) }, 4));
  apply(event("goal.runtime_activated", {}, 5));
  return { p, rows, contract };
}

test("public v2 runtime init is read-only before ledger or resource side effects", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-generation-read-only-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd });
    const tools = [];
    const sessionManager = { getSessionId: () => "owner", getSessionFile: () => join(cwd, "session"), getLeafId: () => "leaf", getBranch: () => [], getEntries: () => [] };
    const api = { registerTool: tool => tools.push(tool), on() {} };
    let appends = 0, workspaceAllocations = 0, brokerRegistrations = 0;
    createGoalEngineExtension(api, {
      goalStateEnv: {},
      appendEventBatch() { appends++; throw new Error("v2 writer reached ledger"); },
      workspaceService: { allocate() { workspaceAllocations++; } },
      runtimeHost: {
        registries: runtimeRegistries,
        captureCurrentWorld() { return { safe: true, repo: { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim() } }; },
        registerBroker() { brokerRegistrations++; },
      },
    });
    const v2 = runtimeInit({ execution: { ...runtimeInit().execution, schema: "goal-runtime.v2", tasks: [{ ...runtimeInit().execution.tasks[0], agentProfile: "coder-alpha", acceptance: { criteria: [{ ...runtimeInit().execution.tasks[0].acceptance.criteria[0], evaluator: "run" }] } }] } });
    const init = tools.find(tool => tool.name === "goal_init");
    await assert.rejects(() => init.execute("call", v2, undefined, undefined, { cwd, sessionManager }), /GOAL_GENERATION_READ_ONLY/);
    assert.equal(appends, 0);
    assert.equal(workspaceAllocations, 0);
    assert.equal(brokerRegistrations, 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("table-driven historical v1/v2/v3/planned replay is isolated and runtime fields are not inferred", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-generation-replay-"));
  try {
    for (const schemaVersion of ["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3", "planned.v1"]) {
      const goalId = `replay-${schemaVersion.replaceAll(".", "-")}`;
      seed(root, [legacyCreated(schemaVersion, goalId)]);
      const projection = loadProjection(root, goalId);
      assert.equal(projection.eventSchemaVersion, schemaVersion);
      assert.equal(projection.runtimeGeneration, null);
      assert.equal(projection.conditions.size, 0);
      assert.equal(projection.finalReview, null);
      assert.equal(schemaVersionForMutation(projection), schemaVersion === "planned.v1" ? "planned.v1" : "goal-engine.event.v3");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("planned snapshots retain their existing serialization without runtime active-time fields", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-planned-serialization-"));
  try {
    appendEvent(root, legacyCreated("planned.v1", "planned-serialization"), 0);
    const snapshot = JSON.parse(readFileSync(join(root, "goals", "planned-serialization", "projection.json"), "utf8"));
    assert.equal(Object.hasOwn(snapshot, "runtimeActiveElapsedMs"), false);
    assert.equal(Object.hasOwn(snapshot, "runtimeActiveSince"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writable Goal generation gate admits only public v1 dispatch generations", () => {
  for (const [schemaVersion, expected] of [
    ["planned.v1", true], ["goal-runtime.v1", true],
    ["planned.v2", false], ["goal-runtime.v2", false],
    ["goal-engine.event.v1", false], ["goal-engine.event.v2", false], ["goal-engine.event.v3", false],
    ["unknown", false],
  ]) assert.equal(isWritableGoalGeneration(schemaVersion), expected, schemaVersion);
});

test("generation matrix preserves planned policy and rejects mixed generations/schema mutation", () => {
  for (const version of ["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3"]) {
    assert.deepEqual(generationCapabilities(version), { taskContract: "legacy-commands", executorBinding: "legacy", settlement: "legacy", completion: "accept-auto", conditions: false, executionRevision: false });
  }
  assert.deepEqual(generationCapabilities("planned.v1"), { taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "accept-auto", conditions: false, executionRevision: false });
  const root = mkdtempSync(join(tmpdir(), "goal-generation-mixed-"));
  try {
    const goalId = "mixed-generation";
    seed(root, [legacyCreated("goal-engine.event.v2", goalId), { ...legacyCreated("planned.v1", goalId), eventId: "mixed", occurredAt: at(2), type: "goal.checkpoint", data: { canonicalFingerprint: hash(1), advanced: true, sequence: 1 } }]);
    assert.throws(() => loadProjection(root, goalId), /mixed|downgrade|checkpoint/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh writers reject v2 before any public mutation while historical v2 replay remains exact", () => {
  const v2 = createProjection();
  v2.eventSchemaVersion = "planned.v2";
  assert.throws(() => schemaVersionForMutation(v2), (error) => error?.code === "GOAL_GENERATION_READ_ONLY");

  const root = mkdtempSync(join(tmpdir(), "goal-v2-replay-only-"));
  try {
    const goalId = "historical-v2";
    const historical = legacyCreated("planned.v2", goalId);
    historical.data.taskDefs["task-1"] = {
      ...plannedDef,
      agentProfile: "coder-alpha",
      acceptance: { criteria: [{ ...plannedDef.acceptance.criteria[0], evaluator: "run" }] },
    };
    seed(root, [historical]);
    const replay = loadProjection(root, goalId);
    assert.equal(replay.eventSchemaVersion, "planned.v2");
    assert.throws(() => schemaVersionForMutation(replay), (error) => error?.code === "GOAL_GENERATION_READ_ONLY");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy executor presentation defaults are isolated from v2 task shape", () => {
  assert.equal(legacyExecutorProfile("planned.v1", undefined), "executor");
  assert.equal(legacyExecutorProfile("goal-runtime.v1", undefined), "executor");
  assert.throws(() => legacyExecutorProfile("planned.v2", undefined), /agentProfile/);
  assert.deepEqual(legacyExecutorTaskFields("planned.v1"), { executorBinding: null, lastExecutorProof: null });
  assert.deepEqual(legacyExecutorTaskFields("planned.v2"), {});
});

test("runtime snapshot/replay carries current entities and completion only passes record+complete gate", () => {
  const { p, rows } = runtimeFixture();
  const root = mkdtempSync(join(tmpdir(), "goal-runtime-compat-replay-"));
  try {
    seed(root, rows);
    const replay = loadProjection(root, "runtime-compat");
    assert.equal(replay.runtimeGeneration, "goal-runtime.v1");
    assert.equal(replay.taskApplicability.get("task-1").state, "applicable");
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const field of ["taskApplicability", "conditions", "observationRuns", "findings", "repairEpisodes", "repairChallenges", "suspension", "finalReview"]) assert.ok(field in p, field);
  assert.equal(p.runtimeState, "active");
  const started = event("goal.final_review_started", { reviewId: "review", manifestHash: hash(20), stateHash: hash(21), worldHash: hash(22), head, approval: { entryId: "entry", sessionId: "owner", source: "user" } }, 11);
  const recorded = event("goal.final_review_recorded", { reviewId: "review", resultHash: hash(23), severity: "none", status: "recorded" }, 12);
  const completed = event("goal.completed", { verdict: "COMPLETE", reviewId: "review", manifestHash: hash(20), stateHash: hash(21), worldHash: hash(22), head, resultHash: hash(23) }, 13);
  let next = applyEvent(p, started);
  assert.throws(() => applyEvent(next, completed), /atomic|final|record/i);
  next = applyEvent(next, recorded);
  assert.equal(next.finalReview.status, "recorded");
  next.tasks.get("task-1").status = "accepted";
  assert.equal(applyEvent(next, completed).lifecycle, "completed");
});
