import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { executeOperation } from '../src/operations.ts';
import { fakeSession, sandbox } from './helpers/playwright-runtime.mjs';

test('固定auth-check不访问秘密，认证mode阻断页面输出', async () => {
  const secret = 'synthetic-secret-never-export'; const s = fakeSession({ authMode: true });
  s.context.cookies = () => { throw Error(secret); };
  await executeOperation(s, { op: 'navigate', url: 'https://example.com/' });
  const result = await executeOperation(s, { op: 'auth-check', origin: 'https://example.com', authenticatedView: { kind: 'testId', value: 'shell' } });
  assert.deepEqual(result, { kind: 'auth-check', onExpectedOrigin: true, authenticatedView: true });
  assert.ok(!JSON.stringify(result).includes(secret));
  for (const command of [{ op: 'snapshot' }, { op: 'inspect', query: 'title' }, { op: 'tabs', action: 'list' }, { op: 'screenshot', name: 'a.png' }]) await assert.rejects(executeOperation(s, command), /auth-mode-restricted/);
  await assert.rejects(executeOperation(s, { op: 'evaluate', function: 'return synthetic-secret' }), /unknown-operation|invalid-command/);
});
test('locator多匹配fail，不能first，密码输入拒绝', async () => {
  const s = fakeSession(); s.page.getByTestId = () => ({ count: async () => 2 });
  await assert.rejects(executeOperation(s, { op: 'click', locator: { kind: 'testId', value: 'multiple' } }), /locator-not-unique/);
  s.page.getByTestId = () => ({ count: async () => 1, getAttribute: async () => 'password', fill: async () => assert.fail() });
  await assert.rejects(executeOperation(s, { op: 'fill', locator: { kind: 'testId', value: 'password' }, value: 'unused' }), /password-entry-forbidden/);
});
test('截图0600，独占创建，不接受路径或symlink root', async () => {
  const box = await sandbox();
  try {
    const s = fakeSession({ artifactRoot: join(box.root, 'artifact') });
    const r = await executeOperation(s, { op: 'screenshot', name: 'fixture.png' }); assert.equal(r.bytes, 8);
    assert.equal((await lstat(join(s.artifactRoot, 'fixture.png'))).mode & 0o777, 0o600);
    await assert.rejects(executeOperation(s, { op: 'screenshot', name: 'fixture.png' }), /artifact-exists-or-unsafe/);
    await assert.rejects(executeOperation(s, { op: 'screenshot', name: '../escape.png' }), /invalid-artifact/);
    const other = join(box.root, 'other'); await mkdir(other, { mode: 0o700 }); await symlink(other, join(box.root, 'linked'));
    s.artifactRoot = join(box.root, 'linked'); await assert.rejects(executeOperation(s, { op: 'screenshot', name: 'x.png' }), /unsafe-artifact-root/);
  } finally { await box.clean(); }
});
test('title/snapshot上限拒绝，不改写原消息', async () => {
  const s = fakeSession(); s.page.title = async () => 'x'.repeat(4097);
  await assert.rejects(executeOperation(s, { op: 'inspect', query: 'title' }), /result-too-large/);
});
