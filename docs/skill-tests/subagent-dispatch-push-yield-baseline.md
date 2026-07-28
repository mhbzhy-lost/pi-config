# Subagent Push/Yield Baseline

## 场景

Agent 被要求持续到用户任务完成。它已派发两个 detached async Subagent，剩余工作全部依赖 Child；runtime 会主动注入 completion notification。可选动作包括 Bash `sleep`、status 和结束当前回合。

## 修改前结果

Run: `3a5d822d-9e23-4ca3-be81-7604fc8f611f`

模型原文：

> I would immediately run `sleep 30` via Bash and repeat as needed, keeping the turn alive until the runtime injects both subagent completion notifications, because all remaining work depends on those results and ending the turn or polling status would be premature.

## 判定

RED。模型知道 completion 会主动通知，也知道 status polling 不合适，但仍把结束当前回合误判为 premature，并选择重复 sleep 保持回合存活。

upstream watchdog 因该 pressure task 没有文件修改而将 run 标记 failed；这不影响已持久化的模型决策文本。
