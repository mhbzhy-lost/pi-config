import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, linkSync, existsSync, chmodSync, rmSync, unlinkSync, lstatSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { applyEvent, createProjection } from "./events.mjs";

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
  const bytes = validateSettlementArtifact(artifact);
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
    for (const event of events) next = applyEvent(next, event);
    assertSettlementEvidenceBinding(events, artifact.sha256);
    const registry = prepareRegistryUpdate(canonicalRoot, events.at(-1), next, lock.token);
    publishSettlementArtifact(canonicalRoot, artifact.sha256, bytes, lock.token);
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
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || Object.keys(artifact).length !== 2 || !Object.hasOwn(artifact, "sha256") || !Object.hasOwn(artifact, "content") || !/^[a-f0-9]{64}$/.test(artifact.sha256) || typeof artifact.content !== "string") throw new TypeError("invalid settlement evidence artifact");
  const content = artifact.content;
  if (!content || content === "\n" || !content.endsWith("\n") || content.endsWith("\n\n") || content.includes("\r") || content.includes("\0") || /[\ud800-\udfff]/.test(content)) throw new TypeError("invalid settlement evidence content");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_SETTLEMENT_EVIDENCE_BYTES || bytes.toString("utf8") !== content || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new TypeError("invalid settlement evidence content or hash");
  return bytes;
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
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    assertWriterLockOwned(stateRoot, writerToken);
    try { linkSync(tmp, target); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return assertExistingSettlementArtifact(target, bytes, sha256);
    }
    fsyncDirectory(evidenceDir);
  } finally { if (existsSync(tmp)) rmSync(tmp, { force: true }); }
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
function assertExistingSettlementArtifact(path, bytes, sha256) {
  const stat = lstatSafe(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new TypeError("unsafe settlement evidence target");
  const existing = readFileSync(path);
  if (existing.length !== bytes.length || !existing.equals(bytes) || createHash("sha256").update(existing).digest("hex") !== sha256) throw new TypeError("settlement evidence collision");
}

export function appendEvent(stateRoot, event, expectedVersion) {
  const lock = acquireWriterLock(stateRoot);
  const goalDir = join(stateRoot, "goals", event.goalId);
  const eventsPath = join(goalDir, "events.jsonl");
  const projectionPath = join(goalDir, "projection.json");
  const identity = `${process.pid}-${randomUUID()}`;
  const projectionTmp = `${projectionPath}.${identity}.tmp`;
  let registryTmp = null;

  try {
    const current = replayAndCheckVersion(stateRoot, eventsPath, expectedVersion, lock.token);
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

function sleep(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function lockTimeout() { return Object.assign(new Error("goal engine store writer lock timed out"), { code: "GOAL_ENGINE_STORE_LOCK_TIMEOUT" }); }
function identityUnavailable() { return Object.assign(new Error("goal engine store process birth identity unavailable"), { code: "GOAL_ENGINE_STORE_LOCK_IDENTITY_UNAVAILABLE" }); }
function writerLockLost() { return Object.assign(new Error("goal engine store writer lock was lost"), { code: "GOAL_ENGINE_STORE_LOCK_LOST" }); }
function projectionConflict(expected, current) { return Object.assign(new Error(`projection version conflict: expected ${expected}, current ${current}`), { code: "PROJECTION_CONFLICT" }); }
function batchDurableFailure(cause) { return Object.assign(new Error(`goal engine event batch may already be durable: ${cause.message}`, { cause }), { code: "GOAL_ENGINE_STORE_BATCH_DURABLE" }); }

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
