# Subagent 孤儿恢复实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 在 Root Host/Broker 崩溃、主会话重连或 Supervisor 离线后，安全盘点并恢复合法 standalone subagent，同时保持 durable at-least-once、消费者幂等和用户可见 exactly-once。

**架构：** T0 先冻结现场事实和新增 authority contract；不得把尚不存在的 receipt、generation、lease 或 recovery API 写成既有能力。新增 Root Broker owner receipt/rebind/lease authority 是唯一 owner/stop 边界；workspace 仍只由现有及后续接入的 workspace public service 授权。durable registry 只做 journal/inventory，outbox/barrier 只负责投递与重放。

**技术栈：** Node.js `>=22.19.0`、TypeScript、Node `node:test`、现有 Root Broker RPC、package exports `./workspace` 与 `./workspace/admin`、JSON-only 私有持久化。

## 全局约束

- 当前 Pi 核心版本为 `0.85.1`；本计划不升级 Pi 或 `pi-subagents`。
- `pi-subagents` 固定为 `0.62.0`；不得以升级依赖掩盖生命周期问题。
- 仅修改本计划明确列出的路径；不添加提交步骤。
- `detached` 与 `stop` 必须显式区分；在用户决定默认 graceful shutdown 语义前，不得假定其是 stop 或 detached。
- registry 只记录经过校验的 authorization、Root owner receipt 和 workspace receipt 的 id/digest/revision/reference，不创建、撤销或替代 owner，不改变 workspace disposition，不终止 child，不授予 settlement authority。
- 所有 owner/stop/rebind/lease authority 必须由新增并接入的 Root Broker API 及 workspace public API 授予；不得从 journal 推断 authority，不得直接写 workspace ledger。
- durable storage 使用独立 private root；JSON payload 最大 `32 KiB`，完整 envelope 最大 `64 KiB`，敏感键拒绝，坏文件/无法证明的锁/quarantine 均 fail closed 并记录 `blocked-unknown`。
- delivery 为 durable at-least-once；consumer 以 `eventId + payloadDigest` 去重，用户可见 completion 以 `runId + terminalReceiptId` 去重。
- 现有 integration recovery 默认 `startTimeoutMs = 15_000` 必须保持不变；新增 orphan recovery 使用独立入口，`childStartTimeoutMs = 120_000`，不得覆盖或混用现有 integration 默认值。
- active lease window `30m`、renew interval `5m`、detached window `4h`、waiting-attention window `2h`、专用 broker RPC deadline `5_000ms`；这些是新契约参数，不代表现场已有实现。
- 根 `node --test` 负责跨 package、socket、子进程和 scheduler 测试；package `npm test` 只验证 package manifest/packaging。

## T0 现场事实与契约冻结（已完成，执行 T1 前必须复核）

T0 报告 `/tmp/subagent-orphan-t0-report.md` 是唯一现场依据。当前事实如下，后续任务不得改写为“已存在”：

- `run-authorization.ts:createRunAuthorization`、`assertRunAuthorization` 已存在；`RunAuthorization.binding` 只有 `runId/asyncDir/sessionId/pid/agentProfile`，没有 `ownerGeneration`、`processBirth` 或 OwnerReceipt。
- `root-broker-server.ts:RootBrokerServer.registerAuthorizedRun(authorization): Promise<void>` 已存在；它校验 authorization、Root closing/revocation/session 并捕获 process birth，但不返回 OwnerReceipt。现有 stop 权威是 `stopGoalOwnedRun`，关闭权威是 `closeRootSession`。
- `root-broker-registry.ts:registerRootBrokerAuthorizedRun(authorization): Promise<void>` 只是转发；registry 是进程内 Map/WeakMap，不是 durable owner registry。
- `root-broker-client.ts:challengeRootBroker(..., timeoutMs = 5_000)` 的 5 秒只用于 challenge；`createRootBrokerClient(..., timeoutMs = 10_000)` 的通用默认是 10 秒，不存在通用固定 5 秒 RPC 契约。
- `root-broker-protocol.ts` 当前方法为 `ping/subscribe/acceptance.submit/coordinator.register`，没有 owner generation/rebind/revoke/lease 方法。
- workspace 公开事实来自 `createManagedWorkspaceService`；运行时 receipt 的 schema 是 `managed-workspace.v2`，不是名为 `WorkspaceReceipt` 的导出。`rebindRunForRecovery` 要求调用方注入 `authorizeResumeIntent`。ledger mutate 是内部边界；后续只能从 `./workspace` 或 `./workspace/admin` 调用。
- `recovery-resume-orchestrator.ts` 现有 integration 顺序为 `rpc.resume` → `subagent:async-started` identity 校验 → `registerAuthorizedRun` → `activateResume`，默认 child-start timeout 为 `15_000ms`，不存在 120 秒 orphan path。
- 不存在 `durable-run-registry.ts`、`execution-lease.ts`、`durable-event-outbox.ts`、`replay-barrier.ts`、`supervisor-replay.ts`、`rebind-fencer.ts`，也不存在 scheduler recovery outcome API。
- scheduler 只有现存 `src/task-scheduler/adapter.ts` 和 `pi/extensions/task-scheduler.ts`；不得引用不存在的 scheduler recovery API。

**明确的新 authority boundary（必须先设计再实现）：** 新增 `OwnerReceipt` 不是对现有返回值的命名包装，而是 Root Broker 新 schema。冻结候选字段为：
`{receiptId, rootSessionId, runId, ownerGeneration, processBirth, revision, digest}`。
必须由 Root Broker 产生和校验；`registerAuthorizedRun` 的既有 `Promise<void>` 语义保持兼容，另增明确返回 receipt 的 API 或兼容返回路径，具体 public 名称由 T1 测试先冻结。候选签名为：
`createOwnerReceipt(authorization): Promise<OwnerReceipt>`、
`rebindRun({runId, expectedGeneration, processBirth, lifecycleSessionId}): Promise<OwnerReceipt>`、
`revokeOwner({runId, ownerGeneration, reason}): Promise<void>`。
以上在 T1 前均是待创建契约，不是现场事实。

## DAG

```text
T0（现场事实/契约冻结）
 └─> T1（OwnerReceipt、workspace receipt reference、lease/rebind API 契约）
      ├─> T2（durable storage + inventory journal）
      ├─> T3（Root Broker authority 实现）
      └─> T4（outbox + replay barrier）
T2 + T3 + T4 ─> T5（Supervisor replay）
T2 + T3 + T4 + T5 ─> T6（独立 120s orphan recovery）
T6 ─> T7（scheduler outcome 接入）
```

## Waves

- Wave 1：T0（现场已完成；先核对本节）
- Wave 2：T1（契约冻结，关键路径）
- Wave 3：T2、T3、T4（T3 与 T2/T4 可在契约冻结后并行）
- Wave 4：T5
- Wave 5：T6
- Wave 6：T7

**关键路径：** `T0 → T1 → T3 → T6 → T7`。

---

### Task 1：探索后契约冻结与 authority boundary

**Deps：** `T0`（理由：消费 T0 报告中的实际导出、参数和缺失项）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/contract.ts`
- `test/root-subagent-rebind.test.mjs`
- `test/workspace-recovery-contract.test.mjs`

**Files：** Create：`test/root-subagent-rebind.test.mjs`、`test/workspace-recovery-contract.test.mjs`。 Modify：上述 production 文件，仅加入契约所需类型/协议解析和兼容入口；不得宣称旧 API 已返回 receipt。

**接口契约：**
- Consumes：`assertRunAuthorization`、现有 `registerAuthorizedRun(authorization): Promise<void>`、现有 `managed-workspace.v2` service receipt。
- Produces：冻结 `OwnerReceipt` 字段和 digest/revision 规则；冻结 `createOwnerReceipt(authorization): Promise<OwnerReceipt>`（或同等明确新名）、`rebindRun({runId,expectedGeneration,processBirth,lifecycleSessionId}): Promise<OwnerReceipt>`、`revokeOwner({runId,ownerGeneration,reason}): Promise<void>`；冻结专用 5000ms deadline 注入点；冻结 workspace receipt reference `{workspaceId,leaseId,receiptDigest,revision}`。若最终采用不同名称，必须在本任务测试和后续任务统一替换。

**调用顺序：** `assertRunAuthorization` → 读取 binding → Root Broker 校验现有 process birth → 新 Root OwnerReceipt → workspace public service receipt 校验 → journal reference；rebind 只能 `expectedGeneration` CAS 成功后 issue lease。

**验收标准：** 测试证明旧 `registerAuthorizedRun` 仍是 `Promise<void>` 兼容语义；新 receipt/rebind/revoke 是新增契约；workspace receipt 不伪造 `WorkspaceReceipt` 类型；5s deadline 不改通用 10s 默认；默认 graceful shutdown 的 stop/detached 语义记录为待产品决策。

- [ ] **步骤 1：编写失败测试**：针对新 OwnerReceipt、generation CAS、process-birth mismatch、workspace `managed-workspace.v2` reference 和兼容 Promise<void> 编写 RED。
- [ ] **步骤 2：运行 RED**：`node --test test/root-subagent-rebind.test.mjs test/workspace-recovery-contract.test.mjs`；预期新 schema/API 尚不存在而失败。
- [ ] **步骤 3：实现最小契约**：增加协议类型、parser、错误码和兼容客户端/服务端边界；不实现完整持久化或 orphan 流程。
- [ ] **步骤 4：运行 GREEN**：同命令，预期 PASS。
- [ ] **步骤 5：回归**：`node --test test/recovery-resume-contract.test.mjs test/root-subagent-broker-protocol.test.mjs test/root-subagent-rebind.test.mjs test/workspace-recovery-contract.test.mjs`。

### Task 2：创建 durable storage 与 inventory journal

**Deps：** `T1`（理由：消费已冻结的 OwnerReceipt/workspace reference schema）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-contract.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-run-registry.ts`
- `test/durable-contract.test.mjs`
- `test/durable-storage.test.mjs`
- `test/durable-run-registry.test.mjs`

**Files：** Create：全部列出的文件。

**接口契约：**
- `parseDurableEnvelope(value)`、`parseExecutionLease(value)`、`parseReceiptReference(value)`。
- `writeRevisionedPrivateJson/readRevisionedPrivateJson/withDurableLocks`，独立 storage root、revision CAS、quarantine。
- `recordInventory({authorizationRef,ownerReceiptRef,workspaceReceiptRef,lifecycleState,expectedRevision})`、`loadInventory(rootId)`、`markOrphaned(receipt)`。

**验收标准：** journal 只保存 id/digest/revision/reference，不授予 owner/stop/disposition；锁内不调用 broker/workspace/child RPC；坏 JSON、partial、stale lock、CAS conflict 均 `blocked-unknown` 并保留现场。

- [ ] **步骤 1：编写失败测试**：覆盖大小/敏感键、receipt reference、原子写、0600、CAS、quarantine 和 registry authority 禁止项。
- [ ] **步骤 2：运行 RED**：`node --test test/durable-contract.test.mjs test/durable-storage.test.mjs test/durable-run-registry.test.mjs`。
- [ ] **步骤 3：创建最小实现**：复用 workspace ledger 的原子写模式但使用独立 root；实现 journal，不直接改 ledger。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/durable-contract.test.mjs test/durable-storage.test.mjs test/durable-run-registry.test.mjs`。

### Task 3：实现 Root Broker owner generation、rebind、lease authority

**Deps：** `T1`（理由：消费冻结的 OwnerReceipt 与协议错误码）；`T2`（理由：仅在需要记录 receipt reference 时消费 journal 接口，authority 仍归 Broker）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/rebind-fencer.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts`
- `test/root-subagent-rebind.test.mjs`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/root-subagent-broker.test.mjs`

**Files：** Create：`rebind-fencer.ts`。 Modify：其余文件。

**接口契约：** `rebindRun(...) -> Promise<OwnerReceipt>`、`renewExecutionLease({leaseId,runId,ownerGeneration,processBirth,expectedRenewalSequence,now}) -> Promise<ExecutionLease>`、`releaseExecutionLease(...) -> Promise<void>`；RPC 专用 timeout 为 5000ms。Root Broker 先校验 authorization、现 receipt、process birth，再 generation CAS；child 仅 `observeExecutionLease(runId,leaseId,now)` 和报告 expiry。

**验收标准：** 旧 generation/PID reuse/CAS conflict fail closed；重复 renewal 不延长 expiry；stop 仍只能经 `stopGoalOwnedRun`/既有 close authority；不把 lease/receipt authority 放入 child 或 registry。

- [ ] **步骤 1：编写失败测试**：合法 create/rebind/revoke、旧 generation、PID reuse、重复 renew、timeout、expiry report。
- [ ] **步骤 2：运行 RED**：`node --test test/root-subagent-rebind.test.mjs test/root-subagent-broker-protocol.test.mjs`。
- [ ] **步骤 3：实现最小 broker authority**：新增协议和 fencer，保持旧 register 调用者兼容。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/root-subagent-rebind.test.mjs test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs`。

### Task 4：创建 durable FIFO/outbox 与 replay barrier

**Deps：** `T1`（理由：消费 receipt/cursor 契约）；`T2`（理由：消费私有存储和 reference 校验）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-event-outbox.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/replay-barrier.ts`
- `test/subagent-delivery-recovery.test.mjs`

**Files：** Create：全部列出的文件。

**接口契约：** `appendEvent(envelope)`、`readReplayBatch({rootId,epoch,afterSequence})`、`recordConsumerProcessingReceipt(correlation)`、`ackReceipt(correlation)`、`beginReplayBarrier({rootId,ownerGeneration})`、`switchLiveAfterBarrier(barrier)`。ACK 前不删除；owner generation 只能由 T3 提供。

**验收标准：** FIFO、crash replay、重复 ACK 幂等、旧 epoch/live frame 拒绝；outbox 不写 lifecycle/lease/workspace authority。

- [ ] **步骤 1：编写失败测试**：覆盖 append/投递/ACK 崩溃、重复处理、barrier 高水位和 epoch fencing。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-delivery-recovery.test.mjs`。
- [ ] **步骤 3：创建最小实现**：独立 outbox/barrier 和三类 receipt。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/subagent-delivery-recovery.test.mjs test/durable-storage.test.mjs`。

### Task 5：创建 Supervisor replay

**Deps：** `T2`、`T3`、`T4`（理由：分别需要 inventory、有效 OwnerReceipt/lease、barrier/outbox）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-replay.ts`
- `test/subagent-supervisor-offline-replay.test.mjs`

**Files：** Create：全部列出的文件。

**接口契约：** `replaySupervisor({runId,rootId,requestId,afterSequence}) -> {transportReceipts,processingReceipts,userVisibleCompletionReceipt}`；只读 inventory/receipt，不写 owner/workspace/lifecycle。

**验收标准：** Supervisor 离线、重启、ACK 丢失均可重放；completion 以 `runId + terminalReceiptId` exactly-once；terminal 事实不被 delivery 覆盖。

- [ ] **步骤 1：编写失败测试**：断线、重启、双 resume、ACK 丢失。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-supervisor-offline-replay.test.mjs`。
- [ ] **步骤 3：创建最小 replay adapter**：只组合 T2/T3/T4 public contract。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/subagent-supervisor-offline-replay.test.mjs`。

### Task 6：创建独立 120s orphan recovery path

**Deps：** `T2`、`T3`、`T4`、`T5`（理由：组合 inventory、Root authority、barrier 和 replay receipts）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts`
- `test/subagent-orphan-recovery-crash.test.mjs`
- `test/subagent-orphan-recovery.integration.test.mjs`
- `test/recovery-resume-orchestrator.test.mjs`

**Files：** Create：两份 orphan 测试。 Modify：现有 orchestrator 与既有测试；不得创建第二个 integration orchestrator。

**接口契约：** 新增独立 `recoverDetachedRuns(input)`、`rebindAndReplay(input)`（具体参数必须消费 T1/T2/T3/T4/T5 已冻结类型）；新入口固定 `childStartTimeoutMs: 120_000`。现有 `createRecoveryResumeOrchestrator` 默认 `startTimeoutMs: 15_000` 保持不变。

**调用顺序：** `assertRunAuthorization` → Root OwnerReceipt/process-birth 校验 → workspace public service 的 `managed-workspace.v2` receipt 校验 → inventory match（仅 journal）→ Root Broker generation CAS rebind → issue/rebind lease → replay barrier → Supervisor replay → processing ACK。任一步失败只产生 `blocked-unknown`/debt；terminal/stopped 不恢复；lease expiry 只报告 `execution_lease_expired`，不写 stopped。

**验收标准：** crash/restart 后 transport 可重复、consumer/user-visible completion exactly-once；120s orphan watchdog 与 15s integration watchdog 可分别测试；workspace 变更始终通过 public service；不伪造 terminal/stopped/disposition。

- [ ] **步骤 1：编写失败测试**：真实两个 Node 进程、独立临时 roots，覆盖错误 asyncDir、PID reuse、坏 lease、旧 generation、CAS conflict、每个 crash 点和两个 timeout。
- [ ] **步骤 2：运行 RED**：`node --test test/subagent-orphan-recovery-crash.test.mjs test/subagent-orphan-recovery.integration.test.mjs`。
- [ ] **步骤 3：实现最小串联**：只调用已冻结 public contracts；保持旧 integration path 不变。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：回归**：`node --test test/recovery-resume-contract.test.mjs test/recovery-resume-orchestrator.test.mjs test/root-subagent-broker.test.mjs test/subagent-orphan-recovery-crash.test.mjs test/subagent-orphan-recovery.integration.test.mjs`。

### Task 7：scheduler recovery outcome 接入

**Deps：** `T6`（理由：scheduler 只能消费已实现的 orphan outcome）

**WritePaths：**
- `src/task-scheduler/adapter.ts`
- `pi/extensions/task-scheduler.ts`
- `test/task-scheduler-adapter.test.mjs`
- `test/task-scheduler-package-isolation.test.mjs`
- `test/task-scheduler-runtime.integration.mjs`

**Files：** Modify：上述现有文件；不创建 scheduler recovery API 文件。

**接口契约：** adapter 仅消费 T6 typed union `rebound | blocked-unknown | debt`；不读取 registry private root，不自动重启 terminal/blocked-unknown，同一 detached run 只触发一次。

**验收标准：** trigger/cancel/recover/duplicate schedule 通过现有 scheduler public boundary 验证，保持 membrane/session epoch/shutdown 行为。

- [ ] **步骤 1：编写失败测试**：在现有三个 scheduler 测试中覆盖 outcome union 和重复触发。
- [ ] **步骤 2：运行 RED**：`node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs test/task-scheduler-runtime.integration.mjs`。
- [ ] **步骤 3：最小接入**：只在现有 adapter/extension 转发 T6 outcome。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：最终回归**：`npm run typecheck:subagents-enhanced && npm --prefix packages/pi-subagents-enhanced test && node --test test/recovery-resume-contract.test.mjs test/recovery-resume-orchestrator.test.mjs test/root-subagent-broker.test.mjs test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs test/task-scheduler-runtime.integration.mjs`。

## 计划自检与产品决策门

- [ ] 所有新文件均明确为 Create；现有 `recovery-resume-orchestrator.ts`、scheduler 文件明确为 Modify。
- [ ] 没有把 `OwnerReceipt`、owner generation/rebind/revoke、durable registry/outbox/barrier、120s orphan path 或 scheduler recovery outcome 描述为现有能力。
- [ ] 所有任务均列出真实路径、签名、调用顺序、RED/GREEN 和回归命令。
- [ ] integration `15_000ms` 与 orphan `120_000ms` 是独立入口。
- [ ] **用户仍需决策：默认 graceful shutdown 是 `stop`（经 Root Broker 终止并等待 terminal proof）还是 `detached`（仅脱离 transport、保留 child 与恢复资格）？在该语义冻结前不得实现默认行为。**
