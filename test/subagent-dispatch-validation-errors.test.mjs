import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { CodingDispatchContractError, compileDispatchIR } = await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");

function contract(overrides = {}) {
  return {
    title: "Expose coding validation keypaths",
    agent: "executor",
    task: "Return actionable validation locations. Keep validation strict.",
    writePaths: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"],
    acceptance: { criteria: ["Errors identify their keypath."] },
    ...overrides,
  };
}

test("compiler labels a non-object contract at the top-level keypath", () => {
  assert.throws(() => compileDispatchIR(["not", "a", "contract"], { cwd: "/repo" }), (error) => {
    assert.equal(error instanceof CodingDispatchContractError, true);
    assert.equal(error.code, "INVALID_CONTRACT");
    assert.equal(error.keypath, "$ ");
    return true;
  });
});

test("compiler rejects unknown and retired fields with actionable keypaths", () => {
  assert.throws(() => compileDispatchIR({ ...contract(), surprise: true }), (error) => {
    assert.equal(error.code, "INVALID_CONTRACT");
    assert.equal(error.keypath, "surprise");
    return true;
  });
  assert.throws(() => compileDispatchIR({ ...contract(), version: "dispatch-ir.v1" }), (error) => {
    assert.equal(error.code, "DEPRECATED_SCHEMA");
    assert.equal(error.keypath, "version");
    return true;
  });
  for (const field of ["taskId", "risk"]) {
    assert.throws(() => compileDispatchIR({ ...contract(), [field]: "retired" }), (error) => {
      assert.equal(error.code, "INVALID_CONTRACT");
      assert.equal(error.keypath, field);
      return true;
    });
  }
});

test("compiler validates flat coding fields and preserves keypaths", () => {
  assert.throws(() => compileDispatchIR({ ...contract(), writePaths: ["../escape"] }, { cwd: "/repo" }), (error) => {
    assert.equal(error.code, "INVALID_PATH");
    assert.equal(error.keypath, "writePaths[0]");
    return true;
  });
  assert.throws(() => compileDispatchIR({ ...contract(), acceptance: { criteria: [] } }, { cwd: "/repo" }), (error) => {
    assert.equal(error.code, "INVALID_CONTRACT");
    assert.equal(error.keypath, "acceptance.criteria");
    return true;
  });
});

test("generic contracts compile without coding-only fields", () => {
  const ir = compileDispatchIR({ agent: "reviewer", task: "Inspect the change." });
  assert.equal(ir.kind, "generic");
  assert.match(ir.taskId, /^dispatch-[a-f0-9]{8}$/);
});
