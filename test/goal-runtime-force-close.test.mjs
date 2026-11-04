import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalRuntime } from '../src/goal-runtime/scheduler.ts';
import { decodePlanContract, hashPlanContract } from '../src/goal-runtime/contract.ts';
import { decodeGoalStateSnapshot } from '../src/goal-runtime/session-state.ts';
import { openJointSession } from './helpers/joint-upgrade-session.mjs';
import { installGoalRuntime } from '../src/goal-runtime/index.ts';

/**
 * 计划 T8 断言 (a)-(f)：force-close 的核实型（verified）与盲闭合（manual）两模式及状态门。
 * (a)(b)(d) 与 test/goal-runtime-lineage-rebind.test.mjs 的 T5 形态一致：mock adapter + 内存 store 直测 scheduler；
 * (c)(e)(f) 经 joint-upgrade-session 真实 Host harness 走真实工具注册与 /plan 命令路径。
 * 这些引用不代表官方 proof 或真实 workspace。
 */

const SESSION_ID = 'force-close-test-session';
const SESSION_FILE = '/tmp/force-close-test-session.jsonl';

function contract({ ids = ['A'], taskChecks = false } = {}) {
  return { schema: 'goal-runtime.plan.v1', objective: '强制闭合隔离验证', constraints: ['只读检查'],
    resources: [{ id: 'slot', capacity: 2 }],
    checks: [{ id: 'C', statement: '良性本地命令退出零', command: { executable: process.execPath, args: ['-e', 'console.log("force-close-check-ok")'], timeoutSeconds: 5 }, repairTaskIds: ids }],
    tasks: ids.map(id => ({ id, agent: 'delegate', task: `受控任务 ${id}`, deps: [], writePaths: [`${id}.txt`], resources: ['slot'], acceptance: { criteria: ['完成声明任务'] }, checkIds: taskChecks ? ['C'] : [] })),
    terminalCheckIds: ['C'] };
}
const block = value => `<!-- goal-runtime-contract:start -->\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n<!-- goal-runtime-contract:end -->`;

function factsOf(run, overrides = {}) {
  return { run, terminal: 'pending', terminalProofRef: null, integration: 'pending', integrationReceiptRef: null,
    workspaceState: 'active', recovery: 'none', wakeup: 'subscribed', blocker: null, ...overrides };
}
/** 降级 facts：terminal unknown 且存在 blocker（与 lineage-rebind 测试的触发前提一致）。 */
const degradedFact = (run, blocker = 'PLAN_RUN_UNKNOWN') =>
  factsOf(run, { terminal: 'unknown', terminalProofRef: null, blocker, recovery: 'unknown' });
/** 完全闭合的成功 facts（closed：终态证明 + 集成 + released + 无恢复 + 无 blocker）。 */
const closedFact = run => factsOf(run, { terminal: 'succeeded', terminalProofRef: `proof:${run.runId}`,
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
      const run = { runId: `fc-run-${calls.start.length}`, workspaceId: `fc-ws-${calls.start.length}`,
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

/** 与真实 GoalStateStore 同构的内存双打：update 经严格解码门，history 记录全部快照（只增）。 */
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

/** 按任务构造初始状态；runs/statuses/blockers 以 taskId 索引，缺省任务视为无 run 的 pending。 */
function makeState({ contractValue, planPath, runs = {}, statuses = {}, blockers = {}, status = 'cancelled',
  planId = 'plan-force-close-test' } = {}) {
  const decoded = decodePlanContract(contractValue);
  return {
    planId, revision: 0,
    binding: { planPath, contractHash: hashPlanContract(contractValue), repositoryRoot: process.cwd(),
      sessionId: SESSION_ID, sessionFile: SESSION_FILE },
    contract: decoded, status,
    tasks: Object.fromEntries(decoded.tasks.map(task => {
      const run = runs[task.id] ?? null;
      return [task.id, {
        status: statuses[task.id] ?? (run ? 'running' : 'pending'), attempt: run ? 1 : 0,
        dispatchKey: run ? `dk-${task.id}` : null, workspaceId: run ? run.workspaceId : null, run,
        terminalProofRef: null, integrationReceiptRef: null, blocker: blockers[task.id] ?? null,
      }];
    })),
    receipts: [], checkpoint: { decisions: [], sourceRefs: [], nextAction: '受控测试' },
    pauseReason: null, lastProgressHash: '', noProgressTurns: 0,
  };
}

function runtime(store, execution) {
  return createGoalRuntime({ store, execution,
    verify: async () => { throw new Error('本测试不执行检查'); },
    captureSubject: async () => { throw new Error('本测试不捕获候选版本'); } });
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'goal-force-close-'));
  const contractValue = contract();
  const planPath = join(dir, 'plan.md');
  await writeFile(planPath, block(contractValue));
  return { dir, contractValue, planPath };
}

/* ------------------------- 直测 scheduler：(a)(b)(d) ------------------------- */

const OLD_RUN_A = { runId: 'run-old-a', workspaceId: 'ws-a', rootSessionId: SESSION_ID };
const FINAL_RUN_A = { runId: 'run-final-a', workspaceId: 'ws-a', rootSessionId: SESSION_ID };
const OLD_RUN_B = { runId: 'run-old-b', workspaceId: 'ws-b', rootSessionId: SESSION_ID };
const FINAL_RUN_B = { runId: 'run-final-b', workspaceId: 'ws-b', rootSessionId: SESSION_ID };
const supersededA = ref => (ref.runId === OLD_RUN_A.runId
  ? { run: FINAL_RUN_A, chain: [OLD_RUN_A.runId, FINAL_RUN_A.runId], superseded: true }
  : { run: ref, chain: [ref.runId], superseded: false });

test('(a) 模式 A 全 closed → 成功：run 重绑、checkpoint 留痕、随后 replaceCancelled 通过', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contractAB = contract({ ids: ['A', 'B'] });
  const planPathAB = join(dir, 'plan-ab.md');
  await writeFile(planPathAB, block(contractAB));
  const execution = adapter({ lineage: supersededA });
  execution.facts.set(OLD_RUN_A.runId, degradedFact(OLD_RUN_A)); // A：旧 run 降级，最终 run 已闭合
  execution.facts.set(FINAL_RUN_A.runId, closedFact(FINAL_RUN_A));
  execution.facts.set(FINAL_RUN_B.runId, closedFact(FINAL_RUN_B)); // B：run 已是最终 run（无取代）
  const store = memoryStore(makeState({ contractValue: contractAB, planPath: planPathAB,
    runs: { A: OLD_RUN_A, B: FINAL_RUN_B }, statuses: { A: 'blocked', B: 'blocked' },
    blockers: { A: 'PLAN_RUN_UNKNOWN', B: 'PLAN_RUN_UNKNOWN' } }));
  const rt = runtime(store, execution);
  const closed = await rt.forceCloseTasks({ mode: 'verified' });
  assert.equal(closed.status, 'cancelled'); // 仅闭合留痕，不替换计划
  assert.equal(closed.planId, 'plan-force-close-test');
  const state = store.read();
  const taskA = state.tasks.A;
  assert.deepEqual(taskA.run, FINAL_RUN_A); // 已重绑最终 run
  assert.deepEqual(taskA.supersededRunIds, [OLD_RUN_A.runId]); // 旧 runId 留审计痕
  const taskB = state.tasks.B;
  assert.deepEqual(taskB.run, FINAL_RUN_B); // 未被取代的任务不重绑
  assert.equal(taskB.supersededRunIds, undefined); // 自取代禁止：不得把自身 runId 记为 superseded
  // checkpoint 留痕：mode、时间、planId、逐任务最终 runId
  assert.ok(state.checkpoint.decisions.some(d => d.includes('force-close verified') && d.includes('closedAt=') && d.includes('planId=plan-force-close-test')));
  assert.ok(state.checkpoint.decisions.some(d => d.includes('task A') && d.includes(FINAL_RUN_A.runId)));
  assert.ok(state.checkpoint.decisions.some(d => d.includes('task B') && d.includes(FINAL_RUN_B.runId)));
  assert.deepEqual(state.checkpoint.sourceRefs, []);
  assert.ok(state.checkpoint.nextAction.length > 0);
  assert.ok(store.read().revision >= 1); // 经 change() 持久化
  // 随后 replaceCancelled 通过：旧 run 不再访问，全部按最终 run 判闭合。
  const nextContract = contract({ ids: ['B'] });
  const nextBinding = { planPath: join(dir, 'next.md'), contractHash: hashPlanContract(nextContract),
    repositoryRoot: process.cwd(), sessionId: SESSION_ID, sessionFile: SESSION_FILE };
  const replaced = await rt.replaceCancelled(nextBinding, nextContract);
  assert.equal(replaced.status, 'active');
  assert.notEqual(replaced.planId, 'plan-force-close-test');
  assert.ok(execution.calls.inspect.every(ref => ref.runId !== OLD_RUN_A.runId));
});

test('(b-1) 模式 A lineage null 且旧 run 未闭合 → 整体拒绝且逐任务原因、状态不变', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: () => null });
  execution.facts.set(OLD_RUN_A.runId, degradedFact(OLD_RUN_A));
  const store = memoryStore(makeState({ contractValue, planPath, runs: { A: OLD_RUN_A },
    statuses: { A: 'blocked' }, blockers: { A: 'PLAN_RUN_UNKNOWN' } }));
  await assert.rejects(() => runtime(store, execution).forceCloseTasks({ mode: 'verified' }), error => {
    assert.equal(error.code, 'FORCE_CLOSE_VERIFICATION_FAILED');
    assert.match(error.message, /A（run run-old-a）/); // 逐任务列出未闭合原因
    assert.match(error.message, /terminal=unknown/);
    assert.match(error.message, /\/plan force-close/); // 处置指引指向人工路径
    return true;
  });
  const state = store.read();
  assert.equal(state.revision, 0); // 未做任何写入
  assert.deepEqual(state.tasks.A.run, OLD_RUN_A);
  assert.equal(state.tasks.A.supersededRunIds, undefined);
  assert.deepEqual(state.checkpoint, { decisions: [], sourceRefs: [], nextAction: '受控测试' });
  assert.deepEqual(execution.calls.lineage.map(ref => ref.runId), [OLD_RUN_A.runId]);
  assert.deepEqual(execution.calls.inspect.map(ref => ref.runId), [OLD_RUN_A.runId]);
});

test('(b-2) 模式 A 多任务部分不可核实 → 只列未通过任务，整体拒绝', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contractAB = contract({ ids: ['A', 'B'] });
  const planPathAB = join(dir, 'plan-ab.md');
  await writeFile(planPathAB, block(contractAB));
  const execution = adapter({ lineage: ref => (ref.runId === OLD_RUN_A.runId ? supersededA(ref) : null) });
  execution.facts.set(FINAL_RUN_A.runId, closedFact(FINAL_RUN_A)); // A：核实通过
  execution.facts.set(OLD_RUN_B.runId, degradedFact(OLD_RUN_B)); // B：lineage null 且未闭合
  const store = memoryStore(makeState({ contractValue: contractAB, planPath: planPathAB,
    runs: { A: OLD_RUN_A, B: OLD_RUN_B }, statuses: { A: 'blocked', B: 'blocked' },
    blockers: { A: 'PLAN_RUN_UNKNOWN', B: 'PLAN_RUN_UNKNOWN' } }));
  await assert.rejects(() => runtime(store, execution).forceCloseTasks({ mode: 'verified' }), error => {
    assert.equal(error.code, 'FORCE_CLOSE_VERIFICATION_FAILED');
    assert.match(error.message, /B（run run-old-b）/);
    assert.doesNotMatch(error.message, /A（run/); // 已通过任务不列入未闭合清单
    return true;
  });
  assert.equal(store.read().revision, 0);
  assert.deepEqual(store.read().tasks.A.run, OLD_RUN_A); // 拒绝时不部分重绑
  assert.deepEqual(store.read().tasks.B.run, OLD_RUN_B);
});

test('(b-3) 模式 A lineage superseded 但最终 run facts 非 closed → 拒绝并列最终 run 事实', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: supersededA });
  execution.facts.set(OLD_RUN_A.runId, degradedFact(OLD_RUN_A));
  execution.facts.set(FINAL_RUN_A.runId, factsOf(FINAL_RUN_A)); // 最终 run：健康 pending，未闭合
  const store = memoryStore(makeState({ contractValue, planPath, runs: { A: OLD_RUN_A },
    statuses: { A: 'blocked' }, blockers: { A: 'PLAN_RUN_UNKNOWN' } }));
  await assert.rejects(() => runtime(store, execution).forceCloseTasks({ mode: 'verified' }), error => {
    assert.equal(error.code, 'FORCE_CLOSE_VERIFICATION_FAILED');
    assert.match(error.message, /A（run run-final-a）/); // 原因按最终 run 列出
    assert.match(error.message, /terminal=pending/);
    return true;
  });
  assert.equal(store.read().revision, 0);
  assert.deepEqual(store.read().tasks.A.run, OLD_RUN_A);
  assert.deepEqual(execution.calls.inspect.map(ref => ref.runId), [FINAL_RUN_A.runId]);
});

test('(d) 非 cancelled 状态 → GOAL_NOT_CANCELLED 且无写入（两种模式同门）', async t => {
  const { dir, contractValue, planPath } = await setup();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execution = adapter({ lineage: supersededA });
  execution.facts.set(OLD_RUN_A.runId, closedFact(OLD_RUN_A)); // 即使事实已闭合也拒绝
  const store = memoryStore(makeState({ contractValue, planPath, runs: { A: OLD_RUN_A },
    status: 'active', statuses: { A: 'running' } }));
  const rt = runtime(store, execution);
  await assert.rejects(() => rt.forceCloseTasks({ mode: 'verified' }), { code: 'GOAL_NOT_CANCELLED' });
  await assert.rejects(() => rt.forceCloseTasks({ mode: 'manual' }), { code: 'GOAL_NOT_CANCELLED' });
  assert.equal(store.read().revision, 0);
  assert.deepEqual(store.read().tasks.A.run, OLD_RUN_A);
  assert.equal(execution.calls.inspect.length, 0); // 状态门前置，不触发核实
});

/* ------------------ 真实工具注册与 /plan 命令路径：(c)(e)(f) ------------------ */

const config = { enabled: true, maxConcurrentTasks: 2, maxNoProgressTurns: 3 };
const ok = result => { assert.notEqual(result.isError, true, JSON.stringify(result.details)); return result.details; };

/** 主机侧 adapter 双打（同 goal-runtime-continuity-notify.test.mjs 形态，不含 lineage）。 */
function hostAdapter() {
  const calls = []; const facts = new Map();
  return { calls, facts,
    async start(input) {
      calls.push(input);
      const run = { runId: `fc-host-run-${calls.length}`, workspaceId: `fc-host-ws-${calls.length}`, rootSessionId: input.ctx.sessionManager.getSessionId() };
      await input.onAllocated(run.workspaceId);
      facts.set(run.runId, { run, terminal: 'pending', terminalProofRef: null, integration: 'pending', integrationReceiptRef: null, workspaceState: 'active', recovery: 'none', wakeup: 'subscribed', blocker: null });
      await input.onBound(run); return run;
    },
    async resume(input) { throw new Error('本轮不模拟新进程授权的 typed resume 成功'); },
    async inspect(ref) { assert.ok(facts.has(ref.runId)); return structuredClone(facts.get(ref.runId)); },
    subscribe() { return () => {}; },
  };
}

async function host(t, c = contract()) {
  const execution = hostAdapter(); let bridge;
  const h = await openJointSession({ persistent: true, defaultTools: ['bash'], factories: [pi => {
    bridge = installGoalRuntime(pi, { config, resolveExecution: () => execution });
  }], files: async ({ cwd }) => {
    await mkdir(cwd, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'plan.md'), block(c));
  } });
  t.after(() => h.close());
  const call = async (name, args = {}) => {
    const id = `force-close-${name}-${Date.now()}`;
    return h.session.getToolDefinition(name).execute(id, args, undefined, undefined, h.session.extensionRunner.createToolContext(id));
  };
  await h.session.prompt('建立隔离测试会话');
  return { ...h, execution, get bridge() { return bridge; },
    state: () => bridge.getSession().store.read(),
    call,
    execute: () => call('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' }),
    async control(command) { await h.session.prompt(`/plan ${command}`); },
    goalEntryIds: async () => (await readFile(h.session.sessionFile, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line))
      .filter(entry => entry.type === 'custom' && entry.customType === 'goal-runtime.state.v1')
      .map(entry => entry.id),
    confirmYes() {
      const runner = h.session.extensionRunner;
      runner.setUIContext({ ...runner.getUIContext(), confirm: async () => true }, 'print');
    },
  };
}

test('(c) plan_force_close 工具：force_confirm 不匹配 → FORCE_CLOSE_CONFIRM_MISMATCH；核实失败拒绝', async t => {
  const h = await host(t);
  ok(await h.execute());
  await h.control('cancel');
  assert.equal(h.state().status, 'cancelled');
  const before = structuredClone(h.state());
  const mismatch = await h.call('plan_force_close', { force_confirm: 'not-the-plan-id' });
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.details.error.code, 'FORCE_CLOSE_CONFIRM_MISMATCH');
  assert.deepEqual(h.state(), before); // 拒绝不产生任何写入
  // 正确 planId 但无 lineage 且旧 run 未闭合 → 核实型整体拒绝（工具端到端接线）。
  const denied = await h.call('plan_force_close', { force_confirm: before.planId });
  assert.equal(denied.isError, true);
  assert.equal(denied.details.error.code, 'FORCE_CLOSE_VERIFICATION_FAILED');
  assert.deepEqual(h.state(), before);
});

test('(e) /plan force-close 确认后盲闭合 → 引用置空、留痕、session 条目只增、replaceCancelled 通过', async t => {
  const h = await host(t);
  ok(await h.execute());
  assert.equal(h.state().tasks.A.status, 'running');
  // 预置 proof/receipt 引用：人工断言闭合必须保留历史事实原值。
  const session = h.bridge.getSession();
  await session.store.update(h.state().revision, s => ({ ...s,
    tasks: { ...s.tasks, A: { ...s.tasks.A, terminalProofRef: 'proof-kept', integrationReceiptRef: 'receipt-kept' } } }));
  await h.control('cancel');
  assert.equal(h.state().status, 'cancelled');
  const entriesBefore = await h.goalEntryIds();
  h.confirmYes();
  await h.control('force-close');
  const state = h.state();
  assert.equal(state.status, 'cancelled'); // 盲闭合不替换计划
  const task = state.tasks.A;
  assert.equal(task.run, null); // run/dispatchKey/workspaceId 置空
  assert.equal(task.dispatchKey, null);
  assert.equal(task.workspaceId, null);
  assert.equal(task.status, 'blocked'); // 非 accepted/blocked → blocked
  assert.equal(task.blocker, 'FORCE_CLOSED_BY_ADMIN');
  assert.equal(task.terminalProofRef, 'proof-kept'); // proof/receipt 保留原值
  assert.equal(task.integrationReceiptRef, 'receipt-kept');
  assert.ok(state.checkpoint.decisions.some(d => d.includes('force-close manual') && d.includes('closedAt=') && d.includes(`planId=${state.planId}`)));
  // 历史 entry 未删除：session 条目只增。
  const entriesAfter = await h.goalEntryIds();
  assert.ok(entriesAfter.length > entriesBefore.length);
  const after = new Set(entriesAfter);
  for (const id of entriesBefore) assert.ok(after.has(id), `旧 entry ${id} 不得被删除`);
  // replaceCancelled 无 run 分支通过：重新 plan_execute 绑定新计划。
  const nextContract = contract({ ids: ['B'] });
  await writeFile(join(h.cwd, 'plan2.md'), block(nextContract));
  ok(await h.call('plan_execute', { plan_path: 'plan2.md', mode: 'subagent-driven' }));
  const replaced = h.state();
  assert.notEqual(replaced.planId, state.planId);
  assert.equal(replaced.status, 'active');
  // 替换后新计划立即推进：任务 B 被派发为新 attempt，无残留引用。
  assert.equal(replaced.tasks.B.status, 'running');
  assert.equal(replaced.tasks.B.attempt, 1);
  assert.ok(replaced.tasks.B.run);
  assert.equal(replaced.tasks.B.terminalProofRef, null);
  assert.equal(replaced.tasks.B.blocker, null);
});

test('(f) ui.confirm 拒绝 → 中止且无任何写入', async t => {
  const h = await host(t);
  ok(await h.execute());
  await h.control('cancel');
  assert.equal(h.state().status, 'cancelled');
  const before = structuredClone(h.state());
  const entriesBefore = await h.goalEntryIds();
  await h.control('force-close'); // 默认 noOp UI context：confirm 一律返回 false
  assert.deepEqual(h.state(), before); // 状态、checkpoint、revision 全部不变
  assert.deepEqual(await h.goalEntryIds(), entriesBefore); // session 无新增条目
});
