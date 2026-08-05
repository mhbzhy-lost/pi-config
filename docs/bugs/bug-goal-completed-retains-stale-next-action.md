# Goal 完成后保留过期 nextAction

## 1. 预期行为

`goal.completed` 应清空上一任务/checkpoint 的 `nextAction`、`blockedReason` 和未消费动作能力，并把本 epoch 的完成结果写入历史。

## 2. 实际行为

`goalCompleted()` 只更新 lifecycle 与 verdict，之前 checkpoint 写入的 `nextAction` 会继续出现在 completed projection。

## 3. 稳定复现

依次创建 Goal、写 `goal.checkpoint`、完成全部任务并追加 `goal.completed`；projection.lifecycle 为 completed，但 nextAction 仍是完成前指令。

## 4. 根因

完成 reducer 没有执行终态字段归一化，也没有 completion history 可区分过期动作与新 epoch 动作。

## 5. 影响范围

`goal_status` 可能要求 Agent 在已完成 Goal 上执行无效 integrate/accept/dispatch，造成错误恢复和重复 mutation。

## 6. 修复与验证

让完成事件原子清空瞬态动作/阻塞字段、追加 immutable completionHistory，并根据 session binding 进入 watching 或 quiescent。先写 stale nextAction RED，再验证完成投影与 legacy replay。
