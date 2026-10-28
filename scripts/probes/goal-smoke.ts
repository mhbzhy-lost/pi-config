#!/usr/bin/env node
// 真实 provider 冒烟：所有运行态资源限于临时根，可保留现场供归因。
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, chmod, writeFile, readFile, readdir, symlink, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const model = 'qoder-pool/DeepSeek-Flash';
const scenarios = ['positive', 'repair', 'replace', 'resume', 'compact', 'multi-parallel', 'multi-tools', 'multi-invalid', 'multi-compact'];
const keepArtifacts = process.argv.includes('--keep-artifacts');
const selected = process.argv.includes('--scenario') ? process.argv[process.argv.indexOf('--scenario') + 1] : 'all';
if (process.argv.includes('--help')) {
  console.log(`用法：node scripts/probes/goal-smoke.ts [--scenario all|${scenarios.join('|')}] [--keep-artifacts]\n实际模型：qoder-pool/DeepSeek-Flash。真实付费调用；每场景独立沙箱；失败无条件保留现场，成功默认清理。`);
  process.exit(0);
}
assert.ok(selected === 'all' || scenarios.includes(selected), '未知场景');
if (selected === 'all') {
  for (const scenario of scenarios) {
    const child = spawn(process.execPath, [import.meta.filename, '--scenario', scenario, ...(keepArtifacts ? ['--keep-artifacts'] : [])], { stdio: 'inherit' });
    const code = await new Promise<number>(done => child.once('close', code => done(code ?? 1)));
    if (code !== 0) process.exit(code);
  }
  process.exit(0);
}
const multi = selected.startsWith('multi-');
type Json = Record<string, any>;
// package 按自身 tsconfig 检查；探针只消费公开运行时出口。
const adminEntry = 'pi-subagents-enhanced/workspace/admin';
const auditManagedWorkspaces: (options: { stateRoot: string; originRoot: string }) => Json = (await import(adminEntry)).auditManagedWorkspaces;
const evidence: Json[] = [];
const emit = (type: string, data: Json) => { const event = { type, at: new Date().toISOString(), ...data }; evidence.push(event); console.log(JSON.stringify(event)); };
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const root = await realpath(await mkdtemp(join(tmpdir(), 'goal-smoke-')));
await chmod(root, 0o700);
const agent = join(root, 'agent');
const cwd = join(root, multi ? 'super-root' : 'repository');
const origins = multi ? ['repoA', 'repoB'].map(id => join(cwd, id)) : [cwd];
const hostRoot = join(repo, 'node_modules/@earendil-works/pi-coding-agent');
const cli = process.env.PI_REAL_BIN || join(hostRoot, 'dist/cli.js');
const hosts: Rpc[] = [];
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  interrupted = true;
  for (const host of hosts) if (host.child.exitCode === null) host.child.kill('SIGTERM');
});
let failed = false;
let currentScenario = 'setup';
const env: NodeJS.ProcessEnv = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
  XDG_CONFIG_HOME: join(root, 'home/config'), XDG_STATE_HOME: join(root, 'home/state'),
  PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
  PI_CODING_WORKSPACE_DIR: join(root, 'workspaces'), PI_SESSION_OWNER_REGISTRY: join(root, 'registry'),
  PI_PACKAGE_DIR: hostRoot, PI_REAL_BIN: cli, PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: hostRoot,
  PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Goal Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'Goal Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
};
const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

class Rpc {
  child: ChildProcessWithoutNullStreams;
  records: Json[] = [];
  buffer = '';
  stderr = '';
  ordinal = 0;
  closed: Promise<void>;
  scenario = currentScenario;
  constructor(session?: string) {
    const args = [cli, '--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--approve',
      '-e', join(repo, 'packages/pi-subagents-enhanced/extensions/subagent-runtime.ts'),
      '-e', join(repo, 'pi/extensions/goal-runtime.ts'), '-e', join(root, 'observe.ts'),
      '--provider', 'qoder-pool', '--model', model, '--thinking', 'off',
      '--append-system-prompt', '这是获授权的临时仓库真实冒烟。只按用户要求调用 plan 工具。task 为 running 时若 next 为 wait 或事实暂不齐的 blocked，直接输出等待并结束本轮，禁止循环查询或重复 execute/verify；真实通知会唤醒。task 为 verifying 时严格按 guidance 的 check_ids 调用 plan_verify；仅全部 accepted 后可无参终态 verify。不得自己写业务文件，不派计划外任务，不绕过 blocked。回答尽量简短。'];
    if (session) args.push('--session', session);
    this.child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.closed = new Promise(done => this.child.once('close', () => done()));
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const event = JSON.parse(line); this.records.push(event);
          if (event.type === 'tool_execution_end') emit('tool', { scenario: currentScenario, toolName: event.toolName, isError: event.isError ?? event.result?.isError ?? false, details: event.toolName?.startsWith('plan_') ? event.result?.details : undefined });
          if (event.type === 'extension_error') emit('extension_error', { error: event.error, extensionPath: event.extensionPath });
        } catch { /* 非 JSON 启动提示不作为回执。 */ }
      }
    });
    hosts.push(this);
  }
  async budget() {
    const events = (await readFile(join(root, 'children.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const callsByPid = new Map<number, number>();
    for (const event of events) if (event.type === 'assistant') callsByPid.set(event.pid, (callsByPid.get(event.pid) ?? 0) + 1);
    for (const [pid, calls] of callsByPid) assert.ok(calls <= 6, `CHILD_BUDGET_EXCEEDED pid=${pid} calls=${calls}`);
    assert.ok(hosts.filter(host => host.scenario === this.scenario).reduce((n, host) => n + host.records.filter(r => r.type === 'message_end' && r.message?.role === 'assistant').length, 0) <= 16, '主模型调用预算超过 16，停止场景');
  }
  async wait(predicate: (r: Json) => boolean, timeout = 30000, offset = 0): Promise<Json> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await this.budget();
      const result = this.records.slice(offset).find(predicate); if (result) return result;
      const modelFailure = this.records.find(r => r.type === 'message_end' && r.message?.role === 'assistant' && r.message?.stopReason === 'error');
      if (modelFailure) throw Error(`MODEL_FAILED ${modelFailure.message.errorMessage ?? 'provider error'}`);
      assert.equal(this.child.exitCode, null, `Host 提前退出：${this.stderr}`);
      await pause(100);
    }
    throw new Error(`RPC_TIMEOUT：${currentScenario}；${this.stderr}`);
  }
  async send(type: string, data: Json = {}, timeout = 30000): Promise<any> {
    const id = `smoke-${++this.ordinal}`;
    this.child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n');
    const reply = await this.wait(r => r.type === 'response' && r.id === id, timeout);
    assert.equal(reply.success, true, JSON.stringify(reply)); return reply.data;
  }
  async snapshot(run?: Json): Promise<Json> {
    const { entries } = await this.send('get_entries');
    const latest = entries.findLast((item: Json) => item.customType === 'goal-runtime.state.v1');
    await this.send('prompt', { message: '/smoke-observe' + (run ? ' ' + JSON.stringify(run) : '') });
    const observation = JSON.parse(await readFile(join(root, 'observation.json'), 'utf8'));
    return { ...observation, state: latest?.data, entryIds: entries.filter((entry: Json) => entry.customType?.startsWith('goal-runtime.')).map((entry: Json) => ({ id: entry.id, customType: entry.customType, planId: entry.data?.planId })) };
  }
  async settled(timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await this.send('get_state');
      if (!state.isStreaming && state.pendingMessageCount === 0) return;
      await pause(250);
    }
    throw Error('HOST_SETTLE_TIMEOUT');
  }
  async goalUntil(predicate: (snapshot: Json) => boolean, controlled = false): Promise<Json> {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      assert.equal(interrupted, false, 'SMOKE_INTERRUPTED');
      const snapshot = await this.snapshot();
      if (predicate(snapshot)) { emit('goal_receipt', { scenario: currentScenario, ...snapshot }); return snapshot; }
      if (snapshot.state?.status === 'completed') throw Error('SCENARIO_PRECONDITION_MISSED：计划已完成但未满足所选场景的观察条件');
      const error = this.records.find(r => r.type === 'extension_error' || (r.type === 'tool_execution_end' && r.result?.isError && /^(plan_|subagent_start|subagent_run_resume)/.test(r.toolName) && !['TERMINAL_NOT_READY','GOAL_NOT_ACTIVE'].includes(r.result?.details?.error?.code)));
      if (error) throw Error(`HOST_TOOL_FAILED ${JSON.stringify(error)}`);
      if (!controlled && (snapshot.state?.status === 'blocked' || snapshot.state?.status === 'paused' || Object.values(snapshot.state?.tasks ?? {}).some((task: any) => task.status === 'blocked'))) throw Error(`GOAL_BLOCKED ${JSON.stringify(snapshot)}`);
      await pause(250);
    }
    throw Error('GOAL_TIMEOUT');
  }
  async close() {
    if (this.child.exitCode !== null) return;
    try { await this.send('abort', {}, 5000); this.child.stdin.end(); } catch { this.child.kill('SIGTERM'); }
    await Promise.race([this.closed, pause(5000)]);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
    await this.closed;
    emit('host_exit', { pid: this.child.pid, exitCode: this.child.exitCode, signal: this.child.signalCode });
    // 子进程可能由上游 detached；额外进程清理在外层按临时路径匹配。
    try { process.kill(-this.child.pid!, 'SIGKILL'); } catch { /* 已退出。 */ }
  }
}

function plan(name: string, repair = false, single = false) {
  const tasks = (single ? ['A'] : ['A', 'B']).map((id, index) => ({
    id, agent: 'delegate', task: `只创建 ${name}-${id}.txt，内容为 ${repair ? 'bad（首派必须保留这个故意失败的值，不提前修复；未来只有收到明确修复指导才修改）' : id} 加换行。用户已授权在这个临时 worktree 中执行且必须成功运行：printf '${repair ? 'bad' : id}\\n' > ${name}-${id}.txt && git add ${name}-${id}.txt && git commit -m 'feat: 添加冒烟标记' && test -z "$(git status --porcelain)"。只执行这一条 bash，然后输出 acceptance-report；不要停在文件写入、不修改计划、不运行其他业务。Auto Integration 自主发布。失败即停止。`,
    deps: index ? ['A'] : [], writePaths: [`${name}-${id}.txt`], resources: ['writer'],
    acceptance: { criteria: [`${name}-${id}.txt 内容正确且已提交，git status --porcelain 为空`] }, checkIds: [`check-${id}`],
  }));
  return { schema: 'goal-runtime.plan.v1', objective: '临时仓库真实冒烟', constraints: ['仅允许修改各任务指定文件。用户明确授权临时仓库提交，禁止访问其他仓库或凭据。'], resources: [{ id: 'writer', capacity: 1 }], tasks,
    checks: tasks.map(task => ({ id: `check-${task.id}`, statement: '只读核验文件内容', command: { executable: process.execPath, args: ['-e', `process.exit(require('node:fs').readFileSync('${name}-${task.id}.txt','utf8')===${JSON.stringify((repair ? 'fixed' : task.id) + '\n')}?0:7)`], timeoutSeconds: 10 }, repairTaskIds: [task.id] })),
    terminalCheckIds: tasks.map(task => `check-${task.id}`) };
}
async function execute(host: Rpc, name: string, guidance = '') {
  await host.send('prompt', { streamingBehavior: 'followUp', message: `用户明确授权执行 ${name}.md 的全部任务。现在调用 plan_execute，plan_path=${name}.md，mode=subagent-driven。${guidance}之后按 Goal 通知调用 plan_verify/plan_execute 直至 completed；检查失败必须停止等待指导，不自动 retry。` });
}
function assertDelivered(snapshot: Json) {
  for (const [id, fact] of Object.entries(snapshot.facts) as [string, Json][]) {
    assert.equal(fact.terminal, 'succeeded', id); assert.ok(fact.terminalProofRef, id);
    assert.equal(fact.integration, 'completed', id); assert.ok(fact.integrationReceiptRef, id);
    assert.equal(fact.workspaceState, 'released', id);
  }
}
function audit(snapshot?: Json) {
  for (const originRoot of origins) {
    const result = auditManagedWorkspaces({ stateRoot: join(root, 'workspaces'), originRoot });
    emit('workspace_audit', { originRoot, ...result });
    if (!snapshot) continue;
    for (const item of result.inventory.workspaces) {
      const receipt = item.receipt;
      const task = Object.values(snapshot.state.tasks).find((task: any) => task.run?.runId === receipt.run?.runId) as Json | undefined;
      if (!task) continue;
      assert.equal(receipt.state, 'released'); assert.ok(receipt.leaseId);
      assert.equal(receipt.owner.rootSessionId, snapshot.sessionId);
      assert.equal(receipt.workspaceId, task.run.workspaceId);
      if (multi) {
        const binding: Json | undefined = snapshot.state.binding.repositories.find((item: Json) => item.root === originRoot);
        assert.ok(binding); assert.equal(result.coordinator.repositoryId, binding.repositoryId);
        assert.ok(receipt.policy.writePaths.every((path: string) => !path.startsWith('repoA/') && !path.startsWith('repoB/')));
      }
      const queue = result.queue.items.find((item: Json) => item.childRunId === receipt.run.runId);
      assert.ok(queue); assert.equal(queue.state, 'completed');
    }
  }
}
async function assertParallel(snapshot: Json) {
  const events = (await readFile(join(root, 'children.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const spans = Object.entries(snapshot.state.tasks).map(([id, task]: [string, any]) => {
    const start = events.find(e => e.type === 'child_start' && e.sessionFile.includes(task.run.runId));
    assert.ok(start, `缺少 ${id} child_start`);
    const end = events.find(e => e.pid === start.pid && e.type === 'child_shutdown');
    assert.ok(end, `缺少 ${id} child_shutdown`);
    return { taskId: id, runId: task.run.runId, pid: start.pid, start: start.at, end: end.at };
  });
  const overlapMs = Math.min(...spans.map(s => Date.parse(s.end))) - Math.max(...spans.map(s => Date.parse(s.start)));
  emit('parallel_overlap', { spans, overlapMs }); assert.ok(overlapMs > 0, '两个真实 child 未实际重叠');
}
function multiPlan(name: string) {
  const contract = plan(name);
  contract.resources[0].capacity = 2;
  for (const task of contract.tasks) {
    const id = task.id;
    const prefix = `repo${id}/`;
    task.deps = [];
    task.writePaths = task.writePaths.map(path => prefix + path);
    task.task = task.task.replace('只执行这一条 bash', '为记录并行重叠，先在同一条 bash 开头执行 sleep 3；只执行这一条 bash');
    if (name === 'multi-tools' && id === 'A') task.task = task.task.replace("printf 'A\\n'", "printf 'bad\\n'").replace('内容为 A 加换行', '内容为 bad 加换行（受控失败，首派不得提前修复）');
    const check = contract.checks.find(check => check.id === `check-${id}`)!;
    check.command.args[1] = check.command.args[1].replace(`'${name}-${id}.txt'`, `'${prefix}${name}-${id}.txt'`);
    if (name === 'multi-tools' && id === 'A') check.command.args[1] = check.command.args[1].replace(JSON.stringify('A\n'), JSON.stringify('fixed\n'));
  }
  return contract;
}

try {
  for (const dir of [agent, cwd, join(agent, 'agents'), join(agent, 'extensions'), join(root, 'home'), join(root, 'tmp'), join(root, 'sessions')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  // 唯一凭据操作：外部 cp；脚本不读取、解析、打印凭据内容。
  execFileSync('cp', [join(repo, 'pi/auth.json'), join(agent, 'auth.json')]);
  for (const name of ['models.json', 'models-store.json']) execFileSync('cp', [join(repo, 'pi', name), join(agent, name)]);
  // 临时模型目录只缩小 contextWindow 以让 manual compact 达到真实阈值；provider/id/endpoint 仍是实际 qoder-pool/DeepSeek-Flash。
  execFileSync(process.execPath, ['-e', `const fs=require('fs');const p=${JSON.stringify(join(agent, 'models.json'))};const j=JSON.parse(fs.readFileSync(p));const m=j.providers['qoder-pool'].models.find(x=>x.id==='DeepSeek-Flash');m.contextWindow=16384;m.maxTokens=2048;fs.writeFileSync(p,JSON.stringify(j));`]);
  for (const name of ['delegate', 'executor', 'reviewer']) {
    const source = await readFile(join(repo, 'pi/agents', `${name}.md`), 'utf8');
    const pinned = source.replace(/models:\n(?:  - .*\n)+/, `model: ${model}\n`).replace(/^model: .*$/m, `model: ${model}`).replace(/^thinking: .*$/m, 'thinking: off').replace(/^tools: .*$/m, 'tools: read, write, edit, bash');
    await writeFile(join(agent, 'agents', `${name}.md`), pinned.replace(/^---\n/, `---\nextensions: ${join(root, 'observe-child.ts')}\n`));
  }
  await writeFile(join(root, 'observe-child.ts'), `import {appendFile} from 'node:fs/promises'; export default function(pi){let calls=0; const save=event=>appendFile(${JSON.stringify(join(root, 'children.jsonl'))},JSON.stringify({pid:process.pid,at:new Date().toISOString(),...event})+'\\n'); pi.on('turn_start',(_e,ctx)=>{if(calls>=6)ctx.abort()}); pi.on('session_start',async(_e,ctx)=>save({type:'child_start',cwd:ctx.cwd,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),model:ctx.model?.provider+'/'+ctx.model?.id})); pi.on('session_shutdown',async()=>save({type:'child_shutdown'})); pi.on('message_end',async e=>{if(e.message?.role==='assistant'){calls++;await save({type:'assistant',model:e.message.provider+'/'+e.message.model,usage:e.message.usage,stopReason:e.message.stopReason})}}); }`);
  await symlink(join(repo, 'pi/extensions/agents-shared.ts'), join(agent, 'extensions/agents-shared.ts'));
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ goalEngine: { enabled: true }, defaultProvider: 'qoder-pool', defaultModel: 'DeepSeek-Flash', enabledModels: [model], defaultThinkingLevel: 'off', defaultTools: ['read', 'write', 'edit', 'bash'], defaultProjectTrust: 'always', enableInstallTelemetry: false, subagents: { disableBuiltins: true }, compaction: { enabled: false }, retry: { enabled: false }, extensions: ['-builtin:mcp'] }));
  await writeFile(join(agent, 'goal-runtime.json'), JSON.stringify({ enabled: true, maxConcurrentTasks: multi ? 2 : 1, maxNoProgressTurns: 3 }));
  await writeFile(join(root, 'observe.ts'), `import {writeFile} from 'node:fs/promises'; import {readFileSync,writeFileSync} from 'node:fs'; import {getPlanExecutionService} from ${JSON.stringify(join(repo, 'packages/pi-subagents-enhanced/src/execution/index.ts'))};
export default function(pi){ const counter=${JSON.stringify(join(root, 'host-budget.json'))}; const count=()=>{try{return Number(readFileSync(counter,'utf8'))}catch{return 0}}; pi.on('turn_start',(_e,ctx)=>{if(count()>=16)ctx.abort()}); pi.on('message_end',e=>{if(e.message?.role==='assistant')writeFileSync(counter,String(count()+1))}); pi.on('session_start',()=>pi.setActiveTools(${JSON.stringify(selected === 'resume' ? ['subagent_start','subagent_run_resume','subagent_run_status','bash'] : selected === 'all' ? ['plan_execute','plan_verify','plan_status','plan_retry','plan_checkpoint','subagent_start','subagent_run_resume','subagent_run_status','bash'] : ['plan_execute','plan_verify','plan_status','plan_retry','plan_checkpoint','bash'])})); pi.registerCommand('smoke-observe',{description:'只读冒烟快照',async handler(_args,ctx){const entries=ctx.sessionManager.getBranch(); const state=entries.filter(e=>e.customType==='goal-runtime.state.v1').at(-1)?.data; const service=getPlanExecutionService(pi,ctx.sessionManager.getSessionId()); const facts={}; for(const [id,task] of Object.entries(state?.tasks??{})){if(task.run)facts[id]=await service?.inspect(task.run)} if(_args.trim()) facts.probe=await service?.inspect(JSON.parse(_args)); await writeFile(${JSON.stringify(join(root, 'observation.json'))},JSON.stringify({pid:process.pid,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),facts}))}}); }
`);
  for (const originRoot of origins) {
    await mkdir(originRoot, { recursive: true });
    git('-C', originRoot, 'init', '-q', '-b', 'main');
    await writeFile(join(originRoot, 'initial.txt'), '隔离冒烟初始提交\n');
    git('-C', originRoot, 'add', '.'); git('-C', originRoot, 'commit', '-qm', 'chore: 初始化隔离冒烟');
  }
  const candidates = [
    { name: 'positive', repair: false, single: false },
    { name: 'repair', repair: true, single: true },
    { name: 'replacement', repair: false, single: true },
    { name: 'replacement-next', repair: false, single: true },
    { name: 'compact', repair: false, single: true },
  ];
  for (const { name, repair, single } of candidates) {
    await writeFile(join(cwd, `${name}.md`), '# 隔离冒烟\n<!-- goal-runtime-contract:start -->\n```json\n' + JSON.stringify(plan(name, repair, single), null, 2) + '\n```\n<!-- goal-runtime-contract:end -->\n');
  }
  if (multi) {
    for (const name of ['multi-parallel', 'multi-tools', 'multi-compact', 'invalid-prefix', 'invalid-cross']) {
      const contract = multiPlan(name);
      if (name === 'invalid-prefix') contract.tasks[0].writePaths = ['outside.txt'];
      if (name === 'invalid-cross') contract.tasks[0].writePaths = ['repoA/out.txt', 'repoB/out.txt'];
      await writeFile(join(cwd, `${name}.md`), '# 多仓库隔离冒烟\n<!-- goal-runtime-contract:start -->\n```json\n' + JSON.stringify(contract, null, 2) + '\n```\n<!-- goal-runtime-contract:end -->\n');
    }
    assert.equal(existsSync(join(cwd, '.git')), false);
  } else { git('add', '.'); git('commit', '-qm', 'chore: 添加冒烟计划'); }
  emit('setup', { root, mode: '0700', model, cli, superRoot: multi, origins: origins.map(origin => ({ origin, head: git('-C', origin, 'rev-parse', 'HEAD') })) });
  currentScenario = selected;
  let host = new Rpc();
  const identity = await host.send('get_state');
  assert.equal(`${identity.model.provider}/${identity.model.id}`, model);
  emit('host', { pid: host.child.pid, sessionId: identity.sessionId, sessionFile: identity.sessionFile, model });
  if (selected === 'multi-invalid') {
    for (const [name, code] of [['invalid-prefix', 'GOAL_REPOSITORY_PREFIX_REQUIRED'], ['invalid-cross', 'GOAL_REPOSITORY_CROSS_TASK']]) {
      const offset = host.records.length;
      await host.send('prompt', { message: `只调用一次 plan_execute({plan_path:"${name}.md",mode:"subagent-driven"})，预期拒绝后停止，不更改文件。` });
      const reply = await host.wait(r => r.type === 'tool_execution_end' && r.toolName === 'plan_execute', 120000, offset);
      assert.equal(reply.result?.isError, true); assert.equal(reply.result.details?.error?.code, code);
      await host.settled(); assert.equal((await host.snapshot()).state, undefined);
    }
  }
  if (selected === 'multi-parallel' || selected === 'multi-tools') {
    const retryOffset = host.records.length;
    await execute(host, selected, selected === 'multi-tools' ? 'execute 成功后先调用 plan_checkpoint(task_id="A",decisions=["等待真实交付"],source_refs=["multi-tools.md"],next_action="按通知验证")，再调用 plan_status。' : '');
    if (selected === 'multi-tools') {
      const blocked = await host.goalUntil(s => s.state?.tasks.A.status === 'blocked' && s.state.receipts.some((r: Json) => r.exitCode === 7), true);
      assert.equal(blocked.facts.A.workspaceState, 'released');
      await host.settled();
      if (!host.records.slice(retryOffset).some(r => r.type === 'tool_execution_end' && r.toolName === 'plan_retry' && r.result?.isError !== true)) {
        await host.send('prompt', { streamingBehavior: 'followUp', message: '用户明确授权修复 A：若 B 仍 verifying，先 plan_verify(check_ids=["check-B"])；再 plan_status 获取当前 revision，plan_retry(task_id="A",expected_revision=当前revision,message="只将 multi-tools-A.txt 改为 fixed 加换行，用户授权 git add 和 commit，核验干净工作区后报告。路径相对当前仓库，禁止修改 repoB。")；然后按通知 plan_verify，全部 accepted 后终态 verify。' });
        await host.send('prompt', { message: '/plan resume' });
      }
      const retry = await host.wait(r => r.type === 'tool_execution_end' && r.toolName === 'plan_retry', 120000, retryOffset);
      assert.notEqual(retry.result?.isError, true, JSON.stringify(retry));
    }
    const completed = await host.goalUntil(s => s.state?.status === 'completed', selected === 'multi-tools');
    assertDelivered(completed); await host.settled(); audit(completed);
    assert.ok(completed.state.receipts.some((r: Json) => r.exitCode === 0 && r.subject?.kind === 'multi-repository'));
    if (selected === 'multi-parallel') await assertParallel(completed);
    else {
      assert.equal(completed.state.tasks.A.attempt, 2);
      for (const name of ['plan_execute', 'plan_status', 'plan_checkpoint', 'plan_retry', 'plan_verify']) assert.ok(host.records.some(r => r.type === 'tool_execution_end' && r.toolName === name && r.result?.isError !== true), name);
    }
  }
  if (selected === 'all' || selected === 'positive') {
    currentScenario = 'positive';
    await execute(host, 'positive');
    const positive = await host.goalUntil(s => s.state?.status === 'completed');
    for (const fact of Object.values(positive.facts) as Json[]) { assert.equal(fact.terminal, 'succeeded'); assert.ok(fact.terminalProofRef); assert.equal(fact.integration, 'completed'); assert.ok(fact.integrationReceiptRef); assert.equal(fact.workspaceState, 'released'); }
    await host.settled();
  }
  async function fresh() { if ((await host.snapshot()).state) { await host.close(); host = new Rpc(); await host.send('get_state'); } }
  if (selected === 'all' || selected === 'repair') {
    currentScenario = 'repair'; await fresh();
    await execute(host, 'repair');
    const blocked = await host.goalUntil(s => s.state?.tasks.A.status === 'blocked' && s.state.receipts.some((r: Json) => r.exitCode === 7));
    assert.equal(blocked.facts.A.workspaceState, 'released');
    await host.send('prompt', { message: '/plan pause' });
    await host.settled();
    const retryOffset = host.records.length;
    await host.send('prompt', { message: '用户授权修复；先调用 plan_status 读取当前 revision，再调用 plan_retry(task_id=A, expected_revision=当前revision, message="将 repair-A.txt 改为 fixed 加换行，提交并验证。")，然后按 Goal 指引运行 plan_verify 至 completed。' });
    await host.send('prompt', { message: '/plan resume' });
    const retried = await host.wait(r => r.type === 'tool_execution_end' && r.toolName === 'plan_retry', 120000, retryOffset);
    assert.notEqual(retried.result?.isError, true, JSON.stringify(retried));
    await host.goalUntil(s => s.state?.status === 'completed' && s.state.tasks.A.attempt === 2);
    await host.settled();
  }
  if (selected === 'all' || selected === 'replace') {
    currentScenario = 'replace'; await fresh();
    await execute(host, 'replacement');
    await host.wait(r => r.type === 'tool_execution_end' && r.toolName === 'plan_execute');
    await host.send('prompt', { message: '/plan pause' });
    const old = await host.goalUntil(s => s.facts.A?.workspaceState === 'released', true);
    await host.settled();
    await host.send('prompt', { message: '/plan cancel' });
    const cancelled = await host.snapshot(); assert.equal(cancelled.state.status, 'cancelled');
    // 已闭合但未终态检查的计划允许 cancel；completed 不允许原地改写。
    await execute(host, 'replacement-next');
    const replaced = await host.goalUntil(s => s.state?.status === 'completed');
    assert.notEqual(replaced.state.planId, old.state.planId);
    assert.ok(replaced.entryIds.some((entry: Json) => entry.planId === old.state.planId)); await host.settled();
  }
  if (selected === 'all' || selected === 'resume') {
    currentScenario = 'resume'; await fresh();
    const resumeRootSessionId = (await host.send('get_state')).sessionId;
    const request = { agent: 'delegate', title: '冒烟恢复前置', task: '只创建 resume.txt，内容 resumed 加换行，执行一次只读内容验证后立即返回 acceptance-report。此阶段明确禁止 git add/commit；保留未提交产物用于下一次已授权恢复，不调用集成或处置工具。只修改 resume.txt，不新增测试。', writePaths: ['resume.txt'], acceptance: { criteria: ['resume.txt 包含 resumed 加换行，内容验证成功，暂不提交且无 staged 文件'] }, worktree: true, cwd };
    await host.send('prompt', { message: `调用一次 subagent_start(${JSON.stringify(request)})。这是用户授权的恢复场景：等待 child 完成后暂停等待下一条指导，任何 handoff 均只读观察，不人工提交、不集成、不处置、不自动 resume。` });
    const started = await host.wait(r => r.type === 'tool_execution_end' && r.toolName === 'subagent_start', 120000);
    assert.notEqual(started.result?.isError, true, JSON.stringify(started));
    const handle = started.result.details;
    let intent: any;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      assert.equal(interrupted, false, 'SMOKE_INTERRUPTED');
      await host.budget();
      const audit = auditManagedWorkspaces({ stateRoot: join(root, 'workspaces'), originRoot: cwd });
      intent = audit.queue.resumeIntents.find((item: any) => item.sourceRunId === handle.runId && item.state === 'pending');
      if (intent) break;
      await pause(500);
    }
    assert.ok(intent, '真实 child 完成后未形成 canonical pending resume intent');
    emit('resume_intent', { resumeIntentId: intent.resumeIntentId, sourceRunId: intent.sourceRunId, sourceProofId: intent.sourceProofId, workspaceId: intent.workspaceId, queueItemId: intent.queueItemId, delivery: intent.delivery.state });
    await host.settled();
    const offset = host.records.length;
    await host.send('prompt', { message: `用户授权执行 subagent_run_resume({id:${JSON.stringify(handle.runId)},index:0,message:"继续原任务：核对 resume.txt 内容，用户现在明确授权 git add resume.txt 并 git commit -m 'feat: 完成恢复冒烟'。验证内容和 git status 后输出验收报告。只修改 resume.txt。"})。仅通过 typed resume，不重派；后续通知只读观察。` });
    const resumed = await host.wait(r => r.type === 'tool_execution_end' && r.toolName === 'subagent_run_resume', 120000, offset);
    assert.notEqual(resumed.result?.isError, true, JSON.stringify(resumed));
    const resumedId = resumed.result.details.runId ?? resumed.result.details.asyncId;
    assert.ok(resumedId && resumedId !== handle.runId);
    const finish = Date.now() + 180000;
    let receipt: any; let finalIntent: any; let resumedFacts: any;
    while (Date.now() < finish) {
      assert.equal(interrupted, false, 'SMOKE_INTERRUPTED');
      const audit = auditManagedWorkspaces({ stateRoot: join(root, 'workspaces'), originRoot: cwd });
      finalIntent = audit.queue.resumeIntents.find((item: any) => item.resumeIntentId === intent.resumeIntentId);
      receipt = audit.inventory.workspaces.find((item: any) => item.receipt.workspaceId === handle.workspace_id)?.receipt;
      resumedFacts = (await host.snapshot({ runId: resumedId, workspaceId: handle.workspace_id, rootSessionId: resumeRootSessionId })).facts.probe;
      if (receipt?.state === 'released' && resumedFacts.integration === 'completed' && finalIntent?.state === 'completed') break;
      await pause(500);
    }
    assert.equal(receipt?.run?.runId, resumedId); assert.equal(receipt?.state, 'released');
    assert.equal(finalIntent?.state, 'completed'); assert.equal(finalIntent?.resumedRun?.runId, resumedId);
    const observed = (await readFile(join(root, 'children.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === 'child_start');
    const sourceChild = observed.find(e => e.sessionFile.includes(handle.runId));
    const resumedChild = observed.findLast(e => e.pid !== sourceChild?.pid && e.sessionFile === sourceChild?.sessionFile);
    assert.ok(sourceChild && resumedChild, '缺少同 session 新 PID 回执');
    assert.equal(finalIntent.resumedRun.pid, resumedChild.pid);
    emit('resume_receipt', { sourceRunId: handle.runId, resumedRunId: resumedId, oldPid: sourceChild.pid, newPid: resumedChild.pid, sessionFile: sourceChild.sessionFile, workspaceId: receipt.workspaceId, queueItemId: intent.queueItemId, resumeIntentId: finalIntent.resumeIntentId, agentProfile: finalIntent.resumedRun.agentProfile, state: finalIntent.state, proofId: resumedFacts.terminalProofRef, integrationReceiptRef: resumedFacts.integrationReceiptRef });
  }
  if (selected === 'all' || selected === 'compact' || selected === 'multi-compact') {
    currentScenario = selected; await fresh();
    for (let index = 0; index < 4; index++) { await host.send('prompt', { message: `以下只是 compact 阈值填充文本 ${index}；当前没有计划，禁止调用工具，只回复“已记录”。${'保持 Goal 合同、未完成任务、run 绑定、来源引用和下一步。'.repeat(2500)}` }); await host.settled(); }
    await execute(host, selected);
    await host.wait(r => r.type === 'tool_execution_end' && r.toolName === 'plan_execute');
    const before = await host.goalUntil(s => Object.keys(s.state?.tasks ?? {}).length > 0 && Object.values(s.state.tasks).every((t: any) => t.status === 'verifying'), true);
    assert.equal(before.state.status, 'active');
    const compacted = await host.send('compact', { customInstructions: '保留当前 Goal 合同、run 引用、未完成任务与下一步。' }, 120000);
    emit('compact', { result: compacted, pid: host.child.pid, planId: before.state.planId });
    await host.close(); host = new Rpc(before.sessionFile);
    await host.settled();
    const restored = await host.snapshot(); assert.equal(restored.state.planId, before.state.planId); assert.notEqual(restored.pid, before.pid);
    assertDelivered(before);
    assertDelivered(restored);
    for (const id of Object.keys(before.state.tasks)) {
      assert.deepEqual(restored.state.tasks[id].run, before.state.tasks[id].run);
      for (const key of ['terminalProofRef', 'integrationReceiptRef']) assert.equal(restored.facts[id][key], before.facts[id][key]);
    }
    emit('restored', { oldPid: before.pid, newPid: restored.pid, before, restored });
    await host.settled();
    await host.send('prompt', { streamingBehavior: 'followUp', message: '恢复后按当前 verifying 状态调用 plan_verify，之后按 Goal 指引继续至 completed。' });
    await host.settled();
    await host.send('prompt', { message: '/plan resume' });
    await host.settled();
    const completed = await host.goalUntil(s => s.state?.status === 'completed');
    assertDelivered(completed); audit(completed);
  }
  await host.settled(); await host.budget();
} catch (error) {
  failed = true;
  emit('failure', { scenario: currentScenario, message: error instanceof Error ? error.message : String(error) });
} finally {
  // 日志只汇总实际 assistant 的模型、usage；不读取认证文件或输出原始 provider 请求。
  for (const host of hosts) {
    if (host.child.exitCode === null) {
      try { emit('final_snapshot', { scenario: currentScenario, ...(await host.snapshot()) }); } catch { /* 原始失败仍为权威。 */ }
    }
  }
  try { audit(); } catch (error) { emit('audit_error', { message: String(error) }); }
  for (const host of hosts) await host.close().catch(() => { failed = true; });
  const sessions: Json[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.jsonl')) {
        const records = (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const messages = records.filter(r => r.type === 'message' && r.message?.role === 'assistant').map(r => r.message);
        if (messages.length) sessions.push({ file, sessionId: records.find(r => r.type === 'session')?.id, calls: messages.length, models: [...new Set(messages.map(m => `${m.provider}/${m.model}`))], input: messages.reduce((n, m) => n + (m.usage?.input ?? 0), 0), output: messages.reduce((n, m) => n + (m.usage?.output ?? 0), 0), cacheRead: messages.reduce((n, m) => n + (m.usage?.cacheRead ?? 0), 0), totalTokens: messages.reduce((n, m) => n + (m.usage?.totalTokens ?? 0), 0) });
      }
    }
  };
  await walk(join(root, 'sessions')); await walk(join(agent, 'sessions')); await walk(join(agent, 'pi-subagents'));
  const childEvents = (await readFile(join(root, 'children.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  emit('usage', { sessions, childEvents, hostCalls: hosts.reduce((n, host) => n + host.records.filter(r => r.type === 'message_end' && r.message?.role === 'assistant').length, 0), hostLimit: 16, childLimit: 6 });
  // 仅清理由本次唯一临时根匹配的进程，避免触碰用户 Host。
  const processList = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const pids = processList.split('\n').filter(line => line.includes(root)).map(line => Number(line.trim().split(/\s+/)[0])).filter(pid => pid !== process.pid);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出。 */ } }
  if (failed || interrupted || keepArtifacts) {
    await writeFile(join(root, 'probe-events.jsonl'), evidence.map(event => JSON.stringify(event)).join('\n') + '\n');
    for (const host of hosts) await writeFile(join(root, `host-${host.child.pid}.json`), JSON.stringify({ records: host.records, stderr: host.stderr }, null, 2));
  } else await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  emit('cleanup', { root, failed, exitCode: failed ? 1 : 0, preserved: failed || interrupted || keepArtifacts, removed: !existsSync(root), killedPids: pids, noStagedFiles: execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim() === '' });
  if (existsSync(root)) await writeFile(join(root, 'probe-events.jsonl'), evidence.map(event => JSON.stringify(event)).join('\n') + '\n');
}
process.exitCode = failed ? 1 : 0;
