import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOptions, validateCommand, validateSafeResult, safeName, MAX_WIRE_BYTES, bounded } from '../src/contracts.ts';
import { socketPath } from '../src/lifecycle.ts';
import { options } from './helpers/playwright-runtime.mjs';

test('配置安全名称和有限期限', () => {
  safeName('my-task'); validateOptions(options('my-task'));
  for (const name of ['../escape', 'UPPER', 'bad_name', '', 'a'.repeat(33)]) assert.throws(() => safeName(name));
  for (const n of [NaN, -1, 0, Infinity]) assert.throws(() => validateOptions(options('x', { idleTimeoutMs: n })));
});
test('URL、未知代码入口和locator命令在执行前校验', () => {
  validateCommand({ op: 'navigate', url: 'about:blank' });
  validateCommand({ op: 'auth-check', origin: 'https://example.com', authenticatedView: { kind: 'testId', value: 'shell' } });
  for (const url of ['javascript:alert(1)', 'data:x', 'file:///x', 'https://u:p@example.com']) assert.throws(() => validateCommand({ op: 'navigate', url }));
  for (const op of ['evaluate', 'run-file', 'stopall']) assert.throws(() => validateCommand({ op, function: 'secret' }));
  assert.throws(() => validateCommand({ op: 'auth-check', origin: 'https://example.com/path', authenticatedView: { kind: 'css', value: 'body' } }));
  assert.throws(() => validateCommand({ op: 'click', locator: { kind: 'css', value: 'a', additional: 'secret' } }));
  assert.throws(() => validateCommand({ op: 'screenshot', name: '../x.png' }));
});
test('返回schema没有任意对象通道，不静默截断', () => {
  validateSafeResult({ kind: 'auth-check', onExpectedOrigin: true, authenticatedView: false });
  assert.throws(() => validateSafeResult({ kind: 'auth-check', onExpectedOrigin: true, authenticatedView: false, cookies: 'synthetic-secret' }));
  assert.throws(() => validateSafeResult({ arbitrary: 'synthetic-secret' }));
  assert.throws(() => validateSafeResult({ kind: 'text', value: 'x'.repeat(4097), maxLength: 4096 }), /result-too-large/);
  assert.equal(MAX_WIRE_BYTES, 1024 * 1024);
});
test('socket哈希包含scope并检查真实字节长度', () => {
  const a = socketPath({ scope: { stateRoot: '/private/tmp/a' }, instance: 'task' });
  const b = socketPath({ scope: { stateRoot: '/private/tmp/b' }, instance: 'task' });
  assert.notEqual(a, b);
  assert.throws(() => socketPath({ scope: { stateRoot: '/' + 'a'.repeat(100) }, instance: 'x' }), /socket-path-too-long/);
});
test('异步期限不无限等待', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 10, 'operation', 'operation-timeout'), /operation-timeout/);
});

test('Aone只接受固定verify/export环境合同，拒绝所有额外输入通道', () => {
  validateCommand({ op: 'aone-config-readonly', action: 'verify' });
  for (const environment of ['daily', 'prepub', 'publish']) {
    validateCommand({ op: 'aone-config-readonly', action: 'export', environment });
    for (const bytes of [1, 1024 * 1024]) validateSafeResult({ kind: 'aone-config-artifact', name: `aone-config-${environment}.env`, bytes });
  }
  const invalid = [
    { action: 'import' }, { action: 'delete' }, { action: 'apply' }, { action: 'export' },
    { action: 'verify', environment: 'daily' },
    ...['all', 'project', 'DAILY', '', null, ['daily']].map(environment => ({ action: 'export', environment })),
    ...['url', 'selector', 'locator', 'script', 'code', 'path', 'name', 'app', 'origin'].map(field => ({ action: 'export', environment: 'daily', [field]: 'synthetic-secret' })),
  ];
  for (const input of invalid) assert.throws(() => validateCommand({ op: 'aone-config-readonly', ...input }), /invalid-command/);
  for (const name of ['../aone-config-daily.env', 'aone-config-project.env', 'config.env', 'aone-config-daily.env/extra']) {
    assert.throws(() => validateSafeResult({ kind: 'aone-config-artifact', name, bytes: 10 }), /invalid-result/);
  }
  for (const bytes of [0, -1, 0.5, 1024 * 1024 + 1, NaN, Infinity, '10']) {
    assert.throws(() => validateSafeResult({ kind: 'aone-config-artifact', name: 'aone-config-daily.env', bytes }), /invalid-result/);
  }
  assert.throws(() => validateSafeResult({ kind: 'aone-config-artifact', name: 'aone-config-daily.env', bytes: 1, body: 'synthetic-secret' }));
});
