/**
 * D1 合同测试：RPC 准入失败的安全回执与 trace 接线。
 *
 * 覆盖计划 §5 D1 的验收点：
 * - 经 `createTypedSubagentExtension` 的公开 execute 链路验证合法 ping、缺 ctx、缺 session、
 *   cwd 不符、capability 缺失、generic 早于统一断言抛出的 `assertSpawnAllowed`；
 * - 失败 details 与 tool-failed trace 只携带 D0 的白名单 negotiation 投影；
 * - 原准入判定、error code/message、missingCapabilities/upgradeStopped、wire 与成功结果不变；
 * - 失败路径不调用 spawn、不新增回退、缺 ping 时不补造投影；
 * - 诊断（details/trace/0600 trace 文件）不含真实路径、身份值或任务正文 canary。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSubagentDispatchTraceFileSink,
  createTypedSubagentExtension,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

/* ------------------------- canary：诊断绝不允许出现 ------------------------- */

const CANARY_ROOT = "/Users/canary/pi-config-canary";
const CANARY_SESSION_FILE = "/Users/canary/.pi/sessions/parent-session-canary.jsonl";
const CANARY_SESSION_ID = "session-id-canary-5f3e2a10";
const CANARY_ASYNC_DIR = "/Users/canary/.pi/async-dir-canary";
const CANARY_CAPABILITY = "canaryCapabilityName";
const CANARY_TASK_BODY = "RPC-DIAGNOSTIC-BODY-CANARY-never-serialize-me";
const CANARY_TASK = `${CANARY_TASK_BODY} prompt containing ${CANARY_SESSION_FILE} under ${CANARY_ROOT}`;

const CANARIES = [
  CANARY_ROOT,
  CANARY_SESSION_FILE,
  CANARY_SESSION_ID,
  CANARY_ASYNC_DIR,
  CANARY_CAPABILITY,
  CANARY_TASK_BODY,
];

function assertNoCanary(value, label) {
  const text = JSON.stringify(value) ?? "";
  for (const canary of CANARIES) {
    assert.equal(text.includes(canary), false, `${label} 泄漏 canary：${canary}`);
  }
}

/** 诊断面（details/trace）不得出现正文、路径、身份值或 Error 对象类字段。 */
const FORBIDDEN_DIAGNOSTIC_KEYS = [
  "error", "cause", "secondaryError", "compensation", "raw", "session", "sessionFile",
  "asyncDir", "path", "cwd", "prompt", "task", "payloadDigest", "idempotencyKey", "stack",
];

function assertNoForbiddenKeys(value, label) {
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, inner] of Object.entries(node)) {
        assert.equal(FORBIDDEN_DIAGNOSTIC_KEYS.includes(key), false, `${label} 含禁止键 ${trail}.${key}`);
        walk(inner, `${trail}.${key}`);
      }
    }
  };
  walk(value, "$");
}

/* --------------------------------- harness --------------------------------- */

function createPi() {
  const tools = [];
  const listeners = new Map();
  const messages = [];
  return {
    tools,
    messages,
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
    sendMessage(message) { messages.push(message); },
    getAllTools() { return [...tools]; },
    on() {},
  };
}

/** 只记录调用；默认不实现 spawn，任何失败用例若走到 spawn 都会因缺回包而暴露。 */
function createRpc({ ping, spawn } = {}) {
  const calls = [];
  return {
    calls,
    async ping(options) {
      calls.push({ method: "ping", options });
      return ping(options);
    },
    async spawn(params, options) {
      calls.push({ method: "spawn", params, options });
      if (typeof spawn !== "function") {
        throw Object.assign(new Error("test harness did not expect a spawn call"), { code: "UNEXPECTED_SPAWN" });
      }
      return spawn(params, options);
    },
    async stop(params) { calls.push({ method: "stop", params }); return { text: "stopped" }; },
    dispose() {},
  };
}

const spawnCalls = (rpc) => rpc.calls.filter((call) => call.method === "spawn");
const pingCalls = (rpc) => rpc.calls.filter((call) => call.method === "ping");

const FULL_CAPABILITIES = Object.freeze({
  asyncSpawn: true,
  processTerminalProof: true,
  launchResolvedExtensions: true,
  runtimeAcknowledgedExtensions: true,
});

/** 失败用例的 ping：身份/cwd 全部使用 canary 值，用来证明诊断只输出布尔结论。 */
const canarySession = (overrides = {}) => ({
  sessionId: CANARY_SESSION_ID,
  sessionFile: CANARY_SESSION_FILE,
  cwd: CANARY_ROOT,
  ...overrides,
});

const GENERIC_INPUT = Object.freeze({
  agent: "executor",
  title: "RPC 诊断",
  task: CANARY_TASK,
});

function codingContract(overrides = {}) {
  return {
    title: "RPC 诊断接线",
    agent: "executor",
    task: CANARY_TASK,
    writePaths: ["packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts"],
    acceptance: { criteria: ["失败诊断只包含白名单布尔投影"] },
    ...overrides,
  };
}

// S4：按工具名解析注册面，不以 tools 数组位置为权威。
function startTool(host) {
  const found = (host.tools ?? []).find((tool) => tool?.name === "subagent_start");
  if (!found) throw new Error("subagent_start must be registered");
  return found;
}

function install(pi, options = {}) {
  createTypedSubagentExtension(pi, {
    cleanupStore: {},
    randomUUID: () => "dispatch-1",
    discoverAgents: async () => ({ agents: [{ name: "executor" }] }),
    ...options,
  });
  return startTool(pi);
}

function execute(tool, input, ctx = { cwd: CANARY_ROOT }) {
  return tool.execute("tool-call-1", input, undefined, undefined, ctx);
}

/** D0 投影的期望形状：只有固定枚举、布尔与白名单能力名。 */
function expectedNegotiation(overrides = {}) {
  return {
    schemaVersion: "rpc-negotiation-diagnostic.v1",
    stage: "spawn-capability-assertion",
    dispatchPath: "coding",
    capabilitiesEnvelopePresent: true,
    versionOk: true,
    spawnMethodOk: true,
    sessionIdPresent: true,
    lifecycleIdentityPresent: true,
    sessionCwdPresent: true,
    cwdEqual: true,
    missingCapabilities: [],
    ...overrides,
  };
}

function assertDiagnosticSurface(value, label) {
  assertNoCanary(value, label);
  assertNoForbiddenKeys(value, label);
}

/* ------------------------------ 1. 合法 ping ------------------------------ */

test("合法 ping：generic 成功结果与 wire 不变，诊断面不出现 negotiation", async () => {
  const pi = createPi();
  const trace = [];
  const rpc = createRpc({
    ping: async (options) => {
      options.diagnostic.sink("rpc-ping-sent", { method: "ping", requestId: "ping-1" });
      options.diagnostic.sink("rpc-ping-replied", { method: "ping", requestId: "ping-1" });
      return {
        version: 1,
        methods: ["ping", "spawn"],
        session: { sessionId: "session-1", sessionFile: "session-1", cwd: "/repo" },
      };
    },
    spawn: async (params, options) => {
      options.diagnostic.sink("rpc-spawn-sent", { method: "spawn", requestId: "spawn-1" });
      pi.events.emit("subagent:async-started", {
        runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "session-1", pid: 7,
        agent: "executor", workflowKey: "typed-dispatch-1", parentWorkflowRunId: "root-1",
      });
      options.diagnostic.sink("rpc-spawn-replied", { method: "spawn", requestId: "spawn-1" });
      return { details: { runId: "root-1", asyncDir: "/tmp/root-1" } };
    },
  });
  const tool = install(pi, { rpc, diagnosticSink: (entry) => trace.push(entry) });

  const result = await execute(tool, { agent: "executor", title: "Trace", task: "ordinary task body" }, { cwd: "/repo" });

  assert.equal(result.isError, false, result.content?.[0]?.text);
  assert.equal(result.details.runId, "leaf-1");
  assert.equal(Object.hasOwn(result.details, "negotiation"), false);
  assert.equal(Object.hasOwn(result.details, "detail"), false);
  assert.equal(spawnCalls(rpc).length, 1);
  // wire 不变：diagnostic/sink/toolCallId 不得进入公开 RPC spawn 参数。
  const spawnParams = spawnCalls(rpc)[0].params;
  for (const key of ["diagnostic", "sink", "toolCallId", "negotiation", "agent", "task"]) {
    assert.equal(Object.hasOwn(spawnParams, key), false, `${key} 不得出现在 wire spawn 参数`);
  }
  assert.deepEqual(trace.map((entry) => entry.phase), [
    "tool-entered", "agent-discovery-started", "agent-discovery-finished", "rpc-ping-sent", "rpc-ping-replied",
    "rpc-spawn-sent", "rpc-spawn-replied", "leaf-wait-started", "leaf-wait-finished", "tool-returned",
  ]);
  assert.ok(trace.every((entry) => !Object.hasOwn(entry, "negotiation")), "成功路径不得附 negotiation");
  assert.ok(trace.every((entry) => entry.toolCallId === "tool-call-1"));
});

test("合法 ping：coding 成功结果保持既有 handle 字段，无诊断附加", async () => {
  const pi = createPi();
  const rpc = createRpc({
    ping: async (options) => {
      options.diagnostic.sink("rpc-ping-sent", { method: "ping", requestId: "ping-1" });
      options.diagnostic.sink("rpc-ping-replied", { method: "ping", requestId: "ping-1" });
      return {
        version: 1,
        methods: ["ping", "spawn"],
        capabilities: { ...FULL_CAPABILITIES },
        session: { sessionId: "session-1", sessionFile: "session-1", cwd: "/repo" },
      };
    },
    spawn: async (params, options) => {
      options.diagnostic.sink("rpc-spawn-sent", { method: "spawn", requestId: "spawn-1" });
      pi.events.emit("subagent:async-started", {
        runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "session-1", pid: 9,
        agent: "executor", workflowKey: "typed-dispatch-1", parentWorkflowRunId: "root-1",
      });
      options.diagnostic.sink("rpc-spawn-replied", { method: "spawn", requestId: "spawn-1" });
      return { details: { runId: "root-1", asyncDir: "/tmp/root-1" } };
    },
  });
  const tool = install(pi, { rpc, registerAuthorizedRun: async () => {} });

  const result = await execute(tool, codingContract(), { cwd: "/repo" });

  assert.equal(result.isError, false, result.content?.[0]?.text);
  assert.equal(result.details.runId, "leaf-1");
  assert.equal(result.details.agent, "executor");
  assert.equal(Object.hasOwn(result.details, "negotiation"), false);
  assert.equal(spawnCalls(rpc).length, 1);
});

/* --------------------- 2. 统一断言失败（coding 路径） --------------------- */

test("coding 缺 session：断言失败附 D0 投影，code/message 与准入不变且不调用 spawn", async () => {
  const pi = createPi();
  const trace = [];
  const rpc = createRpc({
    ping: async () => ({ version: 1, methods: ["ping", "spawn"], capabilities: { ...FULL_CAPABILITIES } }),
  });
  const tool = install(pi, { rpc, diagnosticSink: (entry) => trace.push(entry) });

  const result = await execute(tool, codingContract());

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "CAPABILITY_NEGOTIATION_FAILED");
  // 原错误文案与 missing 集合不变（准入判定仍由 assertSpawnCapabilities 权威拥有）。
  assert.equal(result.content[0].text,
    "CAPABILITY_NEGOTIATION_FAILED: pi-subagents RPC capability negotiation failed; missing: rpc:v1/session");
  assert.deepEqual(result.details.detail.negotiation, expectedNegotiation({
    dispatchPath: "coding",
    sessionIdPresent: false,
    lifecycleIdentityPresent: false,
    sessionCwdPresent: false,
    cwdEqual: false,
    missingCapabilities: ["rpc:v1/session"],
  }));
  assert.deepEqual(Object.keys(result.details).sort(), ["code", "detail"]);
  assert.equal(spawnCalls(rpc).length, 0, "准入失败不得调用 spawn");
  assert.equal(pingCalls(rpc).length, 1, "不得为诊断重复 ping（不新增回退）");

  const failed = trace.find((entry) => entry.phase === "tool-failed");
  assert.ok(failed, "必须有 tool-failed trace");
  assert.equal(failed.errorCode, "CAPABILITY_NEGOTIATION_FAILED");
  assert.deepEqual(failed.negotiation, result.details.detail.negotiation);
  assertDiagnosticSurface(result.details, "coding 缺 session details");
  assertDiagnosticSurface(trace, "coding 缺 session trace");
});

test("generic 缺 ctx.cwd：投影只给 cwdEqual=false，不回显任何路径", async () => {
  const pi = createPi();
  const rpc = createRpc({
    ping: async () => ({
      version: 1,
      methods: ["ping", "spawn"],
      capabilities: { ...FULL_CAPABILITIES },
      session: canarySession(),
    }),
  });
  const tool = install(pi, { rpc });

  const result = await execute(tool, { agent: "executor", title: "缺 ctx", task: CANARY_TASK }, {});

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "CAPABILITY_NEGOTIATION_FAILED");
  assert.deepEqual(result.details.detail.negotiation, expectedNegotiation({
    dispatchPath: "generic",
    cwdEqual: false,
    missingCapabilities: ["rpc:v1/session"],
  }));
  assert.equal(spawnCalls(rpc).length, 0);
  assertDiagnosticSurface(result.details, "缺 ctx details");
});

test("coding cwd 不符：sessionCwdPresent=true 且 cwdEqual=false，身份值不外泄", async () => {
  const pi = createPi();
  const trace = [];
  const rpc = createRpc({
    ping: async () => ({
      version: 1,
      methods: ["ping", "spawn"],
      capabilities: { ...FULL_CAPABILITIES },
      session: canarySession({ cwd: "/another/canary-free-cwd" }),
    }),
  });
  const tool = install(pi, { rpc, diagnosticSink: (entry) => trace.push(entry) });

  const result = await execute(tool, codingContract(), { cwd: CANARY_ROOT });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.detail.negotiation, expectedNegotiation({
    cwdEqual: false,
    missingCapabilities: ["rpc:v1/session"],
  }));
  assert.equal(result.details.detail.negotiation.sessionCwdPresent, true);
  assertDiagnosticSurface(result.details, "cwd 不符 details");
  assertDiagnosticSurface(trace, "cwd 不符 trace");
  assert.equal(spawnCalls(rpc).length, 0);
});

test("coding capability 缺失：missingCapabilities 只含既有白名单能力名", async () => {
  const pi = createPi();
  const rpc = createRpc({
    ping: async () => ({
      version: 1,
      methods: ["ping", "spawn"],
      capabilities: {
        asyncSpawn: true,
        processTerminalProof: false,
        launchResolvedExtensions: true,
        runtimeAcknowledgedExtensions: true,
        [CANARY_CAPABILITY]: false,
        "evil:capability": null,
      },
      session: canarySession(),
    }),
  });
  const tool = install(pi, { rpc });

  const result = await execute(tool, codingContract());

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text,
    "CAPABILITY_NEGOTIATION_FAILED: pi-subagents RPC capability negotiation failed; missing: processTerminalProof");
  assert.deepEqual(result.details.detail.negotiation, expectedNegotiation({
    missingCapabilities: ["processTerminalProof"],
  }));
  assertDiagnosticSurface(result.details, "capability 缺失 details");
  assert.equal(spawnCalls(rpc).length, 0);
});

/* ------------------- 3. generic 早于统一断言的 assertSpawnAllowed ------------------- */

test("generic 早抛 assertSpawnAllowed：原 RPC 失败字段保留并在同一 catch 合并 negotiation", async () => {
  const pi = createPi();
  const trace = [];
  const rpc = createRpc({
    ping: async () => ({
      version: 1,
      methods: ["ping", "spawn"],
      // asyncSpawn 缺失 → negotiateCapabilities 判定不可 spawn，assertSpawnAllowed 先抛。
      capabilities: {
        processTerminalProof: true,
        launchResolvedExtensions: true,
        runtimeAcknowledgedExtensions: true,
      },
      session: canarySession({ sessionFile: null }),
    }),
  });
  const tool = install(pi, { rpc, diagnosticSink: (entry) => trace.push(entry) });

  const result = await execute(tool, { ...GENERIC_INPUT });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "CAPABILITY_NEGOTIATION_FAILED");
  // rpc-client 的原错误文案不变。
  assert.equal(result.content[0].text,
    "CAPABILITY_NEGOTIATION_FAILED: RPC capability negotiation failed; missing: asyncSpawn");
  // createSubagentRpcFailureDetails 的原字段全部保留，只新增 negotiation。
  assert.deepEqual(Object.keys(result.details).sort(), ["code", "detail"]);
  assert.deepEqual(Object.keys(result.details.detail).sort(), [
    "causeCode", "causeMessage", "negotiation", "rpcOperation", "stage", "taskId", "toolCallId",
  ]);
  assert.equal(result.details.detail.toolCallId, "tool-call-1");
  assert.equal(result.details.detail.stage, "rpc-ping");
  assert.equal(result.details.detail.rpcOperation, "spawn");
  assert.equal(result.details.detail.causeCode, "CAPABILITY_NEGOTIATION_FAILED");
  assert.equal(result.details.detail.causeMessage, "RPC capability negotiation failed; missing: asyncSpawn");
  assert.deepEqual(result.details.detail.negotiation, expectedNegotiation({
    dispatchPath: "generic",
    missingCapabilities: ["asyncSpawn"],
  }));
  // 白名单外字段（含 raw 回包）绝不出现。
  assert.equal(Object.hasOwn(result.details.detail, "raw"), false);
  assert.equal(Object.hasOwn(result.details.detail, "missingCapabilities"), false);
  assert.equal(spawnCalls(rpc).length, 0, "assertSpawnAllowed 失败不得调用 spawn");
  assert.equal(pingCalls(rpc).length, 1, "不得为诊断补 ping");

  const failed = trace.find((entry) => entry.phase === "tool-failed");
  assert.equal(failed.errorCode, "CAPABILITY_NEGOTIATION_FAILED");
  assert.equal(failed.stage, "rpc-ping");
  assert.deepEqual(failed.negotiation, result.details.detail.negotiation);
  assertDiagnosticSurface(result.details, "generic 早抛 details");
  assertDiagnosticSurface(trace, "generic 早抛 trace");
});

test("generic 无 capabilities envelope：统一断言失败走 error.detail 分支且不含 RPC 失败字段", async () => {
  const pi = createPi();
  const rpc = createRpc({
    ping: async () => ({
      version: 1,
      methods: ["ping", "spawn"],
      session: canarySession({ cwd: "/another/canary-free-cwd" }),
    }),
  });
  const tool = install(pi, { rpc });

  const result = await execute(tool, { ...GENERIC_INPUT });

  assert.equal(result.isError, true);
  assert.deepEqual(Object.keys(result.details).sort(), ["code", "detail"]);
  assert.deepEqual(result.details.detail.negotiation, expectedNegotiation({
    dispatchPath: "generic",
    capabilitiesEnvelopePresent: false,
    cwdEqual: false,
    missingCapabilities: ["rpc:v1/session"],
  }));
  assert.equal(result.content[0].text,
    "CAPABILITY_NEGOTIATION_FAILED: pi-subagents RPC capability negotiation failed; missing: rpc:v1/session");
  assert.equal(spawnCalls(rpc).length, 0);
  assertDiagnosticSurface(result.details, "generic 无 envelope details");
});

/* ------------------------- 4. 缺 ping 不补造投影 ------------------------- */

test("ping 失败：RPC 失败 details 保留原字段但不补造 negotiation", async () => {
  const pi = createPi();
  const trace = [];
  const rpc = createRpc({
    ping: async () => {
      throw Object.assign(new Error("typed subagent RPC ping timed out"), { code: "timeout", operation: "ping" });
    },
  });
  const tool = install(pi, { rpc, diagnosticSink: (entry) => trace.push(entry) });

  const result = await execute(tool, { ...GENERIC_INPUT });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "timeout");
  assert.equal(result.details.detail.rpcOperation, "ping");
  assert.equal(result.details.detail.stage, "rpc-ping");
  assert.equal(Object.hasOwn(result.details.detail, "negotiation"), false, "缺 ping 回包不得伪造投影");
  assert.equal(spawnCalls(rpc).length, 0);

  const failed = trace.find((entry) => entry.phase === "tool-failed");
  assert.equal(failed.errorCode, "timeout");
  assert.equal(Object.hasOwn(failed, "negotiation"), false);
  assertDiagnosticSurface(result.details, "ping 失败 details");
});

/* --------------------- 5. 端到端：0600 trace 文件落盘 --------------------- */

test("失败诊断写入 0600 trace 文件时只落盘白名单 negotiation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-rpc-diagnostics-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);
  const pi = createPi();
  const rpc = createRpc({
    ping: async () => ({
      version: 1,
      methods: ["ping", "spawn"],
      capabilities: {
        asyncSpawn: true,
        processTerminalProof: true,
        launchResolvedExtensions: false,
        runtimeAcknowledgedExtensions: true,
      },
      session: canarySession(),
    }),
  });
  const tool = install(pi, { rpc, diagnosticSink: sink });

  const result = await execute(tool, codingContract());
  assert.equal(result.isError, true);
  sink.dispose();

  const records = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const failed = records.find((record) => record.phase === "tool-failed");
  assert.ok(failed, "trace 文件必须有 tool-failed 记录");
  assert.deepEqual(Object.keys(failed).sort(), [
    "errorCode", "monotonicMs", "negotiation", "phase", "toolCallId", "version",
  ]);
  assert.deepEqual(failed.negotiation, expectedNegotiation({
    missingCapabilities: ["launchResolvedExtensions"],
  }));
  assert.equal(failed.errorCode, "CAPABILITY_NEGOTIATION_FAILED");
  assertNoCanary(records, "trace 文件");
  assert.ok(!readFileSync(file, "utf8").includes(CANARY_TASK_BODY), "任务正文不得落盘");
});
