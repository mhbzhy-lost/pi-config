# Blocked Task 的恢复动作不可执行

## 1. 预期行为

blocked task 的 workspace 已安全释放后，应能通过 typed amendment 明确 retry；若原任务不再适用，应 supersede 并新增 replacement。

## 2. 实际行为

Graph 要求 blocked task 走 amend，但 reducer 的 v2 amend 只允许修改或删除 pending task，因此推荐动作必然被拒。

## 3. 稳定复现

将 task settle 为 blocked、discard 并释放 workspace，再按 status 建议调用普通 `goal.amended(updateTasks)`；`assertTaskUpdatable` 抛出 `cannot update non-pending task`。

## 4. 根因

状态机缺少 blocked→pending/superseded 的显式恢复事件，试图复用普通任务定义 patch，而普通 patch 又正确地冻结了非 pending task。

## 5. 影响范围

Goal 会永久停在无法继续也无法安全替换的 task；Agent 只能绕过 typed 工具或手工改状态，TokenRec 会话因此出现恢复顺序混乱。

## 6. 修复与验证

新增 v3 `task.block_resolved`，仅在 workspace 已释放时允许 `retry` 或 `supersede`；未释放时 fail closed。先写 released/unreleased RED，再保持普通 amendment 对非 pending task 的冻结。
