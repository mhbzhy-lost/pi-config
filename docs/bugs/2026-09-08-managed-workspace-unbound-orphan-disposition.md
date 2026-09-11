# 未绑定 allocation orphan 的处置被 terminal policy 拒绝（2026-09-08）

## 现象

Goal 分配 workspace 后，service 的 allocation record 已 durable；随后
`task.workspace_allocated` 的 Goal append 失败时，service record 仍是
`state: "active"` 且 `run: null`。该 allocation orphan 尚无 process terminal
事实。

此前 service status/disposition 一律调用 terminal proof provider：其 pending
policy 仅允许 `preserve`，并使带 exact owner、lease 和 action token 的 orphan
`discard` 在 `MANAGED_WORKSPACE_TERMINAL` 被拒绝。

## 调用链与首个偏离点

1. workspace service `ensureAllocated` durable 写入 active allocation；
2. Goal `task.workspace_allocated` append 失败；
3. record 保持 `run: null`；
4. canonical orphan recovery 以 service receipt 授权 discard；
5. service `inspectStatus` 首先偏离：在确认 record.run 前调用
   `resolveProof`，把不存在的 terminal 事实当作 pending；
6. pending terminal policy 只允许 preserve，dispose 的 allowed-snapshot 检查拒绝
   discard。

## 修复

`record.run === null` 由 service record 权威判定，不读取、要求或构造 terminal
proof。active 且通过既有 service identity/owner/lease/action-token 约束的未绑定
record 仅发布 `discard`、`preserve`，不发布 `integrate`。discard/preserve 继续走
既有 Git cleanup、receipt、重试和幂等路径。

绑定 run 的 record 不采用该分支，仍按 observed/pending/conflict terminal policy
门禁 destructive disposition；caller 不能用其输入声称 run 未绑定。
