import { randomUUID } from "node:crypto";
import { constants, open, mkdir, lstat, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export class DurableStorageError extends Error {
  readonly code: string;
  constructor(code: string, message = code, options?: { cause?: unknown }) { super(message, options); this.code = code; }
}
export interface StoredValue<T = unknown> { revision: number; value: T; }
const name = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new DurableStorageError("DURABLE_STORAGE_NAME"); return value; };
type Flock = (fd: number, operation: "exnb", callback: (error: NodeJS.ErrnoException | null) => void) => void;
export class DurableStorage {
  readonly root: string; readonly staleLockMs: number;
  private readonly flock: Flock;
  constructor(input: { root: string; staleLockMs?: number }) {
    if (!path.isAbsolute(input.root)) throw new DurableStorageError("DURABLE_STORAGE_ROOT");
    this.root = input.root;
    // 仅保留构造参数兼容性；锁所有权不再依赖时间。
    this.staleLockMs = input.staleLockMs ?? 60_000;
    if (process.platform !== "darwin" && process.platform !== "linux") throw new DurableStorageError("DURABLE_LOCK_UNSUPPORTED_PLATFORM", `DURABLE_LOCK_UNSUPPORTED_PLATFORM: ${process.platform}`);
    try {
      const native = createRequire(import.meta.url)("fs-ext");
      if (typeof native.flock !== "function") throw new Error("fs-ext.flock 不可用");
      this.flock = native.flock;
    } catch (cause) {
      throw new DurableStorageError("DURABLE_LOCK_UNAVAILABLE", "DURABLE_LOCK_UNAVAILABLE: 请在当前 Node 版本下运行 setup:runtime 构建 fs-ext", { cause });
    }
  }
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
    await this.ensureRoot();
    // 文件名标识新协议；旧 writer 的合法 key 不能以点开头，避免命名冲突。
    // 创建后立即终止留下的空文件仍是新版稳定锁，不需要非原子的 owner 写入。
    const lock = path.join(this.root, `.flock-v1.${name(key)}.lock`);
    let handle;
    try {
      for (const suffix of [".lock", ".lock.guard"]) {
        const legacy = this.file(key, suffix);
        try { await lstat(legacy); }
        catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
        throw new DurableStorageError("DURABLE_LOCK_MIGRATION_REQUIRED", `DURABLE_LOCK_MIGRATION_REQUIRED: key=${key}; 旧协议文件 ${legacy} 已保留；停止该存储根的全部旧 writer 后归档旧锁并统一升级`);
      }
      handle = await open(lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new DurableStorageError("DURABLE_LOCK_UNPROVEN");
      await new Promise<void>((resolve, reject) => {
        this.flock(handle.fd, "exnb", error => {
          if (!error) { resolve(); return; }
          const code = error.code === "EAGAIN" || error.code === "EWOULDBLOCK" ? "DURABLE_LOCK_HELD" : "DURABLE_LOCK_UNPROVEN";
          reject(new DurableStorageError(code, `${code}: key=${key}`, { cause: error }));
        });
      });
    } catch (cause) {
      await handle?.close();
      if (cause instanceof DurableStorageError) throw cause;
      throw new DurableStorageError("DURABLE_LOCK_UNPROVEN", `DURABLE_LOCK_UNPROVEN: key=${key}`, { cause });
    }
    // 闭包持有 FileHandle；只关闭一次，不删除或替换内核锁对应的 inode。
    const held = handle;
    let releasePromise: Promise<void> | undefined;
    return () => releasePromise ??= held.close();
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
