import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ForkSource, LaunchReservation } from "./registry.ts";

export type LaunchIntent =
  | { kind: "new"; continueArgIndex: null }
  | { kind: "continue"; continueArgIndex: number }
  | { kind: "resume"; continueArgIndex: null }
  | { kind: "session"; value: string; continueArgIndex: null }
  | { kind: "session-id"; value: string; continueArgIndex: null }
  | { kind: "fork"; value: string; continueArgIndex: null }
  | { kind: "ephemeral"; continueArgIndex: null }
  | { kind: "non-interactive"; continueArgIndex: null };

export type TtyFacts = Readonly<{ stdinTty: boolean; stdoutTty: boolean }>;
export type ResolvedSession = Readonly<{ id: string; cwd: string; path: string }>;
export type PiSessionManager = Readonly<{
  list(cwd: string, sessionDir?: string): Promise<readonly ResolvedSession[]>;
  listAll?(sessionDir?: string): Promise<readonly ResolvedSession[]>;
}>;
export type RecentResolution = { kind: "found"; session: ResolvedSession } | { kind: "absent" } | { kind: "unavailable" };
export type TargetResolution = { kind: "resolved"; reservation: LaunchReservation } | { kind: "absent" } | { kind: "unavailable" };
export type ResolveRecentSessionInput = Readonly<{
  argv: readonly string[]; cwd: string; env?: Readonly<Record<string, string | undefined>>;
  sessionManager?: PiSessionManager; piBinary?: string; packageRoot?: string; statMtime?: (path: string) => Promise<number> | number;
  readHeaderBytes?: (path: string, maximum: number) => Promise<Buffer> | Buffer;
}>;

export const MAX_SESSION_HEADER_BYTES = 16 * 1024;

export class LaunchIntentError extends Error {
  readonly code: "missing-value" | "conflicting-intents" | "unverifiable-cwd" | "unverifiable-path";
  constructor(code: "missing-value" | "conflicting-intents" | "unverifiable-cwd" | "unverifiable-path", message: string) { super(message); this.name = "LaunchIntentError"; this.code = code; }
}

const VALUE_OPTIONS = new Set(["-p", "--print", "-e", "--extension", "--skill", "--prompt-template", "--theme", "--provider", "--model", "--models", "--thinking", "--tools", "--exclude-tools", "--api-key", "--name", "--system-prompt", "--append-system-prompt", "--session-dir", "--session", "--session-id", "--fork", "--mode", "--export"]);
type Token = Readonly<{ index: number; value: string }>;

function consumedTokens(argv: readonly string[]): readonly Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--") break;
    tokens.push({ index, value });
    if (VALUE_OPTIONS.has(value)) index += 1;
  }
  return tokens;
}

function separatedValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new LaunchIntentError("missing-value", `${flag} requires a value`);
  return value;
}

export function classifyPiLaunch(argv: readonly string[], tty?: TtyFacts): LaunchIntent {
  const tokens = consumedTokens(argv);
  let guarded: LaunchIntent | undefined;
  let ephemeral = false;
  let print = false;
  let mode: string | undefined;
  for (const token of tokens) {
    const { value, index } = token;
    let next: LaunchIntent | undefined;
    if (value === "-c" || value === "--continue") next = { kind: "continue", continueArgIndex: index };
    else if (value === "-r" || value === "--resume") next = { kind: "resume", continueArgIndex: null };
    else if (value === "--session") next = { kind: "session", value: separatedValue(argv, index, value), continueArgIndex: null };
    else if (value === "--session-id") next = { kind: "session-id", value: separatedValue(argv, index, value), continueArgIndex: null };
    else if (value === "--fork") next = { kind: "fork", value: separatedValue(argv, index, value), continueArgIndex: null };
    else if (value === "--no-session") ephemeral = true;
    else if (value === "-p" || value === "--print") print = true;
    else if (value === "--mode") mode = separatedValue(argv, index, value);
    if (next) {
      if (guarded) throw new LaunchIntentError("conflicting-intents", "multiple session startup intents are not supported");
      guarded = next;
    }
  }
  const nonInteractive = print || mode === "json" || mode === "rpc";
  if (guarded && ephemeral) throw new LaunchIntentError("conflicting-intents", "session reuse cannot be combined with ephemeral startup");
  if (ephemeral) return { kind: "ephemeral", continueArgIndex: null };
  // resume 始终需要 Pi 的交互式选择器，即使同时出现看似非交互的参数。
  if (guarded?.kind === "resume") return guarded;
  if (nonInteractive || (tty !== undefined && (!tty.stdinTty || !tty.stdoutTty))) return { kind: "non-interactive", continueArgIndex: null };
  return guarded ?? { kind: "new", continueArgIndex: null };
}

export function canonicalizeCwd(cwd: string): string { try { return realpathSync.native(cwd); } catch { throw new LaunchIntentError("unverifiable-cwd", `cannot verify cwd: ${cwd}`); } }
export function normalizeSessionPath(path: string, cwd: string): string {
  const resolved = resolve(cwd, path);
  try { return realpathSync.native(resolved); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved; throw new LaunchIntentError("unverifiable-path", `cannot verify session path: ${path}`); }
}

function sessionDirFromArgv(argv: readonly string[]): string | undefined {
  let sessionDir: string | undefined;
  for (const { index, value } of consumedTokens(argv)) if (value === "--session-dir") sessionDir = separatedValue(argv, index, value);
  return sessionDir;
}

function verifiedSessionDir(cwd: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = resolve(cwd, value);
  try {
    const canonical = realpathSync.native(path);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw new LaunchIntentError("unverifiable-path", `cannot verify session directory: ${value}`);
  }
}

function sessionHeader(path: string, cwd: string): ForkSource | null {
  const sessionFile = normalizeSessionPath(path, cwd);
  try {
    if (!statSync(sessionFile).isFile()) throw new Error("not a file");
    const firstLine = readFileSync(sessionFile, "utf8").split(/\r?\n/, 1)[0];
    if (!firstLine) throw new Error("missing header");
    const header: unknown = JSON.parse(firstLine);
    if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session"
      || typeof (header as { id?: unknown }).id !== "string" || !(header as { id: string }).id
      || typeof (header as { cwd?: unknown }).cwd !== "string") throw new Error("invalid header");
    return { cwd: canonicalizeCwd((header as { cwd: string }).cwd), sessionFile, sessionId: (header as { id: string }).id };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LaunchIntentError("unverifiable-path", `cannot verify session header: ${path}`);
  }
}

function existingPathReservation(path: string, cwd: string): LaunchReservation | null {
  const source = sessionHeader(path, cwd);
  if (source === null) return null;
  if (source.cwd !== cwd) throw new LaunchIntentError("unverifiable-path", `cannot verify session header: ${path}`);
  return { kind: "session", cwd, sessionFile: source.sessionFile, sessionId: source.sessionId };
}

function piPackageRoot(bin: string): string | null {
  let directory: string;
  try { directory = dirname(realpathSync.native(bin)); } catch { return null; }
  while (dirname(directory) !== directory) {
    try { if ((JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as { name?: string }).name === "@earendil-works/pi-coding-agent") return directory; } catch { /* 继续向父目录查找。 */ }
    directory = dirname(directory);
  }
  return null;
}

export async function loadPublicSessionManager(input: Readonly<{ piBinary?: string; packageRoot?: string }>): Promise<PiSessionManager | null> {
  const root = input.packageRoot ?? (input.piBinary ? piPackageRoot(input.piBinary) : null);
  if (!root) return null;
  try {
    const module = await import(pathToFileURL(resolve(root, "dist", "index.js")).href) as { SessionManager?: PiSessionManager };
    return module.SessionManager && typeof module.SessionManager.list === "function" ? module.SessionManager : null;
  } catch { return null; }
}

export async function resolveRecentSession(input: ResolveRecentSessionInput): Promise<RecentResolution> {
  try {
    const cwd = canonicalizeCwd(input.cwd);
    const sessionDirValue = sessionDirFromArgv(input.argv) ?? input.env?.PI_CODING_AGENT_SESSION_DIR ?? process.env.PI_CODING_AGENT_SESSION_DIR;
    const sessionDir = verifiedSessionDir(cwd, sessionDirValue);
    if (sessionDir === undefined) return { kind: "absent" };
    let names: string[];
    try { names = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }; throw error; }
    const mtime = input.statMtime ?? ((path: string) => statSync(path).mtimeMs);
    const candidates = await Promise.all(names.map(async (name, index) => {
      const path = resolve(sessionDir, name);
      const info = statSync(path);
      if (!info.isFile()) return null;
      return { index, mtime: await mtime(path), path: realpathSync.native(path) };
    }));
    for (const candidate of candidates.filter((value): value is NonNullable<typeof value> => value !== null).sort((left, right) => right.mtime - left.mtime || left.index - right.index)) {
      const bytes = input.readHeaderBytes ? await input.readHeaderBytes(candidate.path, MAX_SESSION_HEADER_BYTES) : readSessionHeaderBytes(candidate.path);
      const lineEnd = bytes.indexOf(10);
      if (lineEnd < 0) {
        if (bytes.length >= MAX_SESSION_HEADER_BYTES) throw new Error("session header exceeds maximum size");
        continue;
      }
      const line = bytes.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
      try {
        const header: unknown = JSON.parse(line);
        if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session"
          || typeof (header as { id?: unknown }).id !== "string" || !(header as { id: string }).id
          || typeof (header as { cwd?: unknown }).cwd !== "string") continue;
        if (canonicalizeCwd((header as { cwd: string }).cwd) !== cwd) continue;
        return { kind: "found", session: { id: (header as { id: string }).id, cwd, path: candidate.path } };
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof LaunchIntentError) continue;
        throw error;
      }
    }
    return { kind: "absent" };
  } catch { return { kind: "unavailable" }; }
}

export function readSessionHeaderBytes(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    for (let offset = 0; offset < buffer.length; offset += 1) {
      if (readSync(fd, buffer, offset, 1, offset) === 0) return buffer.subarray(0, offset);
      if (buffer[offset] === 10) return buffer.subarray(0, offset + 1);
    }
    return buffer;
  } finally { closeSync(fd); }
}

export async function resolveLaunchTarget(input: ResolveRecentSessionInput & Readonly<{ intent: LaunchIntent }>): Promise<TargetResolution> {
  const cwd = canonicalizeCwd(input.cwd);
  const sessionDirValue = sessionDirFromArgv(input.argv) ?? input.env?.PI_CODING_AGENT_SESSION_DIR ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  const sessionDir = verifiedSessionDir(cwd, sessionDirValue);
  if (input.intent.kind === "continue") {
    const recent = await resolveRecentSession(input);
    if (recent.kind === "found") return { kind: "resolved", reservation: { kind: "session", cwd, sessionFile: normalizeSessionPath(recent.session.path, cwd), sessionId: recent.session.id } };
    return recent.kind === "absent" ? { kind: "absent" } : { kind: "unavailable" };
  }
  if (input.intent.kind === "resume") return { kind: "resolved", reservation: { kind: "selecting" } };
  if (input.intent.kind === "new" || input.intent.kind === "ephemeral" || input.intent.kind === "non-interactive") return { kind: "resolved", reservation: { kind: "new" } };
  try {
    if (input.intent.kind === "fork" && (input.intent.value.includes("/") || input.intent.value.includes("\\") || input.intent.value.endsWith(".jsonl"))) {
      const source = sessionHeader(input.intent.value, cwd);
      return source === null ? { kind: "unavailable" } : { kind: "resolved", reservation: { kind: "fork-source", cwd, source } };
    }
    if (input.intent.kind === "session" && (input.intent.value.includes("/") || input.intent.value.includes("\\") || input.intent.value.endsWith(".jsonl"))) {
      const existing = existingPathReservation(input.intent.value, cwd);
      return { kind: "resolved", reservation: existing ?? { kind: "session", cwd, sessionFile: normalizeSessionPath(input.intent.value, cwd), sessionId: null } };
    }
    const manager = input.sessionManager ?? await loadPublicSessionManager(input);
    if (!manager) return { kind: "unavailable" };
    if (input.intent.kind === "session-id") {
      const sessionId = input.intent.value;
      const local = await manager.list(cwd, sessionDir);
      const existing = local.filter((entry) => entry.id === sessionId);
      if (existing.length > 1) return { kind: "unavailable" };
      return { kind: "resolved", reservation: existing[0] ? { kind: "session", cwd, sessionFile: normalizeSessionPath(existing[0].path, cwd), sessionId: existing[0].id } : { kind: "session-id", cwd, sessionId } };
    }
    const value = input.intent.value;
    const local = await manager.list(cwd, sessionDir);
    const all = manager.listAll ? await manager.listAll(sessionDir) : [];
    const matches = [...local, ...all].filter((entry, index, entries) => (entry.id === value || entry.id.startsWith(value)) && entries.findIndex((candidate) => candidate.path === entry.path) === index);
    if (matches.length !== 1) return { kind: "unavailable" };
    const match = matches[0]!;
    if (input.intent.kind === "fork") return { kind: "resolved", reservation: { kind: "fork-source", cwd, source: { cwd: canonicalizeCwd(match.cwd), sessionFile: normalizeSessionPath(match.path, cwd), sessionId: match.id } } };
    return { kind: "resolved", reservation: { kind: "session", cwd: canonicalizeCwd(match.cwd), sessionFile: normalizeSessionPath(match.path, cwd), sessionId: match.id } };
  } catch { return { kind: "unavailable" }; }
}
