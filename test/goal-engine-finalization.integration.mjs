import assert from "node:assert/strict";
import test from "node:test";
import { finalizeGoal } from "../src/goal-engine/finalization.ts";

test("all existing generations fail closed before finalization side effects", () => {
  for (const eventSchemaVersion of ["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3", "planned.v1"]) {
    let sideEffects = 0;
    assert.throws(() => finalizeGoal({ eventSchemaVersion }, { onSideEffect() { sideEffects += 1; } }), (error) => error.code === "FINALIZATION_UNSUPPORTED_GENERATION");
    assert.equal(sideEffects, 0);
  }
});
