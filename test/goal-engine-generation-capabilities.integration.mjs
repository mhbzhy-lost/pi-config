import assert from "node:assert/strict";
import test from "node:test";
import { generationCapabilities } from "../src/goal-engine/generation-capabilities.ts";

test("generation capability matrix is exact, frozen, and fail closed", () => {
  for (const version of ["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3"]) {
    assert.deepEqual(generationCapabilities(version), { taskContract: "legacy-commands", executorBinding: "legacy", settlement: "legacy", completion: "accept-auto", conditions: false, executionRevision: false });
  }
  assert.deepEqual(generationCapabilities("planned.v1"), { taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "accept-auto", conditions: false, executionRevision: false });
  assert.deepEqual(generationCapabilities("goal-runtime.v1"), { taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "goal-finalize", conditions: true, executionRevision: true });
  assert.equal(Object.isFrozen(generationCapabilities("goal-runtime.v1")), true);
  assert.throws(() => generationCapabilities("unknown.v1"), /unknown generation/);
});
