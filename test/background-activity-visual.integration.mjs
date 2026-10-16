// tests-only：真实隔离终端验证；必须显式 PI_TEST_BG_VISUAL=1。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
function renderedLines(debug) {
  return debug.split('\n').flatMap((line) => {
    const match = /^\[\d+\] \(w=(\d+)\) (.*)$/.exec(line);
    return match ? [{ width: Number(match[1]), text: stripVTControlCharacters(JSON.parse(match[2])) }] : [];
  });
}
import { startControlledPty } from './helpers/controlled-pty.mjs';
import { repo, hostRoot, scenarios, visualArgs, visualEnv } from './helpers/background-activity-visual.mjs';

// 等待自造 probe 文件事件而不是 sleep；监听先于动作，且每次回查已落盘状态。
async function waitProbe(root, predicate, timeoutMs = 20_000, afterLine = 0) {
  const path = join(root, 'probe.jsonl');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(value); };
    const check = async () => {
      try {
        const entries = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        const result = entries.slice(afterLine).find(predicate);
        if (result) finish(null, result);
      } catch (error) { if (error.code !== 'ENOENT') finish(error); }
    };
    const watcher = watch(root, () => { void check(); });
    const timer = setTimeout(() => finish(new Error(`fixture probe 超时：${root}`)), timeoutMs);
    void check();
  });
}
async function fixture(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), `bg-visual-${scenario}-`));
  await Promise.all(['home', 'tmp', 'agent', 'sessions', 'registry', 'cwd'].map((dir) => mkdir(join(root, dir), { mode: 0o700 })));
  const lease = await startControlledPty({ command: join(repo, 'scripts/pi-launcher.zsh'), args: visualArgs(root), cwd: join(root, 'cwd'), env: visualEnv(root), cols: 78, rows: 24, artifactDir: join(root, 'pty'), deadlineMs: 20_000 });
  t.after(async () => {
    if (lease.exit === null) await lease.write('\x1b[27u\x15').catch(() => {});
    const closed = await lease.close();
    await writeFile(join(root, 'exit.json'), JSON.stringify(closed, null, 2), { mode: 0o600 });
    console.log(`[visual-ledger] ${scenario} ${root} ${JSON.stringify(closed)}`);
    assert.equal(closed.exited, true, '所有视觉fixture必须自然退出/reap，不强杀');
    assert.equal(closed.exit.code, 0);
  });
  await waitProbe(root, (entry) => entry.event === 'start');
  // 输入命令在 TUI 完成首帧后发送，fake model label 为真实首帧文本。
  await lease.waitForText(/deterministic/i, 20_000);
  let commandSeq = 0;
  const command = async (action) => {
    const before = (await readFile(join(root, 'probe.jsonl'), 'utf8')).trim().split('\n').length;
    const done = waitProbe(root, (entry) => entry.event === 'command' && entry.action === action && entry.fixture === true && entry.epoch >= 1, 20_000, before);
    // 每个 scenario 内普通 action 唯一；重复动作使用独立序号帧文件，不依赖旧文本捕获。
    await lease.write(`\x15/fixture-bg ${action}\r`);
    const result = await done;
    await writeFile(join(root, `command-${++commandSeq}.json`), JSON.stringify({ before, action, result }), { mode: 0o600 });
    return result;
  };
  const debug = async (name) => {
    const debugPath = join(root, 'agent/pi-debug.log');
    const fresh = new Promise((resolve, reject) => {
      const watcher = watch(join(root, 'agent'), async (_type, filename) => {
        if (String(filename) !== 'pi-debug.log') return;
        try {
          const text = await readFile(debugPath, 'utf8');
          if (!text.includes('=== All rendered lines')) return;
          clearTimeout(timer); watcher.close(); resolve(text);
        } catch { /* 自造文件尚未写完，下次事件重读 */ }
      });
      const timer = setTimeout(() => { watcher.close(); reject(new Error('未收到新debug帧')); }, 20_000);
    });
    await lease.write('\x15/debug\r');
    const text = await fresh;
    await writeFile(join(root, `frame-${name}.log`), text, { mode: 0o600 });
    return text;
  };
  return { root, lease, command, debug };
}

for (const scenario of scenarios) test(`真实后台活动视觉：${scenario}`, { skip: process.env.PI_TEST_BG_VISUAL !== '1', timeout: 120_000 }, async (t) => {
  if (scenario === 'rpc') {
    const root = await mkdtemp(join(tmpdir(), 'bg-visual-rpc-'));
    await Promise.all(['home', 'tmp', 'agent', 'sessions', 'registry', 'cwd'].map((dir) => mkdir(join(root, dir), { mode: 0o700 })));
    const child = spawn(process.execPath, [join(hostRoot, 'dist/cli.js'), ...visualArgs(root, true)], { cwd: join(root, 'cwd'), env: visualEnv(root), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    await waitProbe(root, (entry) => entry.event === 'start' && entry.mode === 'rpc');
    child.stdin.write(JSON.stringify({ id: 'fixture-state', type: 'get_state' }) + '\n');
    child.stdin.end();
    const terminal = await exit;
    await writeFile(join(root, 'rpc.json'), JSON.stringify({ output, errors, terminal }), { mode: 0o600 });
    assert.equal(terminal.code, 0);
    const lines = output.trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    assert.doesNotMatch(output, /\x1b\[|fixture:subagent|fixture detail/);
    return;
  }
  const { root, lease, command, debug } = await fixture(t, scenario);
  if (scenario === 'base') {
    const frame = stripVTControlCharacters(await debug('base'));
    for (const kind of ['subagent', 'bash_async', 'scheduler']) assert.ok(frame.includes(`fixture:${kind}:0`));
    const entries = renderedLines(frame).filter((line) => /fixture:(subagent|bash_async|scheduler):0/.test(line.text));
    assert.equal(entries.length, 3);
    for (const line of entries) { assert.equal(visibleWidth(line.text.slice(0, line.text.indexOf('fixture:'))), 3); assert.equal(line.width, 78); }
  } else if (scenario === 'long') {
    await command('long');
    const frame = stripVTControlCharacters(await debug('long'));
    assert.ok(frame.includes('(delegate)'));
    assert.ok(frame.includes('fixture:'));
    const title = renderedLines(frame).find((line) => line.text.includes('brightness-control'));
    const continuation = renderedLines(frame).find((line) => line.text.includes('(delegate)'));
    assert.ok(title && continuation);
    assert.equal(title.width, 78);
    assert.ok(continuation.text.startsWith('   '));
    assert.ok(!continuation.text.startsWith('    '));
  } else if (scenario === 'widths') {
    for (const cols of [20, 40, 78, 120]) {
      const size = await lease.resize(cols, 24);
      assert.equal(size.appliedCols, cols);
      // /debug 自身在当前宽度渲染，宽度事实来自官方帧而非历史ANSI拼接。
      const frame = await debug(`width-${cols}`);
      assert.ok(frame.includes(`Terminal: ${cols}x24`));
      for (const line of renderedLines(frame)) assert.ok(line.width <= cols, `官方渲染行超宽：${line.width}>${cols}`);
    }
  } else if (scenario === 'heights') {
    for (const action of ['stale', 'unavailable']) {
      await command(action);
      const statusFrame = stripVTControlCharacters(await debug(action));
      assert.match(statusFrame, action === 'stale' ? /过期观察/ : /暂不可用/);
    }
    await command('overflow');
    for (const rows of [4, 10, 24]) {
      const size = await lease.resize(78, rows);
      assert.equal(size.appliedRows, rows);
      const frame = await debug(`height-${rows}`);
      assert.ok(frame.includes(`Terminal: 78x${rows}`));
      for (const line of renderedLines(frame)) assert.ok(line.width <= 78);
    }
  } else if (scenario === 'draft') {
    await command('probe');
    const detail = waitProbe(root, (entry) => entry.event === 'detail');
    await lease.write('\x1bo');
    await detail;
    for (const kind of ['bash_async', 'scheduler']) {
      const nextDetail = waitProbe(root, (entry) => entry.event === 'detail' && entry.key === `fixture:${kind}:0`);
      await lease.write('\x1b[C');
      await nextDetail;
    }
    await lease.write('\x1b[D\x1b[27u');
    const draft = waitProbe(root, (entry) => entry.event === 'draft');
    await lease.write('\x1bp');
    assert.equal((await draft).draft, 'fixture 草稿保留');
  } else if (scenario === 'themes') {
    for (const theme of ['light', 'dark']) await command(theme);
    await lease.write('\x1bo');
    await waitProbe(root, (entry) => entry.event === 'detail');
    await lease.write('\x1b[27u');
    await debug('themes');
  } else if (scenario === 'lifecycle') {
    await lease.write('fixture seed\r');
    await lease.waitForText('deterministic', 20_000);
    await command('new');
    await command('switch');
    await command('fork');
    const prior = (await readFile(join(root, 'probe.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter((entry) => entry.event === 'start').length;
    await lease.write('/fixture-bg reload\r');
    // 新模块 epoch 从1开始，用文件中的start计数而不是假设跨reload共享闭包。
    await new Promise((resolve, reject) => {
      const watcher = watch(root, async () => {
        const entries = (await readFile(join(root, 'probe.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        if (entries.filter((entry) => entry.event === 'start').length > prior) { clearTimeout(timer); watcher.close(); resolve(); }
      });
      const timer = setTimeout(() => { watcher.close(); reject(new Error('reload无新start')); }, 20_000);
    });
  }
});
