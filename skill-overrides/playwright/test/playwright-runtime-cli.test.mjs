import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoke } from './helpers/playwright-runtime.mjs';

test('绝对skill入口跨cwd可用，帮助和参数不启动Chrome', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pw-cli-')));
  try {
    const r = await invoke(['--help'], { HOME: root }, root); assert.equal(r.code, 0); assert.equal(r.data.defaultMode, 'headless');
    const invalid = await invoke(['start'], { HOME: root }, root); assert.equal(invalid.code, 1); assert.equal(invalid.data.error.code, 'instance-required');
    const unknown = await invoke(['--instance', 'task', 'command', '{"op":"run-file","path":"/private/secret"}'], { HOME: root }, root);
    assert.equal(unknown.code, 1); assert.ok(!JSON.stringify(unknown.data).includes('/private/secret'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('默认测试发现不拾取browser gate，文档不教旧工具协议', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['test:playwright:browser'], /browser\.smoke\.mjs/);
  assert.ok(!pkg.scripts.test.includes('browser'));
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.ok(!/@playwright\/mcp|playwright\.py|tools\/call|browser_run_code_unsafe/.test(skill));
  const auth = await readFile(new URL('../docs/authentication.md', import.meta.url), 'utf8');
  assert.match(auth, /auth-check/);
});
