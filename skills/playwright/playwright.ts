#!/usr/bin/env node
import { runCli } from './src/index.ts';
process.exitCode = await runCli(process.argv.slice(2));
