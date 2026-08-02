import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function safeId(value, field) {
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("..")) throw new Error(`Invalid ${field}`);
  return value;
}

function isRepoRelativePosixPath(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${field}: path must be a non-empty string`);
  }
  if (value.includes("\u0000")) {
    throw new Error(`Invalid ${field}: path contains NUL byte`);
  }
  if (value.includes("\\")) {
    throw new Error(`Invalid ${field}: path must be repo-relative and POSIX`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`Invalid ${field}: path must be repo-relative and POSIX`);
  }
  if (value.includes("*") || value.includes("?") || value.includes("[") || value.includes("]") || value.includes("{") || value.includes("}")) {
    throw new Error(`Invalid ${field}: unsupported glob pattern`);
  }

  const segments = value.split("/");
  if (!segments.every((segment) => segment.length > 0)) {
    throw new Error(`Invalid ${field}: path contains empty segment`);
  }
  if (segments.includes("." ) || segments.includes("..")) {
    throw new Error(`Invalid ${field}: path contains invalid segment`);
  }
  return value;
}

function describeWritePath(writePath) {
  if (writePath.endsWith("/**")) {
    const dir = writePath.slice(0, -3);
    if (!dir) {
      throw new Error(`Invalid writePath: path must include a directory before "/**"`);
    }
    if (dir.includes("*") || dir.includes("?") || dir.includes("[") || dir.includes("]") || dir.includes("{") || dir.includes("}")) {
      throw new Error(`Invalid writePath pattern: unsupported glob`);
    }
    isRepoRelativePosixPath(dir, "writePath");
    return { type: "dir", prefix: `${dir}/`, raw: writePath };
  }

  isRepoRelativePosixPath(writePath, "writePath");
  return { type: "file", path: writePath, raw: writePath };
}

function matchesWritePath(writePath, changedFile) {
  if (writePath.type === "file") {
    return changedFile === writePath.path;
  }

  if (writePath.type === "dir") {
    return changedFile.startsWith(writePath.prefix);
  }

  return false;
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

export function loadExecutorWorkspaceLease({ goalId, taskId, attempt, stateRoot }) {
  safeId(goalId, "goalId");
  safeId(taskId, "taskId");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  if (typeof stateRoot !== "string") throw new Error("stateRoot is required");

  const { workspacePath, leasePath } = workspacePaths(stateRoot, goalId, taskId, attempt);
  if (!existsSync(leasePath)) {
    throw new Error(`Executor workspace lease not found: ${goalId}/${taskId}/${attempt}`);
  }

  let lease;
  try {
    lease = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch {
    throw new Error(`Executor workspace lease is invalid: ${goalId}/${taskId}/${attempt}`);
  }

  const expected = {
    goalId,
    taskId,
    attempt,
    stateRoot: path.resolve(stateRoot),
    path: workspacePath,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (lease?.[field] !== value) {
      throw new Error(`Executor workspace lease ${field} does not match`);
    }
  }
  for (const field of ["originRoot", "baseCommit", "branch", "ownerToken", "createdAt"]) {
    if (typeof lease[field] !== "string" || !lease[field]) {
      throw new Error(`Executor workspace lease ${field} is invalid`);
    }
  }

  return { ...lease, leasePath };
}

export function inspectExecutorWorkspace(lease) {
  if (!existsSync(lease.path)) throw new Error("Executor workspace is missing");

  const headCommit = git(lease.path, "rev-parse", "HEAD");
  const statusOutput = git(lease.path, "status", "--porcelain=v1", "-uno");
  const dirtyFiles = statusOutput ? statusOutput.split("\n").map((line) => line.slice(3)) : [];
  const untrackedOutput = git(lease.path, "ls-files", "--others", "--exclude-standard");
  const untrackedFiles = untrackedOutput
    ? untrackedOutput.split("\n").filter((file) => file && !file.startsWith(".pi-subagents/"))
    : [];

  const changedOutput = headCommit === lease.baseCommit
    ? ""
    : git(lease.path, "diff", "--name-only", `${lease.baseCommit}..${headCommit}`);
  const changedFiles = changedOutput ? changedOutput.split("\n").filter(Boolean) : [];

  let diff = "";
  if (headCommit !== lease.baseCommit) {
    diff = git(lease.path, "diff", `${lease.baseCommit}..${headCommit}`);
  }

  return {
    headCommit,
    baseCommit: lease.baseCommit,
    changedFiles,
    dirtyFiles,
    untrackedFiles,
    diff,
    clean: dirtyFiles.length === 0 && untrackedFiles.length === 0,
    hasCommits: headCommit !== lease.baseCommit,
  };
}

export function assertWorkspaceChangesWithinPaths(inspection, writePaths) {
  if (!inspection || !Array.isArray(inspection.changedFiles)) {
    throw new Error("Invalid inspection result: changedFiles is required");
  }

  if (!Array.isArray(writePaths) || writePaths.length === 0) {
    throw new Error("Invalid writePaths: at least one write path is required");
  }

  const validatedWritePaths = writePaths.map((writePath) => {
    if (typeof writePath !== "string" || writePath.length === 0) {
      throw new Error("Invalid writePaths: each write path must be a non-empty string");
    }
    if (writePath.includes("..")) {
      const parts = writePath.split("/");
      if (parts.includes("..")) {
        throw new Error(`Invalid writePath: ${writePath}`);
      }
    }
    if (writePath.includes("/")) {
      const leadingOrTrailingSlash = writePath.startsWith("/") || writePath.endsWith("/");
      if (leadingOrTrailingSlash) {
        throw new Error(`Invalid writePath: ${writePath}`);
      }
    }

    return describeWritePath(writePath);
  });

  const validPaths = inspection.changedFiles.map((changedFile) => {
    isRepoRelativePosixPath(changedFile, "changed file");
    return changedFile;
  });

  const invalid = [];
  for (const changedFile of validPaths) {
    const matches = validatedWritePaths.some((writePath) => matchesWritePath(writePath, changedFile));
    if (!matches) {
      invalid.push(changedFile);
    }
  }

  if (invalid.length > 0) {
    const sortedInvalid = [...new Set(invalid)].sort();
    const sortedWritePaths = [...new Set(writePaths)].sort();
    throw new Error(
      `writePaths mismatch: changed files outside writePaths: ${sortedInvalid.join(", ")}; writePaths: ${sortedWritePaths.join(", ")}`,
    );
  }
}

export function isExecutorWorkspaceIntegrated(lease, { strategy, executorHead } = {}) {
  const selectedStrategy = strategy || "cherry-pick";
  const checkedHead = executorHead ?? git(lease.path, "rev-parse", "HEAD");

  if (!lease.baseCommit) {
    throw new Error("Invalid lease: missing baseCommit");
  }

  if (selectedStrategy === "merge") {
    try {
      git(lease.originRoot, "merge-base", "--is-ancestor", checkedHead, "HEAD");
      return true;
    } catch (error) {
      if (error?.status === 1) {
        return false;
      }
      throw error;
    }
  }

  if (selectedStrategy === "cherry-pick") {
    const range = git(lease.originRoot, "rev-list", "--max-count=1", `${lease.baseCommit}..${checkedHead}`);
    if (!range.trim()) return false;

    const output = git(lease.originRoot, "cherry", "HEAD", checkedHead, lease.baseCommit);
    const lines = output ? output.split("\n").filter((line) => line.length > 0) : [];

    if (lines.length === 0) {
      const firstParentCommits = git(lease.originRoot, "rev-list", "--first-parent", "HEAD", `^${lease.baseCommit}`);
      const firstParentList = firstParentCommits ? firstParentCommits.split("\n").filter((line) => line.length > 0) : [];
      return firstParentList.includes(checkedHead);
    }

    return lines.every((line) => line.startsWith("-"));
  }

  throw new Error(`Unknown integration strategy: ${selectedStrategy}`);
}

export function integrateExecutorWorkspace(lease, { strategy = "cherry-pick", executorHead } = {}) {
  if (!existsSync(lease.path)) throw new Error("Executor workspace is missing");

  const origin = lease.originRoot;
  const inspection = inspectExecutorWorkspace(lease);

  const selectedExecutorHead = executorHead
    ? git(lease.path, "rev-parse", `${executorHead}^{commit}`)
    : inspection.headCommit;

  if (executorHead && selectedExecutorHead !== inspection.headCommit) {
    throw new Error(
      `executor HEAD mismatch (expected ${selectedExecutorHead}, got ${inspection.headCommit})`,
    );
  }

  if (!inspection.hasCommits || selectedExecutorHead === lease.baseCommit) throw new Error("No commits to integrate");
  if (!inspection.clean) throw new Error("Workspace must be clean before integration (no uncommitted changes)");

  const originHeadBefore = git(origin, "rev-parse", "HEAD");
  const originStatusBefore = git(origin, "status", "--porcelain");

  if (strategy === "cherry-pick") {
    try {
      git(origin, "cherry-pick", `${lease.baseCommit}..${selectedExecutorHead}`);
    } catch (error) {
      let abortError;
      try {
        git(origin, "cherry-pick", "--abort");
      } catch (abortErr) {
        abortError = abortErr;
      }

      const originHeadAfter = git(origin, "rev-parse", "HEAD");
      const originStatusAfter = git(origin, "status", "--porcelain");
      if (originHeadAfter !== originHeadBefore || originStatusAfter !== originStatusBefore) {
        throw abortError || error;
      }
      if (abortError) throw error;
      throw error;
    }
  } else if (strategy === "merge") {
    try {
      git(origin, "merge", "--no-ff", selectedExecutorHead, "-m", `ge: integrate ${lease.goalId}/${lease.taskId}`);
    } catch (error) {
      let abortError;
      try {
        git(origin, "merge", "--abort");
      } catch (abortErr) {
        abortError = abortErr;
      }

      const originHeadAfter = git(origin, "rev-parse", "HEAD");
      const originStatusAfter = git(origin, "status", "--porcelain");
      if (originHeadAfter !== originHeadBefore || originStatusAfter !== originStatusBefore) {
        throw abortError || error;
      }
      if (abortError) throw error;
      throw error;
    }
  } else {
    throw new Error(`Unknown integration strategy: ${strategy}`);
  }

  const newHead = git(origin, "rev-parse", "HEAD");
  return {
    integrated: true,
    executorHead: selectedExecutorHead,
    originHeadBefore,
    newHead,
    strategy,
  };
}

export function inspectExecutorWorkspaceResources(lease) {
  const workspaceExists = existsSync(lease.path);
  const leaseExists = lease.leasePath ? existsSync(lease.leasePath) : false;
  const branchExists = !!git(lease.originRoot, "branch", "--list", lease.branch);

  return { workspaceExists, branchExists, leaseExists };
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
  } else {
    git(origin, "worktree", "prune", "--expire", "now");
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
