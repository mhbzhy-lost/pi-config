# Bug：Executor pre-resolver 错误泄漏 durable authorization

## 症状

Plan Runner 已通过 Capsule 授权 Executor tool call 后，如果 typed `subagent` 在调用 `resolveCodingSpawnIdentity` 之前失败，随后到达的 `tool_result` 无法被处理。Boundary 报 `Executor result requires resolved spawn identity`，同一 durable dispatch 的新 toolCall 又报 `Executor dispatch already authorized (replay)`，Attempt 保持 `dispatch-requested` 且当前 session 无法继续。

## 影响

Root Broker 短暂不可用、RPC capability ping 失败或 typed tool 在 resolver 前抛错时，尚未注册到 Backend/Broker 的 Executor 被错误保留为可能已启动。用户既不能安全重试，也没有 runtime identity 可供 lookup、stop 或 lifecycle 恢复，只能重启 Plan Runner session 才可能重新建立 Boundary。

## 复现

`executeCoding` 的顺序是 compile、title prepare、`rpc.ping()`、`resolveCodingSpawnIdentity()`、`rpc.spawn()`。在 `f8d3e54` 上只调用 Boundary `authorize`，模拟 resolver 前的 error result，得到 `Executor result requires resolved spawn identity`；再次用新 toolCall authorize 同一 contract，稳定得到 `Executor dispatch already authorized (replay)`。

## 根因

Task 6C2b 的 error RED 都先调用了 `resolveCodingSpawnIdentity`，因此只覆盖 Backend 已注册后的 `not-started`、`cleaned`、`spawned` 和 `uncertain` lookup。实现也统一先调用 `executionRequestForToolCall`，没有区分 Boundary 的 `executing` 与 `identity-resolved`：前者本身就是可信的“resolver 尚未运行、spawn 不可能开始”证据，却被状态机拒绝。

## 修复

新增独立 tests-only RED：Boundary 在 `executing` 状态收到 exact error result 时返回明确的 pre-dispatch/not-started 状态，并允许调用方安全释放；真实 typed extension 测试让 `rpc.ping()` 在 resolver 前失败，经过 Capsule `tool_result` 后验证新 toolCall 可授权。Plan Runner 只对该 Boundary 内部状态直接 release，不访问 Backend 或 Broker；`identity-resolved` 错误仍严格执行 lookup 与 bind-or-cleanup。

## 验证

RED 必须先证明 resolver 调用次数为零、Backend/Broker 没有 durable registration，并在第二次授权处失败。GREEN 后该用例允许新 toolCall，同时原有 resolved error lookup、cleaned retry、uncertain fence、success binding、Boundary/Capsule/Coordinator/Backend/Broker/Dependencies 回归全部通过，且无 detached process。
