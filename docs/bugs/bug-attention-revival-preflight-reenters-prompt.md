# Bug：Attention 恢复在 prompt preflight 内重入 agent turn

## 1. 现象

真实 A2 Harness 的 Attention reply generation 在启动后先收到
`pi-plan-attention-reply-v1`，provider 随即输出
`PLAN_RUNNER_WAITING_ATTENTION`，没有调用 `plan_executor_supervisor`。同一 generation 随后同时出现
`Agent is already processing a prompt` 与 stale extension context 错误，Plan projection 保持在
`waiting-attention`。

## 2. 证据与反证

`before_agent_start` 先调用 `prepareExecutionLifecycle()`；该路径进入
`recoverExecutionState()`，再由 `processAttentionReplies()` 调用
`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`。此时外层 revival prompt 仍在
preflight，Pi 尚未把外层 prompt 交给 agent，`sendMessage` 因而把 custom message 作为一个新的 agent
turn 直接启动。内层 turn 结束前，外层 prompt 又尝试启动，产生 processing 冲突；session shutdown
继而使外层捕获的 ctx 失效。错误发生在 Root alias、grant 与 canonical session 均已成功之后，不能归因于
stale caller fence。

## 3. 根因

`processAttentionReplies()` 同时承担两种不兼容职责：空闲 generation 的主动唤醒，以及
`before_agent_start` 恢复阶段的 command 注入。恢复阶段需要把 durable reply 作为当前 prompt 的附加
context 返回，不能启动第二个 prompt。现有局部单测只验证 `sendMessage` 被调用，没有覆盖 Pi runtime 的
preflight 重入语义。

## 4. 正确修复

让恢复路径返回待注入的 exact `pi-plan-attention-reply-v1` message，由 Capsule 的
`before_agent_start` handler 通过标准 `message` 返回值加入当前 turn。恢复路径不得调用
`pi.sendMessage(triggerTurn)`。空闲 timer 路径仍可使用主动投递，但必须与恢复路径复用同一 command
筛选、身份校验和 announcement 状态。

每个恢复 turn 最多注入一个 Attention command；其余 command 由后续 durable wake generation 处理，
避免一个 provider turn 中多个 custom reply 互相覆盖。

## 5. TDD 验证

先增加组合 RED：真实 Capsule `before_agent_start` 调用真实 dependencies recovery，准备一个 durable
reply，并使用会拒绝 preflight 内 `sendMessage(triggerTurn)` 的 Pi double。预期 handler 返回 exact custom
message，当前实现应因重入投递而失败。GREEN 后断言当前 turn 能看到
`plan_executor_supervisor`，且没有第二次 prompt、processing error 或 stale ctx。

保留 timer 路径的失败重试与 fresh generation replay 测试，证明修复没有删除离线 command 消费能力。

## 6. 影响边界

影响 Capsule 的 `before_agent_start` 返回值、Plan Runner recovery 及 Attention command 投递方式。不修改
Supervisor RPC、Attention event schema、Root official terminal authority、revival descriptor 或 Plan Runner
frontmatter tool ceiling。若不修，首次在真实 revived Attention turn 暴露，修复代价中；若错误地继续在
preflight 内启动 turn，会重复消耗 generation 并使 canonical session 留下失败 assistant 消息。
