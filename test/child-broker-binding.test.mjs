import assert from 'node:assert/strict';
import test from 'node:test';
import {createRunAuthorization} from '../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts';
import {RootBrokerServer} from '../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts';
import {AuthorityStore} from '../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';

test('child定位从真实processBirth匹配既有authority/grant，错误root不能授权',async t=>{
 const {resolveChildBrokerIdentity}=await import('../packages/pi-subagents-enhanced/src/subagent-dispatch/child-broker-binding.ts');
 const root=await mkdtemp(join(tmpdir(),'child-broker-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));const id='root-'+process.pid;
 const store=new AuthorityStore({root:join(root,'root-broker-authority',id)});const events={on(){return()=>{};}};
 const broker=new RootBrokerServer({rootSessionId:id,events,authorityStore:store,upstream:{ping(){},stop(){},dispose(){}}});await broker.start();t.after(()=>{broker.ownedRuns.clear();return broker.closeRootSession();});
 const auth=createRunAuthorization({kind:'coding',binding:{runId:'run-'+process.pid,asyncDir:root,sessionId:id,pid:process.pid,agentProfile:'executor'},goal:null});await broker.registerAuthorizedRun(auth);
 const env={PI_SUBAGENT_CHILD:'1',PI_CODING_WORKSPACE_DIR:root,PI_SUBAGENT_EXTENSION_BINDINGS:JSON.stringify({'pi-config.root/1':{rootSessionId:id}})};
 const binding=await resolveChildBrokerIdentity(env);assert.equal(binding.rootSessionId,id);assert.equal(binding.runId,auth.binding.runId);
 await assert.rejects(resolveChildBrokerIdentity({...env,PI_SUBAGENT_EXTENSION_BINDINGS:JSON.stringify({'pi-config.root/1':{rootSessionId:'wrong'}})},{timeoutMs:50}),/identity|binding|身份/);
 const lease=await store.readLease(auth.binding.runId);await store.releaseLease({runId:auth.binding.runId,leaseId:lease.leaseId,ownerGeneration:lease.ownerGeneration,processBirth:lease.processBirth,expectedRevision:lease.revision});
 await assert.rejects(resolveChildBrokerIdentity(env,{timeoutMs:50}),/lease|租约|身份/);
 // 真实run结束由现有broker stop路径处理；本测试只使用自己PID，显式终局fixture避免向宿主发信号。
 broker.ownedRuns.clear();
});
