import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  // 只清理运行时产物根（.pi/subagents、.pi-subagents 等）；.pi/agents 等
  // tracked 项目配置不得被当作可删元数据（R11：tracked .pi/agents 曾阻塞 discard）。
  ".pi/subagents",
  ".pi-subagents",
  ".state/subagent-dispatch",
  ".state/worktree-lifecycle",
];

class ManagedWorkspaceError extends Error {
  code: string;
  cause?: unknown;
  detail?: GitFailureDetail;
  constructor(code: string, message: string, cause?: unknown, detail?: GitFailureDetail) {
    super(message);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (detail !== undefined) this.detail = detail;
  }
}
type GitRunner = (cwd: string, args: readonly string[]) => string;
type ManagedWorkspaceRecord = { path: string; dispatchCwd: string; branchRef: string; request: { workspaceId: string; originRoot: string; originRef: string; baseCommit: string; policy: { publication: string; application: string; writePaths: string[] } } };
type GitInspection = { headCommit: string; baseCommit: string; descendant: boolean; aheadCommits: string[]; aheadCount: number; hasCommits: boolean; changedFiles: string[]; clean: boolean; originRef: string | null; originHead: string | null; originClean: boolean; originError: string | null };

function failure(code: string, message: string, cause?: unknown, detail?: GitFailureDetail): ManagedWorkspaceError {
  return new ManagedWorkspaceError(code, message, cause, detail);
}

export type GitFailureCategory = "locked" | "sequencer-in-progress" | "path-missing" | "unmerged-entries" | "submodule-dirty" | "dirty-worktree" | "untracked-files" | "ignored-runtime-artifacts" | "unknown";
export type GitFailureDetail = { readonly category: GitFailureCategory; readonly categories: readonly GitFailureCategory[]; readonly gitStderr: string; readonly porcelain?: string; readonly gitStatus?: number; readonly args: readonly string[] };
const GIT_TEXT_MAX_BYTES = 512;
const TOKEN_PATTERN = /managed-workspace-(?:owner|action|lease)\.v1:[A-Za-z0-9._:-]+/g;
const HOME_PATTERN = /\/(?:Users|home)\/[^/\s'"]+/g;
const TMPDIR_PATTERN = /\/(?:private\/)?var\/folders\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?/g;
function truncateUtf8(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  const marker = "…[truncated]";
  if (bytes.length <= GIT_TEXT_MAX_BYTES) return text;
  let end = GIT_TEXT_MAX_BYTES - Buffer.byteLength(marker, "utf8");
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}
export function redactGitText(raw: string, extraRoots: readonly string[] = []): string {
  let text = String(raw).replace(TOKEN_PATTERN, (value) => `${value.split(":")[0]}:[redacted]`);
  for (const root of extraRoots) if (root.length > 1) text = text.split(root).join("<redacted-root>");
  return truncateUtf8(text.replace(TMPDIR_PATTERN, "<tmp>").replace(HOME_PATTERN, "~").trim());
}
const UNMERGED_XY = new Set(["AA", "AU", "UA", "UU", "DU", "UD", "DD"]);
export function classifyPorcelain(porcelain: string, submodulePaths: readonly string[] = []): GitFailureCategory[] {
  const hits = new Set<GitFailureCategory>();
  const tokens = porcelain.includes("\0") ? porcelain.split("\0") : porcelain.split("\n");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]; if (!token) continue;
    const marker = token.slice(0, 2); let entry = token.slice(3);
    if (token.length >= 2 && (marker[0] === "R" || marker[0] === "C") && i + 1 < tokens.length) { entry = tokens[++i]; }
    if (entry.startsWith('"') && entry.endsWith('"')) { try { entry = JSON.parse(entry); } catch {} }
    if (UNMERGED_XY.has(marker)) hits.add("unmerged-entries");
    else if (marker === "!!") hits.add("ignored-runtime-artifacts");
    else if (marker === "??") hits.add("untracked-files");
    else if (submodulePaths.some((sub) => entry === sub || entry.startsWith(`${sub}/`))) hits.add("submodule-dirty");
    else if (/[MADRC]/.test(marker)) hits.add("dirty-worktree");
  }
  return (["unmerged-entries", "submodule-dirty", "dirty-worktree", "untracked-files", "ignored-runtime-artifacts"] as GitFailureCategory[]).filter((c) => hits.has(c));
}
export function classifyGitFailure(input: { args: readonly string[]; cause: unknown; porcelain?: string; submodulePaths?: readonly string[]; extraRedactRoots?: readonly string[] }): GitFailureDetail {
  const { args, cause, porcelain, submodulePaths = [], extraRedactRoots = [] } = input;
  const value = cause as { stderr?: unknown; message?: unknown; status?: unknown };
  const stderr = typeof value?.stderr === "string" ? value.stderr : typeof value?.message === "string" ? value.message : "";
  const categories: GitFailureCategory[] = [];
  const rules: [RegExp, GitFailureCategory][] = [[/index\.lock.*File exists|already locked/i, "locked"], [/interactive rebase|rebase-merge|rebase-apply|cherry-pick.*progress/i, "sequencer-in-progress"], [/does not exist|No such file or directory/i, "path-missing"]];
  for (const [rule, category] of rules) if (rule.test(stderr)) { categories.push(category); break; }
  const hasPorcelain = typeof porcelain === "string" && porcelain.length > 0;
  if (hasPorcelain) categories.push(...classifyPorcelain(porcelain, submodulePaths));
  else if (!categories.length && /modified or untracked|contains modified|Directory not empty/i.test(stderr)) categories.push("dirty-worktree");
  if (!categories.length) categories.push("unknown");
  return Object.freeze({ category: categories[0], categories: Object.freeze([...categories]), gitStderr: redactGitText(stderr || "(git produced no stderr)", extraRedactRoots), ...(hasPorcelain ? { porcelain: redactGitText(porcelain, extraRedactRoots) } : {}), ...(typeof value?.status === "number" ? { gitStatus: value.status } : {}), args: Object.freeze(args.map((arg) => redactGitText(arg, extraRedactRoots))) });
}
function gitFailure(args: readonly string[], cause: unknown, detail?: GitFailureDetail): ManagedWorkspaceError {
  const resolved = detail ?? classifyGitFailure({ args, cause });
  return failure("MANAGED_WORKSPACE_GIT", `git ${resolved.args.join(" ")} failed; category=${resolved.category}; all=[${resolved.categories.join(",")}]; git said: ${resolved.gitStderr}${resolved.porcelain ? `; worktree state: ${resolved.porcelain}` : ""}`, cause, resolved);
}

const git: GitRunner = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw gitFailure(args, cause);
  }
};

const gitRaw: GitRunner = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    throw gitFailure(args, cause);
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

function gitDirectory(cwd: string) {
  const value = git(cwd, ["rev-parse", "--git-dir"]);
  return realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function rebaseDirectory(cwd: string): string | null {
  const gitDir = gitDirectory(cwd);
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const candidate = path.join(gitDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sequencerActive(cwd) {
  const gitDir = gitDirectory(cwd);
  return ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]
    .some((name) => existsSync(path.join(gitDir, name)));
}

const managedGitEnvironment = () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_CONFIG_") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS"].includes(name)) delete env[name];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "/usr/bin/true", GIT_SEQUENCE_EDITOR: "/usr/bin/true", GIT_PAGER: "/bin/cat" };
};

function managedGit(cwd: string, args: readonly string[]) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: managedGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_REBASE", `git ${args.join(" ")} failed`, cause);
  }
}

function unmergedEntries(cwd: string) {
  return managedGit(cwd, ["ls-files", "-u", "-z"]).length > 0;
}

function rebaseConfigurationIsSafe(cwd: string) {
  if (!pathExists(cwd) || !gitSucceeds(cwd, ["rev-parse", "--is-inside-work-tree"])) {
    throw failure("MANAGED_WORKSPACE_IDENTITY", "managed worktree path is missing or unregistered");
  }
  const names = managedGit(cwd, ["config", "--local", "--name-only", "--get-regexp", "."])
    .split("\n").filter(Boolean).map((value) => value.toLowerCase());
  const unsafe = names.some((name) => name === "core.hookspath" || /^merge\..+\.driver$/.test(name) || /^filter\..+\.(?:clean|smudge|process)$/.test(name)
    || name === "rebase.exec" || name === "commit.gpgsign" || name === "gpg.program" || name === "core.editor" || name === "sequence.editor"
    || name === "core.pager" || name.startsWith("pager."));
  const hooks = path.join(commonDir(cwd), "hooks");
  let executableHook = false;
  if (existsSync(hooks)) {
    for (const name of ["pre-rebase", "post-rewrite", "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      const hook = path.join(hooks, name);
      if (existsSync(hook)) { const info = lstatSync(hook); if (info.isFile() && (info.mode & 0o111) !== 0) executableHook = true; }
    }
  }
  if (unsafe || executableHook) throw failure("MANAGED_WORKSPACE_CONFIG", "repository-local executable Git configuration is not permitted");
}

function assertDispatchCwd(record: ManagedWorkspaceRecord, workspacePath: string) {
  if (!pathExists(record.dispatchCwd)) throw failure("MANAGED_WORKSPACE_IDENTITY", "requested cwd is missing from managed worktree");
  const cwd = realpathSync(record.dispatchCwd);
  const relative = path.relative(workspacePath, cwd);
  if (cwd !== record.dispatchCwd || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure("MANAGED_WORKSPACE_IDENTITY", "requested cwd is outside the managed worktree");
  }
}

function continuingIdentity(record: ManagedWorkspaceRecord) {
  if (!pathExists(record.path) || realpathSync(record.path) !== record.path) throw failure("MANAGED_WORKSPACE_IDENTITY", "managed worktree path is invalid");
  const registration = registrationFor(record);
  const directory = rebaseDirectory(record.path);
  if (!directory) throw failure("MANAGED_WORKSPACE_SEQUENCER", "continue requires the active managed rebase");
  const headName = path.join(directory, "head-name");
  if (!registration || registration.locked || registration.prunable || registration.branchRef !== null || !existsSync(headName)
      || readFileSync(headName, "utf8").trim() !== record.branchRef
      || realpathSync(git(record.path, ["rev-parse", "--show-toplevel"])) !== record.path
      || commonDir(record.path) !== originCommonDir(record)) throw failure("MANAGED_WORKSPACE_IDENTITY", "managed rebase identity changed");
  assertDispatchCwd(record, record.path);
  return { workspacePath: record.path, headCommit: git(record.path, ["rev-parse", "--verify", "HEAD^{commit}"]) };
}

function rebaseCandidateFacts(record: ManagedWorkspaceRecord, targetHead: string, state: "completed" | "resolving-conflict") {
  const head = managedGit(record.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const changedFiles = parseChangedPaths(managedGit(record.path, ["diff", "-l0", "--name-status", "-z", "--find-renames", `${targetHead}..${head}`]));
  assertManagedWorkspaceWritePaths(changedFiles, record.request.policy.writePaths);
  if (state === "completed") {
    const identity = inspectIdentity(record);
    if (identity.headCommit !== head || !gitSucceeds(record.path, ["merge-base", "--is-ancestor", targetHead, head])) {
      throw failure("MANAGED_WORKSPACE_REBASE", "candidate identity or ancestry is invalid");
    }
  }
  return { state, head, targetHead, targetAncestor: targetHead, clean: userStatus(record.path).length === 0, sequencerEmpty: !sequencerActive(record.path), changedFiles };
}

type RebaseAdmission = { admissionGeneration?: number; queueLeaseId?: string; validate?: () => { admissionGeneration?: number; queueLeaseId?: string } };
type RebaseOptions = { continue?: boolean; admission?: RebaseAdmission; fault?: (phase: "locked" | "before-git") => void };

function assertRebaseAdmission(admission?: RebaseAdmission) {
  if (!admission) return;
  if (!Number.isSafeInteger(admission.admissionGeneration) || (admission.admissionGeneration ?? 0) <= 0 || typeof admission.queueLeaseId !== "string" || admission.queueLeaseId.length === 0) {
    throw failure("MANAGED_WORKSPACE_QUEUE", "queue admission is invalid");
  }
  if (admission.validate) {
    const current = admission.validate();
    if (current.admissionGeneration !== admission.admissionGeneration || current.queueLeaseId !== admission.queueLeaseId) {
      throw failure("MANAGED_WORKSPACE_QUEUE", "queue admission lease or generation drifted");
    }
  }
}

function assertRebaseTarget(root: string, record: ManagedWorkspaceRecord, targetHead: string) {
  if (currentRef(root) !== record.request.originRef) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "canonical target ref changed");
  if (managedGit(root, ["rev-parse", "--verify", `${record.request.originRef}^{commit}`]) !== targetHead) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "target head drifted");
}

export function managedGitRebase(record: ManagedWorkspaceRecord, targetHead: string, options: RebaseOptions = {}) {
  const continuing = options.continue === true;
  // Inspect executable repository configuration before status/identity commands:
  // attributes can make even `git status` invoke a configured filter.
  rebaseConfigurationIsSafe(record.path);
  const identity = continuing ? continuingIdentity(record) : inspectIdentity(record);
  assertDispatchCwd(record, identity.workspacePath);
  if (identity.workspacePath !== record.path || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(targetHead)) throw failure("MANAGED_WORKSPACE_IDENTITY", "invalid managed rebase identity or target");
  const initialHead = identity.headCommit;
  const root = primaryOrigin(record);
  assertRebaseTarget(root, record, targetHead);
  if (!gitSucceeds(record.path, ["cat-file", "-e", `${targetHead}^{commit}`])) throw failure("MANAGED_WORKSPACE_TARGET", "target is not a commit");
  assertRebaseAdmission(options.admission);
  if (!continuing && (userStatus(record.path).length !== 0 || sequencerActive(record.path))) throw failure("MANAGED_WORKSPACE_DIRTY", "workspace must be clean and have no sequencer");
  if (continuing && !rebaseDirectory(record.path)) throw failure("MANAGED_WORKSPACE_SEQUENCER", "continue requires the active managed rebase");
  const unlock = operationLock(root);
  try {
    options.fault?.("locked");
    assertRebaseTarget(root, record, targetHead);
    assertRebaseAdmission(options.admission);
    const confirmed = continuing ? continuingIdentity(record) : inspectIdentity(record);
    if (confirmed.headCommit !== initialHead) throw failure("MANAGED_WORKSPACE_IDENTITY", "workspace HEAD drifted after admission");
    if (!continuing && (userStatus(record.path).length !== 0 || sequencerActive(record.path))) throw failure("MANAGED_WORKSPACE_DIRTY", "workspace changed after admission");
    options.fault?.("before-git");
    assertRebaseTarget(root, record, targetHead);
    assertRebaseAdmission(options.admission);
    try {
      const safeOverrides = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"];
      managedGit(record.path, continuing ? [...safeOverrides, "rebase", "--continue"] : [...safeOverrides, "rebase", "--no-autostash", targetHead]);
    } catch (cause) {
      if (rebaseDirectory(record.path) && unmergedEntries(record.path)) return rebaseCandidateFacts(record, targetHead, "resolving-conflict");
      throw failure("MANAGED_WORKSPACE_REBASE", "rebase failed; operation preserved", cause);
    }
    assertRebaseTarget(root, record, targetHead);
    assertRebaseAdmission(options.admission);
    return rebaseCandidateFacts(record, targetHead, "completed");
  } finally { unlock(); }
}

export function inspectManagedIntegrationAdmission(record: ManagedWorkspaceRecord, targetRef: string) {
  const source = inspectManagedGitWorkspace(record);
  if (sequencerActive(record.path)) throw failure("MANAGED_WORKSPACE_INTEGRATE", "workspace has an active Git sequencer");
  const root = primaryOrigin(record);
  if (currentRef(root) !== targetRef || targetRef !== record.request.originRef) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "canonical checkout is not on the requested target ref");
  if (sequencerActive(root) || userStatus(root).length !== 0) throw failure("MANAGED_WORKSPACE_ORIGIN_DIRTY", "canonical checkout must be clean and have no active sequencer");
  return { inspection: source, targetHead: git(root, ["rev-parse", "HEAD^{commit}"]) };
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
    const removeArgs = ["worktree", "remove", record.path] as const;
    try { git(record.request.originRoot, removeArgs); }
    catch (cause) {
      let porcelain: string | undefined;
      let submodulePaths: string[] = [];
      try {
        const config = execFileSync("git", ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], { cwd: record.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        submodulePaths = config.split("\n").map((line) => line.split(/\s+/)[1]).filter(Boolean);
      } catch {}
      try { porcelain = execFileSync("git", ["status", "--porcelain", "--ignored=matching", "--untracked-files=all"], { cwd: record.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {}
      const original = cause instanceof ManagedWorkspaceError ? cause.cause : cause;
      const detail = classifyGitFailure({ args: removeArgs, cause: original, porcelain, submodulePaths });
      throw gitFailure(removeArgs, original, detail);
    }
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
function processBirthIdentity(pid: number) {
  const output = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
  if (!output.toString().trim()) throw new Error("process is unavailable");
  return createHash("sha256").update(output).digest("hex");
}
let ownProcessBirthIdentity: string | undefined;
function operationLock(root: string) {
  const lock = path.join(commonDir(root), "pi-managed-workspace-operation.lock");
  const token = randomUUID();
  const owner = { token, pid: process.pid, birthIdentity: ownProcessBirthIdentity ??= processBirthIdentity(process.pid), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const descriptor = openSync(path.join(lock, "owner.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(descriptor, `${JSON.stringify(owner)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      return () => {
        try {
          const observed = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
          if (observed.token === token && observed.pid === process.pid && observed.birthIdentity === owner.birthIdentity) rmSync(lock, { recursive: true });
        } catch (cause) { if (existsSync(lock)) throw cause; }
      };
    } catch (cause: any) {
      if (cause?.code !== "EEXIST") throw failure("MANAGED_WORKSPACE_LOCKED", "repository-wide Git operation lock cannot be created", cause);
      let stale = false;
      try {
        const observed = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
        if (!Number.isSafeInteger(observed.pid) || typeof observed.birthIdentity !== "string") stale = true;
        else {
          try { process.kill(observed.pid, 0); stale = processBirthIdentity(observed.pid) !== observed.birthIdentity; }
          catch (error: any) { stale = error?.code === "ESRCH" || error?.message === "process is unavailable"; }
        }
      } catch {
        try { stale = Date.now() - lstatSync(lock).mtimeMs > 5_000; }
        catch { stale = false; }
      }
      if (!stale) throw failure("MANAGED_WORKSPACE_LOCKED", "repository-wide Git operation lock is held", cause);
      const quarantine = `${lock}.stale-${process.pid}-${randomUUID()}`;
      try { renameSync(lock, quarantine); rmSync(quarantine, { recursive: true, force: true }); }
      catch (recoveryCause) { throw failure("MANAGED_WORKSPACE_LOCKED", "stale repository-wide Git operation lock cannot be recovered", recoveryCause); }
    }
  }
  throw failure("MANAGED_WORKSPACE_LOCKED", "repository-wide Git operation lock is held");
}

export function fastForwardManagedGitWorkspace(input: {
  record: ManagedWorkspaceRecord; targetRef: string; targetHead: string; candidateHead: string;
  fault?: (phase: string) => void;
}) {
  const { record, targetRef, targetHead, candidateHead } = input;
  if (targetRef !== record.request.originRef || !targetRef.startsWith("refs/heads/")) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "target ref is not the workspace canonical origin ref");
  const source = inspectManagedGitWorkspace(record);
  if (source.headCommit !== candidateHead || !source.clean || sequencerActive(record.path) || !gitSucceeds(record.path, ["merge-base", "--is-ancestor", targetHead, candidateHead])) {
    throw failure("MANAGED_WORKSPACE_INTEGRATE", "sealed candidate is not a clean target descendant at workspace HEAD");
  }
  assertManagedWorkspaceWritePaths(parseChangedPaths(gitRaw(record.path, ["diff", "-l0", "--name-status", "-z", "--find-renames", "--find-copies-harder", `${targetHead}..${candidateHead}`])), record.request.policy.writePaths);
  const root = primaryOrigin(record);
  const unlock = operationLock(root);
  try {
    if (currentRef(root) !== targetRef) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "canonical checkout is not on the admitted target ref");
    const before = git(root, ["rev-parse", "HEAD^{commit}"]);
    if (before !== targetHead && before !== candidateHead) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "canonical target advanced outside the admission CAS");
    if (sequencerActive(root) || userStatus(root).length !== 0) throw failure("MANAGED_WORKSPACE_ORIGIN_DIRTY", "canonical checkout must be clean and have no active sequencer");
    input.fault?.("before-merge");
    if (before === targetHead) git(root, ["merge", "--ff-only", candidateHead]);
    input.fault?.("after-merge");
    if (currentRef(root) !== targetRef || git(root, ["rev-parse", "HEAD^{commit}"]) !== candidateHead
        || refValue(root, targetRef) !== candidateHead || sequencerActive(root) || userStatus(root).length !== 0) {
      throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "canonical checkout did not settle at the exact candidate");
    }
    const confirmedSource = inspectManagedGitWorkspace(record);
    if (confirmedSource.headCommit !== candidateHead || !confirmedSource.clean) throw failure("MANAGED_WORKSPACE_INTEGRATE", "source workspace changed during fast-forward");
    return { headCommit: candidateHead, alreadyIntegrated: before === candidateHead };
  } finally { unlock(); }
}

/** 将工作区当前结果固化为独立 tree 和 CAS 保护的 durable ref。 */
export function publishWorkspaceSnapshot(input: {
  record: ManagedWorkspaceRecord; policy: { publication: string; application: string; writePaths: string[] };
  proofId: string; expectedRef?: string | null;
}): PublishedArtifact {
  const { record, policy } = input;
  if (!record?.request || !policy || policy.publication !== "allowed") throw failure("MANAGED_WORKSPACE_POLICY", "publish requires an allowed policy");
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
  if (input.record.request.policy?.application !== "allowed") throw failure("MANAGED_WORKSPACE_POLICY", "apply requires an allowed policy");
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
