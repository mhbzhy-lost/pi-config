import assert from "node:assert/strict";
import test from "node:test";
import { buildObligationFinalizationManifest, validateObligationFinalizationManifest } from "../src/goal-engine/finalization.ts";

const hash = "a".repeat(64);
const projection = { goalId: "g", executionRevision: 1, executionContractHash: hash, stateHash: hash, tasks: new Map(), conditions: new Map() };
const worldSnapshot = { worldHash: hash, safe: true, activeRuns: [], repo: { head: "b".repeat(40), trackedDirty: [], untracked: [], sequencer: null } };

test("builds a frozen pure finalization manifest and validates it", () => {
  const manifest = buildObligationFinalizationManifest({ projection, worldSnapshot, conditionValidity: new Map(), resourceInventory: {} });
  assert.equal(manifest.goalId, "g");
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(validateObligationFinalizationManifest(manifest), true);
  assert.equal(manifest.complete, true);
  assert.throws(() => { manifest.complete = false; }, TypeError);
});

test("does not trust projection freshness and fails closed on stale condition proof", () => {
  const conditionHash = "c".repeat(64), evidenceId = "e-1";
  const p = { ...projection, conditions: new Map([["c", { status: "satisfied", freshness: "fresh", conditionHash, supportingEvidenceIds: [evidenceId], definition: { id: "c" } }]]), evidenceHistory: [{ evidenceId, conditionId: "c", conditionHash, executionRevision: 1, executionContractHash: hash, verdict: { kind: "passed" } }] };
  const manifest = buildObligationFinalizationManifest({ projection: p, worldSnapshot, conditionValidity: new Map([["c", { status: "stale" }]]), resourceInventory: {} });
  assert.equal(manifest.complete, false);
  assert.ok(manifest.blockers.some(item => item.code === "CONDITION_STALE"));
});
