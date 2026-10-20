import { randomUUID } from "node:crypto";
import { constants, open, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
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
    // 创建、回收和释放都在同一个短临界区内，避免回收者移动已经被替换的新锁。
    await this.withLockMutation(key, async () => {
      const held = await this.readLock(lock);
      if (held) {
        const birth = typeof held.value.processBirth === "string" ? /^(\d+):\d+(?:\.\d+)?$/.exec(held.value.processBirth) : null;
        const pid = held.value.pid ?? (birth ? Number(birth[1]) : undefined);
        if (!Number.isSafeInteger(pid) || pid <= 0 || typeof held.value.owner !== "string" || !held.value.owner
          || (birth && Number(birth[1]) !== pid)) throw new DurableStorageError("DURABLE_LOCK_UNPROVEN");
        try { process.kill(pid, 0); throw new DurableStorageError("DURABLE_LOCK_HELD", `DURABLE_LOCK_HELD: durable owner PID ${pid} is still present; key=${key}`); }
        catch (error: any) {
          if (error instanceof DurableStorageError) throw error;
          // 只有内核明确回答ESRCH才能证明原owner已退出；EPERM或其他错误均不抢。
          if (error?.code !== "ESRCH") throw new DurableStorageError("DURABLE_LOCK_UNPROVEN", "DURABLE_LOCK_UNPROVEN", { cause: error });
        }
        await rename(lock, `${lock}.quarantine-${Date.now()}-${randomUUID()}`);
      }
      const handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ owner, pid: process.pid, processBirth: `${process.pid}:${process.uptime()}` })); await handle.sync(); }
      finally { await handle.close(); }
    });
    let released = false;
    return async () => {
      if (released) return;
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          await this.withLockMutation(key, async () => {
            const current = await this.readLock(lock);
            if (current && current.value.owner === owner) await unlink(lock);
          });
          released = true; return;
        } catch (error: any) {
          if (error?.code !== "DURABLE_LOCK_HELD" || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
    };
  }
  private async readLock(file: string): Promise<{ value: any } | null> {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new DurableStorageError("DURABLE_LOCK_UNPROVEN");
      let value;
      try { value = JSON.parse(await handle.readFile("utf8")); } catch {
        // 旧版本wx写入尚未完成时允许调用方按既有期限等待；老化坏数据不自动恢复。
        throw new DurableStorageError(Date.now() - info.mtimeMs <= this.staleLockMs ? "DURABLE_LOCK_HELD" : "DURABLE_LOCK_UNPROVEN");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new DurableStorageError("DURABLE_LOCK_UNPROVEN");
      return { value };
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof DurableStorageError) throw error;
      throw new DurableStorageError("DURABLE_LOCK_UNPROVEN", "DURABLE_LOCK_UNPROVEN", { cause: error });
    } finally { await handle?.close(); }
  }
  private async withLockMutation<T>(key: string, work: () => Promise<T>): Promise<T> {
    const guard = this.file(key, ".lock.guard");
    let handle;
    try { handle = await open(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error: any) {
      // 空 guard 无 owner 证据；保留现场并指出实际阻塞阶段，不能按年龄自动抢锁。
      if (error?.code === "EEXIST") throw new DurableStorageError("DURABLE_LOCK_HELD", `DURABLE_LOCK_HELD: mutation guard exists; key=${key}; guard owner is unproven, preserve the guard for scoped recovery`, { cause: error });
      throw new DurableStorageError("DURABLE_LOCK_UNPROVEN", "DURABLE_LOCK_UNPROVEN", { cause: error });
    }
    try { return await work(); }
    finally { await handle.close(); await unlink(guard); }
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
