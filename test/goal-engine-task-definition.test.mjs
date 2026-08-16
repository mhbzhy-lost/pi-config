import assert from "node:assert/strict";
import test from "node:test";
import { validateRemediationMetadata, validateTaskDefinitions } from "../scripts/lib/goal-engine/task-definition.mjs";

test("remediation metadata is exact internal provenance", () => {
  const metadata = { kind: "remediation", findingIds: ["finding-1"], episodeId: "episode-1" };
  assert.doesNotThrow(() => validateRemediationMetadata(metadata));
  for (const value of [{ ...metadata, callerText: "bypass" }, { ...metadata, kind: "ordinary" }, { ...metadata, findingIds: [] }]) assert.throws(() => validateRemediationMetadata(value), /exact remediation/i);
  const def = { description: "修复", deps: [], writePaths: ["src/fix.mjs"], acceptance: { criteria: ["通过"], commands: ["node --test"] }, workflow: "tdd", metadata };
  assert.doesNotThrow(() => validateTaskDefinitions(["repair-task-1"], { "repair-task-1": def }));
});
