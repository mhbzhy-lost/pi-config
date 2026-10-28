# 新 Host 未重建计划执行事实视图

日期：2026-10-27。分类：预期 production 数据未被正确处理。

## 现象与证据边界

真实 compact smoke 的 session 为 `01a17e34-ea6c-77a2-814a-e6c2b7ec789b`，计划为 `8f6e86b2-1e69-4ecc-abfc-e90c18f5898d`。首次 Host 已观察到：

| 事实 | 身份或状态 |
| --- | --- |
| run | `ce0d751d-c62a-4e57-98cf-ce772509969c` |
| workspace | `1ad6a1dc-85e9-4325-8cac-c1c18ecce482` |
| terminal proof | `5afe8fc9884328c7e94d6f7a99cf1008346e62f3576b023e64d1ea53fc74459b` |
| integration receipt | `1cf00065-4190-49ce-b569-8c36d725d833` |
| queue | `5786b267-0576-448c-a01c-7ef0ba57c70d`，completed |
| workspace | released |

新 Host 恢复后 `plan_status` 的 facts 为 `PLAN_EXECUTION_FACTS_UNAVAILABLE`；同轮 `plan_verify` 返回 `GOAL_NOT_ACTIVE`。这些身份来自[真实 smoke 记录](../summaries/2026-10-27-goal-runtime-smoke.md:71)。该记录明确说明原始临时 session、ledger、事件日志已经清理，因此本修复没有直接重读原始现场，也没有重新调用真实 provider。真实观测作为问题线索，恢复边界用既有隔离测试验证，不能把摘要称为本次直接取得的 ledger 证据。

## 根因与生成链

合法调用链为 `plan_execute → PlanExecutionService.start → typed coding dispatch → workspace.bindRun / RootBroker.registerAuthorizedRun → 官方 process-terminal 事件 → coordinator.recordTerminalProof → queue 完成与 workspace 释放`。Goal 持久化的是 run/workspace 引用，coordinator 持久化 proof 身份与集成 receipt；这些都是正常生产数据，并非测试直接拼接的 Goal projection。

新 Host 启动创建新的 [RootBrokerServer](../../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:197)，`ownedRuns` 和 `terminalProofs` 是空的。原 `inspectExecutionProof` 只查 `ownedRuns`；[managedCodingBinding](../../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:293) 必须取得该内存 snapshot，缺失即抛错。`planExecution.inspect` 虽已读取同 owner 的 workspace 和 coordinator 记录，但接着仍要求旧进程内 snapshot，读取异常最终变成 `PLAN_EXECUTION_FACTS_UNAVAILABLE`。这是首个偏离点：持久化的终局证明已经存在，读取面却依赖消失的 live 注册。

另一个接线窗口是 Goal 的 `session_start` 先运行、execution service 后绑定。此前 Goal 只在工具/context 入口再次解析服务，没有服务就绪回调；只读 status 本身也不会触发恢复。该窗口与内存 snapshot 缺失分别修复。

`GOAL_NOT_ACTIVE` 来自 scheduler 的 active 状态门禁；paused/cancelled 等状态本来就应拒绝 verify。没有原始事件日志，不能断言该错误由 facts 缺失直接造成。修复不自动把 paused 变成 active，也不清除用户暂停。

## 修复

- [service.inspectIntegrationCompletion](../../packages/pi-subagents-enhanced/src/workspace/service.ts:363) 经过既有 owner、workspace、lease、run 校验后返回持久化 `terminalProof` 的副本；[coordinator.inspectIntegrationState](../../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:241) 透传该事实。
- [RootBroker.inspectPersistedTerminalProof](../../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:632) 核对 root/run/asyncDir、当前 owner receipt，再复用官方 sidecar 的文件类型、权限、uid、硬链接及 inode 一致性读取。`parseProcessTerminal`、完整 canonical SHA-256、runner processInstance 必须一致，才返回终局 outcome。没有 proof 或任一不匹配仍拒绝。
- [planExecution.inspect](../../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:527) 无 live snapshot 时使用此只读路径。集成完成仍需 coordinator 的 completed 队列与本地 receipt 对应，资源闭合仍需 released；不从终局 outcome 推断集成完成。
- [execution 服务发布](../../packages/pi-subagents-enhanced/src/execution/index.ts:72) 增加就绪订阅，由 [Goal 同代回调](../../src/goal-runtime/index.ts:221) 在当前 session/generation 核对后 attach/reconcile，并纳入 `session.ready`。dispose 撤销订阅；旧代回调不能更新新 session。

恢复不写 `ownedRuns`、不签发 grant、不 renew lease、不复活 child，也不写入 proof、receipt 或完成状态。保留原有 fail-closed 与只读 `plan_status` 语义。

## 验证

更新既有 `Root broker lifecycle readers accept one upstream artifact through the same proof facts`：先走正常授权和官方 sidecar 消费，再创建具有同一 durable AuthorityStore 的全新 broker；空 ownedRuns 下可读取原终局 outcome。错误 root/run/hash/processInstance、pending/conflict、可写 sidecar 均拒绝；确认没有 principal、ownedRun 或控制权限产生。

更新既有 `F5 新 Host 实例从同一 session 文件恢复权威引用链，不重派`：Goal 先恢复，稍后的 session_start 发布 execution service，第一次 status 已有恢复的 terminal/integration facts；run 引用不变、没有重派。此项使用既有 adapter，验证 Host 接线，不冒充真实 child 全链。

验证结果：`npm run typecheck` 通过；`node --test test/goal-runtime-runtime.integration.mjs` 为 18/18 通过；root broker 的全部既有案例（包括上述只读恢复与拒绝断言）通过。`subagent-worktree-lifecycle`、`subagent-auto-integration-real-git`、`subagent-auto-integration-resumed-child` 联合运行 13/13 通过，确认新增只读字段不改变 child 工具与跨 owner 隔离行为。真实 provider 跨 Host smoke 本次未运行。

与缺陷 D 不同根：C 是读取面的恢复与绑定时序，D 是终局 proof 已到达后自动队列的机械消费缺失。仅修复 C 不会使 queued 项完成。
