import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { applyEvent, createProjection } from "./events.mjs";

const REGISTRY_SCHEMA_VERSION = "goal-engine.registry.v1";

export function appendEvent(stateRoot, event, expectedVersion) {
  const goalDir = join(stateRoot, "goals", event.goalId);
  const eventsPath = join(goalDir, "events.jsonl");
  const projectionPath = join(goalDir, "projection.json");

  const current = rebuildProjection(eventsPath);
  if (current.version !== expectedVersion) {
    throw new Error(`projection version conflict: expected ${expectedVersion}, current ${current.version}`);
  }

  const next = applyEvent(current, event);

  mkdirSync(goalDir, { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + "\n", { mode: 0o600 });

  const serialized = serializeProjection(next);
  const tmpPath = projectionPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(serialized, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, projectionPath);

  updateRegistry(stateRoot, event, next);

  return next;
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

function rebuildProjection(eventsPath) {
  let projection = createProjection();
  if (!existsSync(eventsPath)) return projection;
  const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    projection = applyEvent(projection, JSON.parse(line));
  }
  return projection;
}

function serializeProjection(p) {
  return {
    goalId: p.goalId,
    version: p.version,
    lifecycle: p.lifecycle,
    objective: p.objective,
    scope: p.scope,
    nonGoals: p.nonGoals,
    dod: p.dod,
    tasks: Object.fromEntries(p.tasks),
    checkpointCount: p.checkpointCount,
    completionVerdict: p.completionVerdict,
    blockedReason: p.blockedReason,
    nextAction: p.nextAction,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    eventSchemaVersion: p.eventSchemaVersion,
  };
}

function updateRegistry(stateRoot, event, projection) {
  const registryPath = join(stateRoot, "registry.json");
  let registry;
  if (existsSync(registryPath)) {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } else {
    registry = { schema_version: REGISTRY_SCHEMA_VERSION, active_goal_ids: [], goals: {} };
  }

  const goalId = event.goalId;
  if (!registry.goals[goalId]) {
    registry.goals[goalId] = {};
  }
  registry.goals[goalId].lifecycle = projection.lifecycle;
  registry.goals[goalId].objective = projection.objective;
  registry.goals[goalId].updatedAt = projection.updatedAt;

  const isActive = projection.lifecycle === "active";
  const idx = registry.active_goal_ids.indexOf(goalId);
  if (isActive && idx === -1) {
    registry.active_goal_ids.push(goalId);
  } else if (!isActive && idx !== -1) {
    registry.active_goal_ids.splice(idx, 1);
  }

  const tmpPath = registryPath + ".tmp";
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, registryPath);
}
