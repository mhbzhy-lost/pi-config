import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, linkSync, existsSync, chmodSync, rmSync, unlinkSync, lstatSync, fstatSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { applyEvent, createProjection } from "./events.mjs";
import { remediationSubjectHash, taskContractHash, validateRemediationMetadata, validateTaskDefinitions } from "./task-definition.mjs";

const REGISTRY_SCHEMA_VERSION = "goal-engine.registry.v1";
const LOCK_TIMEOUT_MS = 1500;
const LOCK_WAIT_MS = 10;
const IDENTITY_PROBE_FRESH_MS = 1400;
const OWNER_PROTOCOL = "goal-engine.writer-owner.v2";
const OWNER_IDENTITY_KIND = "ps-lstart-utc";
let selfBirthIdentity;
const ownerIdentityFreshness = new Map();

export function appendEventBatch(stateRoot, events, expectedVersion) {
  validateEventBatch(events);
  assertRemediationMaterializationBatch(events);
  const lock = acquireWriterLock(stateRoot);
  const goalDir = join(stateRoot, "goals", events[0].goalId);
  const eventsPath = join(goalDir, "events.jsonl");
  const projectionPath = join(goalDir, "projection.json");
  const identity = `${process.pid}-${randomUUID()}`;
  const eventsTmp = `${eventsPath}.${identity}.tmp`;
  const projectionTmp = `${projectionPath}.${identity}.tmp`;
  let registryTmp = null;
  let durable = false;

  try {
    let next = replayAndCheckVersion(stateRoot, eventsPath, expectedVersion, lock.token);
    assertCanonicalFinalizationBatch(events, next, false);
    assertCanonicalAmendmentBatch(events, next, false);
    for (const event of events) next = applyEvent(next, event);
    const registry = prepareRegistryUpdate(stateRoot, events.at(-1), next, lock.token);

    mkdirSync(goalDir, { recursive: true });
    writeBatchJsonlAndRename(stateRoot, eventsPath, eventsTmp, events, lock.token);
    durable = true;
    publishBatchProjectionWithWriterReceipt(stateRoot, projectionTmp, projectionPath, next, lock.token);
    registryTmp = publishBatchRegistry(stateRoot, registry, identity, lock.token);
    return next;
  } catch (error) {
    if (durable) throw batchDurableFailure(error);
    throw error;
  } finally {
    if (existsSync(eventsTmp)) rmSync(eventsTmp, { force: true });
    if (existsSync(projectionTmp)) rmSync(projectionTmp, { force: true });
    if (registryTmp && existsSync(registryTmp)) rmSync(registryTmp, { force: true });
    releaseWriterLock(stateRoot, lock.token);
  }
}

const MAX_SETTLEMENT_EVIDENCE_BYTES = 1_048_576;

// Publishes immutable evidence before the existing batch durability sequence while
// holding its writer receipt; a failed append can therefore leave only an orphan.
export function appendEventBatchWithSettlementEvidence(stateRoot, events, expectedVersion, artifact) {
  validateEventBatch(events);
  assertRemediationMaterializationBatch(events);
  const artifactSnapshot = validateSettlementArtifact(artifact);
  const { sha256, bytes } = artifactSnapshot;
  const canonicalRoot = resolve(stateRoot);
  const lock = acquireWriterLock(canonicalRoot);
  const goalDir = join(canonicalRoot, "goals", events[0].goalId);
  const eventsPath = join(goalDir, "events.jsonl");
  const projectionPath = join(goalDir, "projection.json");
  const identity = `${process.pid}-${randomUUID()}`;
  const eventsTmp = `${eventsPath}.${identity}.tmp`;
  const projectionTmp = `${projectionPath}.${identity}.tmp`;
  let registryTmp = null, durable = false;
  try {
    let next = replayAndCheckVersion(canonicalRoot, eventsPath, expectedVersion, lock.token);
    assertCanonicalFinalizationBatch(events, next, false);
    assertCanonicalAmendmentBatch(events, next, false);
    for (const event of events) next = applyEvent(next, event);
    assertSettlementEvidenceBinding(events, sha256);
    const registry = prepareRegistryUpdate(canonicalRoot, events.at(-1), next, lock.token);
    publishSettlementArtifact(canonicalRoot, sha256, bytes, lock.token);
    mkdirSync(goalDir, { recursive: true });
    writeBatchJsonlAndRename(canonicalRoot, eventsPath, eventsTmp, events, lock.token);
    durable = true;
    publishBatchProjectionWithWriterReceipt(canonicalRoot, projectionTmp, projectionPath, next, lock.token);
    registryTmp = publishBatchRegistry(canonicalRoot, registry, identity, lock.token);
    return next;
  } catch (error) {
    if (durable) throw batchDurableFailure(error);
    throw error;
  } finally {
    if (existsSync(eventsTmp)) rmSync(eventsTmp, { force: true });
    if (existsSync(projectionTmp)) rmSync(projectionTmp, { force: true });
    if (registryTmp && existsSync(registryTmp)) rmSync(registryTmp, { force: true });
    releaseWriterLock(canonicalRoot, lock.token);
  }
}

function validateSettlementArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || Object.getPrototypeOf(artifact) !== Object.prototype) throw new TypeError("invalid settlement evidence artifact");
  const names = Object.getOwnPropertyNames(artifact);
  if (names.length !== 2 || !names.includes("sha256") || !names.includes("content") || Object.getOwnPropertySymbols(artifact).length) throw new TypeError("invalid settlement evidence artifact");
  const shaDescriptor = Object.getOwnPropertyDescriptor(artifact, "sha256");
  const contentDescriptor = Object.getOwnPropertyDescriptor(artifact, "content");
  if (!shaDescriptor || !contentDescriptor || !Object.hasOwn(shaDescriptor, "value") || !Object.hasOwn(contentDescriptor, "value")
    || !shaDescriptor.enumerable || !shaDescriptor.writable || !shaDescriptor.configurable
    || !contentDescriptor.enumerable || !contentDescriptor.writable || !contentDescriptor.configurable) throw new TypeError("invalid settlement evidence artifact");
  const { value: sha256 } = shaDescriptor, { value: content } = contentDescriptor;
  if (!/^[a-f0-9]{64}$/.test(sha256) || typeof content !== "string") throw new TypeError("invalid settlement evidence artifact");
  if (!content || content === "\n" || !content.endsWith("\n") || content.endsWith("\n\n") || content.includes("\r") || content.includes("\0") || /[\ud800-\udfff]/.test(content)) throw new TypeError("invalid settlement evidence content");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_SETTLEMENT_EVIDENCE_BYTES || bytes.toString("utf8") !== content || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new TypeError("invalid settlement evidence content or hash");
  return { sha256, bytes };
}

function assertSettlementEvidenceBinding(events, sha256) {
  const evidence = events.map((event) => event?.data?.settlementEvidence).filter(Boolean);
  const path = `acceptance-evidence/sha256/${sha256}.yaml`;
  if (evidence.length !== 1 || evidence[0].sha256 !== sha256 || evidence[0].path !== path) throw new TypeError("settlement event evidence does not match artifact");
}

function publishSettlementArtifact(stateRoot, sha256, bytes, writerToken) {
  assertWriterLockOwned(stateRoot, writerToken);
  const evidenceDir = secureEvidenceDirectory(stateRoot);
  const target = join(evidenceDir, `${sha256}.yaml`);
  if (existsSync(target)) return assertExistingSettlementArtifact(target, bytes, sha256);
  const tmp = join(evidenceDir, `.${sha256}.${process.pid}-${randomUUID()}.tmp`);
  let preserveUnsafeTemp = false;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    let tmpReceipt;
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      tmpReceipt = fstatSync(fd);
    } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    assertSameSettlementIdentity(tmp, tmpReceipt, "temporary receipt");
    assertWriterLockOwned(stateRoot, writerToken);
    try { linkSync(tmp, target); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return assertExistingSettlementArtifact(target, bytes, sha256);
    }
    assertSameSettlementIdentity(target, tmpReceipt, "target link receipt", false);
    fsyncDirectory(evidenceDir);
    assertSameSettlementIdentity(target, tmpReceipt, "directory fsync receipt", false);
  } catch (error) {
    preserveUnsafeTemp = /receipt|identity|replacement|unsafe/i.test(String(error?.message));
    throw error;
  } finally { if (!preserveUnsafeTemp && existsSync(tmp)) rmSync(tmp, { force: true }); }
}

function secureEvidenceDirectory(stateRoot) {
  let current = stateRoot;
  for (const component of ["acceptance-evidence", "sha256"]) {
    const before = lstatSafe(current);
    if (!before || !before.isDirectory() || before.isSymbolicLink()) throw new TypeError("unsafe settlement evidence parent");
    const next = join(current, component);
    if (!existsSync(next)) mkdirSync(next, { mode: 0o700 });
    const entry = lstatSafe(next);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) throw new TypeError("unsafe settlement evidence directory");
    current = next;
  }
  return current;
}

function lstatSafe(path) { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
function fsyncDirectory(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function sameSettlementIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function assertSameSettlementIdentity(path, receipt, boundary, requireSingleLink = true) {
  const observed = lstatSafe(path);
  if (!observed || !sameSettlementIdentity(observed, receipt)) throw new TypeError(`settlement evidence ${boundary} identity replacement`);
  if (!observed.isFile() || observed.isSymbolicLink() || (requireSingleLink && observed.nlink !== 1) || (observed.mode & 0o7777) !== 0o600) throw new TypeError(`unsafe settlement evidence ${boundary}`);
  return observed;
}
function assertExistingSettlementArtifact(path, bytes, sha256) {
  const receipt = lstatSafe(path);
  if (!receipt || !receipt.isFile() || receipt.isSymbolicLink() || receipt.nlink !== 1 || (receipt.mode & 0o7777) !== 0o600) throw new TypeError("unsafe settlement evidence target");
  const existing = readFileSync(path);
  assertSameSettlementIdentity(path, receipt, "existing read receipt");
  if (existing.length !== bytes.length || !existing.equals(bytes) || createHash("sha256").update(existing).digest("hex") !== sha256) throw new TypeError("settlement evidence collision");
}

export function appendEvent(stateRoot, event, expectedVersion) {
  assertRemediationMaterializationBatch([event]);
  const lock = acquireWriterLock(stateRoot);
  const goalDir = join(stateRoot, "goals", event.goalId);
  const eventsPath = join(goalDir, "events.jsonl");
  const projectionPath = join(goalDir, "projection.json");
  const identity = `${process.pid}-${randomUUID()}`;
  const projectionTmp = `${projectionPath}.${identity}.tmp`;
  let registryTmp = null;

  try {
    const current = replayAndCheckVersion(stateRoot, eventsPath, expectedVersion, lock.token);
    assertCanonicalFinalizationBatch([event], current, true);
    assertCanonicalAmendmentBatch([event], current, true);
    const next = applyEvent(current, event);
    const registry = prepareRegistryUpdate(stateRoot, event, next, lock.token);

    mkdirSync(goalDir, { recursive: true });
    appendJsonlWithWriterReceipt(stateRoot, eventsPath, event, lock.token);
    publishProjectionWithWriterReceipt(stateRoot, projectionTmp, projectionPath, next, lock.token);
    registryTmp = publishRegistry(stateRoot, registry, identity, lock.token);
    return next;
  } finally {
    if (existsSync(projectionTmp)) rmSync(projectionTmp, { force: true });
    if (registryTmp && existsSync(registryTmp)) rmSync(registryTmp, { force: true });
    releaseWriterLock(stateRoot, lock.token);
  }
}

export function loadProjection(stateRoot, goalId) {
  const eventsPath = join(stateRoot, "goals", goalId, "events.jsonl");
  if (!existsSync(eventsPath)) return null;
  return rebuildProjection(eventsPath);
}

// Finalization consumes an independently replayed, checked Store snapshot.  It
// deliberately does not repair a partial publication: callers must fail closed
// rather than turn a validation read into a Store mutation.
export function loadFinalizationProjection(stateRoot, goalId, options = {}) {
  if (typeof stateRoot !== "string" || !stateRoot || typeof goalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(goalId) || goalId === "." || goalId === "..") throw new TypeError("unsafe finalization projection path");
  const root = resolve(stateRoot);
  const lock = acquireWriterLock(root);
  try {
    const goalDir = join(root, "goals", goalId);
    const eventsPath = join(goalDir, "events.jsonl"), projectionPath = join(goalDir, "projection.json"), registryPath = join(root, "registry.json");
    const events = readFinalizationFile(eventsPath), snapshot = readFinalizationFile(projectionPath), registryBytes = readFinalizationFile(registryPath);
    const replay = replayFinalizationEvents(events, goalId);
    let persisted, registry;
    try { persisted = JSON.parse(snapshot.toString("utf8")); registry = JSON.parse(registryBytes.toString("utf8")); }
    catch { throw new TypeError("invalid finalization projection store JSON"); }
    if (JSON.stringify(persisted) !== JSON.stringify(serializeProjection(replay))) throw new TypeError("finalization projection snapshot mismatch");
    validateRegistry(registry);
    const entry = registry.goals[goalId];
    if (!entry || entry.lifecycle !== replay.lifecycle || entry.objective !== replay.objective || entry.updatedAt !== replay.updatedAt) throw new TypeError("finalization registry projection mismatch");
    // Recheck file receipts after all parsing, so a replacement racing the read
    // cannot be silently accepted.
    for (const path of [eventsPath, projectionPath, registryPath]) assertFinalizationFile(path);
    let selected = replay;
    if (Object.keys(options).length) {
      if (!exactObject(options, ["version"]) || !Number.isSafeInteger(options.version) || options.version < 0 || options.version > replay.version) throw new TypeError("invalid finalization projection version");
      selected = createProjection();
      for (const event of events.toString("utf8").trim().split("\n").slice(0, options.version)) selected = applyEvent(selected, JSON.parse(event), { replay: true });
    }
    const projection = freezeProjection(selected);
    return Object.freeze({ goalId, version: projection.version, projection, projectionStateHash: projectionStateHash(projection) });
  } finally { releaseWriterLock(root, lock.token); }
}

function assertFinalizationFile(path) {
  const stat = lstatSafe(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) throw new TypeError("unsafe finalization projection store file");
  return stat;
}
function readFinalizationFile(path) {
  const before = assertFinalizationFile(path), content = readFileSync(path);
  const after = assertFinalizationFile(path);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new TypeError("finalization projection store file replaced");
  return content;
}
function replayFinalizationEvents(content, goalId) {
  let projection = createProjection();
  const text = content.toString("utf8");
  if (!text.trim()) throw new TypeError("invalid finalization projection events");
  for (const line of text.trim().split("\n")) {
    let event; try { event = JSON.parse(line); } catch { throw new TypeError("invalid finalization projection events"); }
    if (event?.goalId !== goalId) throw new TypeError("finalization projection goal mismatch");
    projection = applyEvent(projection, event, { replay: true });
  }
  if (projection.goalId !== goalId) throw new TypeError("finalization projection goal mismatch");
  return projection;
}
function freezeProjection(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) for (const [key, child] of value) { freezeProjection(key, seen); freezeProjection(child, seen); }
  else for (const child of Object.values(value)) freezeProjection(child, seen);
  return Object.freeze(value);
}

export function listGoals(stateRoot) {
  const registryPath = join(stateRoot, "registry.json");
  if (!existsSync(registryPath)) return [];
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  return registry.active_goal_ids || [];
}

export function listGoalIds(stateRoot) {
  const registryPath = join(stateRoot, "registry.json");
  if (!existsSync(registryPath)) return [];
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  validateRegistry(registry);
  return Object.keys(registry.goals).sort();
}

export function acquireWriterLock(stateRoot) {
  mkdirSync(stateRoot, { recursive: true });
  const lockPath = join(stateRoot, ".writer.lock");
  const token = randomUUID();
  const birthIdentity = currentProcessBirthIdentity();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const observed = readLockOwner(lockPath);
    if (observed && Date.now() - Date.parse(observed.createdAt) < IDENTITY_PROBE_FRESH_MS) {
      let alive = true;
      try { process.kill(observed.pid, 0); }
      catch (error) { alive = error.code !== "ESRCH"; }
      if (alive) {
        if (Date.now() >= deadline) throw lockTimeout();
        sleep(LOCK_WAIT_MS);
        continue;
      }
    }
    const guard = acquireRecoveryGuard(stateRoot, deadline);
    const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
    try {
      try {
        writeOwnerCandidate(candidate, token, birthIdentity);
        // link(2) is no-clobber: unlike rename(2), it cannot replace even an
        // empty legacy lock directory.
        linkSync(candidate, lockPath);
        return { token };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readLockOwner(lockPath);
        if (ownerState(owner) === "dead") quarantineStaleLock(lockPath);
      }
    } finally {
      if (existsSync(candidate)) rmSync(candidate, { force: true });
      releaseRecoveryGuard(stateRoot, guard.token);
    }
    if (Date.now() >= deadline) throw lockTimeout();
    sleep(LOCK_WAIT_MS);
  }
}

function writeOwnerCandidate(path, token, birthIdentity) {
  writeFileSync(path, JSON.stringify({ protocol: OWNER_PROTOCOL, identityKind: OWNER_IDENTITY_KIND, pid: process.pid, token, createdAt: new Date().toISOString(), birthIdentity }) + "\n", { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

// New locks are files.  The directory fallback is read-only migration support.
function readLockOwner(lockPath) {
  return readOwner(lockPath) ?? readOwner(join(lockPath, "owner.json"));
}

function readOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : null;
  } catch { return null; }
}

function validOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string" && owner.token.length > 0 && typeof owner.createdAt === "string" && !Number.isNaN(Date.parse(owner.createdAt)) && typeof owner.birthIdentity === "string" && owner.birthIdentity.length > 0 && owner.protocol === OWNER_PROTOCOL && owner.identityKind === OWNER_IDENTITY_KIND;
}

function currentProcessBirthIdentity() {
  if (selfBirthIdentity) return selfBirthIdentity;
  try {
    selfBirthIdentity = processBirthIdentity(process.pid);
    return selfBirthIdentity;
  } catch { throw identityUnavailable(); }
}

function processBirthIdentity(pid) {
  // lstart is localized and timezone-formatted unless ps is invoked canonically.
  const identity = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim();
  if (!identity) throw new Error("process birth identity unavailable");
  return identity;
}

function ownerState(owner) {
  if (!owner) return "unknown";
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === "ESRCH" ? "dead" : "unknown"; }
  // A live owner predating this protocol has no safely comparable identity.
  if (!validOwner(owner)) return "unknown";
  const key = `${owner.pid}:${owner.birthIdentity}`;
  // A newly published owner cannot be stale merely because no caller has probed
  // it yet.  This avoids a ps fan-out for every waiter while bounding recovery.
  const publishedAt = Date.parse(owner.createdAt);
  const fresh = ownerIdentityFreshness.get(key);
  if (Date.now() - publishedAt < IDENTITY_PROBE_FRESH_MS || (fresh && Date.now() - fresh < IDENTITY_PROBE_FRESH_MS)) return "live";
  try {
    const state = processBirthIdentity(owner.pid) === owner.birthIdentity ? "live" : "dead";
    if (state === "live") ownerIdentityFreshness.set(key, Date.now());
    return state;
  } catch { return "unknown"; }
}

function quarantineStaleLock(lockPath) {
  const quarantine = `${lockPath}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
    rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
  }
}

export function acquireRecoveryGuard(stateRoot, deadline) {
  mkdirSync(stateRoot, { recursive: true });
  const guardPath = join(stateRoot, ".writer.recovery.guard");
  const token = randomUUID();
  const birthIdentity = currentProcessBirthIdentity();
  const candidate = `${guardPath}.candidate-${process.pid}-${randomUUID()}`;
  try {
    writeOwnerCandidate(candidate, token, birthIdentity);
    while (true) {
      try {
        linkSync(candidate, guardPath);
        return { token };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readRecoveryGuardOwner(guardPath);
        if (ownerState(owner) === "dead") quarantineStaleGuard(guardPath);
        if (Date.now() >= deadline) throw lockTimeout();
        sleep(LOCK_WAIT_MS);
      }
    }
  } finally {
    if (existsSync(candidate)) rmSync(candidate, { force: true });
  }
}

function readRecoveryGuardOwner(guardPath) {
  return readOwner(guardPath);
}

function quarantineStaleGuard(guardPath) {
  const quarantine = `${guardPath}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    renameSync(guardPath, quarantine);
    rmSync(quarantine, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
  }
}

export function releaseRecoveryGuard(stateRoot, token) {
  const guardPath = join(stateRoot, ".writer.recovery.guard");
  try {
    const owner = readRecoveryGuardOwner(guardPath);
    if (owner?.token === token) unlinkSync(guardPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function releaseWriterLock(stateRoot, token) {
  const guard = acquireRecoveryGuard(stateRoot, Date.now() + LOCK_TIMEOUT_MS);
  try {
    const lockPath = join(stateRoot, ".writer.lock");
    const owner = readLockOwner(lockPath);
    if (owner?.token === token) rmSync(lockPath, { recursive: true, force: true });
  } finally {
    releaseRecoveryGuard(stateRoot, guard.token);
  }
}

// Shared async boundary for state-root transactions.  The underlying lock keeps
// its owner receipt and CAS-protected release protocol; callers only supply the
// critical section and must not retain the receipt themselves.
export async function withGoalStateWriterLock(stateRoot, operation) {
  if (typeof operation !== "function") throw new TypeError("goal state writer lock operation must be a function");
  const lock = acquireWriterLock(stateRoot);
  try { return await operation(); }
  finally { releaseWriterLock(stateRoot, lock.token); }
}

function sleep(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function lockTimeout() { return Object.assign(new Error("goal engine store writer lock timed out"), { code: "GOAL_ENGINE_STORE_LOCK_TIMEOUT" }); }
function identityUnavailable() { return Object.assign(new Error("goal engine store process birth identity unavailable"), { code: "GOAL_ENGINE_STORE_LOCK_IDENTITY_UNAVAILABLE" }); }
function writerLockLost() { return Object.assign(new Error("goal engine store writer lock was lost"), { code: "GOAL_ENGINE_STORE_LOCK_LOST" }); }
function projectionConflict(expected, current) { return Object.assign(new Error(`projection version conflict: expected ${expected}, current ${current}`), { code: "PROJECTION_CONFLICT" }); }
function batchDurableFailure(cause) { return Object.assign(new Error(`goal engine event batch may already be durable: ${cause.message}`, { cause }), { code: "GOAL_ENGINE_STORE_BATCH_DURABLE" }); }

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertyNames(value).length === keys.length && Object.getOwnPropertySymbols(value).length === 0
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertRemediationMaterializationBatch(events) {
  const index = events.findIndex((entry) => entry?.type === "goal.amended" && entry?.data?.hostInternalRemediation === true);
  const repairConsume = events.some((entry) => entry?.type === "repair.capability_consumed" && entry?.data?.action === "authorize_task");
  if (index < 0) { if (repairConsume) throw new Error("authorize_task capability consumption requires one canonical remediation batch"); return; }
  const actionPrefix = events[0]?.type === "goal.action_consumed";
  if (index !== (actionPrefix ? 1 : 0)) throw new Error("Host remediation materialization must be one canonical batch");

  const amendment = events[index], { data } = amendment;
  if (!exactObject(data, ["addTasks", "removeTasks", "updateTasks", "reason", "hostInternalRemediation"])
    || !exactObject(data.addTasks, Object.keys(data.addTasks || {})) || Object.keys(data.addTasks).length !== 1
    || !Array.isArray(data.removeTasks) || data.removeTasks.length !== 0
    || !exactObject(data.updateTasks, []) || data.reason !== "Materialize canonical remediation task" || data.hostInternalRemediation !== true) {
    throw new Error("Host remediation batch has invalid amendment");
  }
  const [taskId] = Object.keys(data.addTasks), taskDef = data.addTasks[taskId], metadata = taskDef?.metadata;
  const taskDefFields = ["description", "writePaths", "acceptance", "workflow", "metadata"];
  if (!exactObject(taskDef, Object.hasOwn(taskDef || {}, "deps") ? [...taskDefFields, "deps"] : taskDefFields)) throw new Error("Host remediation batch has invalid task definition");
  try {
    if (!exactObject(metadata, ["kind", "goalId", "executionRevision", "episodeId", "conditionId", "findingIds", "subjectHash", "taskDefHash"])) throw new Error("invalid metadata shape");
    validateTaskDefinitions([taskId], data.addTasks, { planned: true, hostInternalRemediation: true });
    validateRemediationMetadata(metadata);
  } catch { throw new Error("Host remediation batch has invalid metadata"); }
  if (metadata.goalId !== amendment.goalId || metadata.taskDefHash !== taskContractHash(taskDef)
    || metadata.subjectHash !== remediationSubjectHash({ goalId: amendment.goalId, executionRevision: metadata.executionRevision, episodeId: metadata.episodeId, conditionId: metadata.conditionId, findingIds: metadata.findingIds, task: taskDef })) {
    throw new Error("Host remediation batch metadata binding mismatch");
  }

  const linkAt = (offset) => events[index + offset];
  const linked = (entry, challengeId) => entry?.type === "repair.task_linked"
    && exactObject(entry.data, ["episodeId", "taskId", "challengeId"])
    && entry.data.episodeId === metadata.episodeId && entry.data.taskId === taskId && entry.data.challengeId === challengeId;
  if (events[index + 1]?.type === "repair.task_linked") {
    if (events.length !== index + 2 || !linked(linkAt(1), null)) throw new Error("invalid autonomous remediation batch");
    return;
  }

  if (actionPrefix) throw new Error("invalid user-approved remediation batch");
  const consume = events[index + 1];
  if (events.length !== index + 3 || consume?.type !== "repair.capability_consumed"
    || !exactObject(consume.data, ["nonceDigest", "consumedAt", "challengeId", "challengeHash", "episodeId", "action", "subjectHash", "sessionId", "userEntryId", "decisionId", "executionRevision", "executionContractHash", "baseHead", "taskId", "taskDefHash", "userEntryHash", "branchBindingHash"])
    || consume.data.action !== "authorize_task" || !consume.data.challengeId || !/^[a-f0-9]{64}$/.test(consume.data.challengeHash) || consume.data.episodeId !== metadata.episodeId
    || consume.data.taskId !== taskId || consume.data.taskDefHash !== metadata.taskDefHash || consume.data.executionRevision !== metadata.executionRevision || consume.data.subjectHash !== metadata.subjectHash || !linked(linkAt(2), consume.data.challengeId)) {
    throw new Error("invalid user-approved remediation batch");
  }
}

function assertCanonicalFinalizationBatch(events, projection, standalone) {
  const finalEvents = events.filter((event) => ["goal.final_review_started", "goal.final_review_recorded"].includes(event?.type)
    || (event?.type === "goal.completed" && event.schemaVersion === "goal-runtime.v1"));
  if (!finalEvents.length) return;
  if (projection.eventSchemaVersion !== "goal-runtime.v1" || finalEvents.some((event) => event.schemaVersion !== "goal-runtime.v1")) throw new Error("final review requires runtime events");
  const hasRecord = finalEvents.some((event) => event.type === "goal.final_review_recorded");
  const hasCompletion = finalEvents.some((event) => event.type === "goal.completed");
  if (!hasRecord && !hasCompletion) return;
  if (standalone || events.length === 1) {
    const record = events[0];
    if (record?.type !== "goal.final_review_recorded" || !((['important', 'critical'].includes(record.data?.severity) && record.data?.status === "changes_required") || (['none', 'minor'].includes(record.data?.severity) && record.data?.status === "stale"))) throw new Error("final review pass records and completion must be atomic");
    return;
  }
  if (events.length !== 2 || events[0]?.type !== "goal.final_review_recorded" || events[1]?.type !== "goal.completed") throw new Error("final review pass records and completion must be one atomic batch");
  const [record, completion] = events;
  const started = projection.finalReview;
  if (!started || started.status !== "started" || !["none", "minor"].includes(record.data?.severity) || record.data?.status !== "recorded"
    || record.data.reviewId !== started.reviewId || completion.data?.verdict !== "COMPLETE"
    || completion.data.reviewId !== started.reviewId || completion.data.manifestHash !== started.manifestHash || completion.data.stateHash !== started.stateHash
    || completion.data.worldHash !== started.worldHash || completion.data.head !== started.head || completion.data.resultHash !== record.data.resultHash) throw new Error("final review complete identity mismatch");
}

function assertCanonicalAmendmentBatch(events, projection, standalone) {
  const hasAmendment = events.some((event) => event?.type === "execution.amendment_capability_consumed"
    || event?.type === "execution.amendment_applied"
    || (["task.applicability_changed", "condition.evidence_invalidated"].includes(event?.type)
      && event?.data && typeof event.data === "object"
      && (Object.hasOwn(event.data, "revision") || Object.hasOwn(event.data, "priorEvidenceIds"))));
  if (!hasAmendment) return;
  if (standalone || events[0]?.type !== "execution.amendment_capability_consumed") throw new Error("canonical amendment batch is atomic");
  const pending = projection.pendingHumanDecision;
  if (!pending || pending.phase !== "approved") throw new Error("canonical amendment batch requires approved proposal");
  const targetTaskIds = (pending.targetExecutionContract?.execution?.tasks || []).map((task) => task.id);
  const sourceTaskIds = pending.sourceTaskIds;
  if (!Array.isArray(sourceTaskIds) || JSON.stringify(sourceTaskIds) !== JSON.stringify([...sourceTaskIds].sort()) || sourceTaskIds.some((id) => !projection.tasks.has(id))) throw new Error("invalid amendment source tasks");
  const taskIds = [...new Set([...sourceTaskIds, ...targetTaskIds])].sort();
  const conditionIds = [...projection.conditions.keys()].sort();
  const expectedLength = 1 + taskIds.length + conditionIds.length + 2;
  if (events.length !== expectedLength || events.at(-1)?.type !== "goal.runtime_resumed") throw new Error("invalid canonical amendment batch");
  const consume = events[0]?.data;
  if (consume?.proposalId !== pending.proposalId || !/^[a-f0-9]{64}$/.test(consume?.nonceDigest || "") || projection.consumedAmendmentNonceDigests?.has(consume.nonceDigest)) throw new Error("invalid amendment nonce replay");
  for (let i = 0; i < taskIds.length; i++) { const data = events[i + 1]; if (data?.type !== "task.applicability_changed" || data.data?.taskId !== taskIds[i] || data.data?.revision !== pending.newRevision) throw new Error("invalid amendment applicability facts"); }
  for (let i = 0; i < conditionIds.length; i++) { const data = events[1 + taskIds.length + i]; const condition = projection.conditions.get(conditionIds[i]); if (data?.type !== "condition.evidence_invalidated" || data.data?.conditionId !== conditionIds[i] || data.data?.revision !== pending.newRevision || JSON.stringify(data.data?.priorEvidenceIds) !== JSON.stringify(condition.supportingEvidenceIds)) throw new Error("invalid amendment invalidation facts"); }
  const applied = events.at(-2)?.data;
  if (events.at(-2)?.type !== "execution.amendment_applied" || applied?.proposalId !== pending.proposalId || applied?.proposalHash !== pending.proposalHash || applied?.oldRevision !== pending.oldRevision || applied?.newRevision !== pending.newRevision || applied?.targetContractHash !== pending.targetContractHash) throw new Error("invalid amendment apply identity");
  const reconciliation = applied.reconciliation;
  const targetTaskSet = new Set(targetTaskIds);
  const actionFor = (taskId, state) => !sourceTaskIds.includes(taskId) && targetTaskSet.has(taskId) ? state === "applicable" ? "add" : null : sourceTaskIds.includes(taskId) && !targetTaskSet.has(taskId) ? state === "superseded" ? "supersede" : null : state === "applicable" ? "keep" : state === "reverify_required" ? "reverify" : null;
  if (!Array.isArray(reconciliation) || reconciliation.length !== taskIds.length || reconciliation.some((row, i) => row?.taskId !== taskIds[i] || row.action !== actionFor(taskIds[i], events[i + 1].data.state) || (targetTaskSet.has(taskIds[i]) && events[i + 1].data.state === "superseded"))) throw new Error("invalid amendment reconciliation");
  const resumed = events.at(-1)?.data;
  if (resumed?.suspensionId !== projection.suspension?.suspensionId) throw new Error("invalid amendment resume");
}

function validateEventBatch(events) {
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("event batch must be a non-empty array");
  const goalId = events[0]?.goalId;
  if (typeof goalId !== "string" || !goalId.trim() || events.some((event) => event?.goalId !== goalId)) {
    throw new TypeError("event batch must contain one non-empty goalId");
  }
}

function replayAndCheckVersion(stateRoot, eventsPath, expectedVersion, writerToken) {
  assertWriterLockOwned(stateRoot, writerToken);
  const current = rebuildProjection(eventsPath);
  if (current.version !== expectedVersion) throw projectionConflict(expectedVersion, current.version);
  return current;
}

function appendJsonlWithWriterReceipt(stateRoot, eventsPath, event, writerToken) {
  assertWriterLockOwned(stateRoot, writerToken);
  appendFileSync(eventsPath, JSON.stringify(event) + "\n", { mode: 0o600 });
}

function writeBatchJsonlAndRename(stateRoot, eventsPath, eventsTmp, events, writerToken) {
  assertWriterLockOwned(stateRoot, writerToken);
  const previous = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  writeFileSync(eventsTmp, previous + events.map((event) => JSON.stringify(event) + "\n").join(""), { flag: "wx", mode: 0o600 });
  assertWriterLockOwned(stateRoot, writerToken);
  renameSync(eventsTmp, eventsPath);
}

function publishProjectionWithWriterReceipt(stateRoot, projectionTmp, projectionPath, projection, writerToken) {
  assertWriterLockOwned(stateRoot, writerToken);
  writeFileSync(projectionTmp, JSON.stringify(serializeProjection(projection), null, 2) + "\n", { mode: 0o600 });
  renameSync(projectionTmp, projectionPath);
}

function publishBatchProjectionWithWriterReceipt(stateRoot, projectionTmp, projectionPath, projection, writerToken) {
  return publishProjectionWithWriterReceipt(stateRoot, projectionTmp, projectionPath, projection, writerToken);
}

function rebuildProjection(eventsPath) {
  let projection = createProjection();
  if (!existsSync(eventsPath)) return projection;
  const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) projection = applyEvent(projection, JSON.parse(line), { replay: true });
  return projection;
}

export function projectionStateHash(projection) {
  return createHash("sha256").update(JSON.stringify(serializeProjection(projection))).digest("hex");
}

function serializeProjection(p) {
  return {
    goalId: p.goalId, version: p.version, lifecycle: p.lifecycle, objective: p.objective,
    scope: p.scope, nonGoals: p.nonGoals, dod: p.dod, tasks: Object.fromEntries(p.tasks),
    checkpointCount: p.checkpointCount, completionVerdict: p.completionVerdict,
    blockedReason: p.blockedReason, nextAction: p.nextAction, createdAt: p.createdAt,
    updatedAt: p.updatedAt, eventSchemaVersion: p.eventSchemaVersion,
    epoch: p.epoch, completionHistory: p.completionHistory, coordinationState: p.coordinationState,
    sessionBindings: p.sessionBindings, continuity: p.continuity, actionOffer: p.actionOffer,
    pendingHumanDecision: p.pendingHumanDecision, contractHistory: p.contractHistory,
    runtimeGeneration: p.runtimeGeneration, initialShape: p.initialShape,
    executionRevision: p.executionRevision, executionContractHash: p.executionContractHash,
    readiness: p.readiness, runtimeState: p.runtimeState, writePolicy: p.writePolicy,
    ...(p.runtimeGeneration ? { runtimeActiveElapsedMs: p.runtimeActiveElapsedMs, runtimeActiveSince: p.runtimeActiveSince } : {}),
    taskApplicability: Object.fromEntries(p.taskApplicability || []),
    conditions: Object.fromEntries(p.conditions || []),
    observationRuns: Object.fromEntries(p.observationRuns || []),
    findings: Object.fromEntries(p.findings || []),
    repairEpisodes: Object.fromEntries(p.repairEpisodes || []),
    repairChallenges: Object.fromEntries(p.repairChallenges || []),
    suspension: p.suspension, convergenceBudget: p.convergenceBudget, evidenceHistory: p.evidenceHistory || [],
    ...(p.runtimeGeneration ? { mutationSequence: p.mutationSequence, taskMutationSequences: Object.fromEntries(p.taskMutationSequences || []) } : {}),
    finalReview: p.finalReview || null,
    consumedAmendmentNonceDigests: [...(p.consumedAmendmentNonceDigests || [])].sort(),
  };
}

export function updateRegistry(stateRoot, event, projection, identity, writerToken) {
  return publishRegistry(stateRoot, prepareRegistryUpdate(stateRoot, event, projection, writerToken), identity, writerToken);
}

function prepareRegistryUpdate(stateRoot, event, projection, writerToken) {
  assertWriterLockOwned(stateRoot, writerToken);
  const registryPath = join(stateRoot, "registry.json");
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : { schema_version: REGISTRY_SCHEMA_VERSION, active_goal_ids: [], goals: {} };
  validateRegistry(registry);
  const goalId = event.goalId;
  if (!registry.goals[goalId]) registry.goals[goalId] = {};
  registry.goals[goalId].lifecycle = projection.lifecycle;
  registry.goals[goalId].objective = projection.objective;
  registry.goals[goalId].updatedAt = projection.updatedAt;
  const idx = registry.active_goal_ids.indexOf(goalId);
  if (projection.lifecycle === "active" && idx === -1) registry.active_goal_ids.push(goalId);
  else if (projection.lifecycle !== "active" && idx !== -1) registry.active_goal_ids.splice(idx, 1);
  return registry;
}

function validateRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || registry.schema_version !== REGISTRY_SCHEMA_VERSION || !Array.isArray(registry.active_goal_ids) || !registry.goals || typeof registry.goals !== "object" || Array.isArray(registry.goals)) throw new TypeError("invalid goal engine registry");
  const activeIds = new Set();
  for (const goalId of registry.active_goal_ids) {
    if (typeof goalId !== "string" || !goalId || activeIds.has(goalId)) throw new TypeError("invalid goal engine registry");
    activeIds.add(goalId);
  }
  for (const [goalId, entry] of Object.entries(registry.goals)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !["active", "blocked", "completed", "cancelled"].includes(entry.lifecycle) || typeof entry.objective !== "string" || typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt)) || (entry.lifecycle === "active") !== activeIds.has(goalId)) throw new TypeError("invalid goal engine registry");
  }
  for (const goalId of activeIds) {
    if (!Object.hasOwn(registry.goals, goalId) || registry.goals[goalId].lifecycle !== "active") throw new TypeError("invalid goal engine registry");
  }
}

export function assertWriterLockOwned(stateRoot, token) {
  const owner = readLockOwner(join(stateRoot, ".writer.lock"));
  if (!token || !validOwner(owner) || owner.token !== token) throw writerLockLost();
}

function publishBatchRegistry(stateRoot, registry, identity, writerToken) {
  return publishRegistry(stateRoot, registry, identity, writerToken);
}

function publishRegistry(stateRoot, registry, identity, writerToken) {
  assertWriterLockOwned(stateRoot, writerToken);
  const registryPath = join(stateRoot, "registry.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${identity}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, registryPath);
  return tmpPath;
}
