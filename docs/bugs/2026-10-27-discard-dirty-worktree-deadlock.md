# managed workspace discard 对 dirty worktree 死锁

日期：2026-10-27。状态：源码与既有测试已修复并通过验证；真实卡住工作区需 Host 重启后由 settlement replay 自动收尾（本任务未触碰现场）。

**归类：预期 production 数据未被正确处理。** 现场是真实受管工作区（`183f86ee-d4b9-482d-a5fc-1038e42d9623`）在用户已授权 discard、action token 与参数校验均通过后的结算路径，不是 fixture、不是伪造 ledger、也不是调用方参数错误。受管 worktree 中正常的未提交修改（工作区自身产物）被底层 Git 的非强制删除拒绝对待，导致授权回收永远无法完成；数据本身（5 个已修改 tracked 文件）属于预期 production 数据，其处置方式与既有“未跟踪用户文件保护”合同混在一起，未被正确区分处理。

## 现场（由主会话定位，本任务只读采纳，未访问该工作区）

- ledger：`state=disposing`，`pendingAction` 为 prepared，`phase=prepared`；discard 已获用户授权且 action token 校验通过。
- worktree：5 个未提交修改（`M src/background-activity/*.ts`、`M test/*.mjs`），无记录的未跟踪用户文件。
- 失败点：`git worktree remove` 未带 `--force`，Git 拒绝删除，错误归为 `MANAGED_WORKSPACE_GIT category=dirty-worktree`。
- 后果：`discardForLease` / `recoverDisposition` / `applyPreparedDisposition` 的 catch 统一走 `markDebt`，工作区卡在 cleanup-debt / disposing，settlement replay 每次重试都复现同一条 Git 拒绝，形成死锁。

## 根因链

1. `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts` 的 `releaseManagedGitWorkspace` 固定执行 `["worktree", "remove", record.path]`（修复前 :492），没有 `--force`。
2. 该函数的所有调用方都已是显式销毁/回收授权路径：`service.ts:489` `discardForLease`、`:548` `recoverDisposition`（非 preserve）、`:643` `releaseForLease`（preserved/cleanup-debt 终局回收）、`:760` `applyPreparedDisposition`（coordinator 结算，非 preserve）。正常 coding run 把成果提交到 `pi-managed/<id>` 后 worktree 是干净的，非强制删除也能成功，因此缺陷长期未被发现。
3. 一旦工作区遗留未提交修改（本现场即 5 个 tracked 文件），非强制 `git worktree remove` 永久失败，授权 discard 永远走不到终态。这是设计缺陷，不是 Git 环境问题。
4. 语义不一致：同一函数紧接着对受管分支使用 `branch -D`（强删），说明回收语义本意就是销毁授权，唯独 worktree 删除缺少对应强度。
5. 不能一刀切：既有用例 `test/managed-workspace-service.integration.mjs:338`（767fe3f2 引入、f91d520c 扩展）明确编码“非 runtime 的未跟踪用户文件不得被 discard 静默销毁，必须 fail closed 为 cleanup-debt”。该合同保护的是用户数据，不适用于 tracked 文件的未提交修改。因此修复必须分级。

## 最小修复（分级 force）

`packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`：

- `releaseManagedGitWorkspace` 的移除改为 `["worktree", "remove", "--force", record.path]`（单层 force；不使用 `--force --force`）。
- 新增 `untrackedUserFiles()` 预检（:159）：用只读的 `git ls-files --others --exclude-standard -z` 收集未跟踪文件，排除 `.pi`、`.pi-subagents`、`.state/subagent-dispatch`、`.state/worktree-lifecycle` 与 `RUNTIME_METADATA_ROOTS`（与 `userStatus` 的排除口径一致，runtime 元数据不算用户数据）。
- 若预检命中未跟踪用户文件，则在 `worktree remove` 之前抛 `MANAGED_WORKSPACE_GIT`，错误文案包含既有合同句 `a dirty workspace must never be silently destroyed by discard`，`detail.category=untracked-files`，由 service 的 `markDebt` 落 `cleanup-debt`；即 :338 合同原样保留。
- 保留未变：`pathExists`/registration 一致性检查、`expectedHead` 校验、`removeUntrackedRuntimeMetadata` 调用、失败时的 `classifyGitFailure` 分类路径、`branch -D` 逻辑。
- 行为差异只有一处：仅含 tracked 未提交修改（M/重命名等）的 worktree 现在可被授权 discard/release 强制回收；未跟踪用户文件仍 fail closed。dirty submodule、unmerged 等残余失败继续交给 Git 失败后的既有分类上报。
- `service.ts` 未改动：force 内聚在 release 函数内，四个调用方无需传参，行为对外不可见。

## 测试适配（未新增文件、未新增用例）

`test/managed-workspace-service.integration.mjs` 的既有 discard 用例（`discard succeeds with tracked .pi/agents project config…`，原 :141 断言 released 且 worktree 删除）在 dispose 前把 tracked 的 `.pi/agents/executor.md` 改成带未提交修改，并断言 `git status --porcelain` 非空；dirty 必须在 `issueDisposition` 之前制造，否则 snapshotHash 会漂移而先被 CAS 拒绝。原断言（`state=released`、worktree 被删除）不变。

`:338`（untracked 必须 fail closed）未做任何修改。

## 验证证据

| 命令 | 结果 |
|---|---|
| `node --test test/managed-workspace-service.integration.mjs test/workspace-operation-tools.test.mjs test/managed-workspace-git-diagnostics.test.mjs` | 35 tests / 35 pass / 0 fail（含改造后的 discard M 场景与 :338 untracked fail-closed 合同） |
| `node --test test/managed-workspace-contract.test.mjs test/managed-workspace-ledger.integration.mjs test/subagent-managed-worktree.integration.mjs test/workspace-disposition-settlement.integration.mjs` | 28 tests / 28 pass / 0 fail（含七个 settlement 故障窗口重启幂等收敛） |
| `npm run typecheck`（`typecheck:root` + `typecheck:subagents-enhanced`） | 两段 `tsc --noEmit` 均通过 |

关键通过项：`ordinary untracked files still block destructive workspace disposition and fail closed as cleanup debt`、`runtime metadata does not dirty or block release of a managed workspace`、`discard succeeds with tracked .pi/agents project config…`、`七个新增 settlement 故障窗口在重启后幂等收敛`。

## 当前卡住 ledger 的收尾（需 Host 重启）

本次修复只改代码，不会自愈已在运行进程内的卡住记录。真实卡住工作区 `183f86ee-d4b9-482d-a5fc-1038e42d9623` 仍是 `disposing/prepared`，需要用户重启 Host 后由启动恢复补完：

1. `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:568` `finishStartupRecovery()` 调用 `dispositionSettlement?.replay()`（:570）。
2. `packages/pi-subagents-enhanced/src/workspace/disposition-settlement.ts` 的 `replay()` 收集 `integrationQueue.listDispositionIntents()` 中未 settled 的 prepared 与 `workspaceService.listPreparedDispositions()` 中已 durable 但 coordinator 尚未写 intent 的 prepared，逐个 `settlePrepared`。
3. `settlePrepared` 复核 prepare 与真实 binding 身份一致后，依次 `recordDispositionIntent` → `applyPreparedDisposition`（内部调用 `releaseManagedGitWorkspace`，现带 `--force`）→ `advanceDispositionIntent` → `settleDispositionQueue` → `markDispositionSettled`，最终 `state=released`、`pendingAction.phase=settled`、队列写 `qsr-<settlementId>` receipt。
4. 幂等性：每个 phase 都可重放，`intent.phase === "settled"` 时直接 `markDispositionSettled`；`after-workspace-git-before-commit`、`after-queue-settlement` 等故障窗口已由既有 settlement 集成测试覆盖。

## 局限

1. **未在真实现场验证。** 本任务按授权边界未读写 `var/workspaces` 下的真实工作区、未发任何 managed workspace / subagent 控制请求、未重启 Host。收尾是否成功需用户重启后观察。
2. 若 `183f86ee` 除 5 个 `M` 文件外还残留非 runtime 的未跟踪用户文件（`??`），新预检会再次 fail closed，重启后仍会停在 `cleanup-debt`，需要人工确认/备份后再处置。主会话记录的现场只有 5 个 tracked 修改，按此预计可顺利回收。
3. 单层 `--force` 不覆盖 dirty submodule（Git 需要 `--force --force` 才删干净 submodule 工作树）。此类现场仍会失败并走既有分类上报，本次刻意不放宽以保留可诊断性。
4. `replay()` 只在 Host 启动路径执行，运行中的进程内不会自动触发；必须有重启动作。
5. 预检使用 `--exclude-standard`：被 `.gitignore` 忽略的文件不阻止删除，随 worktree 一起销毁。这是既有行为（忽略项归 `ignored-runtime-artifacts`），本次未改变。
6. discard 语义仍是“全丢”：修复只区分 tracked 修改与未跟踪用户文件，不提供部分保留或自动备份。
