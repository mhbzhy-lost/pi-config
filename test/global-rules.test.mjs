import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Pi loads migrated global rules and Qwen prompt", async () => {
  const agents = await readFile(join(repoRoot, "pi", "AGENTS.md"), "utf8");
  const system = await readFile(join(repoRoot, "pi", "SYSTEM.md"), "utf8");

  assert.match(agents, /任何产生逻辑变更.*test-driven-development/s);
  assert.match(agents, /docs\/bugs\/bug-/);
  assert.match(system, /Analyze surrounding code, tests, and configuration first/);
  assert.doesNotMatch(system, /You are OpenCode/);
});
