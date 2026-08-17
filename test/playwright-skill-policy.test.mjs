import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Playwright Skill owns browser mode and login-state policy", async () => {
  const [skill, agents] = await Promise.all([
    readFile(join(repoRoot, "skill-overrides", "playwright", "SKILL.md"), "utf8"),
    readFile(join(repoRoot, "pi", "AGENTS.md"), "utf8"),
  ]);

  assert.match(skill, /默认.*headless|headless.*默认/u);
  assert.match(skill, /仅.*(?:用户手动登录|用户明确要求).*headed|(?:用户手动登录|用户明确要求).*仅.*headed/u);
  assert.match(skill, /headed.*(?:登录态|认证状态).*(?:安全)?(?:共享|交接).*headless.*继续|(?:登录态|认证状态).*(?:安全)?(?:共享|交接).*headless.*继续/u);
  assert.match(skill, /已有登录态.*(?:禁止|不得).*headed/u);
  assert.match(skill, /无需用户干预.*(?:禁止|不得).*headed/u);
  assert.match(skill, /browser-auth-session/u);
  assert.match(skill, /(?:不得|禁止).*(?:输出|返回).*(?:cookie|token)|(?:cookie|token).*(?:不得|禁止).*(?:输出|返回)/iu);
  assert.doesNotMatch(agents, /^## Playwright 浏览器操作$/mu);
});
