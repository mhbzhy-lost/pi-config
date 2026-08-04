**选 C：保留 Goal 并恢复。**

精确顺序：`goal_status(goalId)` 确认 v1、全 pending、attempts=0、workspace/lease 为空；Git 执行：将 `/.state/goal-engine/` 加入 `.gitignore` → `git rm -r --cached --ignore-unmatch .state/goal-engine` → `git add .gitignore` → `git commit -m 'chore: stop tracking Goal Engine state'` → 验证 `git rev-parse --verify HEAD`、`git ls-files '.state/goal-engine/**'` 为空、`git status --porcelain` 为空。若错误属于已持久化 task contract，调用 `goal_amend(goalId, expectedVersion:1, …)`；若只是仓库代码/配置，修复并提交，不 amend。再 `goal_status` 取最新 version → `goal_dispatch(goalId, taskId, expectedVersion:v)` → `goal_status`。

绝不编辑 projection/events；事件流可读且失败未产生 attempt 时绝不 re-init。仅原 Goal 已正式终止并清零资源，或状态确实不可恢复且获批时才新建。派发前以 `goal_status` 的 lease/workspace 为空及 `git worktree list --porcelain` 仅含主工作树确认无遗留；派发后须与 active attempt 一一对应。残余风险：仍需现场验证 contract 修正内容。

```acceptance-report
{
  "criteriaSatisfied": [{"id":"criterion-1","status":"satisfied","evidence":"已给出 C 方案、typed tools/Git 顺序及残余风险"}],
  "changedFiles": ["/tmp/using-goal-engine-baseline-recovery.md"],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": ["方案覆盖状态保留、基线修复、amend/re-init 边界及 worktree/lease 对账"],
  "residualRisks": ["演示前仍须实际验证 contract 修正内容"],
  "noStagedFiles": true,
  "diffSummary": "新增决策评估文档",
  "reviewFindings": ["no blockers"],
  "manualNotes": "未查询或假设存在 Goal Engine Skill；未执行真实 Goal/Git 操作。"
}
```
