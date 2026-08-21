# suspended runtime reload 后 resume 死锁

## 现象

`goal-runtime.v1` 已处于 `suspended` 且 suspension closure 已完全闭合（`affectedTaskIds`、`affectedRunIds` 均为空）时，owner session 在 reload 前已经获得 `resume_runtime` offer。随后普通 owner 输入会持久化 runtime intent pending。相同 owner session reload 后，首次 `goal_status` 从 custom entry 恢复该 pending gate，直接返回 `R10B_SUSPENSION_REQUIRED`，不再重新签发可用的 resume offer；`goal_amend` 又受该 gate 阻断，runtime 无法恢复。

## 根因

runtime intent gate 是内存保护门闩，其 pending 记录会在 reload 时恢复；但 `goal_status` 在读取到 durable 的、已完全闭合 suspended projection 后，尚未将此情形与 gate 对账并清除过期门闩。因此已完成 suspension 的恢复路径被 active runtime 的 fail-closed gate 永久遮蔽。

## 期望

同一 owner session reload 后，首次 `goal_status` 应仅在 durable projection 为 fully closed suspended runtime 时清除该 session/goal 的 pending gate，并签发绑定当前 session 的新 `resume_runtime` action token。必须使用 reload 后的新 token 成功执行 `resume_runtime`，最终 runtime 为 `active`；reload 前 token 不得复用。

## 回归边界

仅收窄 fully closed suspended runtime 的 reload recovery 对账：不放宽 active runtime 的 fail-closed intent gate，不修改事件 ledger、reset/transfer、workspace 生命周期或旧 Goal ledger。测试使用真实扩展和事件存储，且 suspension 不含 executor 或 workspace 资源。
