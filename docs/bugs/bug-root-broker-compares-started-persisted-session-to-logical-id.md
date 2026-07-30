# Bug: Root Broker 将 started persisted session 与 logical Root ID 比较

## 症状

真实 Root 启动的 logical id 为 `flat-pi-plan-flat-runtime-ITvsE1`，但 pinned async 生命周期中的 `ctx.currentSessionId`、`SUBAGENT_ASYNC_STARTED_EVENT.sessionId` 和 Plan Runner `status.json.sessionId` 都是 Root JSONL 完整路径：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-plan-flat-runtime-ITvsE1/sessions/2026-07-30T23-34-47-610Z_flat-pi-plan-flat-runtime-ITvsE1.jsonl`。两者不相等。

诊断报告 `.pi-subagents/artifacts/diagnostics/task63m-started-session-identity-probe.md` 双重确认该差异：真实 status 证明 pinned `ctx.currentSessionId` 的值，且 started event 源码使用相同表达式。持久化 Root session 随后记录了 `followup.accepted`，又两次记录 `revival.blocked`，原因为 `run-missing`；官方 proof 已 observed/resumable，但无法被接受。

## 影响

合法的 Plan Runner/Executor `started` 事件被忽略，`ownedRuns` 不会建立条目，后续 proof 无法 accept。revival 因而永久落入 `run-missing`，不能恢复到下一代；cleanup 的 ownership 也可能缺失，留下无法按已验证 owner 清理的运行。

这不是将校验放宽为任意 `sessionId` 的理由。Root Broker 需要第二个、由 Root 生命周期权威来源注入的 trust root，继续拒绝 foreign、malformed 或伪造身份的事件。

## 复现

1. 用真实 Harness 启动 Root，logical id 为 `flat-pi-plan-flat-runtime-ITvsE1`，并观察首代 async `status.json.sessionId` 为上述 Root JSONL 完整路径。
2. 触发 pinned Plan Runner 或 Executor async spawn。其 `event.sessionId` 与 status 使用同一个 `ctx.currentSessionId` 值，因此也是该 JSONL 路径，而不是 logical id。
3. 接收 `followup.accepted` 后尝试 revival。尽管官方 proof 已 observed/resumable，Root persisted session 记录 `revival.blocked: run-missing`，且不能产生第二 generation。

报告中的 run id 为 `c5e74d8f-9d1f-4991-a2c4-04ac282d2c80`。报告明确区分 status 与 event 证据：本地 `events.jsonl` 没有持久化 started event，status 不被提升为独立事件证据。

## 根因

pinned `async-execution.ts` 在单 spawn 与 chain spawn 的 config 和 `SUBAGENT_ASYNC_STARTED_EVENT` 都写入 `sessionId: ctx.currentSessionId`：单 spawn 为 1357、1436 行，chain spawn 为 982、1093 行。

而 Root extension 在 `pi/extensions/subagent-runtime.ts` 的 `session_start` 中以 `sessionManager.getSessionId()` 构造 `rootSessionId`，再传入 `RootBrokerServer`。`scripts/lib/subagent-dispatch/root-broker-server.ts` 的 `startedFacts()` 要求 `event.sessionId === rootSessionId`。前者是 persisted lifecycle session identity，后者是 logical Root ID，错误地跨越了两个不同的身份域比较，导致真实 started facts 被过滤。

## 修复

为 `RootBrokerServer` 新增 authoritative `lifecycleSessionId`。Root extension 必须从同一次 `session_start` 的 `ctx.currentSessionId` 注入该值；`startedFacts()` 仅与 `lifecycleSessionId` 比较。

`rootSessionId` 继续独占 broker socket、grant 和 request 的 logical Root 身份，不能与 lifecycle identity 混用。仅为兼容直接 unit 构造，在没有显式传入时默认 `lifecycleSessionId = rootSessionId`；该默认值不改变真实 Root extension 的注入路径。

## 验证

增加彼此独立的 RED：配置 separate lifecycle identity 时，接受带真实 lifecycle `event.sessionId` 的 started event 并记录 owned run；在相同配置下，携带 logical id 伪装的 event 必须拒绝。既有 foreign/malformed event 也必须继续拒绝。

GREEN 使用真实 Harness 验证：官方 proof 出现 `proof.accepted` 与 resume，且能观察到第二 generation。该验证同时证明 lifecycle identity 信任根只接受来自同一 `session_start` 的真实 persisted session identity，而 socket/grant/request 仍由 logical `rootSessionId` 约束。
