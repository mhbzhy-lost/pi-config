import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import { resolveSkillSource } from "../scripts/lib/skill-whitelist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readSkillFile(skillName, fileName = "SKILL.md") {
  return readFile(join(repoRoot, "skill-overrides", skillName, fileName), "utf8");
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return files.flat();
}

test("TDD local skill", async () => {
  const [skill, goodTests] = await Promise.all([
    readSkillFile("test-driven-development"),
    readSkillFile("test-driven-development", "writing-good-tests.md"),
  ]);

  assert.match(skill, /单行(?:改动|变更)|single-line (?:change|edit)/iu);
  assert.match(skill, /纯文档|documentation-only/iu);
  assert.match(skill, /已有测试覆盖|existing test coverage/iu);
  assert.match(skill, /显式(?:声明)?豁免理由|explicit(?:ly)? (?:state|declare).*exemption reason/iu);
  assert.match(skill, /docs\/bugs\/bug-\*\.md/u);
  assert.match(skill, /RED(?:[–-]GREEN[–-]REFACTOR)?|正确失败/u);
  assert.doesNotMatch(skill, /Throwaway prototypes|Generated code|Configuration files/iu);
  assert.doesNotMatch(goodTests, /superpowers:/iu);
});

test("writing-skills local skill", async () => {
  const skillDirectory = join(repoRoot, "skill-overrides", "writing-skills");
  const requiredFiles = [
    "SKILL.md",
    "anthropic-best-practices.md",
    "testing-skills-with-subagents.md",
    "persuasion-principles.md",
    "graphviz-conventions.dot",
    "examples/CLAUDE_MD_TESTING.md",
  ];
  await Promise.all(requiredFiles.map((file) => access(join(skillDirectory, file))));

  const [skill, files] = await Promise.all([readFile(join(skillDirectory, "SKILL.md"), "utf8"), listFiles(skillDirectory)]);
  const content = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

  assert.match(skill, /Skill 内容允许全英文|Skills? (?:may|can) be (?:written|authored) in English/iu);
  assert.match(content, /fresh[ -]context/iu);
  assert.match(content, /subagent-dispatch/u);
  assert.doesNotMatch(content, /superpowers:|\.\.\/using-superpowers\//iu);
});

test("writing-plans local skill", async () => {
  const skillDirectory = join(repoRoot, "skill-overrides", "writing-plans");
  const [skill, files] = await Promise.all([readSkillFile("writing-plans"), listFiles(skillDirectory)]);
  const content = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

  assert.match(skill, /计划文档必须使用中文/u);
  assert.match(skill, /DAG/u);
  assert.match(skill, /Deps/u);
  assert.match(skill, /Wave/u);
  assert.match(skill, /WritePaths/u);
  assert.match(skill, /Subagent-Driven/u);
  assert.match(skill, /Inline Execution/u);
  assert.match(skill, /Goal Engine/u);
  assert.match(skill, /managed worktree|受管理.*worktree/iu);
  assert.match(skill, /docs\/plans\//u);
  assert.doesNotMatch(content, /superpowers:/iu);
});

test("AGENTS keeps only global rules", async () => {
  const agents = await readFile(join(repoRoot, "pi", "AGENTS.md"), "utf8");

  assert.doesNotMatch(agents, /^## TDD$/mu);
  assert.doesNotMatch(agents, /^## Skill 行为 Override$/mu);
  assert.match(agents, /^## Bugfix$/mu);
  assert.match(agents, /^## Subagent$/mu);
  assert.match(agents, /^## 敏感信息$/mu);
  assert.match(agents, /^## Worktree 生命周期$/mu);
  assert.match(agents, /^## 输出语言$/mu);
});

test("repository has no Superpowers runtime dependency", async () => {
  const violations = [];
  const activeFiles = [
    "README.md",
    "init-pi.sh",
    "scripts/lib/skill-whitelist.mjs",
    "skill-overrides/README.md",
  ];
  const forbiddenDocumentation = [
    /vendor\/superpowers/iu,
    /\bgit\s+submodule(?:\s+(?:init(?:ializ\w*)?|update)\b|.{0,80}初始化)/iu,
    /\bSuperpowers\b.{0,80}(?:升级|回退|upgrade|fallback)|(?:升级|回退|upgrade|fallback).{0,80}\bSuperpowers\b/iu,
  ];
  for (const path of activeFiles) {
    const content = await readFile(join(repoRoot, path), "utf8");
    for (const pattern of forbiddenDocumentation) {
      if (pattern.test(content)) {
        violations.push(`${path} contains forbidden runtime dependency documentation: ${pattern}`);
      }
    }
  }

  for (const path of [".gitmodules", "vendor/superpowers"]) {
    try {
      await access(join(repoRoot, path));
      violations.push(`${path} still exists`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  for (const name of ["test-driven-development", "writing-skills", "writing-plans"]) {
    const source = await resolveSkillSource(repoRoot, name);
    if (!relative(repoRoot, source).startsWith(`skill-overrides/`)) {
      violations.push(`${name} resolves outside skill-overrides/: ${source}`);
    }
  }

  assert.deepEqual(violations, []);
});
