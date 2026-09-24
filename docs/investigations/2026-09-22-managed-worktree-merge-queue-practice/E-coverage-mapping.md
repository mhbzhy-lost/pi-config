# 既有计划/缺陷文档/在途改动与 20 项缺口覆盖度比对

> 只读调查报告。证据来自既有报告、批量提取产物、计划/缺陷文档、git diff/log 与冻结现场；未修改仓库。

## 1. 覆盖度判定总表

判定口径：`已修但复现` 仅用于既有计划/缺陷/commit 明确声称已通过或修复、而冻结 live 现场仍出现的情况；仅有根因记录而没有修复主张的列为 `已诊断未修`。计划勾选统计来自 `/tmp/wt-analysis/reports/coverage_targets.json`：lifecycle-overall 9/60，merge-queue 107/113，durable-fifo 38/38，five-child 27/27，orphan-recovery 0/40，unified-harness 62/74。

| 缺口编号 | 判定分类 | 既有计划(Task+勾选状态) | 既有 bug 文档 | 在途改动 | 证据(路径:行号) | 新计划应如何处理 |
|---|---|---|---|---|---|---|
| B1 | 已修但复现 | unified-harness generic/IR 任务已勾选；merge-queue Task 5/7 已勾选 | `docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md` 等记录了历史验证；无 canonical `dispatch-ir` 修复记录 | 无针对 canonical `contracts/dispatch-ir.ts` 的 diff；孤儿 `src/subagent-dispatch/ir.ts` 仍存在 | `00-INTEGRATED-runtime-gap-report.md:79-116`；`contracts/dispatch-ir.ts:168`；`subagent-dispatch/ir.ts:210-212`；`b332005` | 仅需回归验证 |
| B2 | 已修但复现 | unified-harness public schema/adapter 任务已勾选（其验收列为 PASS）；lifecycle P3-T6 未勾选 | `docs/bugs/bug-caller-followup-exact-schema-red-stops-at-first-case.md` 记录 schema RED；`2026-09-14-glm-empty-tool-args-from-root-union-schema.md` 记录根级 union 限制 | `extension.ts` 在途只移除 `task.maxLength`，没有补根 `required`、分支互斥或 coding/generic 字段隔离 | `00-INTEGRATED-runtime-gap-report.md:117-137`；`extension.ts:44-159`（工作树）；`git show HEAD:.../extension.ts:44-159`（HEAD） | 仅需回归验证 |
| B3 | 已修但复现 | merge-queue Task 10/11 验收均已勾选，但剩余真实五-child 验收未勾；five-child Task 3 已勾选 | `2026-09-16-coordinator-sync-git-admission-blocking.md:8-42`；`2026-09-17-premature-enqueue-freezes-base-authorized-head.md:5-27`；`2026-09-13-real-runtime-enqueue-disconnect.md:3-21` | queue/coordinator 相关文件不在当前 `git diff`；仅 root broker 在途变更，未接通 claim worker | `integration-queue/0ed45c9b...json`（state=queued, admissionGeneration=0, revision=3）；`queue-meta.json`（nextSequence=2）；`terminal-proofs.json`（5 observed, receipts={}）；`integration-queue.ts:235-242`；`00-INTEGRATED-runtime-gap-report.md:138-159` | 仅需回归验证 |
| B4 | 已修但复现 | merge-queue Task 11 验收声称 recover/retry/discard/release 与 cleanup debt 可用；lifecycle-overall P2/P4 尚未勾选 | `docs/bugs/2026-09-12-subagent-worktree-lifecycle-broken.md:97-112,193-200`；`bug-managed-worktree-reclaimable-head-cannot-be-safely-reanchored.md:5-7` | `service.ts`、workspace tool 未在当前 diff；当前在途没有 cleanup-debt agent action 或 trusted continuation | `2026-09-12-pi-0851-repository-merge-queue.md:922-955`；`workspace/service.ts:576-617,639-680`；`workspace/coordinator-protocol.ts:74-85`；`00-INTEGRATED-runtime-gap-report.md:160-166` | 仅需回归验证 |
| H1 | 已诊断未修 | unified-harness Git/recovery 任务已勾选；没有针对 bounded stderr 的未勾选任务 | `docs/bugs/2026-09-12-subagent-worktree-lifecycle-broken.md:30-32` 明确指出公开错误丢失底层 operation/cause | 无 `git-worktree.ts` 或 workspace error-detail diff | `workspace/git-worktree.ts:44-57,282-286,461-462`；`00-INTEGRATED-runtime-gap-report.md:172-182` | 纳入新计划 |
| H2 | 已修但复现 | unified-harness T6/T7 的 ignored/untracked、artifact identity 与 cleanup 任务已勾选 | `docs/bugs/2026-09-10-workspace-publish-apply-recovery-gap.md` 及相关 workspace 生命周期记录覆盖 cleanup 证据 | 无当前 diff 修复 runtime artifacts 与 worktree remove 的时序 | `00-INTEGRATED-runtime-gap-report.md:43-61,172-182`；现场 worktree `3b8d0a57`：`git status --ignored --untracked-files=all` 显示 `.pi/subagents/artifacts/*_meta.json`、`*_output.md` | 仅需回归验证 |
| H3 | 新缺口 | lifecycle-overall P6-T9 尚未勾选，且用户已决定整体删除 `workflow`；既有 schema 任务勾选不等于删除 | 未找到明确声明删除 `workflow` 的 bug 修复文档 | 当前 `extension.ts` diff 未删 schema/prompt/contract workflow；`dispatch-ir.ts` 与 prompt 仍渲染 Mode | `extension.ts:63-71`；`contracts/dispatch-ir.ts:145-153,259,276-288`；`00-INTEGRATED-runtime-gap-report.md:172-182` | 纳入新计划 |
| H4 | 已规划未执行 | lifecycle-overall P6-T9：0/5 步骤未勾选；unified-harness Skill/ABI 任务已勾选但当前错误仍在 | `bug-subagent-writepaths-rejects-glob-without-schema-hint.md:15-25`（路径文法可发现性） | `SKILL.md` 不在当前 diff；无尾 `/` 文法修订 | `contracts/dispatch-ir.ts:134-136`；`skill-overrides/subagent-dispatch/SKILL.md`；lifecycle-overall `:340-366` | 等待既有计划 P6-T9 完成后再评估 |
| H5 | 已修但复现 | merge-queue Task 7/11 的 reminder/recovery 验收已勾选；five-child 全勾 | `docs/bugs/2026-09-07-subagent-workspace-session-owner-and-completion-reminder.md`；`2026-09-14-child-integration-auto-lifecycle.md:5-19` | `completion-reminder.ts` 不在当前 diff | `workspace/completion-reminder.ts:31-60`（仅监听 `subagent:async-complete`）；`00-INTEGRATED-runtime-gap-report.md:172-182`（5 workspace 仅 3 reminder） | 仅需回归验证 |
| H6 | 已诊断未修 | merge-queue Task 10/11 已勾选，但没有 agent queue-inspect task；lifecycle P6 尚未勾选 | `docs/bugs/2026-09-13-auto-integration-inspect-information-leak.md:6-13,97-131` 明确 inspect 过度/需 allowlist hardening | 无 queue inspect agent tool 的当前 diff | `workspace/coordinator-server.ts:160-184,241-255`；`coordinator-protocol.ts:74-85`；`00-INTEGRATED-runtime-gap-report.md:172-182` | 纳入新计划 |
| H7 | 已规划未执行 | lifecycle-overall P3-T6 控制平面 0/5 未勾选；P4-T7 亦未勾选 | `docs/bugs/2026-08-21-subagent-resume-control-not-exposed.md` | 当前在途 control-plane 文件虽新增，但未覆盖 upstream paused-state cancel/改态合同；不能据 diff 宣称完成 | `00-INTEGRATED-runtime-gap-report.md:172-182`；upstream `pi-subagents@0.62.0/src/extension/rpc.ts:668-680`；`async-resume.ts:467-476,539-560` | 等待既有计划 P3-T6 完成后再评估 |
| H8 | 新缺口 | 6 份既有计划均无模型候选错误面的未勾选任务 | 未找到明确“返回候选清单”的 bug 文档；`bug-subagent-spark-models-unavailable.md` 仅覆盖可用性 | `model-selection.ts` 不在当前 diff | `model-selection.ts:27-33,54-101`；`00-INTEGRATED-runtime-gap-report.md:172-182` | 纳入新计划 |
| H9 | 已诊断未修 | lifecycle-overall P3-T6 尚未勾选；unified-harness dispatch/error 任务已勾选但 taxonomy 仍漂移 | `docs/bugs/2026-09-08-subagent-rpc-diagnostic-options-boundary.md`（诊断边界）；`2026-09-12-subagent-worktree-lifecycle-broken.md:30-32` | `extension.ts` 当前 diff 未改 preflight catch/stage；`errors.ts` 未改 | `extension.ts:1319-1331`；`errors.ts:47-55`；`00-INTEGRATED-runtime-gap-report.md:172-182` | 纳入新计划 |
| M1 | 已诊断未修 | unified-harness T6 步骤 2/5 已勾选的是 dirty-submodule RED/primitive 验证；merge-queue Task 6 已勾选，但没有“submodule 全链路适配完成”条款 | `docs/bugs/2026-09-12-subagent-worktree-lifecycle-broken.md:70-95` 记录 Git/terminal-proof 生命周期，未声明 submodule 全链路已修 | 当前 `git-worktree.ts`、contract、admission/rebase/publish 无在途 submodule diff | `2026-09-10-unified-delegation-workspace-harness.md:359-363`；`git-worktree.ts:198-218,221-250,371-407,520-545`；`00-INTEGRATED-runtime-gap-report.md:184-196` | 纳入新计划 |
| M2 | 已诊断未修 | unified-harness schema/ABI 任务已勾选；无专门可操作 INVALID_PATH 文本任务 | `bug-subagent-writepaths-rejects-glob-without-schema-hint.md:1-25` | 当前 `extension.ts` diff 未改 path error taxonomy/grammar hint | `contracts/dispatch-ir.ts:128-140`；`00-INTEGRATED-runtime-gap-report.md:184-196` | 纳入新计划 |
| M3 | 新缺口 | 既有计划没有“混入 coding-exclusive 字段时 version heuristic fail-closed”的明确任务；相关 schema 任务虽已勾选仍未覆盖 | 未找到对应 bug 文档 | 当前 `extension.ts` diff 不涉及 `executeGeneric` 的 `:909-920` heuristic | `extension.ts:909-920`；`00-INTEGRATED-runtime-gap-report.md:184-196` | 纳入新计划 |
| M4 | 新缺口 | 既有计划没有 ledger state 与 public semantic label 对齐任务 | 未找到对应 bug 文档 | `ledger.ts`、tool 文案无当前 diff | `ledger.ts:31`；`workspace/service.ts:176-187`；`00-INTEGRATED-runtime-gap-report.md:184-196` | 纳入新计划 |
| M5 | 新缺口 | lifecycle-overall 的 authority deadline 不是操作级 retry/idempotency 任务；其 P2-T3 尚未勾选 | 未找到明确操作级 retry bug 文档 | `rpc-client.ts` 不在当前 diff（root-broker client timeout 变更不等于 operation retry） | `rpc-client.ts:70-154,161-166`；`00-INTEGRATED-runtime-gap-report.md:184-196` | 纳入新计划 |
| M6 | 新缺口 | unified-harness 明确 non-managed/generic/`worktree=false` 不创建 Auto Integration；没有全量 coding isolation/queue coverage 任务 | `docs/bugs/2026-09-14-child-integration-auto-lifecycle.md:11-19` 明确排除 non-managed/generic/worktree=false | 当前 runtime diff 未改变 worktree 分布或 completion gate | `00-INTEGRATED-runtime-gap-report.md:184-196`；现场统计 64 child 中 5 managed、51 root、8 submodule | 纳入新计划 |
| M7 | 新缺口（优先级应上调为 High） | 既有计划只约束单次任务测试落盘/报告，不含长时诊断增量落盘；lifecycle-overall P0 写 `/tmp` 但无过程性 checkpoint 任务 | 未找到既有 bug 文档；本次为流程/执行可靠性现场事实 | 无 runtime/Skill 在途改动能保证调查产物增量持久化 | C 组零落盘被中断（40 次只读证）；E 组第一次在 `write` 瞬间中断、36 次零落盘；E 组第二次先落骨架后只损失当节，三例对照；`00-INTEGRATED-runtime-gap-report.md:251`（既有 M7 单例） | 纳入新计划 |

## 2. `已修但复现` 专章

以下是最高优先级回归集合。这里的“声称修复”来自既有计划验收勾选、bug 文档的 Fix/验证段或 commit 交付；并非把“有根因文档”误当成修复。

### B1：canonical production IR 仍未获得 b332005 的修复

- **声称修复证据：** `b332005` 的变更包含 `src/subagent-dispatch/ir.ts` 的 `boundaries.writePaths minItems: 1→0`；配套测试 `test/subagent-dispatch-validation-errors.test.mjs:89-93` 将空 `writePaths` 命名为显式只读派发。
- **现场复现证据：** canonical 生产入口仍是 `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts:168`，其 `minItems: 1` 未改变；报告 `00-INTEGRATED-runtime-gap-report.md:79-116` 记录该孤儿 IR 无生产 importer，并记录 live docs-only 派发被迫构造 writePaths。故这是“修复落在死文件”的回归/错接线，不是测试 fixture-only 异常。

### B2：统一 schema/contract 计划验收后，跨会话拒绝仍复现

- **声称修复证据：** `docs/plans/2026-09-10-unified-delegation-workspace-harness.md:488-496` 将 public schema、structured adapter、Skill 和 renderer 任务全部勾选并记为 GREEN；`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:1003-1005` 还记录 typecheck/verify/全量测试通过。
- **现场复现证据：** `00-INTEGRATED-runtime-gap-report.md:117-137` 的 312 次 `INVALID_CONTRACT`、327 次 `INVALID_PATH` 和 `workflow.reason` 182 次拒绝；当前工作树 `extension.ts:44-159` 仍无根级 `required`、仍平铺 generic/coding 字段，canonical contract `dispatch-ir.ts:11-27,212-235` 仍要求 coding 字段。当前 diff 只把 generic `task` 的 schema `maxLength` 去掉，未解决漂移。

### B3：queue claim/proof settle 验收声明与 live 状态冲突

- **声称修复证据：** merge-queue Task 10 的契约明确要求 enqueue 后 `admissionGeneration` 从 0 变 1，并要求成功同时具备 queue completed、integration receipt、terminal proof、workspace released（`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:888-911`）；Task 11 验收又勾选 queued/admitted/... 阶段恢复及 proof/cleanup debt audit（`:949-955`）。`five-child-convergence` Task 3 也已勾选 enqueue/claim 共享。
- **现场复现证据：** `var/workspaces/repositories/85369acc.../integration-queue/0ed45c9b-...json` 为 `state:"queued"`, `admissionGeneration:0`, `revision:3` 且没有 lease/admitted/candidate/completed 字段；`queue-meta.json` 为 `nextSequence:2`；`terminal-proof-outbox/terminal-proofs.json` 为 5 个 `pending` proof 全 `state:"observed"`、`receipts:{}` 为空，并有 `trusted run binding is unavailable` debts。该状态直接命中 `00-INTEGRATED-runtime-gap-report.md:138-159`，属于已验收路径的 live 回归。

### B4：cleanup-debt/recovery 与可续做 worktree 仍冲突

- **声称修复证据：** Task 11 的验收列出主 agent 可发现/回收孤儿、recover/retry/discard/release 权限矩阵、proof/cleanup debt audit/reconcile 均通过（`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:949-955`）；其接口还声明 root 可调用 `recover`/`retry`（`:942-947`）。
- **现场复现证据：** `00-INTEGRATED-runtime-gap-report.md:160-166` 记录 4/5 workspace 进入 `cleanup-debt`、5 个目录滞留，agent-facing `subagent_worktree` action 没有 `reconcile`；源码 `workspace/service.ts:604-617` 在 Git remove 失败后记 debt，`workspace/coordinator-protocol.ts:74-85` 将 reconcile 限于 admin 权限，且 `execution-contract.ts:154-163` 拒绝 state-root worktree cwd。故既有验收声明未覆盖本 live 组合，需按回归最高优先处理。

### H5：completion reminder 覆盖声明与现场计数冲突

- **声称修复证据：** unified-harness T7 的验收包括 reminder 回归（`docs/plans/2026-09-10-unified-delegation-workspace-harness.md:365-396`）；merge-queue Task 11 声明 notification delivery debt 可 audit/reconcile（`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:949-955`）。
- **现场复现证据：** `packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts:31-60` 只订阅 `subagent:async-complete`，并要求 run/session 匹配及 active/preserved 语义；不处理 queued、cleanup-debt、delivery debt。现场汇总 `00-INTEGRATED-runtime-gap-report.md:172-182` 记录 5 个 managed workspace 只产生 3 次 reminder。因此“notification 有实现”不能等同于“所有 debt 状态覆盖”，是部分修复后的回归。

### M1：submodule 事实仍穿透已勾选的 Git 边界测试

- **声称修复证据：** unified-harness 的 T6 RED 明确包含 dirty submodule，且 T6 实现/验收已勾选（`docs/plans/2026-09-10-unified-delegation-workspace-harness.md:359-363`）；merge-queue Task 6 的 rebase/fast-forward/reconcile 步骤已勾选（`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:470-540`）。
- **现场复现证据：** `00-INTEGRATED-runtime-gap-report.md:184-196` 记录 worktree add/admission/rebase/publish 没有 submodule recursion，父仓 gitlink 可静默通过且 8 个 child cwd 在 submodule 内；故测试覆盖“dirty submodule”不证明生产全链路适配，live 仍复现。

## 3. `2026-09-12-pi-0851-repository-merge-queue.md` 剩余 6 个未勾项

批量统计为 **107/113**；未勾项不是 6 个独立实现任务，而是 1 个交互 smoke、3 个真实/全量/审阅步骤和 2 个审阅收尾步骤。

| 位置 | 未勾项 | 与 B3 的关系 |
|---|---|---|
| Task 1，步骤 6（`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:161-163`） | 执行 Pi 0.85.1 交互 smoke：regular/fullscreen、`/model`、`/thinking`、footer、child browser、RPC abort、`ctx.cwd` | **不是直接原因**；是 Pi 交互兼容性验证未完成，不会使 queue worker claim。
| Task 9，步骤 8（`:826-834`） | 运行真实五 Subagent 验收：2 roots、5 children、冲突、CAS fast-forward、最终 queue/worktree/process 结算 | **是直接缺失的验收门**；该步骤未勾选，正是未对 `queued→admitted→completed` 与 proof settle 做 live 五-child 证明的计划性原因，但不等于它解释了 runtime 为何未 claim。
| Task 9，步骤 9（`:836-840`） | 计划末尾仅运行一次 `npm test` | **不是直接原因**；全量测试尚未完成，不能作为 live queue 卡住的根因。
| Task 9，步骤 10（`:842-844`） | 执行完成后独立 reviewer 门禁 | **不是直接原因**；属于验收治理，不改变 queue 状态。
| Task 13，收尾验收第 4 项（`:1006`） | 请求用户批准并进行计划完成后 reviewer | **不是直接原因**；执行前/后审阅授权未发生。
| Task 13，收尾验收第 5 项（`:1007`） | 根据 reviewer 意见修复，再报告最终结果 | **不是直接原因**；是 reviewer 后续动作，尚未开始。

重要矛盾：计划 Task 10 的接口契约在 `:892` 明确写“child `awaitIntegrationAdmission()` 同步触发 claim”，并把 `admissionGeneration` 从 0 到 1 作为独立验收条款；其验收勾选在 `:913-920`。但 live item 仍为 `admissionGeneration:0`（现场 queue item JSON），因此“计划条款已勾选”与“本次真实现场达成”不能混同；应将 B3 作为已修但复现/回归验证，不把剩余未勾项当成 B3 的唯一根因。

## 4. `2026-09-20-subagent-lifecycle-overall.md` 边界声明与 WritePaths 热点

### 覆盖边界

- 计划 DAG 在 `docs/plans/2026-09-20-subagent-lifecycle-overall.md:44-60` 定义为 P0-T1/P0-T1-GATE → P1-T2 → P2-T3/P2-T4 → P3-T5 → P3-T6 → P4-T7 → P5-T8；P6-T9 是 P0–P5 之后、另获授权的 Skill 后置任务。
- P0-T1/P0-T1-GATE 只证明官方 resume 的 source/resumed identity 与 session content/provenance eligibility，且 WritePaths 仅 `/tmp/subagent-lifecycle-poc/`（`:81-89,101-130`）；不证明 queue claim、workspace cleanup、Git/submodule、dispatch schema 或模型可行动错误。
- P1-T2 只冻结 identity、纯 policy/contract、clock（`:132-161`），不接入真实 timer、storage、broker、workspace 或 child RPC。
- P2-T3 覆盖 Root Broker owner/rebind/revoke/lease authority，P2-T4 覆盖 durable inventory/outbox/barrier（`:163-223`）；P3-T5/T6 覆盖 Supervisor replay 与 reply/steer control-plane（`:225-285`）；P4-T7 覆盖 orphan/crash recovery（`:287-311`）；P5-T8 覆盖 scheduler typed outcome（`:313-338`）；P6-T9 只同步已验收 lifecycle/control 语义到 Skill（`:340-366`）。这些任务**没有明确覆盖**本报告 B1/B2、queue claim worker/settlement、Git stderr/submodule、cleanup-debt agent 出口、模型候选清单、ledger 对外标签或全量隔离率 M6。
- 计划自身在 `:13-18` 还声明 orphan-recovery 旧文档为早期背景资料，未完成、不可作为前置、不得按其 DAG 启动；旧文档统计 0/40，不能抵销 lifecycle-overall 的新 DAG。

### 写入热点与边界

| 热点文件/区域 | lifecycle-overall 任务 | 与本次缺口的重叠风险 | 事实上的顺序/隔离要求 |
|---|---|---|---|
| `src/subagent-dispatch/extension.ts` | P3-T6（`:256-260`） | 当前工作树已在此改 schema/task 与 control-plane；B2/H3/H9/M3 新任务若直接改会碰同一块 | 先冻结/验收 P3-T6 的在途控制面，再以独立 hunk 做 schema/error 变更；不能覆盖在途逻辑。
| `root-broker-protocol.ts`、`root-broker-client.ts`、`root-broker-server.ts`、`child-extensions/root-session-owner.ts` | P2-T3（`:169-179`） | 当前工作树已修改这些文件；B3 proof/authority、H7、M5 可能共享 RPC/lease 边界 | P2-T3 必须先明确 OwnerReceipt/lease contract；queue/proof 修复不得在同一阶段私改 authority 语义。
| `service.ts`、`coordinator-server.ts`、`coordinator-client.ts` | lifecycle-overall 无直接 WritePath；merge-queue Task 10/11 明列（`docs/plans/2026-09-12...:870-879,926-938`） | B3/B4/H1/H5/H6/M1 都会触碰；在途无 diff 但旧计划声称已验收 | 先完成/回归 merge-queue T10/T11 的真实 worker/proof/recovery 证据；新改动按 queue、workspace、agent-visible inspect 分离。
| `integration-queue.ts`、child integration lifecycle | lifecycle-overall 无直接 WritePath；merge-queue T10 明列 | B3 admission claim、H6 inspect、M1 submodule admission | 不应把 P2 durable outbox 与 queue claim 算法混写；先定位 `queued→admitted` 断点并独立验收。
| `git-worktree.ts`、`workspace/contract.ts` | lifecycle-overall 无直接 WritePath；unified-harness T6/T7 已勾选 | H1/H2/M1/M2/B4 | Git diagnostic/submodule/cleanup 变化需独立于 authority/control-plane；不能用生命周期计划的 completion 证据替代 Git 证据。
| `model-selection.ts`、`errors.ts`、`completion-reminder.ts`、Skill | lifecycle-overall 仅 P6-T9 后置 Skill；其余无明确任务 | H5/H8/H9/M2/H4 | H4 需等待 P6 文案同步；H8/H9/H5 若纳入新计划，WritePaths 应与 P3-T6 extension 控制面拆开。

`P2-T3` 与 `P2-T4` 的计划自检明确要求 WritePaths 不重叠（`:370-376`）；因此任何把 queue/proof 事实塞进 Root Broker authority 文件的做法都与既有边界冲突。

## 5. 在途未提交改动的性质判定

### 性质与归属

这批改动不是一个已完成、可直接作为新计划基线的提交；它是**部分执行中的 lifecycle-overall P2-T3/P3-T6 相关工作树批次**，并混入了其他配置、handoff 与测试变更。归属证据如下：

- 新增且当前未跟踪的 `authority-contract.ts`、`authority-store.ts`、`lifecycle-identity.ts`、`lifecycle-policy.ts`、`durable-*`、`replay-barrier.ts`、`supervisor-control-plane.ts`、`supervisor-replay.ts` 与对应测试，正对应 lifecycle-overall `P1-T2`、`P2-T3`、`P2-T4`、`P3-T5/P3-T6` 的 planned WritePaths（计划 `:138-140,169-179,199-205,231-260`）。
- 已修改的 `root-broker-*.ts`、`root-session-owner.ts` 与 runtime/extension control-plane 与 P2-T3/P3-T6 WritePaths 重叠；`git diff --stat` 显示 17 个 tracked 文件、684 insertions/36 deletions，且另有大量 untracked implementation/test files。工作树状态由批量提取 `coverage_extract.json.git.status` 与现场 `git status --short` 证明。
- `extension.ts` 的工作树相对 HEAD 只显示三类直接事实：generic `task` schema 去掉 `maxLength:65536`；新增 Supervisor control-plane fencing/reply/steer；注入 `supervisorControlPlane`。它**没有**解决 B2 的根 `required`/branch separation，也没有删除 H3 的 `workflow`，没有修复 H9/M3。
- `generic-prompt.ts` 工作树只提高 task UTF-8 byte limit 到 64 KiB（`MAX_TASK_BYTES`、`normalizeString(..., maxBytes)`）；这属于 generic contract 约束增强，不是 B1/B2 canonical coding schema 修复。
- `subagent-runtime.ts`/`root-session-owner.ts`/Root Broker 文件的改动加入 authority store、owner read/rebind/revoke、lease heartbeat/expiry 与 supervisor control wiring，部分实现 P2-T3/P3-T6 的 planned API，但不能凭未提交 diff 宣称任务完成；lifecycle-overall 对这些任务的所有 RED/GREEN 复选框仍为未勾（`coverage_targets.json` 统计 P1/P2/P3 implementation sections均未勾）。
- `pi/AGENTS*.md`、`pi/agents/reviewer.md`、`pi/settings.json`、`.gitignore` 与 context-usage/handoff 文件属于配置/上下文在途变化，不属于 B1–M7 的 runtime 修复证明；尤其 `pi/settings.json` 变更按仓库规则不能提交 `enabledModels`。

### 是否已完成、如何作为基线

结论是：**未完成，不能把工作树直接视为“已解决”或让新计划无条件建立在它之上。** 新计划的事实前置应是：先由 owner 对这批混合改动做提交/丢弃决策并固定 commit（本报告不执行），再以固定 commit 对照；在此之前只能将 `extension.ts` 的 control-plane 变化标记为“在途部分解决/必须避让”，不能把 B2/H3/H9/M3 标为已解决。

本节只判定性质，不要求当前调查执行提交、stash、checkout 或清理；工作树仍原样保留。

## 6. 冲突与重复风险清单

1. **`extension.ts` 双热点：** 直接加入 schema required/branch union、删除 workflow 或改 preflight taxonomy，可能覆盖当前未提交 P3-T6 Supervisor control-plane hunk；应按固定 commit/独立 hunk 顺序处理。B2/H3/H9/M3 不能被当前 diff 的 `task.maxLength` 变化冒充已修。
2. **Root Broker authority 与 queue proof 混界：** P2-T3 的 `root-broker-{protocol,client,server}.ts` 当前在途；B3 的 claim/settlement 与 terminal-proof outbox 应保持在 coordinator/queue/proof 边界，不能直接在 authority API 中补 queue worker，避免违反 lifecycle-overall `P2-T3/P2-T4` WritePaths 隔离。
3. **`service.ts`/coordinator queue 竞争：** merge-queue Task 10/11 明列 `service.ts`、`coordinator-server.ts`、`integration-queue.ts`；B3/B4/H1/H5/H6/M1 新任务若平行写这些文件会和既有 T10/T11 语义冲突。先以 live item 的 `queued/admissionGeneration=0` 和 proof receipts 为空为回归基线，再分别修 claim、proof settle、cleanup/inspect。
4. **cleanup-debt action ABI 冲突：** 既有文档声明 `recover/retry/discard/release`（计划 `:942-946`），实际 public `subagent_worktree` union 未提供 agent `reconcile`，且 admin reconcile 需要显式授权；新计划不能重复发明同名 action 或绕过 owner scope/action token/terminal proof 门禁。
5. **`workflow` 删除与历史 replay：** H3 的用户决策是整体删除，但 dispatch IR、prompt、schema、历史 replay/contract 测试都读该字段；直接从单一 schema 删除会造成旧记录/测试解码冲突，必须先界定 canonical compatibility 边界，不能由 P6 Skill 文案替代 runtime contract。
6. **Skill 与 runtime 顺序：** H4 的 `/**`/尾 `/` 文法错误属于 Skill/runtime ABI 双向漂移；lifecycle-overall P6-T9 明确只能在 P3/P4/P5 验收后更新 Skill（`:340-366`），不要先改 Skill 声明不存在的 H5/H6/H7/H8 能力。
7. **H5/H6/H8/H9/M2/M5/M6 未被当前新增文件覆盖：** reminder、queue inspect、model candidate diagnostics、preflight taxonomy、path error hints、RPC operation retry 和 isolation coverage 均不在当前 `git diff` 解决范围；必须避免“在途已解决”标签扩散。
8. **M1 submodule 的证据边界：** unified-harness 仅证明写过 dirty-submodule RED/实现步骤，不证明真实现场的 submodule cwd、gitlink、nested dirty、publish/rebase recursion 全链路；不能以父仓 clean 或既有测试通过判定已修。
9. **M7 落盘约束是调查/运行时流程风险，不应伪装成 runtime bug：** 本次三例中断已证明零落盘会丢失 36–40 次取证，而先写骨架可将损失压缩为当节；它应作为新计划的高优先级流程/Skill/派发协议事实，但本报告不提出具体实现。
10. **配置热点：** `pi/settings.json` 是 per-machine 配置，尤其 `enabledModels` 禁止提交；任何新计划若将本次 settings diff 当 runtime 证据或顺带纳入，会产生不相关变更与提交风险。
11. **在途生命周期文件的固定基线风险：** 当前 untracked authority/durable/control files 若被删除、重写或 checkout 会破坏事实现场；本次调查禁止这些操作。新计划必须先取得 owner 对提交/丢弃的明确决定，不能在混合工作树上直接开写。

因此，B1/B2/B3/B4/H2/H5/M1 的既有“通过”与 live 复现已构成最高优先级回归验证集合；H3、H8、M3、M4、M5、M6、M7 属于现有资料/在途均未覆盖的新增范围；H1、H6、H9、M2 则已有根因记录但没有对应已完成修复，不能重复宣称已修。
