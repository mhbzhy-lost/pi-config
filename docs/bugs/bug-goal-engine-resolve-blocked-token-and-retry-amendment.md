# Bug：Blocked task 的 typed retry 无法消费 token 或更新合同

## 现象

blocked task 的 workspace discard/release 后，`goal_status` 正确要求 `goal_amend`，offer 参数使用通用 `task_id`。但 `resolve_blocked` typed schema 只接受 `blocked_task_id`，调用时 action token 校验报 `missing task_id`。即使绕过 token，`blocked_resolution=retry` 也忽略同一请求中的 `update_tasks`，无法修正导致 blocked 的 task contract。

## 影响

- blocked task 无法通过公开 typed ABI 恢复为 pending。
- 缺失 writePaths、验收标准或 workflow 等合同错误无法在 retry 时修正，只能手工编辑 Goal state。
- machine action、Tool schema 和 handler 三者互相矛盾，Goal 永久停留在 blocked coordination state。

## 根因

`consumeOfferedAction()` 只从 `params.task_id` 构造 token 绑定参数，没有把 `resolve_blocked.blocked_task_id` 映射到 offer 的通用 task identity。`resolve_blocked` handler 又只在 `supersede` 时附加 `goal.amended`，虽然该 schema 对 retry 同样开放 `add_tasks`、`remove_tasks` 和 `update_tasks`。

## 触发条件

1. task 已 dispatched，并 settle 为 blocked；
2. workspace 已通过 typed discard 完整释放；
3. `goal_status` 返回 `goal_amend` offer 与一次性 action token；
4. 调用 `resolve_blocked`、`blocked_resolution=retry`，并尝试更新原 task 合同。

## 修复方案

1. action offer 校验对 `resolve_blocked` 使用 `params.task_id ?? params.blocked_task_id`，仍精确绑定同一个 task，不放宽其他 operation。
2. retry 请求只要携带非空 add/remove/update payload，就在 `task.block_resolved` 之后同一原子序列追加 `goal.amended`；此时 task 已恢复 pending，可复用既有安全校验。
3. 无 amendment payload 的普通 retry 保持单事件；supersede 继续要求并执行 amendment。

## 验证方法

- 通过生产 action-token 路径完整执行 init → status/dispatch → status/blocked settle → status/discard → status/resolve_blocked。
- RED 确认旧实现因 offer 缺少 `task_id` 拒绝。
- GREEN 后确认同一 token 被消费一次，`task.block_resolved` 与 `goal.amended` 原子生效，task 回到 pending 且新增 bug 文档 writePath；token replay 继续拒绝。
