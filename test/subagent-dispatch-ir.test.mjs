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
  // cwd and worktree are valid generic optional fields (only acceptance is coding-only)
  const genericWithCwd = compileDispatchIR({ agent: "a", task: "t", cwd: "/repo" }, options);
  assert.equal(genericWithCwd.kind, "generic");
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

test("compiles a task far larger than the legacy 4 KiB bound and renders its prompt", () => {
  // 真实场景：派发审阅/执行任务时必须携带完整说明（pi/AGENTS.md 全局约束），
  // 二十余 KiB 的正文属合法输入，不得被标识符共用的 4 KiB 上界拒绝。
  const task = "审核重点：核对 \"证据链\" 与实现是否一致。\n".repeat(400);
  const bytes = Buffer.byteLength(task);
  assert.ok(bytes > 4 * 1024 && bytes <= 32 * 1024, `fixture must sit between the bounds, got ${bytes}`);

  const ir = compileDispatchIR({ agent: "reviewer", task, title: "大 task 派发" }, options);
  assert.equal(ir.kind, "generic");
  assert.equal(ir.task, task.trim());

  const prompt = renderDispatchPrompt(ir);
  assert.ok(Buffer.byteLength(prompt) <= 128 * 1024, "prompt must stay within its own bound");
  assert.ok(prompt.includes("审核重点"), "rendered prompt must carry the full task body");
});

test("accepts a task at the 32 KiB bound and still rejects one beyond it as fail-closed", () => {
  const atBound = "a".repeat(32 * 1024);
  const ir = compileDispatchIR({ agent: "executor", task: atBound, title: "bound" }, options);
  assert.equal(ir.task.length, 32 * 1024);
  assert.ok(Buffer.byteLength(renderDispatchPrompt(ir)) <= 128 * 1024);

  const over = () => compileDispatchIR({ agent: "executor", task: `${atBound}b`, title: "bound" }, options);
  expectCode("INVALID_CONTRACT", over);
  assert.throws(over, (e) => e.keypath === "task" && /exceeds 32768 bytes/.test(e.message));
});

test("keeps identifier fields at their original bounds when the task bound is raised", () => {
  // 放宽 task 不得连带放宽 agent/title/model 等标识符字段的上界。
  expectCode("INVALID_CONTRACT", () => compileDispatchIR({ agent: "a".repeat(4097), task: "Do it" }, options));
  expectCode("INVALID_CONTRACT", () => compileDispatchIR({ agent: "executor", task: "Do it", title: "t".repeat(4097) }, options));
  expectCode("INVALID_CONTRACT", () => compileDispatchIR({ agent: "executor", task: "Do it", model: "m".repeat(513) }, options));
});
