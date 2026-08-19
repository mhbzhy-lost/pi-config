import assert from "node:assert/strict";
import test from "node:test";

import { Compile } from "../pi/npm/node_modules/typebox/build/compile/index.mjs";
import { TYPED_SUBAGENT_PARAMETERS } from "../scripts/lib/subagent-dispatch/extension.ts";

/**
 * Tests that the TYPED_SUBAGENT_PARAMETERS JSON Schema tolerates stringified
 * JSON in nested fields. Some models (qwen3.8-max, gpt-5.6-sol) output nested
 * objects/arrays as JSON strings. The schema must accept these so that
 * compileCodingDispatchIR (ir.ts) can perform the real coercion + validation.
 *
 * This tests the schema validation layer (pi-ai validateToolArguments), which
 * runs BEFORE execute() is called.
 */

const validator = Compile(TYPED_SUBAGENT_PARAMETERS);

function validCodingContract() {
  return {
    version: "dispatch-ir.v1",
    taskId: "schema-coercion-test",
    title: "Test schema tolerates stringified fields",
    agent: "executor",
    risk: "normal",
    objective: "Verify schema accepts stringified nested fields.",
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

test("schema accepts native object coding contract", () => {
  const input = validCodingContract();
  assert.equal(validator.Check(input), true, "native contract should pass schema validation");
});

test("schema accepts stringified workflow", () => {
  const input = validCodingContract();
  input.workflow = '{"mode": "tdd"}';
  assert.equal(validator.Check(input), true, "stringified workflow should pass schema validation");
});

test("schema accepts stringified requirements", () => {
  const input = validCodingContract();
  input.requirements = '["First requirement.", "Second requirement."]';
  assert.equal(validator.Check(input), true, "stringified requirements should pass schema validation");
});

test("schema accepts stringified context", () => {
  const input = validCodingContract();
  input.context = '{"knownFacts": ["Fact."], "decisions": ["Decision."], "relevantFiles": ["src/a.ts"]}';
  assert.equal(validator.Check(input), true, "stringified context should pass schema validation");
});

test("schema accepts stringified boundaries", () => {
  const input = validCodingContract();
  input.boundaries = '{"writePaths": ["src/a.ts"], "excludedWork": [], "forbiddenActions": []}';
  assert.equal(validator.Check(input), true, "stringified boundaries should pass schema validation");
});

test("schema accepts stringified acceptance", () => {
  const input = validCodingContract();
  input.acceptance = '{"criteria": ["Must pass."]}';
  assert.equal(validator.Check(input), true, "stringified acceptance should pass schema validation");
});

test("schema accepts stringified execution", () => {
  const input = validCodingContract();
  input.execution = '{"timeoutMs": 120000, "worktree": true}';
  assert.equal(validator.Check(input), true, "stringified execution should pass schema validation");
});

test("schema accepts all fields stringified simultaneously", () => {
  const input = validCodingContract();
  input.workflow = '{"mode": "tdd"}';
  input.requirements = '["Req."]';
  input.context = '{"knownFacts": [], "decisions": [], "relevantFiles": []}';
  input.boundaries = '{"writePaths": ["src/x.ts"], "excludedWork": [], "forbiddenActions": []}';
  input.acceptance = '{"criteria": ["Done."]}';
  input.execution = '{"timeoutMs": 90000}';
  assert.equal(validator.Check(input), true, "all-stringified contract should pass schema validation");
});

test("schema only defers malformed values with the expected coding field container kind", () => {
  const objectFields = ["workflow", "context", "boundaries", "acceptance", "execution"];

  for (const field of objectFields) {
    const malformed = validCodingContract();
    malformed[field] = { unexpected: [7] };
    assert.equal(validator.Check(malformed), true, `${field} malformed object should reach IR validation`);

    for (const value of [[], 7, false, null]) {
      const invalid = validCodingContract();
      invalid[field] = value;
      assert.equal(validator.Check(invalid), false, `${field} must reject ${value === null ? "null" : typeof value} at schema validation`);
    }
  }

  const malformedRequirements = validCodingContract();
  malformedRequirements.requirements = [7];
  assert.equal(validator.Check(malformedRequirements), true, "malformed requirements members should reach IR validation");
  for (const value of [{ unexpected: true }, 7, false, null]) {
    const invalid = validCodingContract();
    invalid.requirements = value;
    assert.equal(validator.Check(invalid), false, `requirements must reject ${value === null ? "null" : typeof value} at schema validation`);
  }
});

test("schema accepts optional coding modelTier values", () => {
  for (const modelTier of ["luna", "terra"]) {
    const input = validCodingContract();
    input.modelTier = modelTier;
    assert.equal(validator.Check(input), true, `${modelTier} modelTier should pass schema validation`);
  }
});

test("schema rejects unsupported coding modelTier values", () => {
  const input = validCodingContract();
  input.modelTier = "sol";
  assert.equal(validator.Check(input), false, "unsupported modelTier should fail schema validation");
});

test("schema still rejects contract missing required fields", () => {
  const input = validCodingContract();
  delete input.version;
  assert.equal(validator.Check(input), false, "missing version should fail");
});

test("schema still rejects non-executor agent in coding contract", () => {
  const input = validCodingContract();
  input.agent = "researcher";
  // This should not match CODING_SCHEMA (agent enum is ["executor"]),
  // and should not match GENERIC_SCHEMA either (it has version field which is additional).
  // Actually GENERIC_SCHEMA has additionalProperties:false and doesn't list version,
  // so this should fail all anyOf branches.
  assert.equal(validator.Check(input), false, "non-executor agent with coding fields should fail");
});
