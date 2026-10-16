import assert from "node:assert/strict";
import test from "node:test";

import { createSupervisorAdapter } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts";
import {
  SUPERVISOR_OPERATION_ACTION_BY_TOOL,
  SUPERVISOR_REQUEST_PENDING_DESCRIPTION,
  SUPERVISOR_REQUEST_PENDING_PARAMETERS,
  SUPERVISOR_REQUEST_REPLY_PARAMETERS,
  SUPERVISOR_REQUEST_STATUS_PARAMETERS,
  createSupervisorOperationTools,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts";

const TOOL_NAMES = ["supervisor_request_pending", "supervisor_request_status", "supervisor_request_reply"];

function spyAdapter(sink) {
  const adapter = createSupervisorAdapter();
  const calls = [];
  adapter.bind(async (toolCallId, params, signal, onUpdate, ctx) => {
    calls.push({ toolCallId, params, signal, onUpdate, ctx });
    return sink?.(toolCallId, params, signal, onUpdate, ctx);
  });
  return { adapter, calls };
}

function rejectCode(promise) {
  return promise.then(
    () => { throw new Error("expected rejection"); },
    (error) => error,
  );
}

test("supervisor 三操作工具按 S0 精确字段暴露，固定 action 不进 schema", () => {
  const { adapter } = spyAdapter();
  const tools = createSupervisorOperationTools(adapter);
  assert.equal(Object.isFrozen(tools), true);
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of tools) {
    assert.equal(tool.exposure, "model-only");
    assert.equal(Object.isFrozen(tool), true);
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    // 根 schema 不用 union/allOf/oneOf/anyOf/if（对齐 root-no-combinator 合同）。
    for (const forbidden of ["anyOf", "allOf", "oneOf", "if"]) {
      assert.equal(Object.hasOwn(tool.parameters, forbidden), false);
    }
    assert.equal(Object.hasOwn(tool.parameters.properties, "action"), false);
  }
  assert.deepEqual(SUPERVISOR_REQUEST_PENDING_PARAMETERS.properties, {});
  assert.deepEqual(SUPERVISOR_REQUEST_PENDING_PARAMETERS.required, undefined);
  assert.deepEqual(Object.keys(SUPERVISOR_REQUEST_STATUS_PARAMETERS.properties), ["replyTo"]);
  assert.deepEqual(SUPERVISOR_REQUEST_STATUS_PARAMETERS.required, undefined);
  assert.deepEqual(SUPERVISOR_REQUEST_REPLY_PARAMETERS.required, ["replyTo", "message"]);
  // 必填非空在 schema 层与 runtime 校验一致：minLength 1。
  assert.equal(SUPERVISOR_REQUEST_REPLY_PARAMETERS.properties.replyTo.minLength, 1);
  assert.equal(SUPERVISOR_REQUEST_REPLY_PARAMETERS.properties.message.minLength, 1);
  assert.deepEqual(
    Object.keys(SUPERVISOR_REQUEST_REPLY_PARAMETERS.properties).sort(),
    ["message", "replyTo", "to"],
  );
  // factory 自身固定 action 映射表与三工具一一对应，不产生第四工具。
  assert.deepEqual(Object.keys(SUPERVISOR_OPERATION_ACTION_BY_TOOL), TOOL_NAMES);
  assert.equal(SUPERVISOR_OPERATION_ACTION_BY_TOOL.supervisor_request_pending, "pending");
  assert.equal(SUPERVISOR_OPERATION_ACTION_BY_TOOL.supervisor_request_status, "status");
  assert.equal(SUPERVISOR_OPERATION_ACTION_BY_TOOL.supervisor_request_reply, "reply");
});

test("固定 action 由 factory 注入并按工具映射，调用方参数被重建而非透传", async () => {
  const { adapter, calls } = spyAdapter();
  const [pending, status, reply] = createSupervisorOperationTools(adapter);
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/repo" };

  await pending.execute("t-pending", {}, signal, onUpdate, ctx);
  await status.execute("t-status", { replyTo: "req-1" }, signal, onUpdate, ctx);
  await reply.execute("t-reply", { replyTo: "req-1", message: "approved" }, signal, onUpdate, ctx);

  assert.equal(calls.length, 3);
  // 传给 adapter 的 params 是 factory 重建的固定 action 对象。
  assert.deepEqual(calls[0].params, { action: "pending" });
  assert.deepEqual(calls[1].params, { action: "status", replyTo: "req-1" });
  assert.deepEqual(calls[2].params, { action: "reply", replyTo: "req-1", message: "approved" });
  // toolCallId/signal/onUpdate/ctx 原样透传。
  assert.equal(calls[0].toolCallId, "t-pending");
  assert.equal(calls[1].signal, signal);
  assert.equal(calls[2].onUpdate, onUpdate);
  assert.equal(calls[2].ctx, ctx);
  // 可选字段缺省时不注入空值。
  assert.equal(Object.hasOwn(calls[1].params, "to"), false);
});

test("直连调用带 action 或未知/跨面字段被安全拒绝且不触达下游", async () => {
  const { adapter, calls } = spyAdapter();
  const [pending, status, reply] = createSupervisorOperationTools(adapter);

  const invalid = [
    // action 是 schema 外字段：固定 action 不可被调用方覆盖。
    [pending, { action: "status" }],
    [reply, { action: "reply", replyTo: "r", message: "m" }],
    // 未知字段。
    [pending, { to: "child-a" }],
    [pending, { replyTo: "r" }],
    [status, { to: "child-a" }],
    [status, { message: "m" }],
    [reply, { index: 1, replyTo: "r", message: "m" }],
    // 类型错误。
    [status, { replyTo: 7 }],
    [reply, { replyTo: "r", message: 42 }],
  ];
  for (const [tool, params] of invalid) {
    const error = await rejectCode(tool.execute("t", params));
    assert.match(String(error.code), /^SUPERVISOR_OPERATION_/);
  }
  assert.equal(calls.length, 0);
});

test("reply 的 replyTo/message 必填且非空，缺任一直连调用 fail closed", async () => {
  const { adapter, calls } = spyAdapter();
  const [, , reply] = createSupervisorOperationTools(adapter);
  const invalid = [
    {},
    { message: "m" },
    { replyTo: "r" },
    { replyTo: "", message: "m" },
    { replyTo: "r", message: "" },
  ];
  for (const params of invalid) {
    const error = await rejectCode(reply.execute("t", params));
    assert.equal(error.code, "SUPERVISOR_OPERATION_REQUIRED_FIELD");
    assert.match(error.keypath, /^\$\.(replyTo|message)$/);
  }
  assert.equal(calls.length, 0);
});

test("显式 null/数组/原始类型入参拒为 INVALID_INPUT，不洗成空对象，raw 入参不被改写", async () => {
  const { adapter, calls } = spyAdapter();
  const [pending, status, reply] = createSupervisorOperationTools(adapter);

  for (const bad of [null, ["replyTo"], 7, "reply", true]) {
    const error = await rejectCode(pending.execute("t", bad));
    assert.equal(error.code, "SUPERVISOR_OPERATION_INVALID_INPUT");
    assert.equal(error.keypath, "$");
  }
  const nullStatus = await rejectCode(status.execute("t", null));
  const nullReply = await rejectCode(reply.execute("t", null));
  assert.equal(nullStatus.code, "SUPERVISOR_OPERATION_INVALID_INPUT");
  assert.equal(nullReply.code, "SUPERVISOR_OPERATION_INVALID_INPUT");
  assert.equal(calls.length, 0);

  // raw 入参只读语义：校验重建 clean 对象，不改写调用方对象。
  const raw = { replyTo: "r", message: "m" };
  const snapshot = { ...raw };
  await reply.execute("t", raw);
  assert.deepEqual(raw, snapshot);
  assert.deepEqual(calls.at(-1).params, { action: "reply", replyTo: "r", message: "m" });
});

test("未 bind 沿 createSupervisorAdapter 原执行 fail closed，且参数校验先于下游", async () => {
  const adapter = createSupervisorAdapter();
  const [pending, status, reply] = createSupervisorOperationTools(adapter);

  // 合法参数：透传 adapter 未就绪错误（原 code 不改写）。
  const unavailable = await rejectCode(pending.execute("t", {}));
  assert.equal(unavailable.code, "SUPERVISOR_TARGET_UNAVAILABLE");

  // 非法参数：在本层即拒绝，不进入 adapter。
  const unknown = await rejectCode(status.execute("t", { action: "status" }));
  assert.equal(unknown.code, "SUPERVISOR_OPERATION_UNKNOWN_FIELD");

  // 唯一 bind：第二次 bind 沿 adapter 原行为拒绝，首个 target 仍是唯一执行权威。
  const seen = [];
  adapter.bind(async (_id, params) => { seen.push(params); return { ok: true }; });
  assert.throws(() => adapter.bind(async () => ({})), (error) => error.code === "SUPERVISOR_TARGET_ALREADY_BOUND");
  await reply.execute("t", { replyTo: "r", message: "m" });
  assert.deepEqual(seen, [{ action: "reply", replyTo: "r", message: "m" }]);
});

test("raw 结果原样返回：不吞 isError、不改写 content/details、异常原样抛出", async () => {
  const rawOk = Object.freeze({ content: [{ type: "text", text: "queued" }], details: { delivery: "queued" } });
  const { adapter, calls } = spyAdapter(() => rawOk);
  const [pending, status, reply] = createSupervisorOperationTools(adapter);
  assert.equal(await pending.execute("t", {}), rawOk);
  assert.equal(await status.execute("t", { replyTo: "r" }), rawOk);
  assert.equal(await reply.execute("t", { replyTo: "r", message: "m" }), rawOk);

  const rawError = Object.freeze({
    content: [{ type: "text", text: "SUPERVISOR_REQUEST_NOT_PENDING" }],
    isError: true,
    details: { code: "SUPERVISOR_REQUEST_NOT_PENDING" },
  });
  const failing = createSupervisorOperationTools(spyAdapter(() => rawError).adapter);
  const [, , replyFail] = failing;
  assert.equal(await replyFail.execute("t", { replyTo: "missing", message: "m" }), rawError);
  assert.equal(rawError.isError, true);

  const boom = new Error("native failure");
  const throwing = createSupervisorOperationTools(spyAdapter(() => { throw boom; }).adapter);
  const thrown = await rejectCode(throwing[0].execute("t", {}));
  assert.equal(thrown, boom);
  assert.equal(calls.length >= 3, true);
});

test("factory 只产出三工具：不创建 gate 的 inspect/clear，renderers 可选注入", () => {
  const { adapter } = spyAdapter();
  const bare = createSupervisorOperationTools(adapter);
  assert.equal(bare.length, 3);
  for (const tool of bare) {
    assert.equal(Object.hasOwn(tool, "renderCall"), false);
    assert.equal(Object.hasOwn(tool, "renderResult"), false);
    assert.equal(typeof tool.description, "string");
    assert.notEqual(tool.description.includes("inspect"), true);
  }
  const renderCall = () => {};
  const renderResult = () => {};
  const decorated = createSupervisorOperationTools(adapter, { renderCall, renderResult });
  for (const tool of decorated) {
    assert.equal(tool.renderCall, renderCall);
    assert.equal(tool.renderResult, renderResult);
  }
  assert.throws(() => createSupervisorOperationTools(null), /adapter with execute/);
  assert.throws(() => createSupervisorOperationTools({}), /adapter with execute/);
});
