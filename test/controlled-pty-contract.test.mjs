// tests-only：受控 PTY 驱动合同测试。
//
// 约束：
// - 只使用本测试自己生成的短命普通 fixture（Python 脚本），不启动 Pi、不接真实 Host/provider/网络。
// - 不主动 kill 任何进程：SIGKILL 分支只验证「无许可/身份不匹配/已终止」时的拒绝路径。
// - 每个 lease 的 child/driver PID 与真实退出事实都记入账本并在最后打印。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { startControlledPty } from './helpers/controlled-pty.mjs';

const PYTHON_REQUEST = process.env.PI_TEST_PYTHON || 'python3';
const LEDGER = [];
const ACTIVE_LEASES = new Set();
const RETAINED_ROOTS = [];

function resolvePythonExecutable() {
  if (PYTHON_REQUEST.startsWith('/')) return PYTHON_REQUEST;
  const probe = spawnSync(PYTHON_REQUEST, ['-c', 'import sys; sys.stdout.write(sys.executable)'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (probe.error) throw probe.error;
  const executable = (probe.stdout || '').trim();
  assert.ok(executable.startsWith('/'), `无法解析 Python 绝对路径：${PYTHON_REQUEST}`);
  LEDGER.push({
    who: 'python-resolve-probe',
    pid: probe.pid ?? null,
    status: probe.status,
    signal: probe.signal ?? null,
  });
  return executable;
}

const PYTHON = resolvePythonExecutable();

const TTY_PROBE = `
import os
import sys
import time

UNIT = "中文分片测试"
sys.stdout.write("isatty=%s\\n" % os.isatty(1))
sys.stdout.write("READY\\n")
sys.stdout.flush()
sys.stdout.write("BEGIN" + UNIT * 8000 + "END\\n")
sys.stdout.flush()
time.sleep(0.1)
sys.stdout.write("BYE\\n")
sys.stdout.flush()
sys.exit(0)
`;

const RESIZE_PROBE = `
import fcntl
import os
import select
import signal
import struct
import sys
import termios
import time

COUNT = 0


def geometry():
    rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(1, termios.TIOCGWINSZ, b"\\0" * 8))
    return int(cols), int(rows)


def on_winch(signum, frame):
    global COUNT
    COUNT += 1
    cols, rows = geometry()
    sys.stdout.write("WINCH n=%d cols=%d rows=%d\\n" % (COUNT, cols, rows))
    sys.stdout.flush()


signal.signal(signal.SIGWINCH, on_winch)
cols, rows = geometry()
sys.stdout.write("READY cols=%d rows=%d\\n" % (cols, rows))
sys.stdout.flush()
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    ready, _, _ = select.select([sys.stdin], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(0, 1024)
        except OSError:
            chunk = b""
        if not chunk:
            break
sys.stdout.write("BYE n=%d\\n" % COUNT)
sys.stdout.flush()
sys.exit(0)
`;

const STDIN_EXIT = `
import sys

sys.stdout.write("READY\\n")
sys.stdout.flush()
data = sys.stdin.read()
sys.stdout.write("GOT %d bytes\\n" % len(data))
sys.stdout.flush()
sys.exit(0)
`;

const LINGER = `
import sys
import time

sys.stdout.write("READY\\n")
sys.stdout.flush()
time.sleep(2)
sys.stdout.write("BYE\\n")
sys.stdout.flush()
sys.exit(0)
`;

function makeWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), `controlled-pty-${name}-`));
  const fixtureDir = join(root, 'fixtures');
  const artifactDir = join(root, 'artifacts');
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  return {
    name,
    root,
    fixtureDir,
    artifactDir,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: root,
      TMPDIR: root,
      TERM: 'xterm-256color',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  };
}

function writeFixture(workspace, name, source) {
  const path = join(workspace.fixtureDir, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

async function startLease(workspace, fixtureName, source, overrides = {}) {
  const fixturePath = writeFixture(workspace, fixtureName, source);
  const lease = await startControlledPty({
    command: PYTHON,
    args: [fixturePath],
    cwd: workspace.root,
    env: workspace.env,
    cols: 80,
    rows: 24,
    artifactDir: workspace.artifactDir,
    deadlineMs: 8_000,
    ...overrides,
  });
  LEDGER.push({
    who: workspace.name,
    fixture: fixtureName,
    childPid: lease.pid,
    driverPid: lease.driverPid,
    leaseId: lease.leaseId,
    exit: null,
    residualPaths: [],
  });
  ACTIVE_LEASES.add(lease);
  return lease;
}

function record(lease, closeResult) {
  const entry = LEDGER.find((item) => item.leaseId === lease.leaseId);
  if (!entry) return;
  entry.exit = closeResult?.exit ?? lease.exit ?? null;
  entry.exited = closeResult?.exited ?? false;
  entry.steps = closeResult?.steps ?? null;
  entry.residualPaths = lease.residualPaths ?? [];
}

function settleWorkspace(workspace, finalResult) {
  // 只清理已被证明全部退出且无残留的自有根；其余保留现场。
  if (finalResult?.exited === true && (finalResult.residualPaths ?? []).length === 0) {
    rmSync(workspace.root, { recursive: true, force: true });
    return false;
  }
  RETAINED_ROOTS.push(workspace.root);
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('受控 PTY：TTY、直接子进程身份、UTF-8 跨 chunk、自然退出与输出 artifact', async () => {
  const workspace = makeWorkspace('tty-utf8');
  const lease = await startLease(workspace, 'tty-probe.py', TTY_PROBE);
  try {
    assert.ok(Number.isInteger(lease.pid) && lease.pid > 0, 'lease 必须持有真实 child PID');
    assert.notEqual(lease.pid, process.pid);
    assert.ok(Number.isInteger(lease.driverPid) && lease.driverPid > 0);
    assert.notEqual(lease.driverPid, process.pid);
    assert.notEqual(lease.pid, lease.driverPid, 'child 必须是 driver 的直接子进程，不是 driver 自己');

    const ready = await lease.waitForText('READY', 8_000);
    assert.match(ready.output.replace(/\r\n/g, '\n'), /isatty=(True|true)/, 'fixture 必须在真实 PTY 上运行');

    // exec 稳定之后再采样身份；首次记录参考样本，第二次为重核。
    const first = await lease.sampleIdentity();
    assert.equal(first.recorded, true);
    assert.equal(first.identity.present, true, 'ps 必须能读到 child');
    assert.equal(first.identity.pid, lease.pid);
    assert.equal(first.identity.ppid, lease.driverPid, 'PPID 必须等于 driver，证明未 reap 的直接 child');
    assert.ok(first.identity.birth.length > 0);
    assert.match(first.identity.command, /python/i);
    const recheck = await lease.sampleIdentity();
    assert.equal(recheck.recorded, false);
    assert.equal(recheck.matches, true, 'birth/PPID 重核必须一致');

    const expected = `BEGIN${'中文分片测试'.repeat(8000)}END`;
    const big = await lease.waitForText(expected, 15_000);
    assert.ok(big.output.includes(expected), 'UTF-8 增量解码不得丢跨 chunk 的多字节字符');
    assert.ok(!lease.outputText.includes('\uFFFD'), '不得出现替换字符');
    assert.ok(lease.outputBytes > 65_536, `输出必须跨多个 master 读取，实际 ${lease.outputBytes} 字节`);

    await lease.waitForText('BYE', 8_000);
    const exit = await lease.waitForExit(8_000);
    assert.equal(exit.code, 0, 'fixture 必须自然退出');
    assert.equal(exit.signal, null);
    assert.equal(exit.pid, lease.pid);

    const result = await lease.close();
    assert.equal(result.exited, true);
    assert.equal(result.exit.code, 0);
    assert.ok(result.steps.includes('child-already-exited') || result.steps.includes('child-reaped'));
    record(lease, result);

    const outputLog = join(workspace.artifactDir, 'pty-output.log');
    assert.ok(existsSync(outputLog), '必须保留 raw PTY 输出 artifact');
    const logged = readFileSync(outputLog, 'utf8');
    assert.ok(logged.includes(expected), 'artifact 必须完整保留 UTF-8 输出');
    assert.equal(result.residualPaths.length, 0, '干净退出不得产生残留证据');
  } finally {
    settleWorkspace(workspace, LEDGER.find((item) => item.leaseId === lease.leaseId));
  }
});

test('受控 PTY：resize 只做 TIOCSWINSZ，SIGWINCH 由内核单次投递', async () => {
  const workspace = makeWorkspace('resize');
  const lease = await startLease(workspace, 'resize-probe.py', RESIZE_PROBE);
  try {
    await lease.waitForText('READY cols=80 rows=24', 8_000);
    const applied = await lease.resize(100, 40);
    assert.equal(applied.cols, 100);
    assert.equal(applied.rows, 40);
    assert.equal(applied.appliedCols, 100, 'driver 必须回读实际几何');
    assert.equal(applied.appliedRows, 40);
    await lease.waitForText('WINCH n=1 cols=100 rows=40', 8_000);

    await lease.resize(60, 20);
    await lease.waitForText('WINCH n=2 cols=60 rows=20', 8_000);

    // 不额外补发 SIGWINCH：静置后计数仍为 2。
    await sleep(400);
    assert.equal(/WINCH n=3/.test(lease.outputText), false, 'driver 不得显式补发第二次 SIGWINCH');

    const result = await lease.close();
    assert.equal(result.exited, true);
    assert.equal(result.exit.code, 0);
    assert.match(lease.outputText, /BYE n=2/);
    record(lease, result);
  } finally {
    settleWorkspace(workspace, LEDGER.find((item) => item.leaseId === lease.leaseId));
  }
});

test('受控 PTY：Ctrl+D 优雅退出与重复 close 幂等', async () => {
  const workspace = makeWorkspace('repeat-close');
  const lease = await startLease(workspace, 'stdin-exit.py', STDIN_EXIT);
  try {
    await lease.waitForText('READY', 8_000);
    assert.equal(lease.exit, null, 'close 之前 fixture 必须仍存活');
    const [first, second] = await Promise.all([lease.close(), lease.close()]);
    assert.equal(first, second, '并发 close 必须返回同一事实对象');
    assert.equal(first.exited, true);
    assert.equal(first.exit.code, 0);
    assert.ok(first.steps.includes('ctrl-d'), '正常退出必须先发 Ctrl+D');
    assert.match(lease.outputText, /GOT 0 bytes/, 'Ctrl+D 必须让 fixture 的 stdin 收到 EOF');
    const third = await lease.close();
    assert.equal(third, first, '已关闭后重复 close 必须幂等');
    record(lease, third);
  } finally {
    settleWorkspace(workspace, LEDGER.find((item) => item.leaseId === lease.leaseId));
  }
});

test('受控 PTY：deadline 有界失败保留 artifact 与 live 身份，且不杀 wrapper', async () => {
  const workspace = makeWorkspace('bounded-timeout');
  const lease = await startLease(workspace, 'linger.py', LINGER, { deadlineMs: 400 });
  try {
    await lease.waitForText('READY', 8_000);
    const startedAt = Date.now();
    const failed = await lease.close();
    const elapsed = Date.now() - startedAt;
    assert.equal(failed.exited, false, 'linger fixture 不可能在 400ms 内退出');
    assert.ok(elapsed < 6_000, `close 必须有界返回，实际 ${elapsed}ms`);
    assert.ok(failed.steps.some((step) => step.startsWith('exit-deadline-exceeded')), JSON.stringify(failed.steps));

    assert.ok(failed.residualPaths.length >= 1, '超时必须写残留 artifact');
    for (const path of failed.residualPaths) assert.ok(existsSync(path), `artifact 必须保留：${path}`);
    const driverResidualPath = failed.residualPaths.find((path) => path.includes('residual-driver'));
    assert.ok(driverResidualPath, 'driver 必须写自己的残留证据');
    const residual = JSON.parse(readFileSync(driverResidualPath, 'utf8'));
    assert.equal(residual.childPid, lease.pid);
    assert.equal(residual.driverPid, lease.driverPid);
    assert.equal(residual.killDelivered, false, '本任务不得发送任何 SIGKILL');
    assert.ok(residual.reason.length > 0);
    assert.equal(residual.exit, null, '残留时 child 仍未退出');
    assert.ok(residual.liveIdentity.present === true, '必须报告 live 身份');
    assert.equal(residual.liveIdentity.pid, lease.pid);

    // 不主动 kill：等 fixture 自然退出后再 close，证明 lease 仍可回收。
    const exit = await lease.waitForExit(10_000);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    const finalResult = await lease.close();
    assert.equal(finalResult.exited, true);
    assert.equal(finalResult.exit.code, 0);
    for (const path of failed.residualPaths) assert.ok(existsSync(path), '后续 close 不得删除已保留的 artifact');
    assert.ok(existsSync(join(workspace.artifactDir, 'pty-output.log')));
    record(lease, finalResult);
  } finally {
    settleWorkspace(workspace, LEDGER.find((item) => item.leaseId === lease.leaseId));
  }
});

test('受控 PTY：拒绝外部 PID/attach 入参与 group kill 入参', async () => {
  const workspace = makeWorkspace('reject-attach');
  const fixturePath = writeFixture(workspace, 'stdin-exit.py', STDIN_EXIT);
  const base = {
    command: PYTHON,
    args: [fixturePath],
    cwd: workspace.root,
    env: workspace.env,
    cols: 80,
    rows: 24,
    artifactDir: workspace.artifactDir,
    deadlineMs: 4_000,
  };
  try {
    for (const extra of [{ pid: process.pid }, { attachPid: 1 }, { attach: true }, { processGroup: -1 }, { pgid: 1234 }]) {
      await assert.rejects(
        () => startControlledPty({ ...base, ...extra }),
        /拒绝外部 PID/,
        `必须拒绝入参 ${JSON.stringify(extra)}`,
      );
    }
    await assert.rejects(() => startControlledPty({ ...base, command: '' }), /command 必填/);
    await assert.rejects(() => startControlledPty({ ...base, args: [1] }), /args 必须为字符串数组/);
    await assert.rejects(() => startControlledPty({ ...base, cols: 0 }), /正整数/);
    await assert.rejects(() => startControlledPty({ ...base, env: { PATH: 1 } }), /env\.PATH 必须为字符串/);
  } finally {
    settleWorkspace(workspace, { exited: true, residualPaths: [] });
  }
});

test('受控 PTY：无许可/身份不匹配/已终止一律不发 signal', async () => {
  const workspace = makeWorkspace('refuse-kill');
  const lease = await startLease(workspace, 'stdin-exit.py', STDIN_EXIT);
  try {
    await lease.waitForText('READY', 8_000);

    const missing = await lease.signalFixtureKill(undefined);
    assert.deepEqual(missing, { delivered: false, reason: 'unauthorized-missing-permission', sent: false });
    const notExplicit = await lease.signalFixtureKill({ leaseId: lease.leaseId, pid: lease.pid });
    assert.deepEqual(notExplicit, { delivered: false, reason: 'unauthorized-missing-permission', sent: false });

    const pidMismatch = await lease.signalFixtureKill({
      explicitOneTimePermission: true,
      leaseId: lease.leaseId,
      pid: lease.pid + 1,
    });
    assert.equal(pidMismatch.delivered, false);
    assert.equal(pidMismatch.reason, 'pid-mismatch');
    assert.equal(pidMismatch.sent, false);

    const leaseMismatch = await lease.signalFixtureKill({
      explicitOneTimePermission: true,
      leaseId: 'not-this-lease',
      pid: lease.pid,
    });
    assert.equal(leaseMismatch.reason, 'lease-mismatch');
    assert.equal(leaseMismatch.sent, false);

    const signalMismatch = await lease.signalFixtureKill({
      explicitOneTimePermission: true,
      leaseId: lease.leaseId,
      pid: lease.pid,
      signal: 'SIGTERM',
    });
    assert.equal(signalMismatch.reason, 'unsupported-signal');
    assert.equal(signalMismatch.sent, false);

    await assert.rejects(
      () => lease.signalFixtureKill({
        explicitOneTimePermission: true,
        leaseId: lease.leaseId,
        pid: lease.pid,
        group: true,
      }),
      /拒绝 group\/descendant kill/,
    );

    // 所有拒绝路径都不得影响 fixture 存活与身份。
    assert.equal(lease.exit, null, '被拒绝的 kill 不得终止 fixture');
    const recheck = await lease.sampleIdentity();
    assert.equal(recheck.matches, true);
    assert.equal(recheck.identity.present, true);
    assert.equal(recheck.exited, false);

    const result = await lease.close();
    assert.equal(result.exited, true);
    assert.equal(result.exit.code, 0);
    assert.equal(lease.snapshot().killConsumed, false, '本合同测试不得消耗 SIGKILL lease');
    record(lease, result);
  } finally {
    settleWorkspace(workspace, LEDGER.find((item) => item.leaseId === lease.leaseId));
  }
});

test('受控 PTY：child 已终止后即使授权齐全也拒绝 signal', async () => {
  const workspace = makeWorkspace('terminal-refusal');
  const lease = await startLease(workspace, 'stdin-exit.py', STDIN_EXIT);
  try {
    await lease.waitForText('READY', 8_000);
    await lease.write('\x04');
    const exit = await lease.waitForExit(8_000);
    assert.equal(exit.code, 0);
    const refusal = await lease.signalFixtureKill({
      explicitOneTimePermission: true,
      leaseId: lease.leaseId,
      pid: lease.pid,
      signal: 'SIGKILL',
    });
    assert.equal(refusal.delivered, false, '已终止的 child 不得再收信号');
    assert.equal(refusal.reason, 'already-terminal-local');
    assert.equal(lease.snapshot().killConsumed, false);
    const result = await lease.close();
    assert.equal(result.exited, true);
    record(lease, result);
  } finally {
    settleWorkspace(workspace, LEDGER.find((item) => item.leaseId === lease.leaseId));
  }
});

test.after(async () => {
  // 断言失败时，测试的 finally 仍需保留现场；这里仅对本测试自己创建的 lease
  // 做优雅 Ctrl+D 收口，避免失败路径把 driver/child 留成未知残留。
  for (const lease of ACTIVE_LEASES) {
    if (lease.exit !== null) continue;
    try {
      const result = await lease.close();
      record(lease, result);
    } catch (error) {
      const entry = LEDGER.find((item) => item.leaseId === lease.leaseId);
      if (entry) entry.cleanupError = String(error?.message ?? error);
    }
  }
  for (const entry of LEDGER) {
    const exitText = entry.exit
      ? `code=${entry.exit.code} signal=${entry.exit.signal} status=${entry.exit.status}`
      : `status=${entry.status ?? 'n/a'} signal=${entry.signal ?? 'n/a'}`;
    console.log(
      `[pty-ledger] ${entry.who} fixture=${entry.fixture ?? '-'} childPid=${entry.childPid ?? entry.pid ?? '-'}`
      + ` driverPid=${entry.driverPid ?? '-'} exited=${entry.exited ?? '-'} ${exitText}`
      + ` residual=${(entry.residualPaths ?? []).length}`,
    );
  }
  console.log(`[pty-ledger] retainedRoots=${JSON.stringify(RETAINED_ROOTS)}`);
  const unfinished = LEDGER.filter(
    (entry) => entry.childPid !== undefined && entry.exited !== true && entry.exit === null,
  );
  assert.deepEqual(unfinished, [], '所有 lease 的 child 必须有已证明的退出事实');
  const killed = LEDGER.filter((entry) => entry.exit?.signal !== null && entry.exit?.signal !== undefined);
  assert.deepEqual(killed, [], '合同测试不得出现被信号终止的 child');
});
