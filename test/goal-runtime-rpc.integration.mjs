import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePiCodingAgentRoot } from './helpers/pi-runtime.mjs';

const repo = resolve(import.meta.dirname, '..');
const hostRoot = resolvePiCodingAgentRoot();
const moduleUrl = path => pathToFileURL(join(repo, path)).href;
const names = ['plan_checkpoint', 'plan_execute', 'plan_retry', 'plan_status', 'plan_verify'];

// 沿用 joint-upgrade RPC 的受限 env 和官方 runRpcMode，合成模型复用 openJointSession。
// Pi 1.4 RPC 没有 get_tools/execute_tool；测试命令只投影实际 registry，不虚构协议方法。
const source = `
import { openJointSession, sdk, Type } from ${JSON.stringify(moduleUrl('test/helpers/joint-upgrade-session.mjs'))};
import goalExtension from ${JSON.stringify(moduleUrl('pi/extensions/goal-runtime.ts'))};
import { bindPlanExecutionService } from ${JSON.stringify(moduleUrl('packages/pi-subagents-enhanced/src/execution/index.ts'))};
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const enabled = process.env.GOAL_RPC_ENABLED === '1';
const multi = process.env.GOAL_RPC_MULTI === '1';
const contract = { schema: 'goal-runtime.plan.v1', objective: 'RPC 隔离验证', constraints: ['不得访问真实 provider'], resources: [],
 checks: [{id:'C',statement:'只读检查',command:{executable:'true',args:[],timeoutSeconds:5},repairTaskIds:['A']}],
 tasks:[{id:'A',agent:'delegate',task:'只操作临时仓库，异常即停止。',deps:[],writePaths:['A.txt'],resources:[],acceptance:{criteria:['保留边界']},checkIds:[]}],terminalCheckIds:['C'] };
if (multi) {
 contract.tasks[0].writePaths = ['repoA/A.txt'];
 contract.tasks.push({...structuredClone(contract.tasks[0]),id:'B',writePaths:['repoB/B.txt']});
 contract.checks[0].repairTaskIds.push('B');
}
const base = await openJointSession({ persistent: true, defaultTools: ['bash'], files: async ({agentDir,cwd}) => {
 for (const root of multi ? ['repoA','repoB','unused'].map(id=>join(cwd,id)) : [cwd]) {
  await mkdir(root,{recursive:true}); execFileSync('git',['init','-b','main'],{cwd:root,stdio:'ignore'});
 }
 await writeFile(join(agentDir,'settings.json'),JSON.stringify({goalEngine:{enabled},defaultTools:['bash'],defaultProjectTrust:'always',enableInstallTelemetry:false,compaction:{enabled:false},retry:{enabled:false}}));
 await writeFile(join(agentDir,'goal-runtime.json'),JSON.stringify({enabled:true,maxConcurrentTasks:2,maxNoProgressTurns:3}));
 await writeFile(join(cwd,'plan.md'),'<!-- goal-runtime-contract:start -->\\n'+'\`\`\`json\\n'+JSON.stringify(contract)+'\\n\`\`\`\\n<!-- goal-runtime-contract:end -->');
}});
process.stdout.write(JSON.stringify({type:'fixture_ready',temp:base.temp})+'\\n');
process.env.PI_CODING_AGENT_DIR = base.agentDir;
base.session.dispose();
let session; let revoke;
const facts = new Map(); const dispatches = [];
// 只注入 pending 的 adapter 边界引用，不声称真实 spawn/proof/集成。
const execution = {
 async start(input) { dispatches.push(input.request); const n=dispatches.length; const run={runId:'rpc-boundary-run-'+n,workspaceId:'rpc-boundary-workspace-'+n,rootSessionId:input.ctx.sessionManager.getSessionId()}; await input.onAllocated(run.workspaceId);
 facts.set(run.runId,{run,terminal:'pending',terminalProofRef:null,integration:'pending',integrationReceiptRef:null,workspaceState:'active',recovery:'none',wakeup:'subscribed',blocker:null}); await input.onBound(run); return run; },
 async resume(){throw Error('未授权真实恢复')}, async inspect(run){return facts.get(run.runId)}, subscribe(){return ()=>{}}
};
const settingsManager = sdk.SettingsManager.create(base.cwd,base.agentDir);
const resourceLoader = new sdk.DefaultResourceLoader({cwd:base.cwd,agentDir:base.agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
 extensionFactories:[pi=>{
  pi.on('session_start',(_e,ctx)=>{revoke?.();revoke=bindPlanExecutionService(pi,ctx.sessionManager.getSessionId(),execution)});
  pi.on('session_shutdown',()=>revoke?.());
 },goalExtension,pi=>{
  pi.registerCommand('goal-probe',{description:'只读测试诊断',async handler(){pi.sendMessage({customType:'goal-test.registry',content:JSON.stringify({registered:session.getAllTools().map(t=>t.name),active:session.getActiveToolNames(),callable:session.getCallableToolNames(),dispatches}),display:false})}});
  pi.registerCommand('goal-probe-status',{description:'只读测试状态',async handler(){const result=await session.getToolDefinition('plan_status').execute('rpc-direct-status',{},undefined,undefined,session.extensionRunner.createToolContext('rpc-direct-status'));pi.sendMessage({customType:'goal-test.status',content:JSON.stringify(result),display:false})}});
  pi.registerCommand('goal-probe-call',{description:'测试工具入口',async handler(args){const {name,arguments:params}=JSON.parse(args);const result=await session.getToolDefinition(name).execute('rpc-probe-call',params,undefined,undefined,session.extensionRunner.createToolContext('rpc-probe-call'));pi.sendMessage({customType:'goal-test.call',content:JSON.stringify(result),display:false})}});
  pi.registerTool({name:'goal_probe_nested_status',label:'goal_probe_nested_status',description:'测试真实 nested direct 准入',parameters:Type.Object({}),reachesTools:()=>['plan_status'],async execute(_id,_p,_s,_u,ctx){const outcome=await ctx.executeTool('plan_status',{});return {content:[{type:'text',text:JSON.stringify(outcome)}],details:outcome}}});
 }]});
await resourceLoader.reload();
({session}=await sdk.createAgentSession({cwd:base.cwd,agentDir:base.agentDir,settingsManager,resourceLoader,modelRuntime:base.session.modelRuntime,model:base.session.model,sessionManager:base.session.sessionManager}));
const services={cwd:base.cwd,agentDir:base.agentDir,modelRuntime:base.session.modelRuntime,settingsManager,resourceLoader,diagnostics:[]};
const runtime=new sdk.AgentSessionRuntime(session,services,async()=>{throw Error('测试禁止创建额外会话')});
await sdk.runRpcMode(runtime);
`;

async function withRpc(enabled, check, { multi = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'goal-rpc-'));
  await mkdir(join(root, 'home')); await mkdir(join(root, 'agent'));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), TMPDIR: '/tmp',
    PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_PACKAGE_DIR: hostRoot,
    PI_TEST_CODING_AGENT_ROOT: hostRoot, PI_REAL_BIN: join(hostRoot, 'dist/cli.js'),
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: hostRoot, GOAL_RPC_ENABLED: enabled ? '1' : '0', GOAL_RPC_MULTI: multi ? '1' : '0' };
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const records = []; let buffer = ''; let stderr = ''; let fixtureTemp;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const item = JSON.parse(line); records.push(item); if (item.type === 'fixture_ready') fixtureTemp = item.temp; }
      catch { assert.ok(line.startsWith('[goal-engine]'), `非预期 RPC stdout: ${line}`); }
    }
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let ordinal = 0;
  async function wait(predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = records.find(predicate); if (value) return value;
      if (child.exitCode !== null) throw new Error(`RPC 提前退出：${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`RPC 等待超时：${stderr}`);
  }
  async function send(type, args = {}) {
    const id = `rpc-${++ordinal}`; child.stdin.write(JSON.stringify({ id, type, ...args }) + '\n');
    const result = await wait(r => r.type === 'response' && r.id === id); assert.equal(result.success, true, JSON.stringify(result)); return result.data;
  }
  async function invoke(name, args = {}) {
    const offset = records.length;
    await send('prompt', { message: JSON.stringify({ name, arguments: args }) });
    await wait((r, index) => index >= offset && r.type === 'agent_settled');
    const result = records.slice(offset).findLast(r => r.type === 'message_end' && r.message?.role === 'toolResult' && r.message.toolName === name)?.message;
    assert.ok(result, `缺少工具回执 ${name}`); assert.notEqual(result.isError, true, JSON.stringify(result)); return result;
  }
  async function probe(command, customType) {
    await send('prompt', { message: `/${command}` });
    const { messages } = await send('get_messages');
    const message = messages.findLast(m => m.customType === customType); assert.ok(message); return JSON.parse(message.content);
  }
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 25000);
  try {
    await check({ send, invoke, probe });
    child.stdin.end(); assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
  } finally {
    clearTimeout(watchdog); if (child.exitCode === null) child.kill('SIGKILL'); await closed;
    if (fixtureTemp) await rm(fixtureTemp, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

test('RPC 开启：从真实 Host registry 枚举五工具及 direct/model-only 集合', async () => withRpc(true, async h => {
  const result = await h.probe('goal-probe', 'goal-test.registry');
  assert.deepEqual(result.registered.filter(n => n.startsWith('plan_')).sort(), names);
  assert.deepEqual(result.active.filter(n => n.startsWith('plan_')).sort(), names);
  assert.deepEqual(result.callable.filter(n => n.startsWith('plan_')), ['plan_status']);
}));

test('RPC 开启：plan_status 真实 nested executeTool 可直读且不写 Goal entry', async () => withRpc(true, async h => {
  const before = (await h.send('get_entries')).entries.filter(e => e.customType?.startsWith('goal-runtime.'));
  const response = await h.invoke('goal_probe_nested_status');
  assert.equal(response.details.isError, false); assert.equal(response.details.result.details.state, null);
  const after = (await h.send('get_entries')).entries.filter(e => e.customType?.startsWith('goal-runtime.'));
  assert.deepEqual(after, before);
}));

test('RPC 开启：真实模型绑定与状态回读 session/plan/contractHash 身份一致', async t => withRpc(true, async h => {
  const executed = await h.invoke('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' });
  const state = executed.details.state; const rpc = await h.send('get_state');
  assert.equal(state.binding.sessionId, rpc.sessionId); assert.equal(state.binding.sessionFile, rpc.sessionFile);
  const prior = (await h.send('get_entries')).entries.filter(e => e.customType === 'goal-runtime.state.v1');
  const status = await h.probe('goal-probe-status', 'goal-test.status');
  assert.equal(status.details.state.planId, state.planId); assert.equal(status.details.state.binding.contractHash, state.binding.contractHash);
  assert.equal(status.details.state.revision, state.revision);
  const after = (await h.send('get_entries')).entries.filter(e => e.customType === 'goal-runtime.state.v1'); assert.deepEqual(after, prior);
  const persisted = (await readFile(rpc.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(persisted.some(e => e.id === prior.at(-1).id && e.data?.planId === state.planId));
  t.diagnostic(JSON.stringify({ sessionId: rpc.sessionId, planId: state.planId, contractHash: state.binding.contractHash, entryId: prior.at(-1).id }));
}));

test('RPC 关闭：三工具集合无 plan 工具且无 Goal entry', async () => withRpc(false, async h => {
  const result = await h.probe('goal-probe', 'goal-test.registry');
  for (const set of ['registered', 'active', 'callable']) assert.deepEqual(result[set].filter(n => n.startsWith('plan_')), []);
  assert.deepEqual((await h.send('get_entries')).entries.filter(e => e.customType?.startsWith('goal-runtime.')), []);
}));

test('T3 多仓库 RPC 五工具形态不变，派发路径、checkpoint 与未交付 verify/retry fail-closed', async () => withRpc(true, async h => {
  const registry = await h.probe('goal-probe', 'goal-test.registry');
  assert.deepEqual(registry.registered.filter(n => n.startsWith('plan_')).sort(), names);
  assert.deepEqual(registry.callable.filter(n => n.startsWith('plan_')), ['plan_status']);
  const executed = await h.invoke('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' });
  const state = executed.details.state;
  assert.deepEqual(state.binding.repositories.map(r => r.repoId), ['repoA', 'repoB']);
  assert.deepEqual(executed.details.dispatches.map(d => d.outcome), ['bound', 'bound']);
  const { dispatches } = await h.probe('goal-probe', 'goal-test.registry');
  for (const [index, request] of dispatches.entries()) {
    assert.equal(request.cwd, state.binding.repositories[index].root);
    assert.deepEqual(request.writePaths, [index === 0 ? 'A.txt' : 'B.txt']);
    assert.deepEqual(JSON.parse(request.task.split('\n').slice(1).join('\n')).task.writePaths, request.writePaths);
  }
  // 激活后的 recovery context 是合法生产消息；合成 provider 只识别最后 user，后续沿测试命令调用实际工具入口。
  const call = (name, args = {}) => h.probe(`goal-probe-call ${JSON.stringify({ name, arguments: args })}`, 'goal-test.call');
  const checkpoint = await call('plan_checkpoint', { task_id: 'A', decisions: ['固定参与集合'], source_refs: ['plan.md'], next_action: '等待既有运行' });
  assert.notEqual(checkpoint.isError, true);
  const beforeStatus = (await h.send('get_entries')).entries.filter(e => e.customType === 'goal-runtime.state.v1');
  const status = await call('plan_status');
  assert.deepEqual((await h.send('get_entries')).entries.filter(e => e.customType === 'goal-runtime.state.v1'), beforeStatus);
  assert.equal(status.details.state.checkpoint.taskId, 'A');
  assert.equal(status.details.tasks.A.repoId, 'repoA');
  assert.equal(status.details.tasks.B.repoId, 'repoB');
  assert.equal(status.details.checkpoint.repoId, 'repoA');
  assert.equal(Object.hasOwn(status.details.state.checkpoint, 'repoId'), false);
  for (const task of Object.values(status.details.state.tasks)) {
    assert.equal(Object.hasOwn(task, 'repoId'), false);
    assert.equal(Object.hasOwn(task.run, 'repoId'), false);
  }
  const rejectedCheckpoint = await call('plan_checkpoint', { task_id: 'unknown', decisions: [], source_refs: [], next_action: '拒绝合同外定位' });
  assert.equal(rejectedCheckpoint.details.error.code, 'INVALID_STATE_CHANGE');
  assert.deepEqual((await h.send('get_entries')).entries.filter(e => e.customType === 'goal-runtime.state.v1'), beforeStatus);
  const verified = await call('plan_verify');
  assert.equal(verified.isError, true); assert.equal(verified.details.error.code, 'TERMINAL_NOT_READY');
  const retried = await call('plan_retry', { task_id: 'A', message: '仍在运行不得重派', expected_revision: status.details.state.revision });
  assert.equal(retried.isError, true); assert.equal(retried.details.error.code, 'RETRY_NOT_ADMITTED');
  assert.deepEqual((await call('plan_execute', { plan_path: 'plan.md', mode: 'subagent-driven' })).details.dispatches, []);
  const globalCheckpoint = await call('plan_checkpoint', { decisions: ['全计划交接'], source_refs: [], next_action: '等待全部仓库' });
  assert.equal(Object.hasOwn(globalCheckpoint.details.checkpoint, 'repoId'), false);
  assert.equal((await h.probe('goal-probe', 'goal-test.registry')).dispatches.length, 2);
  assert.equal((await h.send('get_entries')).entries.some(e => e.customType === 'goal-runtime.check-result.v1'), false);
}, { multi: true }));
