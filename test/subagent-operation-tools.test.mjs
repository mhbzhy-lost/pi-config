// S1 合同测试：subagent_roster / subagent_start / subagent_run_* 七工具薄 factory。
// 依据：docs/plans/2026-10-16-subagent-operation-tools-guidance.md §S1 与
// docs/plans/records/2026-10-16-operation-tools/contract.md §2.1/§3。
// 覆盖：七 schema（单 object 根、无顶层组合子、字段不扩）、真实 callback spy 委托、
// 调用方 action 与跨面/未知字段 fail closed（不触下游）、缺/空/错型必填 agent/task 与
// steer/resume message 不触回调、raw 引用不变。
import assert from "node:assert/strict";
import test from "node:test";

import { Compile } from "../pi/npm/node_modules/typebox/build/compile/index.mjs";
import {
  SUBAGENT_ROSTER_PARAMETERS,
  SUBAGENT_START_PARAMETERS,
  SUBAGENT_RUN_STATUS_PARAMETERS,
  SUBAGENT_RUN_STEER_PARAMETERS,
  SUBAGENT_RUN_INTERRUPT_PARAMETERS,
  SUBAGENT_RUN_RESUME_PARAMETERS,
  SUBAGENT_RUN_STOP_PARAMETERS,
  createSubagentOperationTools,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts";

const TOOL_NAMES = [
  "subagent_roster",
  "subagent_start",
  "subagent_run_status",
  "subagent_run_steer",
  "subagent_run_interrupt",
  "subagent_run_resume",
  "subagent_run_stop",
];

function makeHarness() {
  const calls = { start: [], control: [] };
  const sentinel = { content: [{ type: "text", text: "raw-passthrough" }], isError: false, details: { marker: "sentinel" } };
  const deps = {
    executeStart: (...args) => { calls.start.push(args); return sentinel; },
    executeControl: (...args) => { calls.control.push(args); return sentinel; },
  };
  const tools = createSubagentOperationTools(deps);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, sentinel, tools, byName };
}

function codingStart() {
  return { agent: "executor", task: "落地实现", writePaths: ["src/index.ts"], acceptance: { criteria: ["通过合同测试"] } };
}

test("seven model-only tools are produced with frozen single-object parameter schemas", () => {
  const { tools } = makeHarness();
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of tools) {
    assert.equal(tool.exposure, "model-only", `${tool.name} must stay model-only`);
    assert.equal(Object.isFrozen(tool), true);
    assert.equal(Object.isFrozen(tool.parameters), true);
    assert.equal(tool.parameters.type, "object", `${tool.name} root must be a single object`);
    assert.equal(tool.parameters.additionalProperties, false);
    for (const combinator of ["anyOf", "oneOf", "allOf", "if"]) {
      assert.equal(tool.parameters[combinator], undefined, `${tool.name} root must not use ${combinator}`);
    }
    assert.equal(typeof tool.execute, "function");
  }
});

test("each schema validates its frozen field surface and rejects unknown fields", () => {
  const validators = {
    subagent_roster: Compile(SUBAGENT_ROSTER_PARAMETERS),
    subagent_start: Compile(SUBAGENT_START_PARAMETERS),
    subagent_run_status: Compile(SUBAGENT_RUN_STATUS_PARAMETERS),
    subagent_run_steer: Compile(SUBAGENT_RUN_STEER_PARAMETERS),
    subagent_run_interrupt: Compile(SUBAGENT_RUN_INTERRUPT_PARAMETERS),
    subagent_run_resume: Compile(SUBAGENT_RUN_RESUME_PARAMETERS),
    subagent_run_stop: Compile(SUBAGENT_RUN_STOP_PARAMETERS),
  };
  // 合法输入（含空参数）逐工具通过。
  const valid = [
    ["subagent_roster", {}],
    ["subagent_start", { agent: "delegate", task: "只读调研" }],
    ["subagent_start", codingStart()],
    ["subagent_start", { ...codingStart(), model: " provider/model-id ", thinkingLevel: "high", title: "t", cwd: "/repo", worktree: true, output: false, outputMode: "inline", artifacts: false, progress: true, skill: "review", reads: ["a"] }],
    ["subagent_run_status", {}],
    ["subagent_run_status", { id: "run-1", index: 0 }],
    ["subagent_run_steer", { message: "改成只改测试" }],
    ["subagent_run_interrupt", { runId: "run-2" }],
    ["subagent_run_resume", { message: "继续", output: false, outputMode: "file-only" }],
    ["subagent_run_resume", { id: "run-3", message: "继续", output: "out.md" }],
    ["subagent_run_stop", { dir: "/repo/.pi/worktrees/w1" }],
  ];
  for (const [name, input] of valid) {
    assert.equal(validators[name].Check(input), true, `${name} should accept ${JSON.stringify(input)}`);
  }
  // 未知字段/跨面字段/不支持字段逐工具拒绝（additionalProperties:false，字段不扩）。
  const invalid = [
    ["subagent_roster", { action: "list" }],
    ["subagent_roster", { agent: "delegate" }],
    ["subagent_start", { agent: "delegate", task: "t", action: "status" }],
    ["subagent_start", { agent: "delegate", task: "t", id: "run-1" }],
    ["subagent_start", { agent: "delegate", task: "t", context: "reuse" }],
    ["subagent_start", { agent: "delegate", task: "t", timeoutMs: 1000 }],
    ["subagent_start", { agent: "delegate", task: "t", version: 2 }],
    ["subagent_start", { task: "缺 agent" }],
    ["subagent_start", { agent: "delegate" }],
    ["subagent_start", { ...codingStart(), writePaths: [] }],
    ["subagent_run_status", { message: "x" }],
    ["subagent_run_status", { view: "transcript" }],
    ["subagent_run_steer", { id: "run-1" }],
    ["subagent_run_steer", { message: "" }],
    ["subagent_run_steer", { message: "go", mode: "auto" }],
    ["subagent_run_steer", { message: "go", model: "provider/x" }],
    ["subagent_run_interrupt", { message: "x" }],
    ["subagent_run_resume", {}],
    ["subagent_run_resume", { message: "" }],
    ["subagent_run_resume", { message: "x", model: "provider/x" }],
    ["subagent_run_resume", { message: "x", outputMode: "inline" }],
    ["subagent_run_resume", { message: "x", childId: "c1" }],
    ["subagent_run_resume", { message: "x", output: 3 }],
    ["subagent_run_stop", { message: "x" }],
    ["subagent_run_stop", { action: "status" }],
  ];
  for (const [name, input] of invalid) {
    assert.equal(validators[name].Check(input), false, `${name} should reject ${JSON.stringify(input)}`);
  }
});

test("start does not expose context or runtime-only fields at the schema layer", () => {
  const properties = SUBAGENT_START_PARAMETERS.properties;
  for (const forbidden of ["context", "timeoutMs", "version", "action", "id", "runId", "dir", "index", "message"]) {
    assert.equal(properties[forbidden], undefined, `subagent_start must not expose ${forbidden}`);
  }
  assert.deepEqual(SUBAGENT_START_PARAMETERS.required, ["agent", "task"]);
});

test("resume keeps reachable output/outputMode with file-only mode and no model switching", () => {
  const properties = SUBAGENT_RUN_RESUME_PARAMETERS.properties;
  assert.deepEqual(properties.outputMode.enum, ["file-only"]);
  assert.ok(properties.output.anyOf.some((branch) => branch.const === false));
  assert.ok(properties.output.anyOf.some((branch) => branch.type === "string"));
  assert.equal(properties.model, undefined);
});

test("callbacks receive ToolDefinition.execute argument order unchanged", async () => {
  const { byName, calls, sentinel } = makeHarness();
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/repo" };
  const startInput = codingStart();
  assert.equal(await byName.subagent_start.execute("tc-1", startInput, signal, onUpdate, ctx), sentinel);
  assert.deepEqual(calls.start, [["tc-1", { agent: "executor", task: "落地实现", writePaths: ["src/index.ts"], acceptance: { criteria: ["通过合同测试"] } }, signal, onUpdate, ctx]]);
  assert.equal(await byName.subagent_run_status.execute("tc-2", { id: "run-1" }, signal, onUpdate, ctx), sentinel);
  assert.deepEqual(calls.control.at(-1), ["tc-2", { action: "status", id: "run-1" }, signal, onUpdate, ctx]);
});

test("roster delegates an empty args surface to the fixed list action", async () => {
  const { byName, calls, sentinel } = makeHarness();
  assert.equal(await byName.subagent_roster.execute("tc-3", {}, undefined, undefined, { cwd: "/repo" }), sentinel);
  assert.deepEqual(calls.control, [["tc-3", { action: "list" }, undefined, undefined, { cwd: "/repo" }]]);
  assert.deepEqual(calls.start, []);
});

test("unknown action in caller args fails closed on every tool without reaching the dispatcher", async () => {
  const { byName, calls } = makeHarness();
  const cases = [
    ["subagent_roster", { action: "status" }],
    ["subagent_roster", { action: "list" }],
    ["subagent_start", { agent: "delegate", task: "t", action: "status" }],
    ["subagent_run_status", { id: "r", action: "stop" }],
    ["subagent_run_steer", { message: "go", action: "resume" }],
    ["subagent_run_interrupt", { action: "list" }],
    ["subagent_run_resume", { id: "r", message: "m", action: "stop" }],
    ["subagent_run_stop", { action: "steer" }],
  ];
  let tc = 10;
  for (const [name, input] of cases) {
    tc += 1;
    const result = await byName[name].execute(`tc-${tc}`, input, undefined, undefined, {});
    assert.equal(result.isError, true, `${name} must fail closed on caller action`);
    assert.equal(result.details.code, "INVALID_DISPATCH");
    assert.equal(result.details.keypath, "$.action");
    assert.match(result.content[0].text, /action/);
  }
  assert.deepEqual(calls.start, [], "caller action must not reach executeStart");
  assert.deepEqual(calls.control, [], "caller action must not reach executeControl");
});

test("required agent/task and steer/resume message fail closed with compatible codes before callbacks", async () => {
  const { byName, calls } = makeHarness();
  const cases = [
    ["subagent_start", {}, "INVALID_GENERIC_DISPATCH", "$.agent"],
    ["subagent_start", { agent: "delegate" }, "INVALID_GENERIC_DISPATCH", "$.task"],
    ["subagent_start", { agent: "", task: "t" }, "INVALID_GENERIC_DISPATCH", "$.agent"],
    ["subagent_start", { agent: 42, task: "t" }, "INVALID_GENERIC_DISPATCH", "$.agent"],
    ["subagent_start", { agent: "delegate", task: "" }, "INVALID_GENERIC_DISPATCH", "$.task"],
    ["subagent_start", { agent: "delegate", task: null }, "INVALID_GENERIC_DISPATCH", "$.task"],
    ["subagent_run_steer", {}, "INVALID_DISPATCH", "$.message"],
    ["subagent_run_steer", { message: "" }, "INVALID_DISPATCH", "$.message"],
    ["subagent_run_steer", { message: 7 }, "INVALID_DISPATCH", "$.message"],
    ["subagent_run_resume", {}, "INVALID_RESUME_MESSAGE", "$.message"],
    ["subagent_run_resume", { message: "" }, "INVALID_RESUME_MESSAGE", "$.message"],
    ["subagent_run_resume", { message: false }, "INVALID_RESUME_MESSAGE", "$.message"],
  ];
  let tc = 200;
  for (const [name, input, code, keypath] of cases) {
    tc += 1;
    const result = await byName[name].execute(`tc-${tc}`, input, undefined, undefined, {});
    assert.equal(result.isError, true, `${name} must fail closed on ${JSON.stringify(input)}`);
    assert.equal(result.details.code, code, `${name} must keep compatible code for ${JSON.stringify(input)}`);
    assert.equal(result.details.keypath, keypath);
  }
  assert.deepEqual(calls.start, [], "missing required start fields must not reach executeStart");
  assert.deepEqual(calls.control, [], "missing required message must not reach executeControl");
  // 合法必填值正常触达回调：固定注入不变。
  await byName.subagent_start.execute("tc-ok-start", { agent: "delegate", task: "t" }, undefined, undefined, {});
  assert.equal(calls.start.length, 1);
  assert.deepEqual(calls.start[0][1], { agent: "delegate", task: "t" });
  await byName.subagent_run_steer.execute("tc-ok-steer", { id: "r", message: "go" }, undefined, undefined, {});
  assert.equal(calls.control.length, 1);
  assert.deepEqual(calls.control[0][1], { action: "steer", id: "r", message: "go" });
  await byName.subagent_run_resume.execute("tc-ok-resume", { message: "m" }, undefined, undefined, {});
  assert.equal(calls.control.length, 2);
  assert.deepEqual(calls.control[1][1], { action: "resume", message: "m" });
});

test("cross-face and unknown fields fail closed without reaching the dispatcher", async () => {
  const { byName, calls } = makeHarness();
  const cases = [
    ["subagent_start", { agent: "delegate", task: "t", id: "run-1" }],
    ["subagent_start", { agent: "delegate", task: "t", message: "hi" }],
    ["subagent_start", { agent: "delegate", task: "t", runId: "r" }],
    ["subagent_run_status", { message: "hi" }],
    ["subagent_run_status", { model: "provider/x" }],
    ["subagent_run_steer", { message: "go", childId: "c1" }],
    ["subagent_run_interrupt", { message: "x" }],
    ["subagent_run_resume", { message: "go", view: "transcript" }],
    ["subagent_run_stop", { message: "x" }],
    ["subagent_roster", { agent: "delegate" }],
  ];
  let tc = 100;
  for (const [name, input] of cases) {
    tc += 1;
    const result = await byName[name].execute(`tc-${tc}`, input, undefined, undefined, {});
    assert.equal(result.isError, true, `${name} must fail closed on ${JSON.stringify(input)}`);
    assert.equal(result.details.code, "INVALID_DISPATCH");
    assert.equal(typeof result.details.keypath, "string");
    assert.match(result.content[0].text, /INVALID_DISPATCH/);
  }
  assert.deepEqual(calls.start, [], "start dispatcher must not receive cross-face input");
  assert.deepEqual(calls.control, [], "control dispatcher must not receive cross-face input");
});

test("direct raw non-object calls fail closed at the run entry", async () => {
  const { byName, calls } = makeHarness();
  for (const name of TOOL_NAMES) {
    for (const raw of [null, undefined, 42, "args", [], true]) {
      const result = await byName[name].execute("tc-raw", raw, undefined, undefined, {});
      assert.equal(result.isError, true);
      assert.equal(result.details.code, "INVALID_DISPATCH");
    }
  }
  assert.deepEqual(calls.start, []);
  assert.deepEqual(calls.control, []);
});

test("callback results are returned by raw reference and caller input objects stay untouched", async () => {
  const { byName, sentinel } = makeHarness();
  const input = Object.freeze({ id: "run-9", message: "keep" });
  const snapshot = structuredClone(input);
  const result = await byName.subagent_run_resume.execute("tc-ref", input, undefined, undefined, {});
  assert.equal(result, sentinel, "callback result must be returned unchanged (raw reference invariance)");
  assert.deepEqual(input, snapshot, "caller input must not be mutated");
});

test("start surface reaches executeStart with no action injection and no control fields", async () => {
  const { byName, calls } = makeHarness();
  const input = { agent: "delegate", task: "t", model: " provider/x " };
  await byName.subagent_start.execute("tc-start", input, undefined, undefined, {});
  assert.deepEqual(calls.start, [["tc-start", { agent: "delegate", task: "t", model: " provider/x " }, undefined, undefined, {}]]);
  assert.deepEqual(calls.control, []);
});

test("factory requires both unique execution callbacks and optional renderers attach by reference", async () => {
  assert.throws(() => createSubagentOperationTools({ executeControl: () => {} }), /executeStart/);
  assert.throws(() => createSubagentOperationTools({ executeStart: () => {} }), /executeControl/);
  const renderCall = () => {};
  const renderResult = () => {};
  const withRenderers = createSubagentOperationTools({
    executeStart: () => {},
    executeControl: () => {},
    renderCall,
    renderResult,
  });
  for (const tool of withRenderers) {
    assert.equal(tool.renderCall, renderCall);
    assert.equal(tool.renderResult, renderResult);
  }
  const bare = createSubagentOperationTools({ executeStart: () => {}, executeControl: () => {} });
  for (const tool of bare) {
    assert.equal("renderCall" in tool, false);
    assert.equal("renderResult" in tool, false);
  }
});
