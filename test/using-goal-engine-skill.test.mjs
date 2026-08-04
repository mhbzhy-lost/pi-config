import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = new URL("../skill-overrides/using-goal-engine/SKILL.md", import.meta.url);
const whitelistPath = new URL("../skill-overrides/skills.list", import.meta.url);
const exactTools = ["goal_init", "goal_status", "goal_dispatch", "goal_settle", "goal_integrate", "goal_accept", "goal_amend"];

async function loadSkill() {
  const source = await readFile(skillPath, "utf8");
  return { source, body: source.replace(/^---[\s\S]*?---\s*/, "") };
}

test("discovers the Git-managed using-goal-engine Skill from the global allowlist", async () => {
  const { source } = await loadSkill();
  const whitelist = await readFile(whitelistPath, "utf8");
  assert.match(source, /^---\nname: using-goal-engine\ndescription: Use when [^\n]+\n---/);
  assert.ok(whitelist.split(/\r?\n/).map((line) => line.trim()).includes("using-goal-engine"));
});

test("documents the exact typed ABI without invented parameters or workspace tools", async () => {
  const { body } = await loadSkill();
  for (const tool of exactTools) assert.match(body, new RegExp(`\\b${tool}\\b`));
  const mentioned = [...body.matchAll(/\bgoal_[a-z_]+\b/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(mentioned)].sort(), [...exactTools].sort());
  assert.doesNotMatch(body, /expectedVersion|attempt_id|goal_workspace_/i);
  assert.match(body, /typed schema|类型 schema/i);
  assert.match(body, /goal_status[\s\S]{0,120}(machine action|机器动作|requiredNextAction)/i);
});

test("requires Git and task-definition checks before initialization", async () => {
  const { body } = await loadSkill();
  assert.match(body, /goal_init[\s\S]{0,500}(Git HEAD|HEAD[\s\S]{0,80}Git)/i);
  assert.match(body, /\.state\/goal-engine\/[\s\S]{0,100}(不受跟踪|untracked|ignored)/i);
  assert.match(body, /writePaths[\s\S]{0,180}(Executor worktree|执行器 worktree|工作树)/i);
  assert.match(body, /commands[\s\S]{0,180}(相对|relative)[\s\S]{0,100}(Executor worktree|执行器 worktree|工作树)/i);
  assert.match(body, /tdd.*existing-tests.*docs-only/is);
});

test("uses status-driven recovery and complete success or failure loops", async () => {
  const { body } = await loadSkill();
  assert.match(body, /(reload|compaction|恢复)[\s\S]{0,120}goal_status/i);
  assert.match(body, /status[\s\S]{0,120}dispatch[\s\S]{0,120}原样[\s\S]{0,180}dispatch-ir\.v1[\s\S]{0,160}settle[\s\S]{0,120}integrate[\s\S]{0,120}accept/i);
  assert.match(body, /failed[\s\S]{0,120}blocked[\s\S]{0,180}discard[\s\S]{0,180}(redispatch|amend)/i);
  assert.match(body, /subagent-dispatch[\s\S]{0,160}完整[\s\S]{0,120}dispatch-ir\.v1/i);
  assert.match(body, /(不要|禁止)[\s\S]{0,80}(编辑|手改)[\s\S]{0,100}(events|projection)/i);
  assert.match(body, /(amend|goal_amend)[\s\S]{0,180}(re-init|重新 init|重新初始化)/i);
  assert.match(body, /(不要|禁止)[\s\S]{0,100}(手工清理|手动清理)[\s\S]{0,100}(worktree|工作树)/i);
});
