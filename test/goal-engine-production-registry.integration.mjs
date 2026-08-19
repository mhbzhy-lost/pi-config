import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGoalEngineEntry } from "../pi/extensions/goal-engine.ts";
import { createProductionGoalRuntimeHost } from "../scripts/lib/goal-engine/production-runtime-host.mjs";
import { resolveObservationAdapter } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { validateRuntimeReadiness } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { runtimeInit } from "./helpers/goal-runtime-fixtures.mjs";

const adapter = {
  ref: "oracle", version: "1", deterministic: true, resourceClaims: [], reset: "clean",
  artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" },
  validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] },
};
const runtimeHost = { adapters: [adapter], environments: { local: { fingerprint: "local-1", available: true } }, fixtures: { sample: { fingerprint: "sample-1", available: true } }, resources: { "fixture:sample": { capacity: 1, holders: [] } } };
function settings(value) { const dir = mkdtempSync(join(tmpdir(), "goal-engine-registry-")); const path = join(dir, "settings.json"); writeFileSync(path, JSON.stringify(value)); return path; }

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
