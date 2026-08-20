import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, listGoalIds } from "../scripts/lib/goal-engine/store.mjs";
import { __setStateLifecycleTestHooks, inspectGoalState, resetGoalState } from "../scripts/lib/goal-engine/state-lifecycle.mjs";

function repo() { const root = mkdtempSync(join(tmpdir(), "goal-state-lifecycle-")); execFileSync("git", ["init", "--quiet", root]); return root; }
function state(root) { return join(root, ".state", "goal-engine"); }
function event(type, data, goalId = "released-goal") { return { schemaVersion: "planned.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: "2026-01-01T00:00:00.000Z", data }; }
function createReleasedPlannedGoal(root, goalId = "released-goal") {
  const stateRoot = state(root);
  appendEvent(stateRoot, event("goal.created", { objective: "Safely clear historical state", scope: [], nonGoals: [], dod: [], tasks: ["task-1"], taskDefs: { "task-1": { description: "Prepare a safe reset", deps: [], writePaths: ["src/file.mjs"], acceptance: { criteria: [{ id: "criterion-1", statement: "state can be reset", evidenceKinds: ["tests"] }] }, workflow: "tdd" } } }, goalId), 0);
  mkdirSync(join(stateRoot, "worktrees"), { recursive: true });
  return stateRoot;
}
function resetInput(stateRoot, authorizationId = "authorized-reset") { return { stateRoot, expectedStateHash: inspectGoalState({ stateRoot }).stateHash, authorizationId }; }
function runCli(root, args) { return spawnSync(process.execPath, [resolve("scripts/goal-state-lifecycle.mjs"), ...args], { cwd: root, encoding: "utf8" }); }

test("inspect is stable and exposes only state metadata", () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root);
  const first = inspectGoalState({ stateRoot }); const second = inspectGoalState({ stateRoot });
  assert.deepEqual(first, second);
  assert.equal(first.schema, "goal-state-lifecycle.v1");
  assert.match(first.stateHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.goalIds, ["released-goal"]);
  assert.equal(JSON.stringify(first).includes("Safely clear historical state"), false);
});

test("reset rejects an incorrect compare-and-swap hash without modifying state", () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root); const before = inspectGoalState({ stateRoot });
  assert.throws(() => resetGoalState({ stateRoot, expectedStateHash: "0".repeat(64), authorizationId: "authorized-reset" }), /state hash/i);
  assert.deepEqual(inspectGoalState({ stateRoot }), before);
});

test("reset clears a released planned goal and permits a new goal", () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root);
  const result = resetGoalState(resetInput(stateRoot));
  assert.deepEqual(result, { schema: "goal-state-lifecycle.v1", beforeStateHash: result.beforeStateHash, authorizationId: "authorized-reset", clearedGoalIds: ["released-goal"], empty: true });
  assert.deepEqual(listGoalIds(stateRoot), []);
  createReleasedPlannedGoal(root, "new-goal");
  assert.deepEqual(listGoalIds(stateRoot), ["new-goal"]);
});

test("reset rejects active task resources before changing state", () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root); const before = inspectGoalState({ stateRoot });
  const projectionPath = join(stateRoot, "goals", "released-goal", "projection.json");
  const projection = JSON.parse(readFileSync(projectionPath, "utf8")); projection.tasks["task-1"].executorBinding = { runId: "live-run" };
  writeFileSync(projectionPath, `${JSON.stringify(projection)}\n`, { mode: 0o600 }); chmodSync(projectionPath, 0o600);
  assert.throws(() => resetGoalState({ stateRoot, expectedStateHash: before.stateHash, authorizationId: "authorized-reset" }), /executor|active resource/i);
  assert.equal(readFileSync(projectionPath, "utf8").includes("live-run"), true);
});

test("inspect rejects symlinks hardlinks unsafe modes and unknown entries", () => {
  for (const mutation of [
    (root) => symlinkSync("registry.json", join(state(root), "unexpected")),
    (root) => linkSync(join(state(root), "registry.json"), join(state(root), "registry-copy.json")),
    (root) => chmodSync(join(state(root), "registry.json"), 0o644),
    (root) => mkdirSync(join(state(root), "runtime")),
  ]) {
    const root = repo(); const stateRoot = createReleasedPlannedGoal(root); mutation(root);
    assert.throws(() => inspectGoalState({ stateRoot }), /unsafe|unknown|state/i);
  }
});

test("inspect reads the original registry fd across a valid path swap", () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root); const registryPath = join(stateRoot, "registry.json");
  const baseline = inspectGoalState({ stateRoot }); const displaced = join(stateRoot, ".registry-original");
  const replacement = '{\n  "schema_version": "goal-engine.registry.v1",\n  "active_goal_ids": ["released-goal"],\n  "goals": {"released-goal": {}}\n}\n';
  __setStateLifecycleTestHooks({
    beforeSecureFileRead(path) {
      if (path !== registryPath) return;
      renameSync(path, displaced);
      writeFileSync(path, replacement, { mode: 0o600 });
    },
    beforeSecureFileFinalStat(path) {
      if (path !== registryPath) return;
      rmSync(path);
      renameSync(displaced, path);
    },
  });
  try {
    assert.deepEqual(inspectGoalState({ stateRoot }), baseline);
  } finally {
    __setStateLifecycleTestHooks(null);
    if (lstatSync(displaced, { throwIfNoEntry: false })) { rmSync(registryPath); renameSync(displaced, registryPath); }
  }
});

test("reset restores the exact inspectable state when retired cleanup fails", () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root); const before = inspectGoalState({ stateRoot });
  const ledgerBefore = readFileSync(join(stateRoot, "goals", "released-goal", "events.jsonl"));
  const registryBefore = readFileSync(join(stateRoot, "registry.json"));
  __setStateLifecycleTestHooks({ beforeRetiredGoalsCleanup() { throw new Error("injected retired cleanup failure"); } });
  try {
    assert.throws(() => resetGoalState(resetInput(stateRoot)), /reset stopped/i);
  } finally { __setStateLifecycleTestHooks(null); }
  assert.deepEqual(inspectGoalState({ stateRoot }), before);
  assert.deepEqual(readFileSync(join(stateRoot, "goals", "released-goal", "events.jsonl")), ledgerBefore);
  assert.deepEqual(readFileSync(join(stateRoot, "registry.json")), registryBefore);
  assert.deepEqual(readdirSync(stateRoot).filter((name) => name.startsWith(".goals-reset-") || name.startsWith(".registry-reset-")), []);
});

test("reset serializes with the Store writer lock", async () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root); const input = resetInput(stateRoot);
  const storeUrl = new URL("../scripts/lib/goal-engine/store.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["-e", `import(${JSON.stringify(storeUrl)}).then(({ acquireWriterLock, releaseWriterLock }) => { const lock = acquireWriterLock(process.argv[1]); process.stdout.write("locked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); releaseWriterLock(process.argv[1], lock.token); })`, stateRoot], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", (chunk) => chunk.toString() === "locked" ? resolve() : reject(new Error("lock holder failed"))); child.once("error", reject); });
  const result = resetGoalState(input);
  assert.equal(result.empty, true); assert.deepEqual(listGoalIds(stateRoot), []);
});

test("CLI fails closed on parameter boundaries and resets only its exact repository state root", () => {
  const root = repo(); const stateRoot = createReleasedPlannedGoal(root); const snapshot = inspectGoalState({ stateRoot });
  for (const args of [
    ["inspect", "--repo-root", root, "--repo-root", root],
    ["reset", "--repo-root", root, "--expected-state-hash", snapshot.stateHash],
    ["reset", "--repo-root", root, "--expected-state-hash", snapshot.stateHash, "--authorization-id", "ok", "--unknown"],
  ]) assert.notEqual(runCli(root, args).status, 0);
  const inspect = runCli(root, ["inspect", "--repo-root", root]); assert.equal(inspect.status, 0, inspect.stderr); assert.equal(JSON.parse(inspect.stdout).stateHash, snapshot.stateHash);
  const reset = runCli(root, ["reset", "--repo-root", root, "--expected-state-hash", snapshot.stateHash, "--authorization-id", "approved-1"]);
  assert.equal(reset.status, 0); assert.deepEqual(JSON.parse(reset.stdout).clearedGoalIds, ["released-goal"]);
});
