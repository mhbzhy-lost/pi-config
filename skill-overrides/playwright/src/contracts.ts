import type { BrowserContext, Page } from 'playwright';

export const MAX_WIRE_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const CLOSE_TIMEOUT_MS = 10_000;
export type RuntimeScope = { stateRoot: string; profileRoot: string; artifactRoot: string };
export type RuntimeOptions = {
  instance: string; profile?: string; headless: boolean; channel: 'chrome';
  authMode: boolean; startupTimeoutMs: number; idleTimeoutMs: number;
};
export type RuntimeRef = { scope: RuntimeScope; instance: string };
export type ReadyState = {
  instance: string; daemonPid: number; browserReady: boolean; pageReady: boolean;
  headless: boolean; channel: 'chrome'; authMode: boolean; browserVersion: string;
};
export type LocatorSpec =
  | { kind: 'role'; role: string; name: string; exact?: boolean }
  | { kind: 'testId'; value: string }
  | { kind: 'css'; value: string };
export type AoneEnvironment = 'daily' | 'prepub' | 'publish';
export type AoneConfigCommand = { op: 'aone-config-readonly'; action: 'verify' }
  | { op: 'aone-config-readonly'; action: 'export'; environment: AoneEnvironment };
export const AONE_EXPORT_MAX_BYTES = 1024 * 1024;
export type AoneArtifactName = `aone-config-${AoneEnvironment}.env`;
export type Command =
  | AoneConfigCommand
  | { op: 'navigate'; url: string }
  | { op: 'snapshot' }
  | { op: 'click'; locator: LocatorSpec }
  | { op: 'fill'; locator: LocatorSpec; value: string }
  | { op: 'wait'; locator: LocatorSpec; state: 'visible' | 'hidden' }
  | { op: 'screenshot'; name: string }
  | { op: 'tabs'; action: 'list' | 'new' | 'select' | 'close'; tabId?: string }
  | { op: 'inspect'; query: 'title' | 'count' | 'visible'; locator?: LocatorSpec }
  | { op: 'auth-check'; origin: string; authenticatedView: LocatorSpec };
export type SafeResult =
  | { kind: 'status'; value: 'ok' }
  | { kind: 'count'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string; maxLength: 4096 }
  | { kind: 'snapshot'; value: string; maxLength: 65536 }
  | { kind: 'tabs'; tabs: Array<{ tabId: string; url: string; title: string }> }
  | { kind: 'artifact'; name: string; bytes: number }
  | { kind: 'aone-config-artifact'; name: AoneArtifactName; bytes: number }
  | { kind: 'auth-check'; onExpectedOrigin: boolean; authenticatedView: boolean };
export type Session = {
  page: Page; context: BrowserContext; authMode: boolean; artifactRoot: string;
  smoke(): Promise<{ version: string }>; close(): Promise<void>;
};
export type BrowserAdapter = { launch(options: RuntimeOptions, profile: string, artifactRoot: string): Promise<Session> };
export type OperationDispatcher = (session: Session, command: Command) => Promise<SafeResult>;
export type WireRequest = { v: 1; id: string; nonce: string; command: Command | { op: '_status' | '_stop' } };
export type WireReply = { v: 1; id: string; ok: true; result: SafeResult | ReadyState | { stopped: boolean } }
  | { v: 1; id: string; ok: false; error: { stage: string; code: string } };

export class RuntimeFault extends Error {
  stage: string; code: string;
  constructor(stage: string, code: string) { super(code); this.stage = stage; this.code = code; }
}
export function fault(stage: string, code: string): never { throw new RuntimeFault(stage, code); }
export function safeError(error: unknown, stage = 'operation'): { stage: string; code: string } {
  return error instanceof RuntimeFault ? { stage: error.stage, code: error.code } : { stage, code: 'operation-failed' };
}
export function safeName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,32}$/.test(value)) fault('config', 'invalid-name');
}
export function validateOptions(o: RuntimeOptions): void {
  safeName(o.instance); if (o.profile !== undefined) safeName(o.profile);
  if (o.channel !== 'chrome' || typeof o.headless !== 'boolean' || typeof o.authMode !== 'boolean') fault('config', 'invalid-options');
  for (const n of [o.startupTimeoutMs, o.idleTimeoutMs]) if (!Number.isFinite(n) || n <= 0) fault('config', 'invalid-timeout');
}
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function keys(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) fault('protocol', 'invalid-command');
}
function str(v: unknown): v is string { return typeof v === 'string' && v.length > 0; }
export function validateLocator(v: unknown): asserts v is LocatorSpec {
  if (!record(v)) fault('protocol', 'invalid-locator');
  if (v.kind === 'role') {
    keys(v, ['kind', 'role', 'name', 'exact']);
    if (!str(v.role) || !str(v.name) || (v.exact !== undefined && typeof v.exact !== 'boolean')) fault('protocol', 'invalid-locator');
  } else if (v.kind === 'css' || v.kind === 'testId') { keys(v, ['kind', 'value']); if (!str(v.value)) fault('protocol', 'invalid-locator'); }
  else fault('protocol', 'invalid-locator');
}
export function validateUrl(v: unknown): asserts v is string {
  if (v === 'about:blank') return;
  try {
    if (!str(v)) fault('protocol', 'invalid-url');
    const u = new URL(v as string);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fault('protocol', 'invalid-url');
  } catch { fault('protocol', 'invalid-url'); }
}
export function validateCommand(v: unknown): asserts v is Command {
  if (!record(v) || !str(v.op)) fault('protocol', 'invalid-command');
  switch (v.op) {
    case 'aone-config-readonly':
      if (v.action === 'verify') keys(v, ['op', 'action']);
      else if (v.action === 'export') {
        keys(v, ['op', 'action', 'environment']);
        if (!['daily', 'prepub', 'publish'].includes(v.environment as string)) fault('protocol', 'invalid-command');
      } else fault('protocol', 'invalid-command');
      break;
    case 'navigate': keys(v, ['op', 'url']); validateUrl(v.url); break;
    case 'snapshot': keys(v, ['op']); break;
    case 'click': keys(v, ['op', 'locator']); validateLocator(v.locator); break;
    case 'fill': keys(v, ['op', 'locator', 'value']); validateLocator(v.locator); if (typeof v.value !== 'string') fault('protocol', 'invalid-command'); break;
    case 'wait': keys(v, ['op', 'locator', 'state']); validateLocator(v.locator); if (!['visible', 'hidden'].includes(v.state as string)) fault('protocol', 'invalid-command'); break;
    case 'screenshot': keys(v, ['op', 'name']); if (typeof v.name !== 'string' || !/^[a-z0-9-]{1,64}\.png$/.test(v.name)) fault('artifact', 'invalid-artifact'); break;
    case 'tabs': keys(v, ['op', 'action', 'tabId']); if (!['list', 'new', 'select', 'close'].includes(v.action as string) || (['select', 'close'].includes(v.action as string) && !str(v.tabId))) fault('protocol', 'invalid-command'); break;
    case 'inspect': keys(v, ['op', 'query', 'locator']); if (!['title', 'count', 'visible'].includes(v.query as string)) fault('protocol', 'invalid-command'); if (v.query !== 'title') validateLocator(v.locator); break;
    case 'auth-check': {
      keys(v, ['op', 'origin', 'authenticatedView']); validateUrl(v.origin);
      if (new URL(v.origin as string).origin !== v.origin) fault('protocol', 'invalid-origin');
      validateLocator(v.authenticatedView); break;
    }
    default: fault('protocol', 'unknown-operation');
  }
}
export function validateSafeResult(v: unknown): asserts v is SafeResult {
  if (!record(v)) fault('protocol', 'invalid-result');
  switch (v.kind) {
    case 'status': keys(v, ['kind', 'value']); if (v.value !== 'ok') fault('protocol', 'invalid-result'); break;
    case 'count': keys(v, ['kind', 'value']); if (!Number.isSafeInteger(v.value) || (v.value as number) < 0) fault('protocol', 'invalid-result'); break;
    case 'boolean': keys(v, ['kind', 'value']); if (typeof v.value !== 'boolean') fault('protocol', 'invalid-result'); break;
    case 'text': case 'snapshot': {
      keys(v, ['kind', 'value', 'maxLength']); const limit = v.kind === 'text' ? 4096 : 65536;
      if (typeof v.value !== 'string' || v.maxLength !== limit) fault('protocol', 'invalid-result');
      if (Buffer.byteLength(v.value) > limit) fault('operation', 'result-too-large'); break;
    }
    case 'auth-check': keys(v, ['kind', 'onExpectedOrigin', 'authenticatedView']); if (typeof v.onExpectedOrigin !== 'boolean' || typeof v.authenticatedView !== 'boolean') fault('protocol', 'invalid-result'); break;
    case 'aone-config-artifact':
      keys(v, ['kind', 'name', 'bytes']);
      if (!['aone-config-daily.env', 'aone-config-prepub.env', 'aone-config-publish.env'].includes(v.name as string)
        || !Number.isSafeInteger(v.bytes) || (v.bytes as number) < 1 || (v.bytes as number) > AONE_EXPORT_MAX_BYTES) fault('protocol', 'invalid-result');
      break;
    case 'artifact': keys(v, ['kind', 'name', 'bytes']); if (!str(v.name) || !Number.isSafeInteger(v.bytes) || (v.bytes as number) < 0) fault('protocol', 'invalid-result'); break;
    case 'tabs':
      keys(v, ['kind', 'tabs']); if (!Array.isArray(v.tabs)) fault('protocol', 'invalid-result');
      for (const t of v.tabs) { if (!record(t)) fault('protocol', 'invalid-result'); keys(t, ['tabId', 'url', 'title']); if (!str(t.tabId) || typeof t.url !== 'string' || typeof t.title !== 'string') fault('protocol', 'invalid-result'); }
      break;
    default: fault('protocol', 'invalid-result');
  }
  if (Buffer.byteLength(JSON.stringify(v)) > MAX_WIRE_BYTES) fault('protocol', 'result-too-large');
}
export async function bounded<T>(work: Promise<T>, ms: number, stage: string, code: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RuntimeFault(stage, code)), ms); })]); }
  finally { clearTimeout(timer!); }
}
