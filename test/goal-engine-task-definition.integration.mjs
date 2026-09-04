import assert from "node:assert/strict";
import test from "node:test";
import { validateRemediationMetadata, validateTaskDefinitions } from "../src/goal-engine/task-definition.ts";

const remediationMetadata = { kind: "remediation", goalId: "goal-1", executionRevision: 1, episodeId: "episode-1", conditionId: "condition-1", findingIds: ["finding-1"], subjectHash: "a".repeat(64), taskDefHash: "b".repeat(64) };
const remediationTaskDef = (metadata = remediationMetadata) => ({ description: "修复", deps: [], writePaths: ["src/fix.mjs"], acceptance: { criteria: ["通过"], commands: ["node --test"] }, workflow: "tdd", metadata });
const validateRemediationTaskDef = (def, options) => validateTaskDefinitions(["repair-task-1"], { "repair-task-1": def }, options);

test("remediation metadata is exact internal provenance", () => {
  assert.doesNotThrow(() => validateRemediationMetadata(remediationMetadata));
  for (const value of [{ ...remediationMetadata, callerText: "bypass" }, { ...remediationMetadata, kind: "ordinary" }, { ...remediationMetadata, findingIds: [] }]) assert.throws(() => validateRemediationMetadata(value), /exact remediation/i);
});

test("remediation metadata is Host-internal before unknown-field validation", () => {
  assert.throws(() => validateRemediationTaskDef(remediationTaskDef()), /metadata is Host-internal only/);
});

test("task definitions still reject unknown fields", () => {
  assert.throws(() => validateRemediationTaskDef({ ...remediationTaskDef(), unexpected: true }), /contains unknown field/);
});

test("Host-internal task definitions reject malformed remediation metadata", () => {
  assert.throws(() => validateRemediationTaskDef(remediationTaskDef({ ...remediationMetadata, findingIds: [] }), { hostInternalRemediation: true }), /exact remediation metadata/);
});

test("Host-internal remediation metadata is accepted when exact", () => {
  assert.doesNotThrow(() => validateRemediationTaskDef(remediationTaskDef(), { hostInternalRemediation: true }));
});
