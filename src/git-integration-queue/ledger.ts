import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class QueueLedger {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  async init(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); }

  private file(name: string): string { return join(this.root, name); }

  async read<T>(name: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.file(name), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  }

  async write<T>(name: string, value: T): Promise<void> {
    const target = this.file(name);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
