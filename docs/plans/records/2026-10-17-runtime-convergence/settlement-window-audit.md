# 新增 disposition settlement 故障窗口审计（H3 / T25A–T25C）

本文件是静态审计与覆盖缺口清单，不是行为验收。所有“通过”数字均指既有检查，不外推到新窗口。

## 生产侧注入点

| 窗口 | 位置 | 语义 |
| --- | --- | --- |
| `after-workspace-prepare` | `packages/pi-subagents-enhanced/src/workspace/service.ts:743` | 授权已在同一次 CAS 中消费、`pendingAction` 已写为 prepared、state=disposing 之后 |
| `after-workspace-git-before-commit` | `service.ts:762` | workspace 侧 Git 效果已发生、coordinator/queue 提交之前 |
| `after-workspace-effect` | `service.ts:771` | workspace 效果提交完成、跨账本 intent 之前 |
| `after-coordinator-intent` | `disposition-settlement.ts:23` | coordinator intent 已登记，queue 结算之前 |
| `after-queue-settlement` | `disposition-settlement.ts:28` | queue terminal/handoff 已结算，receipt 之前 |
| `before-settlement-receipt` | `disposition-settlement.ts:29` | receipt 写入之前 |
| `after-settlement-receipt` | `disposition-settlement.ts:31` | receipt 已写入、settle 标记之前 |

注入面：`service.ts:845` 的 `activeFault = options.fault`（service 工厂选项）与 `createWorkspaceDispositionSettlement({ workspaceService, integrationQueue, fault })`。两者都是既有 fault 机制，不需要为验证新增生产分支。

## 既有覆盖的真实边界

| 既有检查 | 实际覆盖 | 不覆盖 |
| --- | --- | --- |
| `test/managed-workspace-integration-queue.integration.mjs`（restart 6/6、crash 6/6） | 发布状态机 `after-prepared`/`after-intent`/`after-merge`/`before-queue-complete`、socket 幂等、admission/rebase/conflict | 新 settlement 七窗口、prepared 子格式、跨账本 receipt/handoff 闭环 |
| `test/managed-workspace-coordinator-recovery.test.mjs`（12/12） | idle shutdown fencing、stale socket 回收、dead daemon admission 重发与旧 lease 拒绝 | disposition prepare/apply/replay、startup barrier 的 mutation 门禁 |
| `test/managed-workspace-service.integration.mjs`、`workspace-operation-tools.test.mjs`、`supervisor-gate-wire.test.mjs`（合计 69/69 组合快照） | legacy dispose 路径、proof 门禁（H2）、public 工具面与 gate wire | 同上 |

静态检索事实：`test/**` 中**没有**任何文件引用 `settleDispositionQueue`、`prepareOwnedDisposition`、`readPreparedDisposition`、`applyPreparedDisposition`、`listPreparedDispositions`、`markDispositionSettled`、`recordDispositionIntent`、`advanceDispositionIntent`、`verifyDispositionBinding`、`finishStartupRecovery`。因此新路径当前只有类型检查与合同文档，没有行为证据。

## 状态判定（2026-10-19 更新）

- T25A/T25B/T25C：已由用户授权新增专项用例并实跑，见下节；不再只有类型检查与合同文档。
- H3 整体：**七个新增故障窗口已有行为证据**；既有 integration crash 四窗口仍只证明旧发布链，不作为替代证据。

## 已授权并实跑的专项用例

用户于 2026-10-19 明确授权新增用例。新增 `test/workspace-disposition-settlement.integration.mjs`（临时 Git origin + 临时 state root + 本地 UNIX socket coordinator；无网络、无真实 provider、无 SIGKILL），实跑结果 **12 tests / 12 pass / 0 fail，exit 0**，日志 `/tmp/rc-settlement-windows-3.log`：

| 覆盖 | 用例 |
| --- | --- |
| 七个故障窗口逐个注入 + 重启 replay 幂等 + Git 副作用不重复 | `七个新增 settlement 故障窗口在重启后幂等收敛，且不重复 Git 副作用`（7 个子测试，preserve/discard 混合，含 queue 与 resume intent 场景） |
| workspace-only prepare（intent 之前崩溃）被扫描发现并补建 intent | `workspace-only prepare（coordinator intent 之前崩溃）由重启扫描发现并补建 intent` |
| startup barrier：恢复未完成时 mutation 返回 `COORDINATOR_RECOVERY_NOT_READY`，只读 `queue.audit` 可用；恢复失败后重试路径收敛一致 | `startup 恢复未完成时 mutation 被拒，只读诊断仍可用` |
| 分区隔离：跨 repository 分区的 prepared 不被其它分区恢复消费 | `跨 repository 分区的 prepared disposition 不被其它分区的启动恢复消费` |
| 不可变字段被篡改时 fail closed，不猜测原意图、不执行 Git 清理 | `durable prepare 的不可变字段被篡改时恢复 fail closed，不猜测原意图` |

断言覆盖的收敛事实：workspace `state`/`pendingAction.phase`（prepared → effect-committed → settled）、`workspaceReceiptRef=wsr-<settlementId>`、`queueReceiptRef=qsr-<settlementId>`、queue 终态（preserve→`preserved`、discard→`cancelled`）与 `dispositionReceiptRef`、resume/handoff intent `completed`、`listPreparedDispositions()` 清空、intent 数量不增（重放幂等）、preserve 保留 worktree+受管分支而 discard 清理两者、origin HEAD 与 clean 状态不变。

## 原建议范围（已全部落地为上表用例）

以下为当初的建议范围，现已按授权实现：

1. 七个窗口逐个注入后调用 `reconcileIntegrations()` / startup recovery，断言：不重复消费授权、不产生第二个 commit、prepared→effect-committed→settled 单调推进、重复 replay 幂等。
2. `after-coordinator-intent` 与 `after-queue-settlement` 之间崩溃后，断言 workspace-only prepare 能被扫描发现并补建 coordinator intent，且不可变字段核对失败时 fail closed。
3. `before/after-settlement-receipt` 断言 queue terminal、handoff、receipt 三者幂等补齐，不出现半写 receipt。
4. startup barrier：恢复未完成时 mutation 返回 `COORDINATOR_RECOVERY_NOT_READY`，读取（status/receipt/audit）可用；恢复完成后正常 listen 与 EADDRINUSE stale-socket 重听结果一致。
5. 分区隔离：跨仓 ledger 不被本次恢复扫描消费。

以上均复用既有 fault 注入与临时 ledger fixture 形态；不需要真实 provider、网络、SIGKILL 或真实 workspace。
