/**
 * D2 supervisor 只读诊断合同测试：readDiagnostics 有界只读安全副本。
 * 覆盖：available/unavailable 区分（confirmed 空 ≠ 读取异常）、requests/receipts 白名单投影、
 * 跨 root 隔离、50 条上限与 complete、requestId 过滤只收窄、持久化 state 字节/mtime 不变、
 * TTL 后读取不触发过期改写（对照事务路径才收敛 expired）、损坏 state fail closed、
 * 非法 root/filter fail closed、无 correlation/requestDigest/idempotencyKey/正文/路径泄漏。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSupervisorControlPlane, supervisorCanonicalDigest } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts';

/* ---------------------------- canary 与投影形状断言 ---------------------------- */

const CANARY_BODY = 'TASK-BODY-CANARY-never-project-me';
const CANARY_PATH = '/Users/canary/.pi/sessions/child-session-canary.jsonl';
const CANARY_DIGEST = `sha256:${'c'.repeat(64)}`;
const CANARIES = [CANARY_BODY, CANARY_PATH, CANARY_DIGEST];
/** request 投影行的精确白名单键集（计划 D2 字段）。 */
const REQUEST_KEYS = ['createdAt', 'expiresAt', 'ownerGeneration', 'requestGeneration', 'requestId', 'runId', 'state'];
/** receipt 投影允许的 D0 白名单键集（requestId/requestGeneration/ownerGeneration 可选）。 */
const RECEIPT_KEYS = ['consumed', 'ownerGeneration', 'receiptId', 'requestGeneration', 'requestId', 'runId', 'schemaVersion', 'status'];

/** 顶层键集精确匹配 + canary 不泄漏 + 每行白名单键集校验。 */
function assertDiagnosticsShape(value, availability) {
  const expected = availability === 'available'
    ? ['availability', 'complete', 'receipts', 'requests', 'schemaVersion']
    : ['availability', 'code', 'complete', 'receipts', 'requests', 'schemaVersion'];
  assert.deepEqual(Object.keys(value).sort(), expected, `顶层键集必须精确（${availability}）`);
  assert.equal(value.availability, availability);
  assert.equal(value.schemaVersion, 'supervisor-diagnostics.v1');
  const text = JSON.stringify(value) ?? '';
  for (const canary of CANARIES) assert.ok(!text.includes(canary), `诊断投影泄漏 canary：${canary.slice(0, 40)}`);
  for (const request of value.requests) {
    assert.deepEqual(Object.keys(request).sort(), REQUEST_KEYS, 'request 投影必须是精确白名单字段');
    assert.equal('correlation' in request, false, 'request 投影不得含 correlation');
    assert.equal('requestDigest' in request, false, 'request 投影不得含 requestDigest');
  }
  for (const receipt of value.receipts) {
    assert.ok(Object.keys(receipt).every(key => RECEIPT_KEYS.includes(key)), 'receipt 投影必须限定 D0 白名单字段');
    for (const forbidden of ['idempotencyKey', 'code', 'kind', 'rootSessionId', 'requestDigest']) {
      assert.equal(forbidden in receipt, false, `receipt 投影不得含 ${forbidden}`);
    }
  }
}

const stateFileOf = (persistenceRoot, root) => join(persistenceRoot, `supervisor-${createHash('sha256').update(root).digest('hex')}.json`);

/* ---------------------------- 1. 无持久化模式：内存 Map 的只读安全副本 ---------------------------- */

test('无持久化模式从既有Map生成只读安全副本：白名单投影、跨root隔离、queued不等于consumed、过滤只收窄', async () => {
  const plane = createSupervisorControlPlane({
    readOwnerReceipt: async runId => ({ runId, rootSessionId: runId === 'run-b' ? 'root-b' : 'root-a', ownerGeneration: 1 }),
    readRuntime: async runId => ({ runId, ownerGeneration: 1, running: false, steerable: false }),
  });
  const registeredZ = await plane.registerSupervisorRequest({
    id: 'z-ask', runId: 'run-a', agent: 'executor', reason: 'need_decision', expectsReply: true,
    correlation: { asyncDir: CANARY_PATH, pid: 7, lifecycleSessionId: 'lifecycle-canary', processBirth: '7:1.5', sessionFile: CANARY_PATH, childSessionId: 'child-canary', toolCallId: 'tool-canary', agent: 'executor', childIndex: 0, reason: 'need_decision', requestBodyDigest: CANARY_DIGEST },
  }, 'root-a');
  assert.equal(registeredZ.status, 'registered');
  await plane.registerSupervisorRequest({ id: 'a-ask', runId: 'run-a', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-a');
  await plane.registerSupervisorRequest({ id: 'c-ask', runId: 'run-a', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-a');
  await plane.registerSupervisorRequest({ id: 'd-ask', runId: 'run-a', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-a');
  await plane.registerSupervisorRequest({ id: 'b-ask', runId: 'run-b', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-b');
  const intent = (requestId, payload) => ({ schemaVersion: 'supervisor-control-intent.v1', intentId: `intent-${requestId}`, rootSessionId: 'root-a', runId: 'run-a', ownerGeneration: 1, kind: 'reply', requestId, requestGeneration: 1, payloadDigest: supervisorCanonicalDigest(payload) });
  const queued = await plane.commitDelivery({ intent: intent('a-ask', 'reply-a') }, 'root-a');
  assert.equal(queued.status, 'committed');
  assert.equal(queued.receipt.status, 'queued');
  await plane.commitDelivery({ intent: intent('c-ask', 'reply-c') }, 'root-a');
  const observed = await plane.observeReplyConsumption({ runId: 'run-a', requestId: 'c-ask', payloadDigest: supervisorCanonicalDigest('reply-c') }, 'root-a');
  assert.equal(observed.status, 'committed');
  assert.equal(observed.receipt.consumed, true);
  await plane.commitDelivery({ intent: intent('d-ask', 'reply-d'), success: false, code: 'NATIVE_DELIVERY_FAILED' }, 'root-a');

  const memoryBefore = JSON.stringify(plane.snapshot());
  const diag = await plane.readDiagnostics('root-a');
  assertDiagnosticsShape(diag, 'available');
  assert.equal(diag.complete, true);
  // 本 root 过滤 + requestId 升序
  assert.deepEqual(diag.requests.map(r => r.requestId), ['a-ask', 'c-ask', 'd-ask', 'z-ask']);
  assert.ok(!JSON.stringify(diag).includes('b-ask'), 'root-b 的请求不得进入 root-a 投影');
  // 存储观察值：queued 回执不推进 pending，replied/failed 保持各自已存状态
  assert.deepEqual(diag.requests.map(r => r.state), ['pending', 'replied', 'failed', 'pending']);
  // 安全副本：冻结，改写投影不得影响控制面状态
  assert.throws(() => { diag.requests[0].state = 'expired'; }, TypeError);
  assert.equal(JSON.stringify(plane.snapshot()), memoryBefore, 'readDiagnostics 不改内存状态');
  // receipts：D0 投影，queued ≠ consumed，code/idempotencyKey/kind/rootSessionId 不透传
  assert.equal(diag.receipts.length, 3);
  const byStatus = status => diag.receipts.filter(receipt => receipt.status === status);
  assert.equal(byStatus('queued').length, 1);
  assert.equal(byStatus('queued')[0].consumed, false, 'queued 不等于 consumed');
  assert.equal(byStatus('queued')[0].requestId, 'a-ask');
  assert.equal(byStatus('delivered').length, 1);
  assert.equal(byStatus('delivered')[0].consumed, true);
  assert.equal(byStatus('delivered')[0].requestId, 'c-ask');
  assert.equal(byStatus('failed').length, 1);
  // 跨 root 各自投影
  const diagB = await plane.readDiagnostics('root-b');
  assertDiagnosticsShape(diagB, 'available');
  assert.deepEqual(diagB.requests.map(r => r.requestId), ['b-ask']);
  assert.deepEqual(diagB.receipts, []);
  // filter 只收窄：request 与对应 receipt 同步收窄
  const filtered = await plane.readDiagnostics('root-a', { requestId: 'a-ask' });
  assert.deepEqual(filtered.requests.map(r => r.requestId), ['a-ask']);
  assert.deepEqual(filtered.receipts.map(r => r.requestId), ['a-ask']);
  assert.equal(filtered.complete, true);
  // 未知 root：确认空（available + 空 + complete），不是 unavailable
  const unknownRoot = await plane.readDiagnostics('root-unknown');
  assertDiagnosticsShape(unknownRoot, 'available');
  assert.deepEqual(unknownRoot.requests, []);
  assert.deepEqual(unknownRoot.receipts, []);
  assert.equal(unknownRoot.complete, true);
});

/* ---------------------------- 2. 50 上限、稳定排序与过滤收窄 ---------------------------- */

test('每组最多50条按ID稳定排序，超限complete=false，过滤恢复complete且不扩大scope', async () => {
  const plane = createSupervisorControlPlane({ readOwnerReceipt: async runId => ({ runId, rootSessionId: 'root', ownerGeneration: 1 }) });
  for (let i = 0; i < 51; i++) {
    const index = String(i).padStart(3, '0');
    const registered = await plane.registerSupervisorRequest({ id: `ask-${index}`, runId: `run-${index}`, agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root');
    assert.equal(registered.status, 'registered');
  }
  const diag = await plane.readDiagnostics('root');
  assertDiagnosticsShape(diag, 'available');
  assert.equal(diag.requests.length, 50);
  assert.equal(diag.complete, false, '超过50条必须置 complete=false');
  assert.equal(diag.requests[0].requestId, 'ask-000');
  assert.equal(diag.requests[49].requestId, 'ask-049');
  assert.deepEqual(diag.receipts, []);
  // 稳定排序：同 requestId 保持存储顺序（run-000 先登记）
  const registeredDup = await plane.registerSupervisorRequest({ id: 'ask-000', runId: 'run-dup', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root');
  assert.equal(registeredDup.status, 'registered');
  const dupDiag = await plane.readDiagnostics('root');
  assert.deepEqual(dupDiag.requests.filter(r => r.requestId === 'ask-000').map(r => r.runId), ['run-000', 'run-dup']);
  // 过滤只收窄本 root 的视图，收窄后 complete 恢复
  const filtered = await plane.readDiagnostics('root', { requestId: 'ask-050' });
  assert.deepEqual(filtered.requests.map(r => r.requestId), ['ask-050']);
  assert.equal(filtered.complete, true);
});

/* ---------------------------- 3. 持久化模式：直接读自身 root 已存 state ---------------------------- */

test('持久化模式直接read自身root已存state并验证digest，调用前后字节/mtime/内存一致且跨root隔离', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'supervisor-diagnostics-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let clock = 1_000_000;
  const options = {
    persistenceRoot: stateRoot, now: () => clock,
    readOwnerReceipt: async runId => ({ runId, rootSessionId: runId === 'run-b' ? 'root-b' : 'root-a', ownerGeneration: 1 }),
    readRuntime: async runId => ({ runId, ownerGeneration: 1, running: false, steerable: false }),
  };
  const plane = createSupervisorControlPlane(options);
  await plane.registerSupervisorRequest({ id: 'ask-a', runId: 'run-a', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-a');
  await plane.registerSupervisorRequest({ id: 'ask-b', runId: 'run-b', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-b');
  await plane.commitDelivery({ intent: { schemaVersion: 'supervisor-control-intent.v1', intentId: 'reply-a', rootSessionId: 'root-a', runId: 'run-a', ownerGeneration: 1, kind: 'reply', requestId: 'ask-a', requestGeneration: 1, payloadDigest: supervisorCanonicalDigest('reply-a') } }, 'root-a');
  const fileA = stateFileOf(stateRoot, 'root-a');
  const fileB = stateFileOf(stateRoot, 'root-b');
  const bytesA = await readFile(fileA);
  const bytesB = await readFile(fileB);
  const mtimeA = statSync(fileA).mtimeMs;
  const mtimeB = statSync(fileB).mtimeMs;
  const memoryBefore = JSON.stringify(plane.snapshot());

  const diagA = await plane.readDiagnostics('root-a');
  assertDiagnosticsShape(diagA, 'available');
  assert.equal(diagA.complete, true);
  assert.deepEqual(diagA.requests.map(r => r.requestId), ['ask-a']);
  assert.equal(diagA.requests[0].state, 'pending', 'queued 回执不改变 request 存储状态');
  assert.equal(diagA.requests[0].createdAt, 1_000_000);
  assert.equal(diagA.requests[0].expiresAt, 1_000_000 + 20 * 60 * 1000);
  assert.equal(diagA.receipts.length, 1);
  assert.equal(diagA.receipts[0].status, 'queued');
  assert.equal(diagA.receipts[0].consumed, false);
  assert.equal(diagA.receipts[0].requestId, 'ask-a');
  // 跨 root 隔离：root-b 的已存事实不进入 root-a 投影
  const diagAText = JSON.stringify(diagA);
  assert.ok(!diagAText.includes('ask-b') && !diagAText.includes('run-b'), 'root-b 的 requestId/runId 不得进入 root-a 投影');
  const diagB = await plane.readDiagnostics('root-b');
  assertDiagnosticsShape(diagB, 'available');
  assert.deepEqual(diagB.requests.map(r => r.requestId), ['ask-b']);
  assert.deepEqual(diagB.receipts, []);
  // 两个 root 的 state 文件字节/mtime 均不变；内存快照不变
  assert.deepEqual(await readFile(fileA), bytesA, 'root-a state 字节不变');
  assert.deepEqual(await readFile(fileB), bytesB, 'root-b state 字节不变');
  assert.equal(statSync(fileA).mtimeMs, mtimeA, 'root-a state mtime 不变');
  assert.equal(statSync(fileB).mtimeMs, mtimeB, 'root-b state mtime 不变');
  assert.equal(JSON.stringify(plane.snapshot()), memoryBefore, '内存投影不变');
  // 未执行 ready/loadRoot 的 fresh plane 也能只读同一已存状态
  const fresh = createSupervisorControlPlane(options);
  const freshDiag = await fresh.readDiagnostics('root-a');
  assertDiagnosticsShape(freshDiag, 'available');
  assert.deepEqual(freshDiag.requests.map(r => [r.requestId, r.state]), [['ask-a', 'pending']]);
  assert.equal(freshDiag.receipts.length, 1);
});

test('TTL后readDiagnostics保持存储观察值且不触发过期写入，只有事务路径才收敛expired', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'supervisor-diagnostics-ttl-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let clock = 1_000_000;
  const sink = [];
  const plane = createSupervisorControlPlane({
    persistenceRoot: stateRoot, now: () => clock,
    readOwnerReceipt: async runId => ({ runId, rootSessionId: 'root-a', ownerGeneration: 1 }),
    readRuntime: async runId => ({ runId, ownerGeneration: 1, running: false, steerable: false }),
    diagnosticSink: entry => sink.push(entry),
  });
  await plane.registerSupervisorRequest({ id: 'ask', runId: 'run', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-a');
  const file = stateFileOf(stateRoot, 'root-a');
  const bytes = await readFile(file);
  clock += 21 * 60 * 1000;
  const diag = await plane.readDiagnostics('root-a');
  assertDiagnosticsShape(diag, 'available');
  assert.equal(diag.requests[0].state, 'pending', 'requests 保持存储观察值，不额外计算 expired');
  assert.equal(diag.requests[0].expiresAt, 1_000_000 + 20 * 60 * 1000);
  assert.equal(plane.findRequest('ask').state, 'pending', '内存请求未被读取改写');
  assert.deepEqual(await readFile(file), bytes, 'TTL 后读取不改写 state 文件');
  assert.equal(sink.length, 0, '只读路径不触发诊断 sink');
  // 对照：事务路径（ready→loadRoot）才会按 TTL 过期，证明 readDiagnostics 自身不是 mutator
  assert.equal(await plane.ready('root-a'), true);
  assert.equal(plane.findRequest('ask').state, 'expired');
});

test('持久化模式未知root为confirmed空，损坏state为unavailable固定code不解释成空pending', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'supervisor-diagnostics-corrupt-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const plane = createSupervisorControlPlane({
    persistenceRoot: stateRoot,
    readOwnerReceipt: async runId => ({ runId, rootSessionId: 'root-a', ownerGeneration: 1 }),
  });
  // 未知 root：确认无数据是 available 的空，不是 unavailable
  const empty = await plane.readDiagnostics('root-empty');
  assertDiagnosticsShape(empty, 'available');
  assert.deepEqual(empty.requests, []);
  assert.deepEqual(empty.receipts, []);
  assert.equal(empty.complete, true);
  // 生成合法 state 后破坏 requestDigest 使 stateDigest 校验失败
  await plane.registerSupervisorRequest({ id: 'ask', runId: 'run', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-a');
  const file = stateFileOf(stateRoot, 'root-a');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.value.requests[0].requestDigest = `sha256:${'f'.repeat(64)}`;
  await writeFile(file, JSON.stringify(state));
  const broken = await plane.readDiagnostics('root-a');
  assertDiagnosticsShape(broken, 'unavailable');
  assert.equal(broken.code, 'SUPERVISOR_DIAGNOSTICS_UNAVAILABLE');
  assert.deepEqual(broken.requests, []);
  assert.deepEqual(broken.receipts, []);
  assert.equal(broken.complete, false);
});

/* ---------------------------- 4. 非法输入 fail closed ---------------------------- */

test('非法root身份/非法filter fail closed为unavailable固定code，不发起读取也不外泄错误', async () => {
  const plane = createSupervisorControlPlane({
    readOwnerReceipt: async runId => ({ runId, rootSessionId: 'root-a', ownerGeneration: 1 }),
  });
  await plane.registerSupervisorRequest({ id: 'ask', runId: 'run', agent: 'executor', reason: 'need_decision', expectsReply: true }, 'root-a');
  for (const badRoot of ['../escape', '', 'root with space', '/abs/path']) {
    const diag = await plane.readDiagnostics(badRoot);
    assertDiagnosticsShape(diag, 'unavailable');
    assert.equal(diag.code, 'SUPERVISOR_DIAGNOSTICS_UNAVAILABLE');
  }
  for (const badFilter of ['not-an-object', 42, { requestId: '../escape' }, { requestId: 42 }, { extra: 1 }, { requestId: 'ask', extra: 1 }]) {
    const diag = await plane.readDiagnostics('root-a', badFilter);
    assertDiagnosticsShape(diag, 'unavailable');
    assert.equal(diag.code, 'SUPERVISOR_DIAGNOSTICS_UNAVAILABLE');
  }
  // 合法但未知的 requestId：确认空匹配（available + 空），绝不扩大 scope
  const noMatch = await plane.readDiagnostics('root-a', { requestId: 'no-such-request' });
  assertDiagnosticsShape(noMatch, 'available');
  assert.deepEqual(noMatch.requests, []);
  assert.deepEqual(noMatch.receipts, []);
});
