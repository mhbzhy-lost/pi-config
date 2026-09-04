import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  createManagedWorkspaceRequest,
  publicManagedWorkspaceReceipt,
} from "./contract.ts";

const RECORD_SCHEMA = "managed-workspace-ledger.v1";
const LOCK_SCHEMA = "managed-workspace-lock.v1";
const OWNER_TOKEN = /^managed-workspace-owner\.v1:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATES = new Set(["reserved", "allocating", "active", "disposing", "preserved", "released", "cleanup-debt"]);
const RECORD_KEYS = [
  "schemaVersion", "workspaceId", "request", "requestHash", "ownerToken", "leaseId",
  "path", "dispatchCwd", "branchRef", "state", "run", "disposition", "cleanupDebt",
  "actionChallenge", "pendingAction", "createdAt", "updatedAt", "revision",
];

function failure(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function normalizedStateRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    throw failure("MANAGED_WORKSPACE_STATE_ROOT", "PI_CODING_WORKSPACE_DIR must be a normalized absolute path");
  }
  let cursor = value;
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw failure("MANAGED_WORKSPACE_STATE_ROOT", "PI_CODING_WORKSPACE_DIR has no available ancestor");
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  let canonical;
  try { canonical = realpathSync(cursor); }
  catch (cause) { throw failure("MANAGED_WORKSPACE_STATE_ROOT", "PI_CODING_WORKSPACE_DIR ancestor is unavailable", cause); }
  return missing.reduce((current, segment) => path.join(current, segment), canonical);
}

function canonicalOrigin(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw failure("MANAGED_WORKSPACE_ORIGIN", "originRoot must be absolute");
  try {
    return realpathSync(value);
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_ORIGIN", "originRoot is unavailable", cause);
  }
}

function repositoryId(originRoot) {
  return createHash("sha256").update(originRoot).digest("hex");
}

export function managedWorkspacePaths({ stateRoot, originRoot, workspaceId }) {
  const root = normalizedStateRoot(stateRoot);
  const origin = canonicalOrigin(originRoot);
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(workspaceId) || workspaceId.includes("..")) {
    throw failure("MANAGED_WORKSPACE_ID", "workspaceId is invalid");
  }
  const repositoriesDir = path.join(root, "repositories");
  const repositoryDir = path.join(repositoriesDir, repositoryId(origin));
  const recordsDir = path.join(repositoryDir, "records");
  const worktreesDir = path.join(repositoryDir, "worktrees");
  return {
    stateRoot: root,
    originRoot: origin,
    repositoryId: repositoryId(origin),
    repositoriesDir,
    repositoryDir,
    recordsDir,
    worktreesDir,
    recordPath: path.join(recordsDir, `${workspaceId}.json`),
    worktreePath: path.join(worktreesDir, workspaceId),
    lockPath: path.join(repositoryDir, "ledger.lock"),
  };
}

function ensureDirectory(value) {
  const existed = existsSync(value);
  mkdirSync(value, { recursive: true, mode: 0o700 });
  const info = lstatSync(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_STORAGE", `storage path is not a directory: ${value}`);
  if (!existed) chmodSync(value, 0o700);
  return value;
}

function ensureStorage(paths) {
  for (const directory of [paths.stateRoot, paths.repositoriesDir, paths.repositoryDir, paths.recordsDir, paths.worktreesDir]) ensureDirectory(directory);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function processBirthIdentity(pid) {
  try {
    const output = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (output.length === 0 || !output.toString().trim()) throw new Error("missing process");
    return createHash("sha256").update(output).digest("hex");
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_PROCESS_IDENTITY", "process birth identity is unavailable", cause);
  }
}

let ownBirthIdentity;
function ownBirth() {
  ownBirthIdentity ??= processBirthIdentity(process.pid);
  return ownBirthIdentity;
}

function openNoFollow(file, flags, mode) {
  return openSync(file, flags | (constants.O_NOFOLLOW ?? 0), mode);
}

function readPrivateJson(file, label) {
  let info;
  try {
    info = lstatSync(file);
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_RECORD", `${label} is unavailable`, cause);
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    throw failure("MANAGED_WORKSPACE_RECORD", `${label} must be a 0600 regular file and not a symlink`);
  }
  let descriptor;
  try {
    descriptor = openNoFollow(file, constants.O_RDONLY);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("identity changed");
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (cause) {
    throw failure("MANAGED_WORKSPACE_RECORD", `${label} is invalid`, cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writePrivateFile(file, value) {
  const descriptor = openNoFollow(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(file, 0o600);
}

function atomicWrite(paths, record, fault) {
  const temporary = path.join(paths.recordsDir, `.${record.workspaceId}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fault?.({ operation: "record-write", phase: "before-write", workspaceId: record.workspaceId });
    writePrivateFile(temporary, record);
    renameSync(temporary, paths.recordPath);
    chmodSync(paths.recordPath, 0o600);
    const directory = openSync(paths.recordsDir, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    fault?.({ operation: "record-write", phase: "after-rename", workspaceId: record.workspaceId });
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause?.code === "TEST_FAULT" ? cause : failure("MANAGED_WORKSPACE_WRITE", "managed workspace record write failed", cause);
  }
}

function lockOwnerState(lock) {
  if (!exactKeys(lock, ["schemaVersion", "token", "pid", "birthIdentity", "createdAt"])
      || lock.schemaVersion !== LOCK_SCHEMA || typeof lock.token !== "string" || !lock.token
      || !Number.isSafeInteger(lock.pid) || lock.pid < 1 || !SHA256.test(lock.birthIdentity)
      || typeof lock.createdAt !== "string" || Number.isNaN(Date.parse(lock.createdAt))) return "invalid";
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
  try {
    return processBirthIdentity(lock.pid) === lock.birthIdentity ? "live" : "dead";
  } catch {
    return "unknown";
  }
}

function acquireLock(paths) {
  const value = {
    schemaVersion: LOCK_SCHEMA,
    token: randomUUID(),
    pid: process.pid,
    birthIdentity: ownBirth(),
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writePrivateFile(paths.lockPath, value);
      return value;
    } catch (error) {
      if (error?.code !== "EEXIST") throw failure("MANAGED_WORKSPACE_LOCK", "ledger lock cannot be created", error);
    }
    let observed;
    try { observed = readPrivateJson(paths.lockPath, "ledger lock"); }
    catch (cause) { throw failure("MANAGED_WORKSPACE_LOCK", "ledger lock is invalid", cause); }
    const state = lockOwnerState(observed);
    if (state !== "dead") throw failure("MANAGED_WORKSPACE_LOCK", `ledger lock owner is ${state}`);
    const quarantine = `${paths.lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(paths.lockPath, quarantine);
      rmSync(quarantine, { force: true });
    } catch (cause) {
      throw failure("MANAGED_WORKSPACE_LOCK", "stale ledger lock cannot be quarantined", cause);
    }
  }
  throw failure("MANAGED_WORKSPACE_LOCK", "ledger lock cannot be acquired");
}

function releaseLock(paths, lock) {
  try {
    const observed = readPrivateJson(paths.lockPath, "ledger lock");
    if (observed.token === lock.token && observed.pid === lock.pid && observed.birthIdentity === lock.birthIdentity) unlinkSync(paths.lockPath);
  } catch (error) {
    if (existsSync(paths.lockPath)) throw error;
  }
}

function withLock(paths, operation) {
  ensureStorage(paths);
  const lock = acquireLock(paths);
  try { return operation(); }
  finally { releaseLock(paths, lock); }
}

function receiptFields(record) {
  return {
    schemaVersion: "managed-workspace.v1",
    workspaceId: record.workspaceId,
    leaseId: record.leaseId,
    owner: record.request.owner,
    originRoot: record.request.originRoot,
    requestedCwd: record.request.requestedCwd,
    originRef: record.request.originRef,
    baseCommit: record.request.baseCommit,
    path: record.path,
    dispatchCwd: record.dispatchCwd,
    branchRef: record.branchRef,
    state: record.state,
    run: record.run,
    disposition: record.disposition,
    cleanupDebt: record.cleanupDebt,
  };
}

function validateActionChallenge(value) {
  return value === null || (exactKeys(value, ["tokenHash", "snapshotHash", "allowed", "proofHash", "used"])
    && SHA256.test(value.tokenHash) && SHA256.test(value.snapshotHash)
    && Array.isArray(value.allowed) && value.allowed.length > 0
    && value.allowed.every((item) => ["integrate", "discard", "preserve"].includes(item))
    && new Set(value.allowed).size === value.allowed.length
    && (value.proofHash === null || SHA256.test(value.proofHash)) && typeof value.used === "boolean");
}

function validatePendingAction(value) {
  return value === null || (exactKeys(value, ["disposition", "strategy", "reason", "snapshotHash", "proofHash", "executorHead"])
    && ["integrate", "discard", "preserve"].includes(value.disposition)
    && (value.disposition === "integrate" ? ["cherry-pick", "merge"].includes(value.strategy) : value.strategy === null)
    && (value.disposition === "preserve" ? typeof value.reason === "string" && value.reason.length > 0 : value.reason === null)
    && SHA256.test(value.snapshotHash) && (value.proofHash === null || SHA256.test(value.proofHash))
    && (value.executorHead === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.executorHead)));
}

function validateRecord(value, expectedOrigin) {
  if (!exactKeys(value, RECORD_KEYS) || value.schemaVersion !== RECORD_SCHEMA || !STATES.has(value.state)
      || !SHA256.test(value.requestHash) || !OWNER_TOKEN.test(value.ownerToken) || !SHA256.test(value.leaseId)
      || createHash("sha256").update(value.ownerToken).digest("hex") !== value.leaseId
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
      || typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))
      || !validateActionChallenge(value.actionChallenge) || !validatePendingAction(value.pendingAction)) {
    throw failure("MANAGED_WORKSPACE_SCHEMA", "managed workspace record schema is invalid");
  }
  const request = createManagedWorkspaceRequest(value.request);
  if (request.originRoot !== expectedOrigin || hashValue(request) !== value.requestHash || request.workspaceId !== value.workspaceId) {
    throw failure("MANAGED_WORKSPACE_IDENTITY", "managed workspace request identity is invalid");
  }
  publicManagedWorkspaceReceipt({ ...receiptFields(value), ownerToken: value.ownerToken });
  return value;
}

function readRecord(paths) {
  return validateRecord(readPrivateJson(paths.recordPath, "managed workspace record"), paths.originRoot);
}

function privateLease(record) {
  return structuredClone({ workspaceId: record.workspaceId, leaseId: record.leaseId, ownerToken: record.ownerToken, revision: record.revision, record });
}

function requestPlan(input, paths) {
  const relativeCwd = path.relative(input.originRoot, input.requestedCwd);
  const dispatchCwd = path.join(paths.worktreePath, relativeCwd);
  const ownerToken = `managed-workspace-owner.v1:${randomBytes(32).toString("hex")}`;
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: RECORD_SCHEMA,
    workspaceId: input.workspaceId,
    request: input,
    requestHash: hashValue(input),
    ownerToken,
    leaseId: createHash("sha256").update(ownerToken).digest("hex"),
    path: paths.worktreePath,
    dispatchCwd,
    branchRef: `refs/heads/pi-managed/${input.workspaceId}`,
    state: "reserved",
    run: null,
    disposition: null,
    cleanupDebt: null,
    actionChallenge: null,
    pendingAction: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0,
  };
}

function scopeDirectories(stateRoot) {
  const repositoriesDir = path.join(stateRoot, "repositories");
  if (!existsSync(repositoriesDir)) return [];
  const info = lstatSync(repositoriesDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_STORAGE", "repositories storage is invalid");
  return readdirSync(repositoriesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && SHA256.test(entry.name))
    .map((entry) => path.join(repositoriesDir, entry.name));
}

export function managedWorkspaceReceiptFromRecord(record) {
  return publicManagedWorkspaceReceipt({ ...receiptFields(record), ownerToken: record.ownerToken });
}

export function createManagedWorkspaceLedger({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, fault } = {}) {
  const root = normalizedStateRoot(stateRoot);

  function locate(workspaceId, originRoot) {
    if (originRoot) return managedWorkspacePaths({ stateRoot: root, originRoot, workspaceId });
    const matches = [];
    for (const repositoryDir of scopeDirectories(root)) {
      const recordPath = path.join(repositoryDir, "records", `${workspaceId}.json`);
      if (existsSync(recordPath)) matches.push({
        stateRoot: root,
        repositoryDir,
        recordsDir: path.join(repositoryDir, "records"),
        worktreesDir: path.join(repositoryDir, "worktrees"),
        recordPath,
        worktreePath: path.join(repositoryDir, "worktrees", workspaceId),
        lockPath: path.join(repositoryDir, "ledger.lock"),
      });
    }
    if (matches.length !== 1) throw failure(matches.length === 0 ? "MANAGED_WORKSPACE_NOT_FOUND" : "MANAGED_WORKSPACE_CONFLICT", matches.length === 0 ? "managed workspace record was not found" : "workspaceId is not globally unique");
    const parsed = readPrivateJson(matches[0].recordPath, "managed workspace record");
    return { ...matches[0], originRoot: canonicalOrigin(parsed?.request?.originRoot), repositoryId: path.basename(matches[0].repositoryDir), repositoriesDir: path.join(root, "repositories") };
  }

  function reserve(value) {
    const supplied = createManagedWorkspaceRequest(value);
    const input = createManagedWorkspaceRequest({
      ...supplied,
      originRoot: canonicalOrigin(supplied.originRoot),
      requestedCwd: canonicalOrigin(supplied.requestedCwd),
    });
    const paths = managedWorkspacePaths({ stateRoot: root, originRoot: input.originRoot, workspaceId: input.workspaceId });
    return withLock(paths, () => {
      if (existsSync(paths.recordPath)) {
        const current = readRecord(paths);
        if (current.requestHash !== hashValue(input) || JSON.stringify(current.request) !== JSON.stringify(input)) {
          throw failure("MANAGED_WORKSPACE_CONFLICT", "workspaceId already belongs to a conflicting request");
        }
        return privateLease(current);
      }
      const record = requestPlan(input, paths);
      validateRecord(record, paths.originRoot);
      atomicWrite(paths, record, fault);
      return privateLease(record);
    });
  }

  function load(workspaceId, { originRoot } = {}) {
    const paths = locate(workspaceId, originRoot);
    return privateLease(readRecord(paths));
  }

  function mutate(workspaceId, change, { originRoot, leaseId } = {}) {
    const paths = locate(workspaceId, originRoot);
    return withLock(paths, () => {
      const current = readRecord(paths);
      if (leaseId !== undefined && current.leaseId !== leaseId) throw failure("MANAGED_WORKSPACE_CAS", "workspace lease identity changed");
      const draft = structuredClone(current);
      const changed = change(draft);
      const next = changed ?? draft;
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      validateRecord(next, paths.originRoot);
      atomicWrite(paths, next, fault);
      return privateLease(next);
    });
  }

  function list({ originRoot } = {}) {
    const records = [];
    const scopes = originRoot
      ? [managedWorkspacePaths({ stateRoot: root, originRoot, workspaceId: "inventory" }).repositoryDir]
      : scopeDirectories(root);
    for (const repositoryDir of scopes) {
      const recordsDir = path.join(repositoryDir, "records");
      if (!existsSync(recordsDir)) continue;
      const info = lstatSync(recordsDir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_STORAGE", "records storage is invalid");
      for (const entry of readdirSync(recordsDir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".json")) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_RECORD", "records storage contains a non-regular entry");
        const recordPath = path.join(recordsDir, entry.name);
        const parsed = readPrivateJson(recordPath, "managed workspace record");
        records.push(validateRecord(parsed, canonicalOrigin(parsed.request.originRoot)));
      }
    }
    return records.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)).map((record) => structuredClone(record));
  }

  return Object.freeze({ stateRoot: root, reserve, load, mutate, list });
}
