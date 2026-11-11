import { aoneConfigReadonly } from './aone-config-readonly.ts';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { fault, validateCommand, validateSafeResult, type Command, type LocatorSpec, type SafeResult, type Session } from './contracts.ts';

const tabs = new WeakMap<Session, Map<string, Page>>();
function locator(page: Page, spec: LocatorSpec): Locator {
  if (spec.kind === 'role') return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], { name: spec.name, exact: spec.exact ?? true });
  return spec.kind === 'testId' ? page.getByTestId(spec.value) : page.locator(spec.value);
}
async function strict(page: Page, spec: LocatorSpec): Promise<Locator> {
  const l = locator(page, spec); if (await l.count() !== 1) fault('operation', 'locator-not-unique'); return l;
}
function publicUrl(raw: string): string {
  if (raw === 'about:blank') return raw;
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) ? u.origin + u.pathname : 'unsupported-origin'; }
  catch { return 'unsupported-origin'; }
}
export async function executeOperation(session: Session, command: Command): Promise<SafeResult> {
  validateCommand(command);
  if (session.authMode && !['navigate', 'auth-check'].includes(command.op)
    && !(command.op === 'aone-config-readonly' && command.action === 'verify')) fault('auth', 'auth-mode-restricted');
  let result: SafeResult = { kind: 'status', value: 'ok' };
  const { page } = session;
  switch (command.op) {
    case 'aone-config-readonly': result = await aoneConfigReadonly(session, command); break;
    case 'navigate': await page.goto(command.url); break;
    case 'snapshot': result = { kind: 'snapshot', value: await page.locator('body').ariaSnapshot(), maxLength: 65536 }; break;
    case 'click': await (await strict(page, command.locator)).click(); break;
    case 'fill': {
      const target = await strict(page, command.locator);
      // 固定检查，不接收页面代码，也不读取输入值。
      if (await target.getAttribute('type') === 'password') fault('auth', 'password-entry-forbidden');
      await target.fill(command.value); break;
    }
    case 'wait': await locator(page, command.locator).waitFor({ state: command.state }); break;
    case 'inspect':
      if (command.query === 'title') result = { kind: 'text', value: await page.title(), maxLength: 4096 };
      else if (command.query === 'count') result = { kind: 'count', value: await locator(page, command.locator!).count() };
      else result = { kind: 'boolean', value: await (await strict(page, command.locator!)).isVisible() };
      break;
    case 'auth-check': {
      const same = new URL(page.url()).origin === command.origin;
      result = { kind: 'auth-check', onExpectedOrigin: same, authenticatedView: same && await locator(page, command.authenticatedView).count() === 1 && await locator(page, command.authenticatedView).isVisible() }; break;
    }
    case 'screenshot': {
      await mkdir(session.artifactRoot, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const s = await lstat(session.artifactRoot);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) fault('artifact', 'unsafe-artifact-root');
      const file = await open(join(session.artifactRoot, command.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => fault('artifact', 'artifact-exists-or-unsafe'));
      try { const bytes = await page.screenshot({ type: 'png' }); await file.writeFile(bytes); result = { kind: 'artifact', name: command.name, bytes: bytes.length }; }
      finally { await file.close(); }
      break;
    }
    case 'tabs': {
      const map = tabs.get(session) ?? new Map<string, Page>(); tabs.set(session, map);
      for (const p of session.context.pages()) if (!Array.from(map.values()).includes(p)) map.set(crypto.randomUUID(), p);
      for (const [id, p] of map) if (p.isClosed()) map.delete(id);
      if (command.action === 'new') { const p = await session.context.newPage(); session.page = p; map.set(crypto.randomUUID(), p); }
      if (command.action === 'select' || command.action === 'close') {
        const p = map.get(command.tabId!); if (!p) fault('operation', 'unknown-tab');
        if (command.action === 'select') session.page = p;
        else { if (map.size === 1) fault('operation', 'last-tab'); await p.close(); map.delete(command.tabId!); if (session.page === p) session.page = map.values().next().value!; }
      }
      const list = []; for (const [tabId, p] of map) list.push({ tabId, url: publicUrl(p.url()), title: await p.title() });
      result = { kind: 'tabs', tabs: list }; break;
    }
  }
  validateSafeResult(result); return result;
}
