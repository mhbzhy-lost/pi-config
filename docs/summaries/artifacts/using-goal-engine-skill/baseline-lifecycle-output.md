压缩/重载后先 `goal_status(goal_id)`，重读持久 task、attempt、workspace；不得凭旧通知继续。

**成功**：`goal_settle(task_id, attempt_id)` → 核验 settled=success、artifact/提交/验收证据 → `goal_workspace_integrate(workspace_id)` → 在集成结果上跑必需检查 → `goal_accept(task_id)`。禁止先 accept 后合并。settle 前提：同一 attempt 已有 typed 终态且 task=dispatched；integrate 前提：settle 成功且 workspace=active；accept 前提：集成成功、workspace 非 active、验收项通过。

**失败**：`goal_settle(...)` → 二选一 `goal_workspace_discard(...)`（无保留价值）或 `goal_workspace_preserve(...)`（需取证/复用）→ 确认旧 workspace 已销毁或归档为非 active、task 可重试 → `goal_dispatch(task_id)` 生成新 attempt。失败物不得 integrate；旧 workspace 未处置不得重派。

包装层 prose/status 非权威；匹配 attempt 的 typed artifact 决定 settle 输入，settle 后持久状态是最终权威。风险：8 分钟不足以完成集成后验证时应错过窗口，不得降级门禁。

```acceptance-report
{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"已给出两分支顺序、全部前置条件、权威来源及残余风险"}],"changedFiles":["/tmp/using-goal-engine-baseline-lifecycle.md"],"testsAddedOrUpdated":[],"commandsRun":[],"validationOutput":["人工核对顺序与场景约束"],"residualRisks":["发布窗口可能不足以完成集成后验证"],"noStagedFiles":true,"diffSummary":"新增生命周期决策评估文档","reviewFindings":["无阻断项"],"manualNotes":"未查找或假设 Goal Engine 使用 Skill；仅按 typed 生命周期判断"}
```
