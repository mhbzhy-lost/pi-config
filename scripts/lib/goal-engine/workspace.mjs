import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function safeId(value, field) {
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("..")) throw new Error(`Invalid ${field}`);
  return value;
}

function workspacePaths(stateRoot, goalId, taskId, attempt) {
  const worktreesRoot = path.resolve(stateRoot, "worktrees");
  const name = `${goalId}-${taskId}-${attempt}`;
  const workspacePath = path.join(worktreesRoot, name);
  const leasePath = path.join(worktreesRoot, `.${name}.lease.json`);
  return { worktreesRoot, workspacePath, leasePath };
}

export function allocateExecutorWorkspace({ goalId, taskId, attempt, originRoot, stateRoot, baseCommit }) {
  safeId(goalId, "goalId");
  safeId(taskId, "taskId");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  if (typeof originRoot !== "string" || typeof stateRoot !== "string") throw new Error("originRoot and stateRoot are required");
  if (typeof baseCommit !== "string" || !baseCommit) throw new Error("baseCommit is required");

  const { worktreesRoot, workspacePath, leasePath } = workspacePaths(stateRoot, goalId, taskId, attempt);
  const branch = `ge/${goalId}/${taskId}/${attempt}`;

  if (existsSync(leasePath) || existsSync(workspacePath)) {
    throw new Error(`Executor workspace already exists: ${goalId}/${taskId}/${attempt}`);
  }

  git(originRoot, "rev-parse", "--verify", `${baseCommit}^{commit}`);
  const existingBranch = git(originRoot, "branch", "--list", branch);
  if (existingBranch) throw new Error(`Branch already exists: ${branch}`);

  mkdirSync(worktreesRoot, { recursive: true });
  git(originRoot, "worktree", "add", "-b", branch, workspacePath, baseCommit);

  const lease = {
    goalId,
    taskId,
    attempt,
    originRoot: path.resolve(originRoot),
    stateRoot: path.resolve(stateRoot),
    baseCommit,
    path: workspacePath,
    branch,
    ownerToken: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const tmpPath = `${leasePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(lease, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, leasePath);

  return { ...lease, leasePath };
}

export function inspectExecutorWorkspace(lease) {
  if (!existsSync(lease.path)) throw new Error("Executor workspace is missing");

  const headCommit = git(lease.path, "rev-parse", "HEAD");
  const statusOutput = git(lease.path, "status", "--porcelain=v1", "-uno");
  const dirtyFiles = statusOutput ? statusOutput.split("\n").map((line) => line.slice(3)) : [];
  const untrackedOutput = git(lease.path, "ls-files", "--others", "--exclude-standard");
  const untrackedFiles = untrackedOutput ? untrackedOutput.split("\n").filter(Boolean) : [];

  let diff = "";
  if (headCommit !== lease.baseCommit) {
    diff = git(lease.path, "diff", `${lease.baseCommit}..${headCommit}`);
  }

  return {
    headCommit,
    baseCommit: lease.baseCommit,
    dirtyFiles,
    untrackedFiles,
    diff,
    clean: dirtyFiles.length === 0 && untrackedFiles.length === 0,
    hasCommits: headCommit !== lease.baseCommit,
  };
}

export function integrateExecutorWorkspace(lease, { strategy = "cherry-pick" } = {}) {
  if (!existsSync(lease.path)) throw new Error("Executor workspace is missing");

  const inspection = inspectExecutorWorkspace(lease);
  if (!inspection.hasCommits) throw new Error("No commits to integrate");
  if (!inspection.clean) throw new Error("Workspace must be clean before integration (no uncommitted changes)");

  const origin = lease.originRoot;

  if (strategy === "cherry-pick") {
    const logOutput = git(lease.path, "rev-list", "--reverse", `${lease.baseCommit}..${inspection.headCommit}`);
    const commits = logOutput.split("\n").filter(Boolean);
    for (const commit of commits) {
      git(origin, "cherry-pick", commit);
    }
  } else if (strategy === "merge") {
    git(origin, "merge", "--no-ff", lease.branch, "-m", `ge: integrate ${lease.goalId}/${lease.taskId}`);
  } else {
    throw new Error(`Unknown integration strategy: ${strategy}`);
  }

  const newHead = git(origin, "rev-parse", "HEAD");
  return { integrated: true, newHead, strategy };
}

export function releaseExecutorWorkspace(lease, { disposition } = {}) {
  const validDispositions = ["integrated-cleanup", "failed-cleanup", "discarded-cleanup", "preserved"];
  if (!validDispositions.includes(disposition)) throw new Error(`Invalid disposition: ${disposition}`);

  if (disposition === "preserved") {
    return { released: false, preserved: true, disposition };
  }

  const origin = lease.originRoot;

  if (existsSync(lease.path)) {
    if (disposition === "integrated-cleanup") {
      const inspection = inspectExecutorWorkspace(lease);
      if (!inspection.clean) throw new Error("Workspace must be clean before integrated-cleanup");
    }
    git(origin, "worktree", "remove", "--force", lease.path);
  }

  const branchExists = git(origin, "branch", "--list", lease.branch);
  if (branchExists) {
    git(origin, "branch", "-D", lease.branch);
  }

  if (lease.leasePath && existsSync(lease.leasePath)) {
    rmSync(lease.leasePath, { force: true });
  }

  return { released: true, preserved: false, disposition };
}
