// tests-only 受控 PTY 驱动包装（Node 侧）。
//
// 边界（与 docs/plans/2026-10-15-runtime-closeout.md P0 一致）：
// - 只包装本 helper 自己 spawn 的 Python driver；不接受 attach/外部 PID 入参。
// - 不发送任何未授权信号；`signalFixtureKill` 默认禁用，只有显式一次性许可且 lease/pid 匹配才可能送达。
// - 不做 group kill、不杀 wrapper、不删临时根；deadline 失败时保留 artifact 与 live 身份并如实上报。
// - 所有等待都有界；退出事件幂等，重复 close 返回同一事实。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const DRIVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'controlled-pty-driver.py');
// 出现这些键说明调用方想接管既有进程/进程组，构造 lease 前直接拒绝。
const FORBIDDEN_OPTION_KEYS = Object.freeze([
  'pid',
  'attachPid',
  'attach',
  'existingPid',
  'pgid',
  'processGroup',
  'killGroup',
  'descendants',
]);
const DEFAULT_DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DRIVER_EXIT_TIMEOUT_MS = 3_000;
const DRIVER_STDIO_TIMEOUT_MS = 1_000;

function nowIso() {
  return new Date().toISOString();
}

function assertPositiveInteger(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`controlled-pty: ${name} 必须为正整数`);
  return value;
}

/**
 * 启动一个受控 PTY lease。
 * @param {object} options
 * @param {string} options.command 只允许当前测试指定的可执行项
 * @param {string[]} [options.args]
 * @param {string} options.cwd
 * @param {Record<string,string>} options.env 显式白名单环境，不继承调用方全部 env
 * @param {number} [options.cols]
 * @param {number} [options.rows]
 * @param {string} options.artifactDir 证据目录；失败时保留，不删除
 * @param {number} [options.deadlineMs] 全部等待的默认上界
 * @returns {Promise<object>} lease
 */
export async function startControlledPty(options) {
  if (!options || typeof options !== 'object') throw new TypeError('controlled-pty: options 必须为对象');
  for (const key of FORBIDDEN_OPTION_KEYS) {
    if (key in options) throw new TypeError(`controlled-pty: 拒绝外部 PID/进程组入参 ${key}`);
  }
  const { command, cwd, artifactDir } = options;
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('controlled-pty: command 必填');
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
    throw new TypeError('controlled-pty: args 必须为字符串数组');
  }
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('controlled-pty: cwd 必填');
  const env = options.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new TypeError('controlled-pty: env 必填且为对象');
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new TypeError(`controlled-pty: env.${key} 必须为字符串`);
  }
  if (typeof artifactDir !== 'string' || artifactDir.length === 0) {
    throw new TypeError('controlled-pty: artifactDir 必填');
  }
  const cols = assertPositiveInteger(options.cols, 'cols', 80);
  const rows = assertPositiveInteger(options.rows, 'rows', 24);
  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
    ? options.deadlineMs
    : DEFAULT_DEADLINE_MS;

  const resolvedArtifactDir = resolve(artifactDir);
  mkdirSync(resolvedArtifactDir, { recursive: true });

  const driverPath = typeof options.driverPath === 'string' && options.driverPath.length > 0
    ? resolve(options.driverPath)
    : DRIVER_PATH;
  const pythonExecutable = typeof process.env.PI_TEST_PYTHON === 'string' && process.env.PI_TEST_PYTHON.length > 0
    ? process.env.PI_TEST_PYTHON
    : 'python3';

  const driver = spawn(pythonExecutable, ['-u', driverPath], {
    cwd: resolvedArtifactDir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  driver.stdout.setEncoding('utf8');
  driver.stderr.setEncoding('utf8');

  const lease = new ControlledPtyLease({
    driver,
    command,
    args,
    cwd,
    env,
    cols,
    rows,
    artifactDir: resolvedArtifactDir,
    deadlineMs,
  });
  await lease.start();
  return lease.publicApi();
}

class ControlledPtyLease {
  constructor({ driver, command, args, cwd, env, cols, rows, artifactDir, deadlineMs }) {
    this.driver = driver;
    this.requestSeed = 0;
    this.pending = new Map();
    this.textWaiters = new Set();
    this.exitWaiters = new Set();
    this.decoder = new StringDecoder('utf8');
    this.stdoutBuffer = '';
    this.outputText = '';
    this.outputBytes = 0;
    this.stderrTail = [];
    this.events = [];
    this.startRequest = { command, args, cwd, env, cols, rows, artifactDir };
    this.deadlineMs = deadlineMs;
    this.pid = null;
    this.leaseId = null;
    this.driverPid = null;
    this.referenceIdentity = null;
    this.exit = null;
    this.eof = false;
    this.driverExited = null;
    this.residuals = [];
    this.closeResult = null;
    this.closePromise = null;
    this.killConsumed = false;
    this.wireDriver();
  }

  // ---------- driver 事件 ----------

  wireDriver() {
    this.driver.stdout.on('data', (chunk) => this.onDriverStdout(chunk));
    this.driver.stderr.on('data', (chunk) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.driver.once('error', (error) => {
      this.driverExited = { code: null, signal: null, reason: 'driver-error', error: error.code ?? error.name };
      this.failAllPending(this.driverExited.reason);
      this.resolveExitWaiters();
    });
    this.driver.once('exit', (code, signal) => {
      this.driverExited = { code, signal, at: nowIso() };
      // driver 退出但没报告 child exit：不能把 wrapper 退出当 child 退出证明。
      if (this.exit === null) {
        this.exit = { code: null, signal: null, status: null, reason: 'driver-exited-without-child-exit' };
      }
      this.failAllPending('driver-exited');
      this.resolveExitWaiters();
      this.writeNodeArtifact('driver-exit.json', { driverExited: this.driverExited, exit: this.exit });
    });
  }

  onDriverStdout(chunk) {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.trim().length > 0) this.onControlLine(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  onControlLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.events.push({ at: nowIso(), type: 'control-line-invalid' });
      return;
    }
    this.events.push({ at: nowIso(), type: message.type, id: message.id ?? null });
    switch (message.type) {
      case 'response': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
        return;
      }
      case 'data': {
        const bytes = Buffer.from(String(message.base64 ?? ''), 'base64');
        this.outputBytes += bytes.byteLength;
        // StringDecoder 保证跨 chunk 的多字节 UTF-8 序列不被切碎。
        this.appendOutput(this.decoder.write(bytes));
        return;
      }
      case 'eof':
        this.eof = true;
        return;
      case 'exit':
        this.exit = {
          pid: message.pid ?? null,
          code: message.code ?? null,
          signal: message.signal ?? null,
          status: message.status ?? null,
          reason: message.reason ?? null,
          reapedAt: message.reapedAt ?? null,
        };
        this.resolveExitWaiters();
        return;
      case 'residual':
        this.residuals.push({
          path: message.path,
          reason: message.reason,
          childPid: message.childPid,
          liveIdentity: message.liveIdentity ?? null,
          at: nowIso(),
        });
        return;
      case 'identity':
      case 'hello':
      case 'driver-exit':
      case 'error':
      default:
        return;
    }
  }

  appendOutput(text) {
    if (!text) return;
    this.outputText += text;
    for (const waiter of [...this.textWaiters]) waiter.check();
  }

  failAllPending(reason) {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`controlled-pty: driver 不可用（${reason}），请求 ${id} 未完成`));
    }
  }

  resolveExitWaiters() {
    for (const waiter of [...this.exitWaiters]) {
      this.exitWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(this.exit);
    }
  }

  // ---------- 请求 ----------

  request(payload, timeoutMs) {
    if (this.driverExited && this.driver.exited) {
      return Promise.reject(new Error('controlled-pty: driver 已退出，无法发送请求'));
    }
    const id = ++this.requestSeed;
    const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        rejectPromise(new Error(`controlled-pty: 请求 ${payload.method} 在 ${bound}ms 内无响应`));
      }, bound);
      // 先注册监听，再发出动作，避免响应早于等待。
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      let serialized;
      try {
        serialized = `${JSON.stringify({ id, ...payload })}\n`;
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectPromise(error);
        return;
      }
      this.driver.stdin.write(serialized, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`controlled-pty: 写入控制通道失败（${error.code ?? error.message}）`));
      });
    });
  }

  async sendRequest(payload, timeoutMs, label) {
    const response = await this.request(payload, timeoutMs);
    if (response.ok === false) {
      const error = new Error(`controlled-pty: ${label ?? payload.method} 被 driver 拒绝（${response.reason}）`);
      error.reason = response.reason;
      error.response = response;
      throw error;
    }
    return response;
  }

  async start() {
    const response = await this.sendRequest(
      { method: 'start', ...this.startRequest },
      this.deadlineMs,
      'start',
    );
    this.pid = response.pid;
    this.leaseId = response.leaseId;
    this.driverPid = response.driverPid;
    this.outputLog = response.outputLog ?? null;
  }

  // ---------- 冻结 API ----------

  write(text) {
    if (typeof text !== 'string') return Promise.reject(new TypeError('controlled-pty: write 只接受字符串'));
    return this.sendRequest({ method: 'write', data: text }, REQUEST_TIMEOUT_MS, 'write')
      .then((response) => ({ bytesWritten: response.bytesWritten ?? 0 }));
  }

  resize(cols, rows) {
    const nextCols = assertPositiveInteger(cols, 'cols', null);
    const nextRows = assertPositiveInteger(rows, 'rows', null);
    if (nextCols === null || nextRows === null) {
      return Promise.reject(new TypeError('controlled-pty: resize 需要 cols/rows'));
    }
    return this.sendRequest({ method: 'resize', cols: nextCols, rows: nextRows }, REQUEST_TIMEOUT_MS, 'resize')
      .then((response) => ({
        cols: response.cols,
        rows: response.rows,
        appliedCols: response.appliedCols,
        appliedRows: response.appliedRows,
      }));
  }

  /**
   * 等待 PTY 输出出现指定文本；监听在调用时同步注册，调用方随后再触发动作。
   * @param {string|RegExp} needle
   * @param {number} [timeoutMs]
   */
  waitForText(needle, timeoutMs) {
    const matcher = typeof needle === 'string'
      ? (text) => {
        const index = text.indexOf(needle);
        return index >= 0 ? { index, match: needle } : null;
      }
      : (text) => {
        const result = needle.exec(text);
        return result ? { index: result.index, match: result[0] } : null;
      };
    const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.deadlineMs;
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        timer: null,
        resolve: null,
        check: () => {
          const found = matcher(this.outputText);
          if (!found) return;
          this.textWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          resolvePromise({
            match: found.match,
            index: found.index,
            output: this.outputText,
            outputBytes: this.outputBytes,
          });
        },
      };
      waiter.timer = setTimeout(() => {
        if (!this.textWaiters.has(waiter)) return;
        this.textWaiters.delete(waiter);
        rejectPromise(new Error(
          `controlled-pty: ${bound}ms 内未等到输出 ${typeof needle === 'string' ? JSON.stringify(needle) : String(needle)}`
          + `（已收 ${this.outputBytes} 字节，exit=${JSON.stringify(this.exit)}）`,
        ));
      }, bound);
      this.textWaiters.add(waiter);
      waiter.check();
    });
  }

  waitForExit(timeoutMs) {
    const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.deadlineMs;
    if (this.exit !== null) return Promise.resolve(this.exit);
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { resolve: resolvePromise, timer: null };
      waiter.timer = setTimeout(() => {
        if (!this.exitWaiters.has(waiter)) return;
        this.exitWaiters.delete(waiter);
        rejectPromise(new Error(`controlled-pty: ${bound}ms 内 child 未退出（pid=${this.pid}，driverPid=${this.driverPid}）`));
      }, bound);
      this.exitWaiters.add(waiter);
    });
  }

  /** exec 稳定/ready 之后采样身份；首次调用记录为参考样本，之后为重核。 */
  sampleIdentity(timeoutMs) {
    return this.sendRequest({ method: 'identity' }, timeoutMs ?? REQUEST_TIMEOUT_MS, 'identity')
      .then((response) => {
        if (response.recorded === true) this.referenceIdentity = response.identity ?? null;
        return {
          identity: response.identity ?? null,
          recorded: response.recorded === true,
          matches: response.matches === true,
          driverPid: response.driverPid ?? this.driverPid,
          exited: response.exited === true,
        };
      });
  }

  /**
   * 默认禁用的一次性 SIGKILL：只有显式许可 + 本 lease 的 pid/leaseId 匹配才会下发给 driver，
   * driver 仍会独立复核 terminal 状态与 birth/PPID。不支持组杀与任意 signal。
   */
  async signalFixtureKill(authorization) {
    if (authorization === undefined || authorization === null) {
      return { delivered: false, reason: 'unauthorized-missing-permission', sent: false };
    }
    if (typeof authorization !== 'object') {
      throw new TypeError('controlled-pty: authorization 必须为对象');
    }
    for (const key of ['group', 'processGroup', 'pgid', 'killGroup', 'descendants']) {
      if (authorization[key]) throw new TypeError(`controlled-pty: 拒绝 group/descendant kill 入参 ${key}`);
    }
    if (authorization.explicitOneTimePermission !== true) {
      return { delivered: false, reason: 'unauthorized-missing-permission', sent: false };
    }
    if (authorization.signal !== undefined && authorization.signal !== 'SIGKILL') {
      return { delivered: false, reason: 'unsupported-signal', sent: false };
    }
    if (authorization.leaseId !== this.leaseId) {
      return { delivered: false, reason: 'lease-mismatch', sent: false };
    }
    if (authorization.pid !== this.pid) {
      return { delivered: false, reason: 'pid-mismatch', sent: false };
    }
    if (this.killConsumed) {
      return { delivered: false, reason: 'lease-already-consumed', sent: false };
    }
    if (this.exit !== null) {
      return { delivered: false, reason: 'already-terminal-local', sent: false, exit: this.exit };
    }
    const response = await this.request(
      { method: 'signal', signal: 'SIGKILL', authorization },
      REQUEST_TIMEOUT_MS,
    );
    if (response.delivered === true) this.killConsumed = true;
    return {
      delivered: response.delivered === true,
      reason: response.reason ?? null,
      sent: true,
      identity: response.identity ?? null,
      exit: response.exit ?? this.exit,
    };
  }

  /**
   * 幂等关闭：优雅退出（Ctrl+D）→ 等待 reap → driver shutdown。
   * deadline 失败时写残留 artifact，不杀 wrapper、不删根、不做 group kill。
   */
  close() {
    if (this.closeResult) return Promise.resolve(this.closeResult);
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose().then((result) => {
      this.closePromise = null;
      if (result.exited === true) this.closeResult = result;
      return result;
    }, (error) => {
      this.closePromise = null;
      throw error;
    });
    return this.closePromise;
  }

  async performClose() {
    const steps = [];
    if (this.exit === null) {
      // 上层若需先关 overlay / 清 fixture 草稿，应在调用 close 前自行 write。
      try {
        await this.write('\x04');
        steps.push('ctrl-d');
      } catch (error) {
        steps.push(`ctrl-d-failed:${error.reason ?? error.message}`);
      }
      try {
        await this.waitForExit(this.deadlineMs);
        steps.push('child-reaped');
      } catch (error) {
        steps.push(`exit-deadline-exceeded:${this.deadlineMs}ms`);
      }
    } else {
      steps.push('child-already-exited');
    }

    let residual = this.exit === null;
    let shutdown = null;
    if (this.driverExited === null) {
      try {
        shutdown = await this.request(
          { method: 'shutdown', timeoutMs: residual ? Math.min(this.deadlineMs, 2_000) : DRIVER_STDIO_TIMEOUT_MS },
          Math.max(residual ? 3_000 : DRIVER_STDIO_TIMEOUT_MS, 3_000),
        );
        steps.push(shutdown.ok === false ? `shutdown-${shutdown.reason}` : 'shutdown-ok');
        if (shutdown.ok === false && shutdown.residualPath) {
          this.noteResidual(shutdown.residualPath, shutdown.reason, shutdown.liveIdentity);
        }
      } catch (error) {
        steps.push(`shutdown-failed:${error.message}`);
      }
    } else {
      steps.push('driver-already-exited');
    }

    const driverExit = await this.waitForDriverExit(residual ? 0 : DRIVER_EXIT_TIMEOUT_MS);
    // driver 自己退出不能当 child 退出证明。
    const reaped = this.exit !== null && this.exit.reason !== 'driver-exited-without-child-exit';
    if (!reaped) {
      // 保留现场：不 kill wrapper、不删 artifactDir、不 group kill；只 unref 以免卡住测试进程。
      this.detachHandles();
      const identity = await this.safeLiveIdentity();
      const path = this.writeNodeArtifact(`residual-node-${this.pid ?? 'unknown'}.json`, {
        reason: 'close-deadline-exceeded',
        childPid: this.pid,
        driverPid: this.driverPid,
        leaseId: this.leaseId,
        command: this.startRequest.command,
        args: this.startRequest.args,
        cwd: this.startRequest.cwd,
        liveIdentity: identity,
        exit: this.exit,
        outputBytes: this.outputBytes,
        outputLog: this.outputLog ?? null,
        driverResiduals: this.residuals,
        steps,
        retained: true,
      });
      if (path) this.noteResidual(path, 'close-deadline-exceeded', identity);
      return {
        exited: false,
        reaped: false,
        exit: this.exit,
        steps,
        pid: this.pid,
        driverPid: this.driverPid,
        leaseId: this.leaseId,
        liveIdentity: identity,
        residualPaths: this.residuals.map((item) => item.path),
        driverExited: this.driverExited,
        driverExitObserved: driverExit,
      };
    }
    if (driverExit === null) this.detachHandles();
    return {
      exited: true,
      reaped: true,
      exit: this.exit,
      steps,
      pid: this.pid,
      driverPid: this.driverPid,
      leaseId: this.leaseId,
      outputBytes: this.outputBytes,
      outputLog: this.outputLog ?? null,
      residualPaths: this.residuals.map((item) => item.path),
      driverExited: this.driverExited,
      driverExitObserved: driverExit,
    };
  }

  noteResidual(path, reason, liveIdentity) {
    if (typeof path !== 'string') return;
    if (this.residuals.some((item) => item.path === path)) return;
    this.residuals.push({ path, reason, childPid: this.pid, liveIdentity: liveIdentity ?? null, at: nowIso() });
  }

  async safeLiveIdentity() {
    if (this.exit !== null || this.driverExited !== null) return null;
    try {
      const sample = await this.sampleIdentity(DRIVER_STDIO_TIMEOUT_MS);
      return sample.identity;
    } catch {
      return null;
    }
  }

  waitForDriverExit(timeoutMs) {
    if (this.driverExited !== null) return Promise.resolve(this.driverExited);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.driver.off('exit', onExit);
        resolvePromise(null);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolvePromise(this.driverExited);
      };
      this.driver.once('exit', onExit);
    });
  }

  detachHandles() {
    try {
      this.driver.stdin.unref?.();
      this.driver.stdout.unref?.();
      this.driver.stderr.unref?.();
      this.driver.unref?.();
    } catch {
      // unref 失败不影响残留事实，只是可能让测试进程多等一轮。
    }
  }

  writeNodeArtifact(name, payload) {
    try {
      const path = join(this.startRequest.artifactDir, name);
      writeFileSync(path, `${JSON.stringify({ generatedAt: nowIso(), ...payload }, null, 2)}\n`, 'utf8');
      return path;
    } catch {
      return null;
    }
  }

  snapshot() {
    return {
      pid: this.pid,
      driverPid: this.driverPid,
      leaseId: this.leaseId,
      command: this.startRequest.command,
      args: this.startRequest.args,
      cwd: this.startRequest.cwd,
      artifactDir: this.startRequest.artifactDir,
      exit: this.exit,
      eof: this.eof,
      outputBytes: this.outputBytes,
      outputLog: this.outputLog ?? null,
      referenceIdentity: this.referenceIdentity,
      residualPaths: this.residuals.map((item) => item.path),
      killConsumed: this.killConsumed,
      driverExited: this.driverExited,
      stderrTail: this.stderrTail.join('').slice(-2000),
    };
  }

  publicApi() {
    // 用闭包固定 this，暴露面严格等于冻结 API（外加只读重核/快照两个 helper）。
    const self = this;
    return {
      get pid() { return self.pid; },
      get driverPid() { return self.driverPid; },
      get leaseId() { return self.leaseId; },
      get exit() { return self.exit; },
      get outputText() { return self.outputText; },
      get outputBytes() { return self.outputBytes; },
      get eof() { return self.eof; },
      get artifactDir() { return self.startRequest.artifactDir; },
      get outputLog() { return self.outputLog ?? null; },
      get residualPaths() { return self.residuals.map((item) => item.path); },
      write: (text) => self.write(text),
      resize: (cols, rows) => self.resize(cols, rows),
      waitForText: (needle, timeoutMs) => self.waitForText(needle, timeoutMs),
      waitForExit: (timeoutMs) => self.waitForExit(timeoutMs),
      signalFixtureKill: (authorization) => self.signalFixtureKill(authorization),
      sampleIdentity: (timeoutMs) => self.sampleIdentity(timeoutMs),
      close: () => self.close(),
      snapshot: () => self.snapshot(),
    };
  }
}
