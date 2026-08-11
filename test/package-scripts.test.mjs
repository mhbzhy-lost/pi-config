import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package scripts expose required commands and managed worktree lifecycle commands", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const requiredScripts = {
    test: 'node --test "test/**/*.test.mjs"',
    "test:integration": "node --test test/pi-runtime.integration.mjs",
    "test:subagents": "node --test test/pi-subagents-runtime.integration.mjs",
    "setup:subagent-runtime": "node scripts/setup-subagent-runtime-deps.mjs",
    doctor: "node scripts/doctor.mjs",
    worktree: "node scripts/worktree-lifecycle.mjs",
    "worktree:audit": "node scripts/worktree-lifecycle.mjs audit",
  };

  for (const [name, command] of Object.entries(requiredScripts)) {
    assert.equal(packageJson.scripts[name], command);
  }
});
