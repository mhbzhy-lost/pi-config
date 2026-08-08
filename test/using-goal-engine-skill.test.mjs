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

test("requires typed disposition or managed lifecycle ownership for worktree cleanup", async () => {
  const { body } = await loadSkill();

  assert.match(body, /raw[\s\S]{0,80}git worktree[\s\S]{0,120}(add|remove|prune|move|repair|lock|unlock)/i);
  assert.match(body, /managed lifecycle CLI|worktree-lifecycle\.mjs/i);
  assert.match(body, /owner CAS|owner.*compare-and-swap/i);
  assert.match(body, /typed Goal disposition/i);
  assert.match(body, /--force[\s\S]{0,100}(remove|删除|移除)|(?:remove|删除|移除)[\s\S]{0,100}--force/i);
  assert.match(body, /(\/tmp|TTL|clean)[\s\S]{0,140}(不.*授权|not.*authori)/i);
  assert.match(body, /branch[\s\S]{0,100}(cleanup|清理|delete|删除)/i);
});

test("gives status-only, human-decided orphan workspace recovery guidance", async () => {
  const { body } = await loadSkill();

  // These are resource-specific prohibitions, not the general worktree-cleanup rule.
  assert.match(body, /\.state[\s\S]{0,120}(不提交|不得提交|禁止提交|do not commit|never commit)[\s\S]{0,80}(commit|提交)|(?:不提交|不得提交|禁止提交|do not commit|never commit)[\s\S]{0,120}\.state/i);
  assert.match(body, /\.state[\s\S]{0,140}(不得|禁止|不要|不)(?:执行)?[\s\S]{0,40}(reset|restore)|(不得|禁止|不要|不)[\s\S]{0,100}(reset|restore)[\s\S]{0,100}\.state/i);
  for (const resource of ["lease|租约", "worktree|工作树", "branch|分支"]) {
    assert.match(body, new RegExp(`(不得|禁止|不要|不)[\\s\\S]{0,80}(手工|手动|命令行|CLI|shell)[\\s\\S]{0,100}(删除|delete|remove)[\\s\\S]{0,100}(${resource})|(${resource})[\\s\\S]{0,100}(不得|禁止|不要|不)[\\s\\S]{0,80}(手工|手动|命令行|CLI|shell)[\\s\\S]{0,100}(删除|delete|remove)`, "i"));
  }

  assert.match(body, /Origin must be clean[\s\S]{0,220}(停止|stop)[\s\S]{0,160}goal_status/i);
  assert.match(body, /Executor workspace already exists[\s\S]{0,220}(停止|stop)[\s\S]{0,160}goal_status/i);
  assert.match(body, /(Origin must be clean|Executor workspace already exists)[\s\S]{0,260}(不得|禁止|不要|不)[\s\S]{0,100}(raw Git|Git 修复|git fix)/i);
  for (const code of ["ORPHANED_EXECUTOR_WORKSPACE", "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED", "ORPHANED_WORKSPACE_NOT_SETTLED"]) assert.match(body, new RegExp(`\\b${code}\\b`));

  assert.match(body, /(ORPHANED_EXECUTOR_WORKSPACE|verified orphan)[\s\S]{0,300}(goal_status|status)[\s\S]{0,300}(human|人类)[\s\S]{0,160}(choice|选择)/i);
  assert.match(body, /(human|人类)[\s\S]{0,180}(明确|explicit)[\s\S]{0,180}(选择|choice)[\s\S]{0,180}goal_integrate\((discard|preserve)\)/i);
  assert.match(body, /(不得|禁止|不要|不)[\s\S]{0,100}(默认|优先|default|prefer)[\s\S]{0,120}(preserve|discard)/i);
  assert.match(body, /requiredNextAction[\s\S]{0,100}null[\s\S]{0,180}(停止|等待|stop|wait)[\s\S]{0,180}(选择|choice|人类|human)/i);

  // Orphan handling must stop at multi-choice requests and never treat pressure/authority as an explicit discard/preserve decision.
  assert.match(body, /requiredNextAction[\s\S]{0,120}null[\s\S]{0,220}(blockingReason\.choices|choices)[\s\S]{0,160}(多个|multiple)[\s\S]{0,140}(choice|选择)/i);
  assert.match(body, /requiredNextAction[\s\S]{0,120}null[\s\S]{0,220}(不得|不应|不能|不要)[\s\S]{0,120}goal_integrate/i);
  assert.match(body, /(提问工具|询问用户|向用户提问|ask the user|ask user)[\s\S]{0,180}(discard|preserve)[\s\S]{0,180}(结束当前轮次|结束本轮|end the turn|停止)/i);
  assert.match(body, /(发布压力|最快修好|authority|授权|deadline)[\s\S]{0,180}(不能|不应|不得|不要)[\s\S]{0,180}(将|视作|映射|替代|当成|等同)[\s\S]{0,180}(discard|preserve|明确|explicit)[\s\S]{0,120}(选择|choice)/i);
  assert.match(body, /(preserve|保留)[\s\S]{0,180}(不是|不应|不得)[\s\S]{0,140}(更安全|可逆|默认|安全|reversible|default|artifact|保护)/i);
  assert.match(body, /(人类|人工|human)[\s\S]{0,200}(回复|回复后|回应|answer|response)[\s\S]{0,180}(必须|应当|需)[\s\S]{0,140}(明确|指向|选择|点选)[\s\S]{0,120}(discard|preserve)/i);
  assert.match(body, /ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED[\s\S]{0,260}(只|only)[\s\S]{0,100}goal_status/i);
  assert.match(body, /ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED[\s\S]{0,260}(不得|禁止|不要|不)[\s\S]{0,140}(discard|preserve)/i);
  assert.match(body, /ORPHANED_WORKSPACE_NOT_SETTLED[\s\S]{0,220}(无效|invalid)[\s\S]{0,180}(verified|已验证)[\s\S]{0,160}(选择|choice)/i);

  assert.match(body, /(preserved|已保留)[\s\S]{0,200}(resources|资源)[\s\S]{0,160}(未释放|not released)[\s\S]{0,180}(唯一|only)[\s\S]{0,100}(机器动作|machine action)[\s\S]{0,180}goal_integrate\(discard\)/i);
  assert.match(body, /(preserved|已保留)[\s\S]{0,300}(未释放|not released)[\s\S]{0,180}(不得|禁止|不要|不)[\s\S]{0,100}goal_amend/i);
  assert.match(body, /(释放后|after release)[\s\S]{0,160}goal_status[\s\S]{0,180}(dispatch|amend)/i);
});
