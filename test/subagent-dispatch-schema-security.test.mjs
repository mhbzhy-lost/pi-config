import assert from "node:assert/strict";
import test from "node:test";

import { Compile } from "../pi/npm/node_modules/typebox/build/compile/index.mjs";
import { TYPED_SUBAGENT_PARAMETERS } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

const validator = Compile(TYPED_SUBAGENT_PARAMETERS);

function codingInput() {
  return {
    version: "dispatch-ir.v1", taskId: "schema-security", title: "Schema security", agent: "executor",
    risk: "normal", objective: "Validate tool union fields.", workflow: { mode: "tdd" }, requirements: ["Test it."],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: ["src/index.ts"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["Pass."] }, execution: { timeoutMs: 60_000 },
  };
}

function genericInput() {
  return { agent: "delegate", title: "Generic schema", task: "Validate model fields." };
}

test("coding and generic schemas accept trimmed non-empty model requests", () => {
  for (const input of [codingInput(), genericInput()]) {
    input.model = " provider/model-id ";
    assert.equal(validator.Check(input), true);
  }
});

test("coding and generic schemas reject empty model and retired modelTier fields", () => {
  for (const makeInput of [codingInput, genericInput]) {
    for (const model of ["", "   "]) {
      const input = makeInput();
      input.model = model;
      assert.equal(validator.Check(input), false);
    }
    const input = makeInput();
    input.modelTier = "terra";
    assert.equal(validator.Check(input), false);
  }
});

test("schema routes coding and generic contracts by shape rather than agent name", () => {
  const genericExecutor = genericInput();
  genericExecutor.agent = "executor";
  assert.equal(validator.Check(genericExecutor), true);

  const mixed = codingInput();
  mixed.task = "This generic field must not be accepted by the coding schema.";
  assert.equal(validator.Check(mixed), false);
});
