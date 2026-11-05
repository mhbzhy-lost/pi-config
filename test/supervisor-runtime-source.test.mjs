/**
 * supervisor steer 门 readRuntime 双源判定回归守卫（2026-11-01 生产事故）。
 *
 * 事故：主判定源只依赖上游 rpc.status 的 asyncSnapshot 投影，session-guard 在会话
 * 身份分歧时整体返回空快照（或 rpc.status 抛错/解析为 undefined），running 中的
 * typed workflow leaf 被判非 running，steer 门以 SUPERVISOR_STEER_NOT_ALLOWED 误拒。
 *
 * 本文件固化修复报告 §10.4 第 2 条的 11 项断言矩阵（docs/investigations/
 * 2026-11-01-typed-leaf-async-snapshot-gap.md）：
 *   - A/D/I 事故三变体（status 抛错 / session-guard 空快照 / status 解析为
 *     undefined）+ broker 在册无 terminal proof → 第二源放行 running；
 *   - B terminal proof 已 observed → 维持拒绝（undefined，不放宽）；
 *   - C 显式终态 complete → broker 不覆盖（resolvedBy=primary）；
 *   - E 主链判 running → 零行为变化且不落诊断；
 *   - F owned 在册分支 → 放行；G 双源皆缺 → undefined；H owner 读失败 → 不放宽；
 *   - J 诊断条目字段白名单（无凭据、无消息正文/未投影载荷泄漏）。
 *
 * 被测对象为真实导出 createSupervisorRuntimeReader/brokerLifecycleView/
 * brokerViewSaysRunning/primaryStatusExplicitTerminal，配合真实 RootBrokerServer
 * （observeStarted/observeTerminal 真实登记与 terminal proof 接受链）；仅 rpc.status
 * 以 stub 注入，authorityStore 以最小 stub 提供 owner receipt（ownerGeneration 合并断言）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RootBrokerServer } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts';
import { createSupervisorRuntimeReader, brokerLifecycleView, brokerViewSaysRunning, primaryStatusExplicitTerminal } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-runtime-source.ts';

const ROOT = 'sess-supervisor-runtime-source-root';
const RUN = 'run-leaf-guard-1';
const LEAF_IDENTITY = { sessionId: ROOT, pid: 424242, asyncDir: '/tmp/supervisor-runtime-source-guard-leaf', agent: 'executor' };
const DIVERGENCE = 'supervisor-runtime-source-divergence';
/** J 项负向 canary：混入 status 载荷的非白名单字段不得泄漏进诊断。 */
const CANARY = 'CANARY-SECOND-SOURCE-never-project-me';

/** stub authority store：readOwnerReceipt 可成功（ownerGeneration=3），与 production「owned run 的 owner receipt」同构。 */
const stubStore = () => ({
  setRootSessionId() {},
  async read() {
    return { revoked: false, supersededTo: undefined, receipt: { runId: RUN, rootSessionId: ROOT, ownerGeneration: 3, revision: 1, processBirth: 'stub' } };
  },
});

const newBroker = (withStore = true) => new RootBrokerServer({ rootSessionId: ROOT, upstream: {}, ...(withStore ? { authorityStore: stubStore() } : {}) });

/** 真实 acceptTerminalProof 可接受的 official terminal proof（identity 与 facade 登记一致）。 */
const validTerminalEvent = () => ({
  runId: RUN, ...LEAF_IDENTITY,
  version: 1, runnerProcessInstanceId: `${RUN}-runner`, state: 'observed',
  observedAt: 1_700_000_000_000,
  instances: [{ processInstanceId: `${RUN}-runner`, kind: 'runner', closeObservedAt: 1_700_000_000_000, exitCode: 0, signal: null }],
});

const allEntries = [];
/** diagnosticSink 收集器：条目进入本场景 entries 与全文件 allEntries（供 J 全局白名单校验）。 */
const collect = () => {
  const entries = [];
  return { entries, sink: () => (entry) => { entries.push(entry); allEntries.push(entry); } };
};
const makeReader = (broker, status, sink) => createSupervisorRuntimeReader({
  brokerReady: () => true, broker: () => broker, status, diagnosticSink: sink,
});
const statusThrows = () => async () => { throw Object.assign(new Error('upstream rpc unavailable'), { code: 'rpc_unavailable' }); };

/* ---------------------------- 纯函数真值表 ---------------------------- */

test('纯函数：primaryStatusExplicitTerminal/brokerViewSaysRunning 真值表与 brokerLifecycleView 投影', () => {
  assert.equal(primaryStatusExplicitTerminal(RUN, { details: { state: 'complete' }, asyncSnapshot: { runs: [] } }), true);
  assert.equal(primaryStatusExplicitTerminal(RUN, { details: {}, asyncSnapshot: { runs: [] } }), false, '快照空且无 details.state = 缺源，不是显式终态');
  assert.equal(primaryStatusExplicitTerminal(RUN, { details: { state: 'running' } }), false);
  assert.equal(primaryStatusExplicitTerminal(RUN, undefined), false, 'status undefined（抛错）= 缺源');
  assert.equal(primaryStatusExplicitTerminal(RUN, { details: {}, asyncSnapshot: { runs: [{ id: RUN, state: 'failed' }] } }), true, '快照投影显式终态');
  assert.deepEqual(brokerViewSaysRunning({ registration: 'owned', terminal: 'none', terminalConflict: false }), true);
  assert.deepEqual(brokerViewSaysRunning({ registration: 'facade', terminal: 'none', terminalConflict: false }), true);
  assert.deepEqual(brokerViewSaysRunning({ registration: 'facade', terminal: 'observed', terminalConflict: false }), false, 'terminal 已 observed 不按 running');
  assert.deepEqual(brokerViewSaysRunning({ registration: 'owned', terminal: 'none', terminalConflict: true }), false, 'terminal conflict 不按 running');
  assert.deepEqual(brokerViewSaysRunning({ registration: 'none', terminal: 'none', terminalConflict: false }), false);
  assert.deepEqual(brokerViewSaysRunning({ registration: 'unavailable', terminal: 'none', terminalConflict: false }), false);
  assert.deepEqual(brokerLifecycleView(undefined, RUN), { registration: 'unavailable', terminal: 'none', terminalConflict: false });
});

/* ---------------------------- 事故三变体（A/D/I）：第二源放行 ---------------------------- */

test('A 事故形态：rpc.status 抛错 + facade 在册无 terminal → running=true（broker 第二源放行，ownerGeneration 合并）', async () => {
  const broker = newBroker();
  await broker.observeStarted({ runId: RUN, ...LEAF_IDENTITY });
  assert.equal(broker.inspectFacadeTerminalProof(RUN)?.state, 'pending', '前置：observeStarted 已登记 facade 且无 terminal');
  const { entries, sink } = collect();
  const readRuntime = makeReader(broker, statusThrows(), sink);
  const runtime = await readRuntime(RUN);
  assert.deepEqual(runtime, { runId: RUN, running: true, steerable: true, ownerGeneration: 3 });
  const entry = entries.at(-1);
  assert.equal(entry?.phase, DIVERGENCE);
  assert.equal(entry?.version, 1);
  assert.equal(entry?.runId, RUN);
  assert.equal(entry?.resolvedBy, 'broker');
  assert.equal(entry?.primarySource?.statusOk, false, '主源未产出判定（rpc.status 抛错）');
  assert.deepEqual(entry?.brokerView, { registration: 'facade', terminal: 'none', terminalConflict: false });
});

test('D 事故形态（快照空）：rpc.status 成功但 session-guard 空快照 + facade 在册 → running=true', async () => {
  const broker = newBroker();
  await broker.observeStarted({ runId: RUN, ...LEAF_IDENTITY });
  const { entries, sink } = collect();
  // 缺源：无显式 state；unprojectedCanary 为非白名单载荷，J 项验证其不泄漏。
  const readRuntime = makeReader(broker, async () => ({ details: {}, asyncSnapshot: { runs: [] }, unprojectedCanary: CANARY }), sink);
  const runtime = await readRuntime(RUN);
  assert.deepEqual(runtime, { runId: RUN, running: true, steerable: true, ownerGeneration: 3 });
  assert.equal(entries.at(-1)?.resolvedBy, 'broker');
  assert.equal(entries.at(-1)?.primarySource?.snapshotRunCount, 0, '诊断记录 snapshot 判定：快照为空');
  assert.equal(entries.at(-1)?.primarySource?.statusOk, true);
});

test('I 事故形态：rpc.status 解析为 undefined + facade 在册 → running=true（拿不到 runtime 的缺源场景）', async () => {
  const broker = newBroker();
  await broker.observeStarted({ runId: RUN, ...LEAF_IDENTITY });
  const { sink } = collect();
  const readRuntime = makeReader(broker, async () => undefined, sink);
  assert.deepEqual(await readRuntime(RUN), { runId: RUN, running: true, steerable: true, ownerGeneration: 3 });
});

/* ---------------------------- 终局事实与主链权威（B/C/E/F） ---------------------------- */

test('B terminal proof 已 observed：同一在册 run 维持拒绝（undefined，不放宽）', async () => {
  const broker = newBroker();
  await broker.observeStarted({ runId: RUN, ...LEAF_IDENTITY });
  const { entries, sink } = collect();
  const readRuntime = makeReader(broker, statusThrows(), sink);
  assert.deepEqual(await readRuntime(RUN), { runId: RUN, running: true, steerable: true, ownerGeneration: 3 });
  broker.observeTerminal(validTerminalEvent()); // 真实 terminal proof 接受链（acceptTerminalProof）
  assert.equal(broker.inspectFacadeTerminalProof(RUN)?.state, 'observed', '前置：terminal proof 已 observed');
  const runtime = await readRuntime(RUN);
  assert.equal(runtime, undefined, 'terminal observed 后第二源不放行，维持现状 undefined');
  const entry = entries.at(-1);
  assert.equal(entry?.resolvedBy, null);
  assert.equal(entry?.brokerView?.terminal, 'observed');
});

test('C 显式终态：rpc.status 成功且 state=complete → 不经 broker 覆盖（resolvedBy=primary）', async () => {
  const broker = newBroker();
  await broker.observeStarted({ runId: RUN, ...LEAF_IDENTITY }); // broker 视图本可放行
  const { entries, sink } = collect();
  const readRuntime = makeReader(broker, async () => ({ details: { state: 'complete' }, asyncSnapshot: { runs: [] } }), sink);
  const runtime = await readRuntime(RUN);
  assert.deepEqual(runtime, { runId: RUN, running: false, steerable: false, ownerGeneration: 3, explicitState: 'complete' }, '上游链显式终态权威，broker 不覆盖；explicitState 仅随 runtime 暴露供 INV-EXIT 拒绝归因，不参与判定');
  const entry = entries.at(-1);
  assert.equal(entry?.resolvedBy, 'primary');
  assert.equal(entry?.primarySource?.explicitState, 'complete');
  assert.equal(entry?.primarySource?.snapshotRunCount, 0);
});

test('E 主链判 running：返回值与既有实现逐字段一致，且不落诊断（零行为变化）', async () => {
  const broker = newBroker();
  await broker.observeStarted({ runId: RUN, ...LEAF_IDENTITY });
  const { entries, sink } = collect();
  const readRuntime = makeReader(broker, async () => ({ details: { state: 'running', steerable: true, liveRunEpoch: 9, ownerGeneration: 7 }, asyncSnapshot: { runs: [{ id: RUN, state: 'running' }, { id: 'other' }] } }), sink);
  const before = entries.length;
  const runtime = await readRuntime(RUN);
  assert.deepEqual(runtime, { runId: RUN, running: true, steerable: true, liveRunEpoch: 9, ownerGeneration: 3, explicitState: 'running' }, 'owner receipt 合并语义与既有实现一致（receipt 覆盖 details）；新增 explicitState 仅为 SUPERVISOR_STEER_NOT_ALLOWED 回执归因');
  assert.equal(entries.length, before, '判 running 路径不新增诊断条目（零噪声）');
});

test('F owned 在册分支：inspectExecutionProof 视图（owned 登记、无 terminal）→ running=true', async () => {
  const broker = newBroker();
  // 直接置入最小 OwnedRun 形状以覆盖 owned 视图分支；production 中该登记由
  // authorizeRun（typed 派发授权链）产生，视图组合面为 inspectExecutionProof。
  broker.ownedRuns.set(RUN, {
    rootSessionId: ROOT, runId: RUN, asyncDir: LEAF_IDENTITY.asyncDir, sessionId: ROOT, pid: LEAF_IDENTITY.pid, agentProfile: LEAF_IDENTITY.agent,
    capabilities: new Set(), authorization: { goal: null }, birthIdentity: null, identityState: 'verified',
  });
  assert.deepEqual(brokerLifecycleView(broker, RUN), { registration: 'owned', terminal: 'none', terminalConflict: false });
  const { entries, sink } = collect();
  const readRuntime = makeReader(broker, statusThrows(), sink);
  const runtime = await readRuntime(RUN);
  assert.deepEqual(runtime, { runId: RUN, running: true, steerable: true, ownerGeneration: 3 });
  assert.equal(entries.at(-1)?.brokerView?.registration, 'owned');
});

/* ---------------------------- 双源皆缺与不放宽（G/H） ---------------------------- */

test('G 双源皆缺：未登记 + rpc.status 抛错 → undefined（现状语义不放宽）', async () => {
  const broker = newBroker();
  const { entries, sink } = collect();
  const readRuntime = makeReader(broker, statusThrows(), sink);
  assert.equal(await readRuntime(RUN), undefined);
  const entry = entries.at(-1);
  assert.equal(entry?.resolvedBy, null);
  assert.deepEqual(entry?.brokerView, { registration: 'none', terminal: 'none', terminalConflict: false });
});

test('H owner receipt 读取失败：status 缺源但 owner 读失败 → 仍 undefined（不放宽）', async () => {
  const broker = newBroker(false); // 无 authorityStore：readOwnerReceipt 抛 authority_store_unavailable
  await broker.observeStarted({ runId: RUN, ...LEAF_IDENTITY });
  const { entries, sink } = collect();
  const readRuntime = makeReader(broker, async () => ({ details: {}, asyncSnapshot: { runs: [] } }), sink);
  assert.equal(await readRuntime(RUN), undefined, 'owner 读失败维持现状 undefined（控制面 owner 围栏继续 fail-closed）');
  const entry = entries.at(-1);
  assert.equal(entry?.resolvedBy, null);
  assert.equal(entry?.primarySource?.statusOk, true);
  assert.equal(entry?.primarySource?.error?.code, 'authority_store_unavailable');
});

/* ---------------------------- J：诊断字段白名单 ---------------------------- */

test('J 诊断条目字段白名单：仅含约定字段，canary/消息正文类载荷不泄漏', () => {
  assert.ok(allEntries.length >= 8, `前置：已收集诊断条目（实际 ${allEntries.length}）`);
  const whitelist = new Set(['version', 'phase', 'runId', 'primarySource', 'brokerView', 'resolvedBy']);
  const primaryWhitelist = new Set(['statusOk', 'running', 'steerable', 'explicitState', 'snapshotRunCount', 'projected', 'error', 'failedAt']);
  for (const entry of allEntries) {
    for (const key of Object.keys(entry ?? {})) assert.ok(whitelist.has(key), `诊断条目出现白名单外字段：${key}`);
    for (const key of Object.keys(entry?.primarySource ?? {})) {
      assert.ok(primaryWhitelist.has(key), `primarySource 出现白名单外字段：${key}`);
    }
    assert.deepEqual(Object.keys(entry?.brokerView ?? {}).sort(), ['registration', 'terminal', 'terminalConflict'], 'brokerView 必须是精确白名单字段');
    assert.equal(entry?.phase, DIVERGENCE);
    assert.ok(typeof entry?.runId === 'string' && entry.runId.length > 0, '诊断条目含 runId（两源分歧可归因）');
    assert.ok(['primary', 'broker', null].includes(entry?.resolvedBy), 'resolvedBy 必须在约定枚举内');
    const error = entry?.primarySource?.error;
    if (error) assert.deepEqual(Object.keys(error).sort(), ['code', 'message'], 'error 摘要仅限 code/message（有界）');
    if (typeof error?.message === 'string') assert.ok(error.message.length <= 200, 'error message 有界截断');
  }
  assert.ok(!JSON.stringify(allEntries).includes(CANARY), '混入 status 的非白名单载荷（canary）不得泄漏进诊断');
});
