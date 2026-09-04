import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyEvent, createProjection, schemaVersionForMutation } from "../src/goal-engine/events.ts";
import { generationCapabilities } from "../src/goal-engine/generation-capabilities.ts";
import { appendEvent, appendEventBatch, loadProjection } from "../src/goal-engine/store.ts";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../src/goal-engine/obligation-contract.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

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
