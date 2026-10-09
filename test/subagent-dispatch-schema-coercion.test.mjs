import assert from "node:assert/strict";
import test from "node:test";

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { Compile } = await import(pathToFileURL(createRequire(new URL('../packages/pi-subagents-enhanced/package.json',import.meta.url)).resolve('typebox/compile')));
import { TYPED_SUBAGENT_PARAMETERS } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

// The v2 public schema is flat. Nested values are no longer part of the
// dispatch contract; the schema accepts the flat coding shape and rejects the
// retired v1 containers/fields before runtime compilation.
const validator = Compile(TYPED_SUBAGENT_PARAMETERS);

function validCodingContract() {
  return {
    title: "Test flat v2 fields",
    agent: "executor",
    task: "Verify the unified v2 schema.",
    writePaths: ["src/index.ts"],
    acceptance: { criteria: ["Criterion one."] },
  };
}

test("schema accepts a native flat v2 coding contract", () => {
  assert.equal(validator.Check(validCodingContract()), true);
});

test("schema accepts optional flat v2 coding fields", () => {
  const input = { ...validCodingContract(), model: "codex-pool/gpt-5.6-sol", worktree: true, cwd: "/repo" };
  assert.equal(validator.Check(input), true);
});

test("schema rejects retired nested v1 containers", () => {
  for (const field of ["requirements", "context", "boundaries", "execution"]) {
    const input = { ...validCodingContract(), [field]: {} };
    assert.equal(validator.Check(input), false, `${field} must not be accepted by v2 schema`);
  }
});

test("schema rejects retired identity and risk fields", () => {
  for (const field of ["version", "taskId", "risk"]) {
    const input = { ...validCodingContract(), [field]: "retired" };
    assert.equal(validator.Check(input), false, `${field} must be rejected by schema`);
  }
});

test("schema rejects missing task and invalid flat field types", () => {
  const missingTask = validCodingContract();
  delete missingTask.task;
  assert.equal(validator.Check(missingTask), true, "root schema leaves required-field routing to the compiler");
  for (const value of [7, false, null, []]) {
    assert.equal(validator.Check({ ...validCodingContract(), task: value }), false);
  }
  for (const value of ["", "   "]) {
    assert.equal(validator.Check({ ...validCodingContract(), model: value }), false);
  }
});

test("schema accepts valid profiles and rejects unsafe identities", () => {
  assert.equal(validator.Check({ ...validCodingContract(), agent: "coder-alpha" }), true);
  for (const agent of ["", "   ", "coder\u0000alpha", "coder\u001falpha", "coder\u007falpha"]) {
    assert.equal(validator.Check({ ...validCodingContract(), agent }), false);
  }
});
