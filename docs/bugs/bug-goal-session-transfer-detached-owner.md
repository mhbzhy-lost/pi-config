# Goal detached owner 会话转移崩溃

## 根因

`ownerSessionId` 将最后一个未处于 `transferred` 状态的 binding 视为 owner，因此 `detached` binding 仍是 owner；但 `goal.session_transferred` 仅查找 `watching` source binding。已 detached 的 owner 经完整 challenge 审批后发起转移时，查找结果为 `undefined`，随后 `Object.assign(undefined, ...)` 抛出 TypeError。

## 影响

owner detach 后本应允许的显式、安全、已审批会话转移无法完成，且事件投影重放会中断。

## 修复与验证策略

投影器选择与 `ownerSessionId` 语义一致的当前 source：允许 `watching` 或 `detached`、排除 `transferred`，并优先最后一条。没有合法 source 时抛出明确的 domain error，以 fail closed。转移时只更新 source 状态并保留 `detachedAt`、`reason` 等既有审计字段。新增 `created → bound(A) → detached(A) → transferred(A→B)` 的最小投影器测试，先确认旧实现 RED，再验证 source 审计、目标 watching binding 和 ownership revision。
