# Goal Engine 的 detach_session 无法抢占 runnable offer

## 1. 预期行为

当前可信 Pi session 对 active Goal 有 `watching` binding 时，即使 `goal_status` 已为 runnable task 颁发 `goal_dispatch` offer，也应能使用该 fresh token 显式调用 `goal_amend(operation=detach_session)`。系统先验证当前 binding 与 session identity，再 append-only 地终结旧 offer 并记录 detach；此后该 session 不再获得该 Goal 的 continuity、compaction 或 reminder 注入。

## 2. 实际行为

runnable task 优先产生 `{ tool: "goal_dispatch", params: { goal_id, task_id } }` offer。以该 token 调用 `detach_session` 时，通用精确参数校验要求 `task_id`，报错 `action offer params do not match: missing task_id`，无法解除当前 session 绑定。

## 3. 稳定复现

创建含至少一个 runnable task 的 active Planned Goal，并以当前 session 建立 `watching` binding。调用 `goal_status` 获得 `goal_dispatch` 的 fresh `action_token`，随后调用 `goal_amend`，参数为 `operation=detach_session`、该 token 与当前 session。当前实现会在消费前因缺少 offer 的 `task_id` 拒绝。

## 4. 根因

`consumeOfferedAction` 对所有 mutation 都把请求参数投影为 offer 的精确 params；它没有将 cleanup/cancellation 风格的当前-session detach 与 task action 区分。与此同时，continuity 选择 active projection 时没有检查该 session 是否已有 detached binding，导致已 detach 的 active Goal 仍可能被选中。

## 5. 影响范围

会话无法安全放弃仍有 runnable work 的 Goal；若通过其他路径产生 detached binding，当前 session 仍可能收到 recovery、tool gate、compaction checkpoint/recovery 与未 settle reminder。不能放宽普通 dispatch、settle、integrate、accept 或 amend 的 exact offer 约束。

## 6. 修复与验证

仅为 `detach_session` 增加受限抢占：先确认目标 session 未显式指向其他 identity，且当前可信 session 有 watching binding；再以原 offer 的 tool/params/session 消费旧 offer，并 append `goal.session_detached`，不分配 workspace。continuity 选择和 reminder 过滤当前 session 的 detached binding。测试覆盖 runnable offer 抢占、旧 token 失效、跨 session/错误/stale token 的零状态变化，以及 detach 后各 hook 不再注入；运行 continuity 与 extension targeted tests。
