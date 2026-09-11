# Host 公共 receipt 错误要求 ownerToken

## 现象

Host restart 的 managed service fixture 将 stateRoot 放到 origin 外，以避免
`MANAGED_WORKSPACE_ORIGIN_DIRTY`。随后 `production-runtime-host` 的旧
quarantine adapter 对 `lease.ownerToken` 调用 SHA-256；真实
`publicManagedWorkspaceReceipt` 不含该私有字段，因而在 Host 访问/哈希
`undefined ownerToken` 时失败。

## 生产可达调用链与首偏离点

1. Host restart 通过 Goal 的 legacy/inspection adapter 调用
   `loadExecutorWorkspaceLease`，读取 managed workspace service 的公开 receipt。
2. receipt 来自 workspace service ledger 的公开投影；其 exact 字段为
   `schemaVersion`, `workspaceId`, `leaseId`, `owner`, `originRoot`,
   `requestedCwd`, `originRef`, `baseCommit`, `path`, `dispatchCwd`,
   `branchRef`, `state`, `run`, `disposition`, `cleanupDebt`。
3. Host 调用 inspection adapter，再调用 release/preserve adapter；该 adapter
   返回同一 managed service 的公开 preserved receipt。
4. 首偏离位于 `production-runtime-host.ts`：旧 adapter 把 lease 当作私有
   ledger lease，使用 `sha(lease.ownerToken)` 绑定 request 和 receipt，而不是
   使用公开 `leaseId`（owner digest）及完整 `owner` identity。

## 私有边界和修复约束

`ownerToken` 只属于 workspace service 私有 ledger/action 授权；不得出现在
public receipt、Goal event、fixture helper 或 Host 输出中，Host 也不得由
`leaseId` 推导 token。Host 应验证 public receipt 的 `leaseId`、`workspaceId`、
`owner.kind/goalId/taskId/attempt/executionRevision` 和 workspace identity；任一
缺失或漂移均 fail closed。修复使用既有 `publicManagedWorkspaceReceipt` 校验公开
shape，并仅在 Host adapter 本地保留 stateRoot/Goal lookup 元数据。
