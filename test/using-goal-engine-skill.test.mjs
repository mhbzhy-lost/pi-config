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

test("initializes from the current project and classifies workflows by their actual work", async () => {
  const { body } = await loadSkill();
  assert.match(body, /(当前项目|current project)[\s\S]{0,100}(repository|workspace|仓库|工作区)[\s\S]{0,100}(有效|valid)[\s\S]{0,80}HEAD/i);
  assert.match(body, /(未来|future)[\s\S]{0,120}(Executor worktree|执行器 worktree|执行器工作树)/i);
  assert.doesNotMatch(body, /(Executor worktree|执行器 worktree|执行器工作树)[\s\S]{0,80}(有效|valid)[\s\S]{0,80}HEAD/i);
  assert.match(body, /no active goal[\s\S]{0,100}(初始化检查|initialization checks)/i);
  assert.match(body, /tdd[\s\S]{0,160}(逻辑变更|logic)[\s\S]{0,100}RED/i);
  assert.match(body, /existing-tests[\s\S]{0,180}(真实|real)[\s\S]{0,120}(覆盖|cover)/i);
  assert.match(body, /docs-only[\s\S]{0,180}(纯文档|pure documentation)[\s\S]{0,160}(脚本|scripts)[\s\S]{0,120}(配置|configuration)[\s\S]{0,120}(运行时|runtime)/i);
  assert.match(body, /(混合|mixed)[\s\S]{0,100}(拆分|split)/i);
});

test("requires executor acceptance before settle and status-gated lifecycle transitions", async () => {
  const { body } = await loadSkill();
  assert.match(body, /成功路径[\s\S]{0,900}status[\s\S]{0,120}dispatch[\s\S]{0,220}Executor[\s\S]{0,220}(acceptance commands|验收命令)[\s\S]{0,180}(worktree|工作树)[\s\S]{0,180}settle[\s\S]{0,120}status[\s\S]{0,120}integrate[\s\S]{0,120}status[\s\S]{0,240}(当前项目|current project)[\s\S]{0,180}(最终回归|final regression)[\s\S]{0,180}accept/i);
  assert.match(body, /(wrapper|包装层)[\s\S]{0,160}(failed|timeout)[\s\S]{0,200}(artifact|session|worktree|工作树)[\s\S]{0,180}goal_status[\s\S]{0,160}(requiredNextAction|machine action|机器动作)/i);
  assert.match(body, /(ambiguous|歧义)[\s\S]{0,120}(停止|stop)/i);
  assert.match(body, /失败路径[\s\S]{0,900}status[\s\S]{0,120}settle[\s\S]{0,120}status[\s\S]{0,120}integrate[\s\S]{0,120}discard[\s\S]{0,120}status[\s\S]{0,180}(dispatch|amend)/i);
  assert.match(body, /(每个|every)[\s\S]{0,100}(durable mutation|持久化变更)[\s\S]{0,140}goal_status/i);
});

test("keeps Goal Engine mutation at the Host typed-tool boundary", async () => {
  const { body } = await loadSkill();
  assert.match(body, /(只|only)[\s\S]{0,100}(Pi Host|Host)[\s\S]{0,160}(七个|seven)[\s\S]{0,100}(typed tools|类型工具)/i);
  assert.match(body, /(shell|CLI)[\s\S]{0,120}(禁止|不得|不要)[\s\S]{0,120}(Goal Engine|目标引擎)/i);
  assert.match(body, /(内部 core scripts|internal core scripts)[\s\S]{0,100}(禁止|不得|不要)/i);
  assert.match(body, /(搜索源码|search source)[\s\S]{0,140}(schema|ABI)/i);
  assert.match(body, /(缺|missing)[\s\S]{0,100}(schema|工具|tools)[\s\S]{0,140}(停止|stop)[\s\S]{0,140}(Host|宿主)/i);
  assert.match(body, /(当前|current)[\s\S]{0,100}(ToolDefinition|工具定义)[\s\S]{0,100}(schema|类型)/i);
  assert.match(body, /(Git precheck|Git 预检)[\s\S]{0,100}(不受此禁止|not subject)/i);
});
