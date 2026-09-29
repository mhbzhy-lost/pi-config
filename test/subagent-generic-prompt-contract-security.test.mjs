import assert from "node:assert/strict";
import test from "node:test";

import { compileDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

test("generic v2 compiles only the flat generic fields", () => {
  const ir = compileDispatchIR({ agent: "reviewer", task: "Review the implementation." });
  assert.equal(ir.kind, "generic");
  assert.equal(ir.title, "Review the implementation.");
  assert.equal(Object.hasOwn(ir, "writePaths"), false);
});

test("generic v2 rejects retired schema fields", () => {
  for (const field of ["taskId", "risk", "requirements", "context", "boundaries", "execution"]) {
    assert.throws(
      () => compileDispatchIR({ agent: "reviewer", task: "Review safely.", [field]: field === "taskId" || field === "risk" ? "retired" : {} }),
      (error) => error.code === "INVALID_CONTRACT",
      field,
    );
  }
});

test("generic v2 rejects version with DEPRECATED_SCHEMA", () => {
  assert.throws(
    () => compileDispatchIR({ version: "dispatch-ir.v1", agent: "reviewer", task: "Review safely." }),
    (error) => error.code === "DEPRECATED_SCHEMA",
  );
});
