import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Git identity unavailable: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const displayPath = (value: string) => process.platform === "darwin" ? value.replace(/^\/private(?=\/var\/)/, "") : value;

export async function resolveRepositoryIdentity(cwd: string) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("Git identity requires an absolute cwd");
  const info = await lstat(cwd).catch(() => { throw new Error("Git identity cwd is unavailable"); });
  if (info.isSymbolicLink()) throw new Error("Git identity rejects symlink cwd");
  const realCwd = await realpath(cwd);
  const [topLevel, common] = await Promise.all([
    git(realCwd, ["rev-parse", "--show-toplevel"]).then((value) => displayPath(path.resolve(value))),
    git(realCwd, ["rev-parse", "--git-common-dir"]).then((value) => realpath(path.isAbsolute(value) ? value : path.resolve(realCwd, value))),
  ]);
  const worktrees = (await git(realCwd, ["worktree", "list", "--porcelain"])).split("\n");
  const roots: string[] = [];
  for (const line of worktrees) if (line.startsWith("worktree ")) roots.push(displayPath(path.resolve(line.slice(9))));
  const originRoot = roots[0];
  if (!originRoot) throw new Error("Git identity cannot determine canonical main worktree");
  // 身份哈希必须基于 canonical realpath：displayPath 只给人看。用 display 形态哈希会让
  // 同一 clone 在 macOS /var→/private/var 下写入与 audit 推导出两个不同 storage partition。
  const legacyStorageRepositoryId = hash(await realpath(topLevel));
  const storageRepositoryId = hash(await realpath(originRoot));
  return {
    repositoryId: hash(common),
    originRoot,
    commonDir: common,
    storageRepositoryId,
    migrationDebt: topLevel !== originRoot ? {
      kind: "legacy-linked-worktree-ledger-partition",
      legacyStorageRepositoryId,
      action: "inventory-only",
    } : undefined,
  };
}
