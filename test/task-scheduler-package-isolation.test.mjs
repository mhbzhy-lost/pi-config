import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scheduler = "@amaster.ai/pi-task-scheduler";

test("scheduler package is isolated and its exact dependencies install without loading its extension", async () => {
  const settings = JSON.parse(await readFile(join(repoRoot, "pi/settings.json"), "utf8"));
  const entry = settings.packages.find((candidate) => candidate?.source === `npm:${scheduler}@0.1.9`);
  assert.deepEqual(entry, {
    source: `npm:${scheduler}@0.1.9`, extensions: [], skills: [], prompts: [], themes: [],
  }, "scheduler package must be declared with every Pi resource explicitly disabled");

  const runtimePackage = JSON.parse(await readFile(join(repoRoot, "pi/npm/package.json"), "utf8"));
  assert.equal(runtimePackage.dependencies[scheduler], "0.1.9");
  assert.equal(runtimePackage.dependencies["@amaster.ai/pi-shared"], "0.1.9");
  assert.equal(runtimePackage.dependencies.croner, "10.0.1");
  assert.equal(Object.hasOwn(runtimePackage.dependencies, "typebox"), false, "Doctor forbids pi/npm from owning the scheduler peer as a direct dependency");

  const init = await readFile(join(repoRoot, "init-pi.sh"), "utf8");
  assert.match(init, /--prefix "\$SCRIPT_DIR\/pi\/npm" ci --legacy-peer-deps --ignore-scripts/);
  assert.match(init, /--prefix "\$SCRIPT_DIR\/pi\/npm" install --legacy-peer-deps --no-save --ignore-scripts typebox@1\.1\.38/);
  assert.doesNotMatch(init, /pi-task-scheduler.*(?:extension|dist\/index)/s, "init must not load upstream extension");

  const adapter = await readFile(join(repoRoot, "src/task-scheduler/adapter.ts"), "utf8");
  const extension = await readFile(join(repoRoot, "pi/extensions/task-scheduler.ts"), "utf8");
  assert.doesNotMatch(`${adapter}\n${extension}`, /durable[-_/]root|\.pi\/durable|durableRoot/i, "scheduler recovery must not access a private durable root");
  assert.doesNotMatch(extension, /packages\/pi-subagents-enhanced|pi-subagents-enhanced/, "scheduler recovery bridge must not load the subagents package");
});
