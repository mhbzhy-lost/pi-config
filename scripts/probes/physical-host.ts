#!/usr/bin/env node
import path from 'node:path';
import { probePhysicalHost } from '../../packages/pi-subagents-enhanced/src/host-runtime/index.ts';
const root=path.resolve(import.meta.dirname,'../..');
try { console.log(JSON.stringify(await probePhysicalHost({hostRoot:process.env.PI_HOST_ROOT ?? path.join(root,'node_modules/@earendil-works/pi-coding-agent'),nodeBin:process.execPath,enhancedPackageRoot:path.join(root,'packages/pi-subagents-enhanced')}))); }
catch(error) { console.error(error instanceof Error ? error.message : String(error));process.exitCode=1; }
