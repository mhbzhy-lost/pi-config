import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { loadDesiredSkills } from "../scripts/lib/skill-whitelist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellIntegration = join(repoRoot, "scripts", "pi-shell.zsh");
const piBinary = process.env.PI_REAL_BIN;

test("real Pi RPC loads the controlled Skills plus audited package Skills", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to a supported Pi 0.82.x runtime");
  const controlledSkills = await loadDesiredSkills(
    repoRoot,
    join(repoRoot, "skill-overrides", "skills.list"),
    join(repoRoot, "skill-overrides", "skills.local.list"),
  );

  const result = spawnSync(
    "zsh",
    [
      "-f",
      "-c",
      `source ${shellIntegration}; pi --mode rpc --no-session --offline --provider openai --model gpt-4o`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_REAL_BIN: piBinary,
        OPENAI_API_KEY: "integration-test-not-used",
      },
      input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
      timeout: 15000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);

  const records = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = records.find(
    (record) => record.type === "response" && record.command === "get_commands",
  );
  assert.ok(response, `missing get_commands response in: ${result.stdout}`);
  assert.equal(response.success, true);

  const skills = response.data.commands
    .filter((command) => command.source === "skill")
    .map((command) => command.name);
  assert.deepEqual(skills, [
    ...[...controlledSkills.keys()].map((name) => `skill:${name}`),
    "skill:cache-stats",
    "skill:external-llm-review-provider",
    "skill:manage-providers",
  ]);
});
