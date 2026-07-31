# 恢复 Executor binding 时遗漏 Root official terminal proof

## 1. 现象

task63bs 的唯一一次 persisted flat Harness 为 RED：两名 Executor 都已有 official `process-terminal.json` observed exit 0，Root 也因 queued completion 启动了新 Plan Runner generation；但新 generation 的第一次 `plan_status` 仍把两个 attempt 显示为 `active`，Plan 保持 `running`，`validatedHead` 为 `null`，没有 settle、integrate、verify 或 `plan.validated` 事件。

该次 Harness 使用 subscription ready barrier，报告确认新 actual generation 收到私有 wake、调用一次 `plan_status`，三个 Plan Runner generation 均正常 terminal。失败不在重复派发、Executor acceptance、fanout 授权、拓扑或进程退出，而在跨 generation completion 恢复。

## 2. 真实证据与反证

保存报告显示两个 Executor 实际目录、两个 assistant `subagent` tool call 和两个 authorization handle 分别精确匹配；两个 Executor 在新 generation 模型 turn 开始前已经 official terminal。Plan projection 版本仍为 `7`，两个 attempt 都停在 `active`，说明新 backend 没有可供 `plan_status` 消费的 `execution.completed` fact。

源码与不写文件的组合探针进一步反证 ready/FIFO 假设：真实 Unix broker、revived actual alias、queued official completion、真实 broker client、Root-owned adapter 和 recovered backend 在当前代码下能按 `queued push -> onPush -> execution.completed fact -> subscription.ready` 闭环。因此 EventBus 同步发布和 ready 顺序本身可以工作；不能再把根因归为 ready 超车。

task63bs 的 owned Harness root 已按边界清理，无法事后读取该次 transient backend。未归属的其他 temp root 不得进入或用于补证。本文件不虚构 task63bs 具体 socket disconnect 或 handler 异常。

## 3. 根因

Root 是 Executor lifecycle 的单写者和 official terminal proof 持有者：`acceptTerminalProof` 将严格验证后的 proof 存入 `terminalProofs`。但 `spawn.lookup` 对 durable spawn 只返回 `state:"spawned"` 和 binding，不返回该 run 已存在的 official terminal proof。

Plan Runner revival 的 `recoverExecutionState` 对 `active` attempt 只调用 backend `recoverBinding`。`recoverBinding` 只重建本 generation 的 `pending`/`byRunId` binding，不查询 Root durable ledger，也不重建 terminal fact。于是 completion 的正确性完全依赖 transient subscription push；一旦新 backend 没消费到该 push，Root 明明已有 official proof，Plan 仍会永久把 Executor 视为 active。

## 4. 正确修复

扩展现有私有 `spawn.lookup` 响应：对 caller 自己的已 spawned durable key，继续返回 exact binding；若 Root 已持有与 binding `runId` 对应的 official observed proof，同时返回该 proof。不得从 `async-complete`、status `complete`、ACK、signal 或文本猜测 terminal，也不得改变 public lifecycle schema。

backend `recoverBinding` 应在完成 exact binding/session 校验并登记本地 ledger 后，查询同一 `dispatchId` 的 durable spawn。只有 lookup 的 state、binding `runId/asyncDir` 与恢复 binding 精确一致，且附带 proof 通过既有 typed `parseProcessTerminal` 严格校验并为 `observed`，才发布一次 `execution.completed` fact。无 proof 时保持 active；malformed、identity mismatch、未知字段或不一致结果一律 fail closed，不能降级为猜测或轮询。

恢复操作仍保持稳定 attemptId 顺序和“先完整 structured validation、后 backend mutation”的既有边界。该修复不 spawn、不 poll、不修改 durable Plan events；后续 `plan_status` 仍是消费 fact 并写入 settle 事件的唯一领域路径。

## 5. TDD 验证

先增加 tests-only RED：

1. Root broker 测试先完成 durable spawn 并注入匹配 official process terminal，随后 `spawn.lookup` 必须返回 exact binding 与 proof；无 proof 时不得伪造，其他 caller 仍不可见。
2. execution backend 测试恢复 active binding 时，让 `lookupSpawn` 返回匹配 binding 和 official observed proof；必须生成唯一 `execution.completed` fact，且不调用 spawn/status/poll。
3. backend 对 malformed proof、lookup binding mismatch、unknown/not-started 或非 observed proof必须 fail closed或保持 active，不能发布 completion；重复同一 recovery 不得重复 fact。

RED 必须只改测试并提交。GREEN 只修改 Root broker lookup、typed proof复用和 backend recovery 所需的最小 production 文件；随后分别运行固定 socket suite、backend/dependencies/Capsule focused gates。真实 persisted flat Harness 仍必须按新基线 exact 一次运行，不能 filter 或重跑同一基线。

## 6. 影响边界

影响范围仅是同一 logical Plan Runner 跨 actual generation 恢复已绑定 Executor 时，对 Root 已证明 terminal 的重建。正常在线 lifecycle push、subscription ready FIFO、dispatch authorization、stable logical caller、actual alias stale fence、Executor exact-once、Supervisor、Attention、cleanup 和 Standalone 退役语义保持不变。

错误修复若接受非 official 状态会提前 settle 仍在运行的 Executor，代价高；若只修 push 时序而不补 durable proof recovery，下一次丢失 transient push 时仍会停在 active。最终必须同时由 focused tests 与一次新的真实 persisted flat Harness 证明。
