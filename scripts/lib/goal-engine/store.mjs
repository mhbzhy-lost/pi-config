import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, linkSync, existsSync, chmodSync, rmSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { applyEvent, createProjection } from "./events.mjs";

const REGISTRY_SCHEMA_VERSION = "goal-engine.registry.v1";
const LOCK_TIMEOUT_MS = 1500;
const LOCK_WAIT_MS = 10;
const IDENTITY_PROBE_FRESH_MS = 1400;
let selfBirthIdentity;
const ownerIdentityFreshness = new Map();

export function appendEvent(stateRoot, event, expectedVersion) {
  const lock = acquireWriterLock(stateRoot);
  const goalDir = join(stateRoot, "goals", event.goalId);
  const eventsPath = join(goalDir, "events.jsonl");
  const projectionPath = join(goalDir, "projection.json");
  const identity = `${process.pid}-${randomUUID()}`;
  const projectionTmp = `${projectionPath}.${identity}.tmp`;
  let registryTmp = null;

  try {
    const current = rebuildProjection(eventsPath);
    if (current.version !== expectedVersion) throw projectionConflict(expectedVersion, current.version);
    const next = applyEvent(current, event);
    const registry = prepareRegistryUpdate(stateRoot, event, next);

    mkdirSync(goalDir, { recursive: true });
    appendFileSync(eventsPath, JSON.stringify(event) + "\n", { mode: 0o600 });
    writeFileSync(projectionTmp, JSON.stringify(serializeProjection(next), null, 2) + "\n", { mode: 0o600 });
    renameSync(projectionTmp, projectionPath);
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
        mkdirSync(candidate, { mode: 0o700 });
        chmodSync(candidate, 0o700);
        const ownerPath = join(candidate, "owner.json");
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), birthIdentity }) + "\n", { mode: 0o600 });
        chmodSync(ownerPath, 0o600);
        renameSync(candidate, lockPath);
        return { token };
      } catch (error) {
        if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        const owner = readLockOwner(lockPath);
        if (ownerState(owner) === "dead") quarantineStaleLock(lockPath);
      }
    } finally {
      releaseRecoveryGuard(stateRoot, guard.token);
    }
    if (Date.now() >= deadline) throw lockTimeout();
    sleep(LOCK_WAIT_MS);
  }
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    return validOwner(owner) ? owner : null;
  } catch { return null; }
}

function validOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string" && owner.token.length > 0 && typeof owner.createdAt === "string" && !Number.isNaN(Date.parse(owner.createdAt)) && typeof owner.birthIdentity === "string" && owner.birthIdentity.length > 0;
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
    writeFileSync(candidate, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), birthIdentity }) + "\n", { flag: "wx", mode: 0o600 });
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
  try {
    const owner = JSON.parse(readFileSync(guardPath, "utf8"));
    return validOwner(owner) ? owner : null;
  } catch { return null; }
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

function rebuildProjection(eventsPath) {
  let projection = createProjection();
  if (!existsSync(eventsPath)) return projection;
  const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) projection = applyEvent(projection, JSON.parse(line));
  return projection;
}

function serializeProjection(p) {
  return { goalId: p.goalId, version: p.version, lifecycle: p.lifecycle, objective: p.objective, scope: p.scope, nonGoals: p.nonGoals, dod: p.dod, tasks: Object.fromEntries(p.tasks), checkpointCount: p.checkpointCount, completionVerdict: p.completionVerdict, blockedReason: p.blockedReason, nextAction: p.nextAction, createdAt: p.createdAt, updatedAt: p.updatedAt, eventSchemaVersion: p.eventSchemaVersion };
}

export function updateRegistry(stateRoot, event, projection, identity, writerToken) {
  return publishRegistry(stateRoot, prepareRegistryUpdate(stateRoot, event, projection), identity, writerToken);
}

function prepareRegistryUpdate(stateRoot, event, projection) {
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
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || registry.schema_version !== REGISTRY_SCHEMA_VERSION || !Array.isArray(registry.active_goal_ids) || !registry.active_goal_ids.every((goalId) => typeof goalId === "string") || !registry.goals || typeof registry.goals !== "object" || Array.isArray(registry.goals)) {
    throw new TypeError("invalid goal engine registry");
  }
}

function publishRegistry(stateRoot, registry, identity, writerToken) {
  const owner = readLockOwner(join(stateRoot, ".writer.lock"));
  if (!writerToken || owner?.token !== writerToken) throw writerLockLost();
  const registryPath = join(stateRoot, "registry.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${identity}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, registryPath);
  return tmpPath;
}
