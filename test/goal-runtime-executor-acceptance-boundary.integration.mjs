import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRuntimeGoalInit } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";
import { compileTaskContract } from "../scripts/lib/goal-engine/dispatch.mjs";
import { splitDispatchEnvelope } from "../scripts/lib/goal-engine/dispatch-ir.mjs";
import { buildObligationFinalizationManifest } from "../scripts/lib/goal-engine/finalization.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const hash = "a".repeat(64);
const head = "b".repeat(40);

function runtimeWithCoordinatorCriterion() {
  const input = runtimeInit();
  input.execution.tasks[0].acceptance.criteria.push({
    id: "released", statement: "工作区已集成并释放", evidenceKinds: ["manual-review"],
    evaluator: "coordinator", predicate: "workspace-integrated-released",
  });
  return input;
}

test("public runtime boundary keeps coordinator postconditions authoritative but out of executor acceptance", () => {
  const normalized = normalizeRuntimeGoalInit(runtimeWithCoordinatorCriterion(), runtimeRegistries);
  const event = { schemaVersion: "goal-runtime.v1", eventId: "created", goalId: "boundary", occurredAt: "2026-08-24T00:00:00.000Z", type: "goal.runtime_drafted", data: { runtimeInit: normalized, executionContractHash: hash, baseHead: head } };
  const projection = applyEvent(createProjection(), event);
  const task = projection.tasks.get("task-1");
  assert.equal(task.acceptance.criteria.length, 2, "authority retains coordinator criterion");
  const contract = splitDispatchEnvelope(compileTaskContract(projection, "task-1", "/workspace")).contract;
  assert.equal(contract.acceptance.criteria.length, 1);
  assert.equal(contract.acceptance.criteria.some(value => value.includes("released")), false);
  assert.equal(contract.requirements.some(value => value.includes("released")), false);
  const manifest = buildObligationFinalizationManifest({ projection, worldSnapshot: { safe: true, activeRuns: [], repo: { head, trackedDirty: [], untracked: [], sequencer: null } }, conditionValidity: new Map(), resourceInventory: [] });
  assert.deepEqual(manifest.tasks[0].coordinatorCriteria, [{ id: "released", predicate: "workspace-integrated-released", satisfied: false }]);
  assert.ok(manifest.blockers.some(blocker => blocker.code === "TASK_COORDINATOR_PREDICATE_UNSATISFIED"));
});

test("fresh coordinator criteria fail closed for unknown typed predicates while legacy criteria remain executor-owned", () => {
  const unknown = runtimeWithCoordinatorCriterion();
  unknown.execution.tasks[0].acceptance.criteria[1].predicate = "guessed-from-text";
  assert.throws(() => normalizeRuntimeGoalInit(unknown, runtimeRegistries), /predicate/);
  const normalized = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  assert.equal(normalized.execution.tasks[0].acceptance.criteria[0].evaluator, undefined);
});

test("runtime execution amendment accepts an explicit coordinator predicate", () => {
  const normalized = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  const drafted = applyEvent(createProjection(), { schemaVersion: "goal-runtime.v1", eventId: "created", goalId: "amendment-boundary", occurredAt: "2026-08-24T00:00:00.000Z", type: "goal.runtime_drafted", data: { runtimeInit: normalized, executionContractHash: hash, baseHead: head } });
  const acceptance = structuredClone(drafted.tasks.get("task-1").acceptance);
  acceptance.criteria.push({ id: "terminal", statement: "Executor terminal proof exists", evidenceKinds: ["manual-review"], evaluator: "coordinator", predicate: "executor-terminal-proof" });
  assert.doesNotThrow(() => applyEvent(drafted, { schemaVersion: "goal-runtime.v1", eventId: "amended", goalId: "amendment-boundary", occurredAt: "2026-08-24T00:00:01.000Z", type: "goal.amended", data: { reason: "add lifecycle postcondition", updateTasks: { "task-1": { acceptance } } } }));
});
