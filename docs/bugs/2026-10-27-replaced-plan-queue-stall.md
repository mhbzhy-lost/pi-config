# 取消替换后自动集成队列与 resume intent 停滞

日期：2026-10-27。分类：预期 production 数据未被正确处理。

最新结论：第二轮保留现场确认真实 replace 的首因是 Git copy 源路径误计入 changedFiles；最小修复后 DI 与真实 replace 均通过。以下第一轮记录保留为历史证据边界，第二轮详见后半部分。

## 真实观测与证据边界

[真实 replace smoke 记录](../summaries/2026-10-27-goal-runtime-smoke.md:59) 中，旧计划 `c605a613-b075-4901-834f-ea2d58f931e1` 的 run `04ad2491-7e42-4cc0-bd91-1cc668b3b551` 已 terminal，workspace `012dacc5-6b5f-4c78-9a41-23324a1871fe` 已释放。取消后新 `planId` 与旧 entry 保留符合预期，新计划却留下：

| 事实 | 身份或状态 |
| --- | --- |
| 新计划 | `13299489-292a-4318-92e5-8d4ec5133b01` |
| run | `47aa3ca2-553a-4642-8eb7-3a46062539f7` |
| workspace | `8da0ec51-2fe1-4032-9dd8-8cc4fbfe784e`，active |
| proof | `60b315b8ec7c6a926095feb300bbd3809a1ac2ee5b7e9cb31474a69d9e7eb752` |
| queue | `5fe53dbd-6057-4e48-9df4-38200da54efe`，queued |
| resume intent | `358072b2-34a3-4361-af1f-fd9e6e806893`，pending |
| Goal | manual-integration / subagent-integration-handoff |

原始临时 ledger、session 与事件已由 smoke 清理，本次不能重读它们。不能据摘要确定真实 child 最后一次 admission 为何没有完成，也不能把替换本身断言为唯一触发条件。主管批准用既有 DI/隔离 queue 测试固定可达的消费缺口；未启动真实 provider。

## 根因与复现链

正常入口链为 `plan_execute → replaceCancelled → typed coding dispatch → child agent_end → prepareAutoIntegration → advanceAutoIntegration`。FIFO 非队首、提交尚未准备完成等情况允许项保持 queued；[child lifecycle](../../packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts:66) 在 shutdown 看到 durable queued 直接返回，重试 timer 为 unref，不阻止 child 退出。shutdown 本身不是终局证明，这个保留行为正确。

官方 terminal 通过 Root Broker 校验、写入 coordinator outbox 后，[deliverTerminalProof](../../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:302) 原先对所有未完成队列只写 proof、`requestChildResume`，然后调用 [pumpResumeIntents](../../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:288)。pump 只升级队首 intent 和发人工交接消息，不执行 admission/rebase/publish；已经结束的 child 也不会再触发 agent_end。首个偏离点在此：已有官方终局证明的自动 queued 项，没有消费者接续其机械阶段。反复 replay 只重写同一 pending intent，不能使 queue 完成。

替换没有改变 coordinator 的 owner scope 或 FIFO 分区；此缺口也可由普通 terminal follower 触发，不能归因于 Goal 换 planId。启动时调用全量 `reconcileIntegrations()` 无法解决同 Host 后产生的新项，还会遍历运行 child 的队列，因此最终修复不采用该方案。

既有 `resume intent 按重启持久化并保持 owner scope 过滤` 案例现在保留原手动队列断言，并追加同一测试内的自动 follower 序列：正式分配/bind → Git commit → typed `prepareAutoIntegration` → 前项尚在队首时 terminal RPC → durable waiting-head intent → 通过原 admission/publish 完成前项 → 既有 proof replay 自动消费 follower → 真实集成 receipt、queue completed、intent completed、workspace released。没有直接改 ledger 或设置 completed；proof 为既有 DI 合同输入，只证明协调器消费语义，不代表真实进程 proof。

## 修复

[终局 proof 消费路径](../../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:330) 在 proof 已经记录后，仅对 `autoManaged === true` 的 queued/prepared 项接续原机械集成入口。queued 先按既有后代关系规则刷新最终授权 HEAD，再走原 admission/rebase/publish；prepared 复用原 candidate/lease。

完成后继续原 proof 结算与资源释放；`completePrepared` 原有逻辑关闭 active resume intent，队首完成原有 replay 触发下一项。启动恢复也复用同一 outbox replay，不新增轮询、自动 child resume 或 Goal 执行动作。

准入失败、dirty、冲突、越界和 receipt 不一致均不视为成功。未完成项继续生成/保留 durable resume intent 与人工交接；手动 queue 行为不变。没有制造 proof、receipt 或人工 integrate。

## 验证

更新既有 resume-intent、integration-queue 测试断言。验证覆盖自动 follower 消费及 intent 关闭，同时保留手动队列 pending、owner scope 过滤、FIFO、冲突/候选漂移/dirty/越界 fail-closed、proof supersession 与 disposition 恢复故障窗口。

测试过程中两处新 fixture 输入被原门禁拒绝：旧项集成后仍以旧 baseCommit 分配（`MANAGED_WORKSPACE_ORIGIN_DRIFT`），以及 terminal RPC 漏传 ownerScope（foreign owner scope）。另一次并行运行中，fixture 在 coordinator 重启后尚未连接 client 就执行同步 Git，耗尽空闲关闭窗口出现 EPIPE。均归类为测试制造的非预期数据/顺序；只修 fixture 的当前 HEAD、ownerScope 和连接时序，没有增加生产兼容或放宽超时。

`npm run typecheck` 通过；queue、broker、proof supersession、settlement 故障窗口的聚焦组合首轮为 92/93，通过之外的 1 项是上述 fixture 失败。修正后 `node --test test/managed-workspace-resume-intent.integration.mjs` 全套 7/7 通过；Goal Runtime 18/18 通过；child/worktree/Git 生命周期联合 13/13 通过。Goal 契约、共享 dispatch 与 terminal-proof 的额外 14 项均通过。自动 dirty 负例确认 queue 仍 queued、intent pending 且交接已投递、workspace active。

本次未执行真实 replace smoke。因此可以证明上述可达停滞链已修复，不能补签已清理现场的全部事件时序。

与缺陷 C 不同根：D 是写入/消费链缺口，C 是新 Host 读取持久化事实的缺口。Goal 的 manual-integration 状态忠实反映未完成资源，不能通过放宽 Goal 门禁消除此问题。

## 第二轮：保留真实现场后固定首个准入拒绝（dispatch-e1e38247）

第二轮补齐原始证据后，确认上述 FIFO 接续缺口**不是本次 replace 持续失败的首个原因**。本轮真实数据仍归类为「预期 production 数据未被正确处理」：新 child 经正式 `plan_execute → execution.start → typed coding dispatch` 分配 workspace，正常提交唯一允许的新文件；Git 的 copy 检测把它识别为旧文件的副本，路径解析器却把未修改的源文件也送入 writePaths 校验。

命令：`node scripts/probes/goal-smoke.ts --scenario replace --keep-artifacts`。探针新增保留参数，关闭自身进程后保留完整 ledger、queue/intent、proof outbox、child session、runner stderr/events 和 Host RPC records。首轮失败临时根为 `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-Z33NyW`，归因期间未清理。

| 原始身份 | 现场值 |
| --- | --- |
| Host / session | PID `26718` / `01a17e60-1313-75f2-baf6-d3bc85632d18` |
| 旧 plan / run | `b4d6ec3b-18c6-454e-af48-acb841c2db2e` / `56ff21b8-19e8-409c-bead-ec08bbf2e4bd` |
| 旧 workspace / queue | `2cc5fbc8-7018-4d14-99c1-3f0ca2b4e588` released / `3beeeb17-2d29-4df1-b80f-95c5aa05f18c` completed |
| 新 plan / run | `afcf6a24-abc6-4764-88ec-3eac30fee763` / `332ba929-8633-4499-8d63-c9f15ebcae40` |
| 新 workspace / child PID | `2ab703cb-ffbe-48b1-9c2a-0444c6cdc422` active / `27451` |
| 官方 proof | `53cb3e30c6eca2523eb4e1e4358198fbb24775283c6b50d297576e32f6ed3cb4` |
| 新 queue | `72c29fb9-2baf-42b5-8cf8-15ecaaf07497`，autoManaged=true、queued、revision=0、admissionGeneration=0 |
| resume intent | `dc1c5ba3-58a0-4b9e-955c-df6a4350d6a3`，pending、delivery=delivered、resumedRun=null |
| ledger base / authorized HEAD | `da9185c7c64c34f81d478cf0e515536e39c86cce` / `4570afb2437860cf2b690f18c74107c1778c5c49` |
| writePaths | `["replacement-next-A.txt"]` |

以下摘录均直接来自保留现场，未由 DI 构造。ledger 分区为 `workspaces/repositories/b3ea5ae65e0c440f2d4d039107e6a745304b36f16fdc4dd8f1ddd1c3a8d6e4e3/`，读取私有 record 时只输出非凭据字段。新 child session 的 `2026-10-27T17:20:07.890Z` bash 调用为：

```text
printf 'A\n' > replacement-next-A.txt && git add replacement-next-A.txt && git commit -m 'feat: 添加冒烟标记' && test -z "$(git status --porcelain)"
```

`17:20:08.074Z` 工具回执：`4570afb`、`1 file changed, 1 insertion(+)`、`create mode 100644 replacement-next-A.txt`。后续 `od -c` 得到 `A \n`，`git status --porcelain | wc -l` 为 `0`。原 child 的 `tmp/pi-subagents-uid-501/async-subagent-runs/332ba929-8633-4499-8d63-c9f15ebcae40/runner.stderr.log` 完整关键序列为：

```jsonl
{"version":1,"phase":"integration-gate-passed","monotonicMs":2420488495,"eligible":true,"queueState":"absent"}
{"version":1,"phase":"integration-lifecycle-agent-end","monotonicMs":2420495919,"key":"01a17e60-1313-75f2-baf6-d3bc85632d18\u0000332ba929-8633-4499-8d63-c9f15ebcae40"}
{"version":1,"phase":"integration-lifecycle-prepare-result","monotonicMs":2420495994,"queueState":"queued"}
{"version":1,"phase":"integration-lifecycle-advance-call","monotonicMs":2420495994,"poll":0}
{"version":1,"phase":"integration-lifecycle-disposition-blocked","monotonicMs":2420496654,"reason":"terminal-proof-pending"}
{"version":1,"phase":"integration-lifecycle-advance-error","monotonicMs":2420496654,"reason":"changed files outside writePaths: replacement-A.txt","retryable":false}
```

在相同原始 Git object 上只读执行以下命令，得到相互印证的输出：

```text
git diff --name-status --find-renames --find-copies-harder da9185c7c64c34f81d478cf0e515536e39c86cce 4570afb2437860cf2b690f18c74107c1778c5c49
C100    replacement-A.txt    replacement-next-A.txt

git diff --no-renames --name-status da9185c7c64c34f81d478cf0e515536e39c86cce 4570afb2437860cf2b690f18c74107c1778c5c49
A       replacement-next-A.txt
```

首偏离点是 [git-worktree.ts 的 parseChangedPaths](../../packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:236)：旧实现对 `R` 和 `C` 均 `files.push(source, destination)`。[inspectManagedGitWorkspace](../../packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:299) 开启 `--find-copies-harder`，因此旧文件内容相同即可触发，不要求 child 执行 copy 命令。随后 [service.ts:297](../../packages/pi-subagents-enhanced/src/workspace/service.ts:297) 的范围校验因错误 changedFiles 合法拒绝；不属于模型越界、dirty、FIFO follower 等待或身份失配。

消费条件和等待关系也由代码与 ledger 对齐：[coordinator-server.ts:81](../../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:81) 仅对 FIFO 队首 claim；旧项已经 completed，新项是队首，但 admission callback 在落入 admitted 之前抛错，所以 generation/revision 均为 0。官方 proof 落盘后，[上一轮接续入口](../../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:330) 会命中 autoManaged queued 条件，却复用相同准入检查，无法消除 copy 误判；它不是因替换 planId 而未触达。[requestChildResume](../../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts:115) 为未完成项写 intent，pump 只投递人工 handoff；本轮 intent `17:20:16.222Z` 创建、`.254Z` 标记 delivered。pending intent 是准入失败后保留的恢复义务，不是阻挡 queue claim 的前置锁，也不能当成消费完成。

原始证据校验值：`probe-events.jsonl` SHA-256 `88b4de506379d0fb0e1d8d479753fb4affe0e30d258b806efcdfdece8a0588ea`；`host-26718.json` SHA-256 `26aa9aef4a9283f71bf3b466aa8e21932798001df80aa4dcb41473cef32563d2`；queue JSON SHA-256 `beb0045eaef5b39df31d144fb63e31ca8d39fdac06291d4f87683294d2fefb91`。以上原始身份、stderr 和 Git 输出补上上一轮缺失的 admission 证据。

## 第二轮最小修复与双重验证

主管批准将 `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts` 加入写路径后，只修改 copy/rename 共用解析分支：`C` 消费两个路径字段但只把 destination 计为 changed；`R` 仍计入两端。冻结合同 `docs/plans/2026-09-10-unified-delegation-workspace-harness.md:25` 要求 rename 双端范围检查，未发现 copy 源必须计为写入的合同或既有断言。若源文件自身被修改，它另有 `M` 状态，仍受门禁约束。未修改 service、queue 状态机、coordinator 接续逻辑、owner 或 proof/receipt 规则。

DI 回归采用既有 `test/workspace-disposition-settlement.integration.mjs` fixture：创建与已有 `src/base.txt` 相同的内容，writePaths 收窄为唯一新文件，断言真实 Git 得到 C100 并调用原 `integrationAdmissionFacts`。修改生产实现前，`node --test --test-name-pattern='workspace-only prepare' test/workspace-disposition-settlement.integration.mjs` 精准失败于 `MANAGED_WORKSPACE_WRITE_PATHS: changed files outside writePaths: src/base.txt`；没有新增测试文件或手工制造 queue/proof 完成状态。

修复后的 fresh 真实 replace 使用完全相同的两份内容、同一模型和同一生产入口；保留原失败现场，同时在新隔离根 `goal-smoke-Je1qej` 验证：

| 真实终验 | 结果 |
| --- | --- |
| session | `01a17e64-d7f4-7030-9b09-ae78b80e4989` |
| 旧 plan / run | `6b3f58e7-0f74-418d-8685-f4a037945a1c` / `f927129d-8a34-4287-bf74-6c9dd2842957`，workspace released 后 cancel |
| 新 plan | `4779d7a1-909a-4be8-a1a8-ba04750c1912`，completed，旧 entries 保留 |
| 新 run / workspace | `ddee4fe5-b546-43e5-9558-f28a45420585` / `6676ff3c-2996-4213-9bc0-6e53e30a6301`，released |
| 新 terminal proof | `f99d17b358999662a51e68c1997a4a77ce92fa12f73e616280d88024384e6142` |
| 新 integration receipt | `01e16bd6-1ce9-4bd2-95de-88178ff21857` |
| 新 queue | `dc64a9da-34a4-487a-b1e3-a16fa9c78357`，completed |
| resume intents | `[]`，无需人工交接 |
| 模型 / 调用预算 | `qoder-pool/DeepSeek-Flash`；旧 child 2、新 child 4、主模型 10 条 assistant |

中间一次真实尝试 `goal-smoke-ndX69M` 在旧计划已释放、新计划尚未派发时，由探针 prompt 与通知唤醒竞争触发 `Agent is already processing`，不计为生产修复通过或失败。按官方 `docs/rpc-commands.md`，探针 execute prompt 补 `streamingBehavior: 'followUp'` 后再跑得到上述 completed；未重试失败业务、未改变模型任务内容或放宽门禁。首轮故障复现旧/新 child 各 4 条、主模型 10 条，也均在预算内。

最终验证输出：

- `node --test test/workspace-disposition-settlement.integration.mjs test/managed-workspace-service.integration.mjs test/managed-workspace-integration-queue.integration.mjs test/managed-workspace-resume-intent.integration.mjs test/subagent-runtime-membrane.test.mjs`：**180/180 passed，fail 0、cancelled 0、skipped 0**，240069 ms。包括 C100 窄范围准入、rename 越界、dirty、候选漂移、冲突、FIFO、terminal follower 接续、intent 闭合和七个 settlement 故障窗口。最初前台执行被工具 60 秒超时终止；完整后台重跑得出此汇总，不把超时轮算作通过。日志 SHA-256 `c5b5782703633d603d90b935a02e39d7757bb0579f70e18c34be8203492cb9b5`。
- `npm run typecheck`：根与 package 均通过。
- 探针独立 `tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node scripts/probes/goal-smoke.ts`：通过。
- 真实终验 Host PID `7891`，两次 check-A receipt `37eed34e#0`、`8f02c120#0` 均 exit 0；HEAD `24f9602d2b8731f3402a94a8c4521286f45b23ed`。新 child 原始 stderr：`integration-lifecycle-advance-result`，`monotonicMs=2420813964`，`queueState=completed`，`poll=0`。终验原始 `probe-events.jsonl` SHA-256 `ae6e521b096e744a9a8e2568800695cffca59ddc00d1ba416443197a5d6e6621`。
- `git diff --check`：通过；`git diff --cached --name-only`：空。

归因和双重验证结束后显式清理，三条真实回执如下（此前 `--keep-artifacts` 的 finally 均为 removed:false）：

```jsonl
{"root":"goal-smoke-Z33NyW","removed":true,"killedPids":[],"noStagedFiles":true}
{"root":"goal-smoke-ndX69M","removed":true,"killedPids":[],"noStagedFiles":true}
{"root":"goal-smoke-Je1qej","removed":true,"killedPids":[],"noStagedFiles":true}
```

完整原始临时文件已按合同在归因和验证后删除；本报告保留上述原始摘录、身份与校验值，不把哈希当作仍可访问的日志副本。凭据仅沿用探针的 cp 间接复制；不读取或输出凭据，不碰主仓 `var/workspaces`，不 stage/commit。除主管追加授权的 `git-worktree.ts` 外，本轮仅修改探针、既有 settlement fixture 与两份 D 报告；未覆盖其他 dirty 改动。
