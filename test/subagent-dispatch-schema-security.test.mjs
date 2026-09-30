import assert from "node:assert/strict";
import test from "node:test";

import { Compile } from "../pi/npm/node_modules/typebox/build/compile/index.mjs";
import { TYPED_SUBAGENT_PARAMETERS } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

const validator = Compile(TYPED_SUBAGENT_PARAMETERS);

function codingInput() {
  return {
    title: "Schema security",
    agent: "executor",
    task: "Validate tool union fields. Test it.",
    writePaths: ["src/index.ts"],
    acceptance: { criteria: ["Pass."] },
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
});

test("root schema stays a plain top-level object without union combinators", () => {
  // glm/zai 等严格 OpenAI 兼容端只接受顶层 type:object 的参数 schema；
  // 顶层 anyOf/oneOf/allOf 会让服务端生成空 arguments（docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md）。
  assert.equal(TYPED_SUBAGENT_PARAMETERS.type, "object");
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    assert.equal(TYPED_SUBAGENT_PARAMETERS[combinator], undefined, `root schema must not use ${combinator}`);
  }
});

test("branch mixing is tolerated at the schema layer and routed by runtime shape", () => {
  // 分支互斥由 runtime 路由（action→control、writePaths→coding、其余→generic）
  // 与 compileCodingDispatchIR keypath 诊断裁决；schema 层只保证字段集合法。
  const mixed = codingInput();
  mixed.task = "generic field beside a coding contract";
  assert.equal(validator.Check(mixed), true);
});

test("all three documented branches validate against the flattened root schema", () => {
  assert.equal(validator.Check(codingInput()), true);
  assert.equal(validator.Check(genericInput()), true);
  assert.equal(validator.Check({ action: "status" }), true);
  assert.equal(validator.Check({ action: "resume", id: "run-1", message: "continue" }), true);
});

test("thinkingLevel accepts pi thinking levels on coding and generic branches and rejects invalid values", () => {
  for (const input of [codingInput(), genericInput()]) {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const withLevel = { ...input, thinkingLevel: level };
      assert.equal(validator.Check(withLevel), true, `${level} should be accepted`);
    }
    assert.equal(validator.Check({ ...input, thinkingLevel: "ultra" }), false);
    assert.equal(validator.Check({ ...input, thinkingLevel: "HIGH" }), false);
  }
});

test("public schemas reject caller-controlled execution timeouts", () => {
  const codingObject = codingInput();
  codingObject.timeoutMs = 60_000;
  assert.equal(validator.Check(codingObject), false);

  const generic = genericInput();
  generic.timeoutMs = 60_000;
  assert.equal(validator.Check(generic), false);
});
