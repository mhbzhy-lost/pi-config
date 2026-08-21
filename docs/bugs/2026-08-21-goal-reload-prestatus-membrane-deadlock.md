# 已暂停 runtime reload 后的 pre-status membrane 死锁

## 现象

owner session 的 Goal runtime 已处于 `suspended`，且 suspension 的资源隔离与全部 closure proof 已完成时，旧 session metadata 仍可能保留精确的 `goal-engine-runtime-intent-pending`。reload 的 `session_start` 只恢复该 metadata，随后 `before_agent_start` 在 `goal_status` 有机会执行前立即注入 R10B。因此把清除 gate 放在 `goal_status` handler 中不可达。

即使 reload 阶段清除了该 stale gate，首条普通 owner input 的末尾逻辑仍仅按 active lifecycle 与 owner binding 创建 pending gate，未排除 `runtimeState=suspended`。它会再次锁住下一轮 `before_agent_start`，同样无法抵达签发 `resume_runtime` authority 的 status frontier。

## 修复边界

仅在 durable owner-owned、fully-closed suspended projection 的 reload/session hook 对账 stale intent gate，并阻止该 suspended runtime 的普通 owner input 重建 gate。active、awaiting approval、calibrating 等其他 runtime 状态继续 fail-closed；不修改旧 Goal、session、ownership 或 workspace 生命周期。
