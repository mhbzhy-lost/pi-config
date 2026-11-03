// 计划 T6（缺陷③）：resume 非 actionable 的一行 info 提示 + auto-pause 提示去重。
// 复用 test/helpers/joint-upgrade-session.mjs 真实 Host harness，经 extensionRunner.setUIContext
// 换上 notify 投影 spy 断言 ctx.ui.notify 调用；同时断言 notify 不落 session transcript、
// 既有 JSON 状态输出结构不变。
// 注意：worktree 环境若未物化 node_modules，可用 PI_TEST_CODING_AGENT_ROOT 指向物理 Host 包。
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openJointSession } from './helpers/joint-upgrade-session.mjs';
import { installGoalRuntime } from '../src/goal-runtime/index.ts';

const config = { enabled: true, maxConcurrentTasks: 2, maxNoProgressTurns: 3 };
const AUTO_PAUSE_TEXT = 'Goal 已因新用户消息自动暂停；/plan resume 恢复';
const RESUME_IDLE_MARK = '无需重复 resume';
const STATUS_JSON_KEYS = ['blockedReason', 'checkpoint', 'facts', 'guidance', 'next', 'state', 'storage', 'tasks'];

function contract({ ids = ['A'], taskChecks = false } = {}) {
  return { schema: 'goal-runtime.plan.v1', objective: '隔离 Host 验证', constraints: ['只能修改声明路径', '不得访问真实凭据', '检查只读'],
    resources: [{ id: 'slot', capacity: 2 }],
    checks: [{ id: 'C', statement: '良性本地命令退出零', command: { executable: process.execPath, args: ['-e', 'console.log("goal-check-ok")'], timeoutSeconds: 5 }, repairTaskIds: ids }],
    tasks: ids.map(id => ({ id, agent: 'delegate', task: `读取临时输入并交付 ${id}；越界即停止。`, deps: [], writePaths: [`${id}.txt`], resources: ['slot'], acceptance: { criteria: ['完成声明任务'] }, checkIds: taskChecks ? ['C'] : [] })),
    terminalCheckIds: ['C'] };
}
const block = c => `<!-- goal-runtime-contract:start -->\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\`\n<!-- goal-runtime-contract:end -->`;
const ok = result => { assert.notEqual(result.isError, true, JSON.stringify(result.details)); return result.details; };

// 主管批准的 adapter 边界双打（同 goal-runtime-runtime.integration.mjs 形态）；引用不代表官方 proof 或真实 workspace。
function adapter() {
  const calls = []; const facts = new Map(); const listeners = new Set();
  let fault = null;
  return { calls, facts, listeners,
    set fault(value) { fault = value; },
    async start(input) {
      calls.push(input);
      if (fault === 'unknown') throw new Error('受控故障：调用后无法确认是否启动');
      const run = { runId: `notify-run-${calls.length}`, workspaceId: `notify-workspace-${calls.length}`, rootSessionId: input.ctx.sessionManager.getSessionId() };
      await input.onAllocated(run.workspaceId);
      facts.set(run.runId, { run, terminal: 'pending', terminalProofRef: null, integration: 'pending', integrationReceiptRef: null, workspaceState: 'active', recovery: 'none', wakeup: 'subscribed', blocker: null });
      await input.onBound(run); return run;
    },
    async resume(input) { throw new Error('本轮不模拟新进程授权的 typed resume 成功'); },
    async inspect(ref) { assert.ok(facts.has(ref.runId)); return structuredClone(facts.get(ref.runId)); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    closeRun(run) {
      facts.set(run.runId, { run, terminal: 'succeeded', terminalProofRef: `notify-proof:${run.runId}`, integration: 'completed', integrationReceiptRef: `notify-integration:${run.runId}`, workspaceState: 'released', recovery: 'none', wakeup: 'subscribed', blocker: null });
    },
  };
}

async function host(t, c = contract()) {
  const execution = adapter(); let bridge;
  const h = await openJointSession({ persistent: true, defaultTools: ['bash'], factories: [pi => {
    bridge = installGoalRuntime(pi, { config, resolveExecution: () => execution });
  }], files: async ({ cwd }) => {
    await mkdir(cwd, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'plan.md'), block(c));
  } });
  t.after(() => h.close());
  const call = async (name, args = {}) => {
    const id = `notify-${name}-${Date.now()}`;
    return h.session.getToolDefinition(name).execute(id, args, undefined, undefined, h.session.extensionRunner.createToolContext(id));
  };
  await h.session.prompt('建立隔离测试会话');
  return { ...h, execution, get bridge() { return bridge; },
    state: () => bridge.getSession().store.read(),
    execute: () => call('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' }),
    async control(command) { await h.session.prompt(`/plan ${command}`); } };
}

/** 捕获 ctx.ui.notify：runner.setUIContext 换上独立 spy 对象，不改写共享 noOp 单例、不进入 transcript。 */
function spyNotify(h) {
  const notifications = [];
  const runner = h.session.extensionRunner;
  runner.setUIContext({ ...runner.getUIContext(), notify: (message, level) => notifications.push({ message, level }) }, 'print');
  return notifications;
}
const jsonEntries = notify => notify.filter(n => n.message.trimStart().startsWith('{'));

test('resume 后 next=wait：一行 info 提示含原因文案，既有 JSON 状态输出保留', async t => {
  const h = await host(t);
  const notify = spyNotify(h);
  ok(await h.execute());
  assert.equal(h.state().tasks.A.status, 'running');
  await h.control('pause');
  assert.equal(h.state().status, 'paused');
  notify.length = 0;
  await h.control('resume');
  assert.equal(h.state().status, 'active');
  const line = notify.find(n => n.message.includes(RESUME_IDLE_MARK));
  assert.ok(line, `应输出一行 resume 无可推进事实提示；实际：${JSON.stringify(notify)}`);
  assert.equal(line.level, 'info');
  assert.ok(line.message.includes('已恢复'), line.message);
  assert.ok(line.message.includes('等待已订阅的权威运行或集成事实变化'), `提示须含 wait 原因文案：${line.message}`);
  assert.ok(!line.message.includes('\n'), '提示必须是一行');
  const json = jsonEntries(notify);
  assert.equal(json.length, 1, `既有 JSON 状态输出应保留一次；实际：${JSON.stringify(notify)}`);
  const parsed = JSON.parse(json[0].message);
  assert.equal(parsed.next.kind, 'wait');
  assert.deepEqual(Object.keys(parsed).sort(), STATUS_JSON_KEYS);
});

test('resume 后 next=blocked：一行 info 提示含阻塞原因', async t => {
  const h = await host(t);
  const notify = spyNotify(h);
  h.execution.fault = 'unknown';
  ok(await h.execute());
  assert.equal(h.state().tasks.A.status, 'blocked');
  await h.control('pause');
  notify.length = 0;
  await h.control('resume');
  const line = notify.find(n => n.message.includes(RESUME_IDLE_MARK));
  assert.ok(line, `应输出一行 resume 阻塞提示；实际：${JSON.stringify(notify)}`);
  assert.equal(line.level, 'info');
  assert.ok(line.message.includes('已恢复'), line.message);
  assert.ok(line.message.includes('未完成／阻塞'), `提示须含 blocked 原因文案：${line.message}`);
  assert.ok(!line.message.includes('\n'), '提示必须是一行');
  const json = jsonEntries(notify);
  assert.equal(json.length, 1, `既有 JSON 状态输出应保留一次；实际：${JSON.stringify(notify)}`);
  assert.equal(JSON.parse(json[0].message).next.kind, 'blocked');
});

test('resume 后 next=advance：不输出无可推进事实提示，JSON 状态输出保留', async t => {
  const c = contract({ ids: ['A', 'B'] }); c.tasks[1].deps = ['A'];
  const h = await host(t, c);
  const notify = spyNotify(h);
  ok(await h.execute());
  assert.equal(h.state().tasks.A.status, 'running');
  await h.control('pause');
  h.execution.closeRun(h.state().tasks.A.run);
  notify.length = 0;
  await h.control('resume');
  assert.equal(h.state().tasks.A.status, 'accepted');
  assert.ok(!notify.some(n => n.message.includes(RESUME_IDLE_MARK)), `actionable 时不得提示；实际：${JSON.stringify(notify)}`);
  const json = jsonEntries(notify);
  assert.equal(json.length, 1, `既有 JSON 状态输出应保留一次；实际：${JSON.stringify(notify)}`);
  assert.equal(JSON.parse(json[0].message).next.kind, 'advance');
});

test('auto-pause 提示：同一 pauseReason 只提示一次；resume 成功后去重重置；notify 不进 transcript', async t => {
  const h = await host(t);
  const notify = spyNotify(h);
  ok(await h.execute());
  notify.length = 0;
  await h.session.prompt('第一条用户消息：验证自动暂停提示');
  assert.equal(h.state().status, 'paused');
  const first = notify.filter(n => n.message === AUTO_PAUSE_TEXT);
  assert.equal(first.length, 1, `首条用户消息应提示一次自动暂停；实际：${JSON.stringify(notify)}`);
  assert.equal(first[0].level, 'info');
  await h.session.prompt('第二条用户消息：计划已暂停，不应重复提示');
  assert.equal(notify.filter(n => n.message === AUTO_PAUSE_TEXT).length, 1, '同一 pauseReason 不重复提示');
  const raw = await readFile(h.session.sessionFile, 'utf8');
  assert.ok(!raw.includes(AUTO_PAUSE_TEXT), 'notify 不得进入 session transcript');
  await h.control('resume');
  assert.equal(h.state().status, 'active');
  notify.length = 0;
  await h.session.prompt('第三条用户消息：验证去重状态已重置');
  assert.equal(h.state().status, 'paused');
  assert.equal(notify.filter(n => n.message === AUTO_PAUSE_TEXT).length, 1, 'resume 成功后去重重置，再次自动暂停应重新提示一次');
});
