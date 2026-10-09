import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { candidateEnvironment } from './helpers/joint-upgrade-environment.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveJointUpgradeLayout } from './helpers/joint-upgrade-layout.mjs';
const { repoRoot: c, candidateRoot, hostRoot: h } = resolveJointUpgradeLayout();

test('physical launcher显式root/Node，不信任ambient bundle或错误entry，不回退global',()=>{
 const launcher=path.resolve(import.meta.dirname,'../scripts/pi-launcher.zsh');
 const env={...candidateEnvironment({candidateRoot:candidateRoot,hostRoot:h,nodeBin:process.execPath}),PI_HOST_NODE:process.execPath,PI_HOST_ROOT:h};
 const good=spawnSync('/bin/zsh',['-f',launcher,'--version'],{env,encoding:'utf8',timeout:15000});assert.equal(good.status,0,good.stderr);assert.equal(good.stdout.trim(),'1.0.4');
 for(const extra of [{PI_REAL_BIN:path.join(h,'dist/bundle/cli.js')},{PI_HOST_ROOT:'/missing/host'},{PI_HOST_NODE:'/missing/node'}]){
  const denied=spawnSync('/bin/zsh',['-f',launcher,'--version'],{env:{...env,...extra},encoding:'utf8',timeout:15000});assert.notEqual(denied.status,0,'不能回退其他runtime');assert.doesNotMatch(denied.stdout,/^1\.0\.4$/m);
 }
});

test('wrapper拒绝不加载扩展的shell MCP维护入口，未知server启动数0',async()=>{
 const{mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const root=await mkdtemp(path.join(tmpdir(),'launcher-mcp-deny-'));
 try{const agent=path.join(root,'agent');await mkdir(agent);const capture=path.join(root,'unapproved-start.jsonl');const server=path.resolve(import.meta.dirname,'fixtures/joint-upgrade/mcp-server.mjs');await writeFile(path.join(agent,'mcp.json'),JSON.stringify({mcpServers:{unapproved:{command:process.execPath,args:[server,capture]}}}));
 const env={...candidateEnvironment({candidateRoot:candidateRoot,hostRoot:h,nodeBin:process.execPath}),PI_HOST_NODE:process.execPath,PI_HOST_ROOT:h,PI_CODING_AGENT_DIR:agent};
 for(const args of [['mcp','list','--json'],['--offline','mcp','list','--json']]){const run=spawnSync('/bin/zsh',['-f',path.resolve(import.meta.dirname,'../scripts/pi-launcher.zsh'),...args],{env,encoding:'utf8',timeout:15000});assert.notEqual(run.status,0);assert.match(run.stderr,/MCP.*维护|shell.*mcp/i);}
 await assert.rejects(readFile(capture),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
