import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoke, options, helperPath } from './helpers/playwright-runtime.mjs';
import { startRuntime, stopRuntime } from '../src/lifecycle.ts';

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

test('Aone命令JSON沿用v1和原生命周期，CLI拒绝任意字段且不回显', async () => {
  // 合成CLI使用短临时HOME，避免macOS长TMPDIR触发既有socket长度门禁。
  const root = await realpath(await mkdtemp('/tmp/pw-'));
  const sdkRoot = join(root, '.playwright-sdk');
  const scope = { stateRoot: join(sdkRoot, 'instances'), profileRoot: join(sdkRoot, 'profiles'), artifactRoot: join(sdkRoot, 'artifacts') };
  const ref = { scope, instance: 'aone-json' };
  try {
    await startRuntime(scope, options('aone-json', { authMode: true }), { daemonPath: helperPath });
    const send = command => invoke(['--instance', 'aone-json', 'command', JSON.stringify(command)], { HOME: root }, root);
    const verify = await send({ op: 'aone-config-readonly', action: 'verify' });
    assert.equal(verify.code, 1);
    // 合成daemon没有frame能力；此错误证明新命令已通过协议和auth门禁进入固定分派。
    assert.deepEqual(verify.data.error, { stage: 'aone-config-readonly', code: 'management-controls-unverified' });
    const exp = await send({ op: 'aone-config-readonly', action: 'export', environment: 'daily' });
    assert.equal(exp.code, 1); assert.deepEqual(exp.data.error, { stage: 'auth', code: 'auth-mode-restricted' });
    const bad = await send({ op: 'aone-config-readonly', action: 'export', environment: 'daily', script: 'synthetic-secret' });
    assert.equal(bad.code, 1); assert.equal(bad.data.error.code, 'invalid-command');
    assert.ok(!JSON.stringify(bad.data).includes('synthetic-secret'));
    const status = await invoke(['--instance', 'aone-json', 'status'], { HOME: root }, root);
    assert.equal(status.code, 0);
  } finally { await stopRuntime(ref); await rm(root, { recursive: true, force: true }); }
});
