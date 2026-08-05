import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expectedGlobalSkills = [
  "external-llm-review",
  "git-commit-convention",
  "test-driven-development",
  "writing-skills",
  "writing-plans",
  "subagent-dispatch",
  "using-goal-engine",
  "exa-search",
  "playwright",
  "browser-auth-session",
];

test("pins the official Superpowers release", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "vendor", "superpowers", "package.json"), "utf8"));
  assert.equal(packageJson.version, "6.2.0");
});

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

  assert.equal(executor.model, "openai-codex/gpt-5.6-terra");
  assert.equal(spark.model, "openai-codex/gpt-5.3-codex-spark");
  assert.equal(executor.tools.includes("subagent"), false);
  assert.equal(spark.tools.includes("subagent"), false);
  assert.equal(executor.extensions, undefined);
  assert.equal(spark.extensions, undefined);
  assert.equal(executor.subagentOnlyExtensions, ".pi-subagents/root-session-owner-entry.mjs");
  await access(join(repoRoot, "pi", "child-extensions", "root-session-owner.ts"));
});

test("migration removes retired Plan profiles and child extensions", async () => {
  for (const relative of [
    "pi/agents/plan-runner.md",
    "pi/agents/plan-reviewer.md",
    "pi/extensions/plan-launcher.ts",
    "pi/child-extensions/plan-runner.ts",
    "pi/child-extensions/plan-capsule.ts",
  ]) {
    await assert.rejects(access(join(repoRoot, relative)), { code: "ENOENT" });
  }
  await assert.rejects(access(join(repoRoot, "pi", "extensions", "subagent.ts")));
});

test("configuration cycles only authenticated OpenAI Codex models", async () => {
  const settings = JSON.parse(await readFile(join(repoRoot, "pi", "settings.json"), "utf8"));

  assert.equal(settings.defaultProvider, "openai-codex");
  assert.deepEqual(settings.enabledModels, [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.3-codex-spark",
  ]);
});

test("migration ignores all Plan runtime state", async () => {
  const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\/var\/$/m);
});
