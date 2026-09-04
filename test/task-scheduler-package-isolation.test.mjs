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

  const { buildTaskSchedulerInstallCommand, buildTaskSchedulerPeerInstallCommand } = await import("../scripts/setup-subagent-runtime-deps.ts");
  const install = buildTaskSchedulerInstallCommand("/tmp/pi/npm");
  assert.deepEqual(install, {
    command: "npm",
    args: ["install", "--prefix", "/tmp/pi/npm", "--include=peer", "--save-exact", "@amaster.ai/pi-task-scheduler@0.1.9", "@amaster.ai/pi-shared@0.1.9", "croner@10.0.1"],
  }, "repeatable setup must install exact libraries through npm rather than loading an upstream extension");
  assert.deepEqual(buildTaskSchedulerPeerInstallCommand("/tmp/pi/npm"), {
    command: "npm",
    args: ["install", "--prefix", "/tmp/pi/npm", "--no-save", "--save-exact", "typebox@1.1.38"],
  }, "setup must own the scheduler peer without declaring it in pi/npm/package.json");

  const init = await readFile(join(repoRoot, "init-pi.sh"), "utf8");
  assert.match(init, /npm --prefix "\$SCRIPT_DIR" run setup:subagents-enhanced/, "init delegates repeatable local dependency setup");
  assert.doesNotMatch(init, /pi-task-scheduler.*(?:extension|dist\/index)/s, "init must not load upstream extension");
});
