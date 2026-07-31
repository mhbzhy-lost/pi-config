import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package scripts expose unit, integration, subagent, and read-only doctor commands", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(packageJson.scripts, {
    test: 'node --test "test/**/*.test.mjs"',
    "test:integration": "node --test test/pi-runtime.integration.mjs",
    "test:subagents": "node --test test/pi-subagents-runtime.integration.mjs",
    "test:plan": "node --test test/plan-capsule.integration.mjs",
    "test:plan-harness": "node --test test/plan-flat-runtime-harness.integration.mjs test/plan-amendment-harness.integration.mjs",
    "setup:plan-runtime": "node scripts/setup-plan-runtime-deps.mjs",
    doctor: "node scripts/doctor.mjs",
  });
});
