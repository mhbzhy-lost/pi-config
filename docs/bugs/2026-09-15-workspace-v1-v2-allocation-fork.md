# Workspace 分配 v1/v2 分叉：真实 Auto Integration 路径漏切 V2 创建入口

- 日期：2026-09-15
- 状态：已修复 + v1 全删收尾（pi0851-v1-purge，2026-09-15）
- 诊断依据：`docs/audits/2026-09-15-proof-settle-replay-diagnosis.md`（R10 现场实证）

## 现象

R10 合并队列验收现场：集成主链全通（queue completed、integration receipt 已写），但 terminal proof 永久停在 outbox `pending`，公共验收 `public-audit-settlement` 失败。磁盘 ledger `records/<workspaceId>.json` 为 `managed-workspace-ledger.v1`。

## 根因

v2 ledger 于 2026-09-11（767fe3f）引入，演进设计是"读双格式兼容、写逐步切 v2"。但真实分配路径没有切换：

- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 的 `standaloneWorkspaceRequest` 调用 v1 创建入口 `createManagedWorkspaceRequest`（`mode` + `writePaths` 形态）。
- 该函数同时服务两条链，即真实分叉的全部调用点：
  1. coding 链：`executeCoding` → `standaloneWorkspaceRequest({ kind: "coding", ... })`（Auto Integration 主链）；
  2. generic 链：`executeGeneric` → `standaloneWorkspaceRequest({ kind: "generic", ... })`。
- 结果：真实 Host 分配一律产生 v1 ledger，而所有 v2 沉淀测试（`subagent-auto-integration-real-git`、`managed-workspace-lifecycle-contract` 等）用 `createManagedWorkspaceRequestV2` 手工构造 v2——形成"测试 v2、真实 v1"分叉。

v1 ledger 无法结算 proof 是确定性阻断（与 queue 完成时序无关）：

- `service.ts` v1 `proofValue` 只接受三字段 `{state,conflict,proofHash}`，而 Root Broker runtime 生成的官方 proof 是七字段（无 proofHash）；
- `statusOwned` 对 active v1 走 v1 `resolveProof` 必然按 v1 形态拒绝七字段 proof；
- 处置链 `issueAction`/`discardOwned` 仅 v2（`consumeV2Action`）。

因此 `deliverTerminalProof`（`coordinator-server.ts`）在 v1 workspace 上永远失败，重放也只能把 proof 留在 pending。

## 修复方式（方案 B，现已收束为 V2-only）

- 创建端统一 V2：`standaloneWorkspaceRequest` 改用 `createManagedWorkspaceRequestV2`，`mode/writePaths` 语义映射为 v2 `policy`：
  - coding：`policy = { publication: "allowed", application: "allowed", writePaths: <contract boundaries.writePaths> }`（child-owned 集成 + publish/apply 权限，与既有 v2 沉淀测试约定一致）；
  - generic：`policy = { publication: "forbidden", application: "forbidden", writePaths: [] }`（不可发布、不可应用的只读 workspace 语义）。
- V2-only 收束：删除 v1 创建入口、v1 record/receipt/proof 读写分支与 v1 兼容 shim；唯一 workspace ledger、request、receipt 和 proof 形态为 V2。
- 不实现 v1 兼容结算分支、不自动迁移或读取存量 v1；发现 v1 记录时 fail closed，由人工清理失败现场。

## TDD 证据

- RED：`test/subagent-managed-worktree.integration.mjs` 新增真实分配断言 ledger `schemaVersion === "managed-workspace-ledger.v2"`（coding+generic），当前为 v1 失败。
- RED：`test/subagent-auto-integration-real-git.integration.mjs` 扩展非 LLM wiring：真实 dispatch 分配即 v2，proof 先 pending（queue 未完成前投递被拒、outbox 无 receipt），集成完成后同一 proof 结算 receipts、workspace released、audit 全绿——当前 v1 下失败。
- GREEN：切换 `standaloneWorkspaceRequest` 到 V2 入口后全绿。

## v1 清理结果与失败现场处置

- 不保留存量 v1 migration/read compatibility：`managed-workspace-ledger.v1`、v1 request/receipt/proof codec 以及对应 service/ledger 分支均已删除；v1 record 不再是受支持输入，遇到时 fail closed。
- 已失败的 v1 验收现场（例如 R10 之前产生的临时目录）按失败现场保留规则处理，不通过 production 兼容逻辑恢复；最终由人工按现场处置流程清理。
- Goal ticket、Host terminal proof projection、workspace administration 均已统一 V2；`subagent_worktree` 的 root-side integrate 在 V2 下继续由 child-owned integration 队列拒绝。

## v1 全删收尾（pi0851-v1-purge）

用户指令：v1 全删含读兼容，单机仓库不做平滑迁移。上述 debt 1–4 全部收束：唯一创建/读/管理形态是 v2。

### 删除清单（production）

- `contract.ts`：删除 v1 request codec（`createManagedWorkspaceRequest`、`REQUEST_KEYS`、`MODES`、mode-conditional `writePaths`）与 v1 receipt codec（`validateManagedWorkspaceReceipt`、`publicManagedWorkspaceReceipt`、`RECEIPT_KEYS`）；`createManagedWorkspaceRequestV2` 保留原名作为唯一创建入口（supervisor 批准不重命名）。
- `ledger.ts`：删除 `RECORD_SCHEMA_V1`/v1 keys/`withIntegrationFields` 读兼容 backfill/`receiptFields`/`managedWorkspaceReceiptFromRecord`；envelope 只接受 v2；`requestPlan`/`reserve` 恒 v2。
- `service.ts`：删除 `isV2`、`v1ProofFromV2Projection` 降维、`proofValue` 三字段分支、`inspectStatus`（v1 状态路径）与 `statusForLease` 的 v1 分支（唯一 status 形态即原 v2 语义）；receipt 投影恒 v2；`recoverDisposition` 的 integrate 分支删除（v2 下 root integrate 不可达，由 child 队列拥有）；`dispose integrate` 对 `policy.publication === "allowed"` 恒 `CHILD_OWNS_INTEGRATION`；goal-ticket（executeCoding）切换 `createManagedWorkspaceRequestV2`，ticket 需携带 `policy`。
- `git-worktree.ts`：request 类型仅 policy 形态；`rebaseCandidateFacts`/`fastForwardManagedGitWorkspace` 直接消费 `policy.writePaths`；删除 `integrateManagedGitWorkspace`/`managedWorkspaceAlreadyIntegrated`（root 侧 cherry-pick/merge integrate 随 v1 处置链删除）。
- `administration.ts`：inventory receipt/intent 投影恒 v2（父会话补齐 receipt 缺失的 `terminalProof` 投影）。
- `extensions/subagent-runtime.ts`：`projectManagedWorkspaceTerminalProof` 仅接受 `root-broker.execution-proof.v2` envelope（七字段投影或 terminal null 的 pending）；v1 三字段 facade 形态 fail closed。
- 删除 `src/workspace/child-integration-git.ts`（policy→writePaths 兼容 shim）；service 直接消费 `managedGitRebase`。
- `completion-reminder.ts`：删除死代码 v1 `receipt.mode` 读。

### V2-only 收束暴露的潜在缺陷（RED→GREEN）

- `issueReleaseForLease` 写入 `snapshotHash: null` 的 release challenge，而 `validateActionChallenge` 要求 hex——v1 记录走早退分支从未触发，v2-only 后 administration `applyManagedWorkspaceCleanup` 立即 MANAGED_WORKSPACE_SCHEMA。RED 证据：`managed-workspace-service.integration.mjs` 两个 administration 测试失败；修复：release-only challenge 允许 `snapshotHash: null`（disposition challenge 仍要求 hex）。

### 删除的 v1 专属测试清单

- `test/managed-workspace-v1-replay.test.mjs`：整文件删除（v1 golden replay、v1 record 字节级重放、v1 三字段 proof status、v1 frozen disposition 语义）。
- `test/managed-workspace-lifecycle-contract.test.mjs`：删除「keeps a v1 lease on frozen dispositions without publish or apply authority」（纯 v1 冻结处置断言）。
- `test/managed-workspace-contract.test.mjs`：删除 v1 request codec 测试（mode/writePaths 形态、mode 不变量）与 v1 receipt codec 测试（`validateManagedWorkspaceReceipt`/`publicManagedWorkspaceReceipt`/disposition/cleanupDebt 判别）；改为「the v1 codec surface is fully removed」+ V2 构造的 owner/字段拒绝测试。
- `test/subagent-runtime-membrane.test.mjs`：删除「projects a production rich observed snapshot to the strict codec」（v1 三字段投影正向断言）；「preserves an observed broker conflict」「rejects malformed observed broker snapshots」改 v2 envelope 构造，并新增 v1 facade 形态 fail closed 断言；pending 测试改用 v2 envelope `terminal: null`。

### v1 语义测试改写（保留行为意图）

- `managed-workspace-service.integration.mjs`：「unbound allocation orphan disposes without terminal proof」→「unbound allocation orphans clean up through preserve and release without a terminal proof」（V2 下 discard 需与 run 绑定的 observed proof，无证明孤儿清理路径是 preserve→release）；「integration accepts a clean forward origin and enforces rename writePaths」→「root-side integrate is child-owned and queue admission enforces writePaths on renames」（root integrate 恒 CHILD_OWNS_INTEGRATION，rename 源/目的地 writePaths 约束在 `integrationAdmissionFacts` 队列 admission 执行）；「ordinary untracked files still block destructive disposition」→ dirty workspace 的 discard 经 git worktree remove fail closed 落 cleanup-debt（不静默销毁，断言工作区存活 + cleanup-debt）。
- 全部 v1 mode/writePaths 构造改 V2 policy 构造（service/ledger/queue/multi-root/worktree-lifecycle/action-token/dispatch-extension/membrane/managed-child-rebase）。

### 顺带修复（前序 T10 stale test expectation）

- `test/subagent-workspace-tool.test.mjs`「child integration tool exposes five actions」断言 5 个 action，而 production `child-extensions/integration-queue.ts`（与 HEAD 一致）已稳定暴露 8 个；该断言来自前序任务未提交的 +63 行测试新增，与 v1 无关。经 supervisor 批准同步为 8 action 并补齐 `inspect_integration_state`/`prepare_auto_integration`/`inspect_auto_integration` 三个 coordinator mock；production 未动。

### 新增测试（v1 拒绝 RED→GREEN）

- `test/managed-workspace-ledger.test.mjs`：「v1 creation entry is removed and the v1 request shape is rejected」（RED：v1 codec 存在且 reserve 接受 mode/writePaths）、「v1 record read compatibility is removed」（RED：手工构造的合法 v1 durable record 可正常 load）。

### 未验证范围

- 未跑真实 LLM probe 与全量 npm test（任务排除）；`test/subagent-delegation-workspace.e2e.mjs` 构造已是 V2、不在 v1 消费扫描清单内，未单跑。
