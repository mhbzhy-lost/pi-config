import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGoalEngineEntry,
  isGoalEngineEnabled,
} from "../pi/extensions/goal-engine.ts";

function settingsDir(settings) {
  const dir = mkdtempSync(join(tmpdir(), "goal-engine-gate-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

function disabledPi() {
  const calls = [];
  return {
    calls,
    registerTool(definition) { calls.push(["registerTool", definition?.name]); },
    on() { throw new Error("goal engine must not subscribe to events while disabled"); },
  };
}

test("goal engine defaults to disabled when settings.json is missing", () => {
  assert.equal(isGoalEngineEnabled(join(mkdtempSync(join(tmpdir(), "goal-engine-gate-")), "settings.json")), false);
});

test("goal engine defaults to disabled when the settings key is absent", () => {
  const dir = settingsDir({ theme: "dark" });
  assert.equal(isGoalEngineEnabled(join(dir, "settings.json")), false);
});

test("goal engine stays disabled when enabled is false", () => {
  const dir = settingsDir({ goalEngine: { enabled: false } });
  assert.equal(isGoalEngineEnabled(join(dir, "settings.json")), false);
});

test("goal engine enables with an explicit enabled true", () => {
  const dir = settingsDir({ goalEngine: { enabled: true } });
  assert.equal(isGoalEngineEnabled(join(dir, "settings.json")), true);
});

test("goal engine accepts the boolean shorthand", () => {
  const dir = settingsDir({ goalEngine: true });
  assert.equal(isGoalEngineEnabled(join(dir, "settings.json")), true);
});

test("goal engine fails closed on malformed settings json", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-engine-gate-"));
  writeFileSync(join(dir, "settings.json"), "{ not json");
  assert.equal(isGoalEngineEnabled(join(dir, "settings.json")), false);
});

test("goal engine fails closed on invalid switch shapes", () => {
  for (const value of ["yes", 1, null, [], { enabled: "yes" }, { enabled: 1 }]) {
    const dir = settingsDir({ goalEngine: value });
    assert.equal(isGoalEngineEnabled(join(dir, "settings.json")), false, JSON.stringify(value));
  }
});

test("disabled entry loads no goal engine logic and registers no tools", async () => {
  const dir = settingsDir({ goalEngine: { enabled: false } });
  let loaded = 0;
  const pi = disabledPi();

  await createGoalEngineEntry(pi, {
    settingsPath: join(dir, "settings.json"),
    async load() {
      loaded += 1;
      return { createGoalEngineExtension() { throw new Error("must not run"); } };
    },
  });

  assert.equal(loaded, 0);
  assert.deepEqual(pi.calls, []);
});

test("disabled entry fails closed on a missing settings file", async () => {
  let loaded = 0;
  const pi = disabledPi();

  await createGoalEngineEntry(pi, {
    settingsPath: join(mkdtempSync(join(tmpdir(), "goal-engine-gate-")), "settings.json"),
    async load() {
      loaded += 1;
      return { createGoalEngineExtension() { throw new Error("must not run"); } };
    },
  });

  assert.equal(loaded, 0);
  assert.deepEqual(pi.calls, []);
});

test("enabled entry loads the goal engine module and creates the extension", async () => {
  const dir = settingsDir({ goalEngine: { enabled: true } });
  const pi = disabledPi();
  const created = [];
  const module = { createGoalEngineExtension(target) { created.push(target); } };

  await createGoalEngineEntry(pi, {
    settingsPath: join(dir, "settings.json"),
    async load() { return module; },
  });

  assert.deepEqual(created, [pi]);
});

test("enabled entry forwards the optional runtime trace switch", async () => {
  const dir = settingsDir({ goalEngine: { enabled: true, runtimeTrace: { enabled: true } } });
  const pi = disabledPi();
  const created = [];
  await createGoalEngineEntry(pi, {
    settingsPath: join(dir, "settings.json"),
    async load() { return { createGoalEngineExtension(target, options) { created.push({ target, options }); } }; },
  });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].options, { runtimeTrace: { enabled: true } });
});

test("production entry only injects a factory for exact explicit finalReview model configuration", async () => {
  const dir = settingsDir({ goalEngine: { enabled: true, finalReview: { provider: "configured-provider", id: "configured-model", timeoutMs: 1234 } } });
  const created = [], selected = [];
  const factory = ({ stateRoot }) => async () => ({ stateRoot });
  await createGoalEngineEntry(disabledPi(), {
    settingsPath: join(dir, "settings.json"),
    finalReviewFactory: async configuration => { selected.push(configuration); return factory; },
    async load() { return { createGoalEngineExtension(_target, options) { created.push(options); } }; },
  });
  assert.deepEqual(selected, [{ provider: "configured-provider", id: "configured-model", timeoutMs: 1234 }]);
  assert.equal(created[0].finalReviewProviderFactory, factory);
});

test("invalid or unavailable finalReview configuration fails closed without a provider factory", async () => {
  for (const finalReview of [{ provider: "x", id: "y" }, { provider: " x", id: "y", timeoutMs: 1 }, { provider: "x", id: "y", timeoutMs: 0 }, { provider: "x", id: "y", timeoutMs: 600001 }, { provider: "x", id: "y", timeoutMs: 1, key: "forbidden" }]) {
    const dir = settingsDir({ goalEngine: { enabled: true, finalReview } }); let calls = 0;
    await createGoalEngineEntry(disabledPi(), { settingsPath: join(dir, "settings.json"), finalReviewFactory: async () => { calls++; return () => async () => ({ severity: "none" }); }, async load() { throw new Error("invalid configuration must not load"); } });
    assert.equal(calls, 0);
  }
  const dir = settingsDir({ goalEngine: { enabled: true, finalReview: { provider: "x", id: "y", timeoutMs: 1 } } }); const created = [];
  await createGoalEngineEntry(disabledPi(), { settingsPath: join(dir, "settings.json"), finalReviewFactory: async () => undefined, async load() { return { createGoalEngineExtension(_target, options) { created.push(options); } }; } });
  assert.equal(created[0].finalReviewProviderFactory, undefined);
});

test("enabled entry propagates loader failures", async () => {
  const dir = settingsDir({ goalEngine: true });
  const expected = new Error("goal engine module failed to load");

  await assert.rejects(createGoalEngineEntry(disabledPi(), {
    settingsPath: join(dir, "settings.json"),
    async load() { throw expected; },
  }), (error) => error === expected);
});
