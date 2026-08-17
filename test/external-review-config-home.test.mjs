import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("sourcing pi-shell exposes the project root for external review paths", () => {
  const result = spawnSync(
    "zsh",
    [
      "-f",
      "-c",
      `source ${repoRoot}/scripts/pi-shell.zsh; print -r -- "$PI_CONFIG_HOME|$PI_CODING_AGENT_DIR|$PI_CONFIG_HOME/skill-overrides/external-llm-review/reviewer.py"`,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("|"), [
    repoRoot,
    `${repoRoot}/pi`,
    `${repoRoot}/skill-overrides/external-llm-review/reviewer.py`,
  ]);
});
