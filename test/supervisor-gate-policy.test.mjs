/**
 * G1 supervisor 门禁纯策略合同测试（supervisor-gate-policy.ts）。
 *
 * 数据来源声明（重要）：本文件全部 fixture 都是按 public typed 形状手工构造的**策略输入**，
 * 用于正反例判定；它们不是 production provenance，不证明任何真实 pending / receipt / child 目录状态，
 * 也不代表任何真实 run 的历史。非法数据只用于验证策略 reject，不据此要求 production 增加兼容分支。
 *
 * 覆盖：
 * - resolveTargetChild：显式 index 精确（稀疏目录不判「不存在」、membership 交上游投递）、
 *   非法 index 拒绝、缺 index 不猜 0 / 不广播 / 固定歧义码、目录不可信 fail closed、complete 推断；
 * - classifyRequest：needs-reply / reply-submitted（queued ≠ consumed）/ consumed / cleared / terminal /
 *   scope-unverified 精确分类、TTL 显式 now、failed receipt 不解 gate 且可重试、跨 scope 旧 receipt 不污染、
 *   纯函数不改 request / receipts；
 * - gateBlocksChildSteer：不同 child 互不阻断、缺 correlation 不默认 0、不阻断所有 child；
 * - steerReceiptKey / replyPayloadGuardKey / participatesInIdempotency：幂等 key 与 reply 重复文本保护均 child-scoped。
 * - 模块静态边界：无 import、无 IO、不自取系统时钟。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  classifyRequest,
  gateBlocksChildSteer,
  participatesInIdempotency,
  replyPayloadGuardKey,
  resolveTargetChild,
  steerReceiptKey,
  SUPERVISOR_GATE_POLICY_VERSION,
  SUPERVISOR_REQUEST_SCOPE_UNVERIFIED,
  SUPERVISOR_REPLY_REQUIRED,
  SUPERVISOR_STEER_CHILD_AMBIGUOUS,
  SUPERVISOR_STEER_TARGET_INVALID,
  SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE,
  SUPERVISOR_INTENT_INVALID,
  SUPERVISOR_REQUEST_INVALID,
  SUPERVISOR_RECEIPT_INVALID,
  SUPERVISOR_CLASSIFICATION_TIME_INVALID,
  SUPERVISOR_ORPHAN_CLEARED,
} from '../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-gate-policy.ts';

/* ---------------------------- fixture 构造（public typed 形状） ---------------------------- */

const digest = (label) => `sha256:${createHash('sha256').update(label).digest('hex')}`;

const RUN_A = 'run-aaaa-1111';
const RUN_B = 'run-bbbb-2222';
const ROOT_1 = 'root-session-1';
const ROOT_2 = 'root-session-2';

/** 完整 correlation（parseSupervisorRequestV1 的 12 字段白名单形状）。 */
function makeCorrelation(childIndex, agent = 'worker') {
  return {
    asyncDir: '/tmp/canary-async-dir',
    pid: 4242,
    lifecycleSessionId: 'lifecycle-canary',
    processBirth: 'birth-canary',
    sessionFile: '/tmp/canary-session.jsonl',
    childSessionId: 'child-session-canary',
    toolCallId: 'toolcall-canary',
    agent,
    childIndex,
    reason: 'need_decision',
    requestBodyDigest: digest(`correlation-${childIndex}-${agent}`),
  };
}

function makeRequest(overrides = {}) {
  return {
    schemaVersion: 'supervisor-request.v1',
    requestId: 'req-1',
    runId: RUN_A,
    rootSessionId: ROOT_1,
    ownerGeneration: 3,
    requestGeneration: 1,
    requestDigest: digest('req-1'),
    createdAt: 1_000,
    expiresAt: 2_000,
    state: 'pending',
    correlation: makeCorrelation(0),
    ...overrides,
  };
}

function makeReceipt(overrides = {}) {
  return {
    receiptId: 'receipt-1',
    idempotencyKey: 'key-1',
    kind: 'reply',
    status: 'queued',
    consumed: false,
    runId: RUN_A,
    requestId: 'req-1',
    rootSessionId: ROOT_1,
    ownerGeneration: 3,
    requestGeneration: 1,
    ...overrides,
  };
}

/** 深度冻结：任何被策略改写的入参都会在严格模式下抛错，用于证明纯函数无副作用。 */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const directory = (children, overrides = {}) => ({
  availability: 'available',
  runId: RUN_A,
  ownerGeneration: 3,
  complete: false,
  children,
  ...overrides,
});

const child = (childIndex, overrides = {}) => ({ childIndex, agent: `worker-${childIndex}`, ...overrides });

const NOW = 1_500; // 位于 [createdAt, expiresAt) 区间内：未到期
const steerIntent = (overrides = {}) => ({
  schemaVersion: 'supervisor-control-intent.v2',
  intentId: 'intent-1',
  kind: 'steer',
  rootSessionId: ROOT_1,
  runId: RUN_A,
  ownerGeneration: 3,
  childIndex: 0,
  payloadDigest: digest('steer-payload'),
  liveRunEpoch: 7,
  ...overrides,
});

/* ---------------------------- 模块静态边界：无 IO / 无依赖 / 不自取时钟 ---------------------------- */

test('策略模块零依赖、无 IO、不自取系统时钟', () => {
  const source = readFileSync(
    new URL('../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-gate-policy.ts', import.meta.url),
    'utf8',
  );
  assert.ok(!/^\s*import\s/m.test(source), 'policy 不得 import 任何模块（避免 control-plane cycle）');
  assert.ok(!/\brequire\s*\(/.test(source), 'policy 不得 require');
  assert.ok(!/node:(fs|crypto|path|os)/.test(source), 'policy 不得触达文件系统/加密/路径模块');
  assert.ok(!/\bDate\s*\.\s*now\s*\(/.test(source), 'policy 不得自取时钟，now 必须由调用方显式传入');
  assert.ok(!/\bprocess\s*\./.test(source), 'policy 不得读 process/env');
  assert.ok(!/\bawait\b|\basync\s+function\b/.test(source), 'policy 必须全部是同步纯函数');
});

/* ---------------------------- resolveTargetChild ---------------------------- */

test('显式 index 命中目录：exact + directory-confirmed，保留已证 agent', () => {
  const dir = directory([child(0), child(2, { agent: 'reviewer', steerable: true })]);
  const result = resolveTargetChild(dir, 2);
  assert.equal(result.status, 'exact');
  assert.equal(result.membership, 'directory-confirmed');
  assert.equal(result.inferred, false);
  assert.deepEqual(result.target, { childIndex: 2, agent: 'reviewer', steerable: true });
});

test('显式 index 不在稀疏目录中：仍 exact，membership 交上游投递核（不判 child 不存在）', () => {
  // child B 从未发过 request，因此不在 durable correlation 目录里；父层裁决禁止据此判其不存在。
  const dir = directory([child(0)]);
  const result = resolveTargetChild(dir, 1);
  assert.equal(result.status, 'exact');
  assert.equal(result.membership, 'delegated-upstream');
  assert.deepEqual(result.target, { childIndex: 1, agent: undefined, steerable: undefined });
});

test('显式 index + 空目录 / 目录不可用：仍 exact（delegated-upstream），不猜 0、不拒绝', () => {
  const empty = resolveTargetChild(directory([]), 4);
  assert.equal(empty.status, 'exact');
  assert.equal(empty.membership, 'delegated-upstream');
  assert.equal(empty.target.childIndex, 4);

  const unavailable = resolveTargetChild({ availability: 'unavailable', code: SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE }, 9);
  assert.equal(unavailable.status, 'exact');
  assert.equal(unavailable.membership, 'delegated-upstream');
  assert.equal(unavailable.target.childIndex, 9);
});

test('index 0 合法且 -0 归一为 0', () => {
  const zero = resolveTargetChild(directory([child(0)]), 0);
  assert.equal(zero.status, 'exact');
  assert.equal(zero.target.childIndex, 0);

  const negativeZero = resolveTargetChild(directory([child(0)]), -0);
  assert.equal(negativeZero.status, 'exact');
  assert.equal(negativeZero.target.childIndex, 0);
  assert.ok(Object.is(negativeZero.target.childIndex, 0), '-0 必须归一为 0，避免 key 段出现 -0');
});

test('非法 index 一律 SUPERVISOR_STEER_TARGET_INVALID', () => {
  const dir = directory([child(0), child(1)]);
  for (const invalid of [-1, -7, 1.5, NaN, Infinity, -Infinity, '1', '0', true, false, {}, [], Symbol('x'), 2 ** 53, Number.MAX_SAFE_INTEGER + 2]) {
    const result = resolveTargetChild(dir, invalid);
    assert.equal(result.status, 'blocked', `index=${String(invalid)} 应被拒绝`);
    assert.equal(result.code, SUPERVISOR_STEER_TARGET_INVALID, `index=${String(invalid)} code 错误`);
  }
});

test('缺 index：稀疏目录即使只有一个 child 也固定 ambiguous（不猜 0、不广播、不推断）', () => {
  const single = resolveTargetChild(directory([child(3)]), undefined);
  assert.equal(single.status, 'blocked');
  assert.equal(single.code, SUPERVISOR_STEER_CHILD_AMBIGUOUS);
  // 与 runId 前缀歧义 code 严格分离
  assert.notEqual(single.code, 'SUPERVISOR_STEER_TARGET_AMBIGUOUS');

  const multi = resolveTargetChild(directory([child(0), child(1)]), undefined);
  assert.equal(multi.status, 'blocked');
  assert.equal(multi.code, SUPERVISOR_STEER_CHILD_AMBIGUOUS);

  const empty = resolveTargetChild(directory([]), undefined);
  assert.equal(empty.status, 'blocked');
  assert.equal(empty.code, SUPERVISOR_STEER_CHILD_AMBIGUOUS);

  // null 与 undefined 同义：都不得当成 index 0
  const nulled = resolveTargetChild(directory([child(0)]), null);
  assert.equal(nulled.status, 'blocked');
  assert.equal(nulled.code, SUPERVISOR_STEER_CHILD_AMBIGUOUS);

  // complete:true 但可 steer child 不唯一/不可证 → 仍 ambiguous
  const twoSteerable = resolveTargetChild(directory([child(0, { steerable: true }), child(1, { steerable: true })], { complete: true }), undefined);
  assert.equal(twoSteerable.code, SUPERVISOR_STEER_CHILD_AMBIGUOUS);
  const unknownSteerable = resolveTargetChild(directory([child(0)], { complete: true }), undefined);
  assert.equal(unknownSteerable.code, SUPERVISOR_STEER_CHILD_AMBIGUOUS);
  const notSteerable = resolveTargetChild(directory([child(0, { steerable: false })], { complete: true }), undefined);
  assert.equal(notSteerable.code, SUPERVISOR_STEER_CHILD_AMBIGUOUS);
});

test('缺 index + 目录不可用/不可信：SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE', () => {
  const unavailable = resolveTargetChild({ availability: 'unavailable', code: SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE }, undefined);
  assert.deepEqual(unavailable, { status: 'blocked', code: SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE });

  const malformed = [
    undefined,
    null,
    'directory',
    [],
    {},
    { availability: 'unknown', runId: RUN_A, children: [] },
    { availability: 'available', children: [] },                                  // 缺 runId
    { availability: 'available', runId: RUN_A, ownerGeneration: 0, children: [] }, // ownerGeneration 非法
    { availability: 'available', runId: RUN_A, children: 'nope' },                 // children 非数组
    { availability: 'available', runId: RUN_A, children: [null] },                 // 条目非对象
    { availability: 'available', runId: RUN_A, children: [{ agent: 'w' }] },        // 缺 childIndex
    { availability: 'available', runId: RUN_A, children: [{ childIndex: -1 }] },    // childIndex 非法
    { availability: 'available', runId: RUN_A, children: [{ childIndex: 1.5 }] },
    { availability: 'available', runId: RUN_A, children: [child(0), child(0)] },   // 同 index 重复 → 目录自相矛盾
  ];
  for (const dir of malformed) {
    const result = resolveTargetChild(dir, undefined);
    assert.equal(result.status, 'blocked', `目录 ${JSON.stringify(dir) ?? String(dir)} 应 fail closed`);
    assert.equal(result.code, SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE);
  }
});

test('complete:true 且恰好一个可证 steerable child 时才允许推断', () => {
  const inferred = resolveTargetChild(directory([child(5, { steerable: true, agent: 'sole' })], { complete: true }), undefined);
  assert.equal(inferred.status, 'exact');
  assert.equal(inferred.inferred, true);
  assert.equal(inferred.membership, 'directory-confirmed');
  assert.equal(inferred.target.childIndex, 5);
  assert.equal(inferred.target.agent, 'sole');
});

test('resolveTargetChild 不改目录、不泄漏内部引用', () => {
  const dir = deepFreeze(directory([child(0, { steerable: true }), child(1)]));
  const before = JSON.stringify(dir);
  const confirmed = resolveTargetChild(dir, 0);
  const inferred = resolveTargetChild(dir, undefined);
  assert.equal(JSON.stringify(dir), before, '目录不得被改写');
  assert.notEqual(confirmed.target, dir.children[0], '不得把目录内部对象直接交给调用方');
  assert.equal(inferred.status, 'blocked');
});

/* ---------------------------- classifyRequest：基本分类 ---------------------------- */

test('pending 且无 receipt → needs-reply，阻断已证归属 child', () => {
  const request = deepFreeze(makeRequest());
  const result = classifyRequest(request, [], NOW);
  assert.equal(result.status, 'classified');
  assert.equal(result.policyVersion, SUPERVISOR_GATE_POLICY_VERSION);
  assert.equal(result.classification, 'needs-reply');
  assert.equal(result.blockingCode, SUPERVISOR_REPLY_REQUIRED);
  assert.equal(result.state, 'pending');
  assert.deepEqual(result.scope, { status: 'verified', childIndex: 0, agent: 'worker' });
  assert.equal(result.expired, false);
  assert.equal(result.expiredByTime, false);
  assert.deepEqual(result.reply, { matched: false, receiptId: undefined, queued: false, consumed: false, failed: false, retryable: true });
  assert.equal(result.unmatchedReceipts, 0);
  assert.ok(Object.isFrozen(result));
});

test('pending + queued reply receipt → reply-submitted（允许新 steer，queued 不等于 consumed，不消费）', () => {
  const receipts = deepFreeze([makeReceipt({ status: 'queued', consumed: false })]);
  const before = JSON.stringify(receipts);
  const result = classifyRequest(makeRequest(), receipts, NOW);
  assert.equal(result.classification, 'reply-submitted');
  assert.equal(result.blockingCode, undefined);
  assert.equal(result.reply.queued, true);
  assert.equal(result.reply.consumed, false, 'queued 不得被当成 consumed');
  assert.equal(result.reply.retryable, false);
  assert.equal(gateBlocksChildSteer(result, 0), false, 'reply-submitted 不阻断同 child 的新 steer');
  assert.equal(JSON.stringify(receipts), before, 'receipt 不得被改写（consumed 保持 false）');
  assert.equal(receipts[0].consumed, false);
  assert.equal(receipts[0].status, 'queued');
});

test('queued receipt 缺 consumed 字段不构成「已提交」事实 → 仍 needs-reply', () => {
  const result = classifyRequest(makeRequest(), [makeReceipt({ consumed: undefined })], NOW);
  assert.equal(result.classification, 'needs-reply');
  assert.equal(result.reply.matched, false);
});

test('pending + delivered/consumed 事实 → consumed', () => {
  const delivered = classifyRequest(makeRequest(), [makeReceipt({ status: 'delivered', consumed: true })], NOW);
  assert.equal(delivered.classification, 'consumed');
  assert.equal(delivered.reply.consumed, true);
  assert.equal(delivered.blockingCode, undefined);

  // state 滞后（仍 pending）但消费事实存在：以事实为准，不复活 needs-reply
  const lagging = classifyRequest(makeRequest({ state: 'pending' }), [makeReceipt({ status: 'queued', consumed: true })], NOW);
  assert.equal(lagging.classification, 'consumed');
});

test('pending + failed receipt → 仍 needs-reply（failed 不解 gate）且允许显式重试', () => {
  const failed = makeReceipt({ status: 'failed', consumed: false, code: 'SUPERVISOR_REPLY_DELIVERY_FAILED' });
  const result = classifyRequest(makeRequest(), [failed], NOW);
  assert.equal(result.classification, 'needs-reply');
  assert.equal(result.blockingCode, SUPERVISOR_REPLY_REQUIRED);
  assert.equal(result.reply.failed, true);
  assert.equal(result.reply.queued, false);
  assert.equal(result.reply.retryable, true, 'failed receipt 后同目标显式重试必须可行');
  assert.equal(gateBlocksChildSteer(result, 0), true);
  assert.equal(participatesInIdempotency(failed), false, 'failed receipt 不参与幂等短路');
  assert.equal(participatesInIdempotency(makeReceipt({ status: 'queued', consumed: false })), true);
  assert.equal(participatesInIdempotency(makeReceipt({ status: 'delivered', consumed: true })), true);
  assert.equal(participatesInIdempotency(makeReceipt({ status: 'weird' })), false);
  assert.equal(participatesInIdempotency(null), false);
});

test('replying（回复 in-flight，事实尚未 commit）→ needs-reply，state 原样回显', () => {
  const result = classifyRequest(makeRequest({ state: 'replying' }), [], NOW);
  assert.equal(result.classification, 'needs-reply');
  assert.equal(result.state, 'replying');
});

test('replied/expired/failed → terminal；failed + administrativeResolution → cleared', () => {
  const replied = classifyRequest(makeRequest({ state: 'replied' }), [], NOW);
  assert.equal(replied.classification, 'terminal');
  assert.equal(replied.terminalReason, 'replied');
  assert.equal(gateBlocksChildSteer(replied, 0), false);

  const repliedConsumed = classifyRequest(makeRequest({ state: 'replied' }), [makeReceipt({ status: 'delivered', consumed: true })], NOW);
  assert.equal(repliedConsumed.classification, 'consumed');

  const expiredState = classifyRequest(makeRequest({ state: 'expired' }), [], NOW);
  assert.equal(expiredState.classification, 'terminal');
  assert.equal(expiredState.terminalReason, 'expired');

  const failedState = classifyRequest(makeRequest({ state: 'failed' }), [], NOW);
  assert.equal(failedState.classification, 'terminal');
  assert.equal(failedState.terminalReason, 'failed');
  assert.equal(failedState.administrativeCode, undefined);

  const cleared = classifyRequest(
    makeRequest({ state: 'failed', administrativeResolution: { code: SUPERVISOR_ORPHAN_CLEARED, clearedAt: 1_800, previousState: 'pending', auditId: 'audit-1', reason: 'orphan', clearerRootSessionId: ROOT_1 } }),
    [],
    NOW,
  );
  assert.equal(cleared.classification, 'cleared');
  assert.equal(cleared.terminalReason, 'administratively-cleared');
  assert.equal(cleared.administrativeCode, SUPERVISOR_ORPHAN_CLEARED);
  assert.equal(gateBlocksChildSteer(cleared, 0), false);
});

test('cleared 不因遗留 queued receipt 被复活成 consumed/reply-submitted，且 receipt 不被升级', () => {
  const receipts = deepFreeze([makeReceipt({ status: 'queued', consumed: false })]);
  const before = JSON.stringify(receipts);
  const result = classifyRequest(
    makeRequest({ state: 'failed', administrativeResolution: { code: SUPERVISOR_ORPHAN_CLEARED, clearedAt: 1_800 } }),
    receipts,
    NOW,
  );
  assert.equal(result.classification, 'cleared');
  assert.equal(result.reply.consumed, false);
  assert.equal(JSON.stringify(receipts), before, 'queued receipt 不得被静默升级为 delivered/consumed');
});

test('administrativeResolution 不完整（缺 code / 缺 clearedAt / 非对象）→ 按普通 failed terminal', () => {
  for (const resolution of [{ clearedAt: 1 }, { code: SUPERVISOR_ORPHAN_CLEARED }, 'cleared', null, 42]) {
    const result = classifyRequest(makeRequest({ state: 'failed', administrativeResolution: resolution }), [], NOW);
    assert.equal(result.classification, 'terminal', `resolution=${JSON.stringify(resolution)}`);
    assert.equal(result.terminalReason, 'failed');
  }
});

/* ---------------------------- classifyRequest：TTL 显式 now ---------------------------- */

test('TTL 由显式 now 决定：到期前 needs-reply，到期及之后 terminal(expired)', () => {
  const request = makeRequest({ createdAt: 1_000, expiresAt: 2_000 });
  assert.equal(classifyRequest(request, [], 1_999).classification, 'needs-reply');

  const atBoundary = classifyRequest(request, [], 2_000);
  assert.equal(atBoundary.classification, 'terminal', '与既有 loadRoot/resolveSupervisorControl 一致：now >= expiresAt 即到期');
  assert.equal(atBoundary.terminalReason, 'expired');
  assert.equal(atBoundary.expired, true);
  assert.equal(atBoundary.expiredByTime, true);
  assert.equal(atBoundary.blockingCode, undefined);
  assert.equal(gateBlocksChildSteer(atBoundary, 0), false);

  const after = classifyRequest(request, [], 5_000);
  assert.equal(after.classification, 'terminal');
  assert.equal(after.expiredByTime, true);
});

test('内存模式过期 pending 不得继续 needs-reply，且分类不改写 request.state', () => {
  const request = deepFreeze(makeRequest({ createdAt: 1_000, expiresAt: 2_000, state: 'pending' }));
  const result = classifyRequest(request, [], 9_999);
  assert.equal(result.classification, 'terminal');
  assert.equal(result.state, 'pending', 'state 写回只属于既有持久化事务，纯函数不得副作用修改');
  assert.equal(request.state, 'pending');
});

test('now 缺失/非法 → rejected(SUPERVISOR_CLASSIFICATION_TIME_INVALID)', () => {
  const request = makeRequest();
  for (const now of [undefined, null, NaN, Infinity, -Infinity, '1500', {}, []]) {
    const result = classifyRequest(request, [], now);
    assert.equal(result.status, 'rejected', `now=${String(now)}`);
    assert.equal(result.code, SUPERVISOR_CLASSIFICATION_TIME_INVALID);
    assert.equal(gateBlocksChildSteer(result, 0), false);
  }
});

test('终局 state 的分类不随 now 漂移（TTL 只作用于待回复状态）', () => {
  const replied = makeRequest({ state: 'replied', createdAt: 1_000, expiresAt: 2_000 });
  assert.equal(classifyRequest(replied, [], 1_500).classification, 'terminal');
  assert.equal(classifyRequest(replied, [], 99_999).classification, 'terminal');
  assert.equal(classifyRequest(replied, [], 99_999).terminalReason, 'replied');
});

/* ---------------------------- classifyRequest：child 归属与隔离 ---------------------------- */

test('缺 correlation 的 pending → scope-unverified，不默认 0、不阻断任何 child', () => {
  for (const correlation of [undefined, null, {}, { agent: 'worker' }, { childIndex: -1 }, { childIndex: 1.5 }, { childIndex: '0' }, 'nope']) {
    const result = classifyRequest(makeRequest({ correlation }), [], NOW);
    assert.equal(result.status, 'classified', `correlation=${JSON.stringify(correlation)}`);
    assert.equal(result.classification, 'scope-unverified');
    assert.equal(result.blockingCode, SUPERVISOR_REQUEST_SCOPE_UNVERIFIED);
    assert.deepEqual(result.scope, { status: 'unverified', code: SUPERVISOR_REQUEST_SCOPE_UNVERIFIED });
    assert.equal(gateBlocksChildSteer(result, 0), false, '不得默认归属 child 0');
    assert.equal(gateBlocksChildSteer(result, 1), false, '不得阻断所有 child');
  }
});

test('缺 correlation 时：consumed 事实优先，queued 仍单列 scope-unverified（不默认 0）', () => {
  const consumed = classifyRequest(makeRequest({ correlation: undefined }), [makeReceipt({ status: 'delivered', consumed: true })], NOW);
  assert.equal(consumed.classification, 'consumed');
  assert.equal(gateBlocksChildSteer(consumed, 0), false);

  // 只有 queued（尚未消费）时，归属仍不可证：保留 scope-unverified 与 inspect 上报，不当成已解决。
  const submitted = classifyRequest(makeRequest({ correlation: undefined }), [makeReceipt()], NOW);
  assert.equal(submitted.classification, 'scope-unverified');
  assert.equal(submitted.blockingCode, SUPERVISOR_REQUEST_SCOPE_UNVERIFIED);
  assert.equal(submitted.reply.queued, true);
  assert.equal(gateBlocksChildSteer(submitted, 0), false);
  assert.equal(gateBlocksChildSteer(submitted, 1), false);
});

test('不同 child 互不阻断：child0 needs-reply 不影响 child1 的 steer', () => {
  const requestChild0 = makeRequest({ requestId: 'req-a', correlation: makeCorrelation(0, 'worker-a') });
  const requestChild1 = makeRequest({ requestId: 'req-b', correlation: makeCorrelation(1, 'worker-b') });
  const receiptsChild1 = [makeReceipt({ receiptId: 'receipt-b', requestId: 'req-b', status: 'queued', consumed: false })];

  const a = classifyRequest(requestChild0, receiptsChild1, NOW);
  const b = classifyRequest(requestChild1, receiptsChild1, NOW);

  assert.equal(a.classification, 'needs-reply');
  assert.equal(gateBlocksChildSteer(a, 0), true);
  assert.equal(gateBlocksChildSteer(a, 1), false, 'A 的待回复事实不得阻断 child1');
  assert.equal(a.unmatchedReceipts, 1);

  assert.equal(b.classification, 'reply-submitted');
  assert.equal(gateBlocksChildSteer(b, 1), false);
  assert.equal(gateBlocksChildSteer(b, 0), false);
  assert.equal(b.unmatchedReceipts, 0);
});

test('gateBlocksChildSteer 只对合法目标 index 回答，非法 index 不阻断也不猜', () => {
  const result = classifyRequest(makeRequest(), [], NOW);
  assert.equal(gateBlocksChildSteer(result, 0), true);
  for (const target of [undefined, null, -1, 1.5, '0', NaN, {}]) {
    assert.equal(gateBlocksChildSteer(result, target), false, `target=${String(target)}`);
  }
  assert.equal(gateBlocksChildSteer({ status: 'rejected', code: SUPERVISOR_REQUEST_INVALID }, 0), false);
  assert.equal(gateBlocksChildSteer(undefined, 0), false);
});

/* ---------------------------- classifyRequest：精确匹配（跨 scope 不污染） ---------------------------- */

test('跨 root/run/ownergen/requestId/requestGeneration/digest 的旧 receipt 不解除 gate', () => {
  const request = makeRequest();
  const polluted = [
    makeReceipt({ rootSessionId: ROOT_2 }),
    makeReceipt({ runId: RUN_B }),
    makeReceipt({ ownerGeneration: 2 }),
    makeReceipt({ ownerGeneration: 4 }),
    makeReceipt({ requestId: 'req-old' }),
    makeReceipt({ requestGeneration: 2 }),
    makeReceipt({ requestDigest: digest('another-request') }),
    makeReceipt({ rootSessionId: undefined }),
    makeReceipt({ ownerGeneration: undefined }),
    makeReceipt({ requestGeneration: undefined }),
    makeReceipt({ requestId: undefined }),
    makeReceipt({ kind: 'steer' }),
    makeReceipt({ childIndex: 1 }),                 // v2 receipt 指向别的 child
    makeReceipt({ childIndex: '0' }),               // childIndex 非法
  ];
  const result = classifyRequest(request, polluted, NOW);
  assert.equal(result.classification, 'needs-reply');
  assert.equal(result.blockingCode, SUPERVISOR_REPLY_REQUIRED);
  assert.equal(result.reply.matched, false);
  assert.equal(result.unmatchedReceipts, polluted.length);
  assert.equal(gateBlocksChildSteer(result, 0), true);

  // 身份精确匹配但 status 不可枚举：不构成任何 reply 事实，仍 needs-reply（计入匹配但不计 unmatched）。
  const unknownStatus = classifyRequest(request, [makeReceipt({ status: 'unknown-state' })], NOW);
  assert.equal(unknownStatus.classification, 'needs-reply');
  assert.equal(unknownStatus.reply.matched, false);
  assert.equal(unknownStatus.unmatchedReceipts, 0);
});

test('同 child 的 v2 receipt（带 childIndex/requestDigest）精确匹配才生效', () => {
  const request = makeRequest({ requestDigest: digest('req-1') });
  const matching = classifyRequest(request, [makeReceipt({ childIndex: 0, requestDigest: digest('req-1') })], NOW);
  assert.equal(matching.classification, 'reply-submitted');
  assert.equal(matching.unmatchedReceipts, 0);
});

test('多 receipt 并存时取最强事实（consumed > queued > failed），失败不覆盖成功', () => {
  const receipts = [
    makeReceipt({ receiptId: 'r-failed', status: 'failed', consumed: false }),
    makeReceipt({ receiptId: 'r-queued', status: 'queued', consumed: false }),
  ];
  const queuedWins = classifyRequest(makeRequest(), receipts, NOW);
  assert.equal(queuedWins.classification, 'reply-submitted');
  assert.equal(queuedWins.reply.receiptId, 'r-queued');
  assert.equal(queuedWins.reply.failed, false);

  const consumedWins = classifyRequest(makeRequest(), [...receipts, makeReceipt({ receiptId: 'r-consumed', status: 'delivered', consumed: true })], NOW);
  assert.equal(consumedWins.classification, 'consumed');
  assert.equal(consumedWins.reply.receiptId, 'r-consumed');
});

test('steer receipt 不参与 reply 事实判定（即使 idempotencyKey/requestId 相同）', () => {
  const result = classifyRequest(makeRequest(), [makeReceipt({ kind: 'steer', status: 'delivered', consumed: true })], NOW);
  assert.equal(result.classification, 'needs-reply');
  assert.equal(result.unmatchedReceipts, 1);
});

/* ---------------------------- classifyRequest：非法输入只验证 reject ---------------------------- */

test('request 形状非法 → rejected(SUPERVISOR_REQUEST_INVALID)，不新增兼容分支', () => {
  const invalidRequests = [
    undefined, null, 'request', 42, [],
    makeRequest({ requestId: undefined }),
    makeRequest({ requestId: '' }),
    makeRequest({ runId: undefined }),
    makeRequest({ rootSessionId: undefined }),
    makeRequest({ ownerGeneration: 0 }),
    makeRequest({ ownerGeneration: 1.5 }),
    makeRequest({ ownerGeneration: '3' }),
    makeRequest({ requestGeneration: -1 }),
    makeRequest({ requestDigest: 'not-a-digest' }),
    makeRequest({ requestDigest: undefined }),
    makeRequest({ createdAt: undefined }),
    makeRequest({ expiresAt: NaN }),
    makeRequest({ createdAt: 3_000, expiresAt: 2_000 }), // 到期早于创建：倒退时间
    makeRequest({ state: 'unknown' }),
    makeRequest({ state: undefined }),
    makeRequest({ state: 'PENDING' }),
  ];
  for (const request of invalidRequests) {
    const result = classifyRequest(request, [], NOW);
    assert.equal(result.status, 'rejected', `request=${JSON.stringify(request) ?? String(request)}`);
    assert.equal(result.code, SUPERVISOR_REQUEST_INVALID);
    assert.equal(result.policyVersion, SUPERVISOR_GATE_POLICY_VERSION);
  }
});

test('receipts 参数非法 → rejected(SUPERVISOR_RECEIPT_INVALID)', () => {
  const request = makeRequest();
  for (const receipts of [undefined, null, 'nope', 42, {}, [null], ['receipt'], [42], [makeReceipt(), undefined]]) {
    const result = classifyRequest(request, receipts, NOW);
    assert.equal(result.status, 'rejected', `receipts=${JSON.stringify(receipts) ?? String(receipts)}`);
    assert.equal(result.code, SUPERVISOR_RECEIPT_INVALID);
  }
});

test('classifyRequest 不改写任何入参（深冻结入参不抛错且内容不变）', () => {
  const request = deepFreeze(makeRequest());
  const receipts = deepFreeze([makeReceipt({ status: 'failed', consumed: false }), makeReceipt({ receiptId: 'r-2', kind: 'steer' })]);
  const requestBefore = JSON.stringify(request);
  const receiptsBefore = JSON.stringify(receipts);
  const result = classifyRequest(request, receipts, NOW);
  assert.equal(result.status, 'classified');
  assert.equal(JSON.stringify(request), requestBefore);
  assert.equal(JSON.stringify(receipts), receiptsBefore);
  assert.equal(request.state, 'pending');
  assert.equal(receipts[0].status, 'failed');
  assert.ok(Object.isFrozen(result.reply));
  assert.ok(Object.isFrozen(result.scope));
});

/* ---------------------------- steerReceiptKey：child-scoped 幂等 ---------------------------- */

test('steerReceiptKey 含 childIndex，同 payload 发不同 child 不互相误判幂等', () => {
  const child0 = steerReceiptKey(steerIntent({ childIndex: 0 }));
  const child1 = steerReceiptKey(steerIntent({ childIndex: 1 }));
  assert.equal(child0.status, 'ok');
  assert.equal(child1.status, 'ok');
  assert.equal(child0.childIndex, 0);
  assert.equal(child1.childIndex, 1);
  assert.notEqual(child0.key, child1.key);
  assert.ok(child0.key.includes('child:0'), child0.key);
  assert.ok(child1.key.includes('child:1'), child1.key);
  // 稳定性：同参数重复计算必须同 key
  assert.equal(child0.key, steerReceiptKey(steerIntent({ childIndex: 0 })).key);
});

test('steerReceiptKey 区分 payload / epoch / root / run / ownerGeneration，epoch 缺失写显式 none 段', () => {
  const base = steerReceiptKey(steerIntent()).key;
  assert.notEqual(base, steerReceiptKey(steerIntent({ payloadDigest: digest('other') })).key);
  assert.notEqual(base, steerReceiptKey(steerIntent({ liveRunEpoch: 8 })).key);
  assert.notEqual(base, steerReceiptKey(steerIntent({ rootSessionId: ROOT_2 })).key);
  assert.notEqual(base, steerReceiptKey(steerIntent({ runId: RUN_B })).key);
  assert.notEqual(base, steerReceiptKey(steerIntent({ ownerGeneration: 4 })).key);

  const noEpoch = steerReceiptKey(steerIntent({ liveRunEpoch: undefined }));
  assert.equal(noEpoch.status, 'ok');
  assert.ok(noEpoch.key.endsWith(':epoch:none'), noEpoch.key);
  assert.ok(!noEpoch.key.includes('undefined'), '不得出现字面量 undefined 尾段');
  assert.equal(noEpoch.key, steerReceiptKey(steerIntent({ liveRunEpoch: null })).key, 'undefined/null 同义');
  assert.notEqual(noEpoch.key, base);
});

test('steerReceiptKey 缺 childIndex → ambiguous；非法 childIndex → target invalid；其余非法 → intent invalid', () => {
  const missing = steerReceiptKey(steerIntent({ childIndex: undefined }));
  assert.deepEqual(missing, { status: 'blocked', code: SUPERVISOR_STEER_CHILD_AMBIGUOUS });
  assert.deepEqual(steerReceiptKey(steerIntent({ childIndex: null })), { status: 'blocked', code: SUPERVISOR_STEER_CHILD_AMBIGUOUS });

  for (const invalid of [-1, 1.5, NaN, '0', true, {}]) {
    assert.deepEqual(steerReceiptKey(steerIntent({ childIndex: invalid })), { status: 'blocked', code: SUPERVISOR_STEER_TARGET_INVALID }, `childIndex=${String(invalid)}`);
  }

  assert.deepEqual(steerReceiptKey(steerIntent({ payloadDigest: 'nope' })), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  assert.deepEqual(steerReceiptKey(steerIntent({ rootSessionId: '' })), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  assert.deepEqual(steerReceiptKey(steerIntent({ runId: undefined })), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  assert.deepEqual(steerReceiptKey(steerIntent({ ownerGeneration: 0 })), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  assert.deepEqual(steerReceiptKey(steerIntent({ liveRunEpoch: 1.5 })), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  assert.deepEqual(steerReceiptKey(steerIntent({ liveRunEpoch: '7' })), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  assert.deepEqual(steerReceiptKey(steerIntent({ kind: 'reply', requestId: 'req-1', requestGeneration: 1 })), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  for (const intent of [undefined, null, 'intent', 42, []]) {
    assert.deepEqual(steerReceiptKey(intent), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  }
});

test('replyPayloadGuardKey 也 child-scoped：一个 child 的 reply 正文不替另一个 child 制造重复判定', () => {
  const scope = { rootSessionId: ROOT_1, runId: RUN_A, ownerGeneration: 3, childIndex: 0, payloadDigest: digest('same-text') };
  const guard0 = replyPayloadGuardKey(scope);
  const guard1 = replyPayloadGuardKey({ ...scope, childIndex: 1 });
  assert.equal(guard0.status, 'ok');
  assert.equal(guard1.status, 'ok');
  assert.notEqual(guard0.key, guard1.key);
  assert.equal(guard0.key, replyPayloadGuardKey({ ...scope }).key, '同 scope 稳定');
  assert.notEqual(guard0.key, steerReceiptKey(steerIntent({ childIndex: 0, payloadDigest: digest('same-text') })).key, 'guard 与 receipt 命名空间不得碰撞');
});

test('replyPayloadGuardKey 缺可信 child 关联 → SUPERVISOR_REQUEST_SCOPE_UNVERIFIED（不默认 0）', () => {
  const scope = { rootSessionId: ROOT_1, runId: RUN_A, ownerGeneration: 3, payloadDigest: digest('same-text') };
  assert.deepEqual(replyPayloadGuardKey(scope), { status: 'blocked', code: SUPERVISOR_REQUEST_SCOPE_UNVERIFIED });
  assert.deepEqual(replyPayloadGuardKey({ ...scope, childIndex: null }), { status: 'blocked', code: SUPERVISOR_REQUEST_SCOPE_UNVERIFIED });
  assert.deepEqual(replyPayloadGuardKey({ ...scope, childIndex: -1 }), { status: 'blocked', code: SUPERVISOR_STEER_TARGET_INVALID });
  assert.deepEqual(replyPayloadGuardKey({ ...scope, childIndex: 2, payloadDigest: 'bad' }), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  for (const scope2 of [undefined, null, 42, []]) {
    assert.deepEqual(replyPayloadGuardKey(scope2), { status: 'blocked', code: SUPERVISOR_INTENT_INVALID });
  }
});

test('key 函数不修改入参', () => {
  const intent = deepFreeze(steerIntent());
  const before = JSON.stringify(intent);
  assert.equal(steerReceiptKey(intent).status, 'ok');
  assert.equal(replyPayloadGuardKey(intent).status, 'ok');
  assert.equal(JSON.stringify(intent), before);
});
