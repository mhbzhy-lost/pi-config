# Bug: supersede recovery 的陈旧 stop violation 阻断 Plan

## 症状
真实 amendment crash/restart 中，恢复流程已经持久化 terminal `attempt.superseded` 和 `attempt.workspace-released`，随后 `consumeExecutionFacts()` 仍把更早的 `SUPERSEDE_STOP_FAILED` fact 转成 `plan.blocked`。最终 revision 2 Task 保持 pending，Plan 以 `execution_protocol_violation` 终止。

## 影响
Executor 已有 durable terminal proof、supersede checkpoint 和 workspace disposition 仍不能解除恢复 fence；新 revision 无法重新派发。任何 stop RPC 先失败、terminal artifact 稍后稳定并被重试确认的恢复都可能错误阻断整个 Plan。

## 复现
让 active Attempt 在 `plan.amended` 后、`attempt.superseded` 前崩溃；重启时首次 supersede stop 返回失败，但随后稳定 terminal artifact 可读。恢复会依次写入 `attempt.superseded` 和 `attempt.workspace-released`，之后下一次 coordinator control loop 消费遗留 `SUPERSEDE_STOP_FAILED` 并追加 `plan.blocked`。

## 根因
execution backend 把 supersede 的瞬时 stop 失败发布为无上下文、不可撤销的全局 protocol violation。fact 未绑定 `dispatchId`/`attemptId`，consumer 也不根据当前 projection 判断该失败是否已被同一 Attempt 的 durable terminal proof消解，因此恢复成功后仍消费陈旧失败。

## 修复
让 supersede stop violation 携带完整 dispatch/Attempt identity；消费前按当前 projection 过滤已由 matching terminal `attempt.superseded` proof消解的 `SUPERSEDE_STOP_FAILED`。其他未知 identity、未完成 supersede 或真正未消解的 protocol violation 继续 fail closed；不得丢弃无关 violation。

## 验证
先新增 RED：matching terminal supersede proof 后的 `SUPERSEDE_STOP_FAILED` 不阻断并允许 revision 2 dispatch；proof identity 不匹配、Attempt 仍处于 supersede-requested、普通 protocol violation 仍阻断。随后复跑真实 amendment crash/restart Harness 两次、amendment recovery、backend、Coordinator/Capsule 与累计回归。
