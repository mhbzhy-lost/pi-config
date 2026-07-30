# Bug: Plan Runner 重启可重复启动未绑定 Executor

## 症状

Executor 的 exact `subagent` 调用通过一次性授权并由 Root broker 成功 spawn 后，如果 Plan Runner 在收到 `tool_result` 或持久化 `attempt.bound` 前退出，恢复后的 boundary 是空实例。`attempt.dispatch-requested` 会重放同一 contract，第二次 tool call 可再次通过并启动另一个 Executor。

## 影响

两个 Executor 可能并发修改同一 Attempt worktree；领域事件仍只有一个 dispatch intent，无法解释第二个 runtime run。重复执行会破坏 workspace 单写者约束，并使后续 completion、cleanup 和 integration 归属不确定。

## 复现

1. 持久化 `attempt.workspace-allocated` 与 `attempt.dispatch-requested`。
2. exact tool call 通过 boundary，Root broker 成功 spawn；在 `tool_result` 到达 Capsule 前终止 Plan Runner。
3. 重启 Plan Runner，重放同一 dispatch intent，并再次调用 exact contract。
4. 新 boundary 的内存授权表为空；若 broker 没有稳定 request identity/reconciliation evidence，会接受第二次 spawn。

## 根因

当前 one-shot 状态只存在 Plan Runner session-local Map；typed adapter 在 spawn 完成后才生成随机 handle `dispatchId`，broker request 没有绑定领域 durable `dispatchId + toolCallId`。因此进程恢复时无法区分“从未 spawn”与“spawn 成功但 tool result 丢失”。单独持久化“已授权”同样不足：它会在真正未 spawn 时错误阻止恢复。

## 修复

Task6 建立 broker-owned、可重放的 spawn request identity，并把 async-started/complete/process-terminal 只推给 owning Plan Runner。Boundary 的 `tool_result` 与 shutdown recovery 必须按 durable Attempt、request identity、runId、cwd 执行 bind-or-cleanup：同一 binding 幂等成功；已 spawn 的丢失 result 可重建 binding；冲突、取消或 terminal Attempt 必须 stop 对应 run；未知 spawn 结果保持 fail closed，不再盲目 spawn。

## 验证

增加独立 RED 覆盖：成功 result 绑定、result 前取消后 stop 且不 bind、CAS 同 binding 幂等、不同 binding cleanup、非冲突持久化失败的 AggregateError、spawn 后 result 丢失并重启 reconciliation、真正 pre-spawn 失败可安全重试、lifecycle push 仅到 owner subscription。验证事件与 push 不添加 runtime parent，且不得依赖 Plan Runner 本地上游 event bus。
