import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

function childPrefix(prefix) {
  if (typeof prefix !== "string" || !prefix || basename(prefix) !== prefix || prefix.includes(sep)) {
    throw new TypeError("temporary arena child prefix must be a single path segment");
  }
  return prefix;
}

/** A test-owned OS temporary directory. It never invokes Git cleanup commands. */
export class TemporaryArena {
  #children = [];
  #disposeHooks = [];
  #disposed = false;

  constructor(prefix = "goal-engine-test-") {
    const canonicalTmp = realpathSync(tmpdir());
    this.path = realpathSync(mkdtempSync(join(canonicalTmp, childPrefix(prefix))));
  }

  mkdtempSync(prefix) {
    if (this.#disposed) throw new Error("temporary arena is already disposed");
    const child = mkdtempSync(join(this.path, childPrefix(prefix)));
    this.#children.push(child);
    return child;
  }

  onDispose(callback) {
    if (typeof callback !== "function") throw new TypeError("temporary arena dispose hook must be a function");
    this.#disposeHooks.push(callback);
  }

  disposeSync() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const child of [...this.#children].reverse()) {
      rmSync(child, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      for (const hook of this.#disposeHooks) hook(child);
    }
    // rm unlinks symlinks rather than traversing them; this only removes our canonical arena.
    if (resolve(this.path).startsWith(`${realpathSync(tmpdir())}${sep}`)) {
      rmSync(this.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  }
}

export function createTemporaryArenaSync(prefix) {
  return new TemporaryArena(prefix);
}
