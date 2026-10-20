# T25A：workspace 严格 schema 与 durable prepare/apply

## 实现

- 新增 `packages/pi-subagents-enhanced/src/workspace/disposition-contract.ts`：`workspace-disposition-prepare.v1` 严格子格式（顶层 ledger 格式不变，旧六字段 pendingAction 仍按原 exact schema 可读）。
- `ledger.ts` 支持该子格式识别与 binding 校验；`service.ts` 新增 `prepareOwnedDisposition`、`readPreparedDisposition`、`applyPreparedDisposition`、`listPreparedDispositions`、`markDispositionSettled`。
- 一次 CAS 内消费授权并写入精确 binding/HEAD/proof/`disposing`，阶段推进 `prepared → effect-committed → settled`；`coordinator-ledger.ts` 在 rename 后 fsync 目录。
- prepare 字段：`schemaVersion,settlementId,operation,reason,binding,authorizedRevision,snapshotHash,proofHash,executorHead,phase,workspaceReceiptRef,queueReceiptRef`；binding 含 `workspaceId,leaseId,rootSessionId,runId,asyncDir,queueItemId,queueLeaseId,queueRevision,admissionGeneration`。

## 证据与状态

- 合同静态核对见 `workspace-disposition-contract.md`；root/package typecheck exit 0；既有 workspace/queue 组合 69/69 exit 0（覆盖 legacy dispose 与发布链，不覆盖新 prepare/apply）。
- 状态 **local-fix-ready**：`test/**` 中没有任何文件引用 `prepareOwnedDisposition`/`readPreparedDisposition`/`applyPreparedDisposition`/`listPreparedDispositions`/`markDispositionSettled`，故障窗口 `after-workspace-prepare`（`service.ts:743`）、`after-workspace-git-before-commit`（`:762`）、`after-workspace-effect`（`:771`）零行为覆盖。详见 `settlement-window-audit.md`。

## 边界

新增用例需用户明确授权；不得借既有文件创建未授权 case，也不得用旧发布窗口通过冒充新窗口验证。
