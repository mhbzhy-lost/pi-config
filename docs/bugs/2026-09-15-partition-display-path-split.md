# Workspace 分区身份 display-path 分叉与 settlement 死锁

- 日期：2026-09-15
- 发现场景：repository merge queue 单 child 真实验收（R12h，现场 `repository-merge-queue-acceptance-QwpTd9`）probe 在 `public-audit-settlement` 阶段超时，但磁盘四件套（queue completed、integration receipt、terminal proof observed、workspace released）全部达成。

## 现象

- probe `readPublicAudit` 的 `inventory.workspaces` 恒为空：`isAcceptanceAuditSettled` 因 `workspaces.length !== expectedCount` 永不满足。
- 手工以正确环境（`PI_CODING_WORKSPACE_DIR=$STATE/state/workspaces`、cwd=验收仓库）复跑 `worktree-lifecycle audit --json`，同样得到空 inventory、`debts: [{kind:"coordinator-singleton",status:"dead"}]`。
- 磁盘真相：`state/workspaces/repositories/05688bf6…/records/048c7214….json` 存在，V2 record `state=released`、`terminalProof.state=observed`、`conflict=false`；queue item `state=completed` 且全字段齐备。

## 根因

### 缺陷 1（production）：storageRepositoryId 哈希了 display-path 而非 canonical realpath

`resolveRepositoryIdentity`（`src/workspace/repository-identity.ts`）：

1. `realCwd = realpath(cwd)`（物理路径）；
2. `git worktree list --porcelain` 在物理 cwd 下报告物理路径 `/private/var/folders/…/repository`；
3. `displayPath()` 在 darwin 上把 `/private/var/…` 剥成 `/var/…`（本意是给人类看的展示形态）；
4. `storageRepositoryId = hash(displayPath(mainWorktree))`。

而 ledger 侧 `canonicalOrigin = realpathSync`，`repositoryId(originRoot) = hash(realpath(originRoot))`，audit 的 `inventoryManagedWorkspaces` → `ledger.list({originRoot})` → `managedWorkspacePaths` 也走 realpath。于是：

- 写入分区 = `sha256("/var/folders/…")` = `05688bf6…`
- audit 推导分区 = `sha256("/private/var/folders/…")` = `9d7feeaa…`

同一 clone 因路径表示不同得到两个 storage partition，直接违反计划 T2 验收标准“同一 clone 的主 worktree 得到同一 canonical storage partition”。macOS `os.tmpdir()` 返回 `/var/folders/…`（`/var` → `/private/var` 符号链接），因此所有位于 tmpdir 的真实验收场景必现；不在 symlink 路径下的既有测试（`assert.equal(main.originRoot, f.origin)`）从未暴露。

`legacyStorageRepositoryId = hash(topLevel)` 同样哈希 display 形态，识别旧分区时也会算错目录。

### 缺陷 2（harness）：settlement 不接受 daemon 正常 idle-exit 的伴生 debt

`administration.ts` 在 coordinator metadata 存在但 pid 已死时，同时置 `coordinator.status = "stale"` 并 push `debts: [{kind:"coordinator-singleton", status:"dead"}]`。R12g 修复只让 settlement 接受 `status ∈ {observed, stale}`，没有接受这条必然伴随的 debt；`isAcceptanceAuditSettled` 仍要求 `debts.length === 0`。队列结算发生在所有 root/child 退出、daemon idle-exit 之后，因此即使缺陷 1 修复，settlement 仍会因这条 debt 死锁。

## 分类

缺陷 1 属于**预期 production 数据未被正确处理**：数据由合法 public/typed 入口（真实 dispatch → coordinator → ledger）产生，身份/时间/资源事实有效；按生产缺陷处理（本记录 + 精确 RED + 最小修复）。缺陷 2 是验收 harness 的判定缺陷，只改 probe 与其合同测试。

## 修复

1. `repository-identity.ts`：所有身份哈希一律基于 realpath 物理形态——`storageRepositoryId = hash(realpath(mainWorktree))`，`legacyStorageRepositoryId = hash(realpath(topLevel))`；`displayPath` 只保留给人类可读展示，不参与身份。`originRoot` 返回值维持 display 形态（既有测试与人类可读性依赖；ledger reserve 时本就会 canonicalize）。
2. probe `isAcceptanceAuditSettled`：接受且仅接受 `coordinator.status === "stale"` 且 debts 恰为 `[{kind:"coordinator-singleton",status:"dead"}]` 的正常 idle-exit 终态；其余任何 debt 仍然拒绝。

## RED→GREEN

- RED 1：`test/managed-workspace-repository-identity.integration.mjs` 新增断言 `storageRepositoryId === sha256(realpath(originRoot))` 且与 ledger `managedWorkspacePaths` 推导的分区一致（darwin tmpdir 下当前失败）。
- RED 2：`test/repository-merge-queue-acceptance-probe.test.mjs` 新增断言 stale+singleton-dead 且四件套齐备的 audit 判定为 settled（当前失败）。
- GREEN：上述修复后两个 RED 转绿，聚焦测试零回归；随后复跑单 child 真实验收。
