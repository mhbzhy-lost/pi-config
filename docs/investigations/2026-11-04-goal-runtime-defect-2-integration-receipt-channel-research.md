# goal-runtime 缺陷②调研：集成队列完成回执 → goal 引擎的送达通道设计（2026-11-04）

调研对象：`2026-11-04-goal-runtime-usability-defects.md` 所报缺陷②「集成队列完成回执没有通往 goal 引擎的送达通道」，及附带的 child 未提交兜底问题。本报告全部结论以本仓源码与 durable 台账现场为证据，对原报告结论「不盲信、逐条复核」，与原报告不一致处以「偏差记录」标出。

仓库根：`/Users/mhbzhy/pi-config`。行号以当前工作区源码为准。

---

## 一、事实核实（缺陷②两条定位）

### 1.1 定位一：integration-queue 队列侧确无 goal 通知钩子 —— 成立

- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts:60-61`：`createIntegrationQueue({ stateRoot, repositoryId, storageRepositoryId, diagnosticSink })` 工厂只接受一个 `diagnosticSink`，且 `diagnose` 仅用于结构化诊断输出（`:61`），不承载任何业务通知。
- 队列终态写入点全量枚举（均只写 ledger 文件，无对外回调）：
  - `completePrepared`（`:322-336`）：写 `state:"completed"` + `integrationIntentId` + `workspaceDispositionReceiptId` + `completedAt`；
  - `completeItem` / `failItem`（`:353-354`，经 `transition`）；`cancelItem`（`:355-358`，需授权）；
  - `preserveByBinding`（`:299-306`）；`settleDispositionQueue`（`:422-456`，处置结算路径写终态并匹配关闭 resume/recovery intent）。
- daemon 侧唯一调用方 `publishRebasedCandidate`（`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:93-117`）在 `completePrepared`（`:105`）之后只做两件 fire-and-forget：`replayTerminalProofs()`（`:112`）与 `pumpResumeIntents()`（`:115`）。后者的出站通道 `options.recoveryEventSink` 在 daemon 生产装配里是恒定 debt stub：
  - `packages/pi-subagents-enhanced/src/workspace/coordinator-daemon.ts:127-131`：`recoveryEventSink: async () => ({ state: "debt", reason: "coordinator daemon durable-only delivery; hosts poll recovery.status" })`。
- 结论：**队列项进入 completed/preserved/cancelled 终态时，不存在任何指向主会话或 goal 引擎的事件出口**。与原报告该条定位一致。

### 1.2 定位二：`continuity.ts` control/resume → reconcile 是否「唯一推进点」 —— 不成立，需修正表述

`src/goal-runtime/continuity.ts:111-139` 的 `control()` 在 `status === "active"`（即 `/plan resume`）时先 `reconcileGoalSession` 再 `runtime.reconcile(session)`，该路径存在（`:127-135`）。但 `runtime.reconcile` / `reconcileGoalSession` 的触发点远不止这一处：

| # | 触发点 | 位置 | 说明 |
|---|--------|------|------|
| 1 | **execution.subscribe 唤醒**（真正的订阅通道） | `src/goal-runtime/index.ts:264-283`（attachExecution），订阅体 `:272-278` | goal 绑定执行服务时调用 `execution.subscribe(listener)`；任何 `broker.notifyExecutionFacts(runId)` 都会触发 `reconcile(session)`。**listener 不检查 runId，任何 run 的事件都全量 reconcile** |
| 2 | agent turn 收尾 | `index.ts:455` 起 `pi.on("agent_before_settle")` | 每个已完成 turn 且未 suspended 时 `await reconcile(session)` |
| 3 | 压缩恢复 | `continuity.ts:201-215` `pi.on("context")`（recoveryPending） | compaction 后恢复 |
| 4 | 导航护栏 | `continuity.ts:230-252` beforeNavigate（fork/tree 前 reconcile + runsClosed） | 防回滚，非推进 |
| 5 | 工具入口 | `index.ts:327`（toolSession）、plan_execute（replaceCancelled 收尾 reconcile） | 模型调用工具时 |
| 6 | 服务可用性 | `index.ts:299-313` `subscribeExecution` 回调 | package 服务后绑定时的补接 |
| 7 | `/plan` 控制 | `continuity.ts:111-139` | 用户手动 resume/pause/cancel |

而 `notifyExecutionFacts` 本身的全部触发源（`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:210-219` 实现，microtask 内按 runId 去重）：`:758`（终局证明冲突）、`:778`（接受官方终局证明）、`:800`（终局证明投递 settle 的 finally）、`:813`（lease 释放 finally）、`:1288`（publishRecoveryEvent）、`:1388`（**每次经 broker 转发的 `coordinator.request` 完成的 finally**）。另在 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:147`（recovery 泵，见第二节）。

**准确表述**：唤醒通道（execution.subscribe → reconcile）是存在的，但其事件源全部是 **run 生命周期事件**（终局证明接受/投递/lease 释放/broker 转发请求完成/恢复事件）。队列终态变化不产生任何对应事件——除非完成恰好发生在某次 run 事件 RPC 的窗口内（例如存活 child 自己经 broker 调 `advance_auto_integration`，`:1388` 的 finally 会顺带唤醒；`deliverTerminalProof` 在同一次 proof RPC 内推进 FIFO 队首完成，`:800` 的 finally 也会顺带唤醒）。

**缺陷②的实质危害**（比「永远等不到」更精确的两层）：

1. **确定性缺口**：daemon 内部完成路径没有伴随 broker RPC 时，完全没有唤醒。包括：daemon 启动恢复 `finishStartupRecovery`→`replayTerminalProofs`/`pumpResumeIntents`（`coordinator-server.ts:603-609`）；FIFO follower 项在队首完成后的异步 replay（`:107-112`）；处置结算 `settleOwnedDisposition`→`pumpResumeIntents`（`:144`）。这些完成发生时主会话可能 idle，之后无任何力量唤醒引擎。
2. **wait 语义退化**：run 生命周期事件耗尽后（证明已接受、投递已 settle、lease 已释放），`hasExecutionFactWakeup`（`root-broker-server.ts:221-225`）要求 `!terminalProofs.has(runId) || executionFactDeliveries.has(runId)` → 返回 false → `inspect` 尾部给出 `wakeup:"unavailable"` + `blocker:"PLAN_FACT_WAKEUP_UNAVAILABLE"`（`subagent-runtime.ts:994-998`）。而 `decideNextAction` 只有 `fact.wakeup === "subscribed"` 才归入 wait（`src/goal-runtime/scheduler.ts:217-228`，wait 文案「等待已订阅的权威运行或集成事实变化」），否则进 blockers。即：集成事实仍在推进中的任务会被判 blocked 而非 wait，且没有任何队列侧事件能恢复订阅语义。

**偏差记录**（对原报告）：

- 原报告「control/resume → runtime.reconcile 是唯一推进点」不准确：reconcile 有七个触发族（上表），其中 execution.subscribe 才是设计上的订阅唤醒通道。
- 原报告「集成事实变化不触发任何唤醒/结算」在本次事故现场不成立：事故里 `/plan resume` 被多次执行且生效（原报告缺陷③自述「reconcile 无事实可推进」），即引擎**被反复唤醒过**；真正卡点是缺陷①——`task.run` 指向复活前旧 run，`inspect(旧run)` 直接失败（详见第四节）。缺陷②的独立危害是上述两层（无 RPC 伴随的完成零唤醒 + wait→blocked 退化），在主会话 idle、集成事实晚于最后一个 run 事件到达时（FIFO follower、延迟发布、跨会话恢复）成为唯一死因。

### 1.3 现场台账佐证

`pi-config/var/workspaces/repositories/784d2e1d07b9e867aa0ed1ee32a01ef511c517b86208a5806b3a0cfe3d47c92e/integration-queue/979903af-121d-45cc-84fd-4d43e69b7df3.json`（仍存在，已读取）：

- `state:"completed"`、`completedAt:"2026-11-03T17:50:07.568Z"`、`workspaceDispositionReceiptId:"bfadb06a-b4bf-4d0e-8502-9dae81bd5294"`、`candidateHead:"81dc5f39…"`、`authorizedWorkspaceHead:"6dbb51b5…"`（主代理接管后代提交）——与原报告证据坐标一致；
- `childRunId:"ebb0e5ec-0447-46b9-91a7-9ce1d419917e"` = **复活 run**（rebindChildRunForRecovery 已把队列项从旧 run 8bd518a5 重绑到复活 run），佐证第四节交互分析的前提。

另核对该仓库 partition 下 `resume-*.json` 三个 resume intent 与多个 `disposition-*.json` 结算记录，与机制描述一致。

---

## 二、先例机制：recovery intent 的 handoff 泵送（完整链路）

原报告所指先例实为两条并行链路：**daemon 侧 durable 落盘 + Host 侧 D7 轮询泵送达**。完整机制如下。

### 2.1 事件源（daemon 侧，durable）

- child 在 integration 完成前退出时，daemon 的 `deliverTerminalProof`（`coordinator-server.ts:305-371`）对仍处 RESUMABLE 状态（`queued/admitted/resolving-conflict/prepared`）的队列项调用 `requestChildResume`（`:349`，写入 `integration-resume-intent.v1` durable 记录，落盘逻辑在 `integration-queue.ts:115-143`：对 queue item/source run 幂等、attempt/no-progress 限流、超限 fail-closed preserve 并生成 legacy recovery intent）。
- 随后 `pumpResumeIntents()`（`coordinator-server.ts:290-303`）：只升级 FIFO 队首的 waiting-head intent（`promoteRecoverableHead`，`integration-queue.ts:145-155`），对 `state:"pending"` 且未 delivered 的 intent 构造 handoff 并经 `options.recoveryEventSink` 投递；投递结果回写 `markResumeDelivery`（delivered/debt）。
- daemon 模式下 `recoveryEventSink` 恒返回 debt（`coordinator-daemon.ts:129-130`），即事件**只落 durable、不推送**，注释明示「hosts poll recovery.status」。

### 2.2 事件 payload（durable 记录与 handoff 消息两层）

- durable 层：`integration-resume-intent.v1`（`packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-contract.ts:27-48`）字段：`resumeIntentId、queueItemId、workspaceId、leaseId、ownerScope{kind,rootSessionId}、sourceRunId、sourceAsyncDir、sourceProofId、attempt、generation、queueRevision、queueState、conflictDigest、progressFingerprint、noProgressCount、requiredAction:"resume-child"、state（waiting-head/pending/starting/activated/completed/failed/preserved）、resumedRun、delivery{state,attempts,reason}`。
- 消息层：`createManualIntegrationHandoff({resumeIntentId, sourceRunId, workspaceId, queueItemId})`（`recovery-resume-contract.ts:54-59`）→ `{ customType:"subagent-integration-handoff", content:<中文接管指令>, details:{四字段} }`。

### 2.3 Host 侧 D7 轮询泵（送达与唤醒）

`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:121-152`（`connectRuntimeCoordinator` 内）：

1. `setInterval(pumpResumeHandoffs, 5_000)` 且 `unref`（`:152-153`）；`closing/pumpBusy/!lazy.hasClient()` 时空转跳过——daemon 缺位不拉起，保持 D1/D2 懒加载。
2. `client.recoveryStatus()` = coordinator `recovery.status` RPC（`coordinator-server.ts:459-463`，按 `ownerScope.rootSessionId` 过滤返回 recovery + resume intents）。
3. 过滤 `requiredAction==="resume-child" && state==="pending" && delivery.state!=="delivered"`（`:135`）。
4. 重建 handoff（durable intent 不携带 handoff，`:137-139`）后 `pi.sendMessage(handoff, { deliverAs:"followUp", triggerTurn:true })`（`:141`）——**送达目标是主会话模型**（触发一个 turn），不是 goal 引擎接口。
5. 幂等回写 `client.resumeDelivered(...)`（`recovery.resume-delivered` RPC，`coordinator-server.ts:477-485`）；失败保留 debt 由下轮重放，注释明示「极端下可能重复触发一次 followUp，消费方幂等」（at-least-once）。
6. **唤醒 goal**：`finally { broker.notifyExecutionFacts(entry.sourceRunId) }`（`:147`）→ `RootBrokerServer.notifyExecutionFacts`（`root-broker-server.ts:210-219`）→ goal 的 `execution.subscribe` listener（组装链：`extension.ts:2280-2296` 的 service.subscribe → `broker.subscribeExecutionFacts`，`root-broker-server.ts:205-208`；goal 侧订阅 `index.ts:272-278`）→ `reconcile(session)` → `refreshRuns` → 逐任务 `execution.inspect`。

### 2.4 订阅与消费的组装层（goal 与 package 的现有接缝）

- 进程内服务注册表：`packages/pi-subagents-enhanced/src/execution/index.ts:37-77`（`Symbol.for` 全局 registry，`bindPlanExecutionService` / `getPlanExecutionService` / `subscribePlanExecutionService`）；package 在 `subagent-dispatch/extension.ts:2296` 绑定服务。
- goal 侧入口 `pi/extensions/goal-runtime.ts:22-27`：`resolveExecution` + `subscribeExecution` 都走该 registry；`src/goal-runtime/index.ts:4-6` 已 import `pi-subagents-enhanced/execution` 与 `pi-subagents-enhanced/workspace` 公开入口。
- `subscribe` 语义：**只传 runId、不传 facts**（`execution/index.ts:24`），事实永远由 `inspect` 权威拉取（pull 模型）。`extension.ts:2280-2296` 的 service.subscribe 还会在订阅时对已知 runs 逐个补一次 inspect + notify（订阅竞争窗口补齐）。

---

## 三、通道方案设计：集成回执 → goal 订阅事实

### 3.1 目标语义

队列项终态（completed/preserved/cancelled）变化应成为 goal 引擎可订阅的事实，并触发 reconcile-wake；送达 at-least-once、消费幂等；不引入 daemon→Host 推送新基础设施（见 3.5 决策点）。

### 3.2 推荐方案 A：durable 回执事件表 + 复用 D7 Host 泵 + notifyExecutionFacts

完全沿用第二节先例的「durable 落盘 + Host 轮询 + broker 唤醒」三层形态。

**(1) 事件触发点（integration-queue.ts，daemon 进程内）**

在写终态的同一 `ledger.withLock` 临界区内追加一条 durable「integration-receipt-event」记录（新 index 文件，例如 `queue-receipt-events.json` + 每事件一文件，与 recovery/resume intents 的存储形态并列；不与既有 `disposition-settlement-index.json` 混用；localCoordinatorView 的只读形态见 `subagent-runtime.ts:237-263`）。挂点：

- `completePrepared`（`integration-queue.ts:322-336`）→ `state:"completed"`；
- `transition`（`:443`，被 `completeItem:353` / `failItem:354` 使用）→ completed/preserved；
- `cancelItem`（`:355-358`，授权取消）→ cancelled；
- `settleDispositionQueue`（`:422-456`）→ 结算终态（completed/cancelled/preserved）；
- `preserveByBinding`（`:299-306`）→ preserved。

只对「进入终态」建事件（幂等键 `queueItemId + state`；重复终态写入本就被状态机拒绝）。与 `completePrepared` 现有「同一锁内匹配关闭 resume intent」的注释（`:331-333`）一致的锁内原子性原则。

**(2) payload 字段**（对齐 recovery-event.v1 的最小充分集）：

```
schemaVersion: "integration-receipt-event.v1"
queueItemId, workspaceId, leaseId, childRunId,          // 绑定身份；childRunId 为 rebind 后最终 run
ownerScope: { kind: "standalone-subagent", rootSessionId },  // 泵侧 owner 过滤键
repositoryId,
state: "completed" | "preserved" | "cancelled",
attempt, revision,
candidateHead?, integrationIntentId?, workspaceDispositionReceiptId?,  // completed 附带
completedAt | preservedAt | cancelledAt,
delivery: { state: "pending" | "delivered" | "debt", attempts, reason? }   // 泵送达账本
```

**(3) 读取面（coordinator-server.ts）**

两个等价实现，取一：扩展 `recovery.status` 返回体（追加 `receiptEvents` 数组，同样按 `binding.ownerScope.rootSessionId` 过滤、只含未 delivered），或新增独立 RPC `queue.receipt-events`。注意 `queue.audit`（`:373-376`）已聚合 recoveryIntents + notificationDeliveryDebt，运维审计面可同步带上；`recovery.status` 现实现见 `coordinator-server.ts:459-463`。

**(4) Host 泵（subagent-runtime.ts connectRuntimeCoordinator，主会话进程）**

在现有 `pumpResumeHandoffs` 同一 5s 定时器内（或兄弟函数）：

1. 拉取 receipt events（daemon 存活时经 `lazy.preferClient()`；沿用 `hasClient()` 门，daemon 缺位空转）；
2. 对每条事件 `broker.notifyExecutionFacts(event.childRunId)` ——唤醒键用**队列项当前 childRunId（即 rebind 后的最终 run）**；
3. 回写 delivered（新 RPC 或复用事件 delivery 更新方法），失败留 debt 下轮重放（at-least-once）。

**(5) goal 侧消费点：零改动**

- wake：`index.ts:272-278` 的 subscribe listener 已忽略 runId、全量 `reconcile(session)`；
- facts：仍由 `scheduler.refreshRuns`（`scheduler.ts:378-427`）→ `execution.inspect(ref)` 权威拉取；`inspect` 的 receiptMatches 分支（`subagent-runtime.ts:943-946`）已把 `queueState==="completed" && workspaceDispositionReceiptId===receipt.receiptId` 投影为 `integration:"completed" + integrationReceiptRef`。
- 消费点选择结论：**continuity.ts 不动、scheduler 不动**；goal 引擎在该通道上无需任何代码变更，唤醒后的事实正确性取决于 inspect 可达（见第四节缺陷①约束）。

**(6) 与 reconcile 的衔接与幂等**

- `reconcile`（`index.ts:241-263`）自带 invalidated/refreshing 合并与尾部补刷（「只按该通知补刷，不轮询」），重复 wake 自然合并；
- `refreshRuns` 仅在任务投影变化时写 revision（`scheduler.ts:431`）；`wakeIfIdle`（`index.ts:219-240`）用 `wakeFingerprint` 去重续跑 turn；
- broker 层 `notifyExecutionFacts` microtask per-runId 去重（`root-broker-server.ts:210-219`）；
- durable delivery 账本防跨 Host 重启重复泵送；即便重复（Host 重启后重放），全部下游幂等。三层幂等与先例「消费方幂等」注释一致。

**(7) 依赖方向合规性**

- 方向：package（extensions/subagent-runtime.ts，package manifest 声明的 Host 入口）→（进程内）`broker.notifyExecutionFacts` → `PlanExecutionService.subscribe` → goal。goal 不 import 队列内部；package 不 import root `src/**` 或 `pi/extensions/**`（符合仓规范）。**不需要反向注册、不需要新事件总线**——`execution/index.ts` 的 symbol registry 即现成进程内服务发现。
- 若 goal 侧未来需要按 workspace 查询回执，应经 `pi-subagents-enhanced/workspace` 公开入口（goal 已在用其 `resolveRepositoryIdentity`，`index.ts:5`），不得深引用 `integration-queue.ts`。

**(8) 进程边界**

- 队列事实的**权威写入**在 coordinator daemon（detached 独立进程，`coordinator-spawn.ts:192-197`；idle 归零退出，`coordinator-daemon.ts:200-217`）；goal 引擎在主会话 extension（`pi/extensions/goal-runtime.ts`）。daemon 无出站推送能力（2.1 的 debt stub 是设计事实），现行受认可的跨进程送达模式就是 **Host 轮询（D7）**。方案 A 不新增 daemon、不新增持久化机制类别（durable 事件文件与 recovery intents 同类同目录），泵在 daemon 缺位时空转，不破坏 D1/D2/D3/D5 懒加载语义。

### 3.3 备选方案 B：无事件表的台账 diff 泵

Host 泵直接只读拉取队列台账（`createIntegrationQueue().listQueue()` / `localCoordinatorView` 同一 durable 文件，`subagent-runtime.ts:237-263`），内存 diff 出「新进入终态的项」→ notify。

- 优点：零 daemon 改动、实现最小。
- 缺点：无 delivery 账本，Host 重启后全量重通知一次（幂等无害但有噪音）；「已投递」不可审计；diff 状态需含 revision 防止同名终态重写误报。
- 适用：作为方案 A 的先导实验或降级路径。

### 3.4 明确不做（并列为决策点）

daemon→Host 主动推送（现有 coordinator socket 加 push 帧、或文件 watcher）。改动面大、与 D1–D7 哲学相悖；当前无证据表明 5s 轮询时延不可接受。**若未来有强实时需求，作为独立决策点上报，不并入本通道。**

### 3.5 方案对比小结

| 维度 | A：durable 事件 + D7 泵（推荐） | B：台账 diff 泵 | C：daemon 推送 |
|------|------|------|------|
| daemon 改动 | 事件写入 + 读取 RPC | 无 | 新协议面 |
| goal 改动 | 无 | 无 | 无 |
| 送达语义 | at-least-once + durable 账本 | at-least-once + 内存 diff | 准实时 |
| 与先例一致性 | 完全同构（recovery intents） | 部分同构 | 相悖 |
| 风险 | 事件表膨胀（终态一次性，量小） | 重启重扫噪音 | 跨进程耦合、新基础设施 |

---

## 四、与缺陷①④修复（run 重绑）的交互

### 4.1 缺陷①定位复核

`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2238-2273`（`PlanExecutionService.resume`）：要求 `inspect(previous).recovery === "typed-resume"`（`:2243`、二次复核 `:2248`）且 `managedCodingResume.prepare` 返回的 `plan.intent.sourceProofId === facts.terminalProofRef`（`:2253-2254`）。用户经 `subagent_run_resume`（control 命令）复活 child 时**不经过该入口**，goal 的 `task.run` 永不更新；且复活必然换 runId（`:2263` 要求新 runId ≠ previous.runId）。权威侧 meanwhile 已完成重绑：daemon `recovery.activate-resume`（`coordinator-server.ts:486-522`）执行 `rebindRunForRecovery`（workspace ledger）+ `rebindChildRunForRecovery`（queue item，`integration-queue.ts:199-217`）。错位是结构性的：**goal 引擎没有任何按 resume 血缘重绑 task.run 的代码路径**。

### 4.2 错位的消费后果（本次事故的直接卡点）

`refreshRuns`（`scheduler.ts:378-427`）按 `task.run`（旧 run）inspect：`selectReceipt`（`subagent-runtime.ts:437-453`）`readOwned(workspaceId).run.runId !== 旧runId` → `repositoryError` → `inspect` 的 catch（`:999-1004`）→ `facts.blocker = "PLAN_EXECUTION_FACTS_UNAVAILABLE"` → 任务 blocked、两 ref 不再刷新。与实测快照（T1 `terminalProofRef/integrationReceiptRef` null、blocker=PLAN_EXECUTION_FACTS_UNAVAILABLE）完全吻合。**因此事故现场「引擎等不到 integrated」的直接原因是缺陷①；唤醒本身发生过（/plan resume 反复触发 reconcile）。**

### 4.3 completed 回执到达时 childRunId 是复活 run，如何对上 task.run

- 方案②（本报告）的 wake 键是队列项 `childRunId` = 复活 run（台账 979903af 佐证：`childRunId:"ebb0e5ec…"`）。goal 的 subscribe listener 不看 runId，全量 reconcile——wake 不需要对键；**需要对上的是消费**：`refreshRuns` inspect 的对象是 `task.run`。
- 重绑必须发生在 goal 侧 store：候选实现为 `refreshRuns`（以及 `replaceCancelled` 的逐任务 inspect 前）先经 resume 血缘链把旧 run 解析为最终 run 并重写 `task.run`，血缘证据 = durable resume intent 链（`sourceRunId → resumedRun.runId`，`integration-resume-intent.v1`；package 已有链式解析先例 `resolveManagedResumeLineageOwner`，`subagent-runtime.ts:502-580`），写回须保持 `assertTask` 的 attempt/dispatchKey 一致性（`scheduler.ts:277-285`）。若试图只在 package 侧 `inspect` 内部解析血缘并返回最终 run 的事实，`refreshRuns` 的 `RUN_IDENTITY_MISMATCH` 断言（`scheduler.ts:387`，要求 `sameRun(previous.run, fact.run)`）会直接拒绝——所以「goal 侧重绑」不可绕过。
- 已验证的收敛事实：今日代码里 `inspect(最终 run)` 已能给出闭合事实——台账 completed + receipt 匹配 → `integration:"completed"` + receipt（`subagent-runtime.ts:943-946` receiptMatches）→ terminal + released → `blocker:null` → `closed`（`scheduler.ts:69-72`）→ `delivered`。即缺陷①重绑落地后，②的 wake 能直接转化为结算，且缺陷④的 `replaceCancelled`（`scheduler.ts:342-376`，按 `task.run` inspect 并要求 `sameRun && closed`）随 task.run 指向最终 run 自动解锁，无需单独改④。

### 4.4 两条修复是否必须一起上

**机制独立、可分别生效；建议按 ①+④ → ② 顺序落地，无需原子合入。**

- ②不依赖①：无 resume 的常规路径（child 存活自发布，或队列在 child run 事件窗口外完成）下，wake → inspect(task.run) → closed → verifying/accepted → wakeIfIdle 续跑，直接闭环；
- ①不依赖②：用户驱动 reconcile（/plan resume、agent turn settle、工具入口）即可收敛事实；缺②只损失 idle 会话的自主唤醒与 wait 语义（1.2 节两层危害）；
- resume 血缘场景下②的 wake 只有在①之后才能转化为结算（wake 到达时 inspect(旧 run) 仍抛 PLAN_EXECUTION_FACTS_UNAVAILABLE），即**②在该场景的收益被①屏蔽**——这是「①+④ 先行」排序的理由，而非合并发布的理由。

---

## 五、运维澄清四条核实（含兜底建议）

| # | 原报告表述 | 核实结论 | 证据 |
|---|-----------|---------|------|
| 1 | 发布目标 = 本地 origin 仓 main（rebase-ff + fast-forward 本地 main），不推 GitHub | **准确** | `fastForwardManagedGitWorkspace`（`git-worktree.ts:625-654`）在本地 canonical origin 检出（`record.request.originRoot`）执行 `git merge --ff-only candidateHead`（`:644`）；workspace 模块全部源码 grep 无任何 `git push` 调用。「origin」指本地主仓，非 GitHub 远端 |
| 2 | rebase 发布后 worktree 原提交对象不可达并被清理 ≠ 代码丢失；以 candidateHead 与本地 main reflog 为准 | **与源码一致（间接证据）** | `managedGitRebase`（`git-worktree.ts:449-479`）rebase 生成新提交；队列只持久化 `authorizedWorkspaceHead/candidateHead`（台账：`6dbb51b5→81dc5f3`），原提交不再被引用，gc 后不可达属 Git 正常行为 |
| 3 | 父侧 `managed_workspace_dispose(integrate)` 对 publication=allowed 返回 CHILD_OWNS_INTEGRATION 是护栏设计 | **准确** | `service.ts:569` 抛 `CHILD_OWNS_INTEGRATION: "integration is owned by the child integration queue"`；`tool.ts:31/68/95-96` 将其文档化为设计内行为 |
| 4 | child 必须在 run 终结前在自己的 worktree 内提交，否则队列项发布不了 | **机制准确** | admission 链 `admissionFactsForClaim → integrationAdmissionFacts`（`service.ts:290-305`）要求 `hasCommits && clean && descendant`，未提交即拒绝；`deliverTerminalProof` 的 no-payload discard 分支（`coordinator-server.ts:325` + `git-worktree.ts:344-349`）仅在 `clean && headCommit===baseCommit && aheadCount===0`（完全无产出）时成立——**有未提交修改时两路都不通**，项停留 resumable → `requestChildResume` + handoff（`coordinator-server.ts:326-352`），即「发布不了、需人工接管」 |

### 5.1 第 4 条的兜底改进建议：**不做 runtime 自动 commit；维持「派发合同必做步骤 + 文档化」，并做一处低成本 prompt 强化**

理由：

1. **writePaths 违约风险**：admission 断言 `changedFiles ⊆ policy.writePaths`（`service.ts:299` `assertManagedWorkspaceWritePaths`）。自动 `git add -A && git commit` 会把 writePaths 之外的脏文件（构建产物、误改文件）固化进提交，产生**永久不可 admit 的队列项**——比现状（fail-closed + handoff 人工处置）更糟。
2. **半成品直进 main 的完整性风险**：autoManaged 队列 rebase-ff 后 `fastForwardManagedGitWorkspace` 直接推进本地 main。未经人工核对的半成品/垃圾 commit 会自动发布到主干，绕过现有「主 Agent 接管检查后提交」的护栏（handoff 文案即要求先检查未提交修改再提交，`recovery-resume-contract.ts:56-58`）。
3. **责任与审计边界**：host/daemon 代 child 提交等于伪造 authorship，与全链贯穿的「coordinator 不猜 / fail-closed」哲学（recovery 泵注释、`processAliveStatus` 的 ESRCH-only 判死等）冲突。
4. **现有兜底已存在且有效**：未收尾时会产出 handoff followUp（triggerTurn，唤醒主会话模型）与 completion reminder（`completion-reminder.ts:36-90`，按 run+workspace 去重、delivery debt 可观测）。
5. **低成本强化（建议采纳）**：在 goal 派发 prompt 构造器 `prompt()`（`scheduler.ts:440-448`）追加一行收尾指引（如「结束前必须在 worktree 内将交付物显式 git add + commit」），并在派发合同/文档中固化为必做步骤——这正是原报告第 4 条建议的落地形态，无 production 行为变更风险。

---

## 六、推荐与影响面

**推荐**：方案 A（durable integration-receipt-event + 复用 D7 Host 泵 + `notifyExecutionFacts(childRunId)` 唤醒），goal 侧零代码改动；与缺陷①④修复（goal 侧按 resume 血缘重绑 task.run）按「①+④ 先行、② 随后」顺序分别落地。

**理由**：与仓库既有先例（recovery intents 的 durable + 泵 + broker 唤醒）完全同构；不新增进程、不新增持久化机制类别、不引入 daemon→Host 推送；三层幂等（broker 去重 / reconcile 合并 / durable delivery）保证 at-least-once 安全；依赖方向合规（package → 进程内 broker → PlanExecutionService.subscribe → goal，goal 已依赖 package 公开入口）。

**影响面**（未来实施时的改动清单，本次调研未改任何代码）：

- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`：终态写入点追加事件记录（锁内）；
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`：事件读取 RPC（或扩展 recovery.status）；
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`：D7 泵扩展消费回执事件；
- 测试：事件落盘幂等、泵送达/重放、owner 过滤、与 resume intent 泵互不干扰；
- goal-runtime：无改动（缺陷①④另行立项时才动 scheduler/continuity）。

**风险**：

- 5s 轮询时延（与 handoff 泵一致；goal 引擎设计本身是「等待事实通知，不轮询」，送达时延不改变正确性）；
- 事件表体积（终态一次性事件，每队列项至多一条，量级与 disposition intents 相当）；
- daemon 重启窗口内事件保留在 durable 表，由下轮泵补送；
- 若 preserved/cancelled 也唤醒（建议唤醒），可能产生「blocked 需人工」噪音——属正确语义（blocked 分支本来就要人看）。

---

## 七、开放问题

1. **daemon→Host 推送**是否为长期必要（强实时场景）：本报告明确不设计，需产品决策后再立项（3.4 节）。
2. **preserved/cancelled 是否与 completed 同权重唤醒**：建议三者都入事件表并唤醒（failed/preserved 语义上需要 goal 侧转 blocked/人工路径），但是否对 `preserved` 增加节流待定。
3. **`inspect` 的 "no-payload settlement identity unavailable" 分支**（`subagent-runtime.ts:956-959`）：discard/release 结算后 goal 的 integration 投影恒 blocked，缺 not-applicable 语义。与缺陷②相邻但独立，建议单列缺陷跟踪（涉及 ops 第 4 条的「完全无产出」路径）。
4. **child 未提交的 child 侧自检提醒**（agent_end 时 dirty 则向 child 发 followUp 提醒提交）是否立项：比 host 代提交安全的自动化形态，但属 child runtime 行为变更，需单独评估。
5. **事件读取 RPC 形态**：扩展 `recovery.status`（零新方法）vs 独立 `queue.receipt-events`（面更清晰）；以及 `queue.audit` 是否同步聚合回执事件供运维审计。
6. **缺陷①重绑的写点细节**：`refreshRuns` 内联重绑 vs 独立 reconcile 步骤；重绑证据是否要求同时核对 workspace ledger owner run（与 `rebindChildRunForRecovery` 的校验对齐）——实施缺陷①时定案。
