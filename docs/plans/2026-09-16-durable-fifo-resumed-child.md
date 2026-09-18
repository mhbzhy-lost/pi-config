# Durable FIFO Resumed Child 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 当 managed coding child 在 FIFO admission、rebase 或冲突解决完成前退出时，由 Root Broker 基于 durable queue/resume intent 恢复原 child session，显式重绑定同一 workspace/lease 到新 run，最终完成 child-owned rebase、冲突解决、publish、terminal proof 与 workspace release，并通过单 child 与五 child `2/5/4` 真实验收。

**架构：** coordinator 不替 child 解冲突或 publish；它只持久化 FIFO、创建当前队首的 resume intent、校验 Root 授权并激活 resumed run。Root runtime 使用 upstream `resume` 恢复持久 child session，取得新 runId 后注册新授权，再以 typed coordinator API 原子推进 workspace/queue 的 recovery binding；child 启动时通过既有 integration extension 等待 grant+binding 激活，继续自己的 rebase/冲突/publish。旧 run 的 pending terminal proof 被 durable 标记为 superseded，新 run 的 authoritative proof 才能结算 workspace。

**技术栈：** Node 22 原生 TypeScript、`node:test`、Pi 0.85.1 public Extension/RPC API、只读 `pi-subagents@0.62.0` resume 能力、Git worktree、Unix socket coordinator。

## 全局约束

- `pi-subagents@0.62.0` 不升级、不修改 upstream；Pi 0.85.1 upstream 不修改。
- 禁止使用 `zai-coding-cn` provider；真实验收使用用户批准的非 zai 模型。
- workspace ledger V2-only，不恢复 v1 代码或读兼容。
- 必须维持 child-owned integration：coordinator/Root 不得代替 child 解冲突或 publish。
- trusted binding、FIFO、candidate/target CAS、Git conflict evidence、terminal proof、workspace release 门禁不得降级。
- 不伪造 watchdog、`agent_end`、`willRetry`、terminal proof 或模型完成文本。
- 续轮只能使用 upstream public `resume`，不能 raw 启动/杀死 child 进程。
- production 行为变更遵循 TDD；每项先观察精确 RED，再最小 GREEN。
- T13 前不运行全量 `npm test`；真实 probe 按任务要求只运行一次，失败保留现场。
- 不自动 commit；不使用 `git reset --hard`、`git clean -f`、覆盖性 checkout/restore/stash。
- `pi/models.json`、`pi/settings.json` 不在本计划 WritePaths。
- 单次任务与测试预算低于 30 分钟；真实 LLM probe 单独执行，不与实现任务打包。

## 权威前置证据

- `docs/decisions/2026-09-16-fifo-follower-liveness.md`：watchdog 与 Pi follow-up 不可证明；durable recovery 缺 resumed-child 驱动。
- `docs/bugs/2026-09-15-fifo-follower-admission-exit.md`：child 退出后 FIFO item 永久 queued/resolving-conflict。
- `docs/bugs/2026-09-16-coordinator-sync-git-admission-blocking.md`：同步 Git inspection head-of-line blocking。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/subagent-executor.ts:1708+`：`resume` 支持 completed/failed/paused child，生成新 runId 并复用 retained session；stopped run 不可恢复。
- `packages/pi-subagents-enhanced/src/workspace/service.ts:205-215`：现有 `bindRun` 禁止 runId 替换，必须新增显式 recovery rebind。

## 核心 durable 合同

```ts
type IntegrationResumeIntentV1 = {
  version: "integration-resume-intent.v1";
  resumeIntentId: string;
  queueItemId: string;
  workspaceId: string;
  leaseId: string;
  ownerScope: { kind: "standalone-subagent"; rootSessionId: string };
  sourceRunId: string;
  sourceAsyncDir: string;
  sourceProofId: string;
  attempt: number;
  generation: number;
  queueRevision: number;
  queueState: "queued" | "admitted" | "resolving-conflict" | "prepared";
  conflictDigest: string | null;
  progressFingerprint: string;
  noProgressCount: number;
  requiredAction: "resume-child";
  state: "waiting-head" | "pending" | "starting" | "activated" | "completed" | "failed" | "preserved";
  resumedRun: null | {
    runId: string;
    asyncDir: string;
    sessionId: string;
    pid: number;
    agentProfile: string;
  };
  delivery: { state: "pending" | "delivered" | "debt"; attempts: number; reason?: string };
  createdAt: string;
  updatedAt: string;
};

type RecoveryResumeActivationV1 = {
  version: "recovery-resume-activation.v1";
  resumeIntentId: string;
  queueItemId: string;
  workspaceId: string;
  leaseId: string;
  sourceRunId: string;
  resumedRun: {
    runId: string;
    asyncDir: string;
    sessionId: string;
    pid: number;
    agentProfile: string;
  };
  ownerScope: { kind: "standalone-subagent"; rootSessionId: string };
  generation: number;
  authorization: "root";
};
```

**不变量：** workspaceId/leaseId/ownerScope 不变；sourceRunId 必须等于 workspace/queue 当前 run；resumedRunId 必须不同；同一 generation 只能激活一次；旧 run terminal proof 只能 superseded，不能结算新 run；新 run terminal proof 必须匹配重绑定后的 ledger run。

## DAG

```text
R1 (resume 合同/codec) ──> R2 (resume intent + 队首调度) ──> R5 (Root resume orchestrator) ──> R7 (acceptance harness)
          │                                                        │
          └──> R3 (workspace/queue rebind) ──┬──> R4 (proof supersession)
                    │                       └──> R6 (child activation gate)
R2 + R3 + R4 + R5 + R6 ──> R8 (真实进程/真实 Git 非 LLM 集成)
R7 + R8 ──> R9 (真实 single + 2/5/4 验收) ──> R10 (T13 收口)
```

R5 依赖 R2+R3+R4；R6 仅依赖 R3，与 R5 并行。

## Waves

- Wave 1：R1
- Wave 2a：R2（与 R3 同改 `integration-queue.ts`+`coordinator-server.ts`，串行锁定 intent 状态机）
- Wave 2b：R3（与 R4 同改 `coordinator-server.ts`，串行）
- Wave 2c：R4
- Wave 3：R5、R6（R5 消费 R2+R3+R4；R6 仅消费 R3；两者 WritePaths 不相交）
- Wave 4：R7、R8（R7 消费 R5+R6；R8 消费 R2–R6）
- Wave 5：R9
- Wave 6：R10

**关键路径：** R1 → R2 → R3 → R4 → R5 → R7 → R9 → R10；R6/R8 是并行约束路径。

---

### Task R1：Resume Intent 与 Activation codec

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-contract.ts`
- `test/recovery-resume-contract.test.mjs`

**Resources：** `none`

**Files：**
- Create：`packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-contract.ts`
- Create：`test/recovery-resume-contract.test.mjs`

**接口契约：**
- Produces：`createIntegrationResumeIntentV1`、`parseIntegrationResumeIntentV1`、`parseRecoveryResumeActivationV1`、`progressFingerprint(queueItem)`。
- codec exact-object、deep-freeze；禁止 token、capability、私有 prompt、任意路径；仅 `sourceAsyncDir/resumedRun.asyncDir` 允许规范化绝对路径。

**验收标准：** 合法 intent/activation 往返；未知字段、foreign owner、run 相同、generation 倒退、非法状态、非绝对 asyncDir、token/privatePath 均拒绝；fingerprint 对 queue state/revision/admission generation/conflict digest/candidate head 敏感。

- [x] 编写 codec 与 fingerprint 的失败测试。
- [x] 运行：`node --test test/recovery-resume-contract.test.mjs`，确认 RED 为导出不存在（Cannot find module）。
- [x] 最小实现 exact codec/fingerprint。
- [x] 重跑确认 GREEN（13/13）。
- [x] 运行 `npm run typecheck:subagents-enhanced`（通过）。

---

### Task R2：Durable Resume Intent 与 FIFO 队首调度

**Deps：** `R1`（消费 intent codec/fingerprint）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `test/managed-workspace-resume-intent.integration.mjs`

**Resources：** `none`

**Files：**
- Create：`test/managed-workspace-resume-intent.integration.mjs`
- Modify：`integration-queue.ts`、`coordinator-server.ts`

**接口契约：**
- `integrationQueue.requestChildResume(input): IntegrationResumeIntentV1`：对 queue item/source run/generation 幂等。
- `integrationQueue.promoteRecoverableHead(): IntegrationResumeIntentV1 | null`：只有 FIFO 第一项可从 `waiting-head` 转 `pending`。
- `integrationQueue.markResumeDelivery(...)`、`markResumeStarting(...)`、`completeResumeIntent(...)`、`failResumeIntent(...)`。
- `coordinator.deliverTerminalProof`：若 queue 未 completed，不接受 proof；创建/更新 resume intent。非队首 intent 为 `waiting-head`；队首为 `pending` 并经 recoveryEventSink 投递 `requiredAction: "resume-child"`。
- `completePrepared` 后立即 promote 下一 waiting-head intent；不唤醒其余 followers。
- 同一 fingerprint 连续两次无进展或总 attempt > 6 时转 `preserved`，生成现有 `recovery-intent.v1` 人工债，不无限 resume。
- 边界语义：intent 处于 `waiting-head`/`pending`/`starting` 时 owner root session 退出，run 注册表随 session 失效、无人可 `resume`；由既有 reconcile 失败路径收敛为 preserve 人工债或等待人工处置，不得自动改绑其他 root。测试须断言该边界为 fail-closed。

**验收标准：** 五个 terminal follower 只投递当前队首一个 resume event；队首 completed 后精确投递下一项；重复 proof/event 幂等；进展 fingerprint 变化重置 noProgressCount；两次无进展 fail closed preserve。

- [x] 写 RED：5 follower terminal→1 pending+4 waiting；完成头项→第二项 promoted；重复 proof 不新增 intent；无进展两次 preserve（含 attempt>6 上限、重启持久化、owner 过滤）。
- [x] 运行新测试确认 RED（requestChildResume is not a function）。
- [x] 实现 durable files/index/state transitions。
- [x] GREEN 后回归：`test/subagent-auto-integration-recovery.integration.mjs`、`test/subagent-workspace-recovery-tool.test.mjs`、`test/root-subagent-broker.test.mjs`（43/43），另跑 real-git 4/4、integration-queue 26/26、lifecycle 7/7、service 20/20；typecheck 通过。

---

### Task R3：Root 授权的 Workspace/Queue Run Rebind

**Deps：** `R1`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts`
- `test/managed-workspace-recovery-rebind.integration.mjs`

**Resources：** `none`

**Files：**
- Create：`test/managed-workspace-recovery-rebind.integration.mjs`
- Modify：上述 production 文件

**接口契约：**
- `service.rebindRunForRecovery({ workspaceId, leaseId, ownerScope, sourceRunId, resumedRun, resumeIntentId, generation })`：只允许 active workspace、同 lease/owner/source run、已授权 active resume intent；替换 `record.run` 为 resumed run，幂等重放返回同 receipt；其他替换报 `MANAGED_WORKSPACE_RUN_CONFLICT`。「已授权 active resume intent」通过注入式 validator 校验（service 不持有 integrationQueue 句柄，由 coordinator 层注入），保持分层。
- `integrationQueue.rebindChildRunForRecovery(...)`：同条件将 queue item `childRunId` 改为 resumed runId，revision+1；保留 queue lease/admission generation/sequencer 状态。
- coordinator typed operation `recovery.activate-resume`：仅 Root registration role + `authorization:"root"`；按 durable 顺序：intent starting → workspace rebind → queue rebind → intent activated。每阶段可重放。
- `recovery.recover` 旧 preserve 语义不改。

**验收标准：** foreign root、wrong lease/source/generation、重复不同 resumed run 均拒绝；四个 crash window（starting 后、workspace 后、queue 后、activated 前）重放收敛；原 `bindRun` 仍禁止普通换 run。

- [x] 写 exact RED 与四阶段 fault 注入测试（9 个测试：原子重绑、resumed binding 找回 item、foreign/错误身份拒绝、四个 crash window、重复不同 resumed run 拒绝、bindRun 不放宽）。
- [x] 运行确认 RED（activateResume/rebindRunForRecovery is not a function）。
- [x] 最小实现 rebind transaction 与 protocol/client（coordinator-protocol.ts 经核对无需变更：operation 走既有 binding.register 权限路径）。
- [x] GREEN 后回归 service/coordinator/workspace owner tests：rebind 9/9、resume-intent 7/7、service 20/20、integration-queue 26/26、coordinator 11/11、real-git 4/4；typecheck 通过。

---

### Task R4：旧 Terminal Proof Supersession

**Deps：** `R1`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `test/coordinator-proof-resume-supersession.test.mjs`

**Resources：** `none`

**Files：**
- Create：`test/coordinator-proof-resume-supersession.test.mjs`
- Modify：proof outbox/runtime/coordinator

**接口契约：**
- `proofOutbox.supersede({ sourceProofId, sourceRunId, resumedRunId, resumeIntentId })`，durable 状态 `superseded`；replay 跳过 superseded，不形成 proof debt。
- activation 成功后 supersede source proof；activation 重放幂等。
- 新 run proof 必须匹配 ledger 当前 run；旧 proof 永远不能释放 workspace。

**验收标准：** crash 前后 replay 不重复投递旧 proof；旧 proof status 可审计但不计 unresolved debt；新 proof 正常 observed/released；伪造 resumedRunId 拒绝。

- [x] RED：旧 proof 在 rebind 后 replay 当前会永久失败/debt（4 个测试：单元 supersede/幂等+伪造拒绝/同 run 兄弟 proof 一并失效/完整 activation→supersede→新 proof 结算释放）。
- [x] 实现 supersede receipt/index（含 status/supersessions 审计访问器；enqueue/recordDebt 尊重 supersession）。
- [x] GREEN + terminal proof handoff/outbox 回归（4/4 新增、handoff 7/7、rebind 9/9、resume-intent 7/7）；typecheck 通过；extensions/subagent-runtime.ts 经核对无需变更（共享 outbox 文件由 coordinator 侧 supersede）。

---

### Task R5：Root Recovery Resume Orchestrator

**Deps：** `R2`、`R3`、`R4`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `test/recovery-resume-orchestrator.test.mjs`

**Resources：** `none`；只用 fake RPC/event bus

**Files：**
- Create：orchestrator 与测试
- Modify：runtime/broker/workflow collector

**接口契约：**
- `createRecoveryResumeOrchestrator({ rpc, events, coordinatorClient, registerAuthorizedRun, activateResume, rootSessionId, lifecycleSessionId })`。
- 双通道事件来源：① 本 Host broker push 的 `recovery.event`（快路径）；② 周期调用 `client.recoveryStatus()`（服务端已按 `binding.ownerScope.rootSessionId` 过滤，见 coordinator-server.ts `recovery.status` 分支），保证非 daemon-Host 的 Root 也能发现自己 children 的 pending intent。轮询间隔 bounded（默认 5s），同 resumeIntentId 幂等去重，两通道重叠投递不得重复 resume。
- 调用 public `rpc.resume({ id: sourceRunId, message: RECOVERY_PROMPT })`；禁止 model override/extensionBindings。
- resumed run 身份关联键：resume RPC reply details 自带 `runId`/`asyncDir`（`runs/background/async-execution.ts` async-started details），`subagent:async-started` 事件自带 `id`/`pid`/`sessionId`/`agent`；按 `details.runId === event.id` 关联补全 `{runId,asyncDir,sessionId,pid,agent}`。不依赖 `workflowParentRunId`/`workflowKey`（upstream `resumeParams` 剥离这两个字段，现有 workflow collector 的 accept 过滤对 resumed run 永不匹配）。
- 注册 `createRunAuthorization({ kind:"coding", goal:null, binding:resumedRun })` 后调用 `recovery.activate-resume`。
- `RECOVERY_PROMPT`：检查 git status；如有当前 rebase conflict，只解当前冲突并 `git add`；否则不改业务文件；不调用 integration mutation tool；完成后正常结束本轮。
- resume 失败/缺 session file/timeout 写 delivery debt；不自动改模型。
- 边界：owner root session 关闭时该 session 的 run 不可 resume，事件/轮询随 runtime dispose 停止；由 R2 的 preserve 人工债语义收敛，不得跨 root 自动改绑。

**验收标准：** completed/failed/paused source 可恢复；stopped/live 拒绝；重复 event（含 push 与轮询双通道重叠）不重复 resume；非 daemon-Host 的 Root 经 `recovery.status` 轮询也能发现自己 children 的 pending intent 并完成 resume；新 run 授权先于 activation；失败可重放；foreign root 拒绝。

- [x] 写 fake RPC/event bus RED，覆盖顺序 `resume → child-start → grant → activate`（12 个测试：顺序/去重/resume 失败 debt/activation 失败 debt/事件超时/事件身份不一致/starting 重放/foreign root/attempts 上限/轮询发现/轮询跳过/recovery.status+resume-debt 线协议）。
- [x] 实现 orchestrator（含 RECOVERY_RESUME_PROMPT、runId 关联的 start watcher capture 缓冲、completedKeys/inFlight 去重）。
- [x] runtime 的 `recoveryEventSink` 改为：resume-child intent → 本 Host orchestrator submit（快路径）；legacy preserve → broker durable publish；跨 Host 由 `recovery.status` 轮询通道负责；connectRuntimeCoordinator 新增 rpc 参数并在 close 时 dispose；workflow collector 经核对无需变更（按 runId 关联，不依赖被 upstream 剥离的 workflow 字段）。
- [x] GREEN + root broker/rpc/workflow collector 回归（orchestrator 12/12、root-broker 33/33、worktree-lifecycle 8/8、coordinator 11/11）；typecheck 通过。

---

### Task R6：Resumed Child Activation Gate

**Deps：** `R3`（activation gate 用 R3 的 activation API + fake 驱动即可，不依赖 R5 orchestrator）

**WritePaths：**
- `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts`
- `packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`
- `test/subagent-recovery-activation-gate.integration.mjs`

**Resources：** `none`

**接口契约：**
- session_start gate 在 bounded 30s 内等待：Root grant 可读、`inspect_auto_integration` 能以 resumed run binding 返回原 queue item。
- 仅 gate 成功后创建 lifecycle；等待期间不 preserve、不触发模型、不写业务文件。
- gate timeout 通过 broker/coordinator 记录 recovery delivery debt 并 session_shutdown；不得把 workspace 绑定回 source run。
- resolving-conflict 恢复后 lifecycle 首次 advance 必须走 `continue:true`；queued 恢复按 FIFO claim。

**验收标准：** grant 先/activation 后、activation 先/grant 后两种顺序均收敛；超时 fail closed；conflict worktree 保留 UU/AA/sequencer 直到 resumed child 解决；普通首次 spawn 行为不变；root-session-owner 既有 5s `GRANT_NOT_READY` 重试窗口与 activation 延迟（coordinator 同步 Git 阻塞会放大）不产生竞态误判，gate 的 bounded 等待独立且长于该窗口。

- [x] 写乱序 gate RED（7 个测试：默认超时常量、grant 先/activation 后、activation 先/grant 后、超时 fail closed、acceptance 跳过、普通 spawn 一次通过、resolving-conflict 空 wire 输入）。
- [x] 实现 bounded gate（`awaitIntegrationActivationGate`，事件驱动重试；不 sleep-poll 主链路；超时 fail closed 无 lifecycle）；root-session-owner.ts 经核对无需变更（5s GRANT_NOT_READY 窗口只覆盖 grant，gate 30s 独立覆盖更慢的 workspace rebind）；child-integration-lifecycle.ts 经核对无需变更（continue 由 coordinator durable resolving-conflict 状态推导，已有行为）。
- [x] GREEN + lifecycle/recovery/root-owner 回归（gate 7/7、lifecycle 7/7、recovery 7/7、real-git 4/4）；typecheck 通过。

---

### Task R7：Acceptance Harness 的 Recovery 公共证据

**Deps：** `R5`、`R6`

**WritePaths：**
- `scripts/probes/repository-merge-queue-acceptance.ts`
- `test/repository-merge-queue-acceptance-probe.test.mjs`

**Resources：** `none`；本任务不运行真实 LLM

**接口契约：**
- acceptance receipt 增加 `recoveries[]`：`resumeIntentId/sourceRunId/resumedRunId/workspaceId/queueItemId/attempt/generation/state`，只来自 public coordinator audit/root broker receipts。
- barrier 仍只验证初始五 workspace；resumed child 不重新进入 barrier。
- settlement 要求每个 incomplete terminal source run 最终有 activated/completed resume receipt 或根本无需恢复。
- lifecycle 统计增加 `resumed_child_start`、`resume_activation`；不以模型文本计数。

**验收标准：** 合同测试覆盖 single 无恢复、single 一次恢复、五 child 多次串行恢复、双 Host（follower 属非 daemon-Host，recovery 证据经 `recovery.status` 通道可得）、重复 resume receipt、resume debt、foreign receipt；任何 resume intent 最终 `preserved`/`failed` ⇒ settlement 判定失败并保留现场（不是满足条件；15min `waitForAcceptanceAudit` 超时只是兜底报告，不算通过）；失败现场保留。

- [x] 写 receipt/audit RED（audit 分类测试 + 5 个合同测试：无恢复空 recoveries、一次成功恢复、多 attempt 串行、最新 intent 非 completed 不 settled、双 Host 磁盘真相；另修正既有 receipt keys 断言纳入 recoveries）。
- [x] 最小扩展 parser/validator/diagnostic：administration audit 分类 queue/resume/recovery intent 文件（修复 intent 文件误判为 queue-schema 债的潜在缺陷）；`collectAcceptanceRecoveryEvidence`；receipt `recoveries[]` + lifecycle `resumed_child_start`/`resume_activation`；settlement 要求每个 queue item 最新 resume intent 为 completed，preserved/failed 判定失败并保留现场。
- [x] 运行 probe 合同测试全绿（43/43）与 administration 4/4；real-git 4/4、worktree-lifecycle 8/8；typecheck 通过；不跑真实 probe。

---

### Task R8：真实进程 + 真实 Git 非 LLM Recovery 验收

**Deps：** `R2`、`R3`、`R4`、`R5`、`R6`

**WritePaths：**
- `test/subagent-auto-integration-resumed-child.integration.mjs`
- `test/fixtures/recovery-resume/**`

**Resources：** 最多 1 个本地 Git fixture；不得并发运行其它 real-git 测试

**接口契约：** 消费 R1–R6 production API，不增加 test-only production fallback。

**验收标准：** 真实 child runner process 在 queued、admitted、resolving-conflict、prepared 四阶段退出（production 无写 `state:"rebasing"` 的路径，不得为测试新增状态迁移）；Root orchestrator resume 同一 session 为新 run；重绑定成功；冲突由 resumed fixture child 解；queue completed；旧 proof superseded；新 proof observed；workspace released。重复执行三次无 flaky。

- [x] 为四阶段分别写 RED fixture；证明当前无 resume 驱动失败（RED 阶段暴露两个生产缺陷：recovery descriptor 丢失 workflow 注入的 integration child 扩展；audit queue items 顺序不确定导致 settlement 误判，均已按 TDD 修复并补 bug 文档）。
- [x] 实现后逐阶段 GREEN（非 LLM 确定性 scripted model server + 真实 Pi root host + 真实 child 进程 + 真实 Git worktree + 测试持有 daemon；admitted 用 after-admission fault、queued 用 follower 终止、conflict 用自杀脚本、prepared 用 after-prepared fault）。
- [x] 单文件连续运行 3 次；每次全 PASS（4/4×3），无 skip；另发现并隔离共享 model-exclusions 缓存（PI_MODEL_EXCLUSIONS_PATH 指向测试内路径）。

---

### Task R9：真实 Single 与五 Child 验收

**Deps：** `R7`、`R8`

**WritePaths：** `none`

**Resources：** 真实 Pi `/opt/homebrew/bin/pi`；模型为显式用户输入：运行前必须向用户确认具体 model id（非 zai），未确认不运行；single 与 five 串行

**验收标准：**
- Single `1/1/0`：exit 0，若初始 child 退出则 public recovery receipt activated/completed；queue/proof/release/audit 全绿。
- Five `2/5/4`：五 workspace、≥4 Git conflicts、所有 queued follower 经按需 resume；五 queue completed；五 proof observed；五 workspace released；exit 0。

- [x] 先运行 single 一次；失败保留现场并停止，不跑 five。（超时后保留现场，定位并修复生产缺陷「过早入队固化 base 为 authorizedWorkspaceHead」，重跑 ACCEPTED，详见 five 条目）
- [x] single 通过后运行 five 一次。
  - 第一次 single 超时：现场 `repository-merge-queue-acceptance-Jqo7D4`，诊断出生产缺陷「过早入队固化 base 为 authorizedWorkspaceHead」（bug 文档 `docs/bugs/2026-09-17-premature-enqueue-freezes-base-authorized-head.md`，GLM 首个纯文本 turn 的 agent_end 在 commit 前入队），TDD 修复（授权头后代刷新）后定向回归全绿。
  - 第二次 single `1/1/0` **ACCEPTED**（无 recovery，receipt `repository-merge-queue-acceptance-tu6cnL`）。
  - Five 第一轮 `2/5/4` 超时：现场 `repository-merge-queue-acceptance-YtXCjv`；诊断需可观测性，用户批准加诊断日志（orchestrator 阶段打点 + child lifecycle 链路打点，TDD 各 2 测）。
  - Five 第二轮（UDZ9NE，带日志）：定位生产缺陷「resolving-conflict 的 agent_end 不驱动 durable continue」（bug 文档 `docs/bugs/2026-09-17-resolving-conflict-agent-end-skips-durable-continue.md`：poll 循环状态集合缺 resolving-conflict，冲突已解决时仍发 no-op follow-up 被 acceptance no-staged-files 拒绝）；TDD 修复。
  - Five 第三轮（0TNWsC）：队列 5/5 completed+released，仅 probe 15min 超时（磁盘真相已达成）。
  - Five 第四轮（25min 超时）：**ACCEPTED**，receipt `repository-merge-queue-acceptance-vt9Uj4`：status=accepted，2 roots/5 subagents/4 conflicts，7 次 resumed_child_start + 7 次 resume_activation，7 条完整 recovery receipt。
- [x] 更新主计划 T12 真实验收复选框与 handoff 状态。

---

### Task R10：T13 最终收口

**Deps：** `R9`

**WritePaths：**
- `docs/plans/2026-09-12-pi-0851-repository-merge-queue.md`
- `docs/plans/2026-09-14-pi-0851-session-handoff.md`
- 仅测试发现的精确回归文件

**Resources：** 唯一一次全量 `npm test`

**验收标准：** 聚焦回归、typecheck、`verify:subagents-enhanced`、doctor 全绿；测试债分类完成；只运行一次全量 `npm test`；用户批准后执行计划完成后 reviewer。

- [x] 运行计划 T13 的精确聚焦清单（约 270 项全绿；1 个已定性环境竞态单跑排除）。
- [x] `npm run typecheck`（root+package）、`npm run verify:subagents-enhanced`、`npm run doctor` 全绿；doctor 曾因 `var/workspaces` 16 个 v1 遗留 record fail closed，经用户批准按方案 A 清理（归档 `docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md`，含 11 个遗留 worktree 宿主归属与内容零丢失核查、prunable registration prune、package-local Pi peer 冗余移除验证）。
- [x] 分类并修复本次真实回归；不为 fixture 污染添加 production fallback（本会话引入的 2 处已修复：reviewer/executor profile models 断言同步、fake service 补 `recordTerminalProof`；另修复既有 undici resolver（TDD RED/GREEN）与 process-fleet 连带失败）。
- [x] 唯一一次 `npm test`（分类前基线 879 测 874 过，收尾确认 880 测 878 过；剩2 个已分类既有债：init-pi 引用已删 `external-llm-review`（9/14 未收尾）、native supervisor 覆盖同名工具（需 upstream 仲裁设计），均超出本计划范围）。
- [x] 更新计划/交接文档；顺带修正前序计划 `docs/plans/2026-09-16-five-child-convergence.md` 的复选框簿记（T1–T5 已完成但未勾选）。
- [x] 向用户单独请求计划完成后 reviewer 授权；批准后最多两次 reviewer。
  - 用户批准 astra reviewer（run 9aff78e3，openai-codex/gpt-6-astra）。结论：需修复（非根本缺陷）——核心恢复链、四项不变量、状态机幂等、四个生产缺陷修复、既有债分类、资源清理、上游边界全部复核通过；三项意见（settings/models 归属、lock owner 校验、resume_activation 高估）已全部处置完毕（归属澄清 + 两项 TDD 修复），详见 `docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md` 附录。第一次 reviewer 后无需第二次。

---

## 计划自检

1. **门禁覆盖：** trusted binding→R3/R5；FIFO→R2/R3；child 解冲突→R5/R6/R8；proof supersession→R4；release→R8/R9。
2. **阻塞根因覆盖：** child final-drain 不再依赖 follow-up/watchdog；以 public resume + durable activation 取代。
3. **身份一致性：** upstream resume 新 runId 由 R3 显式 rebind；旧 run 由 R4 supersede；普通 `bindRun` 不放宽。
4. **DAG：** codec 前置；R2→R3→R4 串行（R2/R3 同改 `integration-queue.ts`+`coordinator-server.ts`，R3/R4 同改 `coordinator-server.ts`）；R5∥R6（WritePaths 不相交）后置；probe 与 real-git 后置；真实验收串行。
5. **禁止占位：** 无 TBD/TODO/“以后实现”；若 R5 发现 upstream resume 缺 public child-start identity，按停止条件记录 blocker，不得私自 raw spawn。
6. **范围：** 不改 upstream、不启用 watchdog review、不伪造 runner 事件、不提交代码。
