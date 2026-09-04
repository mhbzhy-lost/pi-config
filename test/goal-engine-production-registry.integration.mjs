import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGoalEngineEntry } from "../pi/extensions/goal-engine.ts";
import { createProductionGoalRuntimeHost } from "../src/goal-engine/production-runtime-host.ts";
import { resolveObservationAdapter } from "../src/goal-engine/observation-adapters.ts";
import { validateRuntimeReadiness } from "../src/goal-engine/obligation-contract.ts";
import { runtimeInit } from "./helpers/goal-runtime-fixtures.mjs";

const adapter = {
  ref: "oracle", version: "1", deterministic: true, resourceClaims: [], reset: "clean",
  artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" },
  validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] },
};
const runtimeHost = { adapters: [adapter], environments: { local: { fingerprint: "local-1", available: true } }, fixtures: { sample: { fingerprint: "sample-1", available: true } }, resources: { "fixture:sample": { capacity: 1, holders: [] } } };
function settings(value) { const dir = mkdtempSync(join(tmpdir(), "goal-engine-registry-")); const path = join(dir, "settings.json"); writeFileSync(path, JSON.stringify(value)); return path; }
function realGitRepo() { const dir = mkdtempSync(join(tmpdir(), "goal-engine-capture-")); const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" }); run(["init", "--quiet"]); run(["config", "user.email", "test@example.invalid"]); run(["config", "user.name", "Test"]); writeFileSync(join(dir, "tracked.txt"), "tracked\n"); run(["add", "tracked.txt"]); run(["commit", "--quiet", "-m", "initial"]); return dir; }

test("configured Host captures adapter facts from a real clean Git repository", () => {
  const host = createProductionGoalRuntimeHost({}, runtimeHost);
  const world = host.captureCurrentWorld({ cwd: realGitRepo() });
  assert.equal(world.safe, true);
  assert.deepEqual(world.adapters, [{ ref: "oracle", version: "1" }]);
  assert.deepEqual(world.environments, [{ ref: "local", fingerprint: "local-1", available: true }]);
  assert.deepEqual(world.fixtures, [{ ref: "sample", fingerprint: "sample-1", available: true }]);
  assert.deepEqual(world.resources, [{ key: "fixture:sample", capacity: 1, holders: [] }]);
});

test("production Host derives readiness registry, observation registry, and fresh CurrentWorld facts from settings", () => {
  const host = createProductionGoalRuntimeHost({}, { ...runtimeHost, facade: { captureCurrentWorld: (input) => input } });
  assert.deepEqual(validateRuntimeReadiness(runtimeInit(), host.registries), { readiness: "ready", reasons: [] });
  assert.equal(resolveObservationAdapter(host.adapterRegistry, { adapter: "oracle", environment: "local", fixtures: ["sample"] }).ref, "oracle");
  const first = host.captureCurrentWorld({ cwd: "/repo" }), second = host.captureCurrentWorld({ cwd: "/repo" });
  assert.deepEqual(first.environmentRegistry, { local: { fingerprint: "local-1", available: true } });
  assert.deepEqual(first.fixtureRegistry, { sample: { fingerprint: "sample-1", available: true } });
  assert.deepEqual(first.resourceRegistry, { "fixture:sample": { capacity: 1, holders: [] } });
  assert.notStrictEqual(first.resourceRegistry, second.resourceRegistry);
});

test("Pi entry passes only parsed Host-owned runtime settings to its factory", async () => {
  const seen = [];
  await createGoalEngineEntry({ registerTool() {}, on() {} }, { settingsPath: settings({ goalEngine: { enabled: true, runtimeHost } }), runtimeHostFactory(_pi, options) { seen.push(options); return {}; }, async load() { return { createGoalEngineExtension() {} }; } });
  assert.deepEqual(seen, [runtimeHost]);
});

test("missing runtimeHost keeps task-only extension loadable without inventing runtime authority", async () => {
  const seen = [];
  await createGoalEngineEntry({ registerTool() {}, on() {} }, { settingsPath: settings({ goalEngine: { enabled: true } }), async load() { return { createGoalEngineExtension(_pi, options) { seen.push(options); } }; } });
  assert.deepEqual(seen, [{}]);
});

test("invalid Host settings fail closed before extension registration", async () => {
  for (const bad of [
    { ...runtimeHost, adapters: [adapter, adapter] },
    { ...runtimeHost, adapters: [{ ...adapter, validationPlan: { ...adapter.validationPlan, actions: [{ ...adapter.validationPlan.actions[0], executable: "relative" }] } }] },
    { ...runtimeHost, environments: { local: { fingerprint: "x", available: true, secret: "no" } } },
    { ...runtimeHost, resources: { bad: { capacity: -1, holders: [] } } },
  ]) {
    let loads = 0;
    await createGoalEngineEntry({ registerTool() {}, on() {} }, { settingsPath: settings({ goalEngine: { enabled: true, runtimeHost: bad } }), async load() { loads++; return { createGoalEngineExtension() {} }; } });
    assert.equal(loads, 0);
  }
});
