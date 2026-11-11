import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  bounded, CLOSE_TIMEOUT_MS, MAX_WIRE_BYTES, REQUEST_TIMEOUT_MS, RuntimeFault, fault,
  safeError, safeName, validateCommand, validateOptions, validateSafeResult,
  type BrowserAdapter, type Command, type OperationDispatcher, type ReadyState, type RuntimeOptions,
  type RuntimeRef, type RuntimeScope, type SafeResult, type Session, type WireReply, type WireRequest,
} from './contracts.ts';

type Ownership = { nonce: string; instance: string; kind: 'named' | 'temporary'; profile: string };
type Metadata = { nonce: string; ready: ReadyState };
export async function resolveScope(): Promise<RuntimeScope> {
  const home = await realpath(homedir());
  const root = join(home, '.playwright-sdk');
  await privateDirectory(root);
  return { stateRoot: join(root, 'instances'), profileRoot: join(root, 'profiles'), artifactRoot: join(root, 'artifacts') };
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) fault('profile', 'unsafe-directory');
  // 校验已有每级路径，避免 mkdir 穿过 symlink；系统祖先不要求 0700。
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fault('profile', 'unsafe-directory'); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // 合法并发启动可同时创建根目录；创建后仍逐项校验，不接受 symlink。
      await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) fault('profile', 'unsafe-directory');
    }
  }
  const s = await lstat(path);
  if (s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) fault('profile', 'unsafe-directory');
}
async function validateScope(scope: RuntimeScope): Promise<void> {
  for (const root of [scope.stateRoot, scope.profileRoot, scope.artifactRoot]) {
    await privateDirectory(dirname(root)); await privateDirectory(root);
  }
}
function statePath(ref: RuntimeRef): string { safeName(ref.instance); return join(ref.scope.stateRoot, ref.instance); }
export function socketPath(ref: RuntimeRef): string {
  const hash = createHash('sha256').update(`${ref.scope.stateRoot}\0${process.getuid?.()}\0${ref.instance}`).digest('hex').slice(0, 16);
  const path = join(statePath(ref), `${hash}.sock`);
  if (Buffer.byteLength(path) >= 100) fault('config', 'socket-path-too-long'); return path;
}
async function writePrivate(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
}
async function readMetadata(ref: RuntimeRef): Promise<Metadata | null> {
  const directory = statePath(ref);
  if (!await exists(directory)) return null;
  await privateDirectory(directory);
  const path = join(directory, 'ready.json');
  if (!await exists(path)) fault('protocol', 'instance-not-ready');
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600) fault('protocol', 'unsafe-state');
  try {
    const m = JSON.parse(await readFile(path, 'utf8'));
    if (typeof m.nonce !== 'string' || m.ready?.instance !== ref.instance || !m.ready?.browserReady || !m.ready?.pageReady) fault('protocol', 'unsafe-state');
    return m;
  } catch { fault('protocol', 'unsafe-state'); }
}
async function wire(ref: RuntimeRef, command: WireRequest['command']): Promise<SafeResult | ReadyState | { stopped: boolean }> {
  const metadata = await readMetadata(ref); if (!metadata) fault('protocol', 'unknown-instance');
  const s = await lstat(socketPath(ref)).catch(() => fault('protocol', 'instance-unreachable'));
  if (!s.isSocket() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600) fault('protocol', 'unsafe-socket');
  const request: WireRequest = { v: 1, id: randomUUID(), nonce: metadata.nonce, command };
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_WIRE_BYTES) fault('protocol', 'request-too-large');
  return await new Promise((done, reject) => {
    const socket = createConnection(socketPath(ref)); let data = Buffer.alloc(0), settled = false;
    const end = (error?: unknown, result?: any) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : done(result); };
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => end(new RuntimeFault('protocol', 'request-timeout')));
    socket.on('error', () => end(new RuntimeFault('protocol', 'instance-unreachable')));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data = Buffer.concat([data, Buffer.from(chunk)]);
      if (data.length > MAX_WIRE_BYTES) return end(new RuntimeFault('protocol', 'reply-too-large'));
      if (!data.includes(10)) return;
      try {
        const reply = JSON.parse(data.subarray(0, data.indexOf(10)).toString()) as WireReply;
        if (reply.v !== 1 || reply.id !== request.id) fault('protocol', 'invalid-reply');
        if (reply.ok === false) return end(new RuntimeFault(reply.error.stage, reply.error.code));
        end(undefined, reply.result);
      } catch (e) { end(e instanceof RuntimeFault ? e : new RuntimeFault('protocol', 'invalid-reply')); }
    });
    socket.on('end', () => { if (!settled) end(new RuntimeFault('protocol', 'incomplete-reply')); });
  });
}
export async function startRuntime(scope: RuntimeScope, options: RuntimeOptions, launch?: { daemonPath: string }): Promise<ReadyState> {
  validateOptions(options); await validateScope(scope); socketPath({ scope, instance: options.instance });
  const child = fork(launch?.daemonPath ?? fileURLToPath(new URL('./cli.ts', import.meta.url)), ['--_daemon'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    // 不继承会将页面/协议写入日志的 Playwright debug 开关。
    env: { ...process.env, DEBUG: '', PWDEBUG: '0', NODE_DEBUG: '' },
  });
  return await new Promise((done, reject) => {
    let settled = false;
    const finish = (error?: unknown, ready?: ReadyState) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (child.connected) child.disconnect(); child.unref();
      error ? reject(error) : done(ready!);
    };
    const timer = setTimeout(() => {
      if (child.connected) child.send({ cancel: true });
      finish(new RuntimeFault('browser', 'startup-timeout'));
    }, options.startupTimeoutMs + 1000);
    child.on('error', () => finish(new RuntimeFault('browser', 'daemon-start-failed')));
    child.on('exit', () => finish(new RuntimeFault('browser', 'daemon-start-failed')));
    child.on('message', (m: any) => {
      if (m.ready) finish(undefined, m.ready);
      else if (m.error) finish(new RuntimeFault(m.error.stage, m.error.code));
    });
    child.send({ scope, options });
  });
}
export async function getRuntimeStatus(ref: RuntimeRef): Promise<ReadyState | null> {
  if (!await readMetadata(ref)) return null; return await wire(ref, { op: '_status' }) as ReadyState;
}
export async function listRuntimeInstances(scope: RuntimeScope): Promise<ReadyState[]> {
  if (!await exists(scope.stateRoot)) return []; await privateDirectory(scope.stateRoot);
  const results = [];
  for (const name of await readdir(scope.stateRoot)) { safeName(name); const status = await getRuntimeStatus({ scope, instance: name }); if (status) results.push(status); }
  return results;
}
export async function sendRuntimeCommand(ref: RuntimeRef, command: Command): Promise<SafeResult> {
  validateCommand(command); const result = await wire(ref, command); validateSafeResult(result); return result;
}
export async function stopRuntime(ref: RuntimeRef): Promise<{ stopped: boolean }> {
  if (!await exists(statePath(ref))) return { stopped: true };
  const result = await wire(ref, { op: '_stop' }) as { stopped: boolean };
  if (!result.stopped) fault('stop', 'stop-unconfirmed');
  // daemon 先关闭 browser/释放owned状态，再回包；不依赖可能复用的 PID 发信号。
  if (await exists(statePath(ref))) fault('stop', 'stop-unconfirmed'); return result;
}

/** 仅由本 feature daemon 或测试 harness 调用；不接受页面/CLI 注入 adapter。 */
export async function serveRuntime(scope: RuntimeScope, options: RuntimeOptions, adapter: BrowserAdapter, dispatcher: OperationDispatcher, signal?: AbortSignal): Promise<ReadyState> {
  validateOptions(options); await validateScope(scope);
  const ref = { scope, instance: options.instance }, directory = statePath(ref), socket = socketPath(ref);
  const nonce = randomUUID(); let profile = '', lease = '', ownership: Ownership;
  let session: Session | undefined, server: ReturnType<typeof createServer> | undefined;
  let acquiredState = false, acquiredLease = false, closing = false, unusable = false, active = 0;
  let activity = Date.now(), idleTimer: NodeJS.Timeout | undefined;
  const connections = new Set<Socket>();
  async function release() {
    // 只清理本次创建、nonce匹配的资源；未确认关闭绝不释放租约。
    if (acquiredLease) {
      const saved = JSON.parse(await readFile(join(lease, 'owner.json'), 'utf8'));
      if (saved.nonce !== nonce) fault('stop', 'ownership-mismatch');
      if (ownership.kind === 'temporary') await rm(profile, { recursive: true });
      else await rm(lease, { recursive: true });
      acquiredLease = false;
    }
    if (acquiredState) {
      const saved = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
      if (saved.nonce !== nonce) fault('stop', 'ownership-mismatch');
      await rm(directory, { recursive: true }); acquiredState = false;
    }
  }
  async function shutdown() {
    if (closing) fault('stop', 'stop-unconfirmed'); closing = true;
    clearInterval(idleTimer);
    try { if (session) await bounded(session.close(), CLOSE_TIMEOUT_MS, 'stop', 'stop-unconfirmed'); }
    catch { closing = false; unusable = true; fault('stop', 'stop-unconfirmed'); }
    await release(); server?.close();
  }
  let ready: ReadyState;
  try {
    const checkCancelled = () => { if (signal?.aborted) fault('browser', 'startup-cancelled'); };
    checkCancelled();
    await mkdir(directory, { mode: 0o700 }).catch(() => fault('profile', 'instance-in-use'));
    acquiredState = true; await writePrivate(join(directory, 'owner.json'), { nonce, instance: options.instance });
    profile = options.profile ? join(scope.profileRoot, options.profile) : await mkdtemp(join(scope.profileRoot, 'tmp-'));
    await privateDirectory(profile);
    if (await exists(join(profile, '.pi-playwright.lock'))) fault('profile', 'profile-in-use');
    lease = join(profile, '.sdk-lease');
    await mkdir(lease, { mode: 0o700 }).catch(() => fault('profile', 'profile-in-use')); acquiredLease = true;
    ownership = { nonce, instance: options.instance, profile, kind: options.profile ? 'named' : 'temporary' };
    await writePrivate(join(lease, 'owner.json'), ownership);
    // artifact 留给用户消费，不能在 stop 时删除截图。
    const artifactRoot = join(scope.artifactRoot, options.instance); await privateDirectory(artifactRoot);
    // SDK 自有启动期限确保 launch promise 不在超时后悄悄创建未跟踪 browser。
    session = await adapter.launch(options, profile, artifactRoot);
    checkCancelled();
    let smoke;
    try { smoke = await bounded(session.smoke(), options.startupTimeoutMs, 'page', 'smoke-failed'); }
    catch { fault('page', 'smoke-failed'); }
    checkCancelled();
    ready = { instance: options.instance, daemonPid: process.pid, browserReady: true, pageReady: true, headless: options.headless, channel: 'chrome', authMode: options.authMode, browserVersion: smoke.version };
    let queue = Promise.resolve();
    server = createServer(conn => {
      connections.add(conn); conn.on('close', () => connections.delete(conn));
      let data = Buffer.alloc(0), received = false;
      conn.setTimeout(REQUEST_TIMEOUT_MS, () => conn.destroy()); conn.on('error', () => {});
      conn.on('data', chunk => {
        if (received) return; data = Buffer.concat([data, Buffer.from(chunk)]);
        if (data.length > MAX_WIRE_BYTES) { received = true; conn.end(JSON.stringify({ v: 1, id: '', ok: false, error: { stage: 'protocol', code: 'request-too-large' } }) + '\n'); return; }
        if (!data.includes(10)) return; received = true; active++; activity = Date.now();
        queue = queue.then(async () => {
          let id = ''; let stop = false;
          let reply: WireReply;
          try {
            let request: WireRequest;
            try { request = JSON.parse(data.subarray(0, data.indexOf(10)).toString()); } catch { fault('protocol', 'invalid-request'); }
            if (typeof request.id !== 'string' || request.id.length > 128 || request.v !== 1 || request.nonce !== nonce) fault('protocol', 'invalid-request');
            id = request.id;
            if (closing) fault('stop', 'stop-unconfirmed');
            if (request.command?.op === '_stop') { await shutdown(); stop = true; reply = { v: 1, id, ok: true, result: { stopped: true } }; }
            else if (request.command?.op === '_status') reply = { v: 1, id, ok: true, result: { ...ready, browserReady: !unusable, pageReady: !unusable } };
            else {
              if (unusable) fault('operation', 'instance-unusable'); validateCommand(request.command);
              let result;
              try { result = await bounded(dispatcher(session!, request.command), REQUEST_TIMEOUT_MS, 'operation', 'operation-timeout'); }
              catch (e) {
                if (e instanceof RuntimeFault && e.code === 'operation-timeout') { unusable = true; await shutdown(); stop = true; }
                throw e;
              }
              validateSafeResult(result); reply = { v: 1, id, ok: true, result };
            }
          } catch (e) { reply = { v: 1, id, ok: false, error: safeError(e, 'protocol') }; }
          conn.end(JSON.stringify(reply) + '\n', () => { if (stop) { for (const c of connections) c.destroy(); } });
          active--; activity = Date.now();
        }).catch(() => { active--; conn.destroy(); });
      });
    });
    await new Promise<void>((ok, fail) => { server!.once('error', fail); server!.listen(socket, ok); }); await chmod(socket, 0o600);
    checkCancelled();
    await writePrivate(join(directory, 'ready.json'), { nonce, ready });
    idleTimer = setInterval(() => {
      if (active === 0 && !closing && !unusable && Date.now() - activity >= options.idleTimeoutMs) {
        void shutdown().then(() => { for (const c of connections) c.destroy(); }).catch(() => {});
      }
    }, Math.min(1000, options.idleTimeoutMs));
    return ready;
  } catch (e) {
    // adapter 已接触 browser 但无法确认关闭时，不把启动失败误当成没有资源。
    if (e instanceof RuntimeFault && e.code === 'stop-unconfirmed') throw e;
    try { await shutdown(); } catch { throw new RuntimeFault('stop', 'stop-unconfirmed'); }
    throw e;
  }
}
