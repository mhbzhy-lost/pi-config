import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";
import { Compile } from "../packages/pi-subagents-enhanced/node_modules/pi-subagents/node_modules/typebox/build/compile/index.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { CodingDispatchContractError, compileCodingDispatchIR } = await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");
const { createTypedSubagentExtension, TYPED_SUBAGENT_PARAMETERS } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts");

function contract(overrides = {}) {
  const base = {
    version: "dispatch-ir.v1",
    taskId: "validation-keypaths",
    title: "Expose coding validation keypaths",
    agent: "executor",
    risk: "normal",
    objective: "Return actionable validation locations.",
    requirements: ["Keep validation strict."],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["Errors identify their keypath."] },
    execution: {},
  };
  return {
    ...base,
    ...overrides,
    context: { ...base.context, ...overrides.context },
    boundaries: { ...base.boundaries, ...overrides.boundaries },
    acceptance: { ...base.acceptance, ...overrides.acceptance },
    execution: typeof overrides.execution === "string"
      ? overrides.execution
      : { ...base.execution, ...overrides.execution },
  };
}

function expectValidationError(operation, { keypath, expected, received }) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof CodingDispatchContractError, true);
    assert.equal(error.code, "INVALID_CONTRACT");
    assert.equal(error.keypath, keypath);
    assert.equal(error.detail, keypath);
    assert.match(error.message, new RegExp(`keypath=${keypath.replace(/[.$[\]\\]/g, "\\$&")}`));
    if (expected) assert.match(error.message, new RegExp(`expected ${expected}`));
    if (received) assert.match(error.message, new RegExp(`received ${received}`));
    return true;
  });
}

function extensionTool(options = {}) {
  const tools = [];
  const pi = { events: { on() { return () => {}; }, emit() {} }, registerTool(tool) { tools.push(tool); }, on() {} };
  const rpc = { async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/tmp/s", cwd: "/repo" } }; }, dispose() {} };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {}, ...options });
  return tools[0];
}

test("compiler labels a non-object coding contract at the top-level keypath", () => {
  expectValidationError(
    () => compileCodingDispatchIR(["not", "a", "contract"], { cwd: "/repo" }),
    { keypath: "$", expected: "object", received: "array" },
  );
});


test("object validation errors include the complete shape hint for unknown and missing fields", () => {
  const unknown = contract({ context: { knownFacts: [], decisions: [], relevantFiles: [], surprise: true } });
  assert.throws(() => compileCodingDispatchIR(unknown, { cwd: "/repo" }), (error) => {
    assert.match(error.message, /完整 shape 提示：\{ knownFacts, decisions, relevantFiles \}/);
    return true;
  });
  const missing = contract({ execution: { timeoutMs: 1000 } });
  delete missing.context.relevantFiles;
  assert.throws(() => compileCodingDispatchIR(missing, { cwd: "/repo" }), (error) => {
    assert.match(error.message, /完整 shape 提示：\{ knownFacts, decisions, relevantFiles \}/);
    return true;
  });
});

test("schema rejects non-object roots while routing malformed nested coding inputs to runtime validation", () => {
  const validator = Compile(TYPED_SUBAGENT_PARAMETERS);
  for (const input of [["not", "a", "contract"], "not a contract", 7, false, null]) {
    assert.equal(validator.Check(input), false, `non-object ${String(input)} should fail schema validation`);
  }
  assert.equal(validator.Check(contract({ context: { knownFacts: "plain prose", decisions: [], relevantFiles: [] } })), true);
  assert.equal(validator.Check(contract({ boundaries: { writePaths: [7], excludedWork: [], forbiddenActions: [] } })), true);
});

test("coding contract with empty writePaths is an explicit read-only dispatch", () => {
  // 空数组 writePaths 是显式只读声明：纯运行/观测任务不再被迫造假路径。
  const ir = compileCodingDispatchIR(contract({ boundaries: { writePaths: [], excludedWork: [], forbiddenActions: [] }, execution: { timeoutMs: 1000 } }), { cwd: "/repo" });
  assert.deepEqual(ir.boundaries.writePaths, []);
});

test("extension rejects a coding contract missing its version router field with a self-diagnosing error", async () => {
  // 根节点拍平后 schema 不再拒绝缺字段合同；无 version 时 runtime 路由到
  // generic 分支。含 coding 特征字段的输入必须得到指向真实原因（缺 version）
  // 的精确报错，而不是误导性的 generic agent/title/task 错误（实际派发事故：
  // 缺 version 的 coding 合同被拒后模型需自行推理根因）。
  const tool = extensionTool();
  const { version, ...versionless } = contract();
  const result = await tool.execute("missing-version", versionless, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "INVALID_CODING_ROUTER");
  assert.match(result.content[0].text, /missing version: "dispatch-ir\.v1"/);
});

test("generic dispatch without coding fields keeps the plain generic error", async () => {
  const tool = extensionTool();
  const result = await tool.execute("plain-generic-missing", { agent: "executor" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "INVALID_GENERIC_DISPATCH");
});

test("extension exposes visible and structured coding validation keypaths", async () => {
  const tool = extensionTool();
  const topLevel = await tool.execute("invalid-top-level", ["not", "a", "contract"], undefined, undefined, { cwd: "/repo" });
  assert.equal(topLevel.isError, true);
  assert.match(topLevel.content[0].text, /keypath=\$/);
  assert.equal(topLevel.details.keypath, "$");

  const nested = await tool.execute("invalid-nested", contract({ context: { knownFacts: "plain prose", decisions: [], relevantFiles: [] } }), undefined, undefined, { cwd: "/repo" });
  assert.equal(nested.isError, true);
  assert.match(nested.content[0].text, /keypath=context\.knownFacts/);
  assert.match(nested.content[0].text, /expected array; received string/);
  assert.equal(nested.details.keypath, "context.knownFacts");
  assert.equal(nested.details.detail, "context.knownFacts");
});

test("extension rejects a stringified execution timeout as an invalid public contract", async () => {
  const tool = extensionTool({ discoverAgents() { return { agents: [{ name: "executor" }] }; } });
  const result = await tool.execute("caller-string-timeout", contract({
    execution: JSON.stringify({ cwd: "/repo", timeoutMs: 60_000 }),
  }), undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "INVALID_CONTRACT");
  assert.equal(result.details.keypath, "execution.timeoutMs");
});
