import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { applyEvent, createProjection } from "./events.mjs";
import { acquireWriterLock, releaseWriterLock } from "./store.mjs";

const SCHEMA = "goal-state-lifecycle.v1";
const REGISTRY_SCHEMA = "goal-engine.registry.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTERNAL_LOCKS = new Set([".writer.lock", ".writer.recovery.guard"]);

function failure(message) { return Object.assign(new Error(`GOAL_STATE_LIFECYCLE_UNSAFE: ${message}`), { code: "GOAL_STATE_LIFECYCLE_UNSAFE" }); }
function safeAuthorizationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw failure("invalid authorization id");
  return value;
}
function secureDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(`unsafe ${label} directory`);
}
function secureFile(path, label) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600) throw failure(`unsafe ${label} file`);
  const content = readFileSync(path);
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1 || (after.mode & 0o7777) !== 0o600) throw failure(`replaced ${label} file`);
  return { content, mode: before.mode & 0o7777 };
}
function assertDescendant(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path) throw failure("directory escape");
}
function replayGoal(goalId, eventsBytes, projectionBytes) {
  let replay = createProjection();
  const text = eventsBytes.toString("utf8");
  if (!text.trim()) throw failure(`goal ${goalId} has empty events`);
  try {
    for (const line of text.trim().split("\n")) replay = applyEvent(replay, JSON.parse(line), { replay: true });
  } catch (error) { throw failure(`goal ${goalId} cannot safely replay`); }
  if (replay.goalId !== goalId) throw failure(`goal ${goalId} replay identity mismatch`);
  let projection;
  try { projection = JSON.parse(projectionBytes.toString("utf8")); } catch { throw failure(`goal ${goalId} has invalid projection`); }
  if (!projection || projection.goalId !== goalId || !projection.tasks || typeof projection.tasks !== "object" || Array.isArray(projection.tasks)) throw failure(`goal ${goalId} projection mismatch`);
  for (const task of [...Object.values(projection.tasks), ...replay.tasks.values()]) {
    if (!task || typeof task !== "object" || task.executorBinding || (task.workspace != null && task.workspace.released !== true)
      || ["dispatched", "running", "settling"].includes(task.status)) throw failure(`goal ${goalId} has active resource`);
  }
}
function inspectUnlocked(stateRoot) {
  const root = resolve(stateRoot);
  secureDirectory(root, "state root");
  const rootNames = readdirSync(root).sort();
  if (!rootNames.includes("registry.json") || !rootNames.includes("goals") || !rootNames.includes("worktrees")) throw failure("incomplete managed state root");
  const registryPath = join(root, "registry.json");
  const registryFile = secureFile(registryPath, "registry");
  for (const name of rootNames) if (!new Set(["registry.json", "goals", "worktrees", ...INTERNAL_LOCKS]).has(name)) throw failure(`unknown state entry: ${name}`);
  let registry;
  try { registry = JSON.parse(registryFile.content.toString("utf8")); } catch { throw failure("invalid registry JSON"); }
  if (!registry || registry.schema_version !== REGISTRY_SCHEMA || !Array.isArray(registry.active_goal_ids) || !registry.goals || typeof registry.goals !== "object" || Array.isArray(registry.goals)) throw failure("invalid registry");
  const goalsPath = join(root, "goals"), worktreesPath = join(root, "worktrees");
  secureDirectory(goalsPath, "goals"); secureDirectory(worktreesPath, "worktrees");
  if (readdirSync(worktreesPath).length) throw failure("worktrees directory is not empty");
  const goalIds = readdirSync(goalsPath).sort();
  if (JSON.stringify(goalIds) !== JSON.stringify(Object.keys(registry.goals).sort()) || !goalIds.every((id) => SAFE_ID.test(id) && id !== "." && id !== "..")) throw failure("registry and goal directories mismatch");
  const files = [{ path: "registry.json", ...registryFile }];
  for (const goalId of goalIds) {
    const goalPath = join(goalsPath, goalId); assertDescendant(goalsPath, goalPath); secureDirectory(goalPath, `goal ${goalId}`);
    const names = readdirSync(goalPath).sort();
    if (JSON.stringify(names) !== JSON.stringify(["events.jsonl", "projection.json"])) throw failure(`goal ${goalId} has unknown entry`);
    const events = secureFile(join(goalPath, "events.jsonl"), `goal ${goalId} events`);
    const projection = secureFile(join(goalPath, "projection.json"), `goal ${goalId} projection`);
    replayGoal(goalId, events.content, projection.content);
    files.push({ path: `goals/${goalId}/events.jsonl`, ...events }, { path: `goals/${goalId}/projection.json`, ...projection });
  }
  const manifest = files.map(({ path, mode, content }) => ({ path, mode, size: content.length, contentHash: createHash("sha256").update(content).digest("hex") })).sort((a, b) => a.path.localeCompare(b.path));
  return { root, goalIds, stateHash: createHash("sha256").update(JSON.stringify({ schema: SCHEMA, files: manifest })).digest("hex") };
}
function withLock(stateRoot, operation) {
  const root = resolve(stateRoot); const lock = acquireWriterLock(root);
  try { return operation(root); } finally { releaseWriterLock(root, lock.token); }
}

export function inspectGoalState({ stateRoot } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw failure("state root is required");
  return withLock(stateRoot, () => {
    const inspected = inspectUnlocked(stateRoot);
    return { schema: SCHEMA, stateHash: inspected.stateHash, goalIds: inspected.goalIds };
  });
}

export function resetGoalState({ stateRoot, expectedStateHash, authorizationId } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot || !/^[a-f0-9]{64}$/.test(expectedStateHash || "")) throw failure("state root and expected state hash are required");
  safeAuthorizationId(authorizationId);
  return withLock(stateRoot, (root) => {
    const inspected = inspectUnlocked(root);
    if (inspected.stateHash !== expectedStateHash) throw failure("state hash compare-and-swap mismatch");
    const retiredGoals = join(root, `.goals-reset-${randomUUID()}`);
    try {
      renameSync(join(root, "goals"), retiredGoals);
      mkdirSync(join(root, "goals"), { mode: 0o700 });
      mkdirSync(join(root, "worktrees"), { recursive: true, mode: 0o700 });
      if (readdirSync(join(root, "worktrees")).length) throw failure("worktrees directory changed during reset");
      const tmp = join(root, `.registry-reset-${randomUUID()}.tmp`);
      writeFileSync(tmp, `${JSON.stringify({ schema_version: REGISTRY_SCHEMA, active_goal_ids: [], goals: {} }, null, 2)}\n`, { flag: "wx", mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, join(root, "registry.json"));
      rmSync(retiredGoals, { recursive: true, force: true });
    } catch (error) {
      throw failure(`reset stopped without completing safely: ${error.message}`);
    }
    return { schema: SCHEMA, beforeStateHash: inspected.stateHash, authorizationId, clearedGoalIds: inspected.goalIds, empty: true };
  });
}
