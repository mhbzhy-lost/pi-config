import assert from "node:assert/strict";
import test from "node:test";

import { CodingDispatchContractError, compileCodingDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

function contract(overrides = {}) {
  return {
    title: "Observe without modifying repository files",
    agent: "executor",
    task: "Run a read-only dispatch without declaring a write path. Do not modify repository files.",
    writePaths: ["README.md"],
    acceptance: { criteria: ["The dispatch compiles as a coding contract."] },
    ...overrides,
  };
}

test("canonical compiler requires at least one declared write path", () => {
  assert.throws(
    () => compileCodingDispatchIR(contract({ writePaths: [] }), { cwd: "/repo" }),
    (error) => error instanceof CodingDispatchContractError && error.code === "INVALID_CONTRACT",
  );
});

test("canonical compiler rejects retired nested boundaries", () => {
  assert.throws(
    () => compileCodingDispatchIR({ ...contract(), boundaries: { writePaths: ["README.md"] } }, { cwd: "/repo" }),
    (error) => error.code === "INVALID_CONTRACT",
  );
});
