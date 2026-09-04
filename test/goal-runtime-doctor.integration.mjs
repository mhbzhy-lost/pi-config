import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectConfiguration, inspectGoalRuntimeBoundaries } from "../scripts/doctor.ts";

const validRuntimeFactory = () => ({
  generationCapabilities(schema) {
    if (schema === "planned.v1") return { taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "accept-auto" };
    if (schema === "goal-runtime.v1") return { taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "goal-finalize", conditions: true, executionRevision: true };
    throw new Error("unknown generation");
  },
  normalizeRuntimeGoalInit(input) {
    if (Object.hasOwn(input, "profile") || Object.hasOwn(input, "command")) throw new Error("caller authority rejected");
    if (!input.execution.tasks.length && !input.execution.conditions.length) throw new Error("obligation required");
    return input;
  },
  createRuntimeActivationChallenge() { return { kind: "runtime_activation_approval" }; },
  managedValidation: { prepareManagedValidation() {}, startManagedValidation() {}, inspectManagedValidation() {}, recoverManagedValidation() {}, releaseManagedValidation() {} },
  currentWorld: { captureCurrentWorld() {}, evaluateConditionGraph() {} },
  repair: { deriveFindingFromFailedEvidence() {}, openRepairEpisode() {} },
  suspension: { buildSuspensionPlan() {}, suspensionGuard() {} },
  finalization: { finalizeGoal(projection) { if (projection.eventSchemaVersion === "planned.v1") throw new Error("FINALIZATION_UNSUPPORTED_GENERATION"); }, buildObligationFinalizationManifest() {} },
  finalReview: { runRecoverableFinalReview() {} },
  store: { loadFinalizationProjection() {} },
});

test("Doctor runtime boundary probe reports stable missing capability codes", () => {
  const issues = inspectGoalRuntimeBoundaries({ goalRuntimeBoundaryFactory: () => {
    const capability = validRuntimeFactory();
    capability.managedValidation = { ...capability.managedValidation, recoverManagedValidation: undefined };
    return capability;
  } });
  assert.deepEqual(issues, ["GOAL_RUNTIME_MANAGED_VALIDATION_RECOVERY: missing recoverManagedValidation"]);
});

test("Doctor runtime boundary probe reports forged generation behavior", () => {
  const issues = inspectGoalRuntimeBoundaries({ goalRuntimeBoundaryFactory: () => ({ ...validRuntimeFactory(), generationCapabilities: () => ({ taskContract: "legacy-commands", completion: "accept-auto" }) }) });
  assert.deepEqual(issues, ["GOAL_RUNTIME_GENERATION_CAPABILITIES: planned.v1 must retain strict accept-auto and runtime must require goal-finalize"]);
});

test("Doctor runtime boundary probe accepts complete injected behavior without state", () => {
  assert.deepEqual(inspectGoalRuntimeBoundaries({ goalRuntimeBoundaryFactory: validRuntimeFactory }), []);
});

test("Doctor leaves a temporary repository without Goal Engine state", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-runtime-doctor-"));
  const statePath = join(root, ".state", "goal-engine");
  try {
    await assert.rejects(stat(statePath), { code: "ENOENT" });
    await inspectConfiguration(root, {
      readPiVersion: async () => "0.82.1",
      readBasicMemoryVersion: async () => "0.22.1",
    });
    await assert.rejects(stat(statePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
