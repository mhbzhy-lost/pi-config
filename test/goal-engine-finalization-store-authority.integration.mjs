import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../scripts/lib/goal-engine/store.mjs";
import { buildObligationFinalizationManifest } from "../scripts/lib/goal-engine/finalization.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const goalId = "store-finalization-goal";
const head = "a".repeat(40);
const h = value => String(value).padStart(64, "0");

function runtimeDraft() {
  const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  return {
    schemaVersion: "goal-runtime.v1", eventId: "store-finalization-draft", goalId,
    occurredAt: "2026-08-20T00:00:00.000Z", type: "goal.runtime_drafted",
    data: { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: head, readiness: "draft" },
  };
}
function root() { return mkdtempSync(join(tmpdir(), "r11-store-finalization-")); }
function fixture() {
  const stateRoot = root();
  store.appendEvent(stateRoot, runtimeDraft(), 0);
  return stateRoot;
}
function paths(stateRoot) { return { events: join(stateRoot, "goals", goalId, "events.jsonl"), projection: join(stateRoot, "goals", goalId, "projection.json"), registry: join(stateRoot, "registry.json") }; }
function world() { return { safe: true, repo: { root: "/repo/store-finalization", head, branch: "main", trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, resources: [], activeRuns: [] }; }
function load(stateRoot, id = goalId) {
  assert.equal(typeof store.loadFinalizationProjection, "function", "R11 Store adapter must export loadFinalizationProjection(stateRoot, goalId)");
  return store.loadFinalizationProjection(stateRoot, id);
}
function unchanged(stateRoot, before) {
  const p = paths(stateRoot);
  assert.deepEqual({ events: readFileSync(p.events, "utf8"), projection: readFileSync(p.projection, "utf8"), registry: readFileSync(p.registry, "utf8") }, before, "authority loader must never repair tampered Store files");
}
function snapshot(stateRoot) { const p = paths(stateRoot); return { events: readFileSync(p.events, "utf8"), projection: readFileSync(p.projection, "utf8"), registry: readFileSync(p.registry, "utf8") }; }
function rejectsWithoutRepair(name, mutate) {
  test(name, () => {
    const stateRoot = fixture();
    try { assert.equal(typeof store.loadFinalizationProjection, "function", "R11 loader must exist before its fail-closed protections count"); mutate(stateRoot); const changed = snapshot(stateRoot); assert.throws(() => load(stateRoot), /finalization|projection|store|registry|unsafe|state/i); unchanged(stateRoot, changed); }
    finally { rmSync(stateRoot, { recursive: true, force: true }); }
  });
}

test("Store-owned finalization projection replays under writer lock, verifies snapshot and active registry identity", () => {
  const stateRoot = fixture();
  try {
    const first = load(stateRoot), second = load(stateRoot);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(first.goalId, goalId);
    assert.equal(first.projection.goalId, goalId);
    assert.equal(first.projectionStateHash, store.projectionStateHash(first.projection));
    assert.equal(second.projectionStateHash, first.projectionStateHash, "same durable event chain has a stable Store hash");
    assert.equal(Object.isFrozen(first.projection), true);
    assert.deepEqual(Object.keys(first).sort(), ["goalId", "projection", "projectionStateHash", "version"], "loader envelope has the exact Store contract");
    assert.equal(first.version, first.projection.version);
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test("manifest rejects every caller projection identity or semantic mismatch before building", () => {
  const stateRoot = fixture();
  try {
    const owned = load(stateRoot);
    for (const [label, mutate] of [
      ["goalId", projection => { projection.goalId = "caller-goal"; }],
      ["version", projection => { projection.version += 1; }],
      ["lifecycle", projection => { projection.lifecycle = "completed"; }],
      ["tasks", projection => { projection.tasks.set("caller-task", { id: "caller-task" }); }],
      ["conditions", projection => { projection.conditions.set("caller-condition", { id: "caller-condition" }); }],
    ]) {
      const caller = structuredClone(owned.projection);
      mutate(caller);
      assert.throws(() => buildObligationFinalizationManifest({ projection: caller, storeProjection: owned, worldSnapshot: world(), conditionValidity: new Map(), resourceInventory: [] }), /store|projection|identity|mismatch|envelope/i, `${label} mismatch must be rejected`);
    }
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test("manifest ignores only caller pseudo stateHash while retaining Store authority", () => {
  const stateRoot = fixture();
  try {
    const owned = load(stateRoot);
    const callerProjection = structuredClone(owned.projection);
    callerProjection.stateHash = "f".repeat(64);
    const manifest = buildObligationFinalizationManifest({ projection: callerProjection, storeProjection: owned, worldSnapshot: world(), conditionValidity: new Map(), resourceInventory: [] });
    assert.equal(manifest.stateHash, owned.projectionStateHash);
    assert.notEqual(manifest.stateHash, callerProjection.stateHash);
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test("manifest rejects tampering with any Store envelope identity field", () => {
  const stateRoot = fixture();
  try {
    const owned = load(stateRoot);
    for (const [label, mutate] of [
      ["goalId", envelope => { envelope.goalId = "tampered-goal"; }],
      ["version", envelope => { envelope.version += 1; }],
      ["projectionStateHash", envelope => { envelope.projectionStateHash = "f".repeat(64); }],
      ["projection", envelope => { envelope.projection = structuredClone(envelope.projection); envelope.projection.lifecycle = "completed"; }],
    ]) {
      const tampered = structuredClone(owned);
      mutate(tampered);
      assert.throws(() => buildObligationFinalizationManifest({ projection: structuredClone(owned.projection), storeProjection: tampered, worldSnapshot: world(), conditionValidity: new Map(), resourceInventory: [] }), /store|projection|identity|mismatch|envelope/i, `${label} envelope tamper must be rejected`);
    }
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test("loader returns Store-owned projection and detects Map mutation during manifest rebuild", () => {
  const stateRoot = fixture();
  try {
    const first = load(stateRoot), before = snapshot(stateRoot), originalHash = first.projectionStateHash;
    try { first.projection.tasks.set("mutated-after-load", { id: "mutated-after-load" }); } catch { /* immutable Store-owned Map is also acceptable */ }
    const second = load(stateRoot);
    assert.equal(second.projectionStateHash, originalHash, "a projection Map mutation must not alter the durable Store");
    assert.deepEqual(snapshot(stateRoot), before);
    const mutated = structuredClone(second.projection);
    mutated.tasks.set("mutated-after-load", { id: "mutated-after-load" });
    assert.throws(() => buildObligationFinalizationManifest({ projection: mutated, storeProjection: second, worldSnapshot: world(), conditionValidity: new Map(), resourceInventory: [] }), /store|projection|identity|mismatch|mutation|hash/i);
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

test("manifest stateHash is the Store projectionStateHash, never caller projection.stateHash", () => {
  const stateRoot = fixture();
  try {
    const owned = load(stateRoot);
    const callerProjection = structuredClone(owned.projection);
    callerProjection.stateHash = "f".repeat(64);
    const manifest = buildObligationFinalizationManifest({ projection: callerProjection, storeProjection: owned, worldSnapshot: world(), conditionValidity: new Map(), resourceInventory: [] });
    assert.equal(manifest.stateHash, owned.projectionStateHash);
    assert.notEqual(manifest.stateHash, callerProjection.stateHash);
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});

rejectsWithoutRepair("loader fails closed when projection snapshot is replaced", stateRoot => writeFileSync(paths(stateRoot).projection, "{}\n"));
rejectsWithoutRepair("loader fails closed when projection snapshot is truncated", stateRoot => writeFileSync(paths(stateRoot).projection, "{\n"));
rejectsWithoutRepair("loader fails closed when events are truncated", stateRoot => writeFileSync(paths(stateRoot).events, ""));
rejectsWithoutRepair("loader fails closed when events are replaced", stateRoot => writeFileSync(paths(stateRoot).events, `${JSON.stringify({ ...runtimeDraft(), eventId: "replaced-event", goalId: "other-goal" })}\n`));
rejectsWithoutRepair("loader fails closed when registry omits the active goal", stateRoot => { const p = paths(stateRoot); const registry = JSON.parse(readFileSync(p.registry, "utf8")); registry.active_goal_ids = []; registry.goals = {}; writeFileSync(p.registry, JSON.stringify(registry)); });
rejectsWithoutRepair("loader fails closed when registry goal identity drifts", stateRoot => { const p = paths(stateRoot); const registry = JSON.parse(readFileSync(p.registry, "utf8")); registry.goals[goalId].objective = "drifted objective"; writeFileSync(p.registry, JSON.stringify(registry)); });
rejectsWithoutRepair("loader fails closed when registry JSON is corrupt", stateRoot => writeFileSync(paths(stateRoot).registry, "{ corrupt\n"));
rejectsWithoutRepair("loader fails closed when registry path is a symlink", stateRoot => { const p = paths(stateRoot); const target = `${p.registry}.target`; writeFileSync(target, readFileSync(p.registry)); rmSync(p.registry); symlinkSync(target, p.registry); });
rejectsWithoutRepair("loader fails closed when registry permissions are unsafe", stateRoot => chmodSync(paths(stateRoot).registry, 0o644));
test("loader fails closed for a different goalId without modifying Store files", () => {
  const stateRoot = fixture();
  try { assert.equal(typeof store.loadFinalizationProjection, "function", "R11 loader must exist before its fail-closed protections count"); const before = snapshot(stateRoot); assert.throws(() => load(stateRoot, "other-goal"), /finalization|projection|store|registry|unsafe|state/i); unchanged(stateRoot, before); }
  finally { rmSync(stateRoot, { recursive: true, force: true }); }
});
rejectsWithoutRepair("loader fails closed when events path is a symlink", stateRoot => { const p = paths(stateRoot); const target = `${p.events}.target`; writeFileSync(target, readFileSync(p.events)); rmSync(p.events); symlinkSync(target, p.events); });
rejectsWithoutRepair("loader fails closed when projection permissions are unsafe", stateRoot => chmodSync(paths(stateRoot).projection, 0o644));
