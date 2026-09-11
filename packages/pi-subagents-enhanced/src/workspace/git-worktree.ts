import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { createPublishedArtifact, validatePublishedArtifact, type PublishedArtifact } from "./published-artifact.ts";

const LEGACY_PATHS = [
  ".pi",
  ".pi/**",
  ".pi-subagents",
  ".pi-subagents/**",
  ".state/subagent-dispatch",
  ".state/subagent-dispatch/**",
  ".state/worktree-lifecycle",
  ".state/worktree-lifecycle/**",
];

const RUNTIME_METADATA_ROOTS = [
  ".pi",
  ".pi-subagents",
  ".state/subagent-dispatch",
  ".state/worktree-lifecycle",
];

class ManagedWorkspaceError extends Error {
  code: string;
  cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
type GitRunner = (cwd: string, args: readonly string[]) => string;
type ManagedWorkspaceRecord = { path: string; dispatchCwd: string; branchRef: string; request: { workspaceId: string; originRoot: string; originRef: string; baseCommit: string; mode?: string; writePaths?: string[]; policy?: { publication: string; application: string; writePaths: string[] } } };
type GitInspection = { headCommit: string; baseCommit: string; descendant: boolean; aheadCommits: string[]; aheadCount: number; hasCommits: boolean; changedFiles: string[]; clean: boolean; originRef: string | null; originHead: string | null; originClean: boolean; originError: string | null };

function failure(code: string, message: string, cause?: unknown): ManagedWorkspaceError {
  return new ManagedWorkspaceError(code, message, cause);
}

const git: GitRunner = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_GIT", `git ${args.join(" ")} failed`, cause);
  }
};

const gitRaw: GitRunner = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_GIT", `git ${args.join(" ")} failed`, cause);
  }
};

function gitSucceeds(cwd: string, args: readonly string[]): boolean {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

function pathExists(value) {
  try { lstatSync(value); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw failure("MANAGED_WORKSPACE_IDENTITY", "workspace path cannot be inspected", error);
  }
}

function primaryOrigin(record: ManagedWorkspaceRecord) {
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

function removeUntrackedRuntimeMetadata(cwd) {
  for (const relativePath of RUNTIME_METADATA_ROOTS) {
    if (gitRaw(cwd, ["ls-files", "-z", "--", relativePath]).length !== 0) {
      throw failure("MANAGED_WORKSPACE_IDENTITY", `runtime metadata path is tracked: ${relativePath}`);
    }
    rmSync(path.join(cwd, relativePath), { recursive: true, force: true });
  }
}

function originPreflight(record: ManagedWorkspaceRecord, { exactBase = false, requireClean = true }: { exactBase?: boolean; requireClean?: boolean } = {}) {
  const root = primaryOrigin(record);
  const ref = currentRef(root);
  if (ref !== record.request.originRef) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin branch ref changed");
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (exactBase && head !== record.request.baseCommit) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin HEAD changed before allocation");
  if (!exactBase && !gitSucceeds(root, ["merge-base", "--is-ancestor", record.request.baseCommit, head])) {
    throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin HEAD is not a clean forward advance of baseCommit");
  }
  if (requireClean && userStatus(root).length !== 0) throw failure("MANAGED_WORKSPACE_ORIGIN_DIRTY", "origin must be clean");
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

function registrationFor(record: ManagedWorkspaceRecord) {
  const target = path.resolve(record.path);
  return registrations(record.request.originRoot).find((entry) => path.resolve(entry.path) === target) ?? null;
}

function commonDir(cwd) {
  const value = git(cwd, ["rev-parse", "--git-common-dir"]);
  return realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function originCommonDir(record: ManagedWorkspaceRecord) {
  return commonDir(record.request.originRoot);
}

function branchHead(record: ManagedWorkspaceRecord): string | null {
  if (!gitSucceeds(record.request.originRoot, ["show-ref", "--verify", "--quiet", record.branchRef])) return null;
  return git(record.request.originRoot, ["rev-parse", "--verify", `${record.branchRef}^{commit}`]);
}

function inspectIdentity(record: ManagedWorkspaceRecord) {
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

export function ensureManagedGitWorkspace(record: ManagedWorkspaceRecord) {
  const origin = originPreflight(record, { exactBase: true, requireClean: false });
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

export function inspectManagedGitWorkspace(record: ManagedWorkspaceRecord): GitInspection {
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

export function managedWorkspaceAlreadyIntegrated(record: ManagedWorkspaceRecord, { strategy, executorHead }: { strategy: string; executorHead: string }) {
  const originHead = git(record.request.originRoot, ["rev-parse", "HEAD"]);
  if (strategy === "merge") return gitSucceeds(record.request.originRoot, ["merge-base", "--is-ancestor", executorHead, originHead]);
  if (strategy !== "cherry-pick") throw failure("MANAGED_WORKSPACE_DISPOSITION", "integration strategy is invalid");
  const output = git(record.request.originRoot, ["cherry", originHead, executorHead, record.request.baseCommit]);
  const lines = output.split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith("-"));
}

export function integrateManagedGitWorkspace(record: ManagedWorkspaceRecord, { strategy, executorHead }: { strategy: string; executorHead: string }) {
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

export function releaseManagedGitWorkspace(record: ManagedWorkspaceRecord, { expectedHead }: { expectedHead?: string } = {}) {
  const exists = pathExists(record.path);
  const registration = registrationFor(record);
  const currentBranchHead = branchHead(record);
  if (exists !== Boolean(registration)) throw failure("MANAGED_WORKSPACE_IDENTITY", "worktree path and registration disagree during release");
  if (exists) {
    const identity = inspectIdentity(record);
    if (expectedHead && identity.headCommit !== expectedHead) throw failure("MANAGED_WORKSPACE_IDENTITY", "workspace HEAD changed before release");
    removeUntrackedRuntimeMetadata(identity.workspacePath);
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

export function managedWorkspaceSnapshotHash(inspection: GitInspection, terminalProof: unknown) {
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

function gitWithEnv(cwd: string, args: readonly string[], env: Record<string, string>) {
  try { return execFileSync("git", args, { cwd, env: { ...process.env, ...env, GIT_CONFIG_PARAMETERS: "'core.hooksPath=/dev/null'" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (cause) { throw failure("MANAGED_WORKSPACE_GIT", `git ${args.join(" ")} failed`, cause); }
}

function policyDigest(policy: unknown) { return createHash("sha256").update(JSON.stringify(policy)).digest("hex"); }
function treeChangedFiles(cwd: string, base: string, tree: string) {
  return parseChangedPaths(gitRaw(cwd, ["diff-tree", "-r", "--name-status", "-z", "--find-renames", base, tree]));
}
function rejectUnsafeTree(cwd: string, tree: string) {
  const modes = git(cwd, ["ls-tree", "-r", tree]);
  if (modes.split("\n").some((line) => /^(?:120000|160000)\s/.test(line))) throw failure("MANAGED_WORKSPACE_UNSUPPORTED_STATE", "symlink and gitlink entries are not supported");
}
function refValue(cwd: string, ref: string): string | null {
  return gitSucceeds(cwd, ["show-ref", "--verify", "--quiet", ref]) ? git(cwd, ["rev-parse", ref]) : null;
}
function operationLock(root: string) {
  const lock = path.join(commonDir(root), "pi-managed-workspace-operation.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (cause) { throw failure("MANAGED_WORKSPACE_LOCKED", "repository-wide Git operation lock is held", cause); }
  return () => rmSync(lock, { recursive: true, force: true });
}

/** 将工作区当前结果固化为独立 tree 和 CAS 保护的 durable ref。 */
export function publishWorkspaceSnapshot(input: {
  record: ManagedWorkspaceRecord; policy: { publication: string; application: string; writePaths: string[] };
  proofId: string; expectedRef?: string | null;
}): PublishedArtifact {
  const { record, policy } = input;
  if (!record?.request || !policy || policy.publication !== "allowed") throw failure("MANAGED_WORKSPACE_POLICY", "publish requires an allowed v2 policy");
  const identity = inspectIdentity(record);
  const root = primaryOrigin(record);
  const sourceHead = git(identity.workspacePath, ["rev-parse", "HEAD^{commit}"]);
  const baseCommit = record.request.baseCommit;
  rejectUnsafeTree(identity.workspacePath, sourceHead);
  const dirty = userStatus(identity.workspacePath).length !== 0;
  let tree: string;
  let temporaryIndex: string | undefined;
  try {
    if (!dirty) tree = git(identity.workspacePath, ["rev-parse", "HEAD^{tree}"]);
    else {
      temporaryIndex = path.join(mkdtempSync(path.join(path.dirname(identity.workspacePath), ".pi-snapshot-")), "index");
      tree = gitWithEnv(identity.workspacePath, ["read-tree", "HEAD"], { GIT_INDEX_FILE: temporaryIndex });
      gitWithEnv(identity.workspacePath, ["add", "-A", "--", ".", ...LEGACY_PATHS.map((v) => `:(exclude)${v}`)], { GIT_INDEX_FILE: temporaryIndex });
      tree = gitWithEnv(identity.workspacePath, ["write-tree"], { GIT_INDEX_FILE: temporaryIndex });
    }
    rejectUnsafeTree(identity.workspacePath, tree);
    const changedFiles = treeChangedFiles(identity.workspacePath, baseCommit, tree);
    assertManagedWorkspaceWritePaths(changedFiles, policy.writePaths);
    const refName = `refs/pi/workspaces/${record.request.workspaceId}/published`;
    const current = refValue(root, refName);
    const expected = input.expectedRef === undefined ? current : input.expectedRef;
    if (current !== expected) throw failure("MANAGED_WORKSPACE_REF_CAS", "published ref changed concurrently");
    git(root, ["update-ref", refName, tree, expected ?? ""]);
    return createPublishedArtifact({ workspaceId: record.request.workspaceId, baseCommit, publishedTree: tree, sourceHead,
      refName, policyHash: policyDigest(policy), changedFiles, proofId: input.proofId });
  } finally {
    if (temporaryIndex) rmSync(path.dirname(temporaryIndex), { recursive: true, force: true });
  }
}

export function applyPublishedArtifact(input: { record: ManagedWorkspaceRecord; artifact: PublishedArtifact; expectedOriginHead?: string }): { headCommit: string; changedFiles: string[] } {
  const artifact = validatePublishedArtifact(input.artifact);
  const root = primaryOrigin(input.record);
  if (input.record.request.policy?.application !== "allowed") throw failure("MANAGED_WORKSPACE_POLICY", "apply requires an allowed v2 policy");
  const unlock = operationLock(root);
  try {
    if (sequencerActive(root) || userStatus(root).length !== 0) throw failure("MANAGED_WORKSPACE_ORIGIN_DIRTY", "origin must be clean and have no active sequencer");
    const head = git(root, ["rev-parse", "HEAD^{commit}"]);
    if (input.expectedOriginHead && head !== input.expectedOriginHead) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin HEAD changed");
    if (!gitSucceeds(root, ["merge-base", "--is-ancestor", artifact.baseCommit, head])) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "origin is unrelated to published base");
    const changedFiles = treeChangedFiles(root, artifact.baseCommit, artifact.publishedTree);
    assertManagedWorkspaceWritePaths(changedFiles, input.record.request.policy.writePaths);
    rejectUnsafeTree(root, artifact.publishedTree);
    const patch = execFileSync("git", ["diff", "--binary", artifact.baseCommit, artifact.publishedTree], { cwd: root, encoding: "buffer", env: { ...process.env, GIT_CONFIG_PARAMETERS: "'core.hooksPath=/dev/null'" } });
    try { execFileSync("git", ["apply", "--index", "--whitespace=nowarn"], { cwd: root, input: patch, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, GIT_CONFIG_PARAMETERS: "'core.hooksPath=/dev/null'" } }); }
    catch (cause) { throw failure("MANAGED_WORKSPACE_APPLY_CONFLICT", "published tree conflicts with origin", cause); }
    return { headCommit: git(root, ["rev-parse", "HEAD^{commit}"]), changedFiles };
  } finally { unlock(); }
}
