import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
export { bindPhysicalHostPeers } from './peer-installation.ts';

/** 官方unbundled CLI的精确部署绑定，不解析ambient global。 */
export function resolvePhysicalHost({ hostRoot, nodeBin, env = process.env }: { hostRoot: string; nodeBin: string; env?: NodeJS.ProcessEnv }) {
  if (!path.isAbsolute(hostRoot) || !path.isAbsolute(nodeBin)) throw new Error('physical Host root/Node必须是绝对路径');
  const root = realpathSync(hostRoot);
  const node = realpathSync(nodeBin);
  accessSync(node, constants.X_OK);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '1.4.0') throw new Error('physical Host身份或版本错误');
  for (const peer of ['pi-agent-core', 'pi-ai', 'pi-tui']) {
    const p = JSON.parse(readFileSync(path.join(root, '..', peer, 'package.json'), 'utf8'));
    if (p.name !== '@earendil-works/' + peer || p.version !== '1.4.0') throw new Error('physical Host peer不一致');
  }
  const entry = realpathSync(path.join(root, 'dist/cli.js'));
  const sdk = realpathSync(path.join(root, 'dist/index.js'));
  accessSync(entry, constants.R_OK); accessSync(sdk, constants.R_OK);
  if (env.PI_REAL_BIN && realpathSync(env.PI_REAL_BIN) !== entry) throw new Error('PI_REAL_BIN不匹配physical entry');
  if (env.PI_PACKAGE_DIR && realpathSync(env.PI_PACKAGE_DIR) !== root) throw new Error('PI_PACKAGE_DIR不匹配physical root');
  return { hostRoot: root, nodeBin: node, entry, sdk };
}

/** fresh进程公开Host-backed probe；静态path健康与运行时identity分开。 */
export async function probePhysicalHost({ hostRoot, nodeBin, enhancedPackageRoot }: { hostRoot: string; nodeBin: string; enhancedPackageRoot: string }) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const binding = resolvePhysicalHost({hostRoot,nodeBin,env:{}});
  const temporary = await mkdtemp(path.join(tmpdir(),'physical-host-probe-'));
  try {
    const coding=pathToFileURL(binding.sdk).href;
    const peers=Object.fromEntries(['pi-tui','pi-agent-core','pi-ai'].map(name=>[name,pathToFileURL(path.join(binding.hostRoot,'..',name,'dist',name==='pi-ai'?'compat.js':'index.js')).href]));
    const extension=new URL('./probe-extension.ts',import.meta.url).pathname;
    // watchdog身份：0.79.2 的 subagent_watchdog_warning 由 renderSubagentMessage 返回 SubagentMessageBlock extends Host Box，
    // 不再是直接 Container；因此断言"Host Box 子类"：异源 pi-tui 副本与裸 Box 都 fail closed。
    const source=`import * as sdk from ${JSON.stringify(coding)};
      import * as tui from ${JSON.stringify(peers['pi-tui'])}; import * as core from ${JSON.stringify(peers['pi-agent-core'])}; import * as ai from ${JSON.stringify(peers['pi-ai'])};
      const loaded=await sdk.discoverAndLoadExtensions([${JSON.stringify(extension)}],process.cwd(),process.env.PI_CODING_AGENT_DIR);
      if(loaded.errors.length)throw Error(JSON.stringify(loaded.errors));
      const e=loaded.extensions[0]; const ids=await e.commands.get('physical-host-identity').handler();
      const details={severity:'concern',importance:'high',category:'test-gap',source:'main',state:'displayed',summary:'physical identity',evidence:'actual compat consumer',recommendedAction:'probe'};
      const component=e.messageRenderers.get('subagent_watchdog_warning')({customType:'subagent_watchdog_warning',content:details.summary,display:true,details},{expanded:true},{fg:(_,s)=>s,bold:s=>s});
      const identities={SessionManager:ids.SessionManager===sdk.SessionManager,Container:ids.Container===tui.Container,Agent:ids.Agent===core.Agent,streamSimple:ids.streamSimple===ai.streamSimple,watchdog:component instanceof tui.Box&&component.constructor!==tui.Box};
      loaded.runtime.invalidate();console.log(JSON.stringify({version:'1.4.0',healthy:Object.values(identities).every(Boolean),identities}));`;
    const result=spawnSync(binding.nodeBin,['--input-type=module','-e',source],{cwd:temporary,env:{PATH:path.dirname(binding.nodeBin)+':/usr/bin:/bin',HOME:temporary,TMPDIR:'/tmp',PI_CODING_AGENT_DIR:path.join(temporary,'agent'),PI_PACKAGE_DIR:binding.hostRoot,PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:binding.hostRoot,PI_OFFLINE:'1',PI_TELEMETRY:'0'},encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
    if(result.status!==0)throw new Error('physical Host-backed probe失败: '+result.stderr);
    const report=JSON.parse(result.stdout.trim());
    if(report.version!=='1.4.0'||report.healthy!==true)throw new Error('physical identity不一致: '+result.stdout);
    return report;
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
