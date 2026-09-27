import assert from "node:assert/strict";
import test from "node:test";

import { Compile } from "../packages/pi-subagents-enhanced/node_modules/pi-subagents/node_modules/typebox/build/compile/index.mjs";
import { TYPED_SUBAGENT_PARAMETERS } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

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
    execution: {},
  };
}

test("schema accepts native object coding contract", () => {
  const input = validCodingContract();
  assert.equal(validator.Check(input), true, "native contract should pass schema validation");
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
  input.execution = '{"worktree": true}';
  assert.equal(validator.Check(input), true, "stringified execution should pass schema validation");
});

test("schema accepts all fields stringified simultaneously", () => {
  const input = validCodingContract();
  input.requirements = '["Req."]';
  input.context = '{"knownFacts": [], "decisions": [], "relevantFiles": []}';
  input.boundaries = '{"writePaths": ["src/x.ts"], "excludedWork": [], "forbiddenActions": []}';
  input.acceptance = '{"criteria": ["Done."]}';
  input.execution = '{"worktree": true}';
  assert.equal(validator.Check(input), true, "all-stringified contract should pass schema validation");
});

test("schema only defers malformed values with the expected coding field container kind", () => {
  const objectFields = ["context", "boundaries"];

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

  // acceptance 是 coding/generic 共享字段：generic 侧数组 constraints 是真实能力，
  // 故宽松放行 object/array/string，由分支路由后的 IR/runtime 校验裁决形态。
  const malformedAcceptance = validCodingContract();
  malformedAcceptance.acceptance = { unexpected: [7] };
  assert.equal(validator.Check(malformedAcceptance), true, "malformed acceptance object should reach IR validation");
  for (const value of [["criterion"], "{\"criteria\":[\"ok\"]}"]) {
    const shared = validCodingContract();
    shared.acceptance = value;
    assert.equal(validator.Check(shared), true, `acceptance ${JSON.stringify(value)} belongs to a shared branch`);
  }
  for (const value of [7, false, null]) {
    const invalid = validCodingContract();
    invalid.acceptance = value;
    assert.equal(validator.Check(invalid), false, `acceptance must reject ${value === null ? "null" : typeof value} at schema validation`);
  }

  // execution 是严格 public 容器：没有 loose object 回退，也没有 caller timeout。
  // 畸形对象与非 object/string 值在 schema 层被拒绝，不进 IR 校验。
  for (const value of [{ unexpected: [7] }, [], 7, false, null]) {
    const invalid = validCodingContract();
    invalid.execution = value;
    assert.equal(validator.Check(invalid), false, `execution must reject ${value === null ? "null" : typeof value} at schema validation`);
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

test("schema accepts non-empty coding model requests and rejects empty or retired fields", () => {
  for (const value of ["codex-pool/gpt-5.6-sol", " gpt-5.6-sol "]) {
    const input = validCodingContract();
    input.model = value;
    assert.equal(validator.Check(input), true);
  }
  for (const value of ["", "   "]) {
    const invalid = validCodingContract();
    invalid.model = value;
    assert.equal(validator.Check(invalid), false);
  }
  const retired = validCodingContract();
  retired.modelTier = "terra";
  assert.equal(validator.Check(retired), false);
});

test("missing required fields pass the schema layer and are rejected by runtime routing", async () => {
  // 根节点拍平后不再承担分支 required；缺 version 的合同被 runtime 路由到
  // generic 分支并以 INVALID_GENERIC_DISPATCH 拒绝，不会静默成功。
  const input = validCodingContract();
  delete input.version;
  assert.equal(validator.Check(input), true, "flattened schema only guides field sets");
});

test("schema accepts arbitrary valid coding profiles and rejects invalid identities", () => {
  const input = validCodingContract();
  input.agent = "coder-alpha";
  assert.equal(validator.Check(input), true);
  for (const agent of ["", "   ", "coder\u0000alpha", "coder\u001falpha", "coder\u007falpha", "coder\u009falpha"]) {
    const invalid = validCodingContract();
    invalid.agent = agent;
    assert.equal(validator.Check(invalid), false);
  }
});
