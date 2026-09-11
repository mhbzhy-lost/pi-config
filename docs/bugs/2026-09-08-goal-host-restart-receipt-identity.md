# Host restart 读取 canonical public preservation receipt 时 lease identity mismatch

## 现象

Host A 已通过 managed workspace service 把 workspace preserve；Host B 重启后按
`goalId/taskId/attempt/stateRoot` 重新读取同一 service 的 canonical public receipt，
在 `quarantineWorkspace` 的 lease identity 验证处报
`Executor workspace lease identity mismatch`。

## 生产可达调用链与 provenance

1. Goal owned-stop 的 workspace quarantine 请求携带 Store 绑定的
   `goalId`、`taskId`、`attempt`、`executionRevision`、`leaseId`、`workspacePath`、
   `headAtDispatch` 和 `stateRoot`。
2. Host 调用 managed workspace service 的公开 inventory/lookup adapter；该 adapter
   从持久 ledger 读取 `publicManagedWorkspaceReceipt`，并返回唯一 canonical public
   receipt，不返回 `ownerToken`，也不附带 Host lookup 元数据。
3. Host 检查该 receipt 的 exact public shape：`schemaVersion`、`workspaceId`、
   `leaseId`、`owner`、`originRoot`、`requestedCwd`、`originRef`、`baseCommit`、`path`、
   `dispatchCwd`、`branchRef`、`state`、`run`、`disposition`、`cleanupDebt`；随后 inspection
   和 release adapter 使用同一 receipt，service 返回 canonical preserved receipt。
4. Host restart 的真实 fixture 以 service 分配、Host A preserve、Host B reload/resource
   quarantine 复现此链路；origin 保持 clean，证明不是手工 projection 或 dirty-origin
   fixture。

## 首偏离点

旧 Host adapter 把 canonical public receipt 误当成包含 `goalId`、`taskId`、`attempt`、
`stateRoot`、`branch` 的扩展 lease shape，要求这些不存在于 public receipt 的 lookup
元数据。因此 receipt 的 owner/lease/path/revision 都与 Host expected identity 完全一致时，
仍在 shape 映射处先被拒绝。

## 修复与边界

Host 现在只消费并严格校验 `publicManagedWorkspaceReceipt`：

- request 的 `goalId/taskId/attempt/executionRevision/leaseId` 必须与 receipt 的 exact
  owner 和 leaseId 一致；
- `workspacePath`、`headAtDispatch` 必须分别匹配 receipt `path`、`baseCommit`；
- preserved receipt 必须保持 workspace、owner、lease、origin、path、branch 与 state 的
  完整 identity；任何漂移 fail closed。

`stateRoot` 仅用于 adapter lookup，不能被写入或要求出现在 public receipt。Host 不读取、
推导或输出 `ownerToken`；private token 继续留在 service 私有授权边界，preservation 和
resource quarantine 保持隔离。
