import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../pi/npm/node_modules/jiti/lib/jiti.mjs";
import { Compile } from "../pi/npm/node_modules/typebox/build/compile/index.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { CodingDispatchContractError, compileCodingDispatchIR } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts");
const { createTypedSubagentExtension, TYPED_SUBAGENT_PARAMETERS } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts");

function contract(overrides = {}) {
  const base = {
    version: "dispatch-ir.v1",
    taskId: "validation-keypaths",
    title: "Expose coding validation keypaths",
    agent: "executor",
    risk: "normal",
    objective: "Return actionable validation locations.",
    workflow: { mode: "tdd" },
    requirements: ["Keep validation strict."],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: ["packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["Errors identify their keypath."] },
    execution: { timeoutMs: 60_000 },
  };
  return {
    ...base,
    ...overrides,
    workflow: { ...base.workflow, ...overrides.workflow },
    context: { ...base.context, ...overrides.context },
    boundaries: { ...base.boundaries, ...overrides.boundaries },
    acceptance: { ...base.acceptance, ...overrides.acceptance },
    execution: { ...base.execution, ...overrides.execution },
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

function extensionTool() {
  const tools = [];
  const pi = { events: { on() { return () => {}; }, emit() {} }, registerTool(tool) { tools.push(tool); }, on() {} };
  const rpc = { async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/tmp/s", cwd: "/repo" } }; }, dispose() {} };
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  return tools[0];
}

test("compiler labels a non-object coding contract at the top-level keypath", () => {
  expectValidationError(
    () => compileCodingDispatchIR(["not", "a", "contract"], { cwd: "/repo" }),
    { keypath: "$", expected: "object", received: "array" },
  );
});

test("compiler reports dotted and indexed keypaths with structural runtime types", () => {
  expectValidationError(
    () => compileCodingDispatchIR(contract({ context: { knownFacts: "plain prose", decisions: [], relevantFiles: [] } }), { cwd: "/repo" }),
    { keypath: "context.knownFacts", expected: "array", received: "string" },
  );
  expectValidationError(
    () => compileCodingDispatchIR(contract({ workflow: { mode: 7 } }), { cwd: "/repo" }),
    { keypath: "workflow.mode", expected: "string", received: "number" },
  );
  expectValidationError(
    () => compileCodingDispatchIR(contract({ boundaries: { writePaths: [7], excludedWork: [], forbiddenActions: [] } }), { cwd: "/repo" }),
    { keypath: "boundaries.writePaths[0]", expected: "string", received: "number" },
  );
});

test("schema rejects non-object roots while routing malformed nested coding inputs to runtime validation", () => {
  const validator = Compile(TYPED_SUBAGENT_PARAMETERS);
  for (const input of [["not", "a", "contract"], "not a contract", 7, false, null]) {
    assert.equal(validator.Check(input), false, `non-object ${String(input)} should fail schema validation`);
  }
  assert.equal(validator.Check(contract({ context: { knownFacts: "plain prose", decisions: [], relevantFiles: [] } })), true);
  assert.equal(validator.Check(contract({ boundaries: { writePaths: [7], excludedWork: [], forbiddenActions: [] } })), true);
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
