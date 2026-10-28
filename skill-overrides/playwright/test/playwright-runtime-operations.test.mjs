import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, lstat, symlink, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { AONE_MANAGEMENT_TOP, AONE_SCHEMA_FRAME } from '../src/aone-config-readonly.ts';
import { safeError, AONE_EXPORT_MAX_BYTES } from '../src/contracts.ts';
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

// 全部节点、下载与异常均为内存合成数据，不启动浏览器或读取认证状态。
function aoneFixture(artifactRoot, config = {}) {
  const emitter = new EventEmitter(), checked = [false, true, true, true], actions = [], downloads = [];
  const labels = ['daily(日常环境)', 'prepub(预发环境)', 'publish(正式环境)', 'project()'];
  const boxes = labels.map((_, index) => ({ kind: 'box', index }));
  const body = { kind: 'body' }, dialog = { kind: 'dialog' };
  let opened = !!config.preexistingDialog;
  function collection(nodes) {
    return {
      count: async () => nodes.length,
      nth: index => collection([nodes[index]]),
      filter: ({ visible }) => { assert.equal(visible, true); return collection(nodes); },
      waitFor: async ({ state, timeout }) => { assert.equal(state, 'visible'); assert.equal(timeout, 5000); if (nodes.length !== 1) throw Error('synthetic-secret'); },
      and: other => collection(nodes.filter(n => other.nodes.includes(n))), nodes,
      isVisible: async () => !config.hidden && nodes.length === 1,
      isEnabled: async () => !config.disabled,
      locator: selector => {
        if (selector === 'textarea') return collection(config.textarea ? [{ kind: 'textarea' }] : []);
        if (selector === 'input[type="checkbox"]') return collection(config.fiveBoxes ? [...boxes, {}] : boxes);
        throw Error('合成测试出现未知selector');
      },
      getByRole: (_role, { name, exact }) => {
        assert.equal(exact, true);
        const allowed = nodes[0] === body ? ['导入', '导出'] : ['确定', '取消'];
        if (!allowed.includes(name)) return collection([]);
        const count = config.controlName === name ? config.controlCount : 1;
        return collection(Array.from({ length: count }, () => ({ kind: 'button', name })));
      },
      getByLabel: (label, { exact }) => {
        assert.equal(exact, true);
        if (config.missingLabel && label === labels[0]) return collection([]);
        if (config.multipleLabels && label === labels[0]) return collection([boxes[0], boxes[1]]);
        const index = config.aliasedLabels ? 0 : labels.indexOf(label);
        return collection([boxes[index]]);
      },
      isChecked: async () => checked[nodes[0].index],
      setChecked: async value => { actions.push('checkbox'); if (!config.stuckCheckbox) checked[nodes[0].index] = value; },
      click: async () => {
        const name = nodes[0].name; actions.push(name);
        if (config.clickError) throw Error('synthetic-secret https://bad.invalid/?token=secret');
        if (name === '导出') { opened = true; if (config.earlyDownload) emitDownload(); }
        else if (name === '确定') {
          for (let i = 0; i < (config.downloadCount ?? 1); i++) emitDownload();
          if (config.redirect) main.url = () => 'https://bad.invalid/?token=synthetic-secret';
        } else assert.fail('只允许固定导出流程');
      },
    };
  }
  function emitDownload() {
    const download = {
      cancelled: false, deleted: false,
      async createReadStream() {
        if (config.streamError) throw Error('synthetic-secret');
        if (config.emptyStream) return null;
        return Readable.from(config.chunks ?? [Buffer.from(config.text ?? 'KEY=synthetic-value\n')]);
      },
      async failure() { return config.downloadFailure ? 'synthetic-secret' : null; },
      async cancel() { this.cancelled = true; if (config.cancelError) throw Error('synthetic-secret'); },
      async delete() { this.deleted = true; if (config.cleanupError) throw Error('synthetic-secret'); if (config.extraDuringDelete && downloads.length === 1) emitDownload(); },
    };
    downloads.push(download); emitter.emit('download', download);
  }
  const main = {
    url: () => config.top ?? AONE_MANAGEMENT_TOP, parentFrame: () => null,
    locator: selector => {
      if (config.locatorError) throw Error('synthetic-secret');
      if (selector === 'body') return collection([body]);
      return collection(opened ? (config.twoDialogs ? [dialog, {}] : [dialog]) : []);
    },
  };
  const child = {
    ...main, url: () => config.schema ?? AONE_SCHEMA_FRAME, parentFrame: () => config.detachedParent ? null : main,
    frameElement: async () => {
      if (config.frameElementError) throw Error('synthetic-secret');
      return { isVisible: async () => !config.hiddenFrame, dispose: async () => {} };
    },
  };
  const frames = config.mainOnly ? [main] : [main, child];
  if (config.extraFrame) frames.push({ ...child });
  const page = Object.assign(emitter, { mainFrame: () => main, frames: () => frames });
  return { session: fakeSession({ page, artifactRoot, authMode: !!config.authMode }), checked, actions, downloads, page };
}
const verifyAone = { op: 'aone-config-readonly', action: 'verify' };
const exportAone = environment => ({ op: 'aone-config-readonly', action: 'export', environment });
async function aoneReject(fixture, command, code) {
  await assert.rejects(executeOperation(fixture.session, command), error => {
    assert.deepEqual(safeError(error), { stage: code === 'auth-mode-restricted' ? 'auth' : 'aone-config-readonly', code });
    assert.ok(!JSON.stringify(safeError(error)).includes('synthetic-secret'));
    return true;
  });
  assert.equal(fixture.page.listenerCount('download'), 0);
}

test('Aone verify只检查固定management，auth模式禁止export', async () => {
  for (const mainOnly of [false, true]) {
    const fixture = aoneFixture('', { mainOnly, authMode: true });
    assert.deepEqual(await executeOperation(fixture.session, verifyAone), { kind: 'status', value: 'ok' });
    assert.deepEqual(fixture.actions, []);
    await aoneReject(fixture, exportAone('daily'), 'auth-mode-restricted');
  }
});

test('Aone top/frame/management控件歧义与异常固定失败', async t => {
  for (const [config, code] of [
    [{ top: 'https://bad.invalid/?secret=x' }, 'management-top-unverified'],
    [{ top: AONE_MANAGEMENT_TOP + '/other' }, 'management-top-unverified'],
    [{ top: AONE_MANAGEMENT_TOP.replace('332260', '1') }, 'management-top-unverified'],
    [{ extraFrame: true }, 'management-frame-unverified'],
    [{ detachedParent: true }, 'management-frame-unverified'],
    [{ hiddenFrame: true }, 'management-frame-unverified'],
    [{ frameElementError: true }, 'management-frame-unverified'],
    [{ schema: AONE_SCHEMA_FRAME + '/other' }, 'management-frame-unverified'],
    [{ schema: 'https://bad.invalid/' }, 'management-frame-unverified'],
    [{ controlName: '导出', controlCount: 2 }, 'management-controls-unverified'],
    [{ controlName: '导入', controlCount: 0 }, 'management-controls-unverified'],
    [{ hidden: true }, 'management-controls-unverified'],
    [{ disabled: true }, 'management-controls-unverified'],
    [{ locatorError: true }, 'management-controls-unverified'],
  ]) await t.test(JSON.stringify(config), async () => aoneReject(aoneFixture('', config), verifyAone, code));
  assert.deepEqual(await executeOperation(aoneFixture('', { top: AONE_MANAGEMENT_TOP + '?opaque=synthetic-secret#tab' }).session, verifyAone), { kind: 'status', value: 'ok' });
});

test('Aone export只选一个环境，流写0600私有artifact且不覆盖', async t => {
  const box = await sandbox();
  try {
    for (const [i, environment] of ['daily', 'prepub', 'publish'].entries()) await t.test(environment, async () => {
      const root = join(box.root, environment); await mkdir(root, { mode: 0o700 });
      const fixture = aoneFixture(root);
      const result = await executeOperation(fixture.session, exportAone(environment));
      assert.deepEqual(result, { kind: 'aone-config-artifact', name: `aone-config-${environment}.env`, bytes: 20 });
      assert.deepEqual(fixture.checked, [0, 1, 2, 3].map(n => n === i));
      assert.deepEqual(fixture.actions.filter(a => a !== 'checkbox'), ['导出', '确定']);
      assert.ok(fixture.downloads.every(d => d.deleted && d.cancelled));
      assert.equal(fixture.page.listenerCount('download'), 0);
      const path = join(root, result.name);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, 'utf8'), 'KEY=synthetic-value\n');
      await aoneReject(aoneFixture(root), exportAone(environment), 'artifact-exists-or-unsafe');
      assert.equal(await readFile(path, 'utf8'), 'KEY=synthetic-value\n');
    });
  } finally { await box.clean(); }
});

test('Aone dialog/checkbox/download与异常均fail closed并清理', async t => {
  const box = await sandbox();
  try {
    for (const [i, [config, code]] of [
      [{ preexistingDialog: true }, 'export-dialog-unverified'],
      [{ twoDialogs: true }, 'export-dialog-unverified'],
      [{ fiveBoxes: true }, 'export-dialog-unverified'],
      [{ textarea: true }, 'export-dialog-unverified'],
      [{ controlName: '确定', controlCount: 2 }, 'export-dialog-unverified'],
      [{ controlName: '取消', controlCount: 0 }, 'export-dialog-unverified'],
      [{ missingLabel: true }, 'environment-selection-unverified'],
      [{ multipleLabels: true }, 'environment-selection-unverified'],
      [{ aliasedLabels: true }, 'environment-selection-unverified'],
      [{ stuckCheckbox: true }, 'environment-selection-unverified'],
      [{ downloadCount: 2 }, 'export-download-unconfirmed'],
      [{ earlyDownload: true }, 'export-download-unconfirmed'],
      [{ downloadCount: 0 }, 'export-download-unconfirmed'],
      [{ downloadFailure: true }, 'export-download-unconfirmed'],
      [{ emptyStream: true }, 'export-download-unconfirmed'],
      [{ streamError: true }, 'export-download-unconfirmed'],
      [{ clickError: true }, 'export-dialog-unverified'],
      [{ redirect: true }, 'management-top-unverified'],
      [{ extraDuringDelete: true }, 'export-download-unconfirmed'],
    ].entries()) await t.test(JSON.stringify(config), async () => {
      const root = join(box.root, `case-${i}`); await mkdir(root, { mode: 0o700 });
      const fixture = aoneFixture(root, config);
      await aoneReject(fixture, exportAone('daily'), code);
      assert.deepEqual(await readdir(root), []);
      assert.ok(fixture.downloads.every(d => d.deleted && d.cancelled));
    });
  } finally { await box.clean(); }
});

test('Aone大小边界、格式和masked内容不回显，失败不留artifact', async t => {
  const box = await sandbox();
  try {
    const max = Buffer.from('KEY=' + 'x'.repeat(AONE_EXPORT_MAX_BYTES - 4));
    for (const [i, [config, code]] of [
      [{ chunks: [max] }, null],
      [{ chunks: [max, Buffer.from('x')] }, 'export-too-large'],
      [{ text: '' }, 'export-download-unconfirmed'],
      [{ chunks: [Buffer.from([0xff])] }, 'export-format-invalid'],
      ...['A=x\r\n', 'A=x\0', 'A=x\nA=y', 'wrong key=x', 'A=x\\', 'no-equals', '\uFEFFA=x'].map(text => [{ text }, 'export-format-invalid']),
      ...['KeyCenter', '掉码', 'MASKED', 'redacted', 'hidden', '***'].map(value => [{ text: `KEY=${value}` }, 'export-masked-unverifiable']),
    ].entries()) await t.test(`内容边界-${i}`, async () => {
      const root = join(box.root, `case-${i}`); await mkdir(root, { mode: 0o700 });
      const fixture = aoneFixture(root, config);
      if (code) { await aoneReject(fixture, exportAone('daily'), code); assert.deepEqual(await readdir(root), []); }
      else assert.equal((await executeOperation(fixture.session, exportAone('daily'))).bytes, AONE_EXPORT_MAX_BYTES);
      assert.ok(fixture.downloads.every(d => d.deleted && d.cancelled));
    });
  } finally { await box.clean(); }
});

test('Aone清理失败固定错误并删除本次artifact，禁用后续Aone操作', async () => {
  const box = await sandbox();
  try {
    for (const flag of ['cleanupError', 'cancelError']) {
      const root = join(box.root, flag); await mkdir(root, { mode: 0o700 });
      const fixture = aoneFixture(root, { [flag]: true });
      await aoneReject(fixture, exportAone('daily'), 'export-cleanup-failed');
      assert.deepEqual(await readdir(root), []);
      await aoneReject(fixture, verifyAone, 'export-cleanup-failed');
      assert.ok(fixture.downloads.every(d => d.deleted && d.cancelled));
    }
  } finally { await box.clean(); }
});

test('Aone拒绝不安全root和symlink目标，不改动已有文件', async () => {
  const box = await sandbox();
  try {
    const root = join(box.root, 'artifact'); await mkdir(root, { mode: 0o700 });
    const linked = join(box.root, 'linked'); await symlink(root, linked);
    await aoneReject(aoneFixture(linked), exportAone('daily'), 'unsafe-artifact-root');
    await chmod(root, 0o755);
    await aoneReject(aoneFixture(root), exportAone('daily'), 'unsafe-artifact-root');
    await chmod(root, 0o700);
    const original = join(box.root, 'original'); await writeFile(original, 'synthetic-unchanged');
    await symlink(original, join(root, 'aone-config-daily.env'));
    await aoneReject(aoneFixture(root), exportAone('daily'), 'artifact-exists-or-unsafe');
    assert.equal(await readFile(original, 'utf8'), 'synthetic-unchanged');
  } finally { await box.clean(); }
});
