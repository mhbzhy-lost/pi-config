import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// 全链入口为官方physical CLI + 正式typed runtime + actual detached child，不手写消息/proof。
for (const scenario of ['ask','interview','progress','timeout','managed','stop','duplicate','ceiling','empty','invalid-reply','repeat-question','child-mcp','two-asks']) test('真实physical parent/Node detached supervisor: '+scenario, { timeout: 60000 }, async t => {
 const repo=resolve(import.meta.dirname,'..'); const host=process.env.PI_TEST_CODING_AGENT_ROOT;
 const root=await mkdtemp(join(tmpdir(),'joint-contact-e2e-'));const agent=join(root,'agent');const cwd=join(root,'cwd');const capture=join(root,'capture.jsonl');
 await mkdir(join(agent,'agents'),{recursive:true});await mkdir(cwd);await mkdir(join(root,'home'));await mkdir(join(root,'tmp'));
 if(scenario==='managed') {
   execFileSync('git',['init','-b','main'],{cwd,stdio:'ignore'});execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd});execFileSync('git',['config','user.name','隔离测试'],{cwd});
   await writeFile(join(cwd,'base.txt'),'fixture\n');execFileSync('git',['add','base.txt'],{cwd});execFileSync('git',['commit','-m','test(fixture): 创建隔离基线'],{cwd,stdio:'ignore'});
 }
 const provider=fileURLToPath(new URL('./fixtures/joint-upgrade/contact-provider.mjs',import.meta.url));
 for(const name of ['delegate','executor','reviewer'])await writeFile(join(agent,`agents/${name}.md`),`---\nname: ${name}\ndescription: fixture\nmodel: joint-contact/fixture\ntools: ${scenario==='child-mcp'?'read,contact_supervisor,codemode,mcp__fixture__echo':'read,contact_supervisor'}\nextensions: ${provider}${scenario==='child-mcp'?','+join(repo,'pi/extensions/mcp-policy.ts'):''}\n---\n执行隔离测试请求。\n`);
 await writeFile(join(root,'trace.jsonl'),'',{mode:0o600});
 if(scenario==='child-mcp') {
  await mkdir(join(agent,'extensions/mcp-policy'),{recursive:true});await writeFile(join(agent,'extensions/mcp-policy/config.json'),JSON.stringify({servers:{fixture:{connection:{command:process.execPath,args:[join(repo,'test/fixtures/joint-upgrade/mcp-server.mjs'),join(root,'child-mcp.jsonl')]},tools:{echo:'codemode'},resources:false}}}));
 }
 if(['ceiling','empty'].includes(scenario)) {
  await mkdir(join(agent,'extensions/subagent'),{recursive:true});await writeFile(join(agent,'extensions/subagent/config.json'),JSON.stringify({childToolCeiling:{allowedTools:scenario==='empty'?[]:['read','contact_supervisor']}}));
 }
 const env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:join(root,'home'),TMPDIR:process.env.JOINT_SHARED_TMP??join(root,'tmp'),XDG_STATE_HOME:join(root,'state'),PI_CODING_AGENT_DIR:agent,PI_CODING_WORKSPACE_DIR:join(root,'workspace'),PI_PACKAGE_DIR:host,PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:host,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0',PI_INTERCOM_ASK_TIMEOUT_MS:['timeout','invalid-reply'].includes(scenario)?'1500':'20000',JOINT_CONTACT_CASE:scenario,JOINT_CONTACT_CAPTURE:capture,PI_SUBAGENT_DISPATCH_TRACE_FILE:join(root,'trace.jsonl')};
 const child=spawn(process.execPath,[join(host,'dist/cli.js'),'--mode','rpc','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','-e',provider,'-e',join(repo,'packages/pi-subagents-enhanced/extensions/subagent-runtime.ts'),'--provider','joint-contact','--model','joint-contact/fixture'],{cwd,env,stdio:['pipe','pipe','pipe']});
 const records=[];let buffer='',stderr='';child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',c=>{buffer+=c;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{records.push(JSON.parse(line));}catch{}}});
 const close=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 t.after(async()=>{child.stdin.end();if(child.exitCode===null)child.kill('SIGTERM');await close;});
 child.stdin.write(JSON.stringify({id:'start',type:'prompt',message:'JOINT_PARENT_ASK'})+'\n');
 let spawnResult;
 const until=Date.now()+45000;
 while(Date.now()<until){
  spawnResult=records.find(r=>r.type==='tool_execution_end'&&r.toolName==='subagent')?.result;
  if(spawnResult?.isError)break;
  if(spawnResult?.details?.asyncDir){
    try{const s=JSON.parse(await readFile(join(spawnResult.details.asyncDir,'status.json'),'utf8'));if(!['running','queued'].includes(s.state))break;}catch{}
  }
  if(child.exitCode!==null)break;await delay(50);
 }
 await writeFile(join(root,'parent-events.json'),JSON.stringify(records,null,2));await writeFile(join(root,'parent-stderr.txt'),stderr);
 t.diagnostic('证据目录：'+root);
 assert.ok(spawnResult,'父typed spawn结果缺失：'+stderr);assert.equal(spawnResult.isError,false,JSON.stringify(spawnResult));
 const status=JSON.parse(await readFile(join(spawnResult.details.asyncDir,'status.json'),'utf8'));
 await delay(500);
 const events=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(status.steps[0].model,'joint-contact/fixture','实际runner model，不用请求modelSelection替代');
 assert.equal(events.find(e=>e.child&&e.type==='identities')?.allEqual,true,'child内部四core严格同identity');assert.equal(events.find(e=>!e.child&&e.type==='identities')?.allEqual,true,'parent内部四core严格同identity');
 const actual=events.find(e=>e.child&&e.type==='start').actualModel;assert.deepEqual(actual,{provider:'joint-contact',id:'fixture',api:'joint-contact'});
 assert.deepEqual(new Set(status.runtimeAcknowledgedExtensions?.ids), new Set(['root-session-owner','integration-queue']), 'C11 required实际runtime ACK缺失');
if(scenario==='child-mcp') {
 const childStart=events.find(e=>e.child&&e.type==='start');assert.ok(childStart.tools.some(t=>t.name==='codemode'));assert.ok(!childStart.tools.some(t=>t.name==='mcp__fixture__forbidden'));
 const output=await readFile(status.outputFile,'utf8');assert.match(output,/child-mcp-allowed/);assert.match(output,/denied:/);const calls=(await readFile(join(root,'child-mcp.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(calls.filter(c=>c.type==='call').map(c=>c.name),['echo']);return;
}
if(scenario==='empty') {const childStart=events.find(e=>e.child&&e.type==='start');assert.deepEqual(childStart.tools,[],'空allowedTools应等于实际零工具');assert.deepEqual(status.launchResolvedExtensions.required,['root-session-owner','integration-queue']);return;}
 if(scenario==='ceiling'){assert.deepEqual(events.find(e=>e.child&&e.type==='start').tools.map(t=>t.name).sort(),['contact_supervisor','read']);}
 const childResult=events.find(e=>e.child&&e.message?.toolName==='contact_supervisor');
 if(scenario!=='stop') assert.ok(childResult,'真实child没有contact工具结果');
 if(scenario==='progress') { assert.equal(childResult.message.isError,false); assert.match(childResult.message.content[0].text,/queued/); assert.equal(events.some(e=>!e.child&&e.message?.customType==='subagent_supervisor_request'),false); return; }
 if(scenario==='managed') { assert.ok(events.find(e=>e.child&&e.type==='root-owner-ready'),'managed child必须通过真实grant建立root.subscribe，不能只是ACK加载'); }
 const request=events.findLast(e=>!e.child&&e.message?.customType==='subagent_supervisor_request');
 assert.ok(request,'父message_end未收到实际阻塞请求：'+JSON.stringify({status,events,stderr}));
 if(scenario==='stop') { assert.notEqual(status.state,'complete','stop不能被误标成功');const f=join(root,'workspace/supervisor-control');const persisted=await Promise.all((await readdir(f)).filter(x=>x.endsWith('.json')).map(async x=>JSON.parse(await readFile(join(f,x),'utf8')).value));assert.equal(persisted.flatMap(x=>x.requests).find(x=>x.requestId===request.message.details.requestId).state,'failed','stop不能留下幽灵pending');assert.equal(events.some(e=>!e.child&&e.message?.toolName==='subagent_supervisor'&&e.message.details?.replyTo),false);return; }
 if(scenario==='invalid-reply') {
   const replies=events.filter(e=>!e.child&&e.message?.toolName==='subagent_supervisor');assert.equal(replies.length,3);assert.ok(replies.every(e=>e.message.isError===true&&e.message.details.code==='SUPERVISOR_REQUEST_NOT_PENDING'));assert.equal(childResult.message.isError,true);return;
 }
 if(scenario==='timeout') {
   assert.equal(childResult.message.isError,true); assert.match(childResult.message.content[0].text,/Timed out/);
   const folder=join(root,'workspace/supervisor-control');const files=await readdir(folder);const states=await Promise.all(files.filter(x=>x.endsWith('.json')).map(async x=>JSON.parse(await readFile(join(folder,x),'utf8')).value));
   assert.equal(states.flatMap(s=>s.requests).find(r=>r.requestId===request.message.details.requestId).state,'expired','真实native timeout不得保留20分钟幽灵pending');return;
 }
 const pending=events.find(e=>!e.child&&e.message?.toolName==='subagent_supervisor'&&e.message.details?.pending?.some(r=>r.id===request.message.details.requestId));assert.ok(pending,'native pending必须包含同UUID');
 const reply=events.find(e=>!e.child&&e.message?.toolName==='subagent_supervisor'&&e.message.details?.replyTo===request.message.details.requestId);assert.ok(reply,'父reply缺失');assert.equal(reply.message.isError,false,JSON.stringify(reply.message));
 const consumed=events.find(e=>e.child&&e.message?.toolName==='contact_supervisor'&&e.message.details?.requestId===request.message.details.requestId);assert.ok(consumed,'actual detached child waiter没有消费');assert.equal(consumed.message.isError,false);assert.match(consumed.message.content.map(c=>c.text??'').join('\n'),/joint-reply-nonce/);
 if(scenario==='interview') assert.deepEqual(consumed.message.details.structuredReply,{answer:'joint-reply-nonce'});
 if(scenario==='duplicate') {const replies=events.filter(e=>!e.child&&e.message?.toolName==='subagent_supervisor'&&!e.message.details?.pending);assert.equal(replies.length,2);assert.equal(replies.filter(e=>e.message.isError===false).length,1);assert.equal(replies.find(e=>e.message.isError===true).message.details.code,'SUPERVISOR_DELIVERY_IDEMPOTENT');}
 if(['repeat-question','two-asks'].includes(scenario)){const asks=events.filter(e=>!e.child&&e.message?.customType==='subagent_supervisor_request');const consumedAll=events.filter(e=>e.child&&e.message?.toolName==='contact_supervisor');assert.equal(asks.length,2);assert.equal(consumedAll.length,2);assert.ok(consumedAll.every(e=>e.message.isError===false));assert.notEqual(asks[0].message.details.requestId,asks[1].message.details.requestId);}
 assert.equal(status.state,'complete',JSON.stringify(status));
 const folder=join(root,'workspace/supervisor-control');const files=await readdir(folder);const states=await Promise.all(files.filter(x=>x.endsWith('.json')).map(async x=>JSON.parse(await readFile(join(folder,x),'utf8')).value));
 const receipt=states.flatMap(s=>s.receipts).find(r=>r.requestId===request.message.details.requestId);const authoritative=states.flatMap(s=>s.requests).find(r=>r.requestId===request.message.details.requestId);
 assert.equal(typeof authoritative.correlation?.childSessionId,'string','注册时缺canonical child session binding');assert.equal(authoritative.correlation.toolCallId,consumed.message.toolCallId);assert.equal(authoritative.correlation.reason,consumed.message.details.reason);
 assert.equal(receipt.status,'delivered','C6: 实际消费后receipt仍queued');assert.equal(receipt.consumed,true);assert.equal(authoritative.state,'replied');
});

// 缺namespace/owner/request/payload任一绑定都不得推进；不凭terminal成功判定consumed。

// request注册时必须绑定正在运行的canonical child，而非terminal时才信任status路径。

test('C8 fresh parent稳定拒绝旧关闭generation的ask，不误写消费或双投递', {timeout:60000}, async t=>{
 const repo=resolve(import.meta.dirname,'..'),host=process.env.PI_TEST_CODING_AGENT_ROOT,root=await mkdtemp(join(tmpdir(),'joint-contact-restart-'));
 const agent=join(root,'agent'),cwd=join(root,'cwd'),capture=join(root,'capture.jsonl'),provider=fileURLToPath(new URL('./fixtures/joint-upgrade/contact-provider.mjs',import.meta.url));
 await mkdir(join(agent,'agents'),{recursive:true});await mkdir(cwd);await mkdir(join(root,'home'));await mkdir(join(root,'tmp'));
 for(const name of ['delegate','executor','reviewer'])await writeFile(join(agent,`agents/${name}.md`),`---\nname: ${name}\ndescription: fixture\nmodel: joint-contact/fixture\ntools: read,contact_supervisor\nextensions: ${provider}\n---\nfixture\n`);
 await writeFile(join(root,'trace.jsonl'),'',{mode:0o600});
 const id='restart-'+process.pid;let env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:join(root,'home'),TMPDIR:join(root,'tmp'),PI_CODING_AGENT_DIR:agent,PI_CODING_WORKSPACE_DIR:join(root,'state'),PI_CODING_AGENT_SESSION_DIR:join(root,'sessions'),PI_PACKAGE_DIR:host,PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:host,PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_INTERCOM_ASK_TIMEOUT_MS:'30000',PI_SUBAGENT_DISPATCH_TRACE_FILE:join(root,'trace.jsonl'),JOINT_CONTACT_CAPTURE:capture,JOINT_CONTACT_CASE:'restart-first'};
 const launch=()=>{const p=spawn(process.execPath,[join(host,'dist/cli.js'),'--mode','rpc','--session-id',id,'--no-extensions','--no-skills','--no-themes','--no-context-files','--no-prompt-templates','-e',provider,'-e',join(repo,'packages/pi-subagents-enhanced/extensions/subagent-runtime.ts'),'--provider','joint-contact','--model','joint-contact/fixture'],{cwd,env,stdio:['pipe','pipe','pipe']});let buf='';const records=[];let err='';p.stdout.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\n'))>=0){try{records.push(JSON.parse(buf.slice(0,n)));}catch{}buf=buf.slice(n+1);}});p.stderr.on('data',c=>err+=c);const closed=new Promise(resolve=>p.once('close',resolve));return{p,records,closed,error:()=>err};};
 let current=launch();t.after(async()=>{current.p.stdin.end();if(current.p.exitCode===null)current.p.kill('SIGTERM');await current.closed;});
 current.p.stdin.write(JSON.stringify({id:'first',type:'prompt',message:'JOINT_PARENT_ASK'})+'\n');
 const deadline=Date.now()+15000;while(!current.records.some(r=>r.type==='message_end'&&r.message?.customType==='subagent_supervisor_request')&&Date.now()<deadline)await delay(50);
 const request=current.records.find(r=>r.type==='message_end'&&r.message?.customType==='subagent_supervisor_request');assert.ok(request,current.error());
 current.p.stdin.end();await current.closed;
 env={...env,JOINT_CONTACT_CASE:'ask'};current=launch();current.p.stdin.write(JSON.stringify({id:'second',type:'prompt',message:'JOINT_PARENT_RECOVER'})+'\n');
 const end=Date.now()+10000;let messages=[];
 while(Date.now()<end){try{messages=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);}catch{}if(messages.some(e=>!e.child&&e.message?.toolName==='subagent_supervisor'&&e.message.isError===true))break;await delay(50);}
 const blocked=messages.find(e=>!e.child&&e.message?.toolName==='subagent_supervisor'&&e.message.isError===true);assert.ok(blocked,'fresh必须稳定拒绝旧请求');
 const states=await Promise.all((await readdir(join(root,'state/supervisor-control'))).filter(x=>x.endsWith('.json')).map(async x=>JSON.parse(await readFile(join(root,'state/supervisor-control',x),'utf8')).value));
 assert.equal(states.flatMap(s=>s.requests).find(r=>r.requestId===request.message.details.requestId).state,'failed');
 assert.equal(states.flatMap(s=>s.receipts).some(r=>r.consumed===true),false);
 assert.equal(messages.filter(e=>!e.child&&e.message?.toolName==='subagent_supervisor'&&e.message.details?.replyTo).length,0,'旧generation不得投递');
 t.diagnostic('fresh-parent证据目录：'+root);
});


test('C10两个fresh父Host共享native临时通路，同名child与reply UUID不会串线', {timeout:60000}, async t=>{
 const shared=await mkdtemp(join(tmpdir(),'joint-supervisor-shared-'));
 const launch=()=>new Promise((resolve,reject)=>{
   const p=spawn(process.execPath,['--test','--test-name-pattern=supervisor: ask$',import.meta.filename],{env:{...process.env,NODE_TEST_CONTEXT:undefined,JOINT_SHARED_TMP:shared},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.once('error',reject);p.once('close',code=>resolve({code,out,err}));
 });
 const results=await Promise.all([launch(),launch()]);
 for(const result of results)assert.equal(result.code,0,result.out+result.err);
 const roots=results.map(result=>result.out.match(/证据目录：([^\s]+)/)?.[1]);assert.ok(roots.every(Boolean),JSON.stringify(results));
 const captures=await Promise.all(roots.map(async root=>(await readFile(join(root,'capture.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)));
 const requests=captures.map(events=>events.find(e=>!e.child&&e.message?.customType==='subagent_supervisor_request').message.details);
 assert.notEqual(requests[0].requestId,requests[1].requestId);assert.notEqual(requests[0].runId,requests[1].runId);
 for(let i=0;i<2;i++){const ids=captures[i].filter(e=>e.child&&e.message?.toolName==='contact_supervisor').map(e=>e.message.details?.requestId);assert.deepEqual(ids,[requests[i].requestId]);assert.ok(!ids.includes(requests[1-i].requestId));}
 t.diagnostic(JSON.stringify({shared,roots,requestIds:requests.map(r=>r.requestId)}));
});


for(const lifecycle of ['root-close','lease-expire']) test('C9 managed真实root.subscribe生命周期 '+lifecycle,{timeout:100000},async t=>{
 const repo=resolve(import.meta.dirname,'..'),host=process.env.PI_TEST_CODING_AGENT_ROOT,root=await mkdtemp(join(tmpdir(),'joint-root-lifecycle-'));const agent=join(root,'agent'),cwd=join(root,'repo'),capture=join(root,'capture.jsonl'),provider=join(repo,'test/fixtures/joint-upgrade/contact-provider.mjs');
 await mkdir(join(agent,'agents'),{recursive:true});await mkdir(cwd);await mkdir(join(root,'tmp'));await mkdir(join(root,'home'));
 execFileSync('git',['init','-b','main'],{cwd,stdio:'ignore'});execFileSync('git',['config','user.name','隔离测试'],{cwd});execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd});await writeFile(join(cwd,'base.txt'),'base\n');execFileSync('git',['add','base.txt'],{cwd});execFileSync('git',['commit','-m','test(fixture): 创建生命周期基线'],{cwd,stdio:'ignore'});
 for(const name of ['delegate','executor','reviewer'])await writeFile(join(agent,`agents/${name}.md`),`---\nname: ${name}\ndescription: fixture\nmodel: joint-contact/fixture\ntools: read,contact_supervisor\nextensions: ${provider}\n---\nfixture\n`);
 const env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:join(root,'home'),TMPDIR:join(root,'tmp'),PI_CODING_AGENT_DIR:agent,PI_CODING_WORKSPACE_DIR:join(root,'state'),PI_PACKAGE_DIR:host,PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:host,PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_INTERCOM_ASK_TIMEOUT_MS:'90000',JOINT_CONTACT_CASE:lifecycle,JOINT_CONTACT_CAPTURE:capture};
 const parent=spawn(process.execPath,[join(host,'dist/cli.js'),'--mode','rpc','--no-session','--no-extensions','--no-skills','--no-themes','--no-context-files','--no-prompt-templates','-e',provider,'-e',join(repo,'packages/pi-subagents-enhanced/extensions/subagent-runtime.ts'),'--provider','joint-contact','--model','joint-contact/fixture'],{cwd,env,stdio:['pipe','pipe','pipe']});let out='',err='';parent.stdout.on('data',c=>out+=c);parent.stderr.on('data',c=>err+=c);const closed=new Promise(resolve=>parent.once('close',resolve));let runner;
 t.after(async()=>{if(parent.exitCode===null)parent.kill('SIGKILL');await closed;if(runner){try{process.kill(runner.pid,'SIGTERM');}catch{}}});parent.stdin.write(JSON.stringify({id:'start',type:'prompt',message:'JOINT_LIFECYCLE'})+'\n');
 const readyDeadline=Date.now()+15000;let events=[];
 while(Date.now()<readyDeadline){try{events=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);}catch{}if(events.some(e=>e.child&&e.type==='root-owner-ready')&&events.some(e=>!e.child&&e.message?.customType==='subagent_supervisor_request'))break;await delay(50);}
 assert.ok(events.some(e=>e.child&&e.type==='root-owner-ready'),err+out.slice(-1500));runner=events.find(e=>e.child&&e.type==='start');assert.ok(runner);const handle=events.find(e=>!e.child&&e.message?.toolName==='subagent').message.details;
 const alive=()=>{try{process.kill(runner.pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
 if(lifecycle==='root-close'){parent.stdin.end();await closed;await writeFile(join(root,'parent-stderr.txt'),err);await writeFile(join(root,'parent-events.txt'),out);t.diagnostic(root+' '+err.slice(-3500));}
 else {parent.kill('SIGKILL');await closed;await delay(500);assert.equal(alive(),true,'有效lease的EOF不应立即杀child');}
 const deadline=Date.now()+(lifecycle==='lease-expire'?75000:15000);while(alive()&&Date.now()<deadline)await delay(200);
 assert.equal(alive(),false,'root close或真实lease过期必须结束同birth child');
 const states=await Promise.all((await readdir(join(root,'state/supervisor-control'))).filter(x=>x.endsWith('.json')).map(async x=>JSON.parse(await readFile(join(root,'state/supervisor-control',x),'utf8')).value));assert.equal(states.flatMap(s=>s.receipts).some(r=>r.consumed),false,'未回复不能声称delivered');
 if(lifecycle==='root-close'){const status=JSON.parse(await readFile(join(handle.asyncDir,'status.json'),'utf8'));assert.equal(status.processTerminal.state,'observed');assert.equal(states.flatMap(s=>s.requests)[0].state,'failed');}
 t.diagnostic(JSON.stringify({lifecycle,root,childPid:runner.pid,runId:handle.runId}));runner=undefined;
});
