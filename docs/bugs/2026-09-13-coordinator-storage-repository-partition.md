# Coordinator durable storage repository 分区

## 只读诊断结论

`repositoryId` 是 `SHA256(commonDir)`，继续用于 protocol、auth、registry、endpoint 与 challenge；durable workspace records、integration queue、terminal proof outbox 应统一使用 `storageRepositoryId = SHA256(canonical originRoot)`。旧 common-dir-hash bucket 不自动移动、合并或删除，仅在 audit 中保留 migration debt/inventory 记录。

## Production 可达调用链

public runtime 创建 workspace → coordinator server workspace service / ledger；child integration → Root Broker → coordinator server → integration queue；terminal proof → coordinator proof outbox。当前 queue/outbox 使用 common-dir repositoryId，造成 linked worktree 与 main worktree 的 durable partition 混用。具体 socket 窗口不作未经验证的确定断言。

## Provenance 更新

已确认的首个身份偏离点是 workspace service/ledger 创建时未贯穿 `storageRepositoryId`，导致 records 可能回落到 origin hash，而 queue/proof 使用显式 storage hash。common-dir `repositoryId` 仍保留在 protocol、challenge、registry 与 endpoint metadata；旧 bucket 仅作为 audit migration debt。
