import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const writingPlansPath = join(repoRoot, "skill-overrides", "writing-plans", "SKILL.md");
const writingSkillsPath = join(repoRoot, "skill-overrides", "writing-skills", "SKILL.md");

function descriptionOf(skill) {
  return skill.match(/^---\n[\s\S]*?^description:\s*(.+)$/m)?.[1] ?? "";
}

test("writing-plans description loads broadly without treating loading as authorization", async () => {
  const skill = await readFile(writingPlansPath, "utf8");
  const description = descriptionOf(skill);

  assert.match(description, /多步骤.*实施|实施.*多步骤/u);
  assert.match(description, /DAG|Wave/u);
  assert.match(description, /计划|规划/u);
  assert.doesNotMatch(description, /产出|创建|编写.*计划/u);
  assert.doesNotMatch(description, /授权/u);
  assert.match(skill, /## 用户授权门禁/u);
});

test("writing-plans asks the user without assuming a named question tool", async () => {
  const skill = await readFile(writingPlansPath, "utf8");

  assert.match(skill, /向用户提问并结束当前轮次/u);
  assert.doesNotMatch(skill, /使用提问工具/u);
});

test("writing-skills requires subagent-dispatch for fresh-context pressure tests", async () => {
  const skill = await readFile(writingSkillsPath, "utf8");

  assert.match(skill, /\*\*REQUIRED SUB-SKILL:\*\*\s*Use `?subagent-dispatch`?.{0,100}fresh[ -]context|fresh[ -]context.{0,100}\*\*REQUIRED SUB-SKILL:\*\*\s*Use `?subagent-dispatch`?/iu);
});

test("writing-skills deploys verified files unless the user explicitly authorizes commit or push", async () => {
  const skill = await readFile(writingSkillsPath, "utf8");
  const deployment = skill.slice(skill.indexOf("**Deployment:**"));

  assert.match(deployment, /用户明确授权.{0,80}(?:提交|commit|推送|push)/iu);
  assert.match(deployment, /未授权.{0,80}(?:验证完成的文件|已验证文件)/u);
  assert.doesNotMatch(deployment, /\[ \]\s*Commit skill to git and push to your fork/u);
});
