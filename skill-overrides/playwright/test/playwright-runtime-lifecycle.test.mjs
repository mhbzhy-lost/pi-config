import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, chmod, symlink, stat, lstat, readdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serveRuntime, privateDirectory, sendRuntimeCommand, getRuntimeStatus, socketPath } from '../src/lifecycle.ts';
import { executeOperation } from '../src/operations.ts';
import { MAX_WIRE_BYTES, RuntimeFault } from '../src/contracts.ts';
import { sandbox, options, fakeSession } from './helpers/playwright-runtime.mjs';

test('fake daemon实际smoke后ready，跨进程复用，不启动Chrome', async () => {
  const s = await sandbox();
  try {
    const ready = await s.start(options('task')); assert.equal(ready.browserVersion, 'fake-sdk'); assert.equal(ready.headless, true);
    await sendRuntimeCommand({ scope: s.scope, instance: 'task' }, { op: 'navigate', url: 'https://example.com/' });
    assert.equal((await sendRuntimeCommand({ scope: s.scope, instance: 'task' }, { op: 'inspect', query: 'title' })).value, 'Fixture');
    await s.stop('task'); assert.equal(await getRuntimeStatus({ scope: s.scope, instance: 'task' }), null);
    assert.deepEqual(await readdir(s.scope.profileRoot), []);
    assert.deepEqual(await s.stop('task'), { stopped: true });
  } finally { await s.clean(); }
});
test('同profile并发start仅一个winner，stop保留named并可立即复用', async () => {
  const s = await sandbox();
  try {
    const results = await Promise.allSettled([s.start(options('a', { profile: 'approved' })), s.start(options('b', { profile: 'approved' }))]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.find(x => x.status === 'rejected').reason.code, 'profile-in-use');
    const winner = results[0].status === 'fulfilled' ? 'a' : 'b'; await s.stop(winner);
    assert.equal((await stat(join(s.scope.profileRoot, 'approved'))).mode & 0o777, 0o700);
    await s.start(options('c', { profile: 'approved' })); await s.stop('c');
  } finally { await s.clean(); }
});
test('unsafe目录、profile symlink和旧锁拒绝，不写穿', async () => {
  const s = await sandbox();
  try {
    await privateDirectory(s.scope.profileRoot); const external = join(s.root, 'external'); await mkdir(external, { mode: 0o700 });
    await symlink(external, join(s.scope.profileRoot, 'linked'));
    await assert.rejects(s.start(options('linked', { profile: 'linked' })), /unsafe-directory/);
    assert.deepEqual(await readdir(external), []);
    const wrong = join(s.scope.profileRoot, 'wrong'); await mkdir(wrong, { mode: 0o700 }); await chmod(wrong, 0o755);
    await assert.rejects(s.start(options('wrong', { profile: 'wrong' })), /unsafe-directory/);
    await mkdir(join(s.scope.profileRoot, 'legacy'), { mode: 0o700 });
    await mkdir(join(s.scope.profileRoot, 'legacy', '.pi-playwright.lock'));
    await assert.rejects(s.start(options('old', { profile: 'legacy' })), /profile-in-use/);
  } finally { await s.clean(); }
});
test('socket可见前smoke必须通过，合法adapter故障按来源分类并清理', async () => {
  const s = await sandbox(); const r = { scope: s.scope, instance: 'fail' };
  try {
    await assert.rejects(serveRuntime(s.scope, options('fail'), { launch: async () => { throw new RuntimeFault('browser', 'chrome-unavailable'); } }, executeOperation), /chrome-unavailable/);
    await assert.rejects(access(socketPath(r))); assert.deepEqual(await readdir(s.scope.profileRoot), []);
    let closed = 0;
    await assert.rejects(serveRuntime(s.scope, options('fail'), { launch: async () => fakeSession({ smoke: async () => { throw Error('synthetic-secret'); }, close: async () => { closed++; } }) }, executeOperation), /smoke-failed/);
    assert.equal(closed, 1); await assert.rejects(access(join(s.scope.stateRoot, 'fail')));
  } finally { await s.clean(); }
});
test('close未确认保留authoritative lease，不自动抢占', async () => {
  const s = await sandbox();
  try {
    await assert.rejects(serveRuntime(s.scope, options('fail', { profile: 'keep' }), { launch: async () => fakeSession({ smoke: async () => { throw Error('page-fail'); }, close: async () => { throw Error('unconfirmed'); } }) }, executeOperation), /stop-unconfirmed/);
    await access(join(s.scope.profileRoot, 'keep', '.sdk-lease', 'owner.json'));
    await assert.rejects(s.start(options('other', { profile: 'keep' })), /profile-in-use/);
    // adapter为纯mock、没有任何浏览器/daemon；此处只清理测试自己生成的fixture。
    await rm(join(s.scope.stateRoot, 'fail'), { recursive: true });
  } finally { await s.clean(); }
});
test('idle只自清理，活跃的另一个owned实例不受影响', async () => {
  const s = await sandbox();
  try {
    await s.start(options('idle', { idleTimeoutMs: 100 })); await s.start(options('active'));
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(await getRuntimeStatus({ scope: s.scope, instance: 'idle' }), null);
    assert.equal((await getRuntimeStatus({ scope: s.scope, instance: 'active' })).browserReady, true);
  } finally { await s.clean(); }
});
test('同名instance不覆写，非法协议和超限数据不执行', async () => {
  const s = await sandbox();
  try {
    await s.start(options('same')); await assert.rejects(s.start(options('same')), /instance-in-use/);
    const reply = await new Promise((resolve, reject) => {
      const c = createConnection(socketPath({ scope: s.scope, instance: 'same' })); let out = '';
      c.on('connect', () => c.write('x'.repeat(MAX_WIRE_BYTES + 1) + '\n')); c.on('error', reject);
      c.on('data', d => out += d); c.on('end', () => resolve(JSON.parse(out)));
    });
    assert.equal(reply.error.code, 'request-too-large');
  } finally { await s.clean(); }
});

test('合法pending操作期间不触发idle，取消启动必须关闭已创建context', async () => {
  const s = await sandbox();
  try {
    const ref = { scope: s.scope, instance: 'pending' };
    await serveRuntime(s.scope, options('pending', { idleTimeoutMs: 40 }), { launch: async () => fakeSession() }, async () => {
      await new Promise(resolve => setTimeout(resolve, 180)); return { kind: 'status', value: 'ok' };
    }); s.owned.add('pending');
    const result = await sendRuntimeCommand(ref, { op: 'snapshot' }); assert.equal(result.value, 'ok');
    assert.equal((await getRuntimeStatus(ref)).browserReady, true); await s.stop('pending');
    const abort = new AbortController(); let closed = 0;
    await assert.rejects(serveRuntime(s.scope, options('cancel'), {
      launch: async () => { abort.abort(); return fakeSession({ close: async () => { closed++; } }); },
    }, executeOperation, abort.signal), /startup-cancelled/);
    assert.equal(closed, 1); assert.deepEqual(await readdir(s.scope.profileRoot), []);
  } finally { await s.clean(); }
});

test('fake daemon硬崩溃保留profile租约，来源明确时只清测试fixture', async () => {
  const s = await sandbox();
  try {
    const ready = await s.start(options('crash', { profile: 'locked' }));
    process.kill(ready.daemonPid, 'SIGKILL');
    const deadline = Date.now() + 2000;
    while (true) {
      try { process.kill(ready.daemonPid, 0); } catch (e) { if (e.code === 'ESRCH') break; throw e; }
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20));
    }
    await assert.rejects(getRuntimeStatus({ scope: s.scope, instance: 'crash' }), /instance-unreachable/);
    await assert.rejects(s.start(options('new', { profile: 'locked' })), /profile-in-use/);
    await access(join(s.scope.profileRoot, 'locked', '.sdk-lease', 'owner.json'));
    // 唯一生成链是本测试fake adapter，明确没有真实browser；不作为production orphan自动清理规则。
    s.owned.delete('crash'); await rm(join(s.scope.stateRoot, 'crash'), { recursive: true });
  } finally { await s.clean(); }
});
