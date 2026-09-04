import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

const LEGACY_PATHS = [
  ".pi-subagents",
  ".pi-subagents/**",
  ".state/subagent-dispatch",
  ".state/subagent-dispatch/**",
  ".state/worktree-lifecycle",
  ".state/worktree-lifecycle/**",
];

function failure(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_GIT", `git ${args.join(" ")} failed`, cause);
  }
}

function gitRaw(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_GIT", `git ${args.join(" ")} failed`, cause);
  }
}

function gitSucceeds(cwd, args) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

function pathExists(value) {
  try { lstatSync(value); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw failure("MANAGED_WORKSPACE_IDENTITY", "workspace path cannot be inspected", error);
  }
}

function primaryOrigin(record) {
  const root = realpathSync(record.request.originRoot);
  if (root !== record.request.originRoot || realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw failure("MANAGED_WORKSPACE_IDENTITY", "originRoot is not the canonical Git top-level");
  }
  const dotGit = lstatSync(path.join(root, ".git"));
  if (!dotGit.isDirectory() || dotGit.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_IDENTITY", "originRoot must be the primary worktree");
  return root;
}

function currentRef(cwd) {
  try { return git(cwd, ["symbolic-ref", "--quiet", "HEAD"]); }
  catch (cause) { throw failure("MANAGED_WORKSPACE_IDENTITY", "Git HEAD must be attached", cause); }
}

function userStatus(cwd) {
  const exclusions = LEGACY_PATHS.map((value) => `:(exclude)${value}`);
  return gitRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ...exclusions]);
}

function originPreflight(record, { exactBase = false } = {}) {
  const root = primaryOrigin(record);
  const ref = currentRef(root);
  if (ref !== record.request.originRef) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin branch ref changed");
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (exactBase && head !== record.request.baseCommit) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin HEAD changed before allocation");
  if (!exactBase && !gitSucceeds(root, ["merge-base", "--is-ancestor", record.request.baseCommit, head])) {
    throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin HEAD is not a clean forward advance of baseCommit");
  }
  if (userStatus(root).length !== 0) throw failure("MANAGED_WORKSPACE_ORIGIN_DIRTY", "origin must be clean");
  return { root, ref, head };
}

function registrations(originRoot) {
  const output = gitRaw(originRoot, ["worktree", "list", "--porcelain"]);
  const values = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) values.push(current);
      current = { path: line.slice(9), head: null, branchRef: null, detached: false, locked: false, prunable: false };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branchRef = line.slice(7);
    else if (current && line === "detached") current.detached = true;
    else if (current && line.startsWith("locked")) current.locked = true;
    else if (current && line.startsWith("prunable")) current.prunable = true;
  }
  if (current) values.push(current);
  return values;
}

function registrationFor(record) {
  const target = path.resolve(record.path);
  return registrations(record.request.originRoot).find((entry) => path.resolve(entry.path) === target) ?? null;
}

function commonDir(cwd) {
  const value = git(cwd, ["rev-parse", "--git-common-dir"]);
  return realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function originCommonDir(record) {
  return commonDir(record.request.originRoot);
}

function branchHead(record) {
  if (!gitSucceeds(record.request.originRoot, ["show-ref", "--verify", "--quiet", record.branchRef])) return null;
  return git(record.request.originRoot, ["rev-parse", "--verify", `${record.branchRef}^{commit}`]);
}

function inspectIdentity(record) {
  if (!pathExists(record.path)) throw failure("MANAGED_WORKSPACE_IDENTITY", "managed worktree path is missing");
  const info = lstatSync(record.path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_IDENTITY", "managed worktree path is not a directory");
  const workspacePath = realpathSync(record.path);
  const registration = registrationFor(record);
  if (workspacePath !== record.path || !registration || registration.locked || registration.prunable
      || realpathSync(git(workspacePath, ["rev-parse", "--show-toplevel"])) !== workspacePath
      || commonDir(workspacePath) !== originCommonDir(record)
      || currentRef(workspacePath) !== record.branchRef || registration.branchRef !== record.branchRef) {
    throw failure("MANAGED_WORKSPACE_IDENTITY", "managed worktree Git identity changed");
  }
  const headCommit = git(workspacePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (registration.head !== headCommit || branchHead(record) !== headCommit) {
    throw failure("MANAGED_WORKSPACE_IDENTITY", "managed worktree branch HEAD changed independently");
  }
  return { workspacePath, registration, headCommit };
}

function parseChangedPaths(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      if (index + 1 >= tokens.length) throw failure("MANAGED_WORKSPACE_GIT", "invalid rename/copy diff output");
      files.push(tokens[index++], tokens[index++]);
    } else {
      if (index >= tokens.length) throw failure("MANAGED_WORKSPACE_GIT", "invalid name-status diff output");
      files.push(tokens[index++]);
    }
  }
  return [...new Set(files)].sort();
}

function matchesWritePath(file, allowed) {
  if (allowed.endsWith("/**")) return file.startsWith(`${allowed.slice(0, -3)}/`);
  return file === allowed;
}

export function assertManagedWorkspaceWritePaths(changedFiles, writePaths) {
  const rejected = changedFiles.filter((file) => !writePaths.some((allowed) => matchesWritePath(file, allowed)));
  if (rejected.length > 0) throw failure("MANAGED_WORKSPACE_WRITE_PATHS", `changed files outside writePaths: ${rejected.join(", ")}`);
}

export function ensureManagedGitWorkspace(record) {
  const origin = originPreflight(record, { exactBase: true });
  const exists = pathExists(record.path);
  const registration = registrationFor(record);
  if (exists !== Boolean(registration)) throw failure("MANAGED_WORKSPACE_IDENTITY", "worktree path and registration disagree");
  const existingBranchHead = branchHead(record);
  if (!exists) {
    if (existingBranchHead && existingBranchHead !== record.request.baseCommit) {
      throw failure("MANAGED_WORKSPACE_IDENTITY", "reserved branch moved away from baseCommit");
    }
    mkdirSync(path.dirname(record.path), { recursive: true, mode: 0o700 });
    const branchName = record.branchRef.slice("refs/heads/".length);
    const args = existingBranchHead
      ? ["worktree", "add", record.path, branchName]
      : ["worktree", "add", "-b", branchName, record.path, record.request.baseCommit];
    git(origin.root, args);
  }
  const identity = inspectIdentity(record);
  if (identity.headCommit !== record.request.baseCommit) throw failure("MANAGED_WORKSPACE_IDENTITY", "new worktree HEAD differs from baseCommit");
  if (!pathExists(record.dispatchCwd)) throw failure("MANAGED_WORKSPACE_IDENTITY", "requested cwd is missing from managed worktree");
  return identity;
}

export function inspectManagedGitWorkspace(record) {
  primaryOrigin(record);
  const identity = inspectIdentity(record);
  const descendant = gitSucceeds(identity.workspacePath, ["merge-base", "--is-ancestor", record.request.baseCommit, identity.headCommit]);
  const aheadCommits = descendant
    ? git(identity.workspacePath, ["rev-list", "--reverse", `${record.request.baseCommit}..${identity.headCommit}`]).split("\n").filter(Boolean)
    : [];
  const changedFiles = aheadCommits.length === 0 ? [] : parseChangedPaths(gitRaw(identity.workspacePath, [
    "diff", "-l0", "--name-status", "-z", "--find-renames", "--find-copies-harder", `${record.request.baseCommit}..${identity.headCommit}`,
  ]));
  const dirty = userStatus(identity.workspacePath);
  let origin;
  try { origin = originPreflight(record); }
  catch (error) {
    origin = { root: record.request.originRoot, ref: null, head: null, error: error.code ?? "MANAGED_WORKSPACE_ORIGIN_DRIFT" };
  }
  return {
    headCommit: identity.headCommit,
    baseCommit: record.request.baseCommit,
    descendant,
    aheadCommits,
    aheadCount: aheadCommits.length,
    hasCommits: descendant && aheadCommits.length > 0 && changedFiles.length > 0,
    changedFiles,
    clean: dirty.length === 0,
    originRef: origin.ref,
    originHead: origin.head,
    originClean: !origin.error,
    originError: origin.error ?? null,
  };
}

function sequencerActive(cwd) {
  const gitDirValue = git(cwd, ["rev-parse", "--git-dir"]);
  const gitDir = path.resolve(cwd, gitDirValue);
  return ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]
    .some((name) => existsSync(path.join(gitDir, name)));
}

export function managedWorkspaceAlreadyIntegrated(record, { strategy, executorHead }) {
  const originHead = git(record.request.originRoot, ["rev-parse", "HEAD"]);
  if (strategy === "merge") return gitSucceeds(record.request.originRoot, ["merge-base", "--is-ancestor", executorHead, originHead]);
  if (strategy !== "cherry-pick") throw failure("MANAGED_WORKSPACE_DISPOSITION", "integration strategy is invalid");
  const output = git(record.request.originRoot, ["cherry", originHead, executorHead, record.request.baseCommit]);
  const lines = output.split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith("-"));
}

export function integrateManagedGitWorkspace(record, { strategy, executorHead }) {
  const inspection = inspectManagedGitWorkspace(record);
  if (inspection.headCommit !== executorHead || !inspection.clean || !inspection.descendant || !inspection.hasCommits) {
    throw failure("MANAGED_WORKSPACE_INTEGRATE", "workspace is not a clean committed descendant");
  }
  if (record.request.mode !== "coding") throw failure("MANAGED_WORKSPACE_INTEGRATE", "only coding workspaces can integrate");
  assertManagedWorkspaceWritePaths(inspection.changedFiles, record.request.writePaths);
  const origin = originPreflight(record);
  if (sequencerActive(origin.root)) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin has an active Git sequencer");
  if (managedWorkspaceAlreadyIntegrated(record, { strategy, executorHead })) return { alreadyIntegrated: true, headCommit: origin.head };
  try {
    if (strategy === "cherry-pick") git(origin.root, ["cherry-pick", `${record.request.baseCommit}..${executorHead}`]);
    else if (strategy === "merge") git(origin.root, ["merge", "--no-ff", "--no-edit", executorHead]);
    else throw failure("MANAGED_WORKSPACE_DISPOSITION", "integration strategy is invalid");
  } catch (error) {
    const operation = strategy === "merge" ? "merge" : "cherry-pick";
    if (sequencerActive(origin.root)) {
      try { git(origin.root, [operation, "--abort"]); }
      catch (recoveryError) { throw failure("MANAGED_WORKSPACE_CLEANUP_DEBT", "integration failed and sequencer recovery failed", recoveryError); }
    }
    throw error;
  }
  return { alreadyIntegrated: false, headCommit: git(origin.root, ["rev-parse", "HEAD"]) };
}

export function releaseManagedGitWorkspace(record, { expectedHead } = {}) {
  const exists = pathExists(record.path);
  const registration = registrationFor(record);
  const currentBranchHead = branchHead(record);
  if (exists !== Boolean(registration)) throw failure("MANAGED_WORKSPACE_IDENTITY", "worktree path and registration disagree during release");
  if (exists) {
    const identity = inspectIdentity(record);
    if (expectedHead && identity.headCommit !== expectedHead) throw failure("MANAGED_WORKSPACE_IDENTITY", "workspace HEAD changed before release");
    git(record.request.originRoot, ["worktree", "remove", record.path]);
  }
  const remainingBranchHead = branchHead(record);
  if (remainingBranchHead) {
    if (expectedHead && remainingBranchHead !== expectedHead) throw failure("MANAGED_WORKSPACE_IDENTITY", "managed branch changed before release");
    git(record.request.originRoot, ["branch", "-D", record.branchRef.slice("refs/heads/".length)]);
  } else if (!exists && currentBranchHead === null) {
    return { released: true };
  }
  return { released: true };
}

export function managedWorkspaceSnapshotHash(inspection, terminalProof) {
  const value = {
    headCommit: inspection.headCommit,
    baseCommit: inspection.baseCommit,
    descendant: inspection.descendant,
    aheadCommits: inspection.aheadCommits,
    changedFiles: inspection.changedFiles,
    clean: inspection.clean,
    originRef: inspection.originRef,
    originHead: inspection.originHead,
    originClean: inspection.originClean,
    terminalProof,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function listManagedGitRegistrations(originRoot) {
  return registrations(realpathSync(originRoot)).map((entry) => ({ ...entry }));
}
