import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { applyEvent, createProjection } from "./events.mjs";

const REGISTRY_SCHEMA_VERSION = "goal-engine.registry.v1";
const LOCK_TIMEOUT_MS = 500;
const LOCK_WAIT_MS = 10;

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

    mkdirSync(goalDir, { recursive: true });
    appendFileSync(eventsPath, JSON.stringify(event) + "\n", { mode: 0o600 });
    writeFileSync(projectionTmp, JSON.stringify(serializeProjection(next), null, 2) + "\n", { mode: 0o600 });
    renameSync(projectionTmp, projectionPath);
    registryTmp = updateRegistry(stateRoot, event, next, identity);
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

function acquireWriterLock(stateRoot) {
  mkdirSync(stateRoot, { recursive: true });
  const lockPath = join(stateRoot, ".writer.lock");
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
      return { token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readLockOwner(lockPath);
      if (owner && !pidIsAlive(owner.pid)) quarantineStaleLock(lockPath);
      else if (Date.now() >= deadline) throw lockTimeout();
      else sleep(LOCK_WAIT_MS);
    }
  }
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    return Number.isInteger(owner.pid) && typeof owner.token === "string" ? owner : null;
  } catch { return null; }
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
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

function releaseWriterLock(stateRoot, token) {
  const lockPath = join(stateRoot, ".writer.lock");
  const owner = readLockOwner(lockPath);
  if (owner?.token === token) rmSync(lockPath, { recursive: true, force: true });
}

function sleep(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function lockTimeout() { return Object.assign(new Error("goal engine store writer lock timed out"), { code: "GOAL_ENGINE_STORE_LOCK_TIMEOUT" }); }
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

function updateRegistry(stateRoot, event, projection, identity) {
  const registryPath = join(stateRoot, "registry.json");
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : { schema_version: REGISTRY_SCHEMA_VERSION, active_goal_ids: [], goals: {} };
  const goalId = event.goalId;
  if (!registry.goals[goalId]) registry.goals[goalId] = {};
  registry.goals[goalId].lifecycle = projection.lifecycle;
  registry.goals[goalId].objective = projection.objective;
  registry.goals[goalId].updatedAt = projection.updatedAt;
  const idx = registry.active_goal_ids.indexOf(goalId);
  if (projection.lifecycle === "active" && idx === -1) registry.active_goal_ids.push(goalId);
  else if (projection.lifecycle !== "active" && idx !== -1) registry.active_goal_ids.splice(idx, 1);
  mkdirSync(dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${identity}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, registryPath);
  return tmpPath;
}
