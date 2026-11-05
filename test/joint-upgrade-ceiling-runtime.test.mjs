import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 本文件验收的是真实 Host runtime 在 **root 会话**装配 ceiling/broker 的行为。
// `PI_SUBAGENT_CHILD=1`（或 FANOUT 标记）在增强层是「不拥有 broker/ceiling/owner」的权威
// 事实源：`installSubagentRuntime` 与 `scripts/pi-session-owner.ts` 都直接提前返回。若测试
// 自身从 agent 会话继承了这两个标记（在子会话里跑测试即如此），runtime 根本不会装配，
// 三条用例会稳定失败（ceiling 未注册 / startup 不报错 / drain 不可观察），且与被测逻辑
// 无关：1.4 主仓基线与候选仓同样复现。
// 因此标记必须在**加载被测模块之前**剔除（标记在模块装配期被读取，故本文件的业务模块用
// 动态 import），用 after 复原；不改任何断言。同一既有约定见
// test/session-owner-wrapper.test.mjs 的 childSafeEnv 与 test/subagent-runtime-membrane.test.mjs。
const childMarkers = ['PI_SUBAGENT_CHILD', 'PI_SUBAGENT_FANOUT_CHILD'];
const savedChildMarkers = new Map(childMarkers.map(name => [name, process.env[name]]));
for (const name of childMarkers) delete process.env[name];
const { openJointSession } = await import('./helpers/joint-upgrade-session.mjs');
const runtime = (await import('../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts')).default;
const req = createRequire(new URL('../packages/pi-subagents-enhanced/package.json', import.meta.url));
const ceiling = await import(pathToFileURL(req.resolve('pi-subagents/capability-ceiling')));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR; const oldState = process.env.PI_CODING_WORKSPACE_DIR;
test.after(() => {
  for (const [name, value] of savedChildMarkers) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('真实runtime在persistent session lifecycle identity注册并重复start不泄漏，shutdown撤销', { timeout: 20000 }, async t => {
 const h = await openJointSession({ persistent: true, factories: [runtime], files: async ({ temp, agentDir }) => {
   process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_CODING_WORKSPACE_DIR = join(temp, 'state');
   await mkdir(join(agentDir, 'extensions/subagent'), { recursive: true });
   await mkdir(join(agentDir, 'agents'));
   for (const name of ['delegate', 'executor', 'reviewer']) await writeFile(join(agentDir, `agents/${name}.md`), `---\nname: ${name}\ndescription: fixture\ntools: read,contact_supervisor\n---\n隔离fixture。\n`);
   await writeFile(join(agentDir, 'extensions/subagent/config.json'), JSON.stringify({ childToolCeiling: { allowedTools: ['read', 'contact_supervisor'] } }));
 } });
 t.after(async () => { await h.close(); if (oldAgentDir===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=oldAgentDir; if(oldState===undefined)delete process.env.PI_CODING_WORKSPACE_DIR;else process.env.PI_CODING_WORKSPACE_DIR=oldState; });
 assert.deepEqual(h.errors, [], JSON.stringify(h.errors));
 // 0.83.1 起上游 ceiling 查找键是 sessionManager.getSessionId()；持久 session 下它必须与
 // session file 路径不同，否则旧 lifecycleSessionId 会静默漏注册。
 const sessionManager = h.session.sessionManager;
 const sessionId = sessionManager.getSessionId();
 const sessionFile = sessionManager.getSessionFile();
 assert.ok(sessionFile, '持久 joint session 必须带 session file');
 assert.notEqual(sessionId, sessionFile, 'ceiling 键必须是 session manager ID，而不是 session file');
 assert.deepEqual(ceiling.resolveCurrentSubagentCapabilityCeiling(sessionId)?.allowedTools, ['contact_supervisor', 'read']);
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(sessionFile), undefined, 'session file 不是 ceiling 注册键');
 await h.session.bindExtensions({ mode: 'print', onError: error => h.errors.push(error) });
 assert.deepEqual(h.errors, []);
 assert.deepEqual(ceiling.resolveCurrentSubagentCapabilityCeiling(sessionId)?.allowedTools, ['contact_supervisor', 'read']);
 await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(sessionId), undefined);
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(sessionFile), undefined);
});

test('真实runtime startup失败不得泄漏已注册ceiling或开放typed spawn', { timeout: 20000 }, async t => {
 const h = await openJointSession({ persistent: true, factories: [runtime], files: async ({ temp, agentDir, cwd }) => {
   execFileSync('git',['init','-b','main'],{cwd,stdio:'ignore'});
   process.env.PI_CODING_AGENT_DIR=agentDir; process.env.PI_CODING_WORKSPACE_DIR=join(temp,'blocked-state');
   await writeFile(process.env.PI_CODING_WORKSPACE_DIR, '非目录：模拟合法state配置失效');
   await mkdir(join(agentDir,'agents'));
   for (const name of ['delegate','executor','reviewer']) await writeFile(join(agentDir,`agents/${name}.md`), `---\nname: ${name}\ndescription: fixture\ntools: read\n---\nfixture\n`);
   await mkdir(join(agentDir,'extensions/subagent'),{recursive:true});
   await writeFile(join(agentDir,'extensions/subagent/config.json'),JSON.stringify({childToolCeiling:{allowedTools:['read']}}));
 } });
 t.after(async () => { await h.close(); process.env.PI_CODING_AGENT_DIR=oldAgentDir; if(oldState===undefined)delete process.env.PI_CODING_WORKSPACE_DIR;else process.env.PI_CODING_WORKSPACE_DIR=oldState; });
 assert.ok(h.errors.length>0,'真实startup必须失败');
 const failedSessionId=h.session.sessionManager.getSessionId();
 assert.notEqual(failedSessionId,h.session.sessionManager.getSessionFile(),'ceiling 键必须是 session manager ID');
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(failedSessionId),undefined,'startup失败回滚ceiling');
 const result=await h.invoke('subagent_start',{agent:'executor',task:'不允许副作用',title:'startup failure'});
 assert.equal(result.isError,true);
});

test('Root Broker drain失败保留ceiling，恢复后真实shutdown重试才释放', { timeout: 20000 }, async t => {
 const { RootBrokerServer } = await import('../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts');
 const original=RootBrokerServer.prototype.closeRootSession; let fail=true;
 // 只在真实broker的I/O关闭边界注入故障；不替换registry、session身份或生产清理链。
 RootBrokerServer.prototype.closeRootSession = async function(...args) { if(fail)throw new Error('controlled broker drain failure'); return original.apply(this,args); };
 const h=await openJointSession({persistent:true,factories:[runtime],files:async({temp,agentDir})=>{
  process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_CODING_WORKSPACE_DIR=join(temp,'state');
  await mkdir(join(agentDir,'agents')); for(const name of ['delegate','executor','reviewer'])await writeFile(join(agentDir,`agents/${name}.md`),`---\nname: ${name}\ndescription: fixture\ntools: read\n---\nfixture\n`);
  await mkdir(join(agentDir,'extensions/subagent'),{recursive:true});await writeFile(join(agentDir,'extensions/subagent/config.json'),JSON.stringify({childToolCeiling:{allowedTools:['read']}}));
 }});
 t.after(async()=>{fail=false;RootBrokerServer.prototype.closeRootSession=original;await h.close();process.env.PI_CODING_AGENT_DIR=oldAgentDir;if(oldState===undefined)delete process.env.PI_CODING_WORKSPACE_DIR;else process.env.PI_CODING_WORKSPACE_DIR=oldState;});
 const drainSessionId=h.session.sessionManager.getSessionId(); const drainSessionFile=h.session.sessionManager.getSessionFile();
 assert.notEqual(drainSessionId,drainSessionFile,'ceiling 键必须是 session manager ID');
 await h.session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});
 assert.ok(h.errors.some(e=>String(e.error).includes('cleanup failed')),'关闭失败必须可观察');
 assert.deepEqual(ceiling.resolveCurrentSubagentCapabilityCeiling(drainSessionId)?.allowedTools,['read'],'drain失败不能放宽仍在运行的child政策');
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(drainSessionFile),undefined,'session file 不是 ceiling 注册键');
 fail=false;
 await h.session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(drainSessionId),undefined,'债务清偿后才释放');
});
