# Bug: Capsule in-flight 静默压制并行 integration 工作

## 症状

`agent_settled` 只要发现任意 `dispatch-requested`、`active` 或 `waiting-attention` Attempt 就直接返回。若另一个独立 Attempt 已 `validated` 等待 integration，Capsule 不再触发 `plan_continue`，integration queue 无人 drain。

## 影响

已完成任务不能及时集成，其下游任务无法解锁；一个长时间运行或等待 Attention 的无关 Executor 会阻塞整个 Plan 的可并行进展。该延迟没有资源或依赖依据，最坏情况下等待 Attention 永不回复时形成永久停滞。

## 复现

1. 构造两个独立任务：Task A 的 Attempt 到达 `validated`，Task B 分别处于 `dispatch-requested`、`active` 或 `waiting-attention`。
2. 触发 Capsule `agent_settled`，并令 `canContinue()` 返回 true。
3. 当前实现 messages 为空；未发送 `Continue the plan coordinator.`，因此 `prepareAuthorizedDispatches()` 不会 drain integration。

## 根因

Task5C 将“不做本地 Executor 轮询”错误实现成“存在任何 in-flight Attempt 就不协调 Plan”，混淆了 Executor lifecycle wait 与 Coordinator 可独立推进的 integration/recovery 工作。

## 修复

Capsule 先识别 coordinator work：至少包含 `validated`（待 integration）或 `workspace-allocated`（待发布 intent/recovery）的 Attempt。仅当存在 in-flight 且不存在 coordinator work 时静默；两者混合时仍发送普通 `Continue the plan coordinator.` follow-up，不恢复 wait-loop。

## 验证

对 `dispatch-requested/active/waiting-attention + validated` 三种混合状态分别断言发送一次普通 continue follow-up，且不含 wait/supervisor 指令。单一 in-flight 三种状态继续静默；created runnable、terminal 与 Attention fence 回归通过。
