import assert from "node:assert/strict";
import test from "node:test";

import {
  CodingDispatchContractError,
  compileCodingDispatchIR,
} from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

function contract(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "explicit-read-only-dispatch",
    title: "Observe without modifying repository files",
    agent: "executor",
    risk: "low",
    objective: "Run a read-only dispatch without declaring a write path.",
    requirements: ["Do not modify repository files."],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: {
      writePaths: [],
      excludedWork: ["Do not edit repository files."],
      forbiddenActions: ["Do not write outside the declared scope."],
    },
    acceptance: { criteria: ["An empty write scope compiles as an explicit read-only contract."] },
    execution: { timeoutMs: 1_000 },
    ...overrides,
  };
}

test("canonical compiler accepts an explicit empty writePaths read-only contract", () => {
  const input = contract();
  const ir = compileCodingDispatchIR(input, { cwd: "/repo" });

  assert.deepEqual(ir.boundaries.writePaths, []);
  assert.equal(Array.isArray(ir.boundaries.writePaths), true);
  assert.equal(Object.hasOwn(input.boundaries, "writePaths"), true);
});

test("canonical compiler still rejects a contract with missing boundaries", () => {
  const input = contract();
  delete input.boundaries;

  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/repo" }),
    (error) => {
      assert.equal(error instanceof CodingDispatchContractError, true);
      assert.equal(error.code, "INVALID_CONTRACT");
      assert.equal(error.keypath, "$.boundaries");
      assert.match(error.message, /missing required field boundaries/);
      return true;
    },
  );
});
