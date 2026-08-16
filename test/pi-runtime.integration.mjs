import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { loadDesiredSkills } from "../scripts/lib/skill-whitelist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellIntegration = join(repoRoot, "scripts", "pi-shell.zsh");
const piBinary = process.env.PI_REAL_BIN;
const piPackage = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const piTypes = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts";

test("installed Pi SessionManager advances the active branch from custom intent to real user entry", async () => {
  const { SessionManager } = await import(piPackage);
  const manager = SessionManager.inMemory(repoRoot);
  manager.appendCustomEntry("goal-engine-runtime-approval-intent", { protocol: "goal-engine-runtime-approval-intent.v1" });
  const userEntryId = manager.appendMessage({ role: "user", content: "approve", timestamp: Date.now() });
  const branch = manager.getBranch();
  const user = branch.at(-1);
  assert.equal(userEntryId, user.id);
  assert.equal(user.parentId, branch.at(-2).id);
  assert.equal(user.message.role, "user");
  const declarations = await (await import("node:fs/promises")).readFile(piTypes, "utf8");
  const inputEvent = declarations.match(/interface InputEvent \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(inputEvent, "installed Pi must declare InputEvent");
  assert.match(inputEvent, /text: string;/);
  assert.match(inputEvent, /source: InputSource;/);
  for (const forbidden of ["entryId", "sessionId", "occurredAt"]) assert.doesNotMatch(inputEvent, new RegExp(`\\b${forbidden}\\b`));
});

test("real Pi RPC loads required auto-discovered Skills without retired products", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to an explicitly supported Pi runtime");
  const controlledSkills = await loadDesiredSkills(
    repoRoot,
    join(repoRoot, "skill-overrides", "skills.list"),
    null,
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
  const requiredSkills = [
    ...[...controlledSkills.keys()].map((name) => `skill:${name}`),
    "skill:cache-stats",
    "skill:external-llm-review-provider",
    "skill:manage-providers",
  ];
  for (const required of requiredSkills) assert.ok(skills.includes(required), `missing required Skill: ${required}`);
  assert.equal(new Set(skills).size, skills.length, "auto-discovered Skills must be unique");
  assert.equal(skills.includes("skill:plan-runner-dispatch"), false);
});
