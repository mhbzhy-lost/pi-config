import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(path) {
  return readFile(join(repoRoot, path), "utf8");
}

test("TDD description covers high-risk changes and late-testing symptoms", async () => {
  const skill = await read("skill-overrides/test-driven-development/SKILL.md");
  const description = skill.match(/^description: (.+)$/mu)?.[1] ?? "";

  for (const term of [
    "production code",
    "configuration",
    "Skill behavior",
    "feature",
    "bugfix",
    "refactor",
    "behavior change",
    "implementation before a failing test",
    "manual testing only",
  ]) {
    assert.match(description, new RegExp(term, "iu"), `description must cover ${term}`);
  }
});

test("AGENTS provides only the first-change TDD loading route", async () => {
  const agents = await read("pi/AGENTS.md");
  const bugfixEnd = agents.indexOf("## Git Commit 规范");
  const route = agents.slice(agents.indexOf("## Bugfix"), bugfixEnd);

  assert.match(route, /^## 逻辑变更$/mu);
  assert.match(route, /生产代码、配置或 Skill 逻辑\/行为变更首次修改前必须加载 `test-driven-development`/u);
  assert.match(route, /流程和豁免只在 Skill 维护/u);
  assert.doesNotMatch(route, /RED-GREEN-REFACTOR|单行改动|纯文档变更/u);
});

test("TDD exemptions take priority and bug records apply only to bug fixes", async () => {
  const skill = await read("skill-overrides/test-driven-development/SKILL.md");

  assert.match(skill, /三类显式豁免优先/u);
  for (const exemption of ["单行改动", "纯文档变更", "已有测试覆盖"]) {
    assert.match(skill, new RegExp(exemption, "u"));
  }
  assert.match(skill, /Iron Law.*仅约束非豁免变更/us);
  assert.match(skill, /No exceptions.*仅约束非豁免变更/us);
  assert.match(skill, /仅当修复 bug\/issue\/incident/u);
  assert.match(skill, /docs\/bugs\/<日期>-<摘要>\.md/u);
  assert.match(skill, /feature、refactor、configuration、Skill 非 bug 变更不创建伪 bug 文档/u);
  assert.doesNotMatch(skill, /所有生产或 Skill 逻辑变更.*docs\/bugs\/bug-\*\.md/us);
});
