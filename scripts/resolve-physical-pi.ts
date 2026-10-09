#!/usr/bin/env node
import { resolvePhysicalHost } from '../packages/pi-subagents-enhanced/src/host-runtime/index.ts';
import path from 'node:path';
try {
  const binding=resolvePhysicalHost({hostRoot:process.env.PI_HOST_ROOT ?? path.resolve(import.meta.dirname,'../node_modules/@earendil-works/pi-coding-agent'),nodeBin:process.execPath});
  process.stdout.write(binding.entry+'\n');
} catch(error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; }
