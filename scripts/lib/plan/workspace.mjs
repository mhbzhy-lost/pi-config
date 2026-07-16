import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message) {
  throw new Error(message);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function command(file, args, options = {}) {
  try {
    return await execFile(file, args, options);
  } catch (error) {
    fail(error.stderr?.trim() || error.message);
  }
}

async function git(cwd, ...args) {
  const { stdout } = await command("git", args, { cwd });
  return stdout.trim();
}

function safePlanId(planId) {
  if (typeof planId !== "string" || !PLAN_ID.test(planId) || planId.includes("..")) {
    fail("Invalid planId");
  }
  return planId;
}

function pathsFor(stateRoot, planId) {
  const root = path.resolve(stateRoot);
  const worktreeRoot = path.resolve(root, "var", "plan-worktrees");
  const workspacePath = path.resolve(worktreeRoot, planId);
  if (path.relative(worktreeRoot, workspacePath).startsWith("..") || path.isAbsolute(path.relative(worktreeRoot, workspacePath))) {
    fail("Workspace path escapes plan-worktrees");
  }
  return { worktreeRoot, workspacePath, leasePath: path.join(worktreeRoot, `.${planId}.lease.json`) };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLease(lease) {
  if (!lease || typeof lease !== "object") fail("Invalid lease");
  const planId = safePlanId(lease.planId);
  const { worktreeRoot, workspacePath, leasePath } = pathsFor(lease.stateRoot, planId);
  let stored;
  try {
    stored = JSON.parse(await readFile(leasePath, "utf8"));
  } catch {
    fail("Unknown workspace lease owner");
  }
  if (
    stored.token !== lease.token ||
    stored.originRoot !== lease.originRoot ||
    stored.workspacePath !== workspacePath ||
    stored.stateRoot !== path.resolve(lease.stateRoot) ||
    lease.workspacePath !== workspacePath
  ) {
    fail("Workspace lease owner does not match");
  }
  const resolvedRoot = await realpath(worktreeRoot);
  const resolvedWorkspace = await realpath(workspacePath);
  if (path.relative(resolvedRoot, resolvedWorkspace).startsWith("..") || path.isAbsolute(path.relative(resolvedRoot, resolvedWorkspace))) {
    fail("Workspace lease path escapes owner root");
  }
  return { ...stored, worktreeRoot, workspacePath, leasePath };
}

async function trackedDirtyFiles(workspacePath) {
  const status = await git(workspacePath, "status", "--porcelain=v1", "-uno");
  return status ? status.split("\n").map((line) => line.slice(3)) : [];
}

async function untrackedFiles(workspacePath) {
  const output = await git(workspacePath, "ls-files", "--others", "--exclude-standard", "-z");
  return output ? output.split("\0").filter((file) => file && !file.startsWith(".pi-subagents/")).sort() : [];
}

async function untrackedContentHash(workspacePath, files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file).update("\0").update(await readFile(path.join(workspacePath, file)));
  }
  return digest.digest("hex");
}

export async function createPlanWorkspace({ originRoot, stateRoot, planId, baseCommit }) {
  const validPlanId = safePlanId(planId);
  if (typeof originRoot !== "string" || typeof stateRoot !== "string" || typeof baseCommit !== "string" || !baseCommit) {
    fail("originRoot, stateRoot, and baseCommit are required");
  }
  const resolvedOrigin = await realpath(originRoot);
  const { worktreeRoot, workspacePath, leasePath } = pathsFor(stateRoot, validPlanId);
  await mkdir(worktreeRoot, { recursive: true });
  if (await exists(leasePath) || await exists(workspacePath)) fail("Plan workspace already exists");
  await git(resolvedOrigin, "rev-parse", "--verify", `${baseCommit}^{commit}`);
  await git(resolvedOrigin, "worktree", "add", "-b", `pi-plan/${validPlanId}`, workspacePath, baseCommit);
  const lease = {
    token: randomUUID(),
    planId: validPlanId,
    originRoot: resolvedOrigin,
    stateRoot: path.resolve(stateRoot),
    workspacePath,
    baseCommit,
    branch: `pi-plan/${validPlanId}`,
  };
  await writeFile(leasePath, JSON.stringify(lease), { mode: 0o600 });
  return lease;
}

export async function inspectPlanWorkspace(lease) {
  const owner = await readLease(lease);
  const headCommit = await git(owner.workspacePath, "rev-parse", "HEAD");
  const files = await untrackedFiles(owner.workspacePath);
  const untrackedHash = await untrackedContentHash(owner.workspacePath, files);
  return {
    baseCommit: owner.baseCommit,
    headCommit,
    committedDiff: await git(owner.workspacePath, "diff", "--binary", `${owner.baseCommit}..${headCommit}`),
    untrackedFiles: files,
    dirtyTrackedFiles: await trackedDirtyFiles(owner.workspacePath),
    gateChangeSetHash: hash(`${owner.baseCommit}\0${headCommit}\0${untrackedHash}`),
  };
}

export async function removePlanWorkspace(lease, { requireValidatedHead } = {}) {
  const owner = await readLease(lease);
  const headCommit = await git(owner.workspacePath, "rev-parse", "HEAD");
  if (typeof requireValidatedHead !== "string" || requireValidatedHead !== headCommit) {
    fail("Validated head does not match workspace head");
  }
  if ((await trackedDirtyFiles(owner.workspacePath)).length || (await untrackedFiles(owner.workspacePath)).length) {
    fail("Workspace must be clean before removal");
  }
  await git(owner.originRoot, "worktree", "remove", owner.workspacePath);
  await rm(owner.leasePath, { force: true });
}

export async function rollbackPlanWorkspace(lease) {
  const owner = await readLease(lease);
  const headCommit = await git(owner.workspacePath, "rev-parse", "HEAD");
  if (headCommit !== owner.baseCommit) fail("Workspace head differs from rollback base");
  if ((await trackedDirtyFiles(owner.workspacePath)).length || (await untrackedFiles(owner.workspacePath)).length) {
    fail("Workspace must be clean before rollback");
  }
  await git(owner.originRoot, "worktree", "remove", owner.workspacePath);
  await git(owner.originRoot, "branch", "-d", owner.branch);
  await rm(owner.leasePath, { force: true });
}
