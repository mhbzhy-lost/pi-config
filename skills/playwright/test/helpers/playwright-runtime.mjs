import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startRuntime, stopRuntime, serveRuntime } from '../../src/lifecycle.ts';
import { executeOperation } from '../../src/operations.ts';

export const helperPath = fileURLToPath(import.meta.url);
export const cliPath = fileURLToPath(new URL('../../playwright.ts', import.meta.url));
const exec = promisify(execFile);
export const options = (instance, overrides = {}) => ({ instance, headless: true, channel: 'chrome', authMode: false, startupTimeoutMs: 3000, idleTimeoutMs: 60_000, ...overrides });
export async function sandbox() {
  // macOS 的 /var 为系统别名；所有测试先 canonicalize 自建根。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pw-')));
  const scope = { stateRoot: join(root, 's'), profileRoot: join(root, 'p'), artifactRoot: join(root, 'a') };
  const owned = new Set();
  return {
    root, scope, owned,
    async start(o) { const r = await startRuntime(scope, o, { daemonPath: helperPath }); owned.add(o.instance); return r; },
    async stop(name) { return stopRuntime({ scope, instance: name }); },
    async clean() {
      const errors = [];
      for (const instance of owned) try { await stopRuntime({ scope, instance }); } catch (e) { errors.push(e); }
      if (errors.length) throw new AggregateError(errors, '测试owned实例关闭未确认，保留现场');
      await rm(root, { recursive: true, force: true });
    },
  };
}
export function fakeSession(overrides = {}) {
  let url = 'about:blank', title = '', closed = false;
  const l = { count: async () => 1, isVisible: async () => true, waitFor: async () => {}, click: async () => {}, fill: async () => {}, getAttribute: async () => null, ariaSnapshot: async () => '- button "Submit"' };
  const page = { goto: async v => { url = v; title = v === 'about:blank' ? '' : 'Fixture'; }, title: async () => title, url: () => url, locator: () => l, getByRole: () => l, getByTestId: () => l, screenshot: async () => Buffer.from('fake-png'), isClosed: () => closed, close: async () => { closed = true; } };
  const context = { pages: () => closed ? [] : [page], newPage: async () => page };
  return { page, context, authMode: false, artifactRoot: '', smoke: async () => ({ version: 'fake-sdk' }), close: async () => { closed = true; }, ...overrides };
}
export async function invoke(args, env = {}, cwd) {
  try { const r = await exec(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, cwd, timeout: 40_000 }); return { code: 0, data: JSON.parse(r.stdout.trim()), stderr: r.stderr }; }
  catch (e) { return { code: e.code, data: e.stdout?.trim() ? JSON.parse(e.stdout.trim()) : null, stderr: e.stderr }; }
}

// 独立测试daemon，没有生产环境开关或任意adapter路径入口。
if (process.argv.includes('--_daemon') && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.once('message', async ({ scope, options: o }) => {
    try {
      const ready = await serveRuntime(scope, o, { async launch(_o, _profile, artifactRoot) { return fakeSession({ authMode: o.authMode, artifactRoot }); } }, executeOperation);
      process.send({ ready });
    } catch (e) { process.send({ error: { stage: e.stage ?? 'test', code: e.code ?? 'test-daemon-failed' } }); process.exitCode = 1; }
  });
}
