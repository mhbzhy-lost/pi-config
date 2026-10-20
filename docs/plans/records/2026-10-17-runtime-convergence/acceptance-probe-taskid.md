# 五-child 真实验收 probe：首跑失败归因与修正

## 首跑事实（真实 provider，已授权）

命令：`PI_REAL_BIN=<repo>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js ACCEPTANCE_RECEIPT=/tmp/rc-five-child-acceptance-receipt.json node scripts/probes/repository-merge-queue-acceptance.ts --model qoder-pool/DeepSeek-Flash`（roots=2、subagents=5、require-conflicts=4 默认值）。

- 异步 job `e45a6ba7-5fac-448e-85f4-88ad26f2c78a`：wrapper exit 0，但**probe 自身 `PROBE_EXIT=1`**，耗时约 19 秒。启动回执与 wrapper exit 都不代表验收通过。
- 失败信息：`dispatch receipt has an invalid acceptance taskId: dispatch-19e5682d`；diagnostic 的 `firstDeviation.phase = "public-audit-settlement"`。
- 现场保留：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/repository-merge-queue-acceptance-Xkd9TF/`（`repository/`、`state/`、`barrier/`、`diagnostics/`、`acceptance-diagnostic.json`）。只读核对事实：`repository` 仅有 `790f780 acceptance base` 一个 commit；5 个 `pi-managed/*` worktree 全部停在 base commit；`barrier/` 为空（没有任何 child ready receipt）。
- 两个 Root Host 的事件尾显示 `subagent_start` 共 5 次 `tool_execution_start`/`tool_execution_end`（3 + 2），`stderrTail` 为空；即派发已发生，child 尚未产出提交，probe 就在绑定收集阶段抛出。
- `ps` 复核无残留 probe/Host/child 进程；未删除任何现场。

## 首个偏离点

`scripts/probes/repository-merge-queue-acceptance.ts` 的 `collectPublicDispatchBindings()` 用 host 回执里的 `details.taskId` 反查验收任务名（`acceptanceTaskName`，只接受 `acceptance-<task>`）。而 production 的统一派发合同把 `taskId` 定义为 **contractHash 派生的 dispatch 身份**：`contracts/dispatch-ir.ts:103` `taskId: \`dispatch-${contractHash.slice(0, 8)}\``，且 v1 迁移指引明确要求调用方移除自带的 `version/taskId/risk`。fixture `test/fixtures/repository-merge-queue-acceptance/root-provider.mjs` 的 `contract(task)` 也确实不再把 `taskId` 放进合同（只把 `acceptance-<task>` 当作 **toolCallId** 传给 `tool.execute`）。

因此首个偏离点在 probe 自己的身份映射：它把“调用方任务名”与“production 派生 dispatch 身份”当成同一个字段。

## 分类

**类别 2：验收 harness 的过期期望**，不是 production 缺陷。判据：

- 数据由合法 public 入口产生（真实 Host + 真实 `subagent_start` + 统一派发合同），身份/时间/资源事实有效；
- production 的 `taskId` 语义是已提交合同（`dispatch-ir.ts`），且有既有测试覆盖（`test/subagent-model-selection.integration.mjs` 等按当前 details 形状断言并通过）；
- 偏差只出现在 probe 的期望值上，修改 probe 不需要放宽任何 production 门禁。

处置：只改 probe（`scripts/`），不改 production、不改 fixture 合同、不放宽验收语义。

## 修正内容

1. 任务身份改为以 **probe 自己控制的 `record.toolCallId`** 为权威（`acceptance-<task>`）；`details.taskId` 视为 production 派生的 dispatch 身份。
2. 保留严格性：`details.taskId` 必须是 `dispatch-[0-9a-f]{8}` 或合法的 `acceptance-<task>`，其它形态一律 `unrecognized taskId shape` fail closed；派生形态但缺 `toolCallId`（无法归属任务）时 `lost its acceptance toolCallId` fail closed，不按哈希猜任务。
3. 旧回执形态（`taskId` 直接是 `acceptance-<task>`）继续可识别，既有 probe 合同断言无需改写即可通过。
4. 公开 audit 分支（`receipt.owner.toolCallId`）与五-distinct-child/同 base/conflict 要求、binding 交叉核对全部未变。

## 验证

- `node --test test/repository-merge-queue-acceptance-probe.test.mjs`：**44/44 exit 0**（`/tmp/rc-probe-contract-after-fix.log`），其中新增一条覆盖 production 派生形态、缺 toolCallId fail-closed 与未知形态 fail-closed（用户已授权新增用例）。
- 修正后重跑真实 probe：异步 job `9dd08c51-a664-4aed-aba1-10b7e4f3bc93`，日志 `/tmp/rc-five-child-acceptance-2.log`，receipt `/tmp/rc-five-child-acceptance-receipt-2.json`。结果以完成通知为准；启动回执不代表成功。

## 边界

首跑失败**不构成**任何 merge queue/发布链缺陷证据，也不构成五-child 验收通过；本轮已产生的真实模型调用只覆盖 5 次派发启动，未产生任何 child 提交。

---

# 第二跑：barrier 就绪回执缺失（真实模型已跑起来）

## 事实

命令同上（job `9dd08c51-a664-4aed-aba1-10b7e4f3bc93`），wrapper exit 0、**`PROBE_EXIT=1`**，约 122 秒，日志 `/tmp/rc-five-child-acceptance-2.log`：`acceptance barrier timed out; evidence retained`。现场 `…/repository-merge-queue-acceptance-XYRn5V/` 保留，只读核对：

| 面 | 事实 |
| --- | --- |
| repository | `b616df3 acceptance base` + **`4d4b291 feat: 添加 transform 阶段`**（一个 child 已经过队列发布到 main） |
| worktree | 5 个 `pi-managed/*`；其中 4 个目录内有 `conflict-evidence.json` |
| queue | 5 items：1 `completed`（candidateHead `4d4b291b`）、1 `resolving-conflict`（有 conflictDigest）、3 `queued`；`queue-meta.nextSequence=6` |
| resume/handoff | 4 个 intent：3 `waiting-head`、1 `pending` 且 `delivery.state=delivered` |
| proof outbox | receipts 1、pending 4、debts 0 |
| workspace 台账 | 1 `released`（disposition discard）、4 `active` 且 `terminalProof.state=observed`；无 cleanup-debt |
| barrier | **空目录**：没有任何 `<runId>.ready.json`，也没有 `release.json` |

child 侧证据（`asyncDir …/async-subagent-runs/a6d17c08-…`）：`status.json.state=complete`；`recovery-descriptor.json` 为 `agent=executor`、`model=qoder-pool/DeepSeek-Flash`、`modelOrigin=explicit`、`subagentOnlyExtensions=[<worktree>/acceptance-barrier.mjs]`；`launchResolvedExtensions` = runtime 1 + configured 1 + required `[root-session-owner, integration-queue, agents-shared]`、effective 5、omitted 0；`runtimeAcknowledgedExtensions.ids` 为三个 required；`events.jsonl` 无 `extension_error`（其中出现 barrier 源码文本只是模型自己 `cat` 了该文件）；`runner.stderr.log` 只有 integration gate/lifecycle 诊断。

## 首个偏离点

`test/fixtures/repository-merge-queue-acceptance/acceptance-barrier.mjs` 的 `resolveRuntimeIdentity()` 直接读 `PI_SUBAGENT_RUN_ID`，缺失即抛错，于是 ready receipt 从未写出，probe 的 barrier 等待超时。

该环境变量在当前上游合同里**根本不存在**：对 `packages/pi-subagents-enhanced/node_modules/pi-subagents/src` 全量检索 `PI_SUBAGENT_*` 得到 `PI_SUBAGENT_RUNNER_CONFIG`、`PI_SUBAGENT_EXTENSION_BINDINGS_ENV`、`PI_SUBAGENT_CHILD`、`PI_SUBAGENT_PARENT_SESSION` 等，**没有 `PI_SUBAGENT_RUN_ID`**。它只由本仓 `child-extensions/integration-queue.ts:179-181` 在加载时用 `resolveChildBrokerIdentity(env)` 解析后写回 `env`。而 profile 的 `subagentOnlyExtensions`（barrier）在 `launchResolvedExtensions.effective` 顺序中排在 required child extensions **之前**（runtime → configured → required），因此 barrier 加载时该变量必然还没有值。

## 分类

**类别 2：验收 fixture 依赖已不存在的 launcher 环境变量**，不是生产缺陷：派发、托管工作区、队列发布、真实冲突与 handoff 都按合同工作（见上表），失败的只有 barrier 自身的身份解析。

同时记录一条真实合同事实（供后续 fixture/child extension 设计参考，不作为缺陷）：**profile 注入的 `subagentOnlyExtensions` 先于 required child extensions 加载，不能依赖由后者写入的环境变量**；需要 run 身份时应使用 `PI_SUBAGENT_EXTENSION_BINDINGS` + root-broker authority 的解析入口。

## 修正

只改 fixture：`resolveRunId()` 先取已存在的 `PI_SUBAGENT_RUN_ID`（测试注入或 integration-queue 已写回的情形），否则在 `PI_SUBAGENT_CHILD=1` 且有 `PI_SUBAGENT_EXTENSION_BINDINGS` 时，经 `PI_CODING_AGENT_DIR` 动态 import 生产 helper `src/subagent-dispatch/child-broker-binding.ts` 的 `resolveChildBrokerIdentity(env)` 解析（与 `root-provider.mjs` 已有的定位方式一致），避免 fixture 复制一份绑定解码逻辑；两者都拿不到时 fail closed。未改生产、未改 probe 语义、未放宽 barrier（仍要求 5 个不同 child 同 base 一次释放）。

`node --test test/repository-merge-queue-acceptance-probe.test.mjs`：**44/44 exit 0**（`/tmp/rc-probe-contract-after-barrier.log`），其中直接注入 `PI_SUBAGENT_RUN_ID` 的 barrier 用例走第 1 条路径，无需改写。

## 第三跑

修正后重跑：job `aa8da909-54e0-4c4f-839d-1dc219383b18`，日志 `/tmp/rc-five-child-acceptance-3.log`，receipt `/tmp/rc-five-child-acceptance-receipt-3.json`。结果以完成通知为准。

## 证据边界

第二跑**不是**验收通过：barrier 从未释放，4 个 workspace 停在 `active`，3 个 queue item 停在 `queued`。它只提供了真实模型下“派发→托管工作区→队列发布→真实冲突→handoff/proof”链路的**部分**运行证据，不能替代完整五-child 验收，也不能据此宣称冲突续跑与全部发布已验证。

---

# 第三跑：barrier 修通，但 probe 场景与“不自动 resume”合同冲突

## 事实（job `aa8da909-54e0-4c4f-839d-1dc219383b18`，约 900 秒）

wrapper exit 0、**`PROBE_EXIT=1`**，错误 `OVERALL_TIMEOUT: acceptance probe overall timed out`（probe 默认 `ACCEPTANCE_OVERALL_TIMEOUT_MS=15min`），`firstDeviation.phase=public-audit-settlement`，无 receipt 文件。现场 `…/repository-merge-queue-acceptance-RrLPSD/` 保留，`ps` 无残留 probe/Host/child 进程。

| 面 | 事实 |
| --- | --- |
| barrier | **完全成功**：5 份 `<runId>.ready.json`（同一 `baseCommit 2d49dd6b…`、5 个不同 runId/pid）+ `release.json`（`repository-merge-queue-release.v1`，5 children）→ fixture 身份解析修正已被真实 Host 验证 |
| repository | `2d49dd6 acceptance base` + **`e040eb3 feat: 添加 serialize 阶段`**（FIFO 队首经队列发布成功） |
| queue | 5 items：1 `completed`（`candidateHead e040eb37`、`admittedTargetHead 2d49dd6b`）、4 `queued`（attempt 1、无 admittedTargetHead、无 conflictDigest） |
| resume/handoff | 4 个 intent：1 `pending` 且 `delivery=delivered`、3 `waiting-head` |
| proof outbox | receipts 1、pending 4、debts 0 |
| workspace | 1 `released`（disposition discard、proof observed）、4 `active`（proof observed）、`cleanupDebt` 全空 |
| child | 5 个 run 全部 `state=complete`、`process-terminal.json` 存在、8–13 turns；即**没有 child 存活等待自己的集成** |

## 首个偏离点

follower child 的 `runner.stderr.log` 只有四条诊断：`integration-gate-passed` → `integration-lifecycle-agent-end` → `integration-lifecycle-prepare-result(queueState=queued)` → `integration-lifecycle-advance-call(poll 0)`，随后 child 结束。生产默认轮询预算是 `child-integration-lifecycle.ts:27` 的 `maxAdmissionPolls = 3`、`pollDelayMs = 25`（约 75ms，`:113` 循环），队首还在集成时 follower 拿不到 admission，轮询耗尽后 child 正常结束本轮。

child 结束后：terminal proof 在 `queued` 状态到达 → `coordinator-server.ts` 走 `RESUMABLE_PROOF_QUEUE_STATES` 分支创建 durable resume intent，并按当前产品合同**不自动拉起已结束的 child**，只投递主 Agent 接管提示（`coordinator-server.ts:284-286` 注释、`createManualIntegrationHandoff` 文案“不会自动恢复/主 Agent 接管 worktree”、`test/subagent-auto-integration-resumed-child.integration.mjs` 钉住该语义）。

因此四个 follower 永远等不到“冲突续跑→自行发布”，probe 等待 5 次发布直到 15 分钟总超时。

## 分类

- 数据全部由合法 public 入口与真实 Host/真实模型产生，身份、时间、资源事实有效；
- 生产行为**符合当前合同**（FIFO 队首自发布 + 已结束 child 走人工接管），不是缺陷；
- 偏离在 probe 的验收场景：它假设五个 child 都能存活到各自集成完成并由冲突续跑自行发布，这属于**auto-resume 被移除之前**的合同。

结论：**probe 场景过期（类别 2 的期望过期），但同时暴露一个真实产品特性**——五个并发 coding child 共用一个 base 时，只有 FIFO 队首能自行集成，其余四个必然变成主 Agent 接管（约 75ms 的 admission 轮询预算决定了 follower 几乎不可能等到准入）。这不是本批引入的回归，也不应为了让 probe 变绿去调生产轮询预算。

## 需要 owner 决策（未擅自改验收语义）

1. **改写 probe 以验收当前合同**：断言队首自发布 + 四个 follower 产出 durable resume intent/已投递 handoff/pending proof/保留 workspace，然后由 probe 扮演主 Agent 接管各 worktree 完成冲突解决与发布（真实覆盖 handoff 路径，工作量较大）。
2. **让 child 存活到自身集成结算**：由 fixture barrier 在 release 后继续等待“本 run 集成已结算”的信号（需要 probe 侧新增信号文件或改为按 run 释放），生产轮询预算不动。
3. **判定该场景已作废**：保留本次真实模型证据（队首发布 + handoff 链），把五-child 自发布验收标为 obsolete，改由既有受控集成测试覆盖 FIFO/冲突/handoff。

三个选项都会改变“验收证明什么”，属产品决策；本轮只保留证据、不选择。

## 已取得的真实证据（不等于验收通过）

真实模型（`qoder-pool/DeepSeek-Flash`，`modelOrigin=explicit`）下已证明：barrier 五-child 同 base 一次释放可用；FIFO 队首经 admission→rebase→发布→queue completed→workspace discard/released→proof receipt 全链贯通；follower 的 proof 保持 pending、resume intent 与 handoff 投递按合同产生、workspace 保留且无 cleanup-debt；无残留进程。**未证明**：四个 follower 的冲突续跑与发布、五份 receipt 齐备、probe 的最终 settlement 断言。

---

# 用户裁决：不拖住 child，工作完成即正常退出

## 裁决内容

用户明确否决“保活 child 到自身集成结算”的方向：**child 工作完成就应该正常退出**。因此本节只记录该裁决的后果与随之失效的验收场景，不实施任何保活手段。

## 与源码事实一致

- child runner 在 run promise 结算后 `process.exit(0)`（`pi-subagents/src/runs/background/subagent-runner-bootstrap.js:218-222`），settled 之后无法靠 ref'd timer/pending promise 延寿；生产 `child-integration-lifecycle.ts:98` 的 `retryTimer.unref?.()` 与此一致。
- 可行的“唤醒”只有两种：run 结束前在 awaited 的 `agent_end`/`agent_settled` handler 内阻塞（`dist/core/agent-session.js:682-696` 显示 extension emit 被 await），或排 follow-up turn（`types.d.ts:331-335,1224-1233`；生产冲突续跑即用 `deliverAs:"followUp", triggerTurn:true`）。两者都会推迟 child 退出、推迟 terminal proof 与父会话完成通知——按本裁决不采用。
- 进程退出后不自动拉起：`createManualIntegrationHandoff` 文案即“系统不会自动恢复该 child…请主 Agent 接管 worktree”，`coordinator-server.ts:284-286` 同义。

## 直接后果

1. **`maxAdmissionPolls=3 × pollDelayMs=25`（约 75ms）不是缺陷**：在该合同下 follower 等不到 FIFO 准入就结束本轮是预期行为，随后产生 durable resume intent 与主 Agent 接管提示。不调生产轮询预算。
2. **五-child“全部自行发布 + 4 次冲突续跑”场景在当前合同下不可能通过**：只有 FIFO 队首能在自己存活期间完成集成；其余四个必然以“已结束 child + 接管提示”收场。probe 的该场景属 auto-resume 移除前的合同，判定为 **obsolete（场景过期）**，不再重跑同一姿势。
3. 若要保留“真实模型下五个 child 的成果最终都进入 main”的验收，唯一符合本裁决的路径是**主 Agent 显式接管**：收到 handoff 后对每个 follower 走 `subagent_run_resume`（新 run/新子会话）→ `recovery.activate-resume` 重绑 workspace/queue → 由 resumed child 解决冲突并发布；或由主 Agent 判定放弃并 preserve/discard。这需要新的 probe 设计与 4 次额外真实模型续跑，属独立立项，未实施。

## 本轮已保留的真实模型证据（部分验收，不等于五-child 通过）

barrier 五 receipt 同 base 一次释放；队首 `e040eb3` 经 admission→rebase→发布→queue completed→workspace released(discard)→proof receipt；4 个 follower 各自 durable resume intent（1 已投递 handoff）、proof pending、workspace active 保留、无 cleanup-debt；5 个 child 全部正常 `complete` 并退出；无残留进程。未证明：4 个 follower 的冲突续跑与发布、五份 receipt 齐备、probe 最终 settlement 断言。

## 现场

三次运行的临时现场均保留（未删除）：`…/repository-merge-queue-acceptance-Xkd9TF`、`…-XYRn5V`、`…-RrLPSD`，以及 `/var/folders/.../T/pi-subagents-uid-501/async-subagent-runs/<runId>` 下对应 child 目录。需要清理时由用户指示，不自动删除证据。

## 追加裁决：不为 FIFO 队列增加 prompt 提示

主会话曾建议在 `pi/AGENTS_GLOBAL.md` 增加一句“并发 coding child 只有队首自行集成、其余以接管提示到达”的静态说明。**用户否决，未实施**，理由采纳：

- 队首集成是自动的，不需要主 Agent 理解队列；
- 其余 child 结束时已有明确的主 Agent 通知（`subagent-integration-handoff`，文案本身即“系统不会自动恢复该 child…请主 Agent 接管 worktree <id>，检查未提交修改并完成提交，然后继续将其送入 merge queue”）；
- 在行动时刻已有定向通知的情况下，再往常驻 prompt 里塞队列机制说明没有收益，只增加理解负担。

据此确立的处理原则（与既有引导归属结论一致）：**机制说明不前置进常驻 prompt；只在行动时刻由回执/通知承载可执行指令**。GLOBAL 未改，任何 profile/skill/tool description 也未因此新增队列解释。若将来出现主 Agent 误把接管提示当失败重派的真实事故，再按事故证据决定是否补文案，不预防性添加。
