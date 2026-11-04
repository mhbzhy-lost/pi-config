# goal-runtime 缺陷①+④ 调研报告：resume 血缘事实绑定断裂与 cancel→replace 门死锁（2026-11-04）

本文是 `docs/investigations/2026-11-04-goal-runtime-usability-defects.md`（下称「原报告」）中缺陷①（resume 血缘事实绑定断裂）与缺陷④（cancel→replace 门死锁）的源码级复核与解决方案设计。所有结论均给出文件+行号级证据；与原报告不一致的事实偏差在第七节显式列出。事故实例：planId b93ae48c，T1 旧 run `8bd518a5-571d-4ca3-a3f0-5330a1d5ee38`（下称 8bd518a5），复活 run `ebb0e5ec-0447-46b9-91a7-9ce1d419917e`（下称 ebb0e5ec），workspace `ff4e45f5`，队列项 `979903af`。

## 一、事实核实（逐条 确认/修正）

### 1.1 缺陷①定位核实：extension.ts:2254-2263 —— 部分确认，机制归因需修正

**代码事实**（`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2238-2270`，`PlanExecutionService.resume` 实现）：

- 2242-2243：`facts = await service.inspect(input.previous)`，要求 `facts.recovery === "typed-resume"`；
- 2246-2257（guardedResume.prepare）：2247-2250 复查 `current.terminalProofRef === facts.terminalProofRef`；2253-2254 要求 `plan.intent.workspaceId === input.previous.workspaceId && plan.intent.sourceProofId === facts.terminalProofRef`，否则抛 `PLAN_RESUME_BINDING_UNKNOWN`；
- 2258-2260：经 `executeControl({action:"resume", …}, …, guardedResume)` 执行；
- 2262-2263：`const runId = reply?.details?.runId ?? reply?.details?.asyncId; if (!nonempty(runId) || runId === input.previous.runId) throw new Error("PLAN_RESUME_BINDING_UNKNOWN")`。

**核实结论**：

1. 「resume 绑定要求 `plan.intent.sourceProofId === facts.terminalProofRef`」——**确认**（2254 行），且同段还要求 workspaceId 相同（2253 行）。
2. 「且 runId 不变」——**修正**：2263 行语义恰好相反，它要求 resume **必须产生新 runId**（`runId === input.previous.runId` 时抛错）。整条 resume 合同（workspace 不变 + proof 继承 + runId 更换）与「复活链两项都不满足」的描述不符。
3. **更重要的归因修正**：这段 guarded 代码只包裹 **goal 引擎经 `execution.resume` 发起的 resume**（`src/goal-runtime/scheduler.ts:518-519`，即 `plan_retry` route="resume" 路线）。本次事故的复活（01:3x `subagent_run_resume`）走的是 `subagent` 工具的 control 路径：`extension.ts:2324` `executeControl(input, …, managedCodingResume)`——传入的是**原始** `managedCodingResume`，不经过 2246-2257 的任何守卫。该路径成功完成了复活，**且全程不通知 goal 引擎**。因此 2254-2263 行不是本次断裂的执行点，它是「引擎侧发起二次 resume」时才会触发的守卫；缺陷①的真正断点在 resume 之后的事实查询与覆写链（见 1.2）。

### 1.2 terminalProofRef / integrationReceiptRef「归零」机制核实

结论先行：**不存在任何显式「清零」操作**。归零 = resume 激活把权威账本重绑到新 run 后，`inspect(旧 run)` 固定降级返回双 ref=null 的 facts，`refreshRuns` 用这份降级 facts **覆写**了 task 上原先有效的两个 ref。复活 run 的事实从未断裂——它们完整存在，只是旧 `task.run` 的查询面永远够不到。

因果链（每步带证据）：

1. **resume 激活重绑**（coordinator `recovery.activate-resume`，`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:494-520`）按 durable 序列执行：
   - `integrationQueue.markResumeStarting(…)`（resume intent → starting）；
   - `workspaceService.rebindRunForRecovery(…)`（`packages/pi-subagents-enhanced/src/workspace/service.ts:252-277`）：workspace 记录的 `record.run` 从 source run 换绑到 resumedRun（幂等、须 active resume intent 授权）；
   - `integrationQueue.rebindChildRunForRecovery(…)`（`packages/pi-subagents-enhanced/src/workspace/integration-queue.ts:199-220`）：队列项 `childRunId` 换到新 run；
   - `markResumeActivated(…)`；
   - `proofOutbox.supersede({sourceProofId, sourceRunId, resumedRunId, resumeIntentId})`（coordinator-server.ts:512-514）——旧 run 的 terminal proof **永久失效**（移出 pending、不可重入队、不计 debt，`coordinator-proof-outbox.ts:88-111`）。
2. **inspect(旧 run) 固定降级**（`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:895-1007` 的 `planExecution.inspect`）：
   - 初始 facts 即降级模板：terminal="unknown"、`terminalProofRef=null`、`integrationReceiptRef=null`、blocker=`PLAN_EXECUTION_FACTS_UNAVAILABLE`（895-899 行）；
   - 906 行 `selectReceipt(ref.runId, ref.workspaceId)` → `subagent-runtime.ts:437-455`：workspaceId 已知时 444 行 `readOwned` 能读到 workspace 记录，但 445 行 `record.run?.runId !== runId`（记录已绑 ebb0e5ec，请求的是 8bd518a5）→ **抛错**；
   - 999-1007 行 catch：不降级为可重派，返回初始模板 → blocker=`PLAN_EXECUTION_FACTS_UNAVAILABLE`、双 ref=null。这与 goal 快照 rev 11 中 T1 的观测（两 ref null + 该 blocker）**完全一致**。
   - 补充：即使假设 coordinator 的 `listOwned({runId:旧})` 能返回重绑后的 workspace，912-917 行的 `record.run?.runId !== ref.runId` 校验也会给出 `PLAN_RUN_WORKSPACE_BINDING_UNKNOWN`——同样非 closed。两条路都堵死。
3. **refreshRuns 覆写**（`src/goal-runtime/scheduler.ts:378-430`）：
   - 387 行 `sameRun(previous.run, fact.run)` 守卫——inspect 降级时 `facts.run = {…ref}`（原样回传），守卫通过，任务继续绑定旧 run；
   - 407-410 行：`fact.blocker !== null` → status=blocked、blocker=PLAN_EXECUTION_FACTS_UNAVAILABLE；
   - **423-424 行：`terminalProofRef: fact ? fact.terminalProofRef : task.terminalProofRef`**——fact 存在（降级 facts）时直接用其 null 值覆写 task 的两个 ref。这就是「归零」点。
4. **永不自愈**：workspace 记录不会绑回旧 run；`PlanExecutionService`（`packages/pi-subagents-enhanced/src/execution/index.ts:26-37`）只有 start/resume/inspect/subscribe 四个方法，**没有任何血缘查询入口**；goal 引擎（`src/goal-runtime/`）也不感知 workspace stateRoot / storageRepositoryId，无法自行读账本。除非人工删除存盘或重启会话（缺陷⑤范围），blocker 永久。

另注：`scheduler.ts:482-485` dispatch() 在新建 intent 时也会把 TaskState 双 ref 置 null（「新 intent 清空旧 run」），但本事故 T1 在 resume 后**没有产生新 intent**（attempt 未变），该路径与归零无关——原报告未指认此点，此处补充排除。

### 1.3 缺陷④定位核实：scheduler.ts —— 确认（行号微调）

`src/goal-runtime/scheduler.ts`：

- **closed 定义：69-72 行**——`provedTerminal(fact) && integrated(fact) && fact.workspaceState === "released" && fact.recovery === "none" && fact.blocker === null`。原报告引 69-72：**确认**。
- **provedTerminal：58-59 行**（terminal ∈ {succeeded,failed} 且 `terminalProofRef` 非空）；**integrated：61-64 行**（`integration==="completed" && integrationReceiptRef` 非空，或 `not-applicable`）。原报告引 58-63：**确认**（63/64 为收尾行，实质一致）。
- **replaceCancelled：342-377 行**（原报告引 344-376，±2 行，实质一致）。关键门禁 358-360 行：对每个有 run 的任务 `const fact = await execution.inspect(task.run); if (!sameRun(task.run, fact.run) || !closed(fact)) reject("GOAL_CANCELLED_REPLACEMENT_REQUIRED", …)`。
- **死锁因果：确认**。task.run=8bd518a5；`inspect(旧 run)` 恒返回 1.2 节的降级 facts（blocker≠null、terminal=unknown、双 ref=null、workspaceState=unknown）→ `closed(fact)` 恒假 → 门恒关。即使 adapter 某天对旧 run 返回新 run 身份的 facts，`sameRun` 也会先拒绝。两条独立防线都要求**血缘重绑**才可能通过。
- **plan_retry 的 GOAL_NOT_ACTIVE：确认**。`retryTask`（566 行起）在 569 行 `assertActive(baseline)`；`assertActive`（316-319 行）对 `status !== "active"` 一律 `GOAL_NOT_ACTIVE`——cancelled 计划被永久拒绝修复路线。
- 补充核实（原报告未展开）：replaceCancelled 353-355 行还有一个无 run 分支——`dispatchKey || workspaceId || status==="running"` 同样拒绝；本事故 T1 有 run，走 358-360 分支。

### 1.4 事故持久层数据复核（现场验证，非推断）

对 `var/workspaces/`（PI_CODING_WORKSPACE_DIR）实际读取验证：

| 结构 | 文件 | 关键字段实测值 |
|---|---|---|
| 队列项 | `repositories/784d2e1d…/integration-queue/979903af….json` | `state=completed`、`childRunId=ebb0e5ec`（已重绑）、`workspaceDispositionReceiptId=bfadb06a`、`candidateHead=81dc5f3`、`completedAt=2026-11-03T17:50:07.568Z` |
| resume intent | `…/integration-queue/resume-0ae337d1….json` | `sourceRunId=8bd518a5`、`resumedRun.runId=ebb0e5ec`、`state=completed`、`delivery=delivered`、`workspaceId=ff4e45f5`、`sourceProofId=195a90be…` |
| proof outbox | `…/terminal-proof-outbox/terminal-proofs.json` | `supersessions["195a90be…"] = {sourceRunId: 8bd518a5, resumedRunId: ebb0e5ec, resumeIntentId: 0ae337d1, supersededAt: 2026-11-03T17:46:45.677Z}` |
| workspace 记录 | `…/records/ff4e45f5….json` | `state=released`、`run.runId=ebb0e5ec`（已重绑）、`actionChallenge.proofHash=195a90be…` |
| authority index | `root-broker-authority/01a1a1e7…/authority-index.json` | entries 中 8bd518a5 与 ebb0e5ec **均有 receipt、均未 revoked**，`supersededTo/continuedFrom` 均未标记，associations=0 |

结论：**「closed」所需的全部事实在持久层完整可查**——released、completed+receipt、终态 proof（新 run 的）、resume 血缘。唯一缺失的是 goal 引擎到这些事实的通道（见第二节）。

## 二、resume 血缘数据可得性（调研问题 4 逐项）

旧 run → 复活 run 的映射存在于以下结构（持久 vs 内存、字段、生命周期、goal 侧可读性）：

1. **integration-queue resume intents（持久，主血缘源）**
   - 位置：`var/workspaces/repositories/<storageRepositoryId>/integration-queue/resume-<resumeIntentId>.json`，索引 `resume-intent-index.json`（`integration-queue.ts:105-115`）。
   - 字段（version `integration-resume-intent.v1`，构造见 `subagent-dispatch/recovery-resume-contract.ts` 的 `createIntegrationResumeIntentV1`）：`resumeIntentId、queueItemId、workspaceId、leaseId、ownerScope{kind,rootSessionId}、sourceRunId、sourceAsyncDir、sourceProofId、attempt、generation、progressFingerprint、noProgressCount、delivery{state,attempts}、state、resumedRun{runId,asyncDir,sessionId,pid,agentProfile}|null、createdAt/updatedAt`。
   - 写入者/生命周期：child 在 integration 完成前终结时由 coordinator 写入（`coordinator-server.ts:349` `requestChildResume`）；状态机 `waiting-head → pending →（markResumeDelivery: debt/delivered）→ starting（markResumeStarting，写入 resumedRun）→ activated（markResumeActivated）→ completed/failed/preserved`；队列项完成时活动 intent 同步标 completed（`integration-queue.ts` completeIntegration 中 `saveResumeIntentUnlocked({…, state:"completed"})`）。**记录完成后不删除，无任何清理代码，durably 永久保留**（含 sourceRunId→resumedRun 映射）。
   - 无 resumedRun 的 intent（waiting-head/pending/delivered 未激活）只有 sourceRunId，不构成映射。
2. **coordinator proof outbox supersessions（持久，审计血缘）**
   - 位置：`var/workspaces/repositories/<storageRepositoryId>/terminal-proof-outbox/terminal-proofs.json`。
   - 字段：`supersessions[sourceProofId] = {sourceProofId, sourceRunId, resumedRunId, resumeIntentId, supersededAt}`（`coordinator-proof-outbox.ts:19,88-111`）。幂等重放拒绝伪造不同 resumedRun；同 source run 的其余 pending proof 一并失效。
   - 生命周期：永久（「保留可审计状态」）；由 `recovery.activate-resume` 成功后写入（coordinator-server.ts:512-514）。
3. **workspace ledger record（持久，仅当前指针）**
   - 位置：`var/workspaces/repositories/<storageRepositoryId>/records/<workspaceId>.json`，`run.runId` 字段。重绑后只保留**当前** owner run，无历史链（`service.ts:276`）。适合做终态一致性复核，不能单独回溯血缘。
4. **队列项 childRunId（持久，仅当前指针）**：同上，只保留当前 run。
5. **AuthorityStore（持久，机制存在但未接线）**
   - 位置：`var/workspaces/root-broker-authority/<rootSessionId>/authority-index.json`。
   - 字段：`entries[runId].supersededTo / continuedFrom` 与 `associations[requestDigest]={sourceRunId, resumedRunId, …}`（`authority-store.ts:9-10,48-52`）。写入入口为 broker RPC `owner.rebind`（`root-broker-server.ts:535-549`；client 定义 `root-broker-client.ts:254`）。
   - **实测：当前 typed resume 流程不调用 `owner.rebind`**（src 内无调用方），事故索引中两个 run 均无 supersession 标记、associations=0。该结构目前不构成可用血缘源，属于一致性债（见开放问题 5）。
6. **内存结构**：root broker 的 `ownedRuns`、extension `bindExecution` 闭包内的 `knownRuns`（extension.ts:2185 附近）均为「runId→ref」缓存，**不含血缘**，随 Host 进程消亡。
7. **goal 引擎侧可读性：不可读**。`src/goal-runtime/` 只消费 `PlanExecutionService`（`packages/pi-subagents-enhanced/src/execution/index.ts:26-37`：start/resume/inspect/subscribe）；goal-runtime 无 stateRoot、storageRepositoryId、仓库路由知识，直读文件会破坏现有分层（adapter 模式是既定边界，`scheduler.ts` 头注「外部资源事实只读消费 execution adapter」）。
8. **host 侧现成先例**：`resolveManagedResumeLineageOwner`（`extensions/subagent-runtime.ts:502` 起）已实现「沿 resume intent 链把旧祖先 run 解析为当前 owner run」：从本 root session 拥有的 workspace 出发收集 `coordinator.recoveryStatus()` 的 intents，逐跳校验 workspace/lease 与首跳一致、防环、跨 workspace/歧义/16 跳深度超限一律 fail-closed，并输出结构化诊断。这是 2026-11-02 commit `017c0982`「归一化 managed resume 旧祖先 run 绑定」的成果，路径 a 可直接复用其算法。

## 三、根因链（缺陷①+④ 同根）

1. `subagent_run_resume`（工具路径，绕过 goal 引擎）成功激活复活：workspace 记录、队列项、proof outbox 全部重绑/失效到 ebb0e5ec——账本一致，但**没有任何通道把「8bd518a5 已被 ebb0e5ec 取代」告诉 goal 引擎**。
2. goal 引擎的 `task.run` 永远指 8bd518a5；`refreshRuns` 的 `sameRun` 守卫（scheduler.ts:387）只接受与 task.run 同身份的 facts，而 `inspect(旧 run)` 因 selectReceipt 身份不符（subagent-runtime.ts:445）恒降级为双 ref=null + blocker=PLAN_EXECUTION_FACTS_UNAVAILABLE 的 facts。
3. `refreshRuns` 用降级 facts 覆写 TaskState（scheduler.ts:423-424）→ 双 ref 归零、blocker 永久（缺陷①表象）。
4. `/plan cancel` 后，`replaceCancelled`（scheduler.ts:358-360）对旧 run inspect 得到的仍是降级 facts → `closed` 恒假 → `GOAL_CANCELLED_REPLACEMENT_REQUIRED` 恒拒（缺陷④门死锁）；`plan_retry` 又被 `assertActive`（316-319）以 GOAL_NOT_ACTIVE 拒绝——实例既不能修也不能换。
5. 集成回执（缺陷②范围）挂在复活 run 的队列项上，同样因无通道不触发 goal 唤醒——即使有通道，也需先解决血缘重绑才能被 `closed()` 消费。

## 四、方案设计：三条候选路径评估

### 路径 a：replaceCancelled / refreshRuns 按 resume 血缘解析最终 run（推荐）

**数据来源**（均已在持久层，无需 schema 扩展）：resume intents（主链，含 sourceRunId→resumedRun、workspace/lease、attempt/generation、state）；workspace ledger record.run（终态一致性复核：解析出的最终 run 必须是记录当前 owner run）。

**需要改动的具体函数与调用方**：

1. `packages/pi-subagents-enhanced/src/execution/index.ts`：`PlanExecutionService` 增加可选方法，例如 `lineage?(ref: PlanRunRef): Promise<{ run: PlanRunRef; chain: string[]; superseded: boolean } | null>`（可选成员保持旧实现兼容；goal 侧检测缺失时维持现状行为）。
2. `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` + `src/subagent-dispatch/extension.ts`：service 实现该方法。实现上抽取/复用 `resolveManagedResumeLineageOwner`（subagent-runtime.ts:502）的链解析，但以 `ref.workspaceId` 起点限定（goal 的 ref 携带 workspaceId，比 run-only 枚举更直接），只接受 `state ∈ {activated, completed}` 且 `resumedRun ≠ null` 的 intent 为有效跳；解析结果用 `workspaceService.readOwned({workspaceId, ownerScope})` 复核 `record.run.runId === 最终runId`，不一致返回 null（fail-closed）。
3. `src/goal-runtime/scheduler.ts`：
   - `refreshRuns`（378-430）：inspect 结果为「降级 facts」（terminal=unknown 且 blocker 非空且 recovery=unknown）或 lineage 报告 superseded 时，调用 `execution.lineage(task.run)`；解析成功则把 `task.run.runId` 重绑为最终 run（经既有 `change()` 持久化，attempt/dispatchKey/workspaceId 不变，只改 run），随后以最终 run 的 facts 重新走现有 apply 逻辑；解析失败维持 blocked（现状语义）。
   - `replaceCancelled`（342-377）：358 行 inspect 前先做同样的血缘解析并对 task.run 做内存态重绑（此处不必持久化——计划即将被替换），再 inspect 最终 run 判 closed。
   - `retryTask`（566-596）：578-580 行 inspect 前同样解析重绑（使已取消/已暂停实例在恢复 active 后 retry 路线可达）。
   - `sameRun` 守卫（387 行）保持不变——重绑发生在守卫之前、且由持久血缘授权，不放宽身份校验本身。
4. `src/goal-runtime/continuity.ts`：`runsClosed`（68-84 行）无需改动——task.run 重绑后 `facts[新runId]` 自然匹配。

**边界情况**：

- 多次复活（链式 resume）：resume intent 按 queueItem 逐 attempt 记录且重绑后的 run 再次终结会生成新 intent（`requestChildResume` 对 resumed run 生成下一 attempt），链解析逐跳跟随，现成算法已支持多跳（上限 16）。
- 复活后又被 stop：解析到最终 run 后 inspect 给出**真实** facts（terminal=failed+proof 等）→ closed 仍可能为假 → replaceCancelled 正确地继续拒绝（资源未闭合），但 blocker 从「事实不可得」变为可行动的真实原因，plan_retry 的 resume/start 路线恢复可达。
- 复活后仍在跑：facts terminal=pending → 正常等待/订阅唤醒。
- 血缘记录缺失或链不可信（旁路 resume、记录损坏）：lineage 返回 null → 维持现状 blocked，fail-closed，交由路径 c 兜底。
- 误判防护：superseded 判定只依据持久 resume intent + workspace 记录，**绝不依据 blocker 文案**（coordinator 暂时不可用导致的普通降级不得触发重绑）。

**可实施性**：高。持久数据已在（第二节已现场验证）；host 侧有成熟链解析先例；goal 侧改动集中在 scheduler 三个函数的重绑前置步骤。风险：接口扩展需两模块同步（本仓 monorepo，风险低）；重绑写 store 须在 `change()` 的 `assertTask` 断言下进行；需新增测试覆盖链解析与重绑（按仓库规范，测试新增需用户授权，见开放问题）。

### 路径 b：接受 integration-queue 台账的 completed + workspaceDispositionReceiptId 作为 integrated 证据（不推荐独立采用）

**需要读取什么**：队列项 JSON（`state==="completed"` + `workspaceDispositionReceiptId` + `childRunId`）。goal 引擎侧读取方式只有两种：直读文件（goal-runtime 不知道 stateRoot/storageRepositoryId/仓库路由，需把 workspace 基础设施的路径知识泄漏进 goal 层，破坏「只读消费 execution adapter」边界）或经 adapter 新增查询 API（那与路径 a 的接口扩展工作量相同，但语义更弱）。

**防伪造**：台账文件与 goal 存盘同为本机可写 JSON；goal 直读等于自证。现有 `inspect` 链路的可信度来自 broker 权威校验（`readOwnerReceipt` 的 authority receipt、`inspectPersistedTerminalProof` 的官方 sidecar + owner 复核，subagent-runtime.ts:924、root-broker-server.ts:632-648）——路径 b 若绕过这些，等于接受未鉴权证据。

**与 closed() 的整合问题（致命）**：`closed = provedTerminal ∧ integrated ∧ released ∧ recovery=none ∧ blocker=null`。旧 run 的 proof 已被 supersede（terminal-proof-outbox），队列项里没有旧 run 的 proof ref；只放宽 `integrated` 后 `provedTerminal(旧 run)` 仍为假——门还是不开。要凑齐还得再读 supersessions（terminal 证据）+ workspace 记录（released 证据），即 goal 引擎自行拼装三份账本、重实现一遍 inspect-with-lineage——分层更差、攻击面更大。

**结论**：不作为独立方案。其背后的真诉求（集成事实变化应唤醒 goal）是缺陷②的订阅通道问题，与路径 a 正交，应单独排期（复用 recovery intent 的 handoff 泵送先例）。路径 a 落地后，`inspect(最终 run)` 本身就携带 completed+receipt 的 integration 事实（subagent-runtime.ts:946-953 receiptMatches 逻辑），integrated 证据自然到位。

### 路径 c：admin 强制闭合 typed 命令（受限兜底，可选二期）

**命令形态**：goal-runtime 新增 model-only typed 工具（如 `plan_admin_close`），参数 `{task_ids?, force_confirm: planId}`；或 `/plan force-close` 子命令。动作 = 在核实通过后把指定任务的 `run` 引用按「已闭合」处置（例如置 `run=null, dispatchKey=null, workspaceId=null` 并在 checkpoint 记录 admin 决策），使 `replaceCancelled` 的 353-360 检查通过。

**核实条件**（缺一不可，否则不做）：(1) `execution.lineage`/`inspect` 证明该 task 血缘最终 run 已 `closed`（released + completed + receipt）——此时它其实是路径 a 的手工触发壳；(2) 若血缘不可解析，则退而要求三份持久证据齐全（workspace 记录 released、队列项 completed+receipt、supersession 记录存在），并要求调用方复述 workspaceId/queueItemId——但这需要 goal 侧读盘能力，同路径 b 的分层问题。

**安全门与权限边界**：仅允许对 `cancelled`/长期 `blocked` 实例操作；`force_confirm` 必须精确复述当前 planId（防误操作）；写入前 `assertIdentity`；每次强制闭合在 checkpoint 留结构化决策记录；工具 exposure=model-only 并在描述中声明「跳过自动核实时目标账本必须由人工确认」。**风险**：若跳过核实直接闭合，等于把 goal 台账的「closed=权威事实」降级为「closed=人工断言」，后续 allClosed→terminal verify 的可信链被污染。

**结论**：不作为主修复。若实现，建议一期只做「核实型」（复用路径 a 的 lineage API 作为核实器），真正跳过核实的「盲闭合」留给极端事故并由用户显式授权。

## 五、推荐方案与影响面

**推荐：路径 a 为主**（缺陷④+① 同根自愈的咽喉），路径 c 作为受限兜底可选二期，路径 b 不采纳（诉求归入缺陷②）。

**理由**：①血缘数据已在持久层完整可查（第二节现场验证），零 schema 扩展；②host 侧已有带 fail-closed 校验的链解析实现可复用（017c0982 先例）；③修好一处，全链自愈——refreshRuns 恢复真实事实、双 ref 从最终 run 继承、replaceCancelled 门打开、plan_retry 路线恢复、缺陷②的集成回执也通过 `inspect(最终 run)` 进入 facts（唤醒通道仍需缺陷②单独解决）；④不放宽任何身份校验（sameRun 守卫不动，重绑由持久血缘授权）。

**影响面清单**：

| 文件 | 改动 |
|---|---|
| `packages/pi-subagents-enhanced/src/execution/index.ts` | PlanExecutionService 增加可选 lineage 查询 |
| `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` | 抽取/导出链解析（自 resolveManagedResumeLineageOwner 泛化），实现 lineage |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | bindExecution 的 service 挂载 lineage 实现 |
| `src/goal-runtime/scheduler.ts` | refreshRuns/replaceCancelled/retryTask 前置血缘重绑；重绑持久化 |
| `src/goal-runtime/contract.ts` | （可选）TaskState 增加原始 runId 审计字段——见开放问题 2 |
| `src/goal-runtime/continuity.ts` | 无必改项（runsClosed 自动适配）；如做 /plan 文案可顺带 |
| 测试 | pi-subagents-enhanced 与 goal-runtime 各需新增用例（需授权） |
| 文档 | goal-runtime 使用文档补「resume 血缘与替换门」章节 |

**风险**：接口扩展的双端同步（monorepo 内可控）；重绑写入的正确性（必须复用 change()/assertTask 串行化路径）；链解析的 fail-closed 语义不得被降级为「找不到就当没发生」；旧版本 goal 存盘（无血缘概念）与新代码的兼容（TaskState 未变 schema，天然兼容）。

## 六、与原报告结论不一致的事实偏差（显式清单）

1. **「resume 绑定要求 … runId 不变」——错误**。extension.ts:2263 要求 runId **必须改变**（相同即抛 PLAN_RESUME_BINDING_UNKNOWN）。
2. **缺陷①的机制归因偏移**。extension.ts:2254-2263 是 goal 引擎侧 `execution.resume` 的守卫；本次事故的复活走 `subagent` 工具路径（extension.ts:2324，原始 managedCodingResume），该守卫根本未执行。真正断点是 resume 后 `inspect(旧 run)` 固定降级（subagent-runtime.ts:445 抛错 → 999-1007 catch）+ `refreshRuns` 覆写（scheduler.ts:423-424）。
3. **「terminalProofRef/integrationReceiptRef 清零」表述不准**。无人执行清零；是降级 facts（双 ref=null）每轮 refresh 覆写此前有效 ref。dispatch() 的 intent 清空（scheduler.ts:482-485）与本事故无关（无新 intent）。
4. **scheduler.ts 行号微调**：replaceCancelled 实为 342-377（报告 344-376）；closed 69-72 ✓；provedTerminal/integrated 实为 58-59/61-64（报告 58-63，实质一致）。
5. **「事实已随复活链转移到新 run」——确认且加强**：事实并未丢，持久层完整可查（resume intent、supersession、workspace 记录、队列项均现场验证），缺的只是 goal→adapter 的血缘通道；因此修复不需要任何持久化 schema 扩展。
6. 补充事实（原报告未提）：AuthorityStore 存在 supersededTo/continuedFrom/associations 血缘机制（authority-store.ts:52），但 typed resume 流程未调用 `owner.rebind`，事故数据中该结构无血缘标记——是一处独立的一致性债。

## 七、开放问题（需主会话/用户决策）

1. **接口扩展形态**：`PlanExecutionService.lineage` 采用可选方法还是版本化新接口名（`pi.plan-execution-services.v2`）？是否同期给 `inspect` 增加 follow-lineage 语义选项（方案上更省一次往返，但语义边界需斟酌）？
2. **TaskState 审计字段**：重绑是否在 TaskState 记录原始 runId（如 `supersededRunIds: string[]`）？涉及 goal 契约 schema 变更与否的最小化取舍。
3. **admin 兜底命令**是否立项（涉及权限边界与「人工断言闭合」的可信度取舍）？
4. **血缘跟随规则确认**：仅跟随 `state ∈ {activated, completed}` 且 `resumedRun ≠ null` 的 intent；`failed/preserved` intent 不触发重绑——确认该 fail-closed 期望。
5. **AuthorityStore supersession 接线**：是否应把 typed resume 的 authority supersession（owner.rebind → supersededTo/continuedFrom）接上，使三处血缘源一致？独立小改进，可另行立项。
6. **缺陷②联动**：路径 a 落地后集成事实可被 inspect 读出，但「队列 completed 主动唤醒 goal」仍缺失；泵送通道（复用 recovery intent handoff 泵送先例）需单独排期。
7. **测试新增授权**：本次调研未改任何 production/测试代码；实现阶段的测试新增需按仓库规范另行获得用户授权。

## 附：验证命令与证据坐标

- 现场数据读取（本机）：`var/workspaces/repositories/784d2e1d…/integration-queue/{979903af…,resume-0ae337d1…}.json`、`…/terminal-proof-outbox/terminal-proofs.json`、`…/records/ff4e45f5….json`、`var/workspaces/root-broker-authority/01a1a1e7…/authority-index.json`（第四节表格的实测值来源）。
- 关键源码坐标：extension.ts:2238-2270 / 2324；subagent-runtime.ts:437-455 / 502-560+ / 895-1007；coordinator-server.ts:292 / 349 / 494-520；integration-queue.ts:105-231 / 199-220；service.ts:252-277 / 802-812；coordinator-proof-outbox.ts:88-111；authority-store.ts:9-52；scheduler.ts:50 / 58-72 / 316-319 / 342-377 / 378-430（尤其 387、423-424）/ 451-535（482-485）/ 566-596；continuity.ts:57-84 / 110-170；execution/index.ts:26-37；pi/extensions/goal-runtime.ts；src/goal-runtime/index.ts:374-391（plan_execute→replaceCancelled 调用点）。
