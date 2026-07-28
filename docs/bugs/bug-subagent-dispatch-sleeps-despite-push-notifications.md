# Bug：异步 Subagent 派发后主 Agent 使用 sleep 等待主动通知

## 1. 现象

主 Agent 成功派发 detached Subagent 后，即使运行时会主动注入完成通知，仍倾向调用 `sleep`、重复 status 或其他空等待来维持当前回合。

## 2. 影响

空等待占用工具调用和用户时间，延迟主 Agent 释放控制权；长时间 `sleep` 还可能被中止并制造伪失败。并发 Subagent 越多，这种等待策略越容易演化为轮询循环。

## 3. 证据

项目自有 tool description 目前只声明 `All spawns are detached through RPC`，spawn result 只返回 `Started <agent>: <title> (<runId>).`。两处都没有告诉模型：completion 会主动重新唤醒、没有独立工作时应结束当前回合、不得用 `sleep` 或 status 等待。

`subagent-dispatch` skill 末尾写有 `use status when needed` 和 `Do not busy-poll`，但“needed”没有边界，也没有定义 push notification 下的正确 yield 行为。用户多次观察到主 Agent 仍选择 sleep。

## 4. 根因

等待策略放在可选加载的 skill 中，而不是始终随 tool schema 进入模型上下文的 typed tool 调用合同中。`detached` 只描述进程形态，不描述调度语义；当它与“持续工作直到完成”的通用指令并存时，模型会把 sleep/status 解释为保持任务连续性的手段。

这是调用合同缺失，不是 notifier 缺失：completion event 和自动消息已经工作，额外等待不会提高可观察性。

## 5. 修复策略

把 push/yield 语义写入 `TYPED_SUBAGENT_DESCRIPTION`，并在 coding/generic 两类成功 spawn result 中即时重复：completion 自动通知；禁止为等待 completion 调用 `sleep`、轮询 status 或 supervisor pending；若没有与 Child 独立的工作，应结束当前回合并让通知恢复执行。

status 继续保留，但限定为用户显式查询、需要 steer/interrupt/stop 前观察，或通知/运行事实异常时诊断。`subagent-dispatch` skill 删除等待策略，只保留 agent 选择、typed IR 和 generic dispatch 形状。

不对 Bash 做全局 sleep 拦截，因为测试 timeout、服务周期验证等场景可能合法使用 sleep，基于命令字符串阻断会产生误伤。

## 6. 验证计划

先增加 RED 测试，断言 model-facing tool description 与两类 spawn result 都包含 push/yield/no-sleep 合同，skill 不再拥有 status/wait 策略。再做最小实现并运行 dispatch skill、resource isolation、runtime membrane、RPC 和 fresh SDK description probe。

使用压力场景记录修改前后的决策：没有独立工作且 completion 会主动通知时，正确动作必须是结束当前回合；不得选择 `sleep`、status polling 或 supervisor pending。

## 7. 验证结果

修改前 pressure run `3a5d822d-9e23-4ca3-be81-7604fc8f611f` 明确选择 `sleep 30` 并重复执行。静态/runtime RED 为 20/24，通过后的同组 GREEN 为 24/24，扩大 dispatch/runtime 回归 64/64。

修改后 pressure run `1acb875e-a735-43dc-bdd7-a1dea3850f45` 明确选择结束当前回合并依赖自动通知，拒绝 sleep、status polling 与 supervisor pending。独立 fresh SDK create 289.5ms、reload 295.9ms/312.9ms，extension/runtime errors 均为空，最终 model-facing description 包含完整 push/yield/status 合同。
