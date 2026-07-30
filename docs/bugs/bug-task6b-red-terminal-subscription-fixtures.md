# Bug: Task6B RED 使用虚假的 terminal 与 subscription 夹具

## 症状

Task6B process-terminal RED 发出 `{ state: "terminal", proof: ... }`，但 upstream 实际事件是 `ProcessTerminalV1`：顶层含 `version/runId/runnerProcessInstanceId`，状态为 `pending | not-started | observed | unknown`。Child adapter 的 dedupe 测试让 `rpc.subscribe()` 直接 reject，却期待 `startLifecycleSubscription()` 成功；测试没有发送任何 lifecycle push，也没有验证 dedupe 淘汰。

## 影响

按错误测试实现会解析不存在的 upstream payload，并可能吞掉 subscription 建立失败，导致 Plan Runner 在没有 lifecycle 通道时继续运行。所谓 bounded dedupe 与 closed rejection cleanup 没有行为证据，可能产生无限 Set 或未处理 Promise rejection。

## 复现

1. 对照 `pi-subagents/src/shared/types.ts` 的 `ProcessTerminalV1` 与测试事件，字段和状态不一致。
2. 运行 child adapter RED：首先失败于 `startLifecycleSubscription` 不存在；若仅补该方法，`subscribe()` rejection 会使测试在任何 dedupe 断言前失败。
3. 查看测试，未调用保存的 `onPush`，`messages.length` 始终为零，无法证明 dedupe。

## 根因

测试设计从计划伪代码推断 terminal 形状，没有回读 pinned upstream 类型；同时混淆了两种失败：初始 subscribe rejection 应 fail closed，成功 subscription 的 `closed` Promise 后续 rejection 才需要被消费。Dedupe、close consumption 和 dispose 被合并进一个没有 lifecycle 输入的复合测试。

## 修复

使用真实 observed `ProcessTerminalV1` fixture，并断言 broker 从 ledger 补齐 asyncDir/cwd/sessionId、将 proof 的非重复字段放入有界 `processTerminal`。Child adapter 拆成：subscribe-once+mirror、limit=2 的真实 push 淘汰、成功 subscription.closed rejection 被 catch、dispose 幂等四项独立证据。初始 subscribe rejection 单独断言向调用方传播，不得吞掉。

## 验证

Broker terminal RED 只使用 upstream 真实字段；Child tests 每条独立创建 fake RPC/subscription，实际调用 onPush。Limit=2 时序为 D1、D1 duplicate、D2、D3、D1，期望四次 mirror/follow-up。Closed thenable 的 catch 调用次数与 handle dispose 次数均为一；初始 subscribe failure 独立 reject。无 TypeError、timeout 或未处理 rejection。
