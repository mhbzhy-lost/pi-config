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
  createManagedWorkspaceRequestV2,
} from "./contract.ts";
import {
  isPreparedWorkspaceDisposition,
  dispositionBindingMatches,
} from "./disposition-contract.ts";

const RECORD_SCHEMA_V2 = "managed-workspace-ledger.v2";
const LEGACY_RECORD_SCHEMA_V1 = "managed-workspace-ledger.v1";
const LOCK_SCHEMA = "managed-workspace-lock.v1";
const OWNER_TOKEN = /^managed-workspace-owner\.v1:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECORD_V2_KEYS = [
  "schemaVersion", "workspaceId", "request", "requestHash", "ownerToken", "leaseId",
  "path", "dispatchCwd", "branchRef", "state", "run", "disposition", "cleanupDebt",
  "actionChallenge", "pendingAction", "integrationIntent", "integrationReceipt", "integrationHistory", "createdAt", "updatedAt", "revision",
  "publishedArtifact", "v2Action", "application", "recoveryChallenge", "recoveryPlan", "terminalProof",
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

// workspace record 的权威状态词表。其他生命周期词不是 ledger state。
export const MANAGED_WORKSPACE_STATES = [
  "reserved", "allocating", "active", "disposing", "preserved", "released", "cleanup-debt",
] as const;
export type ManagedWorkspaceState = typeof MANAGED_WORKSPACE_STATES[number];
export function allowedActionsFor(state: ManagedWorkspaceState | string): readonly string[] {
  switch (state) {
    case "reserved":
    case "allocating":
    case "released": return [];
    case "active": return ["status", "dispose"];
    case "disposing": return ["dispose"];
    case "preserved":
    case "cleanup-debt": return ["release"];
    default: throw new Error(`${String(state)} is not a managed workspace state`);
  }
}
const STATES = new Set<string>(MANAGED_WORKSPACE_STATES);

type LedgerFault = (event: { operation: string; phase: string; workspaceId: string }) => void;
type LedgerOptions = { stateRoot?: string; storageRepositoryId?: string; fault?: LedgerFault };
type LoadOptions = { originRoot?: string };
type MutateOptions = { originRoot?: string; leaseId?: string };

function failure(code: string, message: string, cause?: unknown): ManagedWorkspaceError {
  return new ManagedWorkspaceError(code, message, cause);
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

export function managedWorkspacePaths({ stateRoot, originRoot, workspaceId, storageRepositoryId }) {
  const root = normalizedStateRoot(stateRoot);
  const origin = canonicalOrigin(originRoot);
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(workspaceId) || workspaceId.includes("..")) {
    throw failure("MANAGED_WORKSPACE_ID", "workspaceId is invalid");
  }
  const repositoriesDir = path.join(root, "repositories");
  const storageId = storageRepositoryId ?? repositoryId(origin);
  if (!SHA256.test(storageId)) throw failure("MANAGED_WORKSPACE_STORAGE", "storageRepositoryId is invalid");
  const repositoryDir = path.join(repositoriesDir, storageId);
  const recordsDir = path.join(repositoryDir, "records");
  const worktreesDir = path.join(repositoryDir, "worktrees");
  return {
    stateRoot: root,
    originRoot: origin,
    repositoryId: repositoryId(origin),
    storageRepositoryId: storageId,
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

function openNoFollow(file, flags, mode = 0o600) {
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

function validateActionChallenge(value) {
  return value === null || (exactKeys(value, ["tokenHash", "snapshotHash", "allowed", "proofHash", "used"])
    && SHA256.test(value.tokenHash)
    // Release-only challenges have no workspace snapshot to bind; disposition
    // challenges always carry the inspected snapshot hash.
    && (value.snapshotHash === null || SHA256.test(value.snapshotHash))
    && Array.isArray(value.allowed) && value.allowed.length > 0
    && value.allowed.every((item) => ["integrate", "discard", "preserve", "publish", "apply", "release"].includes(item))
    && new Set(value.allowed).size === value.allowed.length
    && (value.proofHash === null || SHA256.test(value.proofHash)) && typeof value.used === "boolean");
}

function validatePendingAction(value) {
  if (isPreparedWorkspaceDisposition(value)) return true;
  return value === null || (exactKeys(value, ["disposition", "strategy", "reason", "snapshotHash", "proofHash", "executorHead"])
    && ["integrate", "discard", "preserve"].includes(value.disposition)
    && (value.disposition === "integrate" ? ["cherry-pick", "merge"].includes(value.strategy) : value.strategy === null)
    && (value.disposition === "preserve" ? typeof value.reason === "string" && value.reason.length > 0 : value.reason === null)
    && SHA256.test(value.snapshotHash) && (value.proofHash === null || SHA256.test(value.proofHash))
    && (value.executorHead === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.executorHead)));
}

function validateRecoveryChallenge(value) {
  return value === null || (exactKeys(value, ["generation", "planHash", "nonceHash", "expiresAt", "consumedAt"])
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && SHA256.test(value.planHash) && SHA256.test(value.nonceHash)
    && typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt))
    && (value.consumedAt === null || (typeof value.consumedAt === "string" && !Number.isNaN(Date.parse(value.consumedAt)))));
}

function validateIntegrationIntent(value) {
  return value === null || (exactKeys(value, ["integrationIntentId", "queueItemId", "queueLeaseId", "admissionGeneration", "targetRef", "targetHead", "candidateHead", "ownerScope", "workspaceLeaseId", "createdAt"])
    && typeof value.integrationIntentId === "string" && value.integrationIntentId.length > 0
    && typeof value.queueItemId === "string" && value.queueItemId.length > 0
    && typeof value.queueLeaseId === "string" && value.queueLeaseId.length > 0
    && Number.isSafeInteger(value.admissionGeneration) && value.admissionGeneration > 0
    && typeof value.targetRef === "string" && value.targetRef.startsWith("refs/heads/")
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.targetHead)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.candidateHead)
    && exactKeys(value.ownerScope, ["kind", "rootSessionId"])
    && value.ownerScope.kind === "standalone-subagent" && typeof value.ownerScope.rootSessionId === "string"
    && SHA256.test(value.workspaceLeaseId)
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)));
}

function validateIntegrationReceipt(value) {
  return value === null || (exactKeys(value, ["receiptId", "integrationIntentId", "queueItemId", "candidateHead", "targetRef", "completedAt"])
    && typeof value.receiptId === "string" && value.receiptId.length > 0
    && typeof value.integrationIntentId === "string" && value.integrationIntentId.length > 0
    && typeof value.queueItemId === "string" && value.queueItemId.length > 0
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.candidateHead)
    && typeof value.targetRef === "string" && value.targetRef.startsWith("refs/heads/")
    && typeof value.completedAt === "string" && !Number.isNaN(Date.parse(value.completedAt)));
}

function validateIntegrationHistory(value) {
  return Array.isArray(value) && value.every(entry => exactKeys(entry, ["intent", "disposition", "closedAt"])
    && validateIntegrationIntent(entry.intent) && entry.intent !== null && entry.disposition === "preserved"
    && typeof entry.closedAt === "string" && !Number.isNaN(Date.parse(entry.closedAt)));
}

function validateRecordEnvelope(value, filenameWorkspaceId?: string) {
  if (!exactKeys(value, RECORD_V2_KEYS) || value.schemaVersion !== RECORD_SCHEMA_V2 || !STATES.has(value.state)
      || !SHA256.test(value.requestHash) || !OWNER_TOKEN.test(value.ownerToken) || !SHA256.test(value.leaseId)
      || createHash("sha256").update(value.ownerToken).digest("hex") !== value.leaseId
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
      || typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))
      || !validateActionChallenge(value.actionChallenge) || !validatePendingAction(value.pendingAction)
      || !validateIntegrationIntent(value.integrationIntent) || !validateIntegrationReceipt(value.integrationReceipt) || !validateIntegrationHistory(value.integrationHistory)
      || (filenameWorkspaceId !== undefined && value.workspaceId !== filenameWorkspaceId)
      || (value.publishedArtifact !== null && (typeof value.publishedArtifact !== "object" || Array.isArray(value.publishedArtifact)))
      || (value.v2Action !== null && (typeof value.v2Action !== "object" || Array.isArray(value.v2Action)))
      || !validateRecoveryChallenge(value.recoveryChallenge)
      || (value.recoveryPlan !== null && !SHA256.test(value.recoveryPlan))) {
    throw failure("MANAGED_WORKSPACE_SCHEMA", "managed workspace record schema is invalid");
  }
  if (isPreparedWorkspaceDisposition(value.pendingAction) && (!dispositionBindingMatches(value, value.pendingAction)
      || value.pendingAction.authorizedRevision >= value.revision)) {
    throw failure("MANAGED_WORKSPACE_SCHEMA", "prepared disposition does not match its workspace authority");
  }
  return createManagedWorkspaceRequestV2(value.request);
}

function validateRecord(value, expectedOrigin) {
  const request = validateRecordEnvelope(value);
  if (request.originRoot !== expectedOrigin || hashValue(request) !== value.requestHash || request.workspaceId !== value.workspaceId) {
    throw failure("MANAGED_WORKSPACE_IDENTITY", "managed workspace request identity is invalid");
  }
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
    schemaVersion: RECORD_SCHEMA_V2,
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
    integrationIntent: null,
    integrationReceipt: null,
    integrationHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0,
    publishedArtifact: null,
    v2Action: null,
    application: null,
    recoveryChallenge: null,
    recoveryPlan: null,
    terminalProof: null,
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

// invalid record 的安全诊断投影：只保留 repository partition、record filename/
// workspaceId、schema/error code 和可结构化解析的 owner scope；绝不包含
// ownerToken、lease token、原始 JSON 或私有原始路径。
export type LedgerOwnerScopeProjection = { kind: string; rootSessionId: string };
export type LedgerInvalidRecordDiagnostic = {
  kind: "ledger-record" | "ledger-storage";
  status: "invalid";
  repositoryPartition: string | null;
  workspaceId: string | null;
  schemaVersion: string | null;
  legacyV1: boolean;
  errorCode: string;
  ownerScope: LedgerOwnerScopeProjection | null;
  originRootPresent: boolean | null;
};

function parseOwnerScopeProjection(value): LedgerOwnerScopeProjection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.kind !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.kind) || value.kind.includes("..")) return null;
  if (typeof value.rootSessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.rootSessionId) || value.rootSessionId.includes("..")) return null;
  return { kind: value.kind, rootSessionId: value.rootSessionId };
}

function originRootPresence(parsed): boolean | null {
  const originRoot = parsed?.request?.originRoot;
  if (typeof originRoot !== "string" || originRoot.length === 0) return null;
  try { return existsSync(originRoot); } catch { return null; }
}

function recordDiagnostic(repositoryPartition: string, workspaceId: string, parsed, errorCode: string): LedgerInvalidRecordDiagnostic {
  const schemaVersion = typeof parsed?.schemaVersion === "string" ? parsed.schemaVersion : null;
  return Object.freeze({
    kind: "ledger-record",
    status: "invalid",
    repositoryPartition,
    workspaceId,
    schemaVersion,
    legacyV1: schemaVersion === LEGACY_RECORD_SCHEMA_V1,
    errorCode,
    ownerScope: parseOwnerScopeProjection(parsed?.request?.owner),
    originRootPresent: originRootPresence(parsed),
  });
}

function storageDiagnostic(repositoryPartition: string | null, errorCode: string): LedgerInvalidRecordDiagnostic {
  return Object.freeze({
    kind: "ledger-storage",
    status: "invalid",
    repositoryPartition,
    workspaceId: null,
    schemaVersion: null,
    legacyV1: false,
    errorCode,
    ownerScope: null,
    originRootPresent: null,
  });
}

// 复用单条 record 的全部严格校验做失败分类；未编码的异常（如 request contract
// 抛出的 TypeError）统一归入 schema 失败，不放宽任何校验。
function classifyRecordFailure(parsed, workspaceId): string | null {
  try {
    const request = validateRecordEnvelope(parsed, workspaceId);
    validateRecord(parsed, canonicalOrigin(request.originRoot));
    return null;
  } catch (error) {
    return error?.code ?? "MANAGED_WORKSPACE_SCHEMA";
  }
}

export function createManagedWorkspaceLedger({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, storageRepositoryId, fault }: LedgerOptions = {}) {
  const root = normalizedStateRoot(stateRoot);
  if (storageRepositoryId !== undefined && !SHA256.test(storageRepositoryId)) throw failure("MANAGED_WORKSPACE_STORAGE", "storageRepositoryId is invalid");

  function locate(workspaceId, originRoot) {
    if (originRoot) return managedWorkspacePaths({ stateRoot: root, originRoot, workspaceId, storageRepositoryId });
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
    return { ...matches[0], originRoot: canonicalOrigin(parsed?.request?.originRoot), repositoryId: path.basename(matches[0].repositoryDir), storageRepositoryId: path.basename(matches[0].repositoryDir), repositoriesDir: path.join(root, "repositories") };
  }

  function reserve(value) {
    const supplied = createManagedWorkspaceRequestV2(value);
    const canonicalized = {
      ...supplied,
      originRoot: canonicalOrigin(supplied.originRoot),
      requestedCwd: canonicalOrigin(supplied.requestedCwd),
    };
    const input = createManagedWorkspaceRequestV2(canonicalized);
    const paths = managedWorkspacePaths({ stateRoot: root, originRoot: input.originRoot, workspaceId: input.workspaceId, storageRepositoryId });
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

  function load(workspaceId, { originRoot }: LoadOptions = {}) {
    const paths = locate(workspaceId, originRoot);
    return privateLease(readRecord(paths));
  }

  function mutate(workspaceId, change, { originRoot, leaseId }: MutateOptions = {}) {
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

  function issueRecoveryChallenge(workspaceId, { planHash, expiresAt }: { planHash: string; expiresAt?: string }) {
    const lease = locate(workspaceId, undefined);
    return withLock(lease, () => {
      const current = readRecord(lease);
      if (!SHA256.test(planHash)) throw failure("MANAGED_WORKSPACE_RECOVERY", "recovery plan hash is invalid");
      const expiry = expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
      if (typeof expiry !== "string" || Number.isNaN(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()) throw failure("MANAGED_WORKSPACE_RECOVERY", "recovery challenge expiry is invalid");
      const nonce = randomBytes(32).toString("hex");
      const challenge = { generation: current.revision + 1, planHash, nonceHash: hashValue(nonce), expiresAt: expiry, consumedAt: null };
      const next = structuredClone(current);
      next.recoveryChallenge = challenge;
      next.recoveryPlan = planHash;
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      validateRecord(next, lease.originRoot);
      atomicWrite(lease, next, fault);
      return Object.freeze({ ...challenge, nonce });
    });
  }

  function consumeRecoveryChallenge(workspaceId, challenge, { originRoot, leaseId }: MutateOptions = {}) {
    const paths = locate(workspaceId, originRoot);
    return withLock(paths, () => {
      const current = readRecord(paths);
      if (!current.recoveryChallenge) throw failure("MANAGED_WORKSPACE_RECOVERY", "recovery challenge is unavailable");
      const stored = current.recoveryChallenge;
      if (leaseId !== undefined && current.leaseId !== leaseId) throw failure("MANAGED_WORKSPACE_CAS", "workspace lease identity changed");
      if (!challenge || current.revision !== stored.generation || challenge.generation !== stored.generation || challenge.planHash !== stored.planHash
          || challenge.nonceHash !== stored.nonceHash || stored.consumedAt !== null
          || Date.parse(stored.expiresAt) <= Date.now() || typeof challenge.nonce !== "string"
          || hashValue(challenge.nonce) !== stored.nonceHash) throw failure("MANAGED_WORKSPACE_RECOVERY", "recovery challenge is stale, expired, or replayed");
      const next = structuredClone(current);
      next.recoveryChallenge.consumedAt = new Date().toISOString();
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      validateRecord(next, paths.originRoot);
      atomicWrite(paths, next, fault);
      return privateLease(next);
    });
  }

  function listScoped({ owner, onInvalid }: { owner: { kind: "standalone-subagent"; rootSessionId: string }; onInvalid?: (diagnostic: LedgerInvalidRecordDiagnostic) => void }) {
    if (!exactKeys(owner, ["kind", "rootSessionId"]) || owner.kind !== "standalone-subagent"
        || typeof owner.rootSessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(owner.rootSessionId) || owner.rootSessionId.includes("..")) {
      throw failure("MANAGED_WORKSPACE_OWNER_SCOPE", "workspace owner scope is invalid");
    }
    const records = [];
    for (const repositoryDir of scopeDirectories(root)) {
      const recordsDir = path.join(repositoryDir, "records");
      if (!existsSync(recordsDir)) continue;
      const info = lstatSync(recordsDir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_STORAGE", "records storage is invalid");
      for (const entry of readdirSync(recordsDir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".json")) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_RECORD", "records storage contains a non-regular entry");
        const workspaceId = entry.name.slice(0, -".json".length);
        const parsed = readPrivateJson(path.join(recordsDir, entry.name), "managed workspace record");
        if (typeof onInvalid === "function" && parsed?.schemaVersion === LEGACY_RECORD_SCHEMA_V1) {
          // 带 owner 的跳过只允许三元条件同时成立：原始 schemaVersion 明确是
          // v1 legacy、owner 形状可结构化解析、且 scope 可证明不等于查询 scope。
          // v2 校验失败、owner 形状不可信或 scope 相同一律继续走下方严格
          // fail-closed 路径；不信任任何坏 v2 record 自报的 owner。
          const ownerScope = parseOwnerScopeProjection(parsed?.request?.owner);
          if (ownerScope && (ownerScope.kind !== owner.kind || ownerScope.rootSessionId !== owner.rootSessionId)) {
            onInvalid(recordDiagnostic(path.basename(repositoryDir), workspaceId, parsed, classifyRecordFailure(parsed, workspaceId) ?? "MANAGED_WORKSPACE_SCHEMA"));
            continue;
          }
        }
        const request = validateRecordEnvelope(parsed, workspaceId);
        if (hashValue(request) !== parsed.requestHash || request.workspaceId !== parsed.workspaceId) {
          throw failure("MANAGED_WORKSPACE_IDENTITY", "managed workspace request identity is invalid");
        }
        if (request.owner.kind !== owner.kind || request.owner.rootSessionId !== owner.rootSessionId) continue;
        records.push(validateRecord(parsed, canonicalOrigin(request.originRoot)));
      }
    }
    return records.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)).map((record) => structuredClone(record));
  }

  function list({ originRoot, storagePartitionOnly = false, onInvalid }: LoadOptions & { storagePartitionOnly?: boolean; onInvalid?: (diagnostic: LedgerInvalidRecordDiagnostic) => void } = {}) {
    const records = [];
    const scopes = originRoot
      ? [managedWorkspacePaths({ stateRoot: root, originRoot, workspaceId: "inventory", storageRepositoryId }).repositoryDir]
      : scopeDirectories(root).filter(directory => !storagePartitionOnly || path.basename(directory) === storageRepositoryId);
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
        // 无 owner 的 callback 扫描只允许跳过原始 schemaVersion 明确为 v1 legacy
        // 的 record 并记录诊断；owner 字段不构成授权依据，v2/未知 schema 仍走
        // 严格校验。未提供 callback 时保持默认严格 fail-closed 行为。
        if (typeof onInvalid === "function" && parsed?.schemaVersion === LEGACY_RECORD_SCHEMA_V1) {
          onInvalid(recordDiagnostic(path.basename(repositoryDir), entry.name.slice(0, -".json".length), parsed, classifyRecordFailure(parsed, entry.name.slice(0, -".json".length)) ?? "MANAGED_WORKSPACE_SCHEMA"));
          continue;
        }
        records.push(validateRecord(parsed, canonicalOrigin(parsed.request.originRoot)));
      }
    }
    return records.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)).map((record) => structuredClone(record));
  }

  // 只读全 state root 扫描：报告所有无法通过单条严格校验的 record/storage 状态，
  // 不修改任何文件，也不吞掉错误码；用于管理面 audit 与 legacy quarantine 规划。
  function scanInvalidRecords(): LedgerInvalidRecordDiagnostic[] {
    const diagnostics: LedgerInvalidRecordDiagnostic[] = [];
    let partitions: string[] = [];
    try {
      partitions = scopeDirectories(root);
    } catch (error) {
      diagnostics.push(storageDiagnostic(null, error?.code ?? "MANAGED_WORKSPACE_STORAGE"));
      return diagnostics;
    }
    for (const repositoryDir of partitions) {
      const repositoryPartition = path.basename(repositoryDir);
      const recordsDir = path.join(repositoryDir, "records");
      if (!existsSync(recordsDir)) continue;
      let entries;
      try {
        const info = lstatSync(recordsDir);
        if (!info.isDirectory() || info.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_STORAGE", "records storage is invalid");
        entries = readdirSync(recordsDir, { withFileTypes: true });
      } catch (error) {
        diagnostics.push(storageDiagnostic(repositoryPartition, error?.code ?? "MANAGED_WORKSPACE_STORAGE"));
        continue;
      }
      for (const entry of entries) {
        if (!entry.name.endsWith(".json")) continue;
        const workspaceId = entry.name.slice(0, -".json".length);
        const recordPath = path.join(recordsDir, entry.name);
        let parsed;
        let errorCode: string | null = null;
        try {
          if (!entry.isFile() || entry.isSymbolicLink()) throw failure("MANAGED_WORKSPACE_RECORD", "records storage contains a non-regular entry");
          parsed = readPrivateJson(recordPath, "managed workspace record");
          errorCode = classifyRecordFailure(parsed, workspaceId);
        } catch (error) {
          errorCode = error?.code ?? "MANAGED_WORKSPACE_RECORD";
        }
        if (errorCode === null) continue;
        diagnostics.push(recordDiagnostic(repositoryPartition, workspaceId, parsed, errorCode));
      }
    }
    return diagnostics.sort((left, right) =>
      `${left.repositoryPartition ?? ""}/${left.workspaceId ?? ""}`.localeCompare(`${right.repositoryPartition ?? ""}/${right.workspaceId ?? ""}`));
  }

  return Object.freeze({ stateRoot: root, reserve, load, mutate, list, listScoped, scanInvalidRecords, issueRecoveryChallenge, consumeRecoveryChallenge });
}
