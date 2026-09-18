# Repository Coordinator 迁移审计

## 范围与来源链

本审计覆盖 `repository-workspace-coordinator.v1`、`managed-workspace-ledger.v2` 与
`workspace-integration-queue-item.v1`。事实来源依次为 Git common-dir 与 canonical
main worktree、coordinator metadata、workspace ledger、integration queue、terminal
proof/delivery outbox；admin audit 只读，不启动 daemon、不申请 lease、不执行 Git 清理。

## 分类与保留项

- canonical main ledger partition：原地接管并继续使用，不复制或合并。
- linked worktree 的旧 partition：标记 `legacy-linked-worktree-ledger-partition`，保留原记录。
- 请求声明了不同 state root：标记 `state-root-split-brain`，不迁移文件。
- 未知 schema、无法解释的 active/disposing、缺少 authoritative proof：标记 migration/proof debt，保留为 preserved 或原状态。
- queue CAS、proof、delivery、cleanup debt：仅供 doctor 报告，等待人工处理。

## 人工处置

先使用 `node scripts/worktree-lifecycle.ts audit --json` 保存审计结果；确认 workspace
lease、proof 与 Git inspection 后，使用 `node scripts/worktree-lifecycle.ts reconcile
--apply --authorization-stdin`，stdin 必须包含当前 plan 及逐项 public lease
`{workspaceId, leaseId}`。禁止使用本机 UID、CLI 身份或 owner scope 推导授权。

本文件不记录 session 正文、凭据、provider 配置或模型参数。
