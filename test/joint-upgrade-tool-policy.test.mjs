import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdk, openJointSession, Type } from './helpers/joint-upgrade-session.mjs';

const server = fileURLToPath(new URL('./fixtures/joint-upgrade/mcp-server.mjs', import.meta.url));
// 捕获production删除MCP策略入口或绕过其配置/registry过滤，使未知server启动、非名单工具执行。
test('MCP策略只连接自有明确server；global/project/动态extension不得启动，direct/nested非名单调用数为0', { timeout: 15000 }, async t => {
  const entry = await import('../src/mcp-policy/index.ts');
  let registerDynamic; let configDir;
  const h = await openJointSession({
    factories: [sdk.createCodemodeExtension(), pi => entry.registerMcpPolicy(pi, { agentDir: configDir }), { name:'mcp', builtin:true, replaceable:true, factory:sdk.createMcpExtension() }, pi => { registerDynamic = (name, config) => pi.registerMcpServer(name, config); pi.registerMcpServer('extension_denied', { command: process.execPath, args: [server, join(process.env.TMPDIR, 'never-used')] }); }],
    files: async ({ temp, agentDir, cwd }) => {
      configDir = agentDir;
      const deny = { command: process.execPath, args: [server, join(temp, 'denied.jsonl')] };
      await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { global_denied: deny } }));
      await mkdir(join(cwd, '.pi')); await writeFile(join(cwd, '.pi/mcp.json'), JSON.stringify({ mcpServers: { project_denied: deny } }));
      await mkdir(join(agentDir, 'extensions/mcp-policy'), { recursive: true });
      await writeFile(join(agentDir, 'extensions/mcp-policy/config.json'), JSON.stringify({ servers: { fixture: { connection: { command: process.execPath, args: [server, join(temp, 'allowed.jsonl')] }, tools: { echo: 'direct', fail_data: 'codemode' }, resources: false } } }));
    },
  }); t.after(() => h.close());
  registerDynamic('fixture', { command: process.execPath, args: [server, join(h.temp, 'denied.jsonl')] });
  registerDynamic('late_denied', { command: process.execPath, args: [server, join(h.temp, 'denied.jsonl')] });
  t.diagnostic('invoke allowed direct');
  const echoed = await h.invoke('mcp__fixture__echo', { value: 'fixture-echo' });
  assert.equal(echoed.isError, false); assert.equal(echoed.content[0].text, 'fixture-echo');
  t.diagnostic('invoke codemode');
  const nested = await h.invoke('codemode', { code: 'const r = await tools.mcp__fixture__fail_data({ value: "data-error" }); text(r);' });
  assert.equal(nested.isError, false); assert.match(nested.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), /data-error/); assert.match(nested.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), /isError/);
  for (const [name, args] of [['mcp__fixture__forbidden', {}], ['codemode', { code: 'await tools.mcp__fixture__forbidden({});' }], ['read_mcp_resource', { server: 'fixture', uri: 'fixture://one' }]]) {
    const result = await h.invoke(name, args); assert.equal(result.isError, true, name);
  }
  const lines = (await readFile(join(h.temp, 'allowed.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.filter(x => x.type === 'start').length, 1);
  assert.deepEqual(lines.filter(x => x.type === 'call').map(x => x.name), ['echo', 'fail_data']);
  assert.equal(lines.some(x => x.type === 'resource'), false);
  await assert.rejects(readFile(join(h.temp, 'denied.jsonl')), { code: 'ENOENT' });
  assert.equal(h.session.getAllTools().some(tool => tool.name === 'tool_search'), false);
});

test('MCP策略未配置时连接数为0；非法配置在server启动前失败', { timeout: 15000 }, async t => {
  const { registerMcpPolicy } = await import('../src/mcp-policy/index.ts');
  let configDir;
  const h = await openJointSession({ files: ({ agentDir }) => { configDir = agentDir; }, factories: [pi => registerMcpPolicy(pi, { agentDir: configDir })] }); t.after(() => h.close());
  assert.equal(h.errors.length, 0);
  const result = await h.invoke('mcp__unknown__echo'); assert.equal(result.isError, true);
  await mkdir(join(h.agentDir, 'extensions/mcp-policy'), { recursive: true });
  await writeFile(join(h.agentDir, 'extensions/mcp-policy/config.json'), JSON.stringify({ servers: { fixture: { connection: { command: process.execPath, args: [server, join(h.temp, 'bad.jsonl')] }, tools: { '*': 'direct' } } } }));
  await assert.rejects(() => import('../src/mcp-policy/index.ts').then(m => m.loadMcpPolicy(h.agentDir)), /tool|名单/);
  await assert.rejects(readFile(join(h.temp, 'bad.jsonl')), { code: 'ENOENT' });
});

test('MCP公开资源独立allow，nested返回structured，不按server工具名单越界', {timeout:15000}, async t=>{
 const {registerMcpPolicy}=await import('../src/mcp-policy/index.ts');let dir;
 const h=await openJointSession({factories:[sdk.createCodemodeExtension({models:false}),pi=>registerMcpPolicy(pi,{agentDir:dir})],files:async({temp,agentDir})=>{
  dir=agentDir;await mkdir(join(agentDir,'extensions/mcp-policy'),{recursive:true});await writeFile(join(agentDir,'extensions/mcp-policy/config.json'),JSON.stringify({servers:{fixture:{connection:{command:process.execPath,args:[server,join(temp,'resource.jsonl')]},tools:{echo:'direct'},resources:true}}}));
 }});t.after(()=>h.close());
 assert.equal((await h.invoke('mcp__fixture__echo',{value:'resource-ready'})).isError,false);
 const resource=await h.invoke('codemode',{code:'text(await tools.read_mcp_resource({server:"fixture",uri:"fixture://one"}));'});assert.equal(resource.isError,false,JSON.stringify(resource));assert.match(resource.content.map(c=>c.text??'').join('\n'),/one/);
 const nested=await h.invoke('codemode',{code:'text(await tools.mcp__fixture__echo({value:"nested-structured"}));'});assert.equal(nested.isError,false);assert.match(nested.content.map(c=>c.text??'').join('\n'),/structuredContent/);
 const denied=await h.invoke('read_mcp_resource',{server:'other',uri:'fixture://one'});assert.equal(denied.isError,true);
});
