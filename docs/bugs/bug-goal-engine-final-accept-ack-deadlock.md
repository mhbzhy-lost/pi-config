# 最终验收确认丢失死锁

## 现象
最后一个 `task.accepted` 已持久化而 `goal.completed` 写入前抛错时，目标保持 active 且全部已验收，重试会再次验收而失败。

## 影响
机器无法继续完成目标，且可能把已持久化确认误报为失败。

## 根因
验收流程先写事件，未在 append 异常后按投影身份恢复，也未给 active/all-accepted 暴露终结动作。原生产提交 `0af7167` 补了恢复实现，但没有对应的 accept durable/crash RED：未覆盖最后 `task.accepted` 后 `goal.completed` 写前失败、两种 durable-then-throw、非最终确认重试及 terminal 零追加边界。

## 复现
在最后任务验收后让完成事件 append 抛错，再以显式 goal_id/task_id 调用 `goal_accept`。

## 修复
projection-first 识别已验收和已完成状态；append 异常后 reload，已提交则继续终结或返回，未提交重抛，其他身份抛 `AMBIGUOUS_ACCEPT_COMMIT`。

## 验证
覆盖 goal.completed 写前失败后的新 Extension 显式身份恢复、task.accepted 与 goal.completed durable-then-throw、非最终确认重试和重复终结零新增事件。
