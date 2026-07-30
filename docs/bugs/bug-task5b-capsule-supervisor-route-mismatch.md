# Bug: Plan Capsule 激活项目 Supervisor 却仍围栏旧工具

## 症状

Capsule 的 active tools 已从上游 `subagent_supervisor` 切换为项目 `plan_executor_supervisor`，但 `tool_call` 和 `tool_result` 仍只处理旧名称。项目 Supervisor 的 reply 因此直接穿过 hook，旧工具反而继续拥有 Attention authorize/resolve 路径。

## 影响

Plan Runner 调用已激活的项目 reply 时不会执行 durable Attention fence，也不会在成功结果后持久化已投递状态。若上游旧工具因加载顺序或异常重新可见，它还能继续执行 pending/reply，形成第二条不受 Root broker 所有权约束的控制路径。`subagent_wait` 同样只从 active list 移除，没有 defense-in-depth block。

## 复现

1. 打开 Plan session，调用 `plan_executor_supervisor` 的 reply。
2. `tool_call` 返回允许，但 `authorizeSupervisorReply` 调用次数为零。
3. 发送对应成功 `tool_result`，`resolveSupervisorReply` 调用次数仍为零。
4. 改用旧 `subagent_supervisor`，上述 authorize/resolve 反而都会执行；`subagent_wait` 也未被 hook 阻断。

## 根因

Task5B 只更新了 active tool 名称，没有同步迁移 Capsule 中既有的 Attention 路由与结果绑定，也把“未激活”误当成足够的安全边界。

## 修复

将 pending/reply 的 `tool_call` 和 reply `tool_result` 路由迁移到 `plan_executor_supervisor`；旧 `subagent_supervisor` 与 `subagent_wait` 无条件 block。保留 message push 的 durable Attention 记录和 reply single-flight 语义。

## 验证

测试项目 reply 先 authorize、成功 result 只 resolve 一次；authorizer 拒绝时项目 reply block。测试旧 Supervisor 的 pending/reply 与 `subagent_wait` 全部 block，且不会调用 authorize/resolve。Capsule 全量测试与 broker adapter 测试通过。
