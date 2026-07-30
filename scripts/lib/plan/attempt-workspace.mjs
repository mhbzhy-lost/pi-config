import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runPlanGit } from "./workspace.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DISPOSITIONS = new Set([
  "integrated-cleanup",
  "cancelled-cleanup",
  "failed-preserve",
  "conflict-preserve",
  "attention-preserve",
  "superseded-cleanup",
  "superseded-preserve",
]);
const PRESERVE_DISPOSITIONS = new Set(["failed-preserve", "conflict-preserve", "attention-preserve", "superseded-preserve"]);
const ALLOWED_STATUS = {
  "integrated-cleanup": new Set(["integrated"]),
  "cancelled-cleanup": new Set(["cancelled"]),
  "failed-preserve": new Set(["failed"]),
  "conflict-preserve": new Set(["succeeded", "validated", "failed"]),
  "attention-preserve": new Set(["waiting-attention"]),
  "superseded-cleanup": new Set(["superseded"]),
  "superseded-preserve": new Set(["superseded"]),
};

function fail(message) {
  throw new Error(message);
}

function safeId(value, field) {
  if (typeof value !== "string" || !ID.test(value) || value.includes("..")) fail(`Invalid ${field}`);
  return value;
}

function attemptSequence(attemptId) {
  const match = attemptId.match(/-(\d+)$/);
  if (!match) fail("Invalid attemptId sequence");
  return match[1];
}

function pathsFor(stateRoot, planId, attemptId) {
  const root = path.resolve(stateRoot);
  const attemptsRoot = path.resolve(root, "var", "plan-worktrees", planId, "attempts");
  const workspacePath = path.resolve(attemptsRoot, attemptId);
  const relative = path.relative(attemptsRoot, workspacePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("Attempt workspace path escapes attempts root");
  const stateDirectory = path.resolve(root, "var", "plan-runs", planId, "attempts", attemptId);
  return {
    workspacePath,
    stateDirectory,
    leasePath: path.join(stateDirectory, "workspace.json"),
    failurePath: path.join(stateDirectory, "release-failure.json"),
    statusPath: path.resolve(root, "var", "plan-runs", planId, "status.json"),
  };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writePrivateAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

function coreLease(lease) {
  return {
    planId: lease.planId,
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    originRoot: lease.originRoot,
    stateRoot: lease.stateRoot,
    baseCommit: lease.baseCommit,
    path: lease.path,
    branch: lease.branch,
    ownerToken: lease.ownerToken,
    createdAt: lease.createdAt,
    ...(lease.releaseHead ? { releaseHead: lease.releaseHead } : {}),
  };
}

async function assertRepositoryIdentity({ originRoot, path: workspacePath, branch }) {
  try {
    const commonDirectory = async (repository) => {
      const directory = await runPlanGit(repository, "rev-parse", "--git-common-dir");
      if (!directory) throw new Error("missing Git common directory");
      return await realpath(path.resolve(repository, directory));
    };
    const [originCommonDirectory, workspaceCommonDirectory, workspaceBranch] = await Promise.all([
      commonDirectory(originRoot),
      commonDirectory(workspacePath),
      runPlanGit(workspacePath, "branch", "--show-current"),
    ]);
    if (workspaceCommonDirectory !== originCommonDirectory || workspaceBranch !== branch) {
      fail("Authoritative attempt workspace repository identity does not match origin");
    }
  } catch (error) {
    if (error instanceof Error && /repository identity/.test(error.message)) throw error;
    fail("Authoritative attempt workspace repository identity does not match origin");
  }
}

async function readAuthoritativeLease(lease) {
  if (!lease || typeof lease !== "object") fail("Invalid attempt workspace lease");
  const planId = safeId(lease.planId, "planId");
  const attemptId = safeId(lease.attemptId, "attemptId");
  safeId(lease.taskId, "taskId");
  const paths = pathsFor(lease.stateRoot, planId, attemptId);
  let stored;
  try {
    stored = JSON.parse(await readFile(paths.leasePath, "utf8"));
  } catch {
    fail("Unknown attempt workspace lease owner");
  }
  for (const field of ["planId", "taskId", "attemptId", "originRoot", "stateRoot", "baseCommit", "path", "branch", "ownerToken", "createdAt"]) {
    if (lease[field] !== stored[field]) fail("Attempt workspace lease owner does not match");
  }
  if (stored.path !== paths.workspacePath || lease.leasePath !== paths.leasePath) fail("Attempt workspace lease path does not match owner");
  if (await exists(stored.path)) {
    const resolvedRoot = await realpath(path.dirname(stored.path));
    const resolvedPath = await realpath(stored.path);
    if (path.relative(resolvedRoot, resolvedPath).startsWith("..")) fail("Attempt workspace path escapes owner root");
    await assertRepositoryIdentity(stored);
  }
  return { ...stored, leasePath: paths.leasePath, failurePath: paths.failurePath, statusPath: paths.statusPath };
}

async function untrackedFiles(workspacePath) {
  const output = await runPlanGit(workspacePath, "ls-files", "--others", "--exclude-standard", "-z");
  return output ? output.split("\0").filter((file) => file && !file.startsWith(".pi-subagents/")).sort() : [];
}

async function inspectOwnedWorkspace(owner) {
  const tracked = await runPlanGit(owner.path, "status", "--porcelain=v1", "-uno");
  const dirtyTrackedFiles = tracked ? tracked.split("\n").map((line) => line.slice(3)) : [];
  const untracked = await untrackedFiles(owner.path);
  return {
    headCommit: await runPlanGit(owner.path, "rev-parse", "HEAD"),
    dirtyTrackedFiles,
    untrackedFiles: untracked,
    clean: dirtyTrackedFiles.length === 0 && untracked.length === 0,
  };
}

async function recoverExactLease({ planId, taskId, attemptId, originRoot, stateRoot, baseCommit, paths, branch }) {
  let stored;
  try {
    stored = JSON.parse(await readFile(paths.leasePath, "utf8"));
  } catch {
    fail("Authoritative attempt workspace lease is invalid");
  }
  const expected = { planId, taskId, attemptId, originRoot, stateRoot, baseCommit, path: paths.workspacePath, branch };
  for (const [field, value] of Object.entries(expected)) {
    if (stored?.[field] !== value) fail("Authoritative attempt workspace lease does not match allocation");
  }
  if (typeof stored.ownerToken !== "string" || !stored.ownerToken || typeof stored.createdAt !== "string" || !stored.createdAt) {
    fail("Authoritative attempt workspace lease is invalid");
  }
  if (!(await exists(stored.path))) fail("Attempt workspace is missing");
  let workspaceHead;
  let workspaceStatus;
  try {
    await assertRepositoryIdentity(stored);
    workspaceHead = await runPlanGit(stored.path, "rev-parse", "HEAD");
    workspaceStatus = await runPlanGit(stored.path, "status", "--porcelain=v1", "--untracked-files=all");
  } catch {
    fail("Authoritative attempt workspace repository identity does not match allocation");
  }
  if (workspaceHead !== stored.baseCommit) fail("Authoritative attempt workspace identity does not match allocation");
  if (workspaceStatus) fail("Authoritative attempt workspace is not clean");
  return { ...stored, leasePath: paths.leasePath };
}

export async function allocateAttemptWorkspace(input) {
  const planId = safeId(input?.planId, "planId");
  const taskId = safeId(input?.taskId, "taskId");
  const attemptId = safeId(input?.attemptId, "attemptId");
  if (typeof input.originRoot !== "string" || typeof input.stateRoot !== "string" || typeof input.baseCommit !== "string" || !input.baseCommit) {
    fail("originRoot, stateRoot, and baseCommit are required");
  }
  const originRoot = await realpath(input.originRoot);
  const stateRoot = path.resolve(input.stateRoot);
  const paths = pathsFor(stateRoot, planId, attemptId);
  const branch = `pi-plan-attempt/${planId}/${taskId}/${attemptSequence(attemptId)}`;
  if (await exists(paths.leasePath)) {
    return recoverExactLease({ planId, taskId, attemptId, originRoot, stateRoot, baseCommit: input.baseCommit, paths, branch });
  }
  if (await exists(paths.workspacePath)) fail("Attempt workspace already exists");
  if (await runPlanGit(originRoot, "branch", "--list", branch)) fail(`Attempt branch already exists: ${branch}`);
  await runPlanGit(originRoot, "rev-parse", "--verify", `${input.baseCommit}^{commit}`);
  await mkdir(path.dirname(paths.workspacePath), { recursive: true });
  await runPlanGit(originRoot, "worktree", "add", "-b", branch, paths.workspacePath, input.baseCommit);
  const lease = {
    planId,
    taskId,
    attemptId,
    originRoot,
    stateRoot,
    baseCommit: input.baseCommit,
    path: paths.workspacePath,
    branch,
    ownerToken: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    await writePrivateAtomic(paths.leasePath, lease);
  } catch (error) {
    await runPlanGit(originRoot, "worktree", "remove", paths.workspacePath);
    await runPlanGit(originRoot, "update-ref", "-d", `refs/heads/${branch}`, input.baseCommit);
    throw error;
  }
  return { ...lease, leasePath: paths.leasePath };
}

export async function inspectAttemptWorkspace(lease) {
  const owner = await readAuthoritativeLease(lease);
  if (!(await exists(owner.path))) fail("Attempt workspace is missing");
  return inspectOwnedWorkspace(owner);
}

async function releaseAuthorization(owner, disposition) {
  let status;
  try {
    status = JSON.parse(await readFile(owner.statusPath, "utf8"));
  } catch {
    fail("Attempt workspace release is not authorized by Plan status");
  }
  if (status?.derived !== true || status.planId !== owner.planId) fail("Attempt workspace release status is invalid");
  const attempt = status.tasks?.flatMap((task) => task.attempts ?? []).find((candidate) => candidate.attemptId === owner.attemptId);
  if (!attempt || attempt.workspaceReleased !== true || attempt.workspaceDisposition !== disposition) {
    fail("Attempt workspace release event is not authorized");
  }
  if (!ALLOWED_STATUS[disposition].has(attempt.status)) fail(`Attempt status ${attempt.status} does not allow ${disposition}`);
}

async function recordReleaseFailure(owner, disposition, error) {
  await writePrivateAtomic(owner.failurePath, {
    attemptId: owner.attemptId,
    disposition,
    error: error instanceof Error ? error.message : String(error),
    occurredAt: new Date().toISOString(),
  });
}

export async function releaseAttemptWorkspace(lease, { ownerToken, disposition } = {}) {
  const owner = await readAuthoritativeLease(lease);
  if (ownerToken !== owner.ownerToken) fail("Attempt workspace owner token does not match");
  if (!DISPOSITIONS.has(disposition)) fail(`Invalid attempt workspace disposition: ${disposition}`);
  try {
    await releaseAuthorization(owner, disposition);
    if (PRESERVE_DISPOSITIONS.has(disposition)) {
      return { released: false, preserved: true, disposition };
    }

    let releaseHead = owner.releaseHead;
    if (await exists(owner.path)) {
      const inspection = await inspectOwnedWorkspace(owner);
      if (!inspection.clean) fail("Attempt workspace must be clean before release");
      releaseHead = inspection.headCommit;
      await writePrivateAtomic(owner.leasePath, { ...coreLease(owner), releaseHead });
      const runtimeArtifacts = path.join(owner.path, ".pi-subagents");
      if (await exists(runtimeArtifacts)) {
        const trackedRuntimeFiles = await runPlanGit(owner.path, "ls-files", "-z", "--", ".pi-subagents");
        if (trackedRuntimeFiles) fail("Tracked .pi-subagents files prevent release cleanup");
        await rm(runtimeArtifacts, { recursive: true, force: true });
      }
      await runPlanGit(owner.originRoot, "worktree", "remove", owner.path);
    }
    if (!releaseHead) fail("Attempt workspace release head is missing");
    await runPlanGit(owner.originRoot, "update-ref", "-d", `refs/heads/${owner.branch}`, releaseHead);
    await rm(owner.leasePath, { force: true });
    await rm(owner.failurePath, { force: true });
    return { released: true, preserved: false, disposition };
  } catch (error) {
    await recordReleaseFailure(owner, disposition, error);
    throw error;
  }
}
