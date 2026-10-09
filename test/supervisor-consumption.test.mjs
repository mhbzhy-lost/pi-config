import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupervisorControlPlane, supervisorCanonicalDigest } from '../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts';

test('消费观察只推进同owner/request generation和reply payload的既有queued receipt，重复幂等', async () => {
 let generation=1;
 const plane=createSupervisorControlPlane({readOwnerReceipt:async runId=>({runId,rootSessionId:'root',ownerGeneration:generation}),readRuntime:async runId=>({runId,ownerGeneration:generation,running:false,steerable:false})});
 await plane.registerSupervisorRequest({id:'ask',runId:'run',agent:'executor',reason:'need_decision',expectsReply:true},'root');
 const intent={schemaVersion:'supervisor-control-intent.v1',intentId:'reply',rootSessionId:'root',runId:'run',ownerGeneration:1,kind:'reply',requestId:'ask',requestGeneration:1,payloadDigest:supervisorCanonicalDigest('reply')};
 await plane.commitDelivery({intent},'root');
 assert.equal(typeof plane.observeReplyConsumption,'function','缺少真正消费观察的production接点');
 assert.equal((await plane.observeReplyConsumption({runId:'run',requestId:'ask',payloadDigest:supervisorCanonicalDigest('different')},'root')).status,'blocked');
 generation=2;assert.equal((await plane.observeReplyConsumption({runId:'run',requestId:'ask',payloadDigest:intent.payloadDigest},'root')).status,'blocked');
 generation=1;
 const delivered=await plane.observeReplyConsumption({runId:'run',requestId:'ask',payloadDigest:intent.payloadDigest},'root');assert.equal(delivered.status,'committed');assert.equal(delivered.receipt.consumed,true);
 assert.equal(plane.findRequest('ask').state,'replied');
 const repeated=await plane.observeReplyConsumption({runId:'run',requestId:'ask',payloadDigest:intent.payloadDigest},'root');assert.equal(repeated.receipt.receiptId,delivered.receipt.receiptId);
});

test('已delivered的持久化receipt可fresh plane恢复，不把自身生成payload记录判corrupt', async t => {
 const {mkdtemp,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'supervisor-consumed-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options={persistenceRoot:root,readOwnerReceipt:async runId=>({runId,rootSessionId:'root',ownerGeneration:1}),readRuntime:async runId=>({runId,ownerGeneration:1,running:false,steerable:false})};
 const plane=createSupervisorControlPlane(options);await plane.registerSupervisorRequest({id:'ask',runId:'run',agent:'executor',reason:'need_decision',expectsReply:true},'root');
 const intent={schemaVersion:'supervisor-control-intent.v1',intentId:'reply',rootSessionId:'root',runId:'run',ownerGeneration:1,kind:'reply',requestId:'ask',requestGeneration:1,payloadDigest:supervisorCanonicalDigest('reply')};
 const delivered=await plane.commitDelivery({intent,consumed:true},'root');assert.equal(delivered.receipt.status,'delivered');
 const fresh=createSupervisorControlPlane(options);assert.equal(await fresh.ready('root'),true);
 const replay=await fresh.resolveSupervisorControl(intent,'root');assert.equal(replay.status,'idempotent');assert.equal(replay.receipt.receiptId,delivered.receipt.receiptId);assert.equal(replay.receipt.consumed,true);
});

test('两个fresh plane并发公开register/commit同root，不丢各自durable request/receipt',async t=>{
 const{mkdtemp,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'supervisor-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options={persistenceRoot:root,readOwnerReceipt:async runId=>({runId,rootSessionId:'root',ownerGeneration:1}),readRuntime:async runId=>({runId,ownerGeneration:1,running:true,steerable:true})};
 const planes=[createSupervisorControlPlane(options),createSupervisorControlPlane(options)];await Promise.all(planes.map((p,i)=>p.registerSupervisorRequest({id:'ask-'+i,runId:'run-'+i,agent:'executor',reason:'need_decision',expectsReply:true},'root')));
 await Promise.all(planes.map((p,i)=>p.commitDelivery({intent:{schemaVersion:'supervisor-control-intent.v1',intentId:'reply-'+i,rootSessionId:'root',runId:'run-'+i,ownerGeneration:1,kind:'reply',requestId:'ask-'+i,requestGeneration:1,payloadDigest:supervisorCanonicalDigest('reply-'+i)},consumed:true},'root')));
 const fresh=createSupervisorControlPlane(options);assert.equal(await fresh.ready('root'),true);assert.deepEqual(fresh.snapshot().requests.map(r=>r.requestId).sort(),['ask-0','ask-1']);assert.ok(fresh.snapshot().requests.every(r=>r.state==='replied'));
});

test('TTL内真实消费在TTL后终局观察同事务收敛replied，关闭的旧receipt不能复活',async t=>{
 const{mkdtemp,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'supervisor-late-consumption-'));t.after(()=>rm(root,{recursive:true,force:true}));let clock=Date.now();
 const plane=createSupervisorControlPlane({persistenceRoot:root,now:()=>clock,readOwnerReceipt:async runId=>({runId,rootSessionId:'root',ownerGeneration:1}),readRuntime:async runId=>({runId,ownerGeneration:1,running:false,steerable:false})});
 await plane.registerSupervisorRequest({id:'ask',runId:'run',agent:'executor',reason:'need_decision',expectsReply:true},'root');const intent={schemaVersion:'supervisor-control-intent.v1',intentId:'reply',rootSessionId:'root',runId:'run',ownerGeneration:1,kind:'reply',requestId:'ask',requestGeneration:1,payloadDigest:supervisorCanonicalDigest('reply')};await plane.commitDelivery({intent},'root');
 clock+=21*60*1000;
 const observed=await plane.observeReplyConsumption({runId:'run',requestId:'ask',payloadDigest:intent.payloadDigest},'root');assert.equal(observed.receipt.status,'delivered');assert.equal(plane.findRequest('ask').state,'replied','不能expired与delivered矛盾');
 await plane.registerSupervisorRequest({id:'ask-closed',runId:'run-closed',agent:'executor',reason:'need_decision',expectsReply:true},'root');await plane.commitDelivery({intent:{...intent,intentId:'closed-reply',requestId:'ask-closed',runId:'run-closed'}},'root');await plane.closeRootRequests('root');assert.equal((await plane.observeReplyConsumption({runId:'run-closed',requestId:'ask-closed',payloadDigest:intent.payloadDigest},'root')).status,'blocked');
});
