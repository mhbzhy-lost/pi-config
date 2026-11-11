import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

type WriteCallback = (error?: Error | null) => void;
type StderrWrite = NodeJS.WriteStream["write"];

export interface StderrGuardHost {
  stderr: { write: StderrWrite };
  prependListener(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  removeListener(event: "uncaughtException", listener: (error: unknown) => void): unknown;
}

interface GuardState {
  version: 1;
  host: StderrGuardHost;
  owner: symbol;
  originalWrite: StderrWrite;
  guardedWrite: StderrWrite;
  fatalListener: (error: unknown) => void;
  writeLog: (chunk: Buffer) => void;
}

const STATE_KEY = Symbol.for("pi-config.interactive-stderr-guard.v1");

function stateRecord(host: StderrGuardHost): Record<PropertyKey, unknown> {
  return host as unknown as Record<PropertyKey, unknown>;
}

function currentState(host: StderrGuardHost): GuardState | undefined {
  const value = stateRecord(host)[STATE_KEY];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<GuardState>;
  return candidate.version === 1 ? value as GuardState : undefined;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toBuffer(chunk: string | Uint8Array, encoding?: BufferEncoding): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(chunk);
}

function restoreState(state: GuardState): void {
  const record = stateRecord(state.host);
  if (record[STATE_KEY] !== state) return;

  if (state.host.stderr.write === state.guardedWrite) {
    state.host.stderr.write = state.originalWrite;
  }
  state.host.removeListener("uncaughtException", state.fatalListener);
  delete record[STATE_KEY];
}

export function installInteractiveStderrGuard(options: {
  host?: StderrGuardHost;
  writeLog(chunk: Buffer): void;
}): () => void {
  const host = options.host ?? process as unknown as StderrGuardHost;
  const owner = Symbol("interactive-stderr-guard-owner");
  const existing = currentState(host);

  if (existing) {
    existing.owner = owner;
    existing.writeLog = options.writeLog;
    return () => {
      if (existing.owner === owner) restoreState(existing);
    };
  }

  let state: GuardState;
  const originalWrite = host.stderr.write;
  const guardedWrite = function write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    let writeError: Error | undefined;

    try {
      state.writeLog(toBuffer(chunk, encoding));
    } catch (error) {
      writeError = normalizeError(error);
    }

    if (done) queueMicrotask(() => done(writeError));
    return true;
  } as StderrWrite;
  const fatalListener = () => restoreState(state);

  state = {
    version: 1,
    host,
    owner,
    originalWrite,
    guardedWrite,
    fatalListener,
    writeLog: options.writeLog,
  };
  stateRecord(host)[STATE_KEY] = state;
  host.stderr.write = guardedWrite;
  host.prependListener("uncaughtException", fatalListener);

  return () => {
    if (state.owner === owner) restoreState(state);
  };
}

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

export function createRotatingStderrSink(options: {
  logPath: string;
  maxBytes?: number;
  now?: () => Date;
}): (chunk: Buffer) => void {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_LOG_BYTES));
  const historyPath = `${options.logPath}.1`;
  const logDirectory = dirname(options.logPath);
  const now = options.now ?? (() => new Date());
  let activeBytes = 0;

  try {
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    chmodSync(logDirectory, 0o700);
  } catch {
    // Writes remain best-effort and must not fall back to stderr.
  }
  try {
    activeBytes = statSync(options.logPath).size;
    chmodSync(options.logPath, 0o600);
  } catch {
    activeBytes = 0;
  }

  const rotate = () => {
    rmSync(historyPath, { force: true });
    try {
      renameSync(options.logPath, historyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    activeBytes = 0;
  };

  return (chunk: Buffer) => {
    try {
      const text = chunk.toString("utf8");
      const newline = text.endsWith("\n") ? "" : "\n";
      const fullRecord = Buffer.from(`[${now().toISOString()}] ${text}${newline}`);
      const record = fullRecord.length > maxBytes ? fullRecord.subarray(0, maxBytes) : fullRecord;
      if (activeBytes > 0 && activeBytes + record.length > maxBytes) rotate();
      appendFileSync(options.logPath, record, { mode: 0o600 });
      chmodSync(options.logPath, 0o600);
      activeBytes += record.length;
    } catch {
      // Diagnostics must never fall back to the terminal or recurse through stderr.
    }
  };
}
