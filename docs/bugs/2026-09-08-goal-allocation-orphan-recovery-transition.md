# Allocation orphan recovery transition（2026-09-08）

## 症状

workspace service 已经 durable allocation 后，`task.workspace_allocated` 的 Goal
ledger append 可能失败。此时 Goal 只保留 `task.dispatch_requested`：task 的
`workspace` 为 `null`，但 service 已有该 attempt 的 workspace receipt。

新的 `goal_status` 会从 service inventory 发现这个 orphan，并签发仅可选择
`discard` 或 `preserve` 的用户 challenge。用户授权后，`goal_integrate` 会复用
既有 `task.workspace_orphan_recovered` 事实事件恢复处理。

## 根因

该 reducer 过去只接受 `pending` task，并要求 attempt 是下一个 attempt。合法
allocation append gap 的 task 则是 `dispatch_requested`，其 attempt 已被
`task.dispatch_requested` durable 记录。因此 challenge 已签名、disposition 已获
授权后，现有 reducer 仍拒绝该事件，不能进入 discard/preserve 闭环。

## 修复边界

不增加 event 或 projection 字段。reducer 除保留原有 pending 路径外，仅接受严格的
allocation gap：task 必须是 `dispatch_requested`、workspace 为 `null`、没有
executor/run binding，且 dispatch request 的 attempt、contract、确定性
workspace ID、origin/base identity 与 recovery event 一致。恢复事实将 task 置回
`pending`，让 discard 能完成后安全 redispatch；preserve 仍沿用既有保留语义，必须
explicit release 才可 redispatch。

任何不完整 identity、已有 workspace/binding、attempt 或 contract 漂移，以及
`dispatched`、`running`、`succeeded` 等状态均 fail closed。
