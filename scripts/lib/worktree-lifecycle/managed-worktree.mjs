import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { parseWorktreePorcelain } from "./inventory.mjs";
import { activateAllocation, beginAllocation, markDisposition, reanchorAllocation } from "./registry.mjs";

const OWNER_TOKEN = /^worktree-owner\.v1:[a-f0-9]{64}$/;
const MANIFEST_STATES = new Set(["allocating", "active", "reclaimable", "preserved", "cleanup-debt", "released"]);
const MANIFEST_KEYS = [
  "schemaVersion", "id", "ownerKind", "ownerId", "ownerToken", "originRoot", "gitCommonDir",
  "path", "branchRef", "baseCommit", "headCommit", "state", "createdAt", "updatedAt",
  "disposition", "lastError",
];

function failure(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw failure("WORKTREE_LIFECYCLE_INVALID_INPUT", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireId(value) {
  const id = requireText(value, "id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw failure("WORKTREE_LIFECYCLE_INVALID_INPUT", "id must be a safe path segment");
  }
  return id;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function runGit(cwd, args, commandObserver) {
  commandObserver?.({ file: "git", cwd, args: [...args] });
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw failure("WORKTREE_LIFECYCLE_GIT_ERROR", `git ${args.join(" ")} failed`, cause);
  }
}

function gitSucceeds(cwd, args, commandObserver) {
  commandObserver?.({ file: "git", cwd, args: [...args] });
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

function canonicalRoot(input, commandObserver) {
  const raw = requireText(input, "originRoot");
  if (!isAbsolute(raw)) throw failure("WORKTREE_LIFECYCLE_INVALID_INPUT", "originRoot must be absolute");
  let root;
  try { root = realpathSync(raw); }
  catch (cause) { throw failure("WORKTREE_LIFECYCLE_INVALID_INPUT", "originRoot is unavailable", cause); }
  const top = realpathSync(runGit(root, ["rev-parse", "--show-toplevel"], commandObserver));
  if (top !== root) throw failure("WORKTREE_LIFECYCLE_INVALID_INPUT", "originRoot must be the canonical Git top-level");
  return root;
}

function manifestPath(root, id) {
  return join(root, ".state/worktree-lifecycle/leases", `${id}.json`);
}

function validateManagedManifest(manifest, path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !exactKeys(manifest, MANIFEST_KEYS)) throw new Error("shape or mode");
    if (manifest.schemaVersion !== "worktree-lifecycle.owner.v1" || !MANIFEST_STATES.has(manifest.state)
      || !OWNER_TOKEN.test(manifest.ownerToken) || typeof manifest.path !== "string" || !isAbsolute(manifest.path)
      || typeof manifest.branchRef !== "string" || !manifest.branchRef.startsWith("refs/heads/")
      || typeof manifest.originRoot !== "string" || typeof manifest.gitCommonDir !== "string") throw new Error("identity");
    return manifest;
  } catch (cause) {
    throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", `owner manifest is invalid: ${path}`, cause);
  }
}

function readManagedManifest(root, id) {
  const path = manifestPath(root, requireId(id));
  if (!existsSync(path)) throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", "allocation manifest is missing");
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (cause) { throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", `owner manifest is unreadable: ${path}`, cause); }
  return { path, manifest: validateManagedManifest(parsed, path) };
}

function assertOwner(manifest, token) {
  if (manifest.ownerToken !== token) {
    throw failure("WORKTREE_LIFECYCLE_OWNER_MISMATCH", "owner token receipt does not match current allocation");
  }
}

function registrationFor(root, path, commandObserver) {
  const output = runGit(root, ["worktree", "list", "--porcelain", "-z"], commandObserver);
  const wanted = resolve(path);
  return parseWorktreePorcelain(output).find((registration) => resolve(registration.path) === wanted) ?? null;
}

function commonDir(cwd, commandObserver) {
  const raw = runGit(cwd, ["rev-parse", "--git-common-dir"], commandObserver);
  return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

function inspectIdentity(manifest, commandObserver) {
  if (!existsSync(manifest.path)) throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree path is missing");
  let path;
  try { path = realpathSync(manifest.path); }
  catch (cause) { throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree path is unavailable", cause); }
  const top = realpathSync(runGit(path, ["rev-parse", "--show-toplevel"], commandObserver));
  const branchRef = runGit(path, ["symbolic-ref", "-q", "HEAD"], commandObserver);
  const headCommit = runGit(path, ["rev-parse", "--verify", "HEAD^{commit}"], commandObserver);
  const registration = registrationFor(manifest.originRoot, path, commandObserver);
  if (path !== manifest.path || top !== manifest.path || commonDir(path, commandObserver) !== manifest.gitCommonDir
    || branchRef !== manifest.branchRef || !registration || registration.branch !== manifest.branchRef) {
    throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree Git identity changed");
  }
  return { path, headCommit, registration };
}

function resourceState(manifest, commandObserver) {
  const pathExists = existsSync(manifest.path);
  let registration;
  try { registration = registrationFor(manifest.originRoot, manifest.path, commandObserver); }
  catch (error) { return { pathExists, registration: null, probeError: error }; }
  return { pathExists, registration, probeError: null };
}

function maybeFault(fault, operation, phase, context = {}) {
  fault?.({ operation, phase, ...context });
}

function receipt(manifest, path = manifestPath(manifest.originRoot, manifest.id)) {
  return { ...structuredClone(manifest), manifestPath: path };
}

function shortBranch(branchRef) {
  return branchRef.slice("refs/heads/".length);
}

function branchHead(root, branchRef, commandObserver) {
  if (!gitSucceeds(root, ["show-ref", "--verify", "--quiet", branchRef], commandObserver)) return null;
  return runGit(root, ["rev-parse", "--verify", `${branchRef}^{commit}`], commandObserver);
}

function debtDisposition(reason, error) {
  return {
    state: "cleanup-debt",
    reason,
    lastError: {
      code: error?.code || "WORKTREE_LIFECYCLE_ERROR",
      message: error?.message || reason,
    },
  };
}

function recordCleanupDebt(manifest, reason, error, options) {
  try {
    return markDisposition({
      originRoot: manifest.originRoot,
      id: manifest.id,
      ownerToken: manifest.ownerToken,
      disposition: debtDisposition(reason, error),
      commandObserver: options.commandObserver,
    });
  } catch (cause) {
    throw failure("WORKTREE_LIFECYCLE_CLEANUP_DEBT", `${reason}; cleanup debt could not be persisted`, cause);
  }
}

function classifyCreateRecovery(manifest, commandObserver) {
  const resources = resourceState(manifest, commandObserver);
  if (resources.probeError) return { safe: false, reason: "worktree registration probe failed" };
  if (!resources.pathExists && !resources.registration) return { safe: true, complete: false };
  if (resources.pathExists && resources.registration) {
    try { inspectIdentity(manifest, commandObserver); return { safe: true, complete: true }; }
    catch (error) { return { safe: false, reason: error.message }; }
  }
  return { safe: false, reason: "worktree path and Git registration disagree" };
}

export function createManagedWorktree({ originRoot, id, branch, baseCommit, owner, path: explicitPath, fault, commandObserver } = {}) {
  const root = canonicalRoot(originRoot, commandObserver);
  const normalizedId = requireId(id);
  // Registry canonicalizes and gates both default and explicit candidates.
  const path = explicitPath ?? join(root, ".state/worktree-lifecycle/worktrees", normalizedId);
  let allocation;
  try {
    allocation = beginAllocation({ originRoot: root, id: normalizedId, path, branch, baseCommit, owner, fault, commandObserver });
    if (allocation.state === "active") {
      return activateAllocation({
        originRoot: root,
        id: allocation.id,
        ownerToken: allocation.ownerToken,
        headCommit: allocation.headCommit,
        commandObserver,
      });
    }
    if (allocation.state !== "allocating") {
      throw failure("WORKTREE_LIFECYCLE_STATE_CONFLICT", `managed create cannot continue from ${allocation.state}`);
    }

    const resources = resourceState(allocation, commandObserver);
    if (resources.probeError || resources.pathExists !== Boolean(resources.registration)) {
      throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "worktree path and Git registration disagree");
    }
    if (!resources.pathExists) {
      maybeFault(fault, "worktree-add", "before", { path: allocation.path });
      mkdirSync(resolve(allocation.path, ".."), { recursive: true, mode: 0o700 });
      const existingBranchHead = branchHead(root, allocation.branchRef, commandObserver);
      if (existingBranchHead && existingBranchHead !== allocation.baseCommit) {
        throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "reserved branch moved away from baseCommit");
      }
      const args = existingBranchHead
        ? ["worktree", "add", allocation.path, shortBranch(allocation.branchRef)]
        : ["worktree", "add", "-b", shortBranch(allocation.branchRef), allocation.path, allocation.baseCommit];
      runGit(root, args, commandObserver);
      maybeFault(fault, "worktree-add", "after", { path: allocation.path });
    }

    maybeFault(fault, "identity-inspect", "before", { path: allocation.path });
    const identity = inspectIdentity(allocation, commandObserver);
    maybeFault(fault, "identity-inspect", "after", { path: allocation.path, headCommit: identity.headCommit });
    return activateAllocation({
      originRoot: root,
      id: allocation.id,
      ownerToken: allocation.ownerToken,
      headCommit: identity.headCommit,
      fault,
      commandObserver,
    });
  } catch (error) {
    if (error?.code !== "TEST_FAULT" && allocation?.state === "allocating") {
      const recovery = classifyCreateRecovery(allocation, commandObserver);
      if (error?.code === "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH" || !recovery.safe) {
        recordCleanupDebt(allocation, recovery.reason ?? error.message, error, { commandObserver });
      }
    }
    throw error;
  }
}

export function reanchorManagedWorktree({ originRoot, id, ownerToken, expectedHead, targetHead, fault, commandObserver } = {}) {
  return reanchorAllocation({ originRoot, id, ownerToken, expectedHead, targetHead, fault, commandObserver });
}

export function preserveManagedWorktree({ originRoot, id, ownerToken, reason, commandObserver } = {}) {
  const root = canonicalRoot(originRoot, commandObserver);
  const observed = readManagedManifest(root, id);
  assertOwner(observed.manifest, ownerToken);
  const normalizedReason = requireText(reason, "reason");
  if (observed.manifest.state === "preserved"
    && observed.manifest.disposition?.state === "preserved"
    && observed.manifest.disposition?.reason === normalizedReason) return receipt(observed.manifest, observed.path);
  return markDisposition({
    originRoot: root,
    id: observed.manifest.id,
    ownerToken,
    disposition: { state: "preserved", reason: normalizedReason },
    commandObserver,
  });
}

function sequencerOperation(path, commandObserver) {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const markerPath = runGit(path, ["rev-parse", "--git-path", marker], commandObserver);
    if (existsSync(markerPath)) return marker;
  }
  return null;
}

function activeWorkspaceUsers(worktreePath) {
  // NUL fields avoid locale/whitespace parsing ambiguity.  lsof uses status 1
  // for "no matches", but never treat output accompanying it as clear.
  const probe = spawnSync("lsof", ["-w", "-n", "-Fpc0", "+D", worktreePath], {
    encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, maxBuffer: 1024 * 1024,
  });
  if (probe.error || probe.signal || (probe.status !== 0 && probe.status !== 1) || probe.stderr.length) {
    throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "managed worktree process inventory is unavailable", probe.error);
  }
  const fields = probe.stdout.toString("utf8").split("\0").filter(Boolean);
  if (fields.some((field) => !/^[pc]/.test(field))) throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "managed worktree process inventory is malformed");
  const pids = fields.filter((field) => /^p\d+$/.test(field)).map((field) => field.slice(1));
  if (probe.status === 1 && pids.length) return pids;
  return pids;
}

function activeDeletedResourceUsers(worktreePath) {
  // This is intentionally global: after removal, +D cannot inspect a vanished
  // directory, while +L1 finds files which remain open after unlinking.
  const probe = spawnSync("lsof", ["-w", "-n", "-Fpcfn0", "+L1"], {
    encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, maxBuffer: 1024 * 1024,
  });
  if (probe.error || probe.signal || (probe.status !== 0 && probe.status !== 1) || probe.stderr.length) {
    throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "deleted resource process inventory is unavailable", probe.error);
  }

  let pid = null;
  let file = false;
  let matched = false;
  for (const rawField of probe.stdout.toString("utf8").split("\0").filter(Boolean)) {
    // lsof retains its documented newline record separators even when fields
    // themselves are NUL-delimited.
    if (rawField === "\n") continue;
    const field = rawField[0] === "\n" ? rawField.slice(1) : rawField;
    const kind = field[0];
    const value = field.slice(1);
    if ((rawField[0] === "\n" && !"pf".includes(kind)) || !"pcfn".includes(kind) || !value) {
      throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "deleted resource process inventory is malformed");
    }
    if (kind === "p") {
      if (!/^\d+$/.test(value)) throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "deleted resource process inventory is malformed");
      pid = value;
      file = false;
    } else if (kind === "c") {
      if (!pid) throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "deleted resource process inventory is malformed");
    } else if (kind === "f") {
      if (!pid) throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "deleted resource process inventory is malformed");
      file = true;
    } else {
      if (!pid || !file) throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "deleted resource process inventory is malformed");
      if (value === worktreePath || value.startsWith(`${worktreePath}/`) || value === `${worktreePath} (deleted)`) matched = true;
    }
  }
  return matched;
}

function assertNoDeletedResourceUsers(worktreePath) {
  if (activeDeletedResourceUsers(worktreePath)) {
    throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "managed worktree cannot be released: deleted resource remains open");
  }
}

function assertSafeRelease(manifest, commandObserver) {
  const identity = inspectIdentity(manifest, commandObserver);
  // Git's clean status does not reveal a server whose cwd is this worktree.
  // Refuse release rather than guessing when the process inventory is unavailable.
  const cwdUsers = activeWorkspaceUsers(manifest.path);
  if (cwdUsers.length) throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "managed worktree cannot be released: active cwd/process");
  if (manifest.headCommit !== identity.headCommit) {
    throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", "managed worktree HEAD changed after becoming reclaimable");
  }
  const status = runGit(manifest.path, ["status", "--porcelain=v1", "-z"], commandObserver);
  const operation = sequencerOperation(manifest.path, commandObserver);
  if (status.length > 0 || operation || identity.registration.locked) {
    const reasons = [status.length > 0 ? "dirty" : null, operation ? `sequencer:${operation}` : null, identity.registration.locked ? "locked" : null].filter(Boolean);
    throw failure("WORKTREE_LIFECYCLE_UNSAFE_RELEASE", `managed worktree cannot be released: ${reasons.join(",")}`);
  }
}

export function releaseManagedWorktree({ originRoot, id, ownerToken, fault, commandObserver } = {}) {
  const root = canonicalRoot(originRoot, commandObserver);
  const observed = readManagedManifest(root, id);
  const current = observed.manifest;
  assertOwner(current, ownerToken);
  if (current.originRoot !== root) throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "owner manifest origin changed");

  if (current.state === "released") {
    const resources = resourceState(current, commandObserver);
    if (resources.probeError || resources.pathExists || resources.registration) {
      throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "released allocation still has worktree resources");
    }
    return receipt(current, observed.path);
  }
  if (current.state !== "reclaimable") {
    throw failure("WORKTREE_LIFECYCLE_NOT_RECLAIMABLE", `managed release requires reclaimable state, found ${current.state}`);
  }

  try {
    const resources = resourceState(current, commandObserver);
    if (resources.probeError || resources.pathExists !== Boolean(resources.registration)) {
      throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "worktree path and Git registration disagree during release");
    }
    if (resources.pathExists) {
      assertSafeRelease(current, commandObserver);
      maybeFault(fault, "worktree-remove", "before", { path: current.path });
      assertSafeRelease(current, commandObserver);
      runGit(root, ["worktree", "remove", current.path], commandObserver);
      maybeFault(fault, "worktree-remove", "after", { path: current.path });
    }
    const after = resourceState(current, commandObserver);
    if (after.probeError || after.pathExists || after.registration) {
      throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "worktree removal did not release both path and registration");
    }
    assertNoDeletedResourceUsers(current.path);
    if (branchHead(root, current.branchRef, commandObserver) !== current.headCommit) {
      throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree branch changed during release");
    }
    return markDisposition({
      originRoot: root,
      id: current.id,
      ownerToken,
      disposition: "released",
      fault,
      commandObserver,
    });
  } catch (error) {
    if (error?.code === "TEST_FAULT") throw error;
    recordCleanupDebt(current, "managed worktree release requires manual reconciliation", error, { commandObserver });
    throw error;
  }
}
