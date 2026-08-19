import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGoalEngineEntry } from "../pi/extensions/goal-engine.ts";

function enabledSettings() {
  const dir = mkdtempSync(join(tmpdir(), "goal-engine-production-host-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ goalEngine: { enabled: true } }));
  return settingsPath;
}

const capabilityNames = [
  "registries", "adapterRegistry", "captureCurrentWorld", "artifactRefForRun",
  "prepareManagedValidation", "startManagedValidation", "recoverManagedValidation",
  "inspectManagedValidation", "releaseManagedValidation", "stopOwnedRun",
  "quarantineWorkspace", "quarantineResource", "stopManagedValidation",
];

function pi() { return { registerTool() {}, on() {} }; }

test("enabled entry constructs a production Host before passing it to the extension", async () => {
  const settingsPath = enabledSettings();
  const host = Object.freeze({ marker: "injected-production-host" });
  const calls = [];
  let factoryCalls = 0;
  const targetPi = pi();
  await createGoalEngineEntry(targetPi, {
    settingsPath,
    runtimeHostFactory(target) {
      factoryCalls += 1;
      assert.equal(target, targetPi);
      return host;
    },
    async load() {
      return { createGoalEngineExtension(target, options) { calls.push({ target, options }); } };
    },
  });
  assert.equal(factoryCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.runtimeHost, host);
});

test("disabled entry does not construct or load a production Host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-engine-production-host-disabled-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ goalEngine: { enabled: false } }));
  let factoryCalls = 0;
  let loadCalls = 0;
  await createGoalEngineEntry(pi(), {
    settingsPath,
    runtimeHostFactory() { factoryCalls += 1; },
    async load() { loadCalls += 1; return { createGoalEngineExtension() {} }; },
  });
  assert.equal(factoryCalls, 0);
  assert.equal(loadCalls, 0);
});

test("Host construction failure is fail closed and never falls back to null", async () => {
  const expected = new Error("production Host unavailable");
  await assert.rejects(createGoalEngineEntry(pi(), {
    settingsPath: enabledSettings(),
    runtimeHostFactory() { throw expected; },
    async load() { throw new Error("extension must not load after Host failure"); },
  }), (error) => error === expected);
});

test("production runtime Host exports the frozen capability boundary", async () => {
  const module = await import("../scripts/lib/goal-engine/production-runtime-host.mjs");
  assert.equal(typeof module.createProductionGoalRuntimeHost, "function");
  const host = module.createProductionGoalRuntimeHost({}, { facade: {} });
  assert.deepEqual(Object.keys(host).sort(), capabilityNames.sort());
  for (const name of capabilityNames) {
    if (name !== "registries" && name !== "adapterRegistry") assert.equal(typeof host[name], "function", name);
  }
  assert.equal("projection" in host, false);
  assert.equal("git" in host, false);
  assert.equal("processProof" in host, false);
  assert.equal("nonce" in host, false);
});

test("captureCurrentWorld reads each canonical cwd through the injected facade", async () => {
  const { createProductionGoalRuntimeHost } = await import("../scripts/lib/goal-engine/production-runtime-host.mjs");
  const seen = [];
  const facade = { captureCurrentWorld(input) { seen.push(input); return { safe: true, repo: { root: input.cwd }, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [] }; } };
  const host = createProductionGoalRuntimeHost({}, { facade });
  const first = host.captureCurrentWorld("/canonical/one");
  const second = host.captureCurrentWorld("/canonical/two");
  assert.deepEqual(seen, [{ cwd: "/canonical/one" }, { cwd: "/canonical/two" }]);
  assert.equal(first.repo.root, "/canonical/one");
  assert.equal(second.repo.root, "/canonical/two");
});

test("stopOwnedRun delegates only the typed Root Broker binding", async () => {
  const { createProductionGoalRuntimeHost } = await import("../scripts/lib/goal-engine/production-runtime-host.mjs");
  const seen = [];
  const host = createProductionGoalRuntimeHost({ marker: "pi" }, { stopRootBrokerGoalOwnedRun(piValue, binding) { seen.push([piValue, binding]); return { state: "unknown" }; } });
  const binding = { runId: "run-1", asyncDir: ".state/async", sessionId: "session-1" };
  assert.deepEqual(await host.stopOwnedRun(binding), { state: "unknown" });
  assert.deepEqual(seen, [[{ marker: "pi" }, binding]]);
});
