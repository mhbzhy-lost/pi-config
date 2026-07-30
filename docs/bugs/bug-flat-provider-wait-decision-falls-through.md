# Bug: Flat Plan Runner provider 等待决策被旧 fallback 覆盖

## 症状

Flat Plan Runner 状态机在 Executor 已启动、尚未收到 lifecycle push 时返回等待文本，但真实 deterministic provider wrapper 仍继续执行旧 fallback。只要历史中存在 `subagent` 结果且工具集中有 `plan_verify`，wrapper 就会立即调用 `plan_verify`，而不是结束当前 turn 等待 Root broker follow-up。

## 影响

真实 flat runtime Harness 会在 Executor 仍运行时提前进入验证。验证可能因未集成改动失败并阻塞Plan，也可能掩盖broker push驱动协议是否真正生效；state单测全部通过仍无法发现该偏差。

## 复现

1. 使用production bootstrap完成`plan_open`和返回`dispatch-required`的`plan_continue`。
2. exact `subagent`调用返回started handle，但尚未收到`pi-root-subagent-lifecycle-v1`。
3. `decideDeterministicTurn`返回`PLAN_RUNNER_WAITING_LIFECYCLE`。
4. Wrapper只读取`compatTurn.tool`，忽略已存在的`compatTurn.text`，继续进入旧fallback并因历史`subagent`结果调用`plan_verify`。

## 根因

Wrapper把“没有tool”错误等同于“state未接管当前turn”。`compatTurn`的文本结果本身是完整决策，必须阻止旧fallback；当前合并表达式只把tool结果当作ownership信号。

## 修复

当`decideDeterministicTurn`返回任意决策对象时，由该决策独占当前turn：有tool就发tool，有text就发text，均不得进入旧fallback。只有state返回`undefined`且amendment逻辑也未接管时，才能执行兼容fallback。

## 验证

增加真实provider stream RED，构造subagent started但无lifecycle push的消息历史，断言输出stop文本且不存在`plan_verify` tool call；再增加收到lifecycle push时只输出`plan_status`的stream断言。保留state单测和generic compatibility wrapper回归。
