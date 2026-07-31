# Bug：Executor owner 绑定前 Supervisor request 被静默丢弃

## 症状

冻结 HEAD `0fbc18e` 的真实 A2 Harness 只运行一次即 RED。持久化 Root session 收到四个唯一的 `subagent_supervisor_request`，但只有两个 task-1 request 进入 Plan Attention；两个 task-2 request 仍使对应任务停留在 `active`。

诊断报告 `.pi-subagents/artifacts/verification/task64a2-flat-attention-owner-race-red.md` 记录了两组 Plan 的结果：task-1 request `b9346c54-9fb2-46c4-9887-2e716d7af01e`、`fcb036db-ef14-430a-a7e4-d11ab5e9b58c` 被持久化为 `waiting-attention`；task-2 request `0dd5ee32-3ef9-4e70-98f6-8f93dfb84bfa`、`02b5bc52-fc87-4c6c-af9c-92c2cca4db2c` 都已进入 Root，却没有成为 Plan Attention。

## 影响

有效的 Executor `contact_supervisor` 会永久失去路由，Plan Runner 看不到 pending Attention，Executor 则等待永远不会到来的 reply。native channel 在发送前把 request file 加入 `seenFiles`；Root 对该消息 `return` 后，后续 poll 不会重发，因而不是暂时延迟而是不可恢复的丢失。

这会令同一批并发任务产生不一致投影：先完成 owner 绑定的 task-1 正常等待 Attention，较早到达但尚未绑定 owner 的 task-2 保持 `active`，并可阻塞后续关闭与回收。

## 复现

1. 在冻结 HEAD `0fbc18e` 仅运行一次真实 A2 Harness；该基线约 47.6 秒后以 exit 1 结束，不能再次运行以免破坏唯一冻结证据。
2. 令多个 Executor 首次工具调用均为 `contact_supervisor`，使 request 到达顺序为 Plan B task-1、Plan A task-1、Plan A task-2、Plan B task-2。
3. Root persisted session 可观察到四个不同 native request ID 和 Executor run ID；同一 Executor session 内复用的 deterministic tool-call ID 不是跨 session 去重原因。
4. `routeSupervisorRequest()` 以 `executorRunId` 查询 `runOwners`。当 task-2 的 owner 尚未写入时，函数在 request 已由 native channel 标记 seen 后直接返回；只有已经完成绑定的两个 task-1 被写入 Plan Attention。

本问题与 `docs/bugs/bug-supervisor-request-dropped-before-root-broker-ready.md` 不同：既有问题发生在 Root Broker startup 前、需要 startup mailbox；本问题发生时 Broker 已 ready，窗口位于 spawn 完成与 Executor owner 绑定完成之间。

## 根因

`scripts/lib/subagent-dispatch/root-broker-server.ts` 的 `routeSupervisorRequest()` 在 `runOwners` 没有 `executorRunId` 对应项时直接 `return`，没有保存 ingress。spawn 路径则先 `await ensureExecutorOwner(runId)`，之后才执行 `runOwners.set(runId, logicalCallerRunId)`。

`ensureExecutorOwner()` 及 Executor 启动可与 native Supervisor request 并发：Executor 进程能够在 spawn 调用方完成上述 await 和 `runOwners.set` 前执行 `contact_supervisor`。因此不能从 request 的 `content`、task 文本或复用的 tool-call ID 反推 owner；唯一可信的暂存索引是传输提供的 Executor `runId`，并须在绑定时以该 identity 校验归属。

## 修复

Broker 对 owner 尚未绑定的合法 Supervisor ingress 建立 session-local、有界的 pending 队列，按 Executor `runId` 索引。每项保留原始 request identity、`context`、`expectsReply` 和到达序号；达到全局或单 Executor 上限时 fail-closed，返回可诊断错误或拒绝新项，绝不静默丢弃或无限积压。

`runOwners.set(runId, logicalCallerRunId)` 成功后，按该 Executor 的 FIFO 顺序重放 pending 项，并在投递前验证 owner identity 和 logical caller 仍有效。requestId 已存在时必须保持幂等；同一 requestId 的 owner 或 payload 不一致必须报 `supervisor_request_conflict`，不得覆盖或重复投递。重放不得依据消息内容推断 owner，也不得改变不同 Executor 队列之间未承诺的全局顺序。

Root `close`、`dispose`、绑定失败、owner 失效及 session 终止必须清理 pending 队列及其去重状态，阻止旧 session 或旧 owner 的 request 跨生命周期重放。关闭期间的新 ingress 应 fail-closed；非法 request、缺失或不匹配 Executor identity、未知 owner 在非可绑定状态以及容量耗尽也必须有明确拒绝边界。

## 验证

先写独立 unit RED，覆盖：request 先于 owner 绑定到达时不丢失；`runOwners.set` 后按同一 Executor FIFO 重放；重复 requestId 幂等、冲突 requestId 被拒绝；owner identity 不匹配不重放；容量、close/dispose 和绑定失败均清理并 fail-closed。随后实施最小 GREEN 并运行这些定向单元测试。

真实 A2 下一冻结基线只能运行一次，且必须在单元 RED/GREEN 已固定后才运行。该一次运行应证明四个唯一 Supervisor request 均进入 Root，并使四个对应任务均形成可见、可回复的 Plan Attention；同时保留 requestId、owner identity、FIFO 与关闭清理的诊断证据。当前文档分片为 docs-only 豁免，不新增测试，也不运行真实 Plan Harness。
