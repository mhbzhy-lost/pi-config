import assert from "node:assert/strict";
import test from "node:test";

import { runBindingForTask, runProofForTask } from "../src/goal-engine/legacy-executor-compat.ts";

const legacyBinding = { attempt: 1, runId: "legacy-run", contractHash: "a".repeat(64), asyncDir: "/tmp/legacy-run", workspacePath: "/tmp/workspace", workspaceLeaseId: "b".repeat(64), headAtDispatch: "c".repeat(40) };
const legacyProof = { runId: "legacy-run", proofId: "d".repeat(64), rootSessionId: "root-1", observedAt: 1_700_000_000_000, outcome: "succeeded" };
const runBinding = { attempt: 1, runId: "run-1", agentProfile: "builder", contractHash: "e".repeat(64), workspaceId: "workspace-1", asyncDir: "/tmp/run-1", workspacePath: "/tmp/workspace", workspaceLeaseId: "f".repeat(64), headAtDispatch: "a".repeat(40) };
const runProof = { runId: "run-1", proofId: "b".repeat(64), rootSessionId: "root-1", observedAt: 1_700_000_000_000, outcome: "succeeded", agentProfile: "builder" };

test("legacy binding and proof accessors derive neutral executor identity", () => {
  for (const schemaVersion of ["planned.v1", "goal-runtime.v1"]) {
    assert.deepEqual(runBindingForTask({ executorBinding: legacyBinding }, schemaVersion), { ...legacyBinding, agentProfile: "executor" });
    assert.deepEqual(runProofForTask({ lastExecutorProof: legacyProof }, schemaVersion), { ...legacyProof, agentProfile: "executor" });
    assert.equal(runBindingForTask({ executorBinding: null }, schemaVersion), null);
    assert.equal(runProofForTask({ lastExecutorProof: null }, schemaVersion), null);
  }
});

test("v2 binding and proof accessors preserve canonical fields", () => {
  for (const schemaVersion of ["planned.v2", "goal-runtime.v2"]) {
    assert.strictEqual(runBindingForTask({ runBinding }, schemaVersion), runBinding);
    assert.strictEqual(runProofForTask({ lastRunProof: runProof }, schemaVersion), runProof);
    assert.equal(runBindingForTask({ runBinding: null }, schemaVersion), null);
    assert.equal(runProofForTask({ lastRunProof: null }, schemaVersion), null);
  }
});

test("binding and proof accessors fail closed for invalid or mixed generation shapes", () => {
  for (const [task, schemaVersion] of [
    [{ executorBinding: { ...legacyBinding, agentProfile: "executor" } }, "planned.v1"],
    [{ executorBinding: legacyBinding, runBinding }, "goal-runtime.v1"],
    [{ runBinding: { ...runBinding, executorBinding: null } }, "planned.v2"],
    [{ runBinding, executorBinding: null }, "goal-runtime.v2"],
    [{ lastExecutorProof: legacyProof, lastRunProof: runProof }, "planned.v1"],
    [{ lastRunProof: runProof, lastExecutorProof: null }, "goal-runtime.v2"],
    [{ runBinding }, "planned.v1"],
    [{ executorBinding: legacyBinding }, "planned.v2"],
  ]) assert.throws(() => runBindingForTask(task, schemaVersion), /legacy executor compatibility/);
  assert.throws(() => runProofForTask({ lastExecutorProof: { ...legacyProof, agentProfile: "executor" } }, "planned.v1"), /legacy executor compatibility/);
  assert.throws(() => runProofForTask({ lastRunProof: { ...runProof, extra: true } }, "planned.v2"), /legacy executor compatibility/);
});
