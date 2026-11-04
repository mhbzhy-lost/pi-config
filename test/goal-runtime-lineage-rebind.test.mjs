import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalRuntime } from '../src/goal-runtime/scheduler.ts';
import { decodePlanContract, hashPlanContract } from '../src/goal-runtime/contract.ts';
import { decodeGoalStateSnapshot } from '../src/goal-runtime/session-state.ts';

/**
 * 计划 T5 断言 (a)-(h)：goal 侧按 resume 血缘重绑 task.run 至最终 run。
 * execution adapter 双打参考 test/goal-runtime-runtime.integration.mjs 的 adapter() 形态并扩展 lineage；
 * 这些引用不代表官方 proof 或真实 workspace。
 */

const SESSION_ID = 'lineage-test-session';
const SESSION_FILE = '/tmp/lineage-test-session.jsonl';

function contract({ ids = ['A'] } = {}) {
  return { schema: 'goal-runtime.plan.v1', objective: '血缘重绑隔离验证', constraints: ['只读检查'],
    resources: [{ id: 'slot', capacity: 2 }],
    checks: [{ id: 'C', statement: '良性本地命令退出零', command: { executable: process.execPath, args: ['-e', 'console.log("lineage-check-ok")'], timeoutSeconds: 5 }, repairTaskIds: ids }],
    tasks: ids.map(id => ({ id, agent: 'delegate', task: `受控任务 ${id}`, deps: [], writePaths: [`${id}.txt`], resources: ['slot'], acceptance: { criteria: ['完成声明任务'] }, checkIds: [] })),
    terminalCheckIds: ['C'] };
}
const block = value => `<!-- goal-runtime-contract:start -->\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n<!-- goal-runtime-contract:end -->`;

function factsOf(run, overrides = {}) {
  return { run, terminal: 'pending', terminalProofRef: null, integration: 'pending', integrationReceiptRef: null,
    workspaceState: 'active', recovery: 'none', wakeup: 'subscribed', blocker: null, ...overrides };
}
/** 降级 facts：terminal unknown 且存在 blocker（计划 T5 的重绑触发条件）。 */
const degradedFact = (run, blocker = 'PLAN_RUN_UNKNOWN') =>
  factsOf(run, { terminal: 'unknown', terminalProofRef: null, blocker, recovery: 'unknown' });
/** 完全闭合的成功 facts（closed：终态证明 + 集成 + released + 无恢复 + 无 blocker）。 */
const closedFact = run => factsOf(run, { terminal: 'succeeded', terminalProofRef: `proof:${run.runId}`,
  integration: 'not-applicable', workspaceState: 'released' });
/** 失败但已闭合的 facts（retryRoute 的 start 路由依据）。 */
const failedClosedFact = run => factsOf(run, { terminal: 'failed', terminalProofRef: `proof:${run.runId}`,
  integration: 'not-applicable', workspaceState: 'released' });

/** 主管批准的 adapter 边界双打；lineage 选项缺省时不挂载该方法（模拟旧实现）。 */
function adapter({ lineage } = {}) {
  const calls = { start: [], inspect: [], lineage: [] };
  const facts = new Map();
  const service = {
    calls,
    facts,
    async start(input) {
      calls.start.push(input);
      const run = { runId: `start-run-${calls.start.length}`, workspaceId: `start-ws-${calls.start.length}`,
        rootSessionId: input.ctx.sessionManager.getSessionId() };
      await input.onAllocated(run.workspaceId);
      facts.set(run.runId, factsOf(run));
      await input.onBound(run);
      return run;
    },
    async resume() { throw new Error('本测试不模拟 typed resume 成功'); },
    async inspect(ref) {
      calls.inspect.push(structuredClone(ref));
      if (!facts.has(ref.runId)) throw new Error(`受控故障：adapter 无 ${ref.runId} 的权威事实`);
      return structuredClone(facts.get(ref.runId));
    },
    subscribe() { return () => {}; },
  };
  if (lineage) {
    service.lineage = async ref => {
      calls.lineage.push(structuredClone(ref));
      return lineage(ref);
    };
  }
  return service;
}

/** 与真实 GoalStateStore 同构的内存双打：update/replaceCancelled 都经严格解码门。 */
function memoryStore(initial) {
  let current = structuredClone(initial);
  const history = [structuredClone(current)];
  const conflict = code => Object.assign(new Error(`受控冲突：${code}`), { code });
  return {
    history,
    restore: async () => structuredClone(current),
    read: () => current,
    async update(expectedRevision, transform) {
      if (!current || current.revision !== expectedRevision) throw conflict('REVISION_CONFLICT');
      const produced = transform(structuredClone(current));
      decodeGoalStateSnapshot(produced);
      current = structuredClone({ ...produced, revision: current.revision + 1 });
      history.push(structuredClone(current));
      return structuredClone(current);
    },
    async replaceCancelled(expectedRevision, newState) {
      if (!current || current.revision !== expectedRevision) throw conflict('REVISION_CONFLICT');
      if (current.status !== 'cancelled') throw conflict('INVALID_STATE_CHANGE');
      decodeGoalStateSnapshot(newState);
      if (newState.planId === current.planId || newState.status !== 'active' || newState.revision !== 0
        || newState.receipts.length
        || Object.values(newState.tasks).some(task => task.status !== 'pending' || task.attempt !== 0
          || task.run || task.dispatchKey || task.workspaceId || task.blocker)) {
        throw conflict('INVALID_STATE_CHANGE');
      }
      current = structuredClone({ ...newState, revision: 1 });
      history.push(structuredClone(current));
      return structuredClone(current);
    },
    async checkpoint(value) {
      return this.update(current.revision, state => ({ ...state, checkpoint: value }));
    },
    writeEvidence: async () => { throw new Error('本测试不写检查证据'); },
    assertWritable() {},
    diagnose: () => ({ restored: true, writable: true, revision: current.revision, entryId: 'test-entry',
      blockedCode: null, blockedReason: null, sessionFile: current.binding.sessionFile, verifiedEntryCount: 1 }),
  };
}

function makeState({ contractValue, planPath, run, status = 'active', taskStatus = 'running',
  blocker = null, supersededRunIds, planId = 'plan-lineage-test' } = {}) {
  const decoded = decodePlanContract(contractValue);
  return {
    planId, revision: 0,
    binding: { planPath, contractHash: hashPlanContract(contractValue), repositoryRoot: process.cwd(),
      sessionId: SESSION_ID, sessionFile: SESSION_FILE },
    contract: decoded, status,
    tasks: Object.fromEntries(decoded.tasks.map(task => [task.id, {
      status: taskStatus, attempt: 1, dispatchKey: 'dk-original', workspaceId: run ? run.workspaceId : null, run,
      terminalProofRef: null, integrationReceiptRef: null, blocker,
      ...(supersededRunIds ? { supersededRunIds } : {}),
    }])),
    receipts: [], checkpoint: { decisions: [], sourceRefs: [], nextAction: '受控测试' },
    pauseReason: null, lastProgressHash: '', noProgressTurns: 0,
  };
}

function runtime(store, execution) {
  return createGoalRuntime({ store, execution,
    verify: async () => { throw new Error('本测试不执行检查'); },
    captureSubject: async () => { throw new Error('本测试不捕获候选版本'); } });
}

const ctx = () => ({ sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => SESSION_FILE } });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lineage-'));
  const contractValue = contract();
  const planPath = join(dir, 'plan.md');
  await writeFile(planPath, block(contractValue));
  return { dir, contractValue, planPath };
}

const OLD_RUN = { runId: 'run-old-1', workspaceId: 'ws-1', rootSessionId: SESSION_ID };
const FINAL_RUN = { runId: 'run-final-1', workspaceId: 'ws-1', rootSessionId: SESSION_ID };
const supersededResolution = ref => (ref.runId === OLD_RUN.runId
  ? { run: FINAL_RUN, chain: [OLD_RUN.runId, FINAL_RUN.runId], superseded: true }
  : { run: ref, chain: [ref.runId], superseded: false });

test('(a) 降级 facts + lineage superseded → refreshRuns 持久化重绑最终 run 并解除 blocker', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: supersededResolution });
  execution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN));
  execution.facts.set(FINAL_RUN.runId, factsOf(FINAL_RUN)); // 最终 run：健康 pending
  const store = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN,
    taskStatus: 'blocked', blocker: 'PLAN_RUN_UNKNOWN' }));
  await runtime(store, execution).refreshRuns();
  const task = store.read().tasks.A;
  assert.deepEqual(task.run, FINAL_RUN);
  assert.deepEqual(task.supersededRunIds, [OLD_RUN.runId]);
  assert.equal(task.status, 'running');
  assert.equal(task.blocker, null);
  assert.equal(task.attempt, 1); // attempt/dispatchKey/workspaceId 不变
  assert.equal(task.dispatchKey, 'dk-original');
  assert.equal(task.workspaceId, 'ws-1');
  assert.deepEqual(execution.calls.lineage, [OLD_RUN]);
  assert.deepEqual(execution.calls.inspect.map(ref => ref.runId), [OLD_RUN.runId, FINAL_RUN.runId]);
  // 重绑本身经 change()/store.update 持久化：历史含 run=最终 run 且仍 blocked 的中间快照（与后续投影分离）。
  assert.ok(store.history.some(state => state.tasks.A.run?.runId === FINAL_RUN.runId && state.tasks.A.status === 'blocked'
    && JSON.stringify(state.tasks.A.supersededRunIds) === JSON.stringify([OLD_RUN.runId])));
  assert.ok(store.read().revision >= 2);
});

test('(b) lineage 返回 null → 维持现状 blocked 且 run 引用不变', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: () => null });
  execution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN));
  const store = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN,
    taskStatus: 'blocked', blocker: 'PLAN_RUN_UNKNOWN' }));
  await runtime(store, execution).refreshRuns();
  const task = store.read().tasks.A;
  assert.deepEqual(task.run, OLD_RUN);
  assert.equal(task.supersededRunIds, undefined);
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocker, 'PLAN_RUN_UNKNOWN');
  assert.equal(execution.calls.lineage.length, 1);
  assert.equal(store.read().revision, 0); // 无重绑、无状态变化
});

test('(c) lineage superseded=false → 维持现状 blocked 且 run 引用不变', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: ref => ({ run: ref, chain: [ref.runId], superseded: false }) });
  execution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN));
  const store = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN,
    taskStatus: 'blocked', blocker: 'PLAN_RUN_UNKNOWN' }));
  await runtime(store, execution).refreshRuns();
  const task = store.read().tasks.A;
  assert.deepEqual(task.run, OLD_RUN);
  assert.equal(task.supersededRunIds, undefined);
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocker, 'PLAN_RUN_UNKNOWN');
  assert.equal(store.read().revision, 0);
});

test('(d) cancel 后 replaceCancelled：前置血缘重绑后按最终 run 判 closed，替换门通过', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nextContract = contract({ ids: ['B'] });
  const nextBinding = { planPath: join(dir, 'next.md'), contractHash: hashPlanContract(nextContract),
    repositoryRoot: process.cwd(), sessionId: SESSION_ID, sessionFile: SESSION_FILE };
  // 对照：不重绑（lineage null）时旧 run 未闭合，替换门仍拒绝。
  const denyExecution = adapter({ lineage: () => null });
  denyExecution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN));
  const denyStore = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN, status: 'cancelled',
    taskStatus: 'blocked', blocker: 'PLAN_RUN_UNKNOWN' }));
  await assert.rejects(() => runtime(denyStore, denyExecution).replaceCancelled(nextBinding, nextContract),
    { code: 'GOAL_CANCELLED_REPLACEMENT_REQUIRED' });
  // 主路径：重绑后 inspect(最终 run) closed → 门通过。
  const execution = adapter({ lineage: supersededResolution });
  execution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN)); // 旧 run：降级未闭合
  execution.facts.set(FINAL_RUN.runId, closedFact(FINAL_RUN)); // 最终 run：已闭合
  const store = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN, status: 'cancelled',
    taskStatus: 'blocked', blocker: 'PLAN_RUN_UNKNOWN' }));
  const replaced = await runtime(store, execution).replaceCancelled(nextBinding, nextContract);
  assert.notEqual(replaced.planId, 'plan-lineage-test');
  assert.equal(replaced.status, 'active');
  assert.deepEqual(replaced.tasks.B, { status: 'pending', attempt: 0, dispatchKey: null, workspaceId: null,
    run: null, terminalProofRef: null, integrationReceiptRef: null, blocker: null });
  // 替换门按最终 run 判闭合：inspect 只收到最终 run；旧 run 仅进入 lineage 解析。
  assert.deepEqual(execution.calls.inspect.map(ref => ref.runId), [FINAL_RUN.runId]);
  assert.deepEqual(execution.calls.lineage.map(ref => ref.runId), [OLD_RUN.runId]);
  // 内存态重绑不持久化：旧计划的全部历史快照保持旧 run，未被改写。
  assert.ok(store.history.slice(0, -1).every(state => state.planId === 'plan-lineage-test'
    && state.tasks.A.run?.runId === OLD_RUN.runId && state.tasks.A.supersededRunIds === undefined));
});

test('(e) retryTask 前置血缘重绑：持久化重绑最终 run 后按其事实准入重派', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: supersededResolution });
  execution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN));
  execution.facts.set(FINAL_RUN.runId, failedClosedFact(FINAL_RUN)); // 最终 run：失败但已闭合 → start 路由
  const store = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN,
    taskStatus: 'blocked', blocker: '权威终态确认 attempt 失败；需要 plan_retry 或 typed 处置' }));
  const rt = runtime(store, execution);
  const result = await rt.retryTask('A', '按血缘重绑后的最终 run 重派', store.read().revision, ctx());
  assert.equal(result.outcome, 'bound');
  const task = store.read().tasks.A;
  assert.equal(task.attempt, 2); // 新 attempt 的新 run
  assert.notEqual(task.run.runId, OLD_RUN.runId);
  assert.notEqual(task.run.runId, FINAL_RUN.runId);
  // 前置重绑经 change() 持久化：历史含 run=最终 run 且 supersededRunIds 记录旧 id 的中间快照。
  assert.ok(store.history.some(state => state.tasks.A.run?.runId === FINAL_RUN.runId
    && JSON.stringify(state.tasks.A.supersededRunIds) === JSON.stringify([OLD_RUN.runId])));
  // 准入事实取自最终 run（inspect 不再访问旧 run），血缘解析以旧 run 起链。
  assert.deepEqual(execution.calls.inspect.map(ref => ref.runId), [FINAL_RUN.runId]);
  assert.deepEqual(execution.calls.lineage.map(ref => ref.runId), [OLD_RUN.runId]);
  assert.equal(execution.calls.start.length, 1);
});

test('(f) lineage 抛异常 → 吞掉返回 null，状态不变', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: () => { throw new Error('受控故障：血缘解析失败'); } });
  execution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN));
  const store = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN,
    taskStatus: 'blocked', blocker: 'PLAN_RUN_UNKNOWN' }));
  await runtime(store, execution).refreshRuns();
  const task = store.read().tasks.A;
  assert.deepEqual(task.run, OLD_RUN);
  assert.equal(task.supersededRunIds, undefined);
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocker, 'PLAN_RUN_UNKNOWN');
  assert.equal(execution.calls.lineage.length, 1); // 确实调用了 lineage 并吞掉异常
  assert.equal(store.read().revision, 0);
});

test('(g) facts.run 身份与 task.run 不符 → 维持既有降级路径，sameRun 未被放宽', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const foreignRun = { runId: 'run-other', workspaceId: 'ws-1', rootSessionId: SESSION_ID };
  // g-1：lineage 不可用（未挂载）+ 身份不符 → RUN_IDENTITY_MISMATCH 被既有 catch 降级为 blocked，run 不变。
  const noLineage = adapter();
  noLineage.facts.set(OLD_RUN.runId, factsOf(foreignRun)); // inspect(旧 run) 返回身份不符的 facts
  const store1 = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN }));
  await runtime(store1, noLineage).refreshRuns();
  const task1 = store1.read().tasks.A;
  assert.deepEqual(task1.run, OLD_RUN);
  assert.equal(task1.supersededRunIds, undefined);
  assert.equal(task1.status, 'blocked');
  assert.match(task1.blocker, /运行事实读取失败/);
  assert.equal(noLineage.calls.lineage.length, 0); // 未挂载 lineage：不解析
  // g-2：重绑已发生但最终 run facts 身份不符 → 拒绝采纳外来 facts，维持 blocked（不接受身份不符的投影）。
  const execution = adapter({ lineage: supersededResolution });
  execution.facts.set(OLD_RUN.runId, degradedFact(OLD_RUN));
  execution.facts.set(FINAL_RUN.runId, factsOf(foreignRun)); // 最终 run 的 facts 身份不符
  const store2 = memoryStore(makeState({ contractValue, planPath, run: OLD_RUN,
    taskStatus: 'blocked', blocker: 'PLAN_RUN_UNKNOWN' }));
  await runtime(store2, execution).refreshRuns();
  const task2 = store2.read().tasks.A;
  assert.deepEqual(task2.run, FINAL_RUN); // 重绑本身已持久化
  assert.deepEqual(task2.supersededRunIds, [OLD_RUN.runId]);
  assert.equal(task2.status, 'blocked'); // 身份不符的 facts 未被采纳：未转 running、blocker 未清除
  assert.equal(task2.blocker, 'PLAN_RUN_UNKNOWN');
});

test('(h) supersededRunIds 快照经 session-state 解码双向兼容', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = makeState({ contractValue, planPath, run: OLD_RUN });
  // 新快照：含 supersededRunIds，经 JSON 落盘语义写入 → 重读一致（往返一致）。
  const withAudit = structuredClone(base);
  withAudit.tasks.A.supersededRunIds = ['run-old-0', 'run-old-1'];
  const persisted = JSON.parse(JSON.stringify(withAudit));
  const decoded = decodeGoalStateSnapshot(persisted);
  assert.deepEqual(decoded.tasks.A.supersededRunIds, ['run-old-0', 'run-old-1']);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), persisted);
  // 旧快照：不含该字段 → 解码为 undefined，且不报未知字段。
  const legacy = JSON.parse(JSON.stringify(base));
  assert.equal(Object.hasOwn(legacy.tasks.A, 'supersededRunIds'), false);
  const decodedLegacy = decodeGoalStateSnapshot(legacy);
  assert.equal(decodedLegacy.tasks.A.supersededRunIds, undefined);
  assert.equal(Object.hasOwn(decodedLegacy.tasks.A, 'supersededRunIds'), false);
  // B1 解码契约：字段存在时必须是 string[]，非法形状仍拒绝。
  for (const bad of ['run-old-0', [7], ['ok', null]]) {
    const corrupt = JSON.parse(JSON.stringify(withAudit));
    corrupt.tasks.A.supersededRunIds = bad;
    assert.throws(() => decodeGoalStateSnapshot(corrupt), { code: 'SESSION_STATE_CORRUPT' });
  }
});
