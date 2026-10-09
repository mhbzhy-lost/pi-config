import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePiCodingAgentRoot } from './helpers/pi-runtime.mjs';

// 捕获安装器保留同版本第二份Pi，使普通native ESM module identity不同。
test('安装将enhanced的四core peer绑定到权威physical root，重复运行不变，不碰其他依赖', async t => {
 const { bindPhysicalHostPeers }=await import('../packages/pi-subagents-enhanced/src/host-runtime/peer-installation.ts');
 const temp=await mkdtemp(join(tmpdir(),'joint-peers-')); t.after(()=>rm(temp,{recursive:true,force:true}));
 const enhanced=join(temp,'enhanced');const host=join(temp,'node_modules/@earendil-works/pi-coding-agent');
 await mkdir(enhanced); await writeFile(join(enhanced,'package.json'),JSON.stringify({name:'pi-subagents-enhanced'}));
 for(const name of ['pi-coding-agent','pi-agent-core','pi-ai','pi-tui']) {
  const source=join(temp,'node_modules/@earendil-works',name);const duplicate=join(enhanced,'node_modules/@earendil-works',name);
  for(const dir of [source,duplicate]) {await mkdir(dir,{recursive:true});await writeFile(join(dir,'package.json'),JSON.stringify({name:'@earendil-works/'+name,version:'1.0.4',type:'module',exports:{'.':{import:'./index.js'}}}));await writeFile(join(dir,'index.js'),'export class Identity {}\n');}
 }
 await mkdir(join(enhanced,'node_modules/pi-subagents'),{recursive:true});await writeFile(join(enhanced,'node_modules/pi-subagents/package.json'),'{}');
 const upstreamBefore=await realpath(join(enhanced,'node_modules/pi-subagents'));
 const source=await import(pathToFileURL(join(host,'../pi-tui/index.js')));
 await bindPhysicalHostPeers({enhancedPackageRoot:enhanced,hostRoot:host});
 await bindPhysicalHostPeers({enhancedPackageRoot:enhanced,hostRoot:host});
 const native=await import(pathToFileURL(join(enhanced,'node_modules/@earendil-works/pi-tui/index.js')));
 assert.strictEqual(native.Identity,source.Identity);
 for(const name of ['pi-coding-agent','pi-agent-core','pi-ai','pi-tui'])assert.equal(await realpath(join(enhanced,'node_modules/@earendil-works',name)),await realpath(join(host,'..',name)));
 assert.equal(await realpath(join(enhanced,'node_modules/pi-subagents')),upstreamBefore);
});

test('peer绑定拒绝指向package外的node_modules父symlink，不能改写外部目录',async t=>{
 const {bindPhysicalHostPeers}=await import('../packages/pi-subagents-enhanced/src/host-runtime/index.ts');
 const {symlink}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'peer-parent-boundary-'));t.after(()=>rm(root,{recursive:true,force:true}));const pkg=join(root,'pkg'),outside=join(root,'outside');await mkdir(pkg);await mkdir(outside);await symlink(outside,join(pkg,'node_modules'));
 // root 经 helper 缺省解析本仓物理 SDK；显式 PI_TEST_CODING_AGENT_ROOT 仍可 pin，
 // 不要求用户手工配置 env 才能运行。
 const host=resolvePiCodingAgentRoot();assert.ok(host);
 await assert.rejects(bindPhysicalHostPeers({enhancedPackageRoot:pkg,hostRoot:host}),e=>e.message==='physical peer parent边界非法');
 await assert.rejects(realpath(join(outside,'@earendil-works/pi-tui')),{code:'ENOENT'});
});
