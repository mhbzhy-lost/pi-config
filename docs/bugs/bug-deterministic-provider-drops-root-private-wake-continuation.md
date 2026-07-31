# Bug：deterministic provider 丢失 Root private wake continuation

## 1. 现象

真实 flat Harness 的 task63t 已成功走完 identity/proof 全链；Root Broker 随后 revival
generation 时，deterministic provider 没有产生 `plan_continue`、Executor 或 `validated`。现场连续
35 代循环中，每一代都只 settle 并重新安装 wake，Plan 没有前进。HEAD `7f64ce8` 已独立消除产品侧
consumed wake 引发的 generation storm；该修复不改变本缺陷，剩余阻断是 provider no-op，而非产品
再次消费或重装 wake。

## 2. 触发条件与证据

pinned async resume 向 revived model 交付的当前 user 消息是 wrapper 加上不可修改的 exact 原文：
`A durable Root broker wake is pending.`。真实证据表明该 provider 上下文中没有可匹配的
`plan_open` bootstrap 或 tool history；因此 revival 不能依赖旧消息被保留来恢复状态。结果是 wake
已经交付，但 model fixture 返回空 turn，只有 settle 与 wake 重装可观察。

RED 至少应覆盖两个彼此独立的合同：

1. private wake 且当前 turn 没有结果时，provider 必须调用 `plan_continue`。
2. private wake 加上 `dispatch-required` 的 tool result 时，provider 必须原样调用 subagent contract。

## 3. 根因

`decideDeterministicTurn()` 仅在 user 消息包含 `plan_open` bootstrap 时进入 flat Plan 状态机。对
revived model 而言，当前 user 消息只有 wrapper 与 exact private wake，且没有可匹配 bootstrap/tool
history，所以该函数返回 `undefined`。这使 deterministic fixture 未模拟真实 Plan Runner 模型将 Root
private wake 理解为已打开 Plan 的 continuation 的行为。

## 4. 影响范围

该问题阻断已打开 Plan 在 Root durable revival 后继续调度：identity/proof 已成立仍无法产生两次
Executor 或最终 `validated`。它与 `7f64ce8` 修复的产品 generation storm 必须分开判断：前者是 test
fixture provider 未作出下一轮工具调用，后者是产品侧 consumed wake 的生命周期问题。private resume
exact 消息和 Root Broker 协议均不在本缺陷的改动范围内。

## 5. 修复边界

仅修改 test fixture state：识别最近 user 消息中的 exact private wake，并将它视为 opened Plan 的
continuation，复用已有 `plan_continue` / dispatch / status / verify 状态机。不得调用 `plan_open`，不得
更改 production private message，也不得改变 Root Broker。

同一当前 user turn 已有 `plan_continue` toolResult 时，状态机必须通过既有 `resultsFor` 解析该结果并
前进到 subagent 或 verify，不能再次调用 `plan_continue`；该防重复行为由现有状态机自然提供。

## 6. 验证策略

先使两个 RED 合同失败：wake 无结果时断言 `plan_continue`，wake 加 `dispatch-required` 结果时断言
subagent contract 原样透传。修复后 deterministic provider unit 与 stream 测试均应 GREEN。

真实 Harness 验证应从一次 revival 连续进入两次 Executor 并到达 `validated`，同时不再出现 generation
storm。提交仅包含本文件，提交信息为 `docs(bug): 记录 provider 丢失 private wake`；提交后检查
`git diff-tree --no-commit-id --name-only -r HEAD`、`git diff --check HEAD^ HEAD` 与
`git diff --cached --quiet`，确保 diff 合法且 index 为空。
