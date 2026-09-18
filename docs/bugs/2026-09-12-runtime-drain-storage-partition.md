# Runtime drain 与 storage partition 根因记录

## 已确认事实

第九次真实现场中，首次 `enqueueIntegration` 返回 `BROKER_DISCONNECTED`；同时 public audit 显示 workspace records/worktrees 与 integration queue、terminal proof outbox 位于不同 repository bucket。当前调用链中 `beforeRuntimeDispose` 原先关闭 coordinator runtime 后才关闭 Root Broker；而 workspace ledger 默认按 `SHA256(canonical originRoot)` 建立 records，queue/proof 已按显式 storage identity 建立，调用方若未继续传递该 identity 会产生分区不一致。

## 来源尚未证实的细节

现场日志没有证明具体 socket write 与 teardown 的精确时间窗口，也没有证明每次失败都由单一线程竞态造成。以下修复仅针对已确认的关闭顺序与身份传递，不推断未观测的调度细节。

## 修复约束

Root Broker 在 coordinator client/server 关闭前等待在途 integration、run drain 与 proof delivery；等待有界，超时形成可观察 debt。`repositoryId` 继续绑定 common-dir 协议、challenge 和 metadata；records、queue、proof outbox 统一使用 canonical main worktree 的 `storageRepositoryId`。旧 bucket 只审计，不自动搬迁或删除。
