# Goal workspace terminal adapter 缺口

## 现象

`planned.v1` 的已结算 Executor 工作区在调用 ManagedWorkspaceService 时，需要把持久化的官方 Executor proof 转换为服务的 `terminalProof`。若 origin 在结算后变脏，服务快照会把 `origin-dirty` 放入 `blockedReasons`；若仍继续申请并执行 integrate，则会在通用的 terminal/snapshot gate 被拒绝，丢失专用的 origin preflight 语义。

## 原因

Goal 侧必须只使用结算时已验证并持久化的官方 proof（`proofId` 作为 `proofHash`），并从服务返回的 canonical receipt/snapshot 判断可处置性。不得从 status、日志或调用方数据重建 proof，也不得使用 legacy workspace phase/released 字段。

## 修复

保留唯一 Goal→service terminal adapter，并在 integrate 前读取 ManagedWorkspaceService 的 canonical snapshot：

- clean、已观察且无冲突的官方 proof 保持允许 integrate；
- `origin-dirty` 在写入 disposition intent 前映射为 `MANAGED_WORKSPACE_ORIGIN_DIRTY` preflight；
- missing/conflicting proof 仍交给严格的 service eligibility 拒绝；
- failed/blocked 工作区的 discard/preserve 语义不放宽。

## 回归覆盖

bounded public `planned.v1 dispatch → bind → settle → integrate` 覆盖 proof 形状和 clean integrate；同构 dirty-origin 流程覆盖专用 preflight，且断言不会写入 disposition intent。
