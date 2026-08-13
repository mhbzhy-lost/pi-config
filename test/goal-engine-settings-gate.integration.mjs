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

test("enabled entry propagates loader failures", async () => {
  const dir = settingsDir({ goalEngine: true });
  const expected = new Error("goal engine module failed to load");

  await assert.rejects(createGoalEngineEntry(disabledPi(), {
    settingsPath: join(dir, "settings.json"),
    async load() { throw expected; },
  }), (error) => error === expected);
});
