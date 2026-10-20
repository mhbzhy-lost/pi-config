# Workspace disposition 当前实现合同

## 版本与公开边界

使用 `managed-workspace-ledger.v2` 既有顶层字段，扩展 pendingAction 为严格 `workspace-disposition-prepare.v1` 子格式。公开模型只提交 workspace/action/token，owner 由 Host 会话注入；proof 来自可信 broker callback 或已记录 proof。无新增模型权限、raw integrate 或 child capability。

## Durable prepare

`prepareOwnedDisposition(input, {settlementId,queueItem})` 在唯一 service 中核对 owner、状态、proof、当前 token/snapshot/允许动作，然后一次 workspace ledger mutation：比较 authorizedRevision，消费 challenge，写 proof、pendingAction 和 disposing。绑定精确包含 workspaceId、leaseId、rootSessionId、runId/asyncDir（unbound 为 null）和 queueItemId/queueLeaseId/queueRevision/admissionGeneration（无 queue 均 null）。

operation 仅 preserve/discard/release；reason 仅 preserve 非空。HEAD 来自准备时实际 inspection，不用可变 authorizedWorkspaceHead 代表 allocation base。旧六字段 pendingAction 仍严格可读；仅持有原 token、同操作/同理由、同 proof 和旧执行 HEAD 才能由 disposing 升级，否则保留现场。

## 效果与回执

- `readPreparedDisposition({workspaceId,ownerScope,settlementId})`：重新从权威 ledger 核对 binding，不把调用者传来的 prepared 对象当授权。
- `applyPreparedDisposition(...)`：检查身份，preserve 再核 HEAD；destructive 按 executorHead 调唯一 Git lifecycle，允许同一已接受准备记录重放删除后未提交 ledger 的窗口。随后 phase=effect-committed，workspaceReceiptRef=`wsr-<settlementId>`。
- `markDispositionSettled({...identity,queueReceiptRef})`：仅 effect-committed 可推进，queueReceiptRef 必须 `qsr-<settlementId>`，标 settled；重复同 receipt 幂等。
- `listPreparedDispositions()`：只扫描当前 repository 分区的未 settled 准备记录，不能跨仓库合并恢复。

## Queue 结算

`createWorkspaceDispositionSettlement({workspaceService,integrationQueue,fault})` 返回 settlePrepared/replay。先重新读 workspace prepare、比对不可变字段，再将 intent 写到既有 integration-queue ledger，阶段 authorized→workspace-committed→queue-committed→settled。

queue 结算前后核对 workspace/lease/run/root、queue lease、revision/admission generation。保留 terminal queue 状态；非 terminal preserve→preserved，明确 discard/release→cancelled，不伪造 published/completed。queue 与匹配 active handoff 在同一锁内分别写文件；文件之间不假装原子，崩溃后同 settlementId 补齐。写入回执后关闭 workspace prepare。

coordinator 的普通 dispose/release、recovery discard/release 统一经 prepare→settlePrepared；不存在断线后 local mutation fallback。startup 先 settlement replay，再 proof replay、handoff pump，最后打开 readiness；正常 listen 与 EADDRINUSE stale-socket 重听共用此流程。

## 自动 no-payload

可信 terminal proof 且无冲突、精确 binding、queued 队列项、clean、HEAD=request.baseCommit、descendant=true、aheadCount=0、无 Git sequencer、无 integrationIntent/integrationReceipt 才自动准备 discard。零净 diff 但存在提交不算空交付。公开用户明确授权的 discard 与自动 no-payload 是两条授权来源，不能混用。

## 故障窗口与当前覆盖

新增调用点：after-workspace-prepare、after-workspace-git-before-commit、after-workspace-effect、after-coordinator-intent、after-queue-settlement、before-settlement-receipt、after-settlement-receipt。workspace-only prepare 在 replay 时补建同 settlementId intent，重放不保存或重新索要 raw token。

本合同由当前实现静态核对得出，不是七窗口行为验收。既有 integration publication 四窗口通过只证明原发布链；新增 settlement 七窗口目前未单独行为验证，新增组合测试保留建议待授权，不将其标绿色。
