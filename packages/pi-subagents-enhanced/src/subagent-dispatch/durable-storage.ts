import { randomUUID } from "node:crypto";
import { constants, open, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class DurableStorageError extends Error {
  readonly code: string;
  constructor(code: string, message = code, options?: { cause?: unknown }) { super(message, options); this.code = code; }
}
export interface StoredValue<T = unknown> { revision: number; value: T; }
const name = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new DurableStorageError("DURABLE_STORAGE_NAME"); return value; };
export class DurableStorage {
  readonly root: string; readonly staleLockMs: number;
  constructor(input: { root: string; staleLockMs?: number }) { if (!path.isAbsolute(input.root)) throw new DurableStorageError("DURABLE_STORAGE_ROOT"); this.root = input.root; this.staleLockMs = input.staleLockMs ?? 60_000; }
  private file(key: string, suffix = ".json") { return path.join(this.root, `${name(key)}${suffix}`); }
  private async ensureRoot() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async read<T = unknown>(key: string): Promise<StoredValue<T> | null> {
    const file = this.file(key); await this.ensureRoot();
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const info = await handle.stat(); if (!info.isFile() || (info.mode & 0o077) !== 0) throw new DurableStorageError("DURABLE_STORAGE_PERMISSIONS"); const text = await handle.readFile("utf8"); const parsed = JSON.parse(text); if (!parsed || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1 || !Object.hasOwn(parsed, "value")) throw new Error("invalid"); return { revision: parsed.revision, value: parsed.value as T }; }
    catch (error: any) { if (error?.code === "ENOENT") return null; if (error instanceof DurableStorageError) throw error; throw new DurableStorageError("DURABLE_STORAGE_CORRUPT", "DURABLE_STORAGE_CORRUPT", { cause: error }); }
    finally { await handle?.close(); }
  }
  async acquireLock(key: string): Promise<() => Promise<void>> {
    await this.ensureRoot(); const lock = this.file(key, ".lock"); const owner = randomUUID();
    const deadline = Date.now() + this.staleLockMs;
    for (;;) {
      try { await writeFile(lock, JSON.stringify({ owner, processBirth: `${process.pid}:${process.uptime()}` }), { flag: "wx", mode: 0o600 }); break; }
      catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        let info;
        try { info = await stat(lock); }
        catch (statError: any) {
          // 持有者刚释放lock的原子窗口只在既有deadline内重试；其他错误保持原样。
          if (statError?.code === "ENOENT" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1)); continue; }
          throw statError;
        }
        if (Date.now() - info.mtimeMs <= this.staleLockMs) throw new DurableStorageError("DURABLE_LOCK_HELD");
        const quarantine = `${lock}.quarantine-${Date.now()}-${randomUUID()}`;
        try { await rename(lock, quarantine); } catch (cause) { throw new DurableStorageError("DURABLE_LOCK_UNPROVEN", "DURABLE_LOCK_UNPROVEN", { cause }); }
      }
    }
    return async () => { try { const raw = JSON.parse(await readFile(lock, "utf8")); if (raw.owner === owner) await unlink(lock); } catch {} };
  }
  private async writeUnlocked<T>(key: string, value: T, expectedRevision: number): Promise<StoredValue<T>> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DurableStorageError("DURABLE_REVISION_CONFLICT");
    const prior = await this.read(key); const actual = prior?.revision ?? 0;
    if (actual !== expectedRevision) throw new DurableStorageError("DURABLE_REVISION_CONFLICT");
    const next = { revision: actual + 1, value }; const destination = this.file(key); const temporary = path.join(this.root, `.${name(key)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(JSON.stringify(next), "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination); const directory = await open(this.root, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    return next;
  }
  async write<T>(key: string, value: T, expectedRevision: number): Promise<StoredValue<T>> {
    const release = await this.acquireLock(key); try { return await this.writeUnlocked(key, value, expectedRevision); } finally { await release(); }
  }
  async writeLocked<T>(key: string, value: T, expectedRevision: number): Promise<StoredValue<T>> {
    return this.writeUnlocked(key, value, expectedRevision);
  }
}
