import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Pi loads migrated global rules and model-specific prompts", async () => {
  const agents = await readFile(join(repoRoot, "pi", "AGENTS.md"), "utf8");
  const qwenSystem = await readFile(join(repoRoot, "pi", "SYSTEM.qwen.md"), "utf8");
  const anthropicSystem = await readFile(join(repoRoot, "pi", "SYSTEM.anthropic.md"), "utf8");

  assert.match(agents, /任何产生逻辑变更.*test-driven-development/s);
  assert.match(agents, /docs\/bugs\/bug-/);
  assert.match(qwenSystem, /Stop Rules/);
  assert.doesNotMatch(qwenSystem, /You are OpenCode/);
  assert.ok(anthropicSystem.length > 0);
});
