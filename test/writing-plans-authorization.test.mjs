import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(repoRoot, "skill-overrides", "writing-plans", "SKILL.md");

test("writing-plans requires explicit user authorization before creating a plan", async () => {
  const skill = await readFile(skillPath, "utf8");
  const gateIndex = skill.indexOf("## 用户授权门禁");
  const startIndex = skill.indexOf("**开始时声明：**");
  const structureIndex = skill.indexOf("## 范围与文件结构检查");
  const planPathIndex = skill.indexOf("**新计划默认保存到：**");

  assert.ok(gateIndex >= 0, "Skill must define an Authorization Gate");
  assert.ok(gateIndex < startIndex, "Authorization Gate must precede the start declaration");
  assert.ok(gateIndex < structureIndex, "Authorization Gate must precede file-structure analysis");
  assert.ok(gateIndex < planPathIndex, "Authorization Gate must precede docs/plans output guidance");
  assert.match(skill, /用户明确(?:要求|说).{0,30}(?:写计划|先规划)|明确同意(?:编写)?计划/u);
  assert.match(skill, /沉默|未回复/u);
  assert.match(skill, /任务复杂|多步骤|最佳实践/u);
  assert.match(skill, /不(?:得|能).{0,30}(?:解释|视为).{0,20}授权/u);
  assert.match(skill, /未获授权.{0,80}(?:不得创建|不创建).{0,30}计划文件/u);
  assert.match(skill, /未获授权.{0,180}直接(?:执行|按).{0,80}(?:TDD|subagent-dispatch|安全|项目规则)/u);
  assert.match(skill, /不(?:得|要).{0,40}反复(?:阻塞|等待).{0,30}授权/u);
});
