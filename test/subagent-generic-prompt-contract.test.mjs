import assert from "node:assert/strict";
import test from "node:test";

import { compileDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

test("compiles generic v2 dispatch without writePaths", () => {
  const input = { agent: "reviewer", title: "Boundary review", task: "Assess the proposed boundary." };
  const ir = compileDispatchIR(input);
  assert.equal(ir.kind, "generic");
  assert.equal(ir.agent, input.agent);
  assert.equal(ir.task, input.task);
  assert.equal(Object.hasOwn(ir, "writePaths"), false);
  assert.match(ir.contractHash, /^[a-f0-9]{64}$/);
});

test("generic v2 rejects coding-only fields without writePaths", () => {
  assert.throws(
    () => compileDispatchIR({ agent: "reviewer", task: "Review safely.", acceptance: { criteria: ["Evidence cited."] } }),
    (error) => error.code === "CODING_FIELD_WITHOUT_WRITE_PATHS",
  );
});
