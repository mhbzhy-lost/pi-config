import assert from "node:assert/strict";
import test from "node:test";
import { compileDispatchIR, isCodingDispatch, renderDispatchPrompt, DEPRECATED_SCHEMA, CodingDispatchContractError } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

const options = { cwd: "/repo", timeoutMs: 60000 };
const expectCode = (code, fn) => assert.throws(fn, (e) => e instanceof CodingDispatchContractError && e.code === code);

test("compiles generic v2 and derives taskId from hash", () => {
  const ir = compileDispatchIR({ agent: " executor ", task: " Do research. " }, options);
  assert.equal(ir.kind, "generic");
  assert.equal(ir.agent, "executor");
  assert.equal(ir.task, "Do research.");
  assert.equal(ir.title, "Do research.");
  assert.match(ir.contractHash, /^[a-f0-9]{64}$/);
  assert.equal(ir.taskId, `dispatch-${ir.contractHash.slice(0, 8)}`);
  assert.equal(Object.isFrozen(ir), true);
});

test("compiles coding v2 with normalized paths and host timeout", () => {
  const ir = compileDispatchIR({ agent: "coder", task: "Implement it", writePaths: [" src/** ", "src/**"], acceptance: { criteria: ["Tests pass"] }, worktree: true }, options);
  assert.equal(ir.kind, "coding");
  assert.deepEqual(ir.writePaths, ["src/**"]);
  assert.deepEqual(ir.acceptance, { criteria: ["Tests pass"] });
  assert.equal(ir.worktree, true);
  assert.equal(ir.cwd, "/repo");
  assert.equal(ir.timeoutMs, 60000);
});

test("routes by writePaths key and validates coding-only fields", () => {
  assert.equal(isCodingDispatch({ agent: "a", task: "t" }), false);
  assert.equal(isCodingDispatch({ agent: "a", task: "t", writePaths: [] }), true);
  expectCode("INVALID_CONTRACT", () => compileDispatchIR({ agent: "a", task: "t", writePaths: [] }, options));
  expectCode("CODING_FIELD_WITHOUT_WRITE_PATHS", () => compileDispatchIR({ agent: "a", task: "t", cwd: "/repo" }, options));
  expectCode("INVALID_PATH", () => compileDispatchIR({ agent: "a", task: "t", writePaths: ["../x"], acceptance: { criteria: ["ok"] } }, options));
  expectCode("INVALID_CONTRACT", () => compileDispatchIR({ agent: "a", task: "t", writePaths: ["src"], acceptance: { criteria: [] } }, options));
});

test("rejects model timeout and deprecated v1 with migration guidance", () => {
  expectCode("INVALID_CONTRACT", () => compileDispatchIR({ agent: "a", task: "t", writePaths: ["src"], acceptance: { criteria: ["ok"] }, timeoutMs: 1 }, options));
  assert.equal(DEPRECATED_SCHEMA.code, "DEPRECATED_SCHEMA");
  assert.match(DEPRECATED_SCHEMA.message, /Migration/);
  assert.throws(() => compileDispatchIR({ version: "dispatch-ir.v1", agent: "a", task: "t" }, options), { code: "DEPRECATED_SCHEMA" });
});

test("hash excludes taskId and is stable by semantic object key order", () => {
  const a = compileDispatchIR({ agent: "a", task: "t", model: "m" }, options);
  const b = compileDispatchIR({ model: "m", task: "t", agent: "a" }, options);
  assert.equal(a.contractHash, b.contractHash);
  assert.equal(a.taskId, b.taskId);
});

test("renders generic and coding prompt sections", () => {
  const generic = renderDispatchPrompt(compileDispatchIR({ agent: "a", task: "t" }, options));
  const coding = renderDispatchPrompt(compileDispatchIR({ agent: "a", task: "t", writePaths: ["src"], acceptance: { criteria: ["done"] } }, options));
  assert.match(generic, /# Dispatch Contract/);
  assert.doesNotMatch(generic, /## Write Scope/);
  assert.match(coding, /## Write Scope/);
  assert.match(coding, /## Acceptance Criteria/);
});
