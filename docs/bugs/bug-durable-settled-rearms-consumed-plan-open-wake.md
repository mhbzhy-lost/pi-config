# Bug：durable agent_settled 重装已消费的 plan-opened wake

## 1. 现象

真实 Harness 在 e8611ac 下创建了 35 个顶层 Plan Runner，发生 34 次完整的 `resume`、`grant`、`success`，却没有任何 Executor。最终 Root broker 关闭，连接报 `ECONNREFUSED`。task63t 的报告同时记录了 275 条 diagnostics 和 35 次 runs；Plan 没有推进，进程却持续生成。

## 2. 影响

当模型 no-op 或上下文不可用时，Plan Runner 会无限生成新的进程，直到 Root 关闭。资源消耗、broker 诊断和运行记录持续膨胀，且重复 revival 不会带来 Executor 派发或 Plan 状态推进。

## 3. 根因

4722b37 基于错误的 root-cause 假设，在 `agent_settled` 的 `canContinue` 与 `gate-required` durable 分支中，每一代都调用相同的 `requestCallerFollowUp({ wakeId: "plan-opened", ... })`。Broker 成功 revive 后会删除该 wake 的 snapshot；下一代 settle 又以相同 `wakeId` 重新入队。已消费 wake 因此被不断重装，proof 触发无穷的 revival 循环。

## 4. 架构决策

`plan_open` 的 `tool_result` 是初始 one-shot durable wake 的唯一登记点，拥有 `plan-opened` wake 的创建职责。durable `agent_settled` 模式既不能 `local triggerTurn`，因为该上下文已经 stale，也不能重装 `plan-opened` wake。没有 durable capability 的 legacy 路径仍保留本地 `sendMessage`，以维持既有行为；不修改 Broker 的消费语义。

## 5. 修复

`agent_settled` 的 durable `canContinue` 和 `gate-required` 分支只 `return`，不调用 `sendMessage`，也不调用 `requestCallerFollowUp`。将现有两个错误 RED 用例改为断言 `calls` 与 `messages` 均为空；保留 `plan_open tool_result` 对 exact wake 的测试，继续证明初始 wake 仅登记一次。

## 6. 验证

单元测试应覆盖：初始 wake 只创建一次、settled 不 rearm、legacy 本地 send 行为不变。真实 Harness 应最多发生一次 revival，且不出现 generation storm。provider 无法推进的独立问题另立 bug 和 RED，不以再次登记 durable wake 掩盖。
