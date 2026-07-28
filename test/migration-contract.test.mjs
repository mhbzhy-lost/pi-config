import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expectedGlobalSkills = [
  "external-llm-review",
  "git-commit-convention",
  "systematic-debugging",
  "test-driven-development",
  "receiving-code-review",
  "writing-skills",
  "writing-plans",
  "plan-runner-dispatch",
  "subagent-dispatch",
  "exa-search",
  "playwright",
  "browser-auth-session",
];

test("migration exposes exactly the required global Skills", async () => {
  const { loadDesiredSkills } = await import("../scripts/lib/skill-whitelist.mjs");
  const skills = await loadDesiredSkills(repoRoot, join(repoRoot, "skill-overrides", "skills.list"));

  assert.deepEqual([...skills.keys()], expectedGlobalSkills);
});

test("migration removes the legacy Task 7 runtime", async () => {
  const legacyFiles = [
    "scripts/lib/subagent-jobs.mjs",
    "scripts/lib/subagent-extension.mjs",
    "scripts/lib/subagent-agents.mjs",
    "pi/extensions/subagent.ts",
  ];

  await Promise.all(
    legacyFiles.map(async (file) => {
      await assert.rejects(access(join(repoRoot, file)));
    }),
  );
});

test("migration keeps ordinary agent profiles independent from subagent tools", async () => {
  const parseFrontmatter = (content) =>
    Object.fromEntries(
      content
        .split("---")[1]
        .trim()
        .split("\n")
        .map((line) => line.split(/:\s+/, 2)),
    );
  const [executor, spark] = await Promise.all(
    ["executor", "spark"].map(async (name) =>
      parseFrontmatter(await readFile(join(repoRoot, "pi", "agents", `${name}.md`), "utf8")),
    ),
  );

  assert.equal(executor.model, "codex-pool/gpt-5.6-terra");
  assert.equal(spark.model, "codex-pool/gpt-5.3-codex-spark");
  assert.equal(executor.tools.includes("subagent"), false);
  assert.equal(spark.tools.includes("subagent"), false);
  assert.equal(executor.extensions, undefined);
  assert.equal(spark.extensions, undefined);
});

test("migration keeps the Plan profiles and child extension isolated", async () => {
  const parseFrontmatter = (content) =>
    Object.fromEntries(
      content
        .split("---")[1]
        .trim()
        .split("\n")
        .map((line) => line.split(/:\s+/, 2)),
    );
  const [runner, reviewer] = await Promise.all(
    ["plan-runner", "plan-reviewer"].map(async (name) =>
      parseFrontmatter(await readFile(join(repoRoot, "pi", "agents", `${name}.md`), "utf8")),
    ),
  );

  assert.equal(runner.model, "codex-pool/gpt-5.6-sol");
  assert.equal(reviewer.model, "codex-pool/gpt-5.6-sol");
  assert.equal(runner.share, "false");
  assert.equal(reviewer.share, "false");
  assert.equal(runner.fallback, "false");
  assert.equal(reviewer.fallback, "false");
  assert.equal(runner.extensions, undefined);
  assert.equal(reviewer.extensions, undefined);
  assert.equal(runner.subagentOnlyExtensions, ".pi-subagents/plan-runner-entry.mjs");
  const runnerTools = new Set(runner.tools.split(","));
  assert.equal(runnerTools.has("subagent"), false);
  assert.equal(runnerTools.has("subagent_wait"), true);
  assert.equal(runnerTools.has("subagent_supervisor"), true);
  assert.equal(reviewer.tools.includes("subagent"), false);
  assert.equal(reviewer.tools.includes("write"), false);
  await access(join(repoRoot, "pi", "child-extensions", "plan-capsule.ts"));
  await assert.rejects(access(join(repoRoot, "pi", "extensions", "subagent.ts")));
});

test("migration ignores all Plan runtime state", async () => {
  const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\/var\/$/m);
});
