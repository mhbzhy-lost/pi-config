/**
 * D0 诊断投影合同测试：RPC 布尔诊断、supervisor 9 类 phase/type 诊断、receipt 投影。
 * 覆盖：未知字段不透传、正文/路径/error/cause/payload digest 不泄漏、畸形输入 fail closed、
 * 完整 9 类 phase 与 type 两种形状、queued 不等于 consumed、投影纯函数与白名单键集。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  projectRpcNegotiation,
  projectSupervisorReceipt,
  projectSupervisorTrace,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/diagnostics.ts";

/* ---------------------------- 共享 canary 与断言 ---------------------------- */

const CANARY_PATH = "/Users/canary/.pi/sessions/root-session-file-canary.jsonl";
const CANARY_ASYNC_DIR = "/Users/canary/.pi/async-dir-canary";
const CANARY_BODY = "TASK-BODY-CANARY-never-serialize-me";
const CANARY_PROMPT = `dispatch prompt containing ${CANARY_BODY} and ${CANARY_PATH}`;
const CANARY_DIGEST = `sha256:${"a".repeat(64)}`;
const CANARY_IDEMPOTENCY_KEY = `request-generation-1:idempotency-canary:${"b".repeat(32)}`;
const CANARY_SESSION_ID = "session-id-canary-5f3e2a10";
const CANARY_SECRET = "Bearer secret-token-canary-9fb2c1";
const CANARY_ERROR_TEXT = `ENOENT: no such file or directory, open '${CANARY_PATH}'`;

const CANARIES = [
  CANARY_PATH,
  CANARY_ASYNC_DIR,
  CANARY_BODY,
  CANARY_PROMPT,
  CANARY_DIGEST,
  CANARY_IDEMPOTENCY_KEY,
  CANARY_SESSION_ID,
  CANARY_SECRET,
  CANARY_ERROR_TEXT,
];

/** 任何被禁止的键名都不得出现在投影结果里。 */
const FORBIDDEN_KEYS = [
  "error", "cause", "secondaryError", "compensation", "detail", "details", "message",
  "raw", "cwd", "path", "sessionFile", "sessionPath", "asyncDir", "dir", "payloadDigest",
  "requestDigest", "idempotencyKey", "prompt", "content", "token", "authorization", "stack",
];

function serialize(value) {
  return JSON.stringify(value) ?? "";
}

/** 投影必须是干净、可序列化、无禁止键、无 canary 文本的白名单对象。 */
function assertSanitized(value, label) {
  const text = serialize(value);
  for (const canary of CANARIES) {
    assert.ok(!text.includes(canary), `${label} 泄漏 canary：${canary.slice(0, 48)}`);
  }
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, inner] of Object.entries(node)) {
        assert.equal(FORBIDDEN_KEYS.includes(key), false, `${label} 含禁止键 ${trail}.${key}`);
        walk(inner, `${trail}.${key}`);
      }
    }
  };
  walk(value, "$");
}

/* ---------------------------- 1. RPC negotiation ---------------------------- */

const EXPECTED_CWD = "/Users/canary/orchestrator-cwd";

const healthyPing = (overrides = {}, sessionOverrides = null) => ({
  version: 1,
  methods: ["ping", "spawn", "status"],
  capabilities: {
    asyncSpawn: true,
    processTerminalProof: true,
    launchResolvedExtensions: true,
    runtimeAcknowledgedExtensions: true,
  },
  session: {
    sessionId: "parent-session-1",
    sessionFile: null,
    cwd: EXPECTED_CWD,
    ...(sessionOverrides === null ? {} : sessionOverrides),
  },
  ...overrides,
});

test("RPC 投影输出固定 schema/stage/路径枚举与全通过布尔", () => {
  const projection = projectRpcNegotiation(healthyPing(), EXPECTED_CWD, "coding");
  assert.equal(projection.schemaVersion, "rpc-negotiation-diagnostic.v1");
  assert.equal(projection.stage, "spawn-capability-assertion");
  assert.equal(projection.dispatchPath, "coding");
  assert.equal(projection.capabilitiesEnvelopePresent, true);
  for (const field of ["versionOk", "spawnMethodOk", "sessionIdPresent", "lifecycleIdentityPresent", "sessionCwdPresent", "cwdEqual"]) {
    assert.equal(projection[field], true, `${field} 应为 true`);
  }
  assert.deepEqual([...projection.missingCapabilities], []);
  assertSanitized(projection, "RPC 全通过投影");
});

test("RPC 投影 generic 路径与 coding 同样保持字段集合一致", () => {
  const coding = projectRpcNegotiation(healthyPing(), EXPECTED_CWD, "coding");
  const generic = projectRpcNegotiation(healthyPing(), EXPECTED_CWD, "generic");
  assert.equal(generic.dispatchPath, "generic");
  assert.deepEqual(Object.keys(generic).sort(), Object.keys(coding).sort());
});

test("RPC 投影不接管准入：合法 ping 的 missingCapabilities 为空且断言语义一致", () => {
  const projection = projectRpcNegotiation(healthyPing(), EXPECTED_CWD, "coding");
  assert.equal(projection.missingCapabilities.length, 0);
});

test("RPC 投影 legacy 无 envelope 形状保持原断言语义（不凭空的 4 个能力名报错）", () => {
  const legacy = healthyPing();
  delete legacy.capabilities;
  const projection = projectRpcNegotiation(legacy, EXPECTED_CWD, "generic");
  assert.equal(projection.capabilitiesEnvelopePresent, false);
  assert.deepEqual([...projection.missingCapabilities], []);
  assert.equal(projection.versionOk, true);
  assert.equal(projection.cwdEqual, true);
});

test("RPC 投影逐个报告缺失的安全能力名，且不含任何其他能力名", () => {
  for (const capability of ["asyncSpawn", "processTerminalProof", "launchResolvedExtensions", "runtimeAcknowledgedExtensions"]) {
    for (const absent of [false, null, undefined]) {
      const capabilities = {
        asyncSpawn: true,
        processTerminalProof: true,
        launchResolvedExtensions: true,
        runtimeAcknowledgedExtensions: true,
        [capability]: absent,
      };
      const projection = projectRpcNegotiation(healthyPing({ capabilities }), EXPECTED_CWD, "coding");
      assert.deepEqual([...projection.missingCapabilities], [capability], `${capability}=${String(absent)}`);
      assert.equal(projection.capabilitiesEnvelopePresent, true);
      assertSanitized(projection, `RPC 缺能力 ${capability}`);
    }
  }
});

test("RPC 投影 capability 的对象形态视为具备", () => {
  const capabilities = {
    asyncSpawn: { version: 1 },
    processTerminalProof: true,
    launchResolvedExtensions: true,
    runtimeAcknowledgedExtensions: true,
    statusProjection: true,
  };
  const projection = projectRpcNegotiation(healthyPing({ capabilities }), EXPECTED_CWD, "coding");
  assert.equal(projection.capabilitiesEnvelopePresent, true);
  assert.equal(projection.missingCapabilities.length, 0);
  assertSanitized(projection, "RPC capability 对象形态");
});

test("RPC 投影把 6 个身份条件的偏离折叠成 rpc:v1/session 且只输出布尔", () => {
  const cases = [
    ["version 不为 1", healthyPing({ version: 2 }), { versionOk: false, cwdEqual: true }],
    ["缺 spawn 方法", healthyPing({ methods: ["ping"] }), { spawnMethodOk: false }],
    ["methods 非数组", healthyPing({ methods: "spawn" }), { spawnMethodOk: false }],
    ["缺 session", healthyPing({ session: undefined }), { sessionIdPresent: false, sessionCwdPresent: false, cwdEqual: false }],
    ["sessionId 空串", healthyPing({}, { sessionId: "" }), { sessionIdPresent: false }],
    ["sessionFile 空串（无效身份）", healthyPing({}, { sessionFile: "" }), { lifecycleIdentityPresent: false }],
    ["sessionFile 非字符串", healthyPing({}, { sessionFile: 42 }), { lifecycleIdentityPresent: false }],
    ["sessionFile 为 null 时回落 sessionId", healthyPing({}, { sessionFile: null }), { lifecycleIdentityPresent: true }],
    ["session.cwd 缺失", healthyPing({}, { cwd: undefined }), { sessionCwdPresent: false, cwdEqual: false }],
    ["cwd 不相等", healthyPing({}, { cwd: `${EXPECTED_CWD}/child` }), { sessionCwdPresent: true, cwdEqual: false }],
  ];
  for (const [label, result, expected] of cases) {
    const projection = projectRpcNegotiation(result, EXPECTED_CWD, "coding");
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(projection[field], value, `${label} 的 ${field}`);
    }
    if (Object.values(expected).includes(false)) {
      assert.deepEqual([...projection.missingCapabilities], ["rpc:v1/session"], label);
    }
    assertSanitized(projection, `RPC 身份条件 ${label}`);
  }
});

test("RPC 投影对畸形 result 一律 fail closed，绝不抛错也不回声输入", () => {
  for (const result of [undefined, null, false, true, 0, 1, "rpc", [], [{ spawn: 1 }], () => CANARY_BODY, Symbol("s")]) {
    const projection = projectRpcNegotiation(result, EXPECTED_CWD, "coding");
    assert.equal(projection.schemaVersion, "rpc-negotiation-diagnostic.v1");
    assert.equal(projection.capabilitiesEnvelopePresent, false);
    assert.equal(projection.versionOk, false);
    assert.equal(projection.spawnMethodOk, false);
    assert.equal(projection.sessionIdPresent, false);
    assert.equal(projection.lifecycleIdentityPresent, false);
    assert.equal(projection.sessionCwdPresent, false);
    assert.equal(projection.cwdEqual, false);
    assert.deepEqual([...projection.missingCapabilities], ["rpc:v1/session"]);
    assertSanitized(projection, "RPC 畸形 result");
  }
});

test("RPC 投影不透传未知字段与正文/路径/digest", () => {
  const poisoned = healthyPing({
    task: CANARY_PROMPT,
    prompt: CANARY_PROMPT,
    message: CANARY_BODY,
    detail: { cause: new Error(CANARY_ERROR_TEXT) },
    raw: { sessionFile: CANARY_PATH, asyncDir: CANARY_ASYNC_DIR },
    payloadDigest: CANARY_DIGEST,
    token: CANARY_SECRET,
    cwd: CANARY_PATH,
    methods: ["ping", "spawn", CANARY_PATH, CANARY_SESSION_ID, "x".repeat(500)],
    capabilities: {
      asyncSpawn: true,
      processTerminalProof: true,
      launchResolvedExtensions: true,
      runtimeAcknowledgedExtensions: true,
      [CANARY_SESSION_ID]: true,
      evilCapability: CANARY_BODY,
    },
    session: { sessionId: CANARY_SESSION_ID, sessionFile: CANARY_PATH, cwd: CANARY_PATH },
  });
  const projection = projectRpcNegotiation(poisoned, CANARY_PATH, "coding");
  assertSanitized(projection, "RPC 投毒投影");
  assert.deepEqual(Object.keys(projection).sort(), [
    "capabilitiesEnvelopePresent", "cwdEqual", "dispatchPath", "lifecycleIdentityPresent",
    "missingCapabilities", "schemaVersion", "sessionCwdPresent", "sessionIdPresent",
    "spawnMethodOk", "stage", "versionOk",
  ].sort());
  // 真实路径与身份值绝不出现，只有布尔结论。
  assert.equal(serialize(projection).includes(CANARY_PATH), false);
  assert.equal(serialize(projection).includes(CANARY_SESSION_ID), false);
  assert.equal(serialize(projection).includes(CANARY_BODY), false);
  assert.equal(serialize(projection).includes(CANARY_DIGEST), false);
});

test("RPC 投影未知 capability 名绝不进入 missingCapabilities", () => {
  const poisoned = healthyPing({
    capabilities: {
      asyncSpawn: false,
      processTerminalProof: true,
      launchResolvedExtensions: true,
      runtimeAcknowledgedExtensions: true,
      [CANARY_BODY]: false,
      "evil:capability": null,
      [`/abs/${CANARY_SESSION_ID}`]: undefined,
    },
  });
  const projection = projectRpcNegotiation(poisoned, EXPECTED_CWD, "generic");
  assert.deepEqual([...projection.missingCapabilities], ["asyncSpawn"]);
  assertSanitized(projection, "RPC 未知能力名过滤");
});

test("RPC 投影的 expectedCwd 畸形时只输出 false，不回声参数", () => {
  for (const expectedCwd of [undefined, null, 42, {}, [], CANARY_PATH]) {
    const projection = projectRpcNegotiation(healthyPing(), expectedCwd, "coding");
    assert.equal(projection.cwdEqual, false);
    assert.equal(projection.sessionCwdPresent, true);
    assertSanitized(projection, "RPC 畸形 expectedCwd");
  }
});

test("RPC 投影的 dispatchPath 白名单外一律 unknown", () => {
  for (const dispatchPath of [undefined, null, "workflow-spawn", "", "Coding", {}, CANARY_BODY, 1]) {
    const projection = projectRpcNegotiation(healthyPing(), EXPECTED_CWD, dispatchPath);
    assert.equal(projection.dispatchPath, "unknown", String(dispatchPath));
    assertSanitized(projection, "RPC 非法 dispatchPath");
  }
});

test("RPC 投影是纯函数：输入对象不变，输出冻结且两次一致", () => {
  const result = healthyPing();
  const snapshot = JSON.stringify(result);
  const first = projectRpcNegotiation(result, EXPECTED_CWD, "coding");
  const second = projectRpcNegotiation(result, EXPECTED_CWD, "coding");
  assert.equal(JSON.stringify(result), snapshot);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { first.versionOk = false; }, TypeError);
});

/* ---------------------------- 2. supervisor trace ---------------------------- */

const SUPERVISOR_PHASES = [
  "supervisor-registration-failed",
  "supervisor-delivery-compensation-failed",
  "supervisor-owner-read-failed",
  "supervisor-runtime-read-failed",
  "supervisor-consumption-rejected",
  "supervisor-consumption-failed",
  "supervisor-persistence-corrupt",
  "supervisor-persistence-rejected",
  "supervisor-replay-failed",
];

const ENVELOPE_CLOCK = 1_700_000_000_123;

test("trace 投影覆盖全部 9 类诊断的 phase 形状并补齐包络 version/clock", () => {
  for (const phase of SUPERVISOR_PHASES) {
    const entry = { phase, runId: "run-1", requestId: "req-1", errorCode: "SUPERVISOR_OWNER_UNAVAILABLE" };
    const projection = projectSupervisorTrace(entry, ENVELOPE_CLOCK);
    assert.ok(projection, phase);
    assert.equal(projection.version, 1);
    assert.equal(projection.eventKind, "supervisor-diagnostic");
    assert.equal(projection.phase, phase);
    assert.equal(projection.monotonicMs, ENVELOPE_CLOCK);
    assert.equal(projection.runId, "run-1");
    assert.equal(projection.requestId, "req-1");
    assert.equal(projection.errorCode, "SUPERVISOR_OWNER_UNAVAILABLE");
    assertSanitized(projection, `trace phase ${phase}`);
  }
});

test("trace 投影兼容 control plane 的 type 形状，输出统一为 phase", () => {
  for (const type of SUPERVISOR_PHASES) {
    const projection = projectSupervisorTrace({ type, rootSessionId: "root-1", code: "SUPERVISOR_PERSISTENCE_CORRUPT" }, ENVELOPE_CLOCK);
    assert.ok(projection, type);
    assert.equal(projection.phase, type);
    assert.ok(!Object.hasOwn(projection, "type"), `${type} 不应保留 type 字段`);
    assert.equal(projection.rootSessionId, "root-1");
    assert.equal(projection.errorCode, "SUPERVISOR_PERSISTENCE_CORRUPT");
    assertSanitized(projection, `trace type ${type}`);
  }
});

test("trace 投影保留 producer 自带的有效 monotonicMs", () => {
  const projection = projectSupervisorTrace({ phase: "supervisor-replay-failed", monotonicMs: 42 }, ENVELOPE_CLOCK);
  assert.equal(projection.monotonicMs, 42);
});

test("trace 投影只在缺 clock 时补当前单调时钟，不补业务身份", () => {
  const filled = projectSupervisorTrace({ phase: "supervisor-owner-read-failed" }, ENVELOPE_CLOCK);
  assert.equal(filled.monotonicMs, ENVELOPE_CLOCK);
  assert.equal(Object.hasOwn(filled, "runId"), false);
  assert.equal(Object.hasOwn(filled, "receiptId"), false);
  assert.equal(Object.hasOwn(filled, "consumed"), false);
});

test("trace 投影在时钟不可用时回落到包络时钟，两者都畸形则 fail closed", () => {
  for (const clock of [undefined, null, NaN, Infinity, -Infinity, -1, 1.5, "123", {}, [], BigInt(1)]) {
    assert.equal(projectSupervisorTrace({ phase: "supervisor-replay-failed" }, clock), undefined, String(clock));
  }
  // producer 自带的 clock 形态不可用时，按诊断包络语义由调用方单调时钟补齐（不新增业务事实）。
  for (const entryClock of [NaN, Infinity, -1, 1.5, "123", null, true]) {
    const projection = projectSupervisorTrace({ phase: "supervisor-replay-failed", monotonicMs: entryClock }, ENVELOPE_CLOCK);
    assert.equal(projection?.monotonicMs, ENVELOPE_CLOCK, String(entryClock));
    assertSanitized(projection ?? {}, "trace 包络时钟回落");
    assert.equal(projectSupervisorTrace({ phase: "supervisor-replay-failed", monotonicMs: entryClock }, NaN), undefined, String(entryClock));
  }
});

test("trace 投影拒绝白名单外的 phase/type 与畸形 entry", () => {
  const rejectedEntries = [
    { phase: "tool-failed" },
    { phase: "recovery-handoff-invalid" },
    { phase: "subagent-ready-debt-retry-failed" },
    { phase: "supervisor-unknown-failed" },
    { phase: "registration-failed" },
    { phase: "SUPERVISOR_REPLAY_FAILED" },
    { phase: `${SUPERVISOR_PHASES[0]} ${CANARY_BODY}` },
    { type: "tool-failed" },
    { type: undefined },
    { phase: 42, type: 7 },
    { phase: [], type: {} },
    {},
    undefined,
    null,
    "supervisor-replay-failed",
    42,
    [],
    [{ phase: "supervisor-replay-failed" }],
    new Error(CANARY_ERROR_TEXT),
  ];
  for (const entry of rejectedEntries) {
    assert.equal(projectSupervisorTrace(entry, ENVELOPE_CLOCK), undefined);
  }
});

test("trace 投影不序列化 error/cause/secondaryError/compensation 对象", () => {
  const entry = {
    version: 1,
    phase: "supervisor-delivery-compensation-failed",
    deliveryPhase: "reply",
    monotonicMs: 99,
    error: new Error(CANARY_ERROR_TEXT),
    cause: new Error(CANARY_BODY),
    secondaryError: Object.assign(new Error(`blocked ${CANARY_ASYNC_DIR}`), { code: CANARY_SECRET }),
    compensation: { status: "blocked", code: "SUPERVISOR_REPLY_REQUIRED", receipt: { idempotencyKey: CANARY_IDEMPOTENCY_KEY, payloadDigest: CANARY_DIGEST } },
    runId: "run-1",
    requestId: "request-1",
    errorCode: "SUPERVISOR_REPLY_DELIVERY_FAILED",
    prompt: CANARY_PROMPT,
    sessionFile: CANARY_PATH,
    asyncDir: CANARY_ASYNC_DIR,
    payloadDigest: CANARY_DIGEST,
  };
  const projection = projectSupervisorTrace(entry, ENVELOPE_CLOCK);
  assert.ok(projection);
  assert.deepEqual(Object.keys(projection).sort(), [
    "errorCode", "monotonicMs", "phase", "requestId", "runId", "version", "eventKind",
  ].sort());
  assert.equal(projection.deliveryPhase, undefined);
  assertSanitized(projection, "trace compensation 投毒投影");
});

test("trace 投影只接受 safe ID，畸形/超长/路径形态一律丢弃", () => {
  const oversize = `r${"a".repeat(200)}`;
  const entry = {
    phase: "supervisor-consumption-rejected",
    runId: "run-ok_1.-2",
    requestId: CANARY_PATH,
    receiptId: `../../etc/${CANARY_SESSION_ID}`,
    rootSessionId: oversize,
    code: "SUPERVISOR_CONSUMPTION_MISMATCH",
  };
  const projection = projectSupervisorTrace(entry, ENVELOPE_CLOCK);
  assert.equal(projection.runId, "run-ok_1.-2");
  assert.equal(Object.hasOwn(projection, "requestId"), false);
  assert.equal(Object.hasOwn(projection, "receiptId"), false);
  assert.equal(Object.hasOwn(projection, "rootSessionId"), false);
  assert.equal(projection.errorCode, "SUPERVISOR_CONSUMPTION_MISMATCH");
  assertSanitized(projection, "trace ID 规则");
});

test("trace 投影只接受标识符形态 errorCode，拒绝正文与路径", () => {
  const cases = [
    [CANARY_ERROR_TEXT, false],
    [CANARY_PATH, false],
    [`open '${CANARY_ASYNC_DIR}'`, false],
    ["", false],
    [`${CANARY_BODY}!`, false],
    ["SUPERVISOR_REQUEST_EXPIRED", true],
    ["authority_store_unavailable", true],
    ["CAPABILITY_NEGOTIATION_FAILED", true],
  ];
  for (const [code, accepted] of cases) {
    const projection = projectSupervisorTrace({ phase: "supervisor-persistence-rejected", code }, ENVELOPE_CLOCK);
    assert.equal(Object.hasOwn(projection, "errorCode"), accepted, String(code));
    if (accepted) assert.equal(projection.errorCode, code);
    assertSanitized(projection, "trace errorCode 规则");
  }
});

test("trace 投影的 receiptStatus 只接受 3 个枚举值，绝不接受决策状态", () => {
  for (const status of ["queued", "delivered", "failed"]) {
    const projection = projectSupervisorTrace({ phase: "supervisor-registration-failed", receiptStatus: status }, ENVELOPE_CLOCK);
    assert.equal(projection.receiptStatus, status);
  }
  for (const status of ["blocked", "committed", "idempotent", "allowed", "replied", "expired", "pending", undefined, CANARY_BODY]) {
    const projection = projectSupervisorTrace({ phase: "supervisor-registration-failed", status }, ENVELOPE_CLOCK);
    assert.equal(Object.hasOwn(projection, "receiptStatus"), false, String(status));
    assertSanitized(projection, "trace receiptStatus 拒绝");
  }
});

test("trace 投影的 consumed 只接受布尔，queued 不被推断成已消费", () => {
  const queued = projectSupervisorTrace({ phase: "supervisor-consumption-rejected", receiptStatus: "queued", consumed: false }, ENVELOPE_CLOCK);
  assert.equal(queued.receiptStatus, "queued");
  assert.equal(queued.consumed, false);
  const terminal = projectSupervisorTrace({ phase: "supervisor-consumption-failed", receiptStatus: "delivered", consumed: true }, ENVELOPE_CLOCK);
  assert.equal(terminal.consumed, true);
  for (const consumed of ["true", 1, 0, null, {}, []]) {
    const projection = projectSupervisorTrace({ phase: "supervisor-consumption-rejected", consumed }, ENVELOPE_CLOCK);
    assert.equal(Object.hasOwn(projection, "consumed"), false, String(consumed));
  }
});

test("trace 投影的 generation 沿 control plane positive 规则（0 不是合法世代）", () => {
  const ok = projectSupervisorTrace({ phase: "supervisor-owner-read-failed", ownerGeneration: 3, requestGeneration: 1 }, ENVELOPE_CLOCK);
  assert.equal(ok.ownerGeneration, 3);
  assert.equal(ok.requestGeneration, 1);
  for (const bad of [0, 1.5, NaN, Infinity, -1, "2", null, true, {}]) {
    const projection = projectSupervisorTrace({ phase: "supervisor-runtime-read-failed", ownerGeneration: bad, requestGeneration: bad }, ENVELOPE_CLOCK);
    assert.equal(Object.hasOwn(projection, "ownerGeneration"), false, String(bad));
    assert.equal(Object.hasOwn(projection, "requestGeneration"), false, String(bad));
  }
});

test("trace 投影是纯函数且输出冻结", () => {
  const entry = { phase: "supervisor-replay-failed", error: new Error(CANARY_ERROR_TEXT), runId: "run-1" };
  const first = projectSupervisorTrace(entry, ENVELOPE_CLOCK);
  const second = projectSupervisorTrace(entry, ENVELOPE_CLOCK);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
  assertSanitized(first, "trace 纯函数投影");
});

test("trace 投影可被 JSON 序列化且不含不可序列化对象", () => {
  const entry = {
    phase: "supervisor-registration-failed",
    errorCode: "SUPERVISOR_REQUEST_REGISTRATION_FAILED",
    requestId: "request-1",
    runId: "run-1",
    error: Object.assign(new Error(CANARY_ERROR_TEXT), { cause: { detail: CANARY_BODY }, code: "SUPERVISOR_OWNER_UNAVAILABLE" }),
    monotonicMs: 7,
  };
  const projection = projectSupervisorTrace(entry, ENVELOPE_CLOCK);
  assert.deepEqual(JSON.parse(serialize(projection)), {
    version: 1,
    eventKind: "supervisor-diagnostic",
    phase: "supervisor-registration-failed",
    monotonicMs: 7,
    runId: "run-1",
    requestId: "request-1",
    errorCode: "SUPERVISOR_REQUEST_REGISTRATION_FAILED",
  });
});

/* ---------------------------- 3. supervisor receipt ---------------------------- */

const durableReceipt = (overrides = {}) => ({
  receiptId: "receipt-1700000000000-abc",
  idempotencyKey: CANARY_IDEMPOTENCY_KEY,
  kind: "reply",
  status: "queued",
  consumed: false,
  runId: "run-1",
  rootSessionId: "root-session-1",
  ownerGeneration: 2,
  requestGeneration: 1,
  requestId: "request-1",
  payloadDigest: CANARY_DIGEST,
  correlation: { sessionFile: CANARY_PATH, asyncDir: CANARY_ASYNC_DIR, requestBodyDigest: CANARY_DIGEST },
  ...overrides,
});

test("receipt 投影只输出白名单字段并丢弃 idempotencyKey/payloadDigest/root 字段", () => {
  const projection = projectSupervisorReceipt(durableReceipt());
  assert.deepEqual(projection, {
    schemaVersion: "supervisor-receipt-diagnostic.v1",
    receiptId: "receipt-1700000000000-abc",
    runId: "run-1",
    requestId: "request-1",
    status: "queued",
    consumed: false,
    requestGeneration: 1,
    ownerGeneration: 2,
  });
  assert.deepEqual(Object.keys(projection).sort(), [
    "consumed", "ownerGeneration", "receiptId", "requestGeneration", "requestId", "runId", "schemaVersion", "status",
  ]);
  assertSanitized(projection, "receipt 投影");
});

test("receipt 投影保持 queued 不等于 consumed 的两个独立事实", () => {
  const queued = projectSupervisorReceipt(durableReceipt({ status: "queued", consumed: false }));
  assert.equal(queued.status, "queued");
  assert.equal(queued.consumed, false);
  const delivered = projectSupervisorReceipt(durableReceipt({ status: "delivered", consumed: true }));
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.consumed, true);
  const failed = projectSupervisorReceipt(durableReceipt({ status: "failed", consumed: false, code: "SUPERVISOR_REPLY_DELIVERY_FAILED" }));
  assert.equal(failed.status, "failed");
  assert.equal(Object.hasOwn(failed, "code"), false);
  assert.equal(Object.hasOwn(failed, "kind"), false);
});

test("receipt 投影在 steer 形态（无 requestId）下仍可投影", () => {
  const steer = durableReceipt({ kind: "steer", requestId: undefined });
  const projection = projectSupervisorReceipt(steer);
  assert.equal(Object.hasOwn(projection, "requestId"), false);
  assert.equal(projection.receiptId, "receipt-1700000000000-abc");
});

test("receipt 投影对畸形核心字段 fail closed", () => {
  const malformed = [
    durableReceipt({ status: "blocked" }),
    durableReceipt({ status: undefined }),
    durableReceipt({ consumed: "false" }),
    durableReceipt({ consumed: undefined }),
    durableReceipt({ receiptId: CANARY_PATH }),
    durableReceipt({ receiptId: undefined }),
    durableReceipt({ receiptId: `r${"x".repeat(200)}` }),
    durableReceipt({ runId: "../../root" }),
    durableReceipt({ runId: 7 }),
    undefined,
    null,
    "receipt-1",
    42,
    [],
    [durableReceipt()],
    new Error(CANARY_ERROR_TEXT),
  ];
  for (const receipt of malformed) {
    assert.equal(projectSupervisorReceipt(receipt), undefined);
  }
});

test("receipt 投影丢弃可选字段的畸形值但保留其余事实", () => {
  const projection = projectSupervisorReceipt(durableReceipt({
    requestId: CANARY_ASYNC_DIR,
    ownerGeneration: 0,
    requestGeneration: -2,
  }));
  assert.ok(projection);
  assert.equal(Object.hasOwn(projection, "requestId"), false);
  assert.equal(Object.hasOwn(projection, "ownerGeneration"), false);
  assert.equal(Object.hasOwn(projection, "requestGeneration"), false);
  assertSanitized(projection, "receipt 可选字段畸形");
});

test("receipt 投影是纯函数且输出冻结", () => {
  const receipt = durableReceipt();
  const snapshot = JSON.stringify(receipt);
  const projection = projectSupervisorReceipt(receipt);
  assert.equal(JSON.stringify(receipt), snapshot);
  assert.equal(Object.isFrozen(projection), true);
  assertSanitized(projectSupervisorReceipt(receipt), "receipt 重复投影");
});

/* ---------------------------- 4. 纯投影边界（无 IO/emit/fetch） ---------------------------- */

test("diagnostics 模块是纯投影：无 import、无 IO、无 emit/fetch/process 访问", () => {
  const source = readFileSync(fileURLToPath(new URL("../packages/pi-subagents-enhanced/src/subagent-dispatch/diagnostics.ts", import.meta.url)), "utf8");
  // 只扫描代码，不扫描中文注释（注释里会描述被禁止的能力）。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [
    "node:", "require(", "readFileSync", "writeFileSync", "openSync", "lstatSync", "fetch(",
    "process.", "Date.now", "performance.", ".emit(", "console.", "child_process", "Math.random",
    "setTimeout", "setInterval", "import(",
  ]) {
    assert.equal(code.includes(forbidden), false, `diagnostics.ts 不应包含 ${forbidden}`);
  }
  assert.equal(/(^|\n)\s*import\s/.test(code), false, "diagnostics.ts 不得有任何 import 语句");
  assert.equal(/(^|\n)\s*export\s+\*/.test(code), false, "diagnostics.ts 不得再导出聚合 export 面");
});

test("投影不接受 getter 注入的额外事实，且对 getter 抛错不敏感", () => {
  const withGetters = {
    get phase() { return "supervisor-replay-failed"; },
    get monotonicMs() { return 5; },
    get runId() { return "run-1"; },
  };
  const projection = projectSupervisorTrace(withGetters, ENVELOPE_CLOCK);
  assert.equal(projection.phase, "supervisor-replay-failed");
  assert.equal(projection.runId, "run-1");
  assertSanitized(projection, "getter 输入投影");

  const rpcFromGetters = {
    get version() { return 1; },
    get methods() { return ["ping", "spawn"]; },
    get session() { return { sessionId: "s-1", cwd: EXPECTED_CWD }; },
    get capabilities() { return { asyncSpawn: true, processTerminalProof: true, launchResolvedExtensions: true, runtimeAcknowledgedExtensions: true }; },
  };
  assert.deepEqual([...projectRpcNegotiation(rpcFromGetters, EXPECTED_CWD, "coding").missingCapabilities], []);
});
