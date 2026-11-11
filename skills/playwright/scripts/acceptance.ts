#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只执行受管验收入口并收集证据，不修复、不安装、不读取个人profile。
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await realpath(await mkdtemp(join(tmpdir(), 'playwright-sdk-acceptance-')));
const evidenceFile = join(output, 'browser.json');
const commands = [
  ['npm', ['run', 'typecheck']],
  ['npm', ['test']],
  ['npm', ['run', 'test:playwright:browser']],
];
const results = [];
for (const [bin, args] of commands as [string, string[]][]) {
  const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PI_PLAYWRIGHT_ACCEPTANCE_EVIDENCE: evidenceFile } });
  results.push({ command: [bin, ...args].join(' '), exitCode: r.status, output: r.stdout + r.stderr });
  if (r.status !== 0) break;
}
let browser: unknown;
try { browser = JSON.parse(await readFile(evidenceFile, 'utf8')); } catch { browser = null; }
const blocked = results.some(r => r.output.includes('BLOCKED: system Chrome unavailable'));
const verdict = blocked ? 'blocked' : results.length === commands.length && results.every(r => r.exitCode === 0) ? 'passed' : 'failed';
const report = join(output, 'report.json');
await writeFile(report, JSON.stringify({ timestamp: new Date().toISOString(), verdict, browser, results }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ verdict, report, browser }));
process.exitCode = verdict === 'passed' ? 0 : 1;
