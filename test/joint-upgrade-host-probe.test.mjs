import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolveJointUpgradeLayout } from './helpers/joint-upgrade-layout.mjs';

test('fresh physical Host probe用官方loader真实compat/watchdog对照四core identity',async()=>{
 const {probePhysicalHost}=await import('../packages/pi-subagents-enhanced/src/host-runtime/index.ts');
 const { repoRoot, hostRoot: host } = resolveJointUpgradeLayout();
 assert.equal(typeof probePhysicalHost,'function');
 const result=await probePhysicalHost({hostRoot:host,nodeBin:process.execPath,enhancedPackageRoot:path.join(repoRoot,'packages/pi-subagents-enhanced')});
 // 权威契约钉扎当前 physical Host 版本 1.4.0：host-runtime/index.ts 的 manifest 门禁与
 // probe 自身 report 均以 1.4.0 为准（与 compat probe SUPPORTED_PI_VERSIONS 同源），
 // 旧 1.0.2 expect 属过期 fixture，不放宽为 any-version。
 assert.equal(result.healthy,true,JSON.stringify(result));assert.equal(result.version,'1.4.0');assert.deepEqual(result.identities,{SessionManager:true,Container:true,Agent:true,streamSimple:true,watchdog:true});
});
