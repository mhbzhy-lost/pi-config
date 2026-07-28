# waiting-attention follow-up 循环饿死 durable control timer

## 1. 现象

真实 Attention Harness 写入 reply 后仍保持 pending，126 秒内 Host 输出约 9 万到 11 万行
`pi-plan-follow-up-v1`，最终超时。主 Plan Harness 路径正常完成。

## 2. 影响

用户决策无法被 control timer 消费，Plan 永久等待；紧循环持续启动模型 turn，放大 CPU、日志和
测试耗时。direct-file stdio 消除 pipe backpressure 后，该问题稳定暴露。

## 3. 触发条件

Attempt 进入 `waiting-attention` 后，assistant turn 结束并触发 Capsule 的 `agent_settled` handler。

## 4. 证据

- reply 文件存在且可由 `createPlanControl().readAttentionReplies()` 正常读取。
- Host session 中没有 reply custom message、ack 或 resolved 事件。
- `agent_settled` 将 `active` 与 `waiting-attention` 合并为 `hasActiveAttempt`，两者都立即发送
  `executor-control-loop` follow-up。
- 连续 follow-up 形成 turn/microtask 链，25ms control interval 没有机会处理 reply。

## 5. 根因

`waiting-attention` 是等待外部用户输入的静止状态，不是需要模型持续轮询的执行状态。Capsule
状态机错误地把两者合并，依赖偶然的 stdio backpressure 为 timer 提供调度机会。

## 6. 修复与防复发

`agent_settled` 仅对 `active` Attempt 发送 bounded Supervisor wait follow-up；只存在
`waiting-attention` 时保持 idle，由 durable control timer 在 reply 到达后发送
`pi-plan-attention-reply-v1` 并触发下一 turn。

## 验证结果

Capsule waiting-only RED/GREEN 通过；真实 Harness 等待阶段日志从约 9 万到 11 万行降为约 151 行，
control timer 在 reply 后触发新 turn，最终 roundtrip validated。
