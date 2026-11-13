import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WorktreeFacts } from "./records.ts";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function repositoryIdentity(cwd: string): { repositoryRoot: string; repositoryId: string } {
  const root = realpathSync(git(resolve(cwd), ["rev-parse", "--show-toplevel"]));
  const commonDir = realpathSync(resolve(root, git(root, ["rev-parse", "--git-common-dir"])));
  return { repositoryRoot: root, repositoryId: createHash("sha256").update(commonDir).digest("hex") };
}

export function targetHead(repositoryRoot: string, targetRef: string): string {
  return git(repositoryRoot, ["rev-parse", `${targetRef}^{commit}`]);
}

export function currentBranch(repositoryRoot: string): string {
  return git(repositoryRoot, ["symbolic-ref", "-q", "HEAD"]);
}

export function isAncestor(repositoryRoot: string, base: string, head: string): boolean {
  try { execFileSync("git", ["-C", repositoryRoot, "merge-base", "--is-ancestor", base, head], { stdio: "ignore" }); return true; }
  catch { return false; }
}

export function worktreeClean(repositoryRoot: string): boolean {
  return git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]) === "";
}

export function changedFiles(repositoryRoot: string): string[] {
  const output = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return output ? output.split("\n").map((line) => line.slice(3).trim()).filter(Boolean) : [];
}

export function hasSequencer(repositoryRoot: string): boolean {
  const gitDir = git(repositoryRoot, ["rev-parse", "--git-dir"]);
  return existsSync(resolve(repositoryRoot, gitDir, "rebase-merge")) || existsSync(resolve(repositoryRoot, gitDir, "rebase-apply"));
}

export function inspectWorktree(input: { worktreePath: string; baseCommit?: string; targetRef?: string; handoffPath?: string }): WorktreeFacts {
  const identity = repositoryIdentity(input.worktreePath);
  const head = git(identity.repositoryRoot, ["rev-parse", "HEAD"]);
  const clean = worktreeClean(identity.repositoryRoot);
  const facts: WorktreeFacts = {
    ...identity,
    worktreePath: realpathSync(input.worktreePath),
    targetRef: input.targetRef,
    baseCommit: input.baseCommit,
    headCommit: head,
    clean,
    changedFiles: changedFiles(identity.repositoryRoot),
    sequencer: hasSequencer(identity.repositoryRoot),
  };
  if (input.targetRef) facts.targetRef = input.targetRef;
  return facts;
}

export function readHandoff(handoffPath: string): WorktreeFacts[] {
  const manifest = JSON.parse(readFileSync(handoffPath, "utf8")) as { groups?: Array<{ repoRoot?: string; baseCommit?: string; children?: Array<{ patch?: { path?: string; changed?: boolean } }>; cleanup?: { tasks?: Array<{ index?: number; path?: string; worktreeRemoved?: boolean; preserved?: boolean }> } }> };
  const result: WorktreeFacts[] = [];
  for (const group of manifest.groups ?? []) {
    if (!group.repoRoot || !group.baseCommit || !Array.isArray(group.children)) continue;
    for (const [index, child] of group.children.entries()) {
      const patch = child.patch;
      const cleanup = group.cleanup?.tasks?.find((task) => task.index === index);
      if (!patch?.path) continue;
      const identity = repositoryIdentity(group.repoRoot);
      const patchDigest = createHash("sha256").update(readFileSync(patch.path)).digest("hex");
      result.push({
        ...identity,
        worktreePath: cleanup?.path,
        baseCommit: group.baseCommit,
        clean: cleanup?.worktreeRemoved === true ? true : cleanup?.preserved === true ? false : null,
        changedFiles: [],
        sequencer: false,
        worktreeRemoved: cleanup?.worktreeRemoved,
        patchChanged: patch.changed === true,
        patchPath: patch.path,
        handoffPath,
        patchDigest,
      });
    }
  }
  return result;
}
