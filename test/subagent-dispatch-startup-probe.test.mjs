import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSubagentDispatchTraceFileSink, createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { projectRpcNegotiation } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/diagnostics.ts";
import { readBoundedDispatchTrace } from "../scripts/probes/subagent-dispatch-startup.ts";

// S4：按工具名解析注册面，不以 tools 数组位置为权威。
function startTool(host) {
  const found = (host.tools ?? []).find((tool) => tool?.name === "subagent_start");
  if (!found) throw new Error("subagent_start must be registered");
  return found;
}

function createPi() {
  const tools = [];
  const listeners = new Map();
  return {
    tools,
    events: {
      on(name, listener) {
        const entries = listeners.get(name) ?? [];
        entries.push(listener);
        listeners.set(name, entries);
        return () => entries.splice(entries.indexOf(listener), 1);
      },
      emit(name, payload) {
        for (const listener of listeners.get(name) ?? []) listener(payload);
      },
    },
    registerTool(tool) { tools.push(tool); },
    on() {},
  };
}

test("records correlated dispatch phases without retaining task content", async () => {
  const pi = createPi();
  const trace = [];
  const rpc = {
    async ping(options) {
      options.diagnostic.sink("rpc-ping-sent", { method: "ping", requestId: "ping-1" });
      options.diagnostic.sink("rpc-ping-replied", { method: "ping", requestId: "ping-1" });
      return { version: 1, methods: ["spawn"], session: { sessionId: "session-1", sessionFile: "session-1", cwd: "/repo" } };
    },
    async spawn(_params, options) {
      options.diagnostic.sink("rpc-spawn-sent", { method: "spawn", requestId: "spawn-1" });
      options.diagnostic.sink("rpc-spawn-replied", { method: "spawn", requestId: "spawn-1" });
      pi.events.emit("subagent:async-started", {
        runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "session-1", pid: 7,
        agent: "executor", workflowKey: "typed-dispatch-1", parentWorkflowRunId: "root-1",
      });
      return { details: { runId: "root-1", asyncDir: "/tmp/root-1" } };
    },
    dispose() {},
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "dispatch-1",
    diagnosticSink(entry) { trace.push(entry); },
    discoverAgents: async () => ({ agents: [{ name: "executor" }] }),
  });

  const result = await startTool(pi).execute("tool-1", {
    agent: "executor", title: "Trace", task: "secret task body",
  }, undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, false);
  assert.deepEqual(trace.map((entry) => entry.phase), [
    "tool-entered", "agent-discovery-started", "agent-discovery-finished", "rpc-ping-sent", "rpc-ping-replied",
    "rpc-spawn-sent", "rpc-spawn-replied", "leaf-wait-started", "leaf-wait-finished", "tool-returned",
  ]);
  assert.ok(trace.every((entry) => entry.toolCallId === "tool-1"));
  assert.ok(trace.every((entry) => Number.isSafeInteger(entry.monotonicMs)));
  assert.ok(trace.every((entry) => !JSON.stringify(entry).includes("secret task body")));
});

test("explicit trace file holds a caller-owned fd and stops after replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-trace-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 1, task: "must not persist" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    version: 1, toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 1,
  });
  const replacement = join(directory, "replacement.jsonl");
  writeFileSync(replacement, "", { mode: 0o600 });
  renameSync(replacement, file);
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-returned", monotonicMs: 2 });
  assert.equal(readFileSync(file, "utf8"), "");
  sink.dispose();
  chmodSync(file, 0o644);
  assert.throws(() => createSubagentDispatchTraceFileSink(file), /caller-owned 0600 regular file/);
});

test("startup probe requires the actual parent session and ignores a partial final line", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, `${JSON.stringify({ version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "rpc-ping-replied", monotonicMs: 2 })}\n{`, { mode: 0o600 });
  const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1", maxBytes: 1024, maxRecords: 4, windowMs: 10, outputBudget: 1024 });
  assert.equal(result.cause, "observed");
  assert.equal(result.partialTrailingLine, true);
  assert.equal(readBoundedDispatchTrace({ file, parentSessionId: "other", toolCallId: "tool-1" }).cause, "unproven");
});

test("startup probe discards a truncated first line and returns structured unproven results for invalid records", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-"));
  const file = join(directory, "trace.jsonl");
  const complete = JSON.stringify({ version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 2 });
  writeFileSync(file, `partial\n${complete}\n`, { mode: 0o600 });
  const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1", maxBytes: Buffer.byteLength(complete) + 3, maxRecords: 4, windowMs: 10, outputBudget: 1024 });
  assert.equal(result.partialLeadingLine, true);
  assert.equal(result.records.length, 1);

  writeFileSync(file, `${JSON.stringify({ version: 2, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 2 })}\n`, { mode: 0o600 });
  assert.equal(readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1" }).invalidTrace, "invalid-version");
});

/* -------------------- D1：tool-failed 的 negotiation 白名单 -------------------- */

// D0 投影的合法形状；sink 只允许该白名单落盘，且必须逐字段重建。
const NEGOTIATION = Object.freeze({
  schemaVersion: "rpc-negotiation-diagnostic.v1",
  stage: "spawn-capability-assertion",
  dispatchPath: "coding",
  capabilitiesEnvelopePresent: true,
  versionOk: true,
  spawnMethodOk: true,
  sessionIdPresent: true,
  lifecycleIdentityPresent: true,
  sessionCwdPresent: true,
  cwdEqual: false,
  missingCapabilities: Object.freeze(["rpc:v1/session"]),
});

const readRecords = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("trace 文件 sink 只落盘 tool-failed 的白名单 negotiation 投影", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-trace-negotiation-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);

  // 1) 合法投影：逐字段落盘，既有 stage/errorCode/toolCallId 白名单不变。
  sink({
    version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 3,
    errorCode: "CAPABILITY_NEGOTIATION_FAILED", stage: "rpc-ping", negotiation: NEGOTIATION,
  });
  // 2) 投毒/畸形投影：整条 negotiation 丢弃，绝不部分透传。
  for (const poisoned of [
    { ...NEGOTIATION, causeMessage: "open '/Users/canary/session.jsonl'", raw: { session: { cwd: "/Users/canary" } } },
    { ...NEGOTIATION, error: { message: "TASK-BODY-CANARY" }, detail: { cause: "canary" } },
    { ...NEGOTIATION, missingCapabilities: ["evilCapability", "rpc:v1/session"] },
    { ...NEGOTIATION, missingCapabilities: ["/Users/canary/session.jsonl"] },
    { ...NEGOTIATION, missingCapabilities: "rpc:v1/session" },
    { ...NEGOTIATION, schemaVersion: "rpc-negotiation-diagnostic.v2" },
    { ...NEGOTIATION, stage: "workflow-spawn" },
    { ...NEGOTIATION, dispatchPath: "/Users/canary" },
    { ...NEGOTIATION, cwdEqual: "false" },
    { ...NEGOTIATION, versionOk: undefined },
    "rpc-negotiation-diagnostic.v1",
    null,
  ]) {
    sink({ version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 4, negotiation: poisoned });
  }
  // 3) 非 tool-failed phase 即使携带合法投影也不落盘该字段。
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-returned", monotonicMs: 5, negotiation: NEGOTIATION });
  // 4) RPC 失败 details 的其余字段与嵌套 error.detail 仍被过滤（只有 stage 进白名单）。
  sink({
    version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 6, stage: "workflow-spawn",
    taskId: "dispatch-canary", rpcOperation: "spawn", causeCode: "CAPABILITY_NEGOTIATION_FAILED",
    causeMessage: "open '/Users/canary/session.jsonl'", detail: { negotiation: NEGOTIATION },
  });
  sink.dispose();

  const records = readRecords(file);
  assert.equal(records.length, 15, "每条合法 trace 记录都应写入一行");
  assert.deepEqual(records[0], {
    version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 3,
    errorCode: "CAPABILITY_NEGOTIATION_FAILED", stage: "rpc-ping",
    negotiation: { ...NEGOTIATION, missingCapabilities: ["rpc:v1/session"] },
  });
  records.slice(1, 13).forEach((record, index) => {
    assert.equal(Object.hasOwn(record, "negotiation"), false, `投毒投影 ${index} 不得落盘`);
  });
  assert.deepEqual(records[13], { version: 1, toolCallId: "tool-1", phase: "tool-returned", monotonicMs: 5 });
  assert.deepEqual(records[14], { version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 6, stage: "workflow-spawn" });
  const text = readFileSync(file, "utf8");
  assert.equal(text.includes("canary"), false, "诊断文件不得出现 canary 正文/路径");
  assert.equal(text.includes("CANARY"), false);
});

test("negotiation 白名单不改变 0600/O_NOFOLLOW/inode/dispose 门禁", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-trace-gates-"));
  const target = join(directory, "target.jsonl");
  writeFileSync(target, "", { mode: 0o600 });

  // O_NOFOLLOW：符号链接入口仍被拒绝，不因新增字段放宽。
  const link = join(directory, "link.jsonl");
  symlinkSync(target, link);
  assert.throws(() => createSubagentDispatchTraceFileSink(link), /caller-owned 0600 regular file/);

  // 写入期间被替换（inode 变化）→ 立即停止，且 dispose 幂等、dispose 后不再写入。
  const sink = createSubagentDispatchTraceFileSink(target);
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 1, negotiation: NEGOTIATION });
  const replacement = join(directory, "replacement.jsonl");
  writeFileSync(replacement, "", { mode: 0o600 });
  renameSync(replacement, target);
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 2, negotiation: NEGOTIATION });
  sink.dispose();
  sink.dispose();
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 3, negotiation: NEGOTIATION });
  assert.equal(readFileSync(target, "utf8"), "", "被替换后的诊断文件不得继续接收写入");
});

/* ------------- D1：producer sink → consumer probe 的 stage/negotiation 合同 ------------- */

/** 真实 D0 投影（不手拼）：缺 processTerminalProof 的 generic ping。 */
const realNegotiation = () => projectRpcNegotiation({
  version: 1,
  methods: ["ping", "spawn"],
  capabilities: {
    asyncSpawn: true,
    processTerminalProof: false,
    launchResolvedExtensions: true,
    runtimeAcknowledgedExtensions: true,
  },
  session: { sessionId: "session-1", sessionFile: null, cwd: "/repo" },
}, "/repo", "generic");

test("真实 sink 写入的 stage/negotiation 记录可被有界 probe 关联消费", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-negotiation-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);
  const negotiation = realNegotiation();
  sink({ version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "rpc-ping-replied", monotonicMs: 2, method: "ping", requestId: "ping-1" });
  sink({
    version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 3,
    errorCode: "CAPABILITY_NEGOTIATION_FAILED", stage: "rpc-ping", negotiation,
  });
  sink.dispose();

  const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1", maxBytes: 4096, maxRecords: 8, windowMs: 1000, outputBudget: 4096 });
  assert.equal(result.cause, "observed", JSON.stringify(result));
  assert.equal(result.records.length, 2);
  assert.equal(result.records[1].stage, "rpc-ping");
  assert.equal(result.records[1].errorCode, "CAPABILITY_NEGOTIATION_FAILED");
  assert.deepEqual(result.records[1].negotiation, { ...negotiation, missingCapabilities: ["processTerminalProof"] });
  // 身份关联仍权威：错误 parentSessionId 仍 unproven，不因新增字段放宽。
  assert.equal(readBoundedDispatchTrace({ file, parentSessionId: "other", toolCallId: "tool-1" }).cause, "unproven");
});

test("probe 对未知键、畸形 negotiation/stage 与 canary 一律 fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-invalid-"));
  const file = join(directory, "trace.jsonl");
  const valid = realNegotiation();
  const base = {
    version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "tool-failed",
    monotonicMs: 3, errorCode: "CAPABILITY_NEGOTIATION_FAILED", stage: "rpc-ping",
  };
  const invalidRecords = [
    // negotiation 携带白名单外键（error.detail 形态）
    { ...base, negotiation: { ...valid, causeMessage: "open '/Users/canary/session.jsonl'" } },
    { ...base, negotiation: { ...valid, raw: { session: { cwd: "/Users/canary" } } } },
    { ...base, negotiation: { ...valid, error: { message: "TASK-BODY-CANARY" } } },
    // 枚举/类型畸形
    { ...base, negotiation: { ...valid, missingCapabilities: ["evilCapability"] } },
    { ...base, negotiation: { ...valid, missingCapabilities: ["/Users/canary/session.jsonl"] } },
    { ...base, negotiation: { ...valid, missingCapabilities: "rpc:v1/session" } },
    { ...base, negotiation: { ...valid, schemaVersion: "rpc-negotiation-diagnostic.v2" } },
    { ...base, negotiation: { ...valid, stage: "workflow-spawn" } },
    { ...base, negotiation: { ...valid, dispatchPath: "/Users/canary/pi-config" } },
    { ...base, negotiation: { ...valid, cwdEqual: "false" } },
    { ...base, negotiation: { ...valid, versionOk: undefined } },
    { ...base, negotiation: "rpc-negotiation-diagnostic.v1" },
    { ...base, negotiation: null },
    { ...base, negotiation: [valid] },
    // stage 不在 producer 固定枚举内
    { ...base, stage: "unknown-stage" },
    { ...base, stage: "/Users/canary/stage" },
    { ...base, stage: 42 },
    // 非 tool-failed 携带 negotiation
    { ...base, phase: "tool-returned", negotiation: valid },
    // 顶层未知键仍 fail closed（含本次未纳入的 timestamp）
    { ...base, detail: { negotiation: valid } },
    { ...base, timestamp: "2026-10-15T00:00:00.000Z" },
    { ...base, task: "TASK-BODY-CANARY" },
  ];
  for (const record of invalidRecords) {
    writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1" });
    const label = JSON.stringify(record);
    assert.equal(result.cause, "unproven", label);
    assert.equal(result.invalidTrace, "invalid-schema", label);
    assert.deepEqual(result.records, [], label);
    assert.equal(JSON.stringify(result).includes("canary"), false, label);
    assert.equal(JSON.stringify(result).includes("CANARY"), false, label);
  }
});

/* -------------------- D3：supervisor 诊断的独立 sink 白名单分支 -------------------- */

const CANARY_BODY = "TASK-BODY-CANARY";
const CANARY_PATH = "/Users/canary/.pi/sessions/child-canary.jsonl";
const CANARY_DIGEST = `sha256:${"c".repeat(64)}`;
const CANARY_TOKEN = "owner token canary";
const CANARIES = [CANARY_BODY, CANARY_PATH, CANARY_DIGEST, CANARY_TOKEN, "canary", "CANARY"];

/** 携带 canary 的 Error：producer 现场就是把 Error/cause 对象整个交给 sink。 */
const canaryError = () => Object.assign(new Error(`open '${CANARY_PATH}' failed: ${CANARY_BODY} (${CANARY_TOKEN})`), {
  code: "authority_store_unavailable",
  cause: new Error(`cause ${CANARY_PATH} ${CANARY_DIGEST}`),
});

/**
 * 9 类 producer 的现场形状（逐条取自实际调用点，不手拼 projection）：
 * 1 extension.ts:reportSupervisorDiagnostic(registration-failed)
 * 2 extension.ts:compensateSupervisorDelivery(delivery-compensation-failed)
 * 3/4 supervisor-control-plane.ts:readOwnerState / identityForRun(owner|runtime-read-failed)
 * 5/6 supervisor-control-plane.ts:persistenceError / loadRoot(persistence-corrupt|rejected，用 type 字段)
 * 7 supervisor-consumption.ts:reconcileSupervisorConsumption(consumption-rejected)
 * 8 extensions/subagent-runtime.ts:observeConsumption(consumption-failed)
 * 9 supervisor-replay.ts:replaySupervisor(replay-failed)
 * 数据来源分类：类别 2（测试矩阵）——形状忠实于 production 调用点，但不声称复现过历史故障。
 */
const producerEntries = () => {
  const error = canaryError();
  return [
    { version: 1, phase: "supervisor-registration-failed", errorCode: "SUPERVISOR_OWNER_UNAVAILABLE", code: "SUPERVISOR_OWNER_UNAVAILABLE", requestId: "request-1", runId: "run-1", error, cause: error.cause },
    { version: 1, phase: "supervisor-delivery-compensation-failed", deliveryPhase: "reply", error, cause: error.cause, secondaryError: error, compensation: { status: "blocked", code: "SUPERVISOR_DELIVERY_COMPENSATION_BLOCKED", receipt: { receiptId: "receipt-1", idempotencyKey: CANARY_TOKEN, requestDigest: CANARY_DIGEST } } },
    { phase: "supervisor-owner-read-failed", runId: "run-1", error, cause: error.cause, errorCode: "authority_store_unavailable" },
    { phase: "supervisor-runtime-read-failed", runId: "run-1", error, cause: error.cause, errorCode: "SUPERVISOR_RUNTIME_UNAVAILABLE" },
    { type: "supervisor-persistence-corrupt", rootSessionId: "root-1", code: "SUPERVISOR_PERSISTENCE_CORRUPT", error, cause: error.cause },
    { type: "supervisor-persistence-rejected", rootSessionId: "root-1", requestId: "request-1", code: "SUPERVISOR_REQUEST_EXPIRED" },
    { phase: "supervisor-consumption-rejected", runId: "run-1", requestId: "request-1", code: "SUPERVISOR_CONSUMPTION_MISMATCH" },
    { phase: "supervisor-consumption-failed", runId: "run-1", error, cause: error.cause },
    { version: 1, phase: "supervisor-replay-failed", error, cause: error.cause },
  ];
};

/** 每条落盘记录允许的键集：D0 SafeSupervisorTraceV1，绝无 error/cause/type/deliveryPhase/compensation。 */
const TRACE_KEYS = ["version", "eventKind", "phase", "monotonicMs", "runId", "requestId", "receiptId", "rootSessionId", "errorCode", "receiptStatus", "consumed", "requestGeneration", "ownerGeneration"];
/** 9 类权威枚举（与 D0 diagnostics.ts 同集合）；落盘顺序以 producerEntries 为准，因此按集合比较。 */
const NINE_PHASES = [
  "supervisor-registration-failed", "supervisor-delivery-compensation-failed", "supervisor-owner-read-failed",
  "supervisor-runtime-read-failed", "supervisor-consumption-rejected", "supervisor-consumption-failed",
  "supervisor-persistence-corrupt", "supervisor-persistence-rejected", "supervisor-replay-failed",
];

test("trace sink 把 9 类 supervisor producer 规范化为安全包络，error/cause/正文/路径/token/digest 不落盘", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-supervisor-trace-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);
  for (const entry of producerEntries()) sink(entry);
  sink.dispose();

  const records = readRecords(file);
  assert.equal(records.length, 9, "9 类 producer 各写一行");
  assert.deepEqual([...records.map((record) => record.phase)].sort(), [...NINE_PHASES].sort(), "9 类 producer 全覆盖，且 type 形状统一规范化为 phase 枚举");
  assert.deepEqual(records.map((record) => record.phase), producerEntries().map((entry) => entry.phase ?? entry.type), "落盘顺序与 producer 调用顺序一致");
  let previous = -1;
  for (const record of records) {
    assert.equal(record.version, 1, "包络层补 version");
    assert.equal(record.eventKind, "supervisor-diagnostic");
    assert.equal(Number.isSafeInteger(record.monotonicMs) && record.monotonicMs >= previous, true, "包络层补单调钟且不倒退");
    previous = record.monotonicMs;
    assert.ok(Object.keys(record).every((key) => TRACE_KEYS.includes(key)), `白名单外键落盘：${JSON.stringify(record)}`);
    for (const forbidden of ["error", "cause", "secondaryError", "compensation", "deliveryPhase", "type", "code", "idempotencyKey", "requestDigest", "payloadDigest", "token", "sessionFile", "correlation"]) {
      assert.equal(forbidden in record, false, `supervisor 诊断不得落盘 ${forbidden}`);
    }
  }
  // 业务身份/错误码只保留安全 ID 与标识符形态枚举；补偿记录只剩包络字段。
  assert.deepEqual({ ...records[0], monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-registration-failed", monotonicMs: 0, requestId: "request-1", runId: "run-1", errorCode: "SUPERVISOR_OWNER_UNAVAILABLE" });
  assert.deepEqual({ ...records[1], monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-delivery-compensation-failed", monotonicMs: 0 });
  assert.deepEqual({ ...records[4], monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-persistence-corrupt", monotonicMs: 0, rootSessionId: "root-1", errorCode: "SUPERVISOR_PERSISTENCE_CORRUPT" });
  assert.deepEqual({ ...records[6], monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-consumption-rejected", monotonicMs: 0, runId: "run-1", requestId: "request-1", errorCode: "SUPERVISOR_CONSUMPTION_MISMATCH" });
  assert.deepEqual({ ...records[8], monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-replay-failed", monotonicMs: 0 });
  const text = readFileSync(file, "utf8");
  for (const canary of CANARIES) assert.equal(text.includes(canary), false, `诊断文件泄漏 canary：${canary}`);
});

test("supervisor 分支对未知 phase、不安全 ID/枚举与投毒字段 fail closed，且既有记录形状优先不变", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-supervisor-trace-invalid-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);
  const error = canaryError();
  // a) 未知 supervisor-* phase/type：整条丢弃，不回落到其它分支。
  sink({ phase: "supervisor-unknown-failed", error, cause: error.cause });
  sink({ type: "supervisor-", error });
  sink({ phase: "supervisor-registration-failed".toUpperCase(), error });
  // b) 不安全 ID/错误码/枚举/世代：字段级丢弃，只留安全包络。
  sink({ phase: "supervisor-consumption-rejected", requestId: CANARY_PATH, runId: "../../escape", rootSessionId: `${CANARY_TOKEN}`, errorCode: `open '${CANARY_PATH}' failed`, receiptStatus: "CANARY", consumed: "yes", ownerGeneration: 0, requestGeneration: -1, receiptId: 42, error });
  // c) 合法安全事实全部保留（IDs/枚举/布尔/正整数）。
  sink({ phase: "supervisor-owner-read-failed", runId: "run-1", requestId: "request-1", receiptId: "receipt-1", rootSessionId: "root-1", errorCode: "authority_store_unavailable", receiptStatus: "delivered", consumed: true, ownerGeneration: 3, requestGeneration: 2 });
  // d) 非法单调钟由包络层时钟补齐，不接受负数/小数。
  sink({ phase: "supervisor-replay-failed", monotonicMs: -5 });
  // e) 既有 dispatch/working-state 记录优先：即使被投毒附加 supervisor type，形状与门禁一字不变。
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 7, errorCode: "CAPABILITY_NEGOTIATION_FAILED", type: "supervisor-replay-failed", error });
  sink({ version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 8, type: "supervisor-persistence-corrupt", error });
  // f) 既有门禁不变：缺 version 的 dispatch 记录仍被丢弃。
  sink({ toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 9 });
  // g) 非记录输入不抛异常、不落盘。
  for (const invalid of [null, undefined, "supervisor-registration-failed", 42, ["supervisor-replay-failed"]]) sink(invalid);
  sink.dispose();

  const records = readRecords(file);
  assert.equal(records.length, 5, `只应落盘 b/c/d 与 e 的两条既有记录，实际 ${JSON.stringify(records)}`);
  assert.deepEqual({ ...records[0], monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-consumption-rejected", monotonicMs: 0 });
  assert.deepEqual({ ...records[1], monotonicMs: 0 }, { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-owner-read-failed", monotonicMs: 0, runId: "run-1", requestId: "request-1", receiptId: "receipt-1", rootSessionId: "root-1", errorCode: "authority_store_unavailable", receiptStatus: "delivered", consumed: true, requestGeneration: 2, ownerGeneration: 3 });
  assert.equal(records[2].phase, "supervisor-replay-failed");
  assert.equal(Number.isSafeInteger(records[2].monotonicMs) && records[2].monotonicMs >= 0, true, "负数单调钟必须由包络层时钟替换");
  assert.deepEqual(records[3], { version: 1, toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 7, errorCode: "CAPABILITY_NEGOTIATION_FAILED" }, "投毒 supervisor type 不得改变既有 dispatch 记录");
  assert.deepEqual(records[4], { version: 1, hostSessionId: "host-1", completionOwnerId: "owner-1", event: "host-idle", monotonicMs: 8 }, "投毒 supervisor type 不得改变既有 working-state 记录");
  assert.equal(records.some((record) => record.eventKind === "supervisor-diagnostic" && record.phase === "supervisor-unknown-failed"), false);
  const text = readFileSync(file, "utf8");
  for (const canary of CANARIES) assert.equal(text.includes(canary), false, `诊断文件泄漏 canary：${canary}`);
});

test("supervisor 分支不放宽 0600/O_NOFOLLOW/inode/dispose 门禁", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-supervisor-trace-gates-"));
  const target = join(directory, "target.jsonl");
  writeFileSync(target, "", { mode: 0o600 });
  const link = join(directory, "link.jsonl");
  symlinkSync(target, link);
  assert.throws(() => createSubagentDispatchTraceFileSink(link), /caller-owned 0600 regular file/);

  const sink = createSubagentDispatchTraceFileSink(target);
  sink({ phase: "supervisor-registration-failed", requestId: "request-1", runId: "run-1", errorCode: "SUPERVISOR_OWNER_UNAVAILABLE" });
  assert.equal(readRecords(target).length, 1);
  // 写入期间被替换（inode 变化）→ 立即永久停止，dispose 幂等，dispose 后不再写入。
  const replacement = join(directory, "replacement.jsonl");
  writeFileSync(replacement, "", { mode: 0o600 });
  renameSync(replacement, target);
  sink({ phase: "supervisor-consumption-failed", runId: "run-1", error: canaryError() });
  sink.dispose();
  sink.dispose();
  sink({ type: "supervisor-persistence-corrupt", rootSessionId: "root-1" });
  assert.equal(readFileSync(target, "utf8"), "", "被替换后的诊断文件不得继续接收 supervisor 记录");
  chmodSync(target, 0o644);
  assert.throws(() => createSubagentDispatchTraceFileSink(target), /caller-owned 0600 regular file/);
});

/* ------- D3：producer sink → consumer probe 的 supervisor 包络合同同步 ------- */

test("真实 sink 混写的 supervisor 包络不再让整份 trace fail closed，也不冒充 dispatch 证据", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-supervisor-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);
  const negotiation = realNegotiation();
  sink({ version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "rpc-ping-replied", monotonicMs: 2, method: "ping", requestId: "ping-1" });
  sink({ version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "tool-failed", monotonicMs: 3, errorCode: "CAPABILITY_NEGOTIATION_FAILED", stage: "rpc-ping", negotiation });
  for (const entry of producerEntries()) sink(entry);
  sink.dispose();
  assert.equal(readRecords(file).length, 11, "2 条 dispatch + 9 条 supervisor 包络");

  const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1", maxBytes: 8192, maxRecords: 16, windowMs: 1000, outputBudget: 8192 });
  assert.equal(result.cause, "observed", JSON.stringify(result));
  assert.equal(result.invalidTrace, undefined, "supervisor 包络不得连带报废同文件的 dispatch 证据");
  assert.deepEqual(result.records.map((record) => record.phase), ["rpc-ping-replied", "tool-failed"]);
  assert.equal(result.records.some((record) => "eventKind" in record), false, "supervisor 包络不是 dispatch 证据");
  assert.deepEqual(result.records[1].negotiation, { ...negotiation, missingCapabilities: ["processTerminalProof"] }, "D1 negotiation 合同不变");
  // 身份关联仍权威：错误 parentSessionId 仍 unproven，但不是 schema 失败。
  const other = readBoundedDispatchTrace({ file, parentSessionId: "other", toolCallId: "tool-1" });
  assert.equal(other.cause, "unproven");
  assert.equal(other.invalidTrace, undefined);
  const text = JSON.stringify(result);
  for (const canary of CANARIES) assert.equal(text.includes(canary), false, `probe 输出泄漏 canary：${canary}`);

  // 只含 supervisor 包络的文件：无 dispatch 证据 = unproven，而不是 invalid。
  const supervisorOnly = join(directory, "supervisor-only.jsonl");
  writeFileSync(supervisorOnly, "", { mode: 0o600 });
  const onlySink = createSubagentDispatchTraceFileSink(supervisorOnly);
  for (const entry of producerEntries()) onlySink(entry);
  onlySink.dispose();
  const onlyResult = readBoundedDispatchTrace({ file: supervisorOnly, parentSessionId: "parent-1", toolCallId: "tool-1" });
  assert.equal(onlyResult.cause, "unproven");
  assert.equal(onlyResult.invalidTrace, undefined);
  assert.deepEqual(onlyResult.records, []);
});

test("probe 对不合格 supervisor 包络一律 fail closed，对 9 类合法包络不误杀", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-supervisor-invalid-"));
  const file = join(directory, "trace.jsonl");
  const valid = { version: 1, eventKind: "supervisor-diagnostic", phase: "supervisor-replay-failed", monotonicMs: 5 };
  const invalidRecords = [
    { ...valid, phase: "supervisor-unknown-failed" },
    { ...valid, phase: "SUPERVISOR-REPLAY-FAILED" },
    { ...valid, phase: "tool-failed" },
    { ...valid, eventKind: "supervisor-diagnostic.v2" },
    { version: 1, phase: "supervisor-replay-failed", monotonicMs: 5 },
    { ...valid, version: 2 },
    { eventKind: "supervisor-diagnostic", phase: "supervisor-replay-failed", monotonicMs: 5 },
    { ...valid, error: { message: CANARY_BODY } },
    { ...valid, cause: { message: CANARY_PATH } },
    { ...valid, secondaryError: { message: CANARY_BODY } },
    { ...valid, compensation: { status: "blocked", code: "X" } },
    { ...valid, deliveryPhase: "reply" },
    { ...valid, type: "supervisor-replay-failed" },
    { ...valid, rootSessionId: CANARY_PATH },
    { ...valid, requestId: "../../escape" },
    { ...valid, runId: CANARY_TOKEN },
    { ...valid, receiptId: CANARY_DIGEST },
    { ...valid, errorCode: `open '${CANARY_PATH}' failed` },
    { ...valid, receiptStatus: "CANARY" },
    { ...valid, consumed: "yes" },
    { ...valid, ownerGeneration: 0 },
    { ...valid, requestGeneration: -1 },
    { ...valid, monotonicMs: -1 },
    { ...valid, monotonicMs: "5" },
    { ...valid, parentSessionId: "parent-1", toolCallId: "tool-1" },
    { ...valid, task: CANARY_BODY },
    { ...valid, payloadDigest: CANARY_DIGEST },
  ];
  for (const record of invalidRecords) {
    writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1" });
    const label = JSON.stringify(record);
    assert.equal(result.cause, "unproven", label);
    assert.ok(["invalid-schema", "invalid-version"].includes(result.invalidTrace), `${label} → ${result.invalidTrace}`);
    assert.deepEqual(result.records, [], label);
    const text = JSON.stringify(result);
    for (const canary of CANARIES) assert.equal(text.includes(canary), false, `${label} 泄漏 ${canary}`);
  }

  // 合格包络也不放行时序倒退。
  writeFileSync(file, `${JSON.stringify({ ...valid, monotonicMs: 9 })}\n${JSON.stringify({ ...valid, monotonicMs: 4 })}\n`, { mode: 0o600 });
  assert.equal(readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1" }).invalidTrace, "non-monotonic-time");

  // 9 类合法包络逐条通过（不误杀），且仍不作为 dispatch 证据。
  for (const phase of NINE_PHASES) {
    writeFileSync(file, `${JSON.stringify({ ...valid, phase })}\n`, { mode: 0o600 });
    const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1" });
    assert.equal(result.invalidTrace, undefined, phase);
    assert.equal(result.cause, "unproven", phase);
    assert.deepEqual(result.records, [], phase);
  }
});
