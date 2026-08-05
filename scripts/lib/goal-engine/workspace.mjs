import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitRaw(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function parseChangedPaths(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      if (index + 1 >= tokens.length) throw new Error("Invalid git rename/copy status output");
      paths.push(tokens[index++], tokens[index++]);
    } else {
      if (index >= tokens.length) throw new Error("Invalid git name-status output");
      paths.push(tokens[index++]);
    }
  }
  return [...new Set(paths)].sort();
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

  // A human-readable branch name is not stable enough: persist the full ref.
  let originRef;
  try {
    originRef = git(originRoot, "symbolic-ref", "--quiet", "HEAD");
  } catch {
    throw new Error("Origin ref must be an attached symbolic ref (detached HEAD is not supported)");
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
    originRef,
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
  for (const field of ["originRoot", "baseCommit", "originRef", "branch", "ownerToken", "createdAt"]) {
    if (typeof lease[field] !== "string" || !lease[field]) {
      throw new Error(`Executor workspace lease ${field} is invalid`);
    }
  }

  return { ...lease, leasePath };
}

function isRuntimePath(file) {
  return file.startsWith(".pi-subagents/");
}

function parsePorcelainStatus(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const dirtyFiles = [];
  const untrackedFiles = [];
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index++];
    if (!record || record.length < 4) throw new Error("Invalid git porcelain status output");
    const status = record.slice(0, 2);
    const paths = [record.slice(3)];
    if (/[RC]/.test(status)) {
      if (index >= tokens.length) throw new Error("Invalid git porcelain rename/copy status output");
      paths.push(tokens[index++]);
    }
    if (paths.some((file) => !file)) throw new Error("Invalid git porcelain status path");
    if (paths.every(isRuntimePath)) continue;
    if (status === "??") untrackedFiles.push(...paths);
    else dirtyFiles.push(...paths);
  }
  return { dirtyFiles: [...new Set(dirtyFiles)].sort(), untrackedFiles: [...new Set(untrackedFiles)].sort() };
}

function assertExecutorWorkspaceIdentity(lease) {
  if (!existsSync(lease.path)) throw new Error("Executor workspace is missing");
  const workspacePath = realpathSync(lease.path);
  const originPath = realpathSync(lease.originRoot);
  const workspaceTopLevel = realpathSync(git(workspacePath, "rev-parse", "--show-toplevel"));
  const originTopLevel = realpathSync(git(originPath, "rev-parse", "--show-toplevel"));
  if (workspaceTopLevel !== workspacePath || originTopLevel !== originPath) {
    throw new Error("Executor workspace identity top-level mismatch");
  }
  const workspaceCommonDir = realpathSync(path.resolve(workspacePath, git(workspacePath, "rev-parse", "--git-common-dir")));
  const originCommonDir = realpathSync(path.resolve(originPath, git(originPath, "rev-parse", "--git-common-dir")));
  if (workspaceCommonDir !== originCommonDir) throw new Error("Executor workspace identity common dir mismatch");
  const liveRef = git(workspacePath, "symbolic-ref", "--quiet", "HEAD");
  const expectedRef = `refs/heads/${lease.branch}`;
  if (liveRef !== expectedRef) throw new Error("Executor workspace identity live branch mismatch");
  return workspacePath;
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function treeChanged(cwd, baseCommit, headCommit) {
  try {
    git(cwd, "diff", "--quiet", baseCommit, headCommit);
    return false;
  } catch (error) {
    if (error?.status === 1) return true;
    throw error;
  }
}

export function inspectExecutorWorkspace(lease) {
  const workspacePath = assertExecutorWorkspaceIdentity(lease);
  const headCommit = git(workspacePath, "rev-parse", "HEAD");
  if (git(workspacePath, "rev-parse", lease.branch) !== headCommit) {
    throw new Error("Executor workspace identity branch HEAD mismatch");
  }
  const descendant = isAncestor(workspacePath, lease.baseCommit, headCommit);
  const aheadCommits = descendant ? git(workspacePath, "rev-list", `${lease.baseCommit}..${headCommit}`).split("\n").filter(Boolean) : [];
  const changed = descendant && aheadCommits.length > 0 && treeChanged(workspacePath, lease.baseCommit, headCommit);
  const status = parsePorcelainStatus(gitRaw(workspacePath, "status", "--porcelain=v1", "-z"));
  const endHead = git(workspacePath, "rev-parse", "HEAD");
  if (endHead !== headCommit) throw new Error("Executor workspace HEAD changed during inspection");

  const changedOutput = changed
    ? gitRaw(workspacePath, "diff", "-l0", "--name-status", "-z", "--find-renames", "--find-copies-harder", `${lease.baseCommit}..${headCommit}`)
    : "";
  const changedFiles = changedOutput ? parseChangedPaths(changedOutput) : [];
  const diff = changed ? git(workspacePath, "diff", `${lease.baseCommit}..${headCommit}`) : "";
  if (git(workspacePath, "rev-parse", "HEAD") !== headCommit) {
    throw new Error("Executor workspace HEAD changed during inspection");
  }

  return {
    headCommit,
    baseCommit: lease.baseCommit,
    descendant,
    aheadCommits,
    aheadCount: aheadCommits.length,
    treeChanged: changed,
    changedFiles,
    ...status,
    diff,
    clean: status.dirtyFiles.length === 0 && status.untrackedFiles.length === 0,
    hasCommits: descendant && aheadCommits.length > 0 && changed,
  };
}

const PERSISTED_LEASE_FIELDS = ["goalId", "taskId", "attempt", "originRoot", "stateRoot", "baseCommit", "originRef", "path", "branch", "ownerToken", "createdAt"];

function probePath(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function inspectionSnapshot(inspection) {
  return JSON.stringify({
    headCommit: inspection.headCommit, baseCommit: inspection.baseCommit, descendant: inspection.descendant,
    aheadCommits: inspection.aheadCommits, aheadCount: inspection.aheadCount, treeChanged: inspection.treeChanged,
    changedFiles: inspection.changedFiles, dirtyFiles: inspection.dirtyFiles, untrackedFiles: inspection.untrackedFiles,
    clean: inspection.clean, hasCommits: inspection.hasCommits, diff: inspection.diff,
  });
}

export function inspectOrphanedExecutorWorkspace({ goalId, taskId, attempt, originRoot, stateRoot }, { inspectExecutorWorkspaceFn = inspectExecutorWorkspace } = {}) {
  safeId(goalId, "goalId");
  safeId(taskId, "taskId");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  if (typeof originRoot !== "string" || !path.isAbsolute(originRoot)) throw new Error("Invalid originRoot");
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) throw new Error("Invalid stateRoot");
  if (typeof inspectExecutorWorkspaceFn !== "function") throw new Error("Invalid inspectExecutorWorkspaceFn");

  const expected = workspacePaths(stateRoot, goalId, taskId, attempt);
  const branch = `ge/${goalId}/${taskId}/${attempt}`;
  const resources = { workspaceExists: null, branchExists: null, leaseExists: null };
  const probeErrors = {};
  const probe = (field, fn) => {
    try {
      resources[field] = fn();
    } catch (error) {
      probeErrors[field] = error instanceof Error ? error.message : String(error);
    }
  };
  // Probe each exact resource independently. An unknown resource is not absent,
  // and every probe must run so the result records the complete observation.
  probe("workspaceExists", () => probePath(expected.workspacePath));
  probe("leaseExists", () => probePath(expected.leasePath));
  probe("branchExists", () => refExists(originRoot, `refs/heads/${branch}`));
  if (Object.keys(probeErrors).length > 0) {
    return { kind: "unverified", resources, error: probeErrors };
  }
  try {
    if (!resources.workspaceExists && !resources.branchExists && !resources.leaseExists) return { kind: "none", resources };
    if (!resources.workspaceExists || !resources.branchExists || !resources.leaseExists) {
      return { kind: "unverified", resources, observed: "partial executor workspace resources" };
    }

    const canonicalSnapshot = () => {
      const leaseText = readFileSync(expected.leasePath, "utf8");
      const lease = JSON.parse(leaseText);
      if (!lease || typeof lease !== "object" || Array.isArray(lease)
        || Object.getPrototypeOf(lease) !== Object.prototype
        || JSON.stringify(Object.keys(lease).sort()) !== JSON.stringify([...PERSISTED_LEASE_FIELDS].sort())
        || lease.goalId !== goalId || lease.taskId !== taskId || lease.attempt !== attempt || lease.branch !== branch
        || ["originRoot", "stateRoot", "baseCommit", "originRef", "path", "ownerToken", "createdAt"].some((field) => typeof lease[field] !== "string" || !lease[field])
        || ["originRoot", "stateRoot", "path"].some((field) => !path.isAbsolute(lease[field]))) {
        throw new Error("invalid persisted lease envelope");
      }
      const queryOrigin = realpathSync(originRoot);
      const queryState = realpathSync(stateRoot);
      const queryPath = realpathSync(expected.workspacePath);
      const persistedOrigin = realpathSync(lease.originRoot);
      const persistedState = realpathSync(lease.stateRoot);
      const persistedPath = realpathSync(lease.path);
      const persistedExpectedPath = realpathSync(workspacePaths(lease.stateRoot, goalId, taskId, attempt).workspacePath);
      if (queryOrigin !== persistedOrigin || queryState !== persistedState || persistedPath !== queryPath || persistedPath !== persistedExpectedPath) {
        throw new Error("persisted lease identity mismatch");
      }
      const currentOriginRef = git(persistedOrigin, "symbolic-ref", "--quiet", "HEAD");
      if (currentOriginRef !== lease.originRef) throw new Error("origin ref mismatch");
      const workspaceHead = git(persistedPath, "rev-parse", "HEAD");
      return {
        leaseText, lease, persistedOrigin, persistedState, persistedPath, currentOriginRef, workspaceHead,
        pinnedLease: { ...lease, originRoot: persistedOrigin, stateRoot: persistedState, path: persistedPath },
      };
    };

    const first = canonicalSnapshot();
    // A supplied callback is only a deterministic scheduling barrier. Its
    // result is deliberately ignored; verified facts always come from the
    // production inspector.
    if (inspectExecutorWorkspaceFn !== inspectExecutorWorkspace) {
      inspectExecutorWorkspaceFn(first.pinnedLease);
    }
    const firstInspection = inspectExecutorWorkspace(first.pinnedLease);
    const second = canonicalSnapshot();
    if (first.leaseText !== second.leaseText || first.persistedOrigin !== second.persistedOrigin
      || first.persistedState !== second.persistedState || first.persistedPath !== second.persistedPath
      || first.currentOriginRef !== second.currentOriginRef || first.workspaceHead !== second.workspaceHead
      || firstInspection.headCommit !== first.workspaceHead) {
      return { kind: "unverified", resources, observed: "executor workspace identity changed during inspection" };
    }
    const secondInspection = inspectExecutorWorkspace(second.pinnedLease);
    const third = canonicalSnapshot();
    if (second.leaseText !== third.leaseText || second.persistedOrigin !== third.persistedOrigin
      || second.persistedState !== third.persistedState || second.persistedPath !== third.persistedPath
      || second.currentOriginRef !== third.currentOriginRef || second.workspaceHead !== third.workspaceHead
      || secondInspection.headCommit !== second.workspaceHead
      || inspectionSnapshot(firstInspection) !== inspectionSnapshot(secondInspection)) {
      return { kind: "unverified", resources, observed: "executor workspace inspection changed during verification" };
    }
    if (!secondInspection.descendant) return { kind: "unverified", resources, observed: "executor HEAD is not a descendant of base" };
    const persistedLease = Object.fromEntries(PERSISTED_LEASE_FIELDS.map((field) => [field, second.lease[field]]));
    return {
      kind: "verified", resources,
      lease: { ...persistedLease, leasePath: workspacePaths(persistedLease.stateRoot, goalId, taskId, attempt).leasePath },
      inspection: secondInspection, executorHead: secondInspection.headCommit,
    };
  } catch (error) {
    return { kind: "unverified", resources, error: error instanceof Error ? error.message : String(error) };
  }
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

function refExists(cwd, ref) {
  try {
    git(cwd, "rev-parse", "-q", "--verify", ref);
    return true;
  } catch (error) {
    // rev-parse uses status 1 for an absent ref. Infrastructure failures must not
    // be mistaken for absence, because that would bypass the fail-closed gate.
    if (error?.status === 1) return false;
    throw error;
  }
}

function hasRebaseState(cwd) {
  const gitDir = git(cwd, "rev-parse", "--git-dir");
  const absoluteGitDir = path.resolve(cwd, gitDir);
  return existsSync(path.join(absoluteGitDir, "rebase-merge")) || existsSync(path.join(absoluteGitDir, "rebase-apply"));
}

function hasSequencerState(cwd) {
  const gitDir = git(cwd, "rev-parse", "--git-dir");
  return existsSync(path.join(path.resolve(cwd, gitDir), "sequencer"));
}

function originIsRestored(origin, { originRef, originHeadBefore }) {
  try {
    return git(origin, "symbolic-ref", "--quiet", "HEAD") === originRef
      && git(origin, "rev-parse", "HEAD") === originHeadBefore
      && userVisibleStatus(origin).length === 0
      && !["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD"].some((ref) => refExists(origin, ref))
      && !hasRebaseState(origin)
      && !hasSequencerState(origin);
  } catch {
    return false;
  }
}

function restoreGoalSequencer(origin, { strategy, originRef, originHeadBefore }) {
  let currentRef;
  try { currentRef = git(origin, "symbolic-ref", "--quiet", "HEAD"); } catch {
    throw new Error("Goal sequencer recovery identity mismatch; manual recovery required");
  }
  if (currentRef !== originRef) {
    throw new Error("Goal sequencer recovery identity mismatch; manual recovery required");
  }
  try {
    git(origin, strategy, "--abort");
  } catch {
    throw new Error("Goal sequencer abort failed; manual recovery required");
  }
  if (originIsRestored(origin, { originRef, originHeadBefore })) return;

  // Git may report abort success while refusing to rewind a commit made before
  // its process died. Ownership and the attached ref were checked by the caller.
  if (git(origin, "symbolic-ref", "--quiet", "HEAD") !== originRef || userVisibleStatus(origin).length > 0) {
    throw new Error("Goal sequencer abort did not safely restore origin; manual recovery required");
  }
  git(origin, "reset", "--hard", originHeadBefore);
  if (!originIsRestored(origin, { originRef, originHeadBefore })) {
    throw new Error("Goal sequencer compensation did not restore origin; manual recovery required");
  }
}

function userVisibleStatus(origin) {
  const status = git(origin, "status", "--porcelain=v1");
  return status.split("\n").filter((line) => line && line.slice(3) !== ".state/" && !line.slice(3).startsWith(".state/goal-engine/"));
}

function assertOriginPreflight(origin, { originRef, originHeadBefore }) {
  let currentRef;
  try { currentRef = git(origin, "symbolic-ref", "--quiet", "HEAD"); } catch { throw new Error("Origin ref preflight failed: detached HEAD"); }
  if (currentRef !== originRef) throw new Error(`Origin ref mismatch (expected ${originRef}, got ${currentRef})`);
  const currentHead = git(origin, "rev-parse", "HEAD");
  if (originHeadBefore && currentHead !== originHeadBefore) throw new Error("Origin HEAD mismatch before integration");
  if (userVisibleStatus(origin).length > 0) throw new Error("Origin must be clean before integration");
  if (["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD"].some((ref) => refExists(origin, ref)) || hasRebaseState(origin)) {
    throw new Error("Origin Git sequencer is active; refusing to modify user operation");
  }
  return currentHead;
}

function goalOwnsSequencer(origin, strategy, lease, executorHead) {
  const marker = strategy === "cherry-pick" ? "CHERRY_PICK_HEAD" : "MERGE_HEAD";
  if (!refExists(origin, marker)) return false;
  const marked = git(origin, "rev-parse", marker);
  if (strategy === "merge") return marked === executorHead;
  try {
    // The marker must be selected by the same base..executor range that the
    // integration command cherry-picks. An executor ancestor at or before the
    // base is a user operation, not evidence of Goal ownership.
    git(lease.path, "merge-base", "--is-ancestor", marked, executorHead);
    try {
      git(lease.path, "merge-base", "--is-ancestor", marked, lease.baseCommit);
      return false;
    } catch (error) {
      if (error?.status === 1) return true;
      throw error;
    }
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function recoverGoalSequencer(origin, { strategy, lease, executorHead, originRef, originHeadBefore }) {
  const marker = strategy === "cherry-pick" ? "CHERRY_PICK_HEAD" : "MERGE_HEAD";
  const otherMarkers = strategy === "cherry-pick" ? ["MERGE_HEAD", "REVERT_HEAD"] : ["CHERRY_PICK_HEAD", "REVERT_HEAD"];
  if (!refExists(origin, marker)) return false;
  const currentRef = git(origin, "symbolic-ref", "--quiet", "HEAD");
  if (currentRef !== originRef || git(origin, "rev-parse", "HEAD") !== originHeadBefore) {
    throw new Error("Goal sequencer recovery identity mismatch; preserving Git operation");
  }
  if (otherMarkers.some((ref) => refExists(origin, ref)) || hasRebaseState(origin)) return false;
  if (!goalOwnsSequencer(origin, strategy, lease, executorHead)) {
    throw new Error("Git sequencer is not provably owned by this Goal; preserving Git operation");
  }
  restoreGoalSequencer(origin, { strategy, originRef, originHeadBefore });
  return true;
}

export function integrateExecutorWorkspace(lease, { strategy = "cherry-pick", executorHead, originRef = lease.originRef, originHeadBefore } = {}) {
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

  if (typeof originRef !== "string" || !originRef) throw new Error("Invalid lease: missing originRef");
  if (!["cherry-pick", "merge"].includes(strategy)) throw new Error(`Unknown integration strategy: ${strategy}`);
  const expectedOriginHead = originHeadBefore || git(origin, "rev-parse", "HEAD");
  // A crash may leave only this Goal's conflict sequencer. Recover it only after
  // checking every persisted identity; user and ambiguous sequencers stay intact.
  recoverGoalSequencer(origin, { strategy, lease, executorHead: selectedExecutorHead, originRef, originHeadBefore: expectedOriginHead });
  assertOriginPreflight(origin, { originRef, originHeadBefore: expectedOriginHead });

  const run = strategy === "cherry-pick"
    ? () => git(origin, "cherry-pick", `${lease.baseCommit}..${selectedExecutorHead}`)
    : strategy === "merge"
      ? () => git(origin, "merge", "--no-ff", selectedExecutorHead, "-m", `ge: integrate ${lease.goalId}/${lease.taskId}`)
      : null;
  if (!run) {
    throw new Error(`Unknown integration strategy: ${strategy}`);
  }
  try {
    run();
  } catch (error) {
    // Abort only a sequencer demonstrably created by this invocation.
    if (goalOwnsSequencer(origin, strategy, lease, selectedExecutorHead)) {
      try {
        restoreGoalSequencer(origin, { strategy, originRef, originHeadBefore: expectedOriginHead });
      } catch (recoveryError) {
        throw new Error(`Integration failed and origin requires manual recovery: ${recoveryError.message}`);
      }
    }
    throw error;
  }

  const newHead = git(origin, "rev-parse", "HEAD");
  return {
    integrated: true,
    executorHead: selectedExecutorHead,
    originHeadBefore: expectedOriginHead,
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

function assertPreservedCleanupFence(lease, expectedExecutorHead, requireClean) {
  try {
    const paths = workspacePaths(lease.stateRoot, lease.goalId, lease.taskId, lease.attempt);
    let persisted;
    try {
      persisted = JSON.parse(readFileSync(paths.leasePath, "utf8"));
    } catch (error) {
      throw new Error(`Executor workspace lease is invalid: ${lease.goalId}/${lease.taskId}/${lease.attempt}`);
    }

    if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)
      || Object.getPrototypeOf(persisted) !== Object.prototype
      || JSON.stringify(Object.keys(persisted).sort()) !== JSON.stringify([...PERSISTED_LEASE_FIELDS].sort())) {
      throw new Error("Executor workspace lease envelope is invalid");
    }

    const expected = {
      goalId: lease.goalId,
      taskId: lease.taskId,
      attempt: lease.attempt,
      stateRoot: path.resolve(lease.stateRoot),
      path: paths.workspacePath,
      originRoot: lease.originRoot,
      baseCommit: lease.baseCommit,
      originRef: lease.originRef,
      branch: lease.branch,
      ownerToken: lease.ownerToken,
      createdAt: lease.createdAt,
    };
    for (const field of PERSISTED_LEASE_FIELDS) {
      if (persisted[field] !== expected[field]) {
        throw new Error(`Executor workspace lease ${field} does not match`);
      }
    }

    const inspectedLease = { ...persisted, leasePath: paths.leasePath };
    const inspection = inspectExecutorWorkspace(inspectedLease);
    if (inspection.headCommit !== expectedExecutorHead) {
      throw new Error(`HEAD mismatch (expected ${expectedExecutorHead}, got ${inspection.headCommit})`);
    }
    if (requireClean && !inspection.clean) throw new Error("workspace must be clean");
    return inspectedLease;
  } catch (error) {
    throw new Error(`workspace identity fence failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function releaseExecutorWorkspace(lease, { disposition, expectedExecutorHead, requireClean, beforeDestructiveCleanupFn } = {}) {
  const validDispositions = ["integrated-cleanup", "failed-cleanup", "discarded-cleanup", "preserved"];
  if (!validDispositions.includes(disposition)) throw new Error(`Invalid disposition: ${disposition}`);
  const fenced = expectedExecutorHead !== undefined || requireClean !== undefined || beforeDestructiveCleanupFn !== undefined;
  if (fenced && (disposition !== "discarded-cleanup"
    || typeof expectedExecutorHead !== "string" || !expectedExecutorHead
    || requireClean !== true
    || (beforeDestructiveCleanupFn !== undefined && typeof beforeDestructiveCleanupFn !== "function"))) {
    throw new Error("Invalid preserved cleanup fence options");
  }

  if (disposition === "preserved") return { released: false, preserved: true, disposition };

  const origin = lease.originRoot;
  let fencedLease;
  if (fenced) {
    fencedLease = assertPreservedCleanupFence(lease, expectedExecutorHead, requireClean);
    try {
      // This is a scheduling barrier only; its result is never trusted.
      beforeDestructiveCleanupFn?.(fencedLease);
    } catch (error) {
      throw new Error(`workspace identity fence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    fencedLease = assertPreservedCleanupFence(lease, expectedExecutorHead, requireClean);
  }

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
    if (fenced) git(origin, "update-ref", "-d", `refs/heads/${fencedLease.branch}`, expectedExecutorHead);
    else git(origin, "branch", "-D", lease.branch);
  }

  if (lease.leasePath && existsSync(lease.leasePath)) rmSync(lease.leasePath, { force: true });
  return { released: true, preserved: false, disposition };
}
