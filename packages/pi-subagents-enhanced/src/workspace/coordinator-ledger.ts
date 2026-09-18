import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function birthIdentity(pid: number) {
  const observed = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
  if (!observed.toString().trim()) throw new Error("process is unavailable");
  return createHash("sha256").update(observed).digest("hex");
}

let ownBirthIdentity: string | undefined;

export function createCoordinatorLedger(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".lock");
  function withLock<T>(operation: () => T): T {
    let descriptor: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        descriptor = openSync(lock, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, birthIdentity: ownBirthIdentity ??= birthIdentity(process.pid) })); fsyncSync(descriptor); break;
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(readFileSync(lock, "utf8"));
          process.kill(owner.pid, 0);
          if (typeof owner.birthIdentity !== "string" || birthIdentity(owner.pid) !== owner.birthIdentity) rmSync(lock, { force: true });
        } catch (ownerError: any) {
          if (ownerError.code === "ESRCH" || ownerError.code === "ENOENT") rmSync(lock, { force: true });
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (descriptor === undefined) throw new Error("coordinator ledger lock is busy");
    try { return operation(); } finally { closeSync(descriptor); rmSync(lock, { force: true }); }
  }
  function read<T>(file: string, fallback: T): T {
    try { return JSON.parse(readFileSync(path.join(directory, file), "utf8")); } catch (error: any) {
      if (error.code === "ENOENT") return structuredClone(fallback);
      throw error;
    }
  }
  function write(file: string, value: unknown) {
    const target = path.join(directory, file); const temporary = `${target}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, "w", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, target);
  }
  return Object.freeze({ directory, withLock, read, write, exists: (file: string) => existsSync(path.join(directory, file)) });
}
