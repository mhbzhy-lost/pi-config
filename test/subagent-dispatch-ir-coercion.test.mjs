import assert from "node:assert/strict";
import test from "node:test";
import { compileDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

test("coerces stringified writePaths and acceptance", () => {
  const ir = compileDispatchIR({ agent: "coder", task: "Implement", writePaths: '["src/**"]', acceptance: '{"criteria":["pass"]}' }, { cwd: "/repo", timeoutMs: 1000 });
  assert.deepEqual(ir.writePaths, ["src/**"]);
  assert.deepEqual(ir.acceptance.criteria, ["pass"]);
});

test("coercion produces same hash as native v2 input", () => {
  const native = compileDispatchIR({ agent: "coder", task: "Implement", writePaths: ["src"], acceptance: { criteria: ["pass"] } }, { cwd: "/repo", timeoutMs: 1000 });
  const encoded = compileDispatchIR({ agent: "coder", task: "Implement", writePaths: '["src"]', acceptance: '{"criteria":["pass"]}' }, { cwd: "/repo", timeoutMs: 1000 });
  assert.equal(native.contractHash, encoded.contractHash);
});
