import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { parseWorktreePorcelain } from "./inventory.mjs";

const MANIFEST_SCHEMA = "worktree-lifecycle.owner.v1";
const LOCK_SCHEMA = "worktree-lifecycle.registry-lock.v1";
const MANIFEST_STATES = new Set(["allocating", "active", "reclaimable", "preserved", "cleanup-debt", "released"]);
const DISPOSITION_STATES = new Set(["reclaimable", "preserved", "cleanup-debt", "released"]);
const MANIFEST_KEYS = [
  "schemaVersion", "id", "ownerKind", "ownerId", "ownerToken", "originRoot", "gitCommonDir",
  "path", "branchRef", "baseCommit", "headCommit", "state", "createdAt", "updatedAt",
  "disposition", "lastError",
];
const LOCK_KEYS = ["schemaVersion", "token", "pid", "birthIdentity", "createdAt"];
const DEFAULT_LOCK_TIMEOUT_MS = 1500;
const LOCK_WAIT_MS = 5;
let selfBirthIdentity;

function failure(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function invalid(message, cause) {
  return failure("WORKTREE_LIFECYCLE_INVALID_INPUT", message, cause);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${label} must be a non-empty string`);
  return value.trim();
}

function requireId(value) {
  const id = requireText(value, "id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || basename(id) !== id) throw invalid("id must be a safe path segment");
  return id;
}

function runGit(cwd, args, commandObserver) {
  commandObserver?.({ file: "git", cwd, args: [...args] });
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw failure("WORKTREE_LIFECYCLE_GIT_ERROR", `git ${args.join(" ")} failed`, cause);
  }
}

function canonicalRepository(originRoot, commandObserver) {
  const requested = requireText(originRoot, "originRoot");
  if (!isAbsolute(requested)) throw invalid("originRoot must be absolute");
  let canonical;
  try { canonical = realpathSync(requested); }
  catch (cause) { throw invalid("originRoot is unavailable", cause); }
  const top = realpathSync(runGit(canonical, ["rev-parse", "--show-toplevel"], commandObserver));
  if (top !== canonical) throw invalid("originRoot must be the canonical Git top-level");
  const rawCommon = runGit(canonical, ["rev-parse", "--git-common-dir"], commandObserver);
  const commonCandidate = isAbsolute(rawCommon) ? rawCommon : resolve(canonical, rawCommon);
  let gitCommonDir;
  try { gitCommonDir = realpathSync(commonCandidate); }
  catch (cause) { throw invalid("Git common-dir is unavailable", cause); }
  return { originRoot: canonical, gitCommonDir };
}

function canonicalCandidate(input) {
  const requested = requireText(input, "path");
  if (!isAbsolute(requested)) throw invalid("path must be absolute");
  const parts = [];
  let cursor = resolve(requested);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw invalid("path has no existing canonical ancestor");
    parts.unshift(basename(cursor));
    cursor = parent;
  }
  let canonical = realpathSync(cursor);
  for (const part of parts) canonical = join(canonical, part);
  return canonical;
}

function branchRef(branch, root, commandObserver) {
  const raw = requireText(branch, "branch");
  const ref = raw.startsWith("refs/heads/") ? raw : `refs/heads/${raw}`;
  runGit(root, ["check-ref-format", ref], commandObserver);
  return ref;
}

function fullCommit(root, revision, commandObserver) {
  const raw = requireText(revision, "commit");
  const commit = runGit(root, ["rev-parse", "--verify", `${raw}^{commit}`], commandObserver);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw invalid("commit must resolve to a full object id");
  return commit;
}

function normalizeOwner(owner) {
  if (!exactKeys(owner, ["kind", "id"])) throw invalid("owner must contain exactly kind and id");
  return { kind: requireText(owner.kind, "owner.kind"), id: requireText(owner.id, "owner.id") };
}

function ownerToken() {
  return `worktree-owner.v1:${randomBytes(32).toString("hex")}`;
}

function ensureRealDirectory(path, { privateMode = false } = {}) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") {
      throw failure("WORKTREE_LIFECYCLE_STATE_ROOT_INSECURE", `worktree lifecycle state directory is insecure: ${path}`, error);
    }
    try { mkdirSync(path, { mode: privateMode ? 0o700 : 0o755 }); }
    catch (mkdirError) {
      if (mkdirError.code !== "EEXIST") {
        throw failure("WORKTREE_LIFECYCLE_STATE_ROOT_INSECURE", `worktree lifecycle state directory cannot be created: ${path}`, mkdirError);
      }
    }
    try { stat = lstatSync(path); }
    catch (cause) {
      throw failure("WORKTREE_LIFECYCLE_STATE_ROOT_INSECURE", `worktree lifecycle state directory is unavailable: ${path}`, cause);
    }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure("WORKTREE_LIFECYCLE_STATE_ROOT_INSECURE", `worktree lifecycle state directory is insecure: ${path}`);
  }
  if (realpathSync(path) !== resolve(path)) {
    throw failure("WORKTREE_LIFECYCLE_STATE_ROOT_INSECURE", `worktree lifecycle state directory escapes its repository: ${path}`);
  }
  if (privateMode) chmodSync(path, 0o700);
  return path;
}

function stateDirectory(root) {
  const state = ensureRealDirectory(join(root, ".state"));
  return ensureRealDirectory(join(state, "worktree-lifecycle"), { privateMode: true });
}

function manifestPathFor(root, id) {
  return join(stateDirectory(root), "leases", `${id}.json`);
}

function safeMode(path) {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600;
}

function validateDisposition(disposition) {
  if (disposition === null) return;
  if (!exactKeys(disposition, ["state", "reason"]) || !DISPOSITION_STATES.has(disposition.state)
      || !(disposition.reason === null || (typeof disposition.reason === "string" && disposition.reason.trim()))) {
    throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", "owner manifest disposition is invalid");
  }
}

function validateLastError(lastError) {
  if (lastError === null) return;
  if (!exactKeys(lastError, ["code", "message", "at"]) || typeof lastError.code !== "string" || !lastError.code
      || typeof lastError.message !== "string" || !lastError.message || typeof lastError.at !== "string"
      || Number.isNaN(Date.parse(lastError.at))) {
    throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", "owner manifest lastError is invalid");
  }
}

function validateManifest(manifest, path) {
  try {
    if (!safeMode(path) || !exactKeys(manifest, MANIFEST_KEYS)) throw new Error("shape or mode");
    if (manifest.schemaVersion !== MANIFEST_SCHEMA || requireId(manifest.id) !== manifest.id) throw new Error("schema or id");
    for (const field of ["ownerKind", "ownerId", "originRoot", "gitCommonDir", "path", "branchRef", "baseCommit", "createdAt", "updatedAt"]) {
      if (typeof manifest[field] !== "string" || !manifest[field]) throw new Error(field);
    }
    if (!/^worktree-owner\.v1:[a-f0-9]{64}$/.test(manifest.ownerToken)) throw new Error("ownerToken");
    if (!isAbsolute(manifest.originRoot) || !isAbsolute(manifest.gitCommonDir) || !isAbsolute(manifest.path)) throw new Error("absolute identity");
    if (!manifest.branchRef.startsWith("refs/heads/") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.baseCommit)) throw new Error("Git identity");
    if (!(manifest.headCommit === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.headCommit))) throw new Error("headCommit");
    if (!MANIFEST_STATES.has(manifest.state) || Number.isNaN(Date.parse(manifest.createdAt)) || Number.isNaN(Date.parse(manifest.updatedAt))) throw new Error("state or time");
    validateDisposition(manifest.disposition);
    validateLastError(manifest.lastError);
    return manifest;
  } catch (cause) {
    if (cause?.code === "WORKTREE_LIFECYCLE_MANIFEST_INVALID") throw cause;
    throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", `owner manifest is invalid: ${path}`, cause);
  }
}

function readManifest(root, id) {
  const path = manifestPathFor(root, id);
  try { lstatSync(path); }
  catch (error) {
    if (error.code === "ENOENT") return { path, manifest: null };
    throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", `owner manifest is unavailable: ${path}`, error);
  }
  try {
    if (!safeMode(path)) throw new Error("manifest must be a private regular file");
    return { path, manifest: validateManifest(JSON.parse(readFileSync(path, "utf8")), path) };
  } catch (cause) {
    if (cause?.code === "WORKTREE_LIFECYCLE_MANIFEST_INVALID") throw cause;
    throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", `owner manifest is unreadable: ${path}`, cause);
  }
}

function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function writePrivateFile(path, content, { exclusive = false } = {}) {
  const fd = openSync(path, exclusive ? "wx" : "w", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

function maybeFault(fault, operation, phase, context = {}) {
  fault?.({ operation, phase, ...context });
}

function processBirthIdentity(pid) {
  let bytes;
  try {
    bytes = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (cause) {
    throw failure("WORKTREE_LIFECYCLE_PROCESS_IDENTITY_UNAVAILABLE", "process birth identity is unavailable", cause);
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length || !bytes.toString("utf8").trim()) {
    throw failure("WORKTREE_LIFECYCLE_PROCESS_IDENTITY_UNAVAILABLE", "process birth identity is unavailable");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function currentBirthIdentity() {
  if (!selfBirthIdentity) selfBirthIdentity = processBirthIdentity(process.pid);
  return selfBirthIdentity;
}

function lockReceipt() {
  return {
    schemaVersion: LOCK_SCHEMA,
    token: randomUUID(),
    pid: process.pid,
    birthIdentity: currentBirthIdentity(),
    createdAt: new Date().toISOString(),
  };
}

function readLock(path) {
  try {
    if (!safeMode(path)) return null;
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (!exactKeys(receipt, LOCK_KEYS) || receipt.schemaVersion !== LOCK_SCHEMA || typeof receipt.token !== "string" || !receipt.token
      || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 || !/^[a-f0-9]{64}$/.test(receipt.birthIdentity)
      || typeof receipt.createdAt !== "string" || Number.isNaN(Date.parse(receipt.createdAt))) return null;
    return receipt;
  } catch { return null; }
}

function lockOwnerState(receipt) {
  if (!receipt) return "unknown";
  try { process.kill(receipt.pid, 0); }
  catch (error) { return error.code === "ESRCH" ? "dead" : "unknown"; }
  try { return processBirthIdentity(receipt.pid) === receipt.birthIdentity ? "live" : "dead"; }
  catch { return "unknown"; }
}

function sameInode(first, second) {
  try {
    const a = statSync(first); const b = statSync(second);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function releaseReceipt(receipt, { removeLock = true } = {}) {
  if (removeLock && sameInode(receipt.lockPath, receipt.receiptPath)) {
    const observed = readLock(receipt.lockPath);
    if (observed?.token === receipt.token && observed.pid === receipt.pid && observed.birthIdentity === receipt.birthIdentity) {
      unlinkSync(receipt.lockPath);
    }
  }
  rmSync(receipt.receiptPath, { force: true });
}

function acquireSimpleLock(lockPath, deadline) {
  const directory = dirname(lockPath);
  while (true) {
    const owner = lockReceipt();
    const receiptPath = `${lockPath}.receipt-${process.pid}-${randomUUID()}`;
    writePrivateFile(receiptPath, `${JSON.stringify(owner)}\n`, { exclusive: true });
    try {
      try {
        linkSync(receiptPath, lockPath);
        syncDirectory(directory);
        return { ...owner, lockPath, receiptPath };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      if (!existsSync(lockPath) || !sameInode(lockPath, receiptPath)) rmSync(receiptPath, { force: true });
    }
    const observed = readLock(lockPath);
    if (lockOwnerState(observed) === "dead") {
      const quarantine = `${lockPath}.quarantine-${process.pid}-${randomUUID()}`;
      try {
        renameSync(lockPath, quarantine);
        rmSync(quarantine, { force: true });
        syncDirectory(directory);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (Date.now() >= deadline) throw failure("WORKTREE_LIFECYCLE_LOCK_TIMEOUT", "worktree lifecycle registry lock timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
  }
}

function quarantineDeadLock(lockPath, deadline) {
  const guardPath = `${lockPath}.recovery.guard`;
  const guard = acquireSimpleLock(guardPath, deadline);
  try {
    const observed = readLock(lockPath);
    if (lockOwnerState(observed) !== "dead") return;
    const quarantine = `${lockPath}.quarantine-${process.pid}-${randomUUID()}`;
    try {
      renameSync(lockPath, quarantine);
      rmSync(quarantine, { force: true });
      syncDirectory(dirname(lockPath));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } finally { releaseReceipt(guard); }
}

function acquireRegistryLock(root, { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, fault } = {}) {
  const directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, ".registry.lock");
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    const owner = lockReceipt();
    const receiptPath = `${lockPath}.receipt-${process.pid}-${randomUUID()}`;
    writePrivateFile(receiptPath, `${JSON.stringify(owner)}\n`, { exclusive: true });
    try {
      try {
        linkSync(receiptPath, lockPath);
        syncDirectory(directory);
        const receipt = { ...owner, lockPath, receiptPath };
        try { maybeFault(fault, "registry-lock", "acquired", { lockPath, receipt: owner }); }
        catch (error) { releaseReceipt(receipt); throw error; }
        return receipt;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      if (!sameInode(lockPath, receiptPath)) rmSync(receiptPath, { force: true });
    }
    const observed = readLock(lockPath);
    if (lockOwnerState(observed) === "dead") quarantineDeadLock(lockPath, deadline);
    if (Date.now() >= deadline) throw failure("WORKTREE_LIFECYCLE_LOCK_TIMEOUT", "worktree lifecycle registry lock timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
  }
}

function assertLockOwned(receipt) {
  if (!sameInode(receipt.lockPath, receipt.receiptPath)) throw failure("WORKTREE_LIFECYCLE_LOCK_LOST", "worktree lifecycle registry lock was replaced");
  const observed = readLock(receipt.lockPath);
  if (observed?.token !== receipt.token || observed.pid !== receipt.pid || observed.birthIdentity !== receipt.birthIdentity) {
    throw failure("WORKTREE_LIFECYCLE_LOCK_LOST", "worktree lifecycle registry lock was replaced");
  }
}

function atomicManifestWrite(path, manifest, receipt, { fault, operation }) {
  ensureRealDirectory(dirname(path), { privateMode: true });
  maybeFault(fault, operation, "before", { manifestPath: path });
  assertLockOwned(receipt);
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writePrivateFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { exclusive: true });
    assertLockOwned(receipt);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
  maybeFault(fault, operation, "after", { manifestPath: path });
}

function registrationFor(root, path, commandObserver) {
  const output = runGit(root, ["worktree", "list", "--porcelain", "-z"], commandObserver);
  const candidate = canonicalCandidate(path);
  return parseWorktreePorcelain(output).find((registration) => {
    try { return canonicalCandidate(registration.path) === candidate; }
    catch { return resolve(registration.path) === resolve(candidate); }
  }) ?? null;
}

function inspectWorktree(manifest, commandObserver) {
  if (!existsSync(manifest.path)) throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree path is missing");
  let canonicalPath;
  try { canonicalPath = realpathSync(manifest.path); }
  catch (cause) { throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree path is unavailable", cause); }
  if (canonicalPath !== manifest.path) throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree path identity changed");
  const top = realpathSync(runGit(canonicalPath, ["rev-parse", "--show-toplevel"], commandObserver));
  const rawCommon = runGit(canonicalPath, ["rev-parse", "--git-common-dir"], commandObserver);
  const common = realpathSync(isAbsolute(rawCommon) ? rawCommon : resolve(canonicalPath, rawCommon));
  const branch = runGit(canonicalPath, ["symbolic-ref", "-q", "HEAD"], commandObserver);
  const headCommit = fullCommit(canonicalPath, "HEAD", commandObserver);
  const registration = registrationFor(manifest.originRoot, canonicalPath, commandObserver);
  if (top !== manifest.path || common !== manifest.gitCommonDir || branch !== manifest.branchRef || !registration
      || registration.branch !== manifest.branchRef) {
    throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "managed worktree Git identity changed");
  }
  return { headCommit, registration };
}

function assertManifestRepository(manifest, repository) {
  if (manifest.originRoot !== repository.originRoot || manifest.gitCommonDir !== repository.gitCommonDir) {
    throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "owner manifest repository identity changed");
  }
}

function assertOwner(manifest, token) {
  if (manifest.ownerToken !== token) throw failure("WORKTREE_LIFECYCLE_OWNER_MISMATCH", "owner token receipt does not match current allocation");
}

function receipt(manifest, path) {
  return { ...structuredClone(manifest), manifestPath: path };
}

function normalizeDisposition(disposition) {
  if (typeof disposition === "string") return { state: disposition, reason: null, lastError: null };
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) throw invalid("disposition is invalid");
  const allowed = new Set(["state", "reason", "lastError"]);
  if (Object.keys(disposition).some((key) => !allowed.has(key))) throw invalid("disposition has unknown fields");
  const state = requireText(disposition.state, "disposition.state");
  const reason = disposition.reason === undefined || disposition.reason === null ? null : requireText(disposition.reason, "disposition.reason");
  let lastError = null;
  if (disposition.lastError !== undefined && disposition.lastError !== null) {
    const value = disposition.lastError;
    const code = typeof value.code === "string" && value.code ? value.code.slice(0, 128) : "WORKTREE_LIFECYCLE_ERROR";
    const message = typeof value.message === "string" && value.message ? value.message.slice(0, 1024) : String(value).slice(0, 1024);
    lastError = { code, message, at: new Date().toISOString() };
  }
  return { state, reason, lastError };
}

function legalTransition(from, to) {
  const allowed = {
    allocating: new Set(["cleanup-debt", "released"]),
    active: new Set(["reclaimable", "preserved", "cleanup-debt"]),
    reclaimable: new Set(["preserved", "cleanup-debt", "released"]),
    preserved: new Set(["reclaimable", "cleanup-debt", "released"]),
    "cleanup-debt": new Set(["reclaimable", "preserved", "released"]),
    released: new Set(),
  };
  return allowed[from]?.has(to) === true;
}

export function beginAllocation({ originRoot, id, path, branch, baseCommit, owner, fault, lockTimeoutMs, commandObserver } = {}) {
  const repository = canonicalRepository(originRoot, commandObserver);
  const normalized = {
    id: requireId(id),
    path: canonicalCandidate(path),
    branchRef: branchRef(branch, repository.originRoot, commandObserver),
    baseCommit: fullCommit(repository.originRoot, baseCommit, commandObserver),
    owner: normalizeOwner(owner),
  };
  if (normalized.path === repository.originRoot) throw invalid("managed worktree path cannot be the main worktree");
  const lock = acquireRegistryLock(repository.originRoot, { lockTimeoutMs, fault });
  try {
    assertLockOwned(lock);
    const observed = readManifest(repository.originRoot, normalized.id);
    if (observed.manifest) {
      assertManifestRepository(observed.manifest, repository);
      const current = observed.manifest;
      if (["allocating", "active"].includes(current.state)
          && current.ownerKind === normalized.owner.kind && current.ownerId === normalized.owner.id
          && current.path === normalized.path && current.branchRef === normalized.branchRef && current.baseCommit === normalized.baseCommit) {
        return receipt(current, observed.path);
      }
      if (current.state !== "released") {
        throw failure("WORKTREE_LIFECYCLE_MANIFEST_CONFLICT", `allocation id is already owned: ${normalized.id}`);
      }
      if (existsSync(current.path) || registrationFor(repository.originRoot, current.path, commandObserver)) {
        throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "released allocation still has worktree resources");
      }
    }
    const now = new Date().toISOString();
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA,
      id: normalized.id,
      ownerKind: normalized.owner.kind,
      ownerId: normalized.owner.id,
      ownerToken: ownerToken(),
      originRoot: repository.originRoot,
      gitCommonDir: repository.gitCommonDir,
      path: normalized.path,
      branchRef: normalized.branchRef,
      baseCommit: normalized.baseCommit,
      headCommit: null,
      state: "allocating",
      createdAt: now,
      updatedAt: now,
      disposition: null,
      lastError: null,
    };
    atomicManifestWrite(observed.path, manifest, lock, { fault, operation: "intent-write" });
    return receipt(manifest, observed.path);
  } finally { releaseReceipt(lock); }
}

export function activateAllocation({ originRoot, id, ownerToken: token, headCommit, fault, lockTimeoutMs, commandObserver } = {}) {
  const repository = canonicalRepository(originRoot, commandObserver);
  const normalizedId = requireId(id);
  const expectedHead = fullCommit(repository.originRoot, headCommit, commandObserver);
  const lock = acquireRegistryLock(repository.originRoot, { lockTimeoutMs, fault });
  try {
    assertLockOwned(lock);
    const observed = readManifest(repository.originRoot, normalizedId);
    if (!observed.manifest) throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", "allocation manifest is missing");
    const current = observed.manifest;
    assertManifestRepository(current, repository);
    assertOwner(current, token);
    if (current.state === "active") {
      if (current.headCommit !== expectedHead) throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "active allocation HEAD changed");
      inspectWorktree(current, commandObserver);
      return receipt(current, observed.path);
    }
    if (current.state !== "allocating") throw failure("WORKTREE_LIFECYCLE_STATE_CONFLICT", `allocation cannot activate from ${current.state}`);
    const inspected = inspectWorktree(current, commandObserver);
    if (inspected.headCommit !== expectedHead) throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "activation HEAD does not match the worktree");
    const next = { ...current, headCommit: inspected.headCommit, state: "active", updatedAt: new Date().toISOString(), disposition: null, lastError: null };
    atomicManifestWrite(observed.path, next, lock, { fault, operation: "activate-write" });
    return receipt(next, observed.path);
  } finally { releaseReceipt(lock); }
}

export function markDisposition({ originRoot, id, ownerToken: token, disposition, fault, lockTimeoutMs, commandObserver } = {}) {
  const repository = canonicalRepository(originRoot, commandObserver);
  const normalizedId = requireId(id);
  const target = normalizeDisposition(disposition);
  if (!DISPOSITION_STATES.has(target.state)) throw invalid("disposition state is invalid");
  const lock = acquireRegistryLock(repository.originRoot, { lockTimeoutMs, fault });
  try {
    assertLockOwned(lock);
    const observed = readManifest(repository.originRoot, normalizedId);
    if (!observed.manifest) throw failure("WORKTREE_LIFECYCLE_MANIFEST_INVALID", "allocation manifest is missing");
    const current = observed.manifest;
    assertManifestRepository(current, repository);
    assertOwner(current, token);
    const desiredDisposition = { state: target.state, reason: target.reason };
    if (current.state === target.state && JSON.stringify(current.disposition) === JSON.stringify(desiredDisposition)) {
      return receipt(current, observed.path);
    }
    if (!legalTransition(current.state, target.state)) {
      throw failure("WORKTREE_LIFECYCLE_STATE_CONFLICT", `allocation cannot transition from ${current.state} to ${target.state}`);
    }
    let headCommit = current.headCommit;
    if (target.state === "reclaimable" || target.state === "preserved") {
      headCommit = inspectWorktree(current, commandObserver).headCommit;
    } else if (target.state === "released") {
      if (existsSync(current.path) || registrationFor(repository.originRoot, current.path, commandObserver)) {
        throw failure("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", "released allocation still has worktree resources");
      }
    }
    const next = {
      ...current,
      headCommit,
      state: target.state,
      updatedAt: new Date().toISOString(),
      disposition: desiredDisposition,
      lastError: target.state === "cleanup-debt" ? (target.lastError ?? {
        code: "WORKTREE_LIFECYCLE_CLEANUP_DEBT",
        message: target.reason ?? "cleanup debt requires inspection",
        at: new Date().toISOString(),
      }) : null,
    };
    atomicManifestWrite(observed.path, next, lock, { fault, operation: `${target.state === "released" ? "released" : "disposition"}-write` });
    return receipt(next, observed.path);
  } finally { releaseReceipt(lock); }
}
