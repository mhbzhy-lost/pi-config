import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = (name) => new URL(`../skill-overrides/${name}/SKILL.md`, import.meta.url);

async function readSkill(name) {
  return readFile(skill(name), "utf8");
}

test("subagent-dispatch documents workspace actions through the registered subagent ABI", async () => {
  const source = await readSkill("subagent-dispatch");

  assert.match(source, /subagent\(\{\s*action:\s*["']workspace_status["'],\s*workspace_id:\s*[^}]+\}\)/);
  assert.match(source, /subagent\(\{\s*action:\s*["']workspace_disposition["'],\s*workspace_id:\s*[^,}]+,\s*disposition:\s*[^,}]+,\s*action_token:\s*[^}]+\}\)/);
  assert.doesNotMatch(source, /(?<!subagent\(\{[^\n]{0,80})\bworkspace_status\(\s*workspace_id/);
  assert.doesNotMatch(source, /(?<!subagent\(\{[^\n]{0,80})\bworkspace_disposition\(\s*workspace_id/);
});

test("using-goal-engine declares its dispatch dependency and ends the turn for user questions", async () => {
  const source = await readSkill("using-goal-engine");

  assert.match(source, /REQUIRED SUB-SKILL:\*\*\s*subagent-dispatch/i);
  assert.match(source, /(缺|missing)[\s\S]{0,100}(typed tools|类型工具|schema|工具)[\s\S]{0,140}(停止|stop)/i);
  assert.doesNotMatch(source, /提问工具/);
  assert.match(source, /向用户提问[\s\S]{0,180}(结束当前轮次|结束本轮|end the turn|停止)/i);
});

test("Playwright description covers UI/E2E and login mode triggers with a conditional auth dependency", async () => {
  const source = await readSkill("playwright");

  const description = source.match(/^description:\s*(.+)$/m)?.[1] ?? "";
  for (const trigger of ["browser UI", "E2E", "manual login", "headed", "headless", "Playwright MCP"]) {
    assert.match(description, new RegExp(trigger, "i"), `description must include ${trigger}`);
  }
  assert.match(source, /CONDITIONALLY REQUIRED SUB-SKILL:[\s\S]{0,180}browser-auth-session/i);
  assert.match(source, /(headed|前台)[\s\S]{0,180}(登录态|认证|login)[\s\S]{0,180}browser-auth-session/i);
});
