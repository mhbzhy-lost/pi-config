import { constants } from 'node:fs';
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Download, Frame, Locator, Page } from 'playwright';
import {
  AONE_EXPORT_MAX_BYTES, RuntimeFault, bounded, fault,
  type AoneArtifactName, type AoneConfigCommand, type SafeResult, type Session,
} from './contracts.ts';

export const AONE_MANAGEMENT_TOP = 'https://cd.aone.alibaba-inc.com/unite/micro/app/332260/configitem';
export const AONE_SCHEMA_FRAME = 'https://cd.aone.alibaba-inc.com/ec/app/332260/configItem/schema';
const STAGE = 'aone-config-readonly';
const UI_TIMEOUT = 1000;
const DIALOG_TIMEOUT = 5000;
const DOWNLOAD_TIMEOUT = 5000;
const DIALOGS = '[role="dialog"],.ant-modal,.next-dialog,.matter-dialog';
const ENVIRONMENT_LABELS = {
  daily: 'daily(日常环境)', prepub: 'prepub(预发环境)', publish: 'publish(正式环境)', project: 'project()',
} as const;
const unusable = new WeakSet<Session>();
function fail(code: string): never { fault(STAGE, code); }
function canonical(raw: string): string {
  try { const u = new URL(raw); return u.username || u.password ? '' : u.origin + u.pathname; }
  catch { return ''; }
}
function managementFrame(page: Page): Frame {
  const main = page.mainFrame(), frames = page.frames();
  if (canonical(main.url()) !== AONE_MANAGEMENT_TOP) fail('management-top-unverified');
  if (frames.filter(f => f === main).length !== 1) fail('management-frame-unverified');
  const children = frames.filter(f => f !== main);
  if (children.length === 0) return main;
  if (children.length !== 1 || children[0].parentFrame() !== main || canonical(children[0].url()) !== AONE_SCHEMA_FRAME) fail('management-frame-unverified');
  return children[0];
}
async function control(target: Locator, code: string): Promise<Locator> {
  if (await target.count() !== 1 || !await target.isVisible() || !await target.isEnabled({ timeout: UI_TIMEOUT })) fail(code);
  return target;
}
async function managementControls(frame: Frame): Promise<Locator> {
  if (frame.parentFrame()) {
    try {
      const element = await frame.frameElement();
      try { if (!await element.isVisible()) fail('management-frame-unverified'); }
      finally { await element.dispose(); }
    } catch { fail('management-frame-unverified'); }
  }
  const root = frame.locator('body');
  if (await root.count() !== 1 || !await root.isVisible()) fail('management-controls-unverified');
  await control(root.getByRole('button', { name: '导入', exact: true }), 'management-controls-unverified');
  return control(root.getByRole('button', { name: '导出', exact: true }), 'management-controls-unverified');
}
async function visibleDialogs(frame: Frame): Promise<Locator[]> {
  const dialogs = frame.locator(DIALOGS), visible: Locator[] = [];
  const count = await dialogs.count();
  if (count > 16) fail('export-dialog-unverified');
  for (let i = 0; i < count; i++) if (await dialogs.nth(i).isVisible()) visible.push(dialogs.nth(i));
  return visible;
}
async function exportDialog(frame: Frame): Promise<Locator> {
  const dialogs = await visibleDialogs(frame);
  if (dialogs.length !== 1) fail('export-dialog-unverified');
  const root = dialogs[0];
  if (await root.locator('input[type="checkbox"]').count() !== 4 || await root.locator('textarea').count() !== 0) fail('export-dialog-unverified');
  await control(root.getByRole('button', { name: '确定', exact: true }), 'export-dialog-unverified');
  await control(root.getByRole('button', { name: '取消', exact: true }), 'export-dialog-unverified');
  return root;
}
async function selectEnvironment(root: Locator, environment: string): Promise<void> {
  const boxes = root.locator('input[type="checkbox"]'), selected: Locator[] = [];
  // 标签关联由 SDK 完成；总数和交集检查防止同一 checkbox 伪装多个环境。
  for (const [name, label] of Object.entries(ENVIRONMENT_LABELS)) {
    const box = root.getByLabel(label, { exact: true });
    await control(box, 'environment-selection-unverified');
    if (await boxes.and(box).count() !== 1) fail('environment-selection-unverified');
    for (const previous of selected) if (await previous.and(box).count() !== 0) fail('environment-selection-unverified');
    selected.push(box);
    await box.setChecked(name === environment, { timeout: UI_TIMEOUT });
  }
  for (const [i, name] of Object.keys(ENVIRONMENT_LABELS).entries()) {
    if (await selected[i].isChecked({ timeout: UI_TIMEOUT }) !== (name === environment)) fail('environment-selection-unverified');
  }
}
async function privateRoot(root: string): Promise<void> {
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) fail('unsafe-artifact-root');
  const s = await lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) fail('unsafe-artifact-root');
}
function validateExport(bytes: Buffer): void {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('export-format-invalid'); }
  if (text.includes('\r') || text.includes('\0')) fail('export-format-invalid');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('='), key = line.slice(0, split), value = line.slice(split + 1);
    if (split < 0 || line.endsWith('\\') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || keys.has(key)) fail('export-format-invalid');
    if (/KeyCenter|掉码|masked|redacted|hidden|\*{3,}/i.test(value)) fail('export-masked-unverifiable');
    keys.add(key);
  }
}
async function readDownload(download: Download): Promise<Buffer> {
  let stream: Awaited<ReturnType<Download['createReadStream']>>, finished = false;
  try {
    return await bounded((async () => {
      stream = await download.createReadStream();
      if (finished) { stream?.destroy(); fail('export-download-unconfirmed'); }
      if (!stream) fail('export-download-unconfirmed');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) {
        const b = Buffer.from(chunk); size += b.length;
        if (size > AONE_EXPORT_MAX_BYTES) fail('export-too-large');
        chunks.push(b);
      }
      if (!size || await download.failure() !== null) fail('export-download-unconfirmed');
      return Buffer.concat(chunks, size);
    })(), DOWNLOAD_TIMEOUT, STAGE, 'export-download-unconfirmed');
  } finally { finished = true; stream?.destroy(); }
}

/** 固定只读业务操作；不接受 URL、locator、脚本或写配置动作。 */
export async function aoneConfigReadonly(session: Session, command: AoneConfigCommand): Promise<SafeResult> {
  if (unusable.has(session)) fail('export-cleanup-failed');
  const { page } = session;
  let code = 'management-controls-unverified';
  let file: FileHandle | undefined, created = false, identity: { ino: number; dev: number } | undefined;
  let path = '', keep = false, listening = false;
  const downloads: Download[] = [];
  const downloadCount = () => downloads.length;
  let notify: (() => void) | undefined;
  const capture = (download: Download) => { downloads.push(download); notify?.(); };
  try {
    const frame = managementFrame(page), button = await managementControls(frame);
    if (command.action === 'verify') {
      if (managementFrame(page) !== frame) fail('management-frame-unverified');
      return { kind: 'status', value: 'ok' };
    }
    const name: AoneArtifactName = `aone-config-${command.environment}.env`;
    code = 'unsafe-artifact-root'; await privateRoot(session.artifactRoot);
    path = join(session.artifactRoot, name);
    // 下载监听覆盖整个导出流程；确认按钮以外触发的下载也判为失败。
    page.on('download', capture); listening = true;
    code = 'export-dialog-unverified';
    if ((await visibleDialogs(frame)).length !== 0) fail(code);
    if (managementFrame(page) !== frame) fail('management-frame-unverified');
    await button.click({ timeout: UI_TIMEOUT });
    await frame.locator(DIALOGS).filter({ visible: true }).waitFor({ state: 'visible', timeout: DIALOG_TIMEOUT });
    const root = await exportDialog(frame);
    code = 'environment-selection-unverified'; await selectEnvironment(root, command.environment);
    if (managementFrame(page) !== frame) fail('management-frame-unverified');
    code = 'export-dialog-unverified';
    await exportDialog(frame);
    if (downloadCount() !== 0) fail('export-download-unconfirmed');
    code = 'export-download-unconfirmed';
    const arrived = new Promise<void>(done => { notify = done; });
    await root.getByRole('button', { name: '确定', exact: true }).click({ timeout: UI_TIMEOUT });
    await bounded(arrived, DOWNLOAD_TIMEOUT, STAGE, code);
    if (downloadCount() !== 1) fail(code);
    const bytes = await readDownload(downloads[0]);
    await delay(200);
    if (downloadCount() !== 1) fail(code);
    if (managementFrame(page) !== frame) fail('management-frame-unverified');
    validateExport(bytes);
    code = 'unsafe-artifact-root'; await privateRoot(session.artifactRoot);
    code = 'artifact-exists-or-unsafe';
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true; identity = await file.stat();
    code = 'export-file-invalid'; await file.writeFile(bytes);
    const saved = await file.stat();
    if (!saved.isFile() || saved.uid !== process.getuid?.() || (saved.mode & 0o777) !== 0o600 || saved.nlink !== 1 || saved.size !== bytes.length) fail(code);
    await file.close(); file = undefined;
    const final = await lstat(path);
    if (!final.isFile() || final.isSymbolicLink() || final.ino !== identity.ino || final.dev !== identity.dev || final.uid !== process.getuid?.() || final.nlink !== 1 || final.size !== bytes.length || (final.mode & 0o777) !== 0o600) fail(code);
    keep = true;
    return { kind: 'aone-config-artifact', name, bytes: bytes.length };
  } catch (error) {
    if (error instanceof RuntimeFault && error.stage === STAGE) throw error;
    fail(code);
  } finally {
    let cleanupFailed = false;
    // 监听一直保留到下载删除完成；失败不保留本次 artifact，也不删除预先存在的文件。
    for (let i = 0; i < downloads.length; i++) {
      for (const action of ['cancel', 'delete'] as const) {
        try { await bounded(downloads[i][action](), 1000, STAGE, 'export-cleanup-failed'); }
        catch { cleanupFailed = true; }
      }
      if (i >= 15) { cleanupFailed = true; break; }
    }
    if (listening) page.off('download', capture);
    if (downloads.length > 1) keep = false;
    try { await file?.close(); } catch { cleanupFailed = true; }
    if (created && (!keep || cleanupFailed)) {
      try {
        const saved = await lstat(path);
        if (!identity || saved.ino !== identity.ino || saved.dev !== identity.dev) throw new Error();
        await unlink(path);
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) { unusable.add(session); fail('export-cleanup-failed'); }
    if (downloads.length > 1) fail('export-download-unconfirmed');
  }
}
