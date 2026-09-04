import assert from "node:assert/strict";
import test from "node:test";

import { compileCodingDispatchIR } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts";

/**
 * Tests for coercing stringified JSON fields back to objects/arrays.
 *
 * Some models (qwen3.8-max, gpt-5.6-sol) output nested fields as JSON strings
 * instead of actual objects, e.g.:
 *   "workflow": "{\"mode\": \"tdd\"}"  instead of  "workflow": {"mode": "tdd"}
 *
 * The extension should transparently coerce these before validation.
 */

function validContract() {
  return {
    version: "dispatch-ir.v1",
    taskId: "coercion-test",
    title: "Test stringified field coercion",
    agent: "executor",
    risk: "normal",
    objective: "Verify coercion works.",
    workflow: { mode: "tdd" },
    requirements: ["Requirement one."],
    context: {
      knownFacts: ["Fact one."],
      decisions: ["Decision one."],
      relevantFiles: ["src/index.ts"],
    },
    boundaries: {
      writePaths: ["src/index.ts"],
      excludedWork: ["Nothing excluded."],
      forbiddenActions: ["Nothing forbidden."],
    },
    acceptance: { criteria: ["Criterion one."] },
    execution: { timeoutMs: 60000 },
  };
}

test("coerces stringified workflow object", () => {
  const input = validContract();
  input.workflow = '{"mode": "tdd"}';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.workflow, { mode: "tdd" });
});

test("coerces stringified workflow with reason", () => {
  const input = validContract();
  input.workflow = '{"mode": "existing-tests", "reason": "Covered by existing tests."}';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.workflow, { mode: "existing-tests", reason: "Covered by existing tests." });
});

test("coerces stringified requirements array", () => {
  const input = validContract();
  input.requirements = '["First requirement.", "Second requirement."]';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.requirements, ["First requirement.", "Second requirement."]);
});

test("coerces stringified context object", () => {
  const input = validContract();
  input.context = '{"knownFacts": ["Fact."], "decisions": ["Decision."], "relevantFiles": ["src/a.ts"]}';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.context.knownFacts, ["Fact."]);
  assert.deepEqual(ir.context.decisions, ["Decision."]);
  assert.deepEqual(ir.context.relevantFiles, ["src/a.ts"]);
});

test("coerces stringified boundaries object", () => {
  const input = validContract();
  input.boundaries = '{"writePaths": ["src/a.ts"], "excludedWork": [], "forbiddenActions": []}';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.boundaries.writePaths, ["src/a.ts"]);
});

test("coerces stringified acceptance object", () => {
  const input = validContract();
  input.acceptance = '{"criteria": ["Must pass."]}';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.acceptance.criteria, ["Must pass."]);
});

test("coerces stringified execution object", () => {
  const input = validContract();
  input.execution = '{"timeoutMs": 120000, "worktree": true}';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.equal(ir.execution.timeoutMs, 120000);
  assert.equal(ir.execution.worktree, true);
});

test("coerces all stringified fields simultaneously", () => {
  const input = validContract();
  input.workflow = '{"mode": "tdd"}';
  input.requirements = '["Req."]';
  input.context = '{"knownFacts": [], "decisions": [], "relevantFiles": []}';
  input.boundaries = '{"writePaths": ["src/x.ts"], "excludedWork": [], "forbiddenActions": []}';
  input.acceptance = '{"criteria": ["Done."]}';
  input.execution = '{"timeoutMs": 90000}';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.workflow, { mode: "tdd" });
  assert.deepEqual(ir.requirements, ["Req."]);
  assert.deepEqual(ir.boundaries.writePaths, ["src/x.ts"]);
  assert.equal(ir.execution.timeoutMs, 90000);
});

test("coerced contract produces same hash as native object contract", () => {
  const native = validContract();
  const stringified = validContract();
  stringified.workflow = '{"mode": "tdd"}';
  stringified.requirements = '["Requirement one."]';
  stringified.context = '{"knownFacts": ["Fact one."], "decisions": ["Decision one."], "relevantFiles": ["src/index.ts"]}';
  stringified.boundaries = '{"writePaths": ["src/index.ts"], "excludedWork": ["Nothing excluded."], "forbiddenActions": ["Nothing forbidden."]}';
  stringified.acceptance = '{"criteria": ["Criterion one."]}';
  stringified.execution = '{"timeoutMs": 60000}';

  const nativeIr = compileCodingDispatchIR(native, { cwd: "/repo" });
  const stringifiedIr = compileCodingDispatchIR(stringified, { cwd: "/repo" });

  assert.equal(nativeIr.hash, stringifiedIr.hash);
});

test("rejects invalid JSON in stringified field", () => {
  const input = validContract();
  input.workflow = "{invalid json}";

  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/repo" }),
    (error) => {
      assert.equal(error.code, "INVALID_CONTRACT");
      return true;
    },
  );
});

test("rejects stringified field that parses to wrong type", () => {
  const input = validContract();
  input.workflow = '"just a string"';  // Valid JSON but not an object

  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/repo" }),
    (error) => {
      assert.equal(error.code, "INVALID_CONTRACT");
      return true;
    },
  );
});

test("does not coerce plain strings that are not JSON", () => {
  const input = validContract();
  input.workflow = "tdd";  // Not JSON, should fail as invalid object

  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/repo" }),
    (error) => {
      assert.equal(error.code, "INVALID_CONTRACT");
      return true;
    },
  );
});

test("handles whitespace-padded JSON strings", () => {
  const input = validContract();
  input.workflow = '  {"mode": "tdd"}  ';

  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });
  assert.deepEqual(ir.workflow, { mode: "tdd" });
});
