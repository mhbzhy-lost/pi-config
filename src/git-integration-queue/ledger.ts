import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export class QueueLedger {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, "items"), { recursive: true, mode: 0o700 });
  }

  private file(name: string): string { return join(this.root, name); }

  itemKey(requestId: string): string {
    return createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  }

  itemFile(requestId: string): string { return join(this.root, "items", `${this.itemKey(requestId)}.json`); }

  async readItem<T>(requestId: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.itemFile(requestId), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  }

  async writeItem<T>(requestId: string, value: T): Promise<void> {
    await this.writeAbsolute(this.itemFile(requestId), value);
  }

  async read<T>(name: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.file(name), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  }

  async write<T>(name: string, value: T): Promise<void> {
    await this.writeAbsolute(this.file(name), value);
  }

  private async writeAbsolute<T>(target: string, value: T): Promise<void> {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
