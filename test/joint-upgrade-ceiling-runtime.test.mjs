import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sdk, openJointSession } from './helpers/joint-upgrade-session.mjs';
import runtime from '../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts';
const req = createRequire(new URL('../packages/pi-subagents-enhanced/package.json', import.meta.url));
const ceiling = await import(pathToFileURL(req.resolve('pi-subagents/capability-ceiling')));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR; const oldState = process.env.PI_CODING_WORKSPACE_DIR;

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
 const identity = h.session.sessionManager.getSessionFile() ?? h.session.sessionId;
 assert.deepEqual(ceiling.resolveCurrentSubagentCapabilityCeiling(identity)?.allowedTools, ['contact_supervisor', 'read']);
 await h.session.bindExtensions({ mode: 'print', onError: error => h.errors.push(error) });
 assert.deepEqual(h.errors, []);
 assert.deepEqual(ceiling.resolveCurrentSubagentCapabilityCeiling(identity)?.allowedTools, ['contact_supervisor', 'read']);
 await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(identity), undefined);
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(h.session.sessionId), undefined);
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
 const identity=h.session.sessionManager.getSessionFile() ?? h.session.sessionId;
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(identity),undefined,'startup失败回滚ceiling');
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
 const id=h.session.sessionManager.getSessionFile()??h.session.sessionId;
 await h.session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});
 assert.ok(h.errors.some(e=>String(e.error).includes('cleanup failed')),'关闭失败必须可观察');
 assert.deepEqual(ceiling.resolveCurrentSubagentCapabilityCeiling(id)?.allowedTools,['read'],'drain失败不能放宽仍在运行的child政策');
 fail=false;
 await h.session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});
 assert.equal(ceiling.resolveCurrentSubagentCapabilityCeiling(id),undefined,'债务清偿后才释放');
});
