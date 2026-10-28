import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { openJointSession, sdk, ai } from './helpers/joint-upgrade-session.mjs';
import { installGoalRuntime, resolvePlanBinding } from '../src/goal-runtime/index.ts';
import { createGoalStateStore, decodeGoalStateSnapshot, decodeGoalCheckEvidence } from '../src/goal-runtime/session-state.ts';
import { captureSubject, captureBindingSubject, compareSubjects, receiptsAreCurrent, verifyChecks } from '../src/goal-runtime/verification.ts';
import { bindingSemanticInput, resolveTaskRepository } from '../src/goal-runtime/repository-resolution.ts';
import { resolveRepositoryIdentity } from 'pi-subagents-enhanced/workspace';
import goalExtension from '../pi/extensions/goal-runtime.ts';
import contextUsage from '../pi/extensions/context-usage.ts';
import { bindPlanExecutionService, getPlanExecutionService, subscribePlanExecutionService } from 'pi-subagents-enhanced/execution';
import { createGoalRuntime, resourceUsage } from '../src/goal-runtime/scheduler.ts';
import { hashPlanContract } from '../src/goal-runtime/contract.ts';
import { createTypedSubagentExtension } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts';

const tools = ['plan_checkpoint', 'plan_execute', 'plan_retry', 'plan_status', 'plan_verify'];
const config = { enabled: true, maxConcurrentTasks: 2, maxNoProgressTurns: 3 };
function contract({ ids = ['A'], taskChecks = true, fail = false, capacity = 2 } = {}) {
  return { schema: 'goal-runtime.plan.v1', objective: '隔离 Host 验证', constraints: ['只能修改声明路径', '不得访问真实凭据', '检查只读'],
    resources: [{ id: 'slot', capacity }],
    checks: [{ id: 'C', statement: '良性本地命令退出零', command: { executable: process.execPath, args: ['-e', fail ? 'process.exit(7)' : 'console.log("goal-check-ok")'], timeoutSeconds: 5 }, repairTaskIds: ids }],
    tasks: ids.map(id => ({ id, agent: 'delegate', task: `读取临时输入并交付 ${id}；越界即停止。`, deps: [], writePaths: [`${id}.txt`], resources: ['slot'], acceptance: { criteria: ['完成声明任务'] }, checkIds: taskChecks ? ['C'] : [] })), terminalCheckIds: ['C'] };
}
const block = c => `<!-- goal-runtime-contract:start -->\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\`\n<!-- goal-runtime-contract:end -->`;
const disk = async session => (await readFile(session.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const goalEntries = entries => entries.filter(e => e.type === 'custom' && e.customType.startsWith('goal-runtime.'));

// 主管批准的 adapter 边界双打；这些引用不代表官方 proof 或真实 workspace。
function adapter() {
  const calls = []; const facts = new Map(); const listeners = new Set();
  let fault = null; let beforeStart = null;
  return { calls, facts, listeners,
    set fault(value) { fault = value; }, set beforeStart(value) { beforeStart = value; },
    async start(input) {
      calls.push(input); await beforeStart?.(input);
      if (fault === 'unknown') throw new Error('受控故障：调用后无法确认是否启动');
      const run = { runId: `boundary-run-${calls.length}`, workspaceId: `boundary-workspace-${calls.length}`, rootSessionId: input.ctx.sessionManager.getSessionId() };
      await input.onAllocated(run.workspaceId);
      facts.set(run.runId, { run, terminal: 'pending', terminalProofRef: null, integration: 'pending', integrationReceiptRef: null, workspaceState: 'active', recovery: 'none', wakeup: 'subscribed', blocker: null });
      await input.onBound(run); return run;
    },
    async resume(input) { throw new Error('本轮不模拟新进程授权的 typed resume 成功'); },
    async inspect(ref) { assert.ok(facts.has(ref.runId)); return structuredClone(facts.get(ref.runId)); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    closeRun(run, overrides = {}) {
      facts.set(run.runId, { run, terminal: 'succeeded', terminalProofRef: `boundary-proof:${run.runId}`, integration: 'completed', integrationReceiptRef: `boundary-integration:${run.runId}`, workspaceState: 'released', recovery: 'none', wakeup: 'subscribed', blocker: null, ...overrides });
    },
  };
}
async function host(t, c = contract(), { empty = false, repositories } = {}) {
  const execution = adapter(); let bridge; let api;
  const h = await openJointSession({ persistent: true, defaultTools: ['bash'], factories: [pi => {
    api = pi; bridge = installGoalRuntime(pi, { config, resolveExecution: () => execution });
  }, contextUsage], files: async ({ cwd }) => {
    for (const root of repositories ? repositories.map(repoId => join(cwd, repoId)) : [cwd]) {
      await mkdir(root, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    }
    await writeFile(join(cwd, 'plan.md'), block(c));
  } });
  t.after(() => h.close());
  const call = async (name, args = {}) => {
    const id = `host-${name}-${Date.now()}`;
    return h.session.getToolDefinition(name).execute(id, args, undefined, undefined, h.session.extensionRunner.createToolContext(id));
  };
  if (!empty) await h.session.prompt('建立隔离测试会话');
  return { ...h, execution, get bridge() { return bridge; }, get api() { return api; }, call,
    state: () => bridge.getSession().store.read(),
    execute: () => call('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' }),
    refresh: () => bridge.getSession().runtime.refreshRuns(),
    async control(command) { await h.session.prompt(`/plan ${command}`); },
  };
}
const ok = result => { assert.notEqual(result.isError, true, JSON.stringify(result.details)); return result.details; };

test('F1 空持久会话经真实模型工具链绑定、落盘与幂等；第二计划和坏 DAG 显式拒绝', async t => {
  const h = await host(t, contract(), { empty: true });
  assert.equal(h.state(), null);
  const first = ok(await h.invoke('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' }));
  assert.equal(first.state.binding.sessionId, h.session.sessionId);
  assert.equal(first.state.binding.contractHash, hashPlanContract(contract()));
  assert.ok(goalEntries(await disk(h.session)).some(e => e.data.planId === first.state.planId));
  assert.equal(ok(await h.execute()).state.planId, first.state.planId); assert.equal(h.execution.calls.length, 1);
  await writeFile(join(h.cwd, 'second.md'), block(contract()));
  assert.equal((await h.call('plan_execute', { plan_path: 'second.md', mode: 'subagent-driven' })).details.error.code, 'GOAL_ALREADY_BOUND');
  const bad = contract(); bad.tasks[0].deps = ['A']; await writeFile(join(h.cwd, 'bad.md'), block(bad));
  assert.equal((await h.call('plan_execute', { plan_path: 'bad.md', mode: 'subagent-driven' })).details.error.code, 'SELF_DEPENDENCY');
  assert.equal((await h.call('plan_execute', { plan_path: 'plan.md', mode: 'inline' })).details.error.code, 'GOAL_MODE_UNSUPPORTED');
  t.diagnostic(JSON.stringify({ sessionId: h.session.sessionId, sessionFile: h.session.sessionFile, planId: first.state.planId, contractHash: first.state.binding.contractHash, entryId: goalEntries(await disk(h.session))[0].id }));
});

test('F2 adapter 边界：intent 先落盘、两个前驱容量并发，后继只等自身依赖', async t => {
  const c = contract({ ids: ['A', 'B', 'C'], taskChecks: false }); c.tasks[2].deps = ['A'];
  const h = await host(t, c);
  h.execution.beforeStart = async input => {
    const entries = await disk(h.session);
    assert.ok(entries.some(e => e.data?.tasks && Object.values(e.data.tasks).some(task => task.dispatchKey === input.dispatchKey && task.run === null)));
    assert.equal(input.request.worktree, true); assert.match(input.request.task, /不得访问真实凭据/);
  };
  assert.deepEqual(ok(await h.execute()).dispatches.map(d => d.outcome), ['bound', 'bound']);
  assert.equal(h.state().tasks.C.status, 'pending');
  h.execution.closeRun(h.state().tasks.A.run); await h.refresh();
  assert.equal(h.state().tasks.A.status, 'accepted');
  assert.equal(ok(await h.execute()).dispatches[0].taskId, 'C');
  assert.equal(h.state().tasks.B.status, 'running'); assert.equal(h.execution.calls.length, 3);
});

test('F2/F6 adapter 边界：调用后故障为 unknown，重复 execute/reload 不自动重派', async t => {
  const h = await host(t); h.execution.fault = 'unknown';
  assert.equal(ok(await h.execute()).dispatches[0].outcome, 'unknown');
  assert.equal(h.state().tasks.A.status, 'blocked'); assert.ok(h.state().tasks.A.dispatchKey);
  assert.deepEqual(ok(await h.execute()).dispatches, []);
  await h.session.reload();
  assert.equal(ok(await h.execute()).dispatches.length, 0); assert.equal(h.execution.calls.length, 1);
});

test('F3 adapter 交付后 running→verifying→accepted：真实 executeTool bash 与 entry 回执决定完成', async t => {
  const h = await host(t); ok(await h.execute());
  assert.equal(h.state().tasks.A.status, 'running');
  h.execution.closeRun(h.state().tasks.A.run); await h.refresh(); assert.equal(h.state().tasks.A.status, 'verifying');
  const observed = []; const unsubscribe = h.session.subscribe(event => { if (event.type === 'tool_execution_end') observed.push(event); });
  try {
    const verified = ok(await h.call('plan_verify'));
    assert.equal(verified.receipts[0].outcome, 'passed'); assert.equal(verified.receipts[0].exitCode, 0);
    assert.equal(h.state().tasks.A.status, 'accepted'); assert.equal(h.state().status, 'active');
    const evidence = (await disk(h.session)).find(e => e.id === verified.receipts[0].resultRef.split('#')[0]);
    assert.equal(evidence.customType, 'goal-runtime.check-result.v1');
    assert.equal(evidence.data.results[0].toolOutcome.result.structuredContent.exit_code, 0);
    assert.ok(observed.some(e => e.toolName === 'bash' && e.parentToolCallId));
    ok(await h.call('plan_verify')); assert.equal(h.state().status, 'completed');
    t.diagnostic(JSON.stringify({ sessionId: h.session.sessionId, contractHash: h.state().binding.contractHash, resultRef: verified.receipts[0].resultRef, toolCallId: verified.receipts[0].toolCallId }));
  } finally { unsubscribe(); }
});

test('F4 adapter 边界：失败检查释放容量1占用，repairTaskIds 修复后真实复验', async t => {
  const c = contract({ capacity: 1 });
  c.checks[0].command.args = ['-e', 'process.exit(Number(require("node:fs").readFileSync("A.txt", "utf8")))'];
  const h = await host(t, c); await writeFile(join(h.cwd, 'A.txt'), '7');
  ok(await h.execute()); h.execution.closeRun(h.state().tasks.A.run); await h.refresh();
  const failed = ok(await h.call('plan_verify')); assert.equal(failed.receipts[0].outcome, 'failed');
  assert.equal(h.state().tasks.A.status, 'blocked');
  assert.equal(resourceUsage(h.state(), h.bridge.getSession().runtime.readFacts()).resources.slot, 0);
  const retry = ok(await h.call('plan_retry', { task_id: 'A', message: '修正临时文件退出码', expected_revision: h.state().revision }));
  assert.equal(retry.dispatch.outcome, 'bound'); assert.equal(h.state().tasks.A.attempt, 2); assert.equal(h.state().receipts.length, 0);
  await writeFile(join(h.cwd, 'A.txt'), '0'); h.execution.closeRun(h.state().tasks.A.run); await h.refresh();
  ok(await h.call('plan_verify')); assert.equal(h.state().tasks.A.status, 'accepted');
  ok(await h.call('plan_verify')); assert.equal(h.state().status, 'completed');
});

test('F4 adapter 边界：无 check 失败的 retry 逐项核验闭合组合，拒绝 unknown/manual/缺 proof', async t => {
  const h = await host(t, contract({ taskChecks: false })); ok(await h.execute()); const run = h.state().tasks.A.run;
  const deny = [
    { terminal: 'unknown', terminalProofRef: null, recovery: 'unknown', blocker: 'PLAN_RUN_UNKNOWN' },
    { terminal: 'pending', terminalProofRef: null, integration: 'pending', workspaceState: 'active' },
    { terminal: 'failed', terminalProofRef: null },
    { terminal: 'failed', integration: 'completed', integrationReceiptRef: null },
    { terminal: 'failed', workspaceState: 'active', recovery: 'manual-integration', blocker: 'PLAN_MANUAL_INTEGRATION_REQUIRED' },
    { terminal: 'failed', workspaceState: 'stopped', recovery: 'unknown' },
  ];
  for (const facts of deny) {
    h.execution.closeRun(run, facts); await h.refresh();
    const rejected = await h.call('plan_retry', { task_id: 'A', message: '核验失败事实', expected_revision: h.state().revision });
    assert.equal(rejected.details.error.code, 'RETRY_NOT_ADMITTED'); assert.equal(h.execution.calls.length, 1);
  }
  h.execution.closeRun(run, { terminal: 'failed', integration: 'not-applicable', integrationReceiptRef: null }); await h.refresh();
  assert.equal(h.state().receipts.length, 0);
  assert.equal((await h.call('plan_retry', { task_id: 'A', message: '修正已闭合失败', expected_revision: h.state().revision - 1 })).details.error.code, 'REVISION_CONFLICT');
  assert.equal(ok(await h.call('plan_retry', { task_id: 'A', message: '修正已闭合失败', expected_revision: h.state().revision })).dispatch.outcome, 'bound');
  assert.equal(h.state().tasks.A.attempt, 2);
});

test('F6 adapter 边界：cancelled 未闭合拒绝替换，全闭合新 planId 保留旧 entry', async t => {
  const h = await host(t); ok(await h.execute()); const old = h.state();
  await h.control('cancel'); assert.equal(h.state().status, 'cancelled');
  const next = contract(); next.objective = '第二个隔离计划'; await writeFile(join(h.cwd, 'next.md'), block(next));
  const replace = () => h.call('plan_execute', { plan_path: 'next.md', mode: 'subagent-driven' });
  assert.equal((await replace()).details.error.code, 'GOAL_CANCELLED_REPLACEMENT_REQUIRED');
  h.execution.closeRun(old.tasks.A.run, { integration: 'blocked', recovery: 'manual-integration', blocker: 'PLAN_MANUAL_INTEGRATION_REQUIRED' });
  assert.equal((await replace()).details.error.code, 'GOAL_CANCELLED_REPLACEMENT_REQUIRED');
  h.execution.closeRun(old.tasks.A.run); const result = ok(await replace());
  assert.notEqual(result.state.planId, old.planId);
  const entries = goalEntries(await disk(h.session));
  assert.ok(entries.some(e => e.data.planId === old.planId && e.data.status === 'cancelled'));
  assert.ok(entries.some(e => e.data.planId === result.state.planId));
});

test('F6 真 Host 控制：status 只读、pause/resume、steer 与 fork/tree 门禁', async t => {
  const h = await host(t); ok(await h.execute()); const before = await readFile(h.session.sessionFile, 'utf8');
  const revision = h.state().revision; ok(await h.call('plan_status')); await h.control('status');
  assert.equal(h.state().revision, revision); assert.equal(await readFile(h.session.sessionFile, 'utf8'), before);
  await h.control('pause'); assert.equal(h.state().status, 'paused');
  assert.equal((await h.execute()).details.error.code, 'GOAL_NOT_ACTIVE');
  await h.control('resume'); assert.equal(h.state().status, 'active');
  await h.session.steer('暂停推进，先核对用户要求'); assert.equal(h.state().status, 'paused'); h.session.clearQueue();
  for (const type of ['session_before_fork', 'session_before_tree']) assert.equal((await h.session.extensionRunner.emit({ type })).cancel, true);
  assert.equal(h.execution.calls.length, 1);
});

test('F5 两次真实 session.compact 后恢复完整合同与 checkpoint，reload 保留 run', async t => {
  const h = await host(t); ok(await h.execute());
  ok(await h.call('plan_checkpoint', { decisions: ['保持原始约束'], source_refs: ['plan.md'], next_action: '等待既有 run' }));
  const original = h.state();
  h.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 } });
  for (let i = 0; i < 2; i++) {
    await h.session.prompt('隔离压缩材料。'.repeat(500), { source: 'extension' });
    const compacted = await h.session.compact(); assert.ok(compacted.summary);
    const context = await h.session.extensionRunner.emitContext([]);
    const recovery = context.find(m => m.customType === 'goal-runtime.recovery.v1'); assert.ok(recovery);
    for (const constraint of original.contract.constraints) assert.ok(recovery.content.includes(constraint));
    assert.ok(recovery.content.includes(original.tasks.A.run.runId)); assert.ok(recovery.content.includes('保持原始约束'));
    assert.equal(h.bridge.getSession().compactPending, null); assert.equal(h.bridge.getSession().recoveryPending, false);
  }
  assert.equal((await disk(h.session)).filter(e => e.type === 'compaction').length, 2);
  await h.session.reload(); assert.equal(h.state().binding.contractHash, original.binding.contractHash);
  assert.deepEqual(h.state().binding, original.binding);
  assert.deepEqual(Object.keys(h.state().binding).sort(), ['contractHash', 'planPath', 'repositoryRoot', 'sessionFile', 'sessionId']);
  assert.deepEqual(bindingSemanticInput(h.state().binding), bindingSemanticInput(original.binding));
  assert.deepEqual(h.state().tasks.A.run, original.tasks.A.run); assert.equal(h.execution.calls.length, 1);
  ok(await h.execute()); assert.equal(h.execution.calls.length, 1);
  assert.deepEqual(h.state().binding, original.binding);
});

async function reopened(h, execution = h.execution) {
  const settingsManager = h.session.settingsManager;
  const loader = new sdk.DefaultResourceLoader({ cwd: h.cwd, agentDir: h.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [pi => {
      // Goal 先恢复，package 在稍后的 session_start 才发布服务。
      installGoalRuntime(pi, { config, resolveExecution: id => getPlanExecutionService(pi, id),
        subscribeExecution: (id, listener) => subscribePlanExecutionService(pi, id, listener) });
      let unbind;
      pi.on('session_start', (_event, ctx) => { unbind = bindPlanExecutionService(pi, ctx.sessionManager.getSessionId(), execution); });
      pi.on('session_shutdown', () => unbind?.());
    }] });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: h.cwd, agentDir: h.agentDir, settingsManager,
    modelRuntime: h.session.modelRuntime, model: h.session.model, resourceLoader: loader,
    sessionManager: sdk.SessionManager.open(h.session.sessionFile) });
  await session.bindExtensions({ mode: 'print', onError: error => { throw error; } });
  return session;
}

test('F5 新 Host 实例从同一 session 文件恢复权威引用链，不重派', async t => {
  const h = await host(t); ok(await h.execute());
  h.execution.closeRun(h.state().tasks.A.run); await h.refresh();
  ok(await h.call('plan_verify'));
  assert.equal(h.state().tasks.A.status, 'accepted'); assert.ok(h.state().receipts[0].resultRef.endsWith('#0'));
  const original = h.state();
  assert.ok(h.session.sessionManager.getBranch().some(e => e.type === 'custom' && e.customType === 'goal-runtime.check-result.v1'));
  await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  const fresh = await reopened(h);
  try {
    const result = ok(await fresh.getToolDefinition('plan_status').execute('restart-status', {}, undefined, undefined, fresh.extensionRunner.createToolContext('restart-status')));
    assert.ok(result.state, JSON.stringify(result)); assert.equal(result.state.planId, original.planId); assert.deepEqual(result.state.tasks.A.run, original.tasks.A.run);
    assert.equal(result.storage.writable, true); assert.equal(h.execution.calls.length, 1);
    assert.equal(result.facts[original.tasks.A.run.runId].terminal, 'succeeded');
    assert.equal(result.facts[original.tasks.A.run.runId].integration, 'completed');
  } finally { await fresh.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); fresh.dispose(); }
});

test('T4 多仓库 compact 与新 Host 只恢复固定 binding、旧 run facts 和派生 repoId', async t => {
  const h = await host(t, multiContract({ taskChecks: true }), { repositories: ['repoA', 'repoB'] });
  ok(await h.execute());
  for (const task of Object.values(h.state().tasks)) h.execution.closeRun(task.run);
  await h.refresh();
  ok(await h.call('plan_verify')); ok(await h.call('plan_verify'));
  assert.equal(h.state().status, 'active');
  assert.equal(h.state().receipts[0].subject.kind, 'multi-repository');
  ok(await h.call('plan_checkpoint', {
    task_id: 'A', decisions: ['固定参与仓库'], source_refs: ['plan.md'], next_action: '等待复核',
  }));
  const original = structuredClone(h.state());
  h.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 } });
  await h.session.prompt('多仓库恢复材料。'.repeat(300), { source: 'extension' });
  const compacted = await h.session.compact();
  assert.ok(compacted.summary);
  const context = await h.session.extensionRunner.emitContext([]);
  const recovery = context.find(message => message.customType === 'goal-runtime.recovery.v1');
  assert.ok(recovery.content.includes(original.tasks.B.run.runId));
  assert.ok(recovery.content.includes('multi-repository'));
  assert.equal(h.bridge.getSession().recoveryPending, false);

  await mkdir(join(h.cwd, 'unrelated'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: join(h.cwd, 'unrelated'), stdio: 'ignore' });
  // 首次发现会拒绝该别名；恢复和重入不得重新扫描到它。
  await symlink(join(h.cwd, 'repoA'), join(h.cwd, 'alias'));
  await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  const inspected = [];
  const fresh = await reopened(h, { ...h.execution, async inspect(ref) {
    inspected.push(structuredClone(ref)); return h.execution.inspect(ref);
  } });
  try {
    const result = ok(await fresh.getToolDefinition('plan_status').execute(
      't4-multi-status', {}, undefined, undefined, fresh.extensionRunner.createToolContext('t4-multi-status')),
    );
    assert.deepEqual(result.state.binding, original.binding);
    assert.deepEqual(result.state.tasks, original.tasks);
    assert.deepEqual(result.state.receipts, original.receipts);
    assert.deepEqual(inspected, Object.values(original.tasks).map(task => task.run));
    assert.equal(result.tasks.A.repoId, 'repoA');
    assert.equal(result.tasks.B.repoId, 'repoB');
    assert.equal(result.checkpoint.repoId, 'repoA');
    assert.equal(Object.hasOwn(result.state.tasks.A, 'repoId'), false);
    assert.equal(Object.hasOwn(result.state.checkpoint, 'repoId'), false);
    assert.equal(result.facts[original.tasks.A.run.runId].terminal, 'succeeded');
    assert.equal(result.facts[original.tasks.B.run.runId].integration, 'completed');
    const call = (name, args = {}) => fresh.getToolDefinition(name).execute(name, args, undefined, undefined, fresh.extensionRunner.createToolContext(name));
    assert.deepEqual(ok(await call('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' })).dispatches, []);
    const verified = ok(await call('plan_verify'));
    assert.equal(verified.state.status, 'completed');
    assert.equal(verified.receipts[0].subject.kind, 'multi-repository');
    assert.equal(h.execution.calls.length, 2);
  } finally { await fresh.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); fresh.dispose(); }
});

test('T4 多仓库新 Host 的 inspect 不可用时旧引用不授权 verify、retry 或导航', async t => {
  const h = await host(t, multiContract(), { repositories: ['repoA', 'repoB'] }); ok(await h.execute());
  for (const task of Object.values(h.state().tasks)) h.execution.closeRun(task.run);
  await h.refresh();
  const original = h.state();
  await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  const inspected = [];
  // 服务不可用是 adapter 边界故障；不修改持久 Goal entry、proof 或 receipt。
  const fresh = await reopened(h, { ...h.execution, async inspect(ref) {
    inspected.push(ref);
    if (ref.runId === original.tasks.B.run.runId) throw new Error('受控 execution.inspect 不可用');
    return h.execution.inspect(ref);
  } });
  try {
    const call = (name, args = {}) => fresh.getToolDefinition(name).execute(name, args, undefined, undefined, fresh.extensionRunner.createToolContext(name));
    const status = ok(await call('plan_status'));
    assert.deepEqual(status.state.tasks.B.run, original.tasks.B.run);
    assert.equal(status.state.tasks.B.status, 'blocked');
    assert.equal(status.facts[original.tasks.B.run.runId], undefined);
    assert.equal(status.tasks.B.repoId, 'repoB');
    assert.equal((await call('plan_verify')).details.error.code, 'TERMINAL_NOT_READY');
    assert.equal((await call('plan_retry', { task_id: 'B', message: '未知事实不可重派', expected_revision: status.state.revision })).isError, true);
    await fresh.prompt('/plan cancel');
    inspected.length = 0;
    assert.equal((await fresh.extensionRunner.emit({ type: 'session_before_fork' })).cancel, true);
    assert.deepEqual(inspected, Object.values(original.tasks).map(task => task.run));
    assert.equal(h.execution.calls.length, 2);
  } finally { await fresh.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); fresh.dispose(); }
});

test('F5 真实 append IO 故障已插入 Manager：compact cancel、无假锁、reload 不靠内存解锁', async t => {
  const h = await host(t); ok(await h.execute()); const file = h.session.sessionFile; const backup = `${file}.backup`;
  const before = h.session.sessionManager.getBranch().length;
  await rename(file, backup); await mkdir(file);
  try {
    const result = await h.session.extensionRunner.emit({ type: 'session_before_compact', reason: 'manual', willRetry: false });
    assert.equal(result.cancel, true); assert.ok(h.session.sessionManager.getBranch().length > before);
    assert.equal(h.bridge.getSession().compactPending, null); assert.equal(h.bridge.getSession().store.diagnose().writable, false);
    const rejected = await h.execute(); assert.equal(rejected.isError, true); assert.equal(h.execution.calls.length, 1);
  } finally { await rm(file, { recursive: true, force: true }); await rename(backup, file); }
  await h.session.reload(); assert.equal(h.bridge.getSession().store.diagnose().writable, false);
  assert.equal((await h.execute()).isError, true);
  await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  const fresh = await reopened(h);
  try {
    const restored = ok(await fresh.getToolDefinition('plan_status').execute('fresh-status', {}, undefined, undefined, fresh.extensionRunner.createToolContext('fresh-status')));
    assert.equal(restored.storage.writable, true); assert.equal(h.execution.calls.length, 1);
  } finally { await fresh.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); fresh.dispose(); }
});

test('F6 契约漂移暂停；compact failed 释放临时标记；不变失败指纹触发无进展保护', async t => {
  const h = await host(t); h.execution.fault = 'unknown'; ok(await h.execute());
  const runtime = h.bridge.getSession().runtime;
  for (let i = 0; i < 4; i++) await runtime.recordProgressTurn({ goalContinuation: true, pendingMessages: false });
  assert.equal(h.state().status, 'paused'); assert.match(h.state().pauseReason, /无有效进展/);
  await h.control('resume');
  for (const reason of ['manual', 'threshold', 'overflow']) {
    await h.session.extensionRunner.emit({ type: 'session_before_compact', reason, willRetry: reason === 'overflow' });
    assert.ok(h.bridge.getSession().compactPending);
    await h.session.extensionRunner.emit({ type: 'session_compact_failed', reason, willRetry: reason === 'overflow', error: '受控压缩失败' });
    assert.equal(h.bridge.getSession().compactPending, null);
  }
  const changed = contract(); changed.constraints.push('追加约束'); await writeFile(join(h.cwd, 'plan.md'), block(changed));
  await h.session.extensionRunner.emitContext([]); assert.equal(h.state().status, 'paused'); assert.match(h.state().pauseReason, /源契约/);
  assert.equal(h.execution.calls.length, 1);
});

async function gateHost(t, snapshot, effective = snapshot) {
  const keys = ['PI_CODING_AGENT_DIR', 'PI_SUBAGENT_CHILD', 'PI_SUBAGENT_FANOUT_CHILD'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const base = await openJointSession({ persistent: true, defaultTools: ['bash'], files: async ({ agentDir, cwd }) => {
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'plan.md'), block(contract()));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ ...snapshot, defaultTools: ['bash'], defaultProjectTrust: 'always', enableInstallTelemetry: false, compaction: { enabled: false }, retry: { enabled: false } }));
    await writeFile(join(agentDir, 'goal-runtime.json'), JSON.stringify(config));
  } });
  let session; let revoke; const execution = adapter();
  t.after(async () => {
    try { if (session) { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); } }
    finally { revoke?.(); await base.close(); for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
  process.env.PI_CODING_AGENT_DIR = base.agentDir; delete process.env.PI_SUBAGENT_CHILD; delete process.env.PI_SUBAGENT_FANOUT_CHILD;
  const settingsManager = sdk.SettingsManager.create(base.cwd, base.agentDir);
  const loader = new sdk.DefaultResourceLoader({ cwd: base.cwd, agentDir: base.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [pi => {
      pi.on('session_start', (_event, ctx) => { revoke?.(); revoke = bindPlanExecutionService(pi, ctx.sessionManager.getSessionId(), execution); });
      pi.on('session_shutdown', () => revoke?.());
    }, goalExtension, contextUsage] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  // loader.reload 会重读设置；在 factory 完成后设置 session_start 的权威快照。
  settingsManager.applyOverrides(effective);
  assert.deepEqual(settingsManager.getSettings().goalEngine, effective.goalEngine);
  ({ session } = await sdk.createAgentSession({ cwd: base.cwd, agentDir: base.agentDir, settingsManager, resourceLoader: loader,
    modelRuntime: base.session.modelRuntime, model: base.session.model, sessionManager: base.session.sessionManager }));
  base.session.dispose();
  await session.bindExtensions({ mode: 'print', onError: error => { throw error; } });
  const call = (name, args = {}) => session.getToolDefinition(name).execute(`gate-${name}`, args, undefined, undefined, session.extensionRunner.createToolContext(`gate-${name}`));
  return { ...base, session, execution, call };
}

// 使用合成 provider 的合法 usage 事件产生高占用，未拼写 session message/Goal entry。
async function highUsage(session) {
  session.modelRuntime.registerProvider('goal-high', { api: 'goal-high', apiKey: 'fixture-not-a-secret', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = ai.createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: '合成高占用响应' }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
        usage: { input: 62000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 62001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'start', partial: message }); stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: message.content[0].text, partial: message });
      stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message });
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return stream;
    },
  });
  await session.setModel(session.modelRuntime.getModel('goal-high', 'fixture'));
  await session.prompt('返回高占用观测', { source: 'extension' });
}

test('F10/F9 真实入口四态：关闭三态零注册/激活/可调用/副作用，开启可执行；高占用只读', async t => {
  for (const [label, settings, enabled] of [['false', { goalEngine: { enabled: false } }, false], ['缺失', {}, false], ['非法', { goalEngine: { enabled: 'true' } }, false], ['true', { goalEngine: { enabled: true } }, true]]) {
    await t.test(label, async t => {
      const h = await gateHost(t, settings);
      const sets = [h.session.getAllTools().map(tool => tool.name), h.session.getActiveToolNames(), h.session.getCallableToolNames()].map(names => names.filter(n => n.startsWith('plan_')).sort());
      assert.deepEqual(sets, enabled ? [tools, tools, ['plan_status']] : [[], [], []]);
      await h.session.prompt('建立开关验证会话');
      if (enabled) assert.equal(ok(await h.call('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' })).state.status, 'active');
      const before = goalEntries(await disk(h.session));
      await highUsage(h.session);
      const usage = ok(await h.call('context_usage'));
      assert.equal(usage.status, 'known'); assert.ok(usage.percent > 90); assert.equal(usage.estimated, true); assert.ok(usage.remainingTokens < 4000);
      assert.equal(Object.keys(usage).some(key => /handoff|should/i.test(key)), false);
      const context = await h.session.extensionRunner.emitContext([]);
      if (!enabled) {
        assert.deepEqual(goalEntries(await disk(h.session)), []); assert.deepEqual(before, []);
        assert.equal(context.some(m => String(m.customType).startsWith('goal-runtime.')), false);
        const compact = await h.session.extensionRunner.emit({ type: 'session_before_compact', reason: 'manual', willRetry: false });
        assert.equal(compact?.cancel, undefined); assert.equal(h.execution.calls.length, 0);
      }
      assert.equal(h.session.messages.some(m => m.customType === 'goal-runtime.continue.v1' || /写.*handoff|context-handoff\.md/.test(JSON.stringify(m))), false);
      t.diagnostic(JSON.stringify({ registered: sets[0], active: sets[1], callable: sets[2], sessionId: h.session.sessionId, contextPercent: usage.percent }));
    });
  }
});

test('F10 两阶段错配保持会话不激活；reload 重读关闭与重新开启', async t => {
  const h = await gateHost(t, { goalEngine: { enabled: true } }, { goalEngine: { enabled: false } });
  assert.deepEqual(h.session.getAllTools().map(t => t.name).filter(n => n.startsWith('plan_')).sort(), tools);
  assert.equal((await h.call('plan_status')).details.error.code, 'GOAL_SESSION_NOT_READY');
  await h.session.prompt('错配情况下不激活'); assert.deepEqual(goalEntries(await disk(h.session)), []);
  assert.deepEqual(await h.session.extensionRunner.emitContext([]), []);
  const settingsFile = join(h.agentDir, 'settings.json'); const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(settingsFile, JSON.stringify({ ...settings, goalEngine: { enabled: false } }));
  await h.session.reload(); assert.equal(h.session.getAllTools().some(t => t.name.startsWith('plan_')), false);
  await writeFile(settingsFile, JSON.stringify({ ...settings, goalEngine: { enabled: true } }));
  await h.session.reload(); assert.deepEqual(h.session.getAllTools().map(t => t.name).filter(n => n.startsWith('plan_')).sort(), tools);
  assert.equal(ok(await h.call('plan_status')).state, null);
  assert.equal(ok(await h.call('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' })).state.status, 'active');
});

function bindingInput(h, previousBinding) {
  return { cwd: h.cwd, planPath: 'plan.md', sessionId: h.session.sessionId, sessionFile: h.session.sessionFile, previousBinding };
}

function multiContract(options = {}) {
  const c = contract({ ids: ['A', 'B'], taskChecks: false, ...options });
  for (const task of c.tasks) task.writePaths = [`repo${task.id}/${task.id}.txt`];
  return c;
}

test('T3 scheduler 投影经生产 coding 入口生成同源 workspace policy，分配前受控停止', async t => {
  const c = multiContract(); c.tasks[0].writePaths = ['repoA/repoA/src/**'];
  const h = await host(t, c, { repositories: ['repoA', 'repoB'] }); ok(await h.execute());
  const registered = []; const allocations = [];
  const pi = { events: sdk.createEventBus(), on() {}, registerTool(tool) { registered.push(tool); } };
  createTypedSubagentExtension(pi, { cleanupStore: {},
    rpc: { ping() { assert.fail('受控测试不得进入 RPC/spawn'); } },
    discoverAgents: () => ({ admission: 'repository-configured', agents: [{ name: 'delegate', description: '受控测试' }] }),
    resolveRootSessionId: () => h.session.sessionId,
    resolveCanonicalOrigin: ({ requestedCwd }) => requestedCwd,
    inspectWorkspaceSource: () => ({ originRef: 'refs/heads/main', baseCommit: 'a'.repeat(40) }),
    workspaceService: { ensureAllocated(request) {
      // 只观测生产 codec 的分配请求，不创建 workspace，不伪造 receipt/proof。
      allocations.push(request); throw Object.assign(new Error('已观测 policy，分配前停止'), { code: 'TEST_PREALLOCATE_STOP' });
    } },
  });
  const tool = registered.find(tool => tool.name === 'subagent_start'); assert.ok(tool);
  for (const input of h.execution.calls) {
    const result = await tool.execute(input.dispatchKey, input.request, undefined, undefined, input.ctx);
    assert.equal(result.details.code, 'TEST_PREALLOCATE_STOP');
  }
  assert.equal(allocations.length, 2);
  for (const [index, request] of allocations.entries()) {
    const dispatched = h.execution.calls[index].request;
    assert.deepEqual(request.policy, { publication: 'allowed', application: 'allowed', writePaths: dispatched.writePaths });
    assert.equal(request.originRoot, dispatched.cwd); assert.equal(request.requestedCwd, dispatched.cwd);
    assert.deepEqual(JSON.parse(dispatched.task.split('\n').slice(1).join('\n')).task.writePaths, request.policy.writePaths);
  }
  assert.deepEqual(allocations[0].policy.writePaths, ['repoA/src/**']);
});

for (const outcome of ['failed', 'blocked']) test(`T3 多仓库 ${outcome} 检查保持 fail-closed`, async t => {
  const h = await host(t, multiContract({ fail: outcome === 'failed' }), { repositories: ['repoA', 'repoB'] }); ok(await h.execute());
  for (const task of Object.values(h.state().tasks)) h.execution.closeRun(task.run);
  await h.refresh();
  const ctx = h.session.extensionRunner.createToolContext(`multi-${outcome}`);
  const runtime = createGoalRuntime({ store: h.bridge.getSession().store, execution: h.execution, verify: verifyChecks, captureSubject });
  const verified = await runtime.verify(outcome === 'blocked' ? { ...ctx, tools: [] } : ctx, `multi-${outcome}`);
  assert.equal(verified.receipts[0].outcome, outcome); assert.equal(h.state().status, 'active');
  assert.equal(receiptsAreCurrent(verified.receipts, verified.receipts[0].subject, h.state().binding.contractHash), false);
});

test('T3 双仓库真实检查在超级根执行，未参与兄弟不影响，subject/evidence 精确解码且恢复旧 run', async t => {
  const c = multiContract();
  c.checks[0].command.args = ['-e', 'if(!require("node:fs").existsSync("plan.md"))process.exit(8);console.log("super-root-check")'];
  const h = await host(t, c, { repositories: ['repoB', 'unused', 'repoA'] });
  ok(await h.execute());
  const before = await captureBindingSubject(h.state().binding);
  assert.deepEqual(before.repositories.map(r => r.repoId), ['repoA', 'repoB']);
  const visited = [];
  assert.deepEqual(await captureBindingSubject({ ...h.state().binding, repositories: [...h.state().binding.repositories].reverse() }, async root => {
    visited.push(root); return captureSubject(root);
  }), before);
  assert.deepEqual(visited, h.state().binding.repositories.map(r => r.root));
  await writeFile(join(h.cwd, 'unused', 'noise.txt'), '不参与');
  assert.deepEqual(await captureBindingSubject(h.state().binding), before);
  for (const task of Object.values(h.state().tasks)) h.execution.closeRun(task.run);
  await h.refresh();
  const verified = ok(await h.call('plan_verify'));
  assert.equal(h.state().status, 'completed'); assert.equal(verified.receipts[0].outcome, 'passed');
  assert.equal(receiptsAreCurrent(verified.receipts, before, h.state().binding.contractHash), true);
  const state = h.state();
  const evidence = (await disk(h.session)).find(e => e.id === verified.receipts[0].resultRef.split('#')[0]).data;
  assert.deepEqual(decodeGoalCheckEvidence(evidence), evidence);
  assert.deepEqual(decodeGoalStateSnapshot(state), state);
  assert.equal('repositoryRoot' in verified.receipts[0].subject, false);
  const malformed = [
    s => { s.extra = true; }, s => { s.kind = 'unknown'; }, s => { delete s.kind; },
    s => { s.repositories.reverse(); }, s => { s.repositories = []; },
    s => { s.repositories.push(s.repositories[0]); }, s => { s.repositories[0].extra = true; },
    s => { s.repositories[0].repoId = '../bad'; }, s => { s.inventory = []; },
  ];
  for (const mutate of malformed) {
    const bad = structuredClone(state); mutate(bad.receipts[0].subject);
    assert.throws(() => decodeGoalStateSnapshot(bad), { code: 'SESSION_STATE_CORRUPT' });
    const badEvidence = structuredClone(evidence); mutate(badEvidence.subjectBefore);
    assert.throws(() => decodeGoalCheckEvidence(badEvidence), { code: 'SESSION_STATE_CORRUPT' });
  }
  for (const mutate of [s => s.repositories.pop(), s => { s.repositories[0].repositoryRoot = h.cwd; },
    s => s.repositories.push({ ...s.repositories[0], repoId: 'unused', repositoryRoot: join(h.cwd, 'unused') }),
    s => { delete s.kind; delete s.repositories; Object.assign(s, before.repositories[0]); delete s.repoId; }]) {
    const bad = structuredClone(state); mutate(bad.receipts[0].subject);
    assert.throws(() => decodeGoalStateSnapshot(bad), { code: 'SESSION_STATE_CORRUPT' });
    const badEvidence = structuredClone(evidence); mutate(badEvidence.subjectAfter);
    await assert.rejects(h.bridge.getSession().store.writeEvidence(badEvidence), { code: 'SESSION_STATE_CORRUPT' });
  }
  await h.session.reload();
  assert.deepEqual(h.state(), state); assert.equal(h.execution.calls.length, 2);
});

test('T3 检查期间 writePaths 外的参与仓库变化整批 stale，证据定位 repoId，复验通过', async t => {
  const c = multiContract();
  c.checks[0].command.args = ['-e', 'require("node:fs").writeFileSync("repoB/outside-scope.txt","drift")'];
  const h = await host(t, c, { repositories: ['repoA', 'repoB'] }); ok(await h.execute());
  for (const task of Object.values(h.state().tasks)) h.execution.closeRun(task.run);
  await h.refresh();
  const verified = ok(await h.call('plan_verify'));
  assert.equal(verified.receipts[0].outcome, 'stale'); assert.equal(h.state().status, 'active');
  assert.match(verified.evidence[0].blockedReason, /repoB/);
  const evidence = (await disk(h.session)).find(e => e.id === verified.receipts[0].resultRef.split('#')[0]).data;
  assert.deepEqual(compareSubjects(evidence.subjectBefore, evidence.subjectAfter), { equal: false, driftedRepoIds: ['repoB'] });
  assert.equal(receiptsAreCurrent(verified.receipts, evidence.subjectAfter, h.state().binding.contractHash), false);
  assert.equal(ok(await h.call('plan_verify')).receipts[0].outcome, 'passed'); assert.equal(h.state().status, 'completed');
});

for (const captureNumber of [1, 2]) test(`T3 scheduler 第 ${captureNumber} 次完成捕获使用共享比较，repoB 漂移不完成`, async t => {
  const h = await host(t, multiContract(), { repositories: ['repoA', 'repoB'] }); ok(await h.execute());
  for (const task of Object.values(h.state().tasks)) h.execution.closeRun(task.run);
  await h.refresh();
  let round = 0;
  const roots = [];
  const runtime = createGoalRuntime({ store: h.bridge.getSession().store, execution: h.execution, verify: verifyChecks,
    captureSubject: async root => {
      roots.push(root);
      if (root === h.state().binding.repositories[0].root && ++round === captureNumber) await writeFile(join(h.cwd, 'repoB', 'outside-scope.txt'), 'drift');
      return captureSubject(root);
    } });
  const ctx = h.session.extensionRunner.createToolContext(`completion-${captureNumber}`);
  const verified = await runtime.verify(ctx, `completion-${captureNumber}`);
  assert.deepEqual(verified.driftedRepoIds, ['repoB']); assert.equal(h.state().status, 'active');
  assert.equal(verified.receipts[0].outcome, 'passed');
  assert.equal(h.state().receipts.length, captureNumber === 1 ? 0 : 1);
  assert.deepEqual(roots, Array.from({ length: captureNumber }, () => h.state().binding.repositories.map(r => r.root)).flat());
});

test('T3 多仓库持久 run reload 后 retry 按原合同重派；cancelled 替换重算参与集合', async t => {
  const c = multiContract(); const h = await host(t, c, { repositories: ['repoA', 'repoB'] }); ok(await h.execute());
  const original = h.state();
  h.execution.closeRun(original.tasks.A.run, { terminal: 'failed' });
  h.execution.closeRun(original.tasks.B.run);
  await h.refresh(); await h.session.reload();
  const retry = ok(await h.call('plan_retry', { task_id: 'A', message: '只修复 repoA 原声明路径', expected_revision: h.state().revision }));
  assert.equal(retry.dispatch.outcome, 'bound'); assert.equal(h.state().tasks.A.attempt, 2);
  assert.equal(h.execution.calls[2].request.cwd, original.binding.repositories[0].root);
  assert.deepEqual(h.execution.calls[2].request.writePaths, ['A.txt']);
  assert.deepEqual(h.state().contract, c); assert.deepEqual(h.state().binding, original.binding);
  await h.control('cancel');
  const next = multiContract({ ids: ['B'] }); next.objective = '仅 repoB 的替换计划';
  await writeFile(join(h.cwd, 'next.md'), block(next));
  const replace = () => h.call('plan_execute', { plan_path: 'next.md', mode: 'subagent-driven' });
  assert.equal((await replace()).details.error.code, 'GOAL_CANCELLED_REPLACEMENT_REQUIRED');
  h.execution.closeRun(h.state().tasks.A.run);
  const replaced = ok(await replace()); assert.notEqual(replaced.state.planId, original.planId);
  assert.deepEqual(replaced.state.binding.repositories.map(r => r.repoId), ['repoB']);
  assert.equal(h.execution.calls[3].request.cwd, original.binding.repositories[1].root);
  assert.deepEqual(h.execution.calls[3].request.writePaths, ['B.txt']);
  assert.ok((await disk(h.session)).some(e => e.data?.planId === original.planId && e.data.status === 'cancelled'));
});

test('T3 多仓库真实持久 dispatch intent 恢复保留 unknown 且禁止 retry/重派', async t => {
  const h = await host(t, multiContract(), { repositories: ['repoA', 'repoB'] }); h.execution.fault = 'unknown';
  assert.deepEqual(ok(await h.execute()).dispatches.map(d => d.outcome), ['unknown', 'unknown']);
  const original = h.state();
  assert.ok((await disk(h.session)).some(e => e.data?.tasks?.A?.dispatchKey && e.data.tasks.A.run === null));
  await h.session.reload(); assert.deepEqual(ok(await h.execute()).dispatches, []);
  for (const [id, task] of Object.entries(h.state().tasks)) {
    assert.deepEqual({ ...task, blocker: original.tasks[id].blocker }, original.tasks[id]);
    assert.match(task.blocker, /intent 尚无权威 run 绑定，禁止重派/);
  }
  assert.equal(h.execution.calls.length, 2);
  assert.equal((await h.call('plan_retry', { task_id: 'A', message: '禁止未知重派', expected_revision: h.state().revision })).details.error.code, 'UNKNOWN_DISPATCH');
});

test('T0/T3 真实 Git 发现 23 根，仅绑定两个参与仓库；投影派发与持久 run 恢复不重派', async t => {
  const c = contract({ ids: ['A', 'B'] });
  c.tasks[0].writePaths = ['repo0/repo0/src/**']; c.tasks[1].writePaths = ['repo1/B.txt'];
  const h = await host(t, c, { repositories: Array.from({ length: 23 }, (_, i) => `repo${i}`) });
  const { binding, contract: decoded } = await resolvePlanBinding(bindingInput(h), h.api.exec.bind(h.api));
  assert.deepEqual(binding.repositories.map(r => r.repoId), ['repo0', 'repo1']);
  assert.deepEqual(Object.keys(binding).sort(), ['contractHash', 'planPath', 'repositories', 'repositoryRoot', 'sessionFile', 'sessionId']);
  const identity = await resolveRepositoryIdentity(join(h.cwd, 'repo0'));
  assert.equal(binding.repositories[0].repositoryId, identity.repositoryId);
  assert.equal(binding.repositories[0].storageRepositoryId, identity.storageRepositoryId);
  assert.equal(binding.repositoryRoot, await realpath(h.cwd));
  assert.deepEqual(resolveTaskRepository(decoded.tasks[0], binding.repositories).writePaths, ['repo0/src/**']);
  const started = ok(await h.execute());
  assert.deepEqual(started.dispatches.map(d => d.outcome), ['bound', 'bound']);
  const state = h.state();
  for (const [index, input] of h.execution.calls.entries()) {
    const projection = resolveTaskRepository(decoded.tasks[index], binding.repositories);
    assert.equal(input.request.cwd, projection.root);
    assert.deepEqual(input.request.writePaths, projection.writePaths);
    const prompt = JSON.parse(input.request.task.split('\n').slice(1).join('\n'));
    assert.deepEqual(prompt.task.writePaths, projection.writePaths);
    assert.deepEqual(prompt.task.acceptance, decoded.tasks[index].acceptance);
  }
  assert.deepEqual(state.contract, decoded); assert.equal(hashPlanContract(state.contract), binding.contractHash);
  await mkdir(join(h.cwd, 'new-sibling'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: join(h.cwd, 'new-sibling'), stdio: 'ignore' });
  const again = await resolvePlanBinding(bindingInput(h), h.api.exec.bind(h.api));
  assert.deepEqual(bindingSemanticInput(again.binding), bindingSemanticInput(binding));
  // 新增非法别名会使首次发现拒绝；固定记录恢复完全不查看该兄弟目录。
  await symlink(join(h.cwd, 'repo0'), join(h.cwd, 'alias'));
  await assert.rejects(resolvePlanBinding(bindingInput(h), h.api.exec.bind(h.api)), { code: 'GOAL_REPOSITORY_TOPOLOGY_INVALID' });
  const restored = await resolvePlanBinding(bindingInput(h, binding), h.api.exec.bind(h.api));
  assert.deepEqual(bindingSemanticInput(restored.binding), bindingSemanticInput(binding));

  const onDisk = (await disk(h.session)).findLast(e => e.data?.planId === state.planId);
  assert.deepEqual(onDisk.data.binding, binding);
  const reopenedStore = createGoalStateStore({ sessionId: h.session.sessionId, sessionFile: h.session.sessionFile,
    readBranch: () => h.session.sessionManager.getBranch(), appendEntry: () => assert.fail('恢复不得写盘') });
  const restoredState = await reopenedStore.restore();
  assert.deepEqual(restoredState.binding, binding); assert.deepEqual(restoredState.contract, decoded);
  assert.deepEqual(restoredState.tasks, state.tasks);
  await h.session.reload(); ok(await h.execute());
  assert.equal(h.execution.calls.length, 2); assert.deepEqual(h.state().tasks, state.tasks);
  const changed = structuredClone(binding); changed.repositories[0].repositoryId = '0'.repeat(64);
  await assert.rejects(resolvePlanBinding(bindingInput(h, changed), h.api.exec.bind(h.api)), { code: 'GOAL_REPOSITORY_IDENTITY_CHANGED' });
  await rename(join(h.cwd, 'repo0'), join(h.cwd, 'moved-repo0'));
  await assert.rejects(resolvePlanBinding(bindingInput(h, binding), h.api.exec.bind(h.api)), { code: 'GOAL_REPOSITORY_TOPOLOGY_INVALID' });
});

test('T0 绑定入口拒绝无前缀、跨仓库、嵌套根和指向超级根外的路径别名', async t => {
  const c = contract(); c.tasks[0].writePaths = ['repoA/src/**'];
  const h = await host(t, c, { repositories: ['repoA', 'repoB'] });
  for (const [paths, code] of [[['A.txt'], 'GOAL_REPOSITORY_PREFIX_REQUIRED'],
    [['repoA/a', 'repoB/b'], 'GOAL_REPOSITORY_CROSS_TASK'], [['repoA/../b'], 'INVALID_PATH'],
    [['repoA/**'], 'GOAL_REPOSITORY_PATH_INVALID']]) {
    const invalid = structuredClone(c); invalid.tasks[0].writePaths = paths;
    await writeFile(join(h.cwd, 'plan.md'), block(invalid));
    assert.equal((await h.execute()).details.error.code, code);
    assert.equal(h.state(), null); assert.equal(h.execution.calls.length, 0);
  }
  await mkdir(join(h.cwd, 'nested', 'inside'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: join(h.cwd, 'nested', 'inside'), stdio: 'ignore' });
  c.tasks[0].writePaths = ['nested/inside/a']; await writeFile(join(h.cwd, 'plan.md'), block(c));
  assert.equal((await h.execute()).details.error.code, 'GOAL_REPOSITORY_NOT_FOUND');
  const outside = join(h.agentDir, 'outside-repository'); await mkdir(outside);
  execFileSync('git', ['init', '-b', 'main'], { cwd: outside, stdio: 'ignore' });
  await symlink(outside, join(h.cwd, 'outside'));
  c.tasks[0].writePaths = ['outside/a']; await writeFile(join(h.cwd, 'plan.md'), block(c));
  assert.equal((await h.execute()).details.error.code, 'GOAL_REPOSITORY_TOPOLOGY_INVALID');
  assert.equal(h.state(), null); assert.equal(h.execution.calls.length, 0);
});
