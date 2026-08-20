import assert from "node:assert/strict";
import test from "node:test";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { recoverObservation, recordObservation, requestObservation } from "../scripts/lib/goal-engine/observation-runner.mjs";

const head = "b".repeat(40);
const registry = createObservationAdapterRegistry([{
  ref: "oracle", version: "1", deterministic: true,
  resourceClaims: [{ key: "fixture:test", mode: "exclusive", capacity: 1, reset: "clean" }],
  reset: "clean", artifactClassifier: { pass: "pass", fail: "fail", inconclusive: "inconclusive", infrastructure_error: "infra" },
  validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 2000, maxOutputBytes: 1024, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "test", kind: "validation", executable: process.execPath, args: ["-e", "process.exit(0)"] }] },
}]);

function projection() {
  return {
    goalId: "g", executionRevision: 1, executionContractHash: "c".repeat(64), runtimeState: "active",
    conditions: new Map([["c", { conditionHash: "a".repeat(64), definition: { oracle_ref: "oracle", environment_ref: "local", fixture_refs: ["sample"], stability: { mode: "single" } } }]]),
    observationRuns: new Map(),
  };
}

test("unknown process recovery remains cleanup debt and cannot record", async () => {
  const durableProjection = projection();
  const requested = requestObservation({ projection: durableProjection, conditionId: "c", worldSnapshot: { safe: true, head }, services: { adapterRegistry: registry } }).runReceipt;
  durableProjection.observationRuns.set(requested.runId, { runId: requested.runId, conditionId: "c", phase: "process_bound" });
  const result = await recoverObservation(requested, {
    adapterRegistry: registry, originRoot: "/origin", stateRoot: "/state", integratedHead: head,
    loadProjection: async () => durableProjection,
    persistEvent: async () => assert.fail("cleanup debt must not record a Goal event"),
    prepareManagedValidation: () => ({ id: "x", phase: "lease_allocated" }),
    recoverManagedValidation: async () => ({ phase: "cleanup_debt", cleanupDebt: true }),
  });
  assert.equal(result.phase, "cleanup_debt");
  assert.equal(result.cleanupDebt, true);
  await assert.rejects(recordObservation({ projection: durableProjection, runReceipt: result, artifactRef: {}, worldSnapshot: {}, services: {} }), /terminal|debt/i);
});
