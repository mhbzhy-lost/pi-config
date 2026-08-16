import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection } from "../scripts/lib/goal-engine/events.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../scripts/lib/goal-engine/obligation-contract.mjs";

function event(type, data, n) { return { schemaVersion: "goal-runtime.v1", eventId: `runtime-${n}`, goalId: "runtime-goal", occurredAt: `2026-08-13T00:00:0${n}.000Z`, type, data }; }

test("runtime draft preserves contract state and observation identity", () => {
  const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  const hash = hashRuntimeExecutionContract(contract);
  let p = applyEvent(createProjection(), event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hash, readiness: "draft" }, 1));
  assert.equal(p.runtimeGeneration, "goal-runtime.v1");
  assert.equal(p.initialShape, "hybrid");
  assert.equal(p.conditions.get("condition-1").status, "inactive");
  p = applyEvent(p, event("condition.observation_requested", { runId: "run-1", conditionId: "condition-1", cycle: 0, worldSnapshotHash: "a".repeat(64), resourceClaimsHash: "b".repeat(64) }, 2));
  assert.equal(p.observationRuns.get("run-1").allocationId, null);
  assert.equal(p.conditions.get("condition-1").lastObservationRunId, "run-1");
  assert.throws(() => applyEvent(p, event("finding.recorded", { findingId: "f-1", conditionId: "condition-1", runId: "run-1", evidenceId: "e-1", fingerprint: "f".repeat(64) }, 3)), /failed observation|terminal/);
  assert.throws(() => applyEvent(p, { ...event("goal.checkpoint", { nextAction: "a sufficiently concrete historical next action" }, 3), schemaVersion: "planned.v1" }), /mixed event generations/);
});
