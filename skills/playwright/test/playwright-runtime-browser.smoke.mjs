import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, realpath, mkdtemp, readdir, lstat, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoke } from './helpers/playwright-runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function ownedDescendants(parent) {
  // 只消费pid/ppid列，不读其他browser的命令参数、profile或凭据。
  const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=']);
  const pairs = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([parent]);
  let changed = true;
  while (changed) { changed = false; for (const [pid, ppid] of pairs) if (owned.has(ppid) && !owned.has(pid)) { owned.add(pid); changed = true; } }
  return owned;
}

// 显式browser gate：默认npm test不发现此文件。不读取个人profile，不访问外网。
test('真实Chrome跨CLI、页面交互、隔离、排他、认证边界与清理', { timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(join(await realpath('/tmp'), 'pw-')));
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const env = { HOME: home, TMPDIR: root }, live = new Set(), daemons = new Set();
  const html = await readFile(new URL('./fixtures/playwright-runtime/page.html', import.meta.url));
  const server = createServer((_req, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evidence = { checks: [], browserVersion: '', cleaned: false };
  async function cli(instance, action, payload, extra = [], override = {}) {
    const args = ['--instance', instance, action, ...(payload ? [JSON.stringify(payload)] : []), ...extra];
    const r = await invoke(args, { ...env, ...override });
    assert.equal(r.stderr, '', 'CLI不输出浏览器原始日志');
    return r;
  }
  async function start(instance, extra = [], override = {}) {
    const r = await cli(instance, 'start', undefined, extra, override);
    if (r.data?.error?.code === 'chrome-unavailable') throw Error('BLOCKED: system Chrome unavailable');
    assert.equal(r.code, 0, JSON.stringify(r.data)); live.add(instance);
    for (const pid of await ownedDescendants(r.data.result.daemonPid)) daemons.add(pid);
    return r.data.result;
  }
  async function stop(instance) { const r = await cli(instance, 'stop'); assert.equal(r.code, 0, JSON.stringify(r.data)); live.delete(instance); }
  async function command(instance, c) { const r = await cli(instance, 'command', c); assert.equal(r.code, 0, JSON.stringify(r.data)); return r.data.result; }
  let error;
  try {
    const ready = await start('a'); assert.equal(ready.headless, true); assert.equal(ready.channel, 'chrome'); assert.equal(ready.browserReady, true); assert.equal(ready.pageReady, true);
    evidence.browserVersion = ready.browserVersion;
    assert.equal((await command('a', { op: 'inspect', query: 'title' })).value, ''); evidence.checks.push('A2');
    await command('a', { op: 'navigate', url: origin + '/?synthetic-query=not-output#not-output' });
    assert.match((await command('a', { op: 'snapshot' })).value, /Submit/);
    await command('a', { op: 'fill', locator: { kind: 'testId', value: 'query' }, value: 'fixture' });
    await command('a', { op: 'click', locator: { kind: 'role', role: 'button', name: 'Submit' } });
    await command('a', { op: 'wait', locator: { kind: 'testId', value: 'result' }, state: 'visible' });
    assert.equal((await command('a', { op: 'inspect', query: 'visible', locator: { kind: 'testId', value: 'result' } })).value, true); evidence.checks.push('A3');
    const original = await command('a', { op: 'tabs', action: 'list' }); assert.equal(original.tabs.length, 1); assert.ok(!original.tabs[0].url.includes('synthetic-query'));
    const created = await command('a', { op: 'tabs', action: 'new' }); assert.equal(created.tabs.length, 2);
    await command('a', { op: 'tabs', action: 'select', tabId: original.tabs[0].tabId });
    await command('a', { op: 'tabs', action: 'close', tabId: created.tabs.find(t => t.tabId !== original.tabs[0].tabId).tabId });
    const shot = await command('a', { op: 'screenshot', name: 'fixture.png' }); assert.ok(shot.bytes > 100);
    const file = join(home, '.playwright-sdk', 'artifacts', 'a', 'fixture.png');
    assert.equal((await lstat(file)).mode & 0o777, 0o600); assert.equal((await readFile(file)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal((await cli('a', 'command', { op: 'screenshot', name: 'fixture.png' })).data.error.code, 'artifact-exists-or-unsafe');
    await start('b'); assert.equal((await command('b', { op: 'inspect', query: 'title' })).value, '');
    assert.equal((await command('a', { op: 'inspect', query: 'title' })).value, 'SDK 验收页面');
    await stop('a'); assert.equal((await command('b', { op: 'inspect', query: 'title' })).value, ''); await stop('b'); evidence.checks.push('A5');
    const pair = await Promise.all([cli('p1', 'start', undefined, ['--profile', 'test-profile']), cli('p2', 'start', undefined, ['--profile', 'test-profile'])]);
    const winners = pair.map((r, i) => ({ r, name: `p${i + 1}` })).filter(({ r }) => r.code === 0);
    assert.equal(winners.length, 1); live.add(winners[0].name);
    for (const pid of await ownedDescendants(winners[0].r.data.result.daemonPid)) daemons.add(pid);
    assert.equal(pair.find(r => r.code !== 0).data.error.code, 'profile-in-use'); await stop(winners[0].name);
    await start('p3', ['--profile', 'test-profile']); await stop('p3');
    assert.equal((await lstat(join(home, '.playwright-sdk', 'profiles', 'test-profile'))).mode & 0o777, 0o700); evidence.checks.push('A6');
    await start('auth', ['--auth']); await command('auth', { op: 'navigate', url: origin });
    const authReply = await command('auth', { op: 'auth-check', origin, authenticatedView: { kind: 'testId', value: 'app-shell' } });
    assert.deepEqual(authReply, { kind: 'auth-check', onExpectedOrigin: true, authenticatedView: true });
    assert.ok(!JSON.stringify(authReply).includes('synthetic-secret-never-export'));
    assert.equal((await cli('auth', 'command', { op: 'snapshot' })).data.error.code, 'auth-mode-restricted'); await stop('auth'); evidence.checks.push('A4');
    await start('idle', [], { PI_PLAYWRIGHT_IDLE_TIMEOUT: '0.6' }); live.add('idle');
    // 期限固定且仅等待本测试owned实例，不用于委派轮询。
    await new Promise(resolve => setTimeout(resolve, 1500));
    const status = await cli('idle', 'status'); assert.equal(status.data.result, null); live.delete('idle');
    const base = join(home, '.playwright-sdk'); assert.deepEqual(await readdir(join(base, 'instances')), []);
    assert.deepEqual(await readdir(join(base, 'profiles')), ['test-profile']);
    await assert.rejects(access(join(base, 'profiles', 'test-profile', '.sdk-lease')));
    evidence.checks.push('A7'); evidence.cleaned = true;
  } catch (e) { error = e; }
  finally {
    const cleanupErrors = [];
    for (const instance of live) { try { await stop(instance); } catch (e) { cleanupErrors.push(e); } }
    await new Promise(resolve => server.close(resolve));
    if (!cleanupErrors.length) {
      // 仅验证本次daemon及其实际子进程身份；不据此杀进程或检查Chrome参数。
      const deadline = Date.now() + 3000;
      for (const pid of daemons) {
        while (true) {
          try { process.kill(pid, 0); }
          catch (e) { if (e.code === 'ESRCH') break; throw e; }
          if (Date.now() >= deadline) throw Error('owned daemon remains after context/stop cleanup');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
      await rm(root, { recursive: true, force: true });
    } else error = new AggregateError(cleanupErrors, 'owned实例关闭未确认，保留私有fixture现场');
  }
  if (process.env.PI_PLAYWRIGHT_ACCEPTANCE_EVIDENCE) await writeFile(process.env.PI_PLAYWRIGHT_ACCEPTANCE_EVIDENCE, JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ playwrightEvidence: evidence }));
  if (error) throw error;
});
