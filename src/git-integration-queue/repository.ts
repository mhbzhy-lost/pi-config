import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { WorktreeFacts } from "./records.ts";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function repositoryIdentity(cwd: string): { repositoryRoot: string; repositoryId: string } {
  const worktreeRoot = realpathSync(git(resolve(cwd), ["rev-parse", "--show-toplevel"]));
  const commonDir = realpathSync(resolve(worktreeRoot, git(worktreeRoot, ["rev-parse", "--git-common-dir"])));
  const porcelain = git(worktreeRoot, ["worktree", "list", "--porcelain"]);
  const canonicalRoot = realpathSync(/^worktree (.+)$/m.exec(porcelain)?.[1] ?? worktreeRoot);
  return { repositoryRoot: canonicalRoot, repositoryId: createHash("sha256").update(commonDir).digest("hex") };
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
  const gitPath = resolve(repositoryRoot, gitDir);
  return ["rebase-merge", "rebase-apply", "sequencer", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"].some((marker) => existsSync(resolve(gitPath, marker)));
}

export function inspectWorktree(input: { worktreePath: string; baseCommit?: string; targetRef?: string; handoffPath?: string }): WorktreeFacts {
  const identity = repositoryIdentity(input.worktreePath);
  const worktreePath = realpathSync(input.worktreePath);
  const head = git(worktreePath, ["rev-parse", "HEAD"]);
  const clean = worktreeClean(worktreePath);
  const facts: WorktreeFacts = {
    ...identity,
    worktreePath,
    targetRef: input.targetRef,
    baseCommit: input.baseCommit,
    headCommit: head,
    clean,
    changedFiles: changedFiles(worktreePath),
    sequencer: hasSequencer(worktreePath),
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
      const resolvedHandoff = realpathSync(handoffPath);
      const resolvedPatch = realpathSync(resolve(patch.path));
      const patchRelative = relative(dirname(resolvedHandoff), resolvedPatch);
      if (patchRelative.startsWith("..") || patchRelative.startsWith("/")) throw new Error("handoff patch is outside its artifact directory");
      const patchDigest = createHash("sha256").update(readFileSync(resolvedPatch)).digest("hex");
      result.push({
        ...identity,
        worktreePath: cleanup?.path,
        baseCommit: group.baseCommit,
        clean: cleanup?.worktreeRemoved === true ? true : cleanup?.preserved === true ? false : null,
        changedFiles: [],
        sequencer: false,
        worktreeRemoved: cleanup?.worktreeRemoved,
        ...(typeof patch.changed === "boolean" ? { patchChanged: patch.changed } : {}),
        patchPath: resolvedPatch,
        handoffPath,
        patchDigest,
      });
    }
  }
  return result;
}
