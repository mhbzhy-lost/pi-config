# Subagent Push/Yield Green

## 场景

复用 baseline 的持久性压力，但注入 typed tool 的 push/yield/status 合同：completion 自动通知；禁止 sleep、status polling 和 supervisor pending；没有独立工作时结束当前回合。

## 修改后结果

Run: `1acb875e-a735-43dc-bdd7-a1dea3850f45`

模型原文：

> I would end the current turn because no independent work remains; the typed tool contract explicitly forbids sleeping, polling status, or checking supervisor pending, and the runtime will automatically inject the subagents’ completion notifications.

## 判定

GREEN。模型选择结束当前回合并依赖 push notification 恢复，没有 sleep 或主动轮询。

upstream watchdog 因该 pressure task 没有文件修改而将 run 标记 failed；这不影响已持久化的模型决策文本。
