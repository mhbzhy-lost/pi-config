# Bug：tool_result 重试会绑定已停止的 Executor

## 症状

Executor 成功返回 typed handle 后，Plan Runner 先将 runtime binding 注册到 Backend，再由 Coordinator 写入 `attempt.bound`。如果该事件第一次发生普通持久化错误，Coordinator 会停止 Executor 并抛错；Capsule 保留同一 tool result 供重试。第二次处理时 Backend 将相同 binding 视为幂等，Coordinator 又可成功写入 `attempt.bound`，使领域 Attempt 指向已经停止的 run。

## 影响

Attempt 会进入 `active`，但对应 Executor 已收到 stop。Broker ledger 仍可能显示 `spawned`，Backend 也保留原 binding；后续状态读取可能卡住、误判失败，或依赖异步 terminal artifact 才能纠正。该窗口破坏“正常 tool_result 是唯一提交点”所要求的 runtime 与领域原子性。

## 复现

对公开 `bindAuthorizedDispatch` 使用一个 Event Writer：第一次追加 `attempt.bound` 抛普通 I/O 错误，backend.stop 成功，第二次追加成功。当前实现第一次调用会记录一次 stop；第二次调用对同一 binding 返回成功并把 Attempt 投影为 `active`。Boundary、Capsule 和 Backend 的既有单测分别允许 result 重试与 exact binding 幂等，因此组合后稳定复现。

## 根因

`bindOrCleanupSpawnedAttempt` 同时服务 legacy direct dispatch 与新的项目 tool-result 提交，却对所有非 CAS 持久化错误统一执行 stop。Legacy 路径没有可重放的 tool result，必须 cleanup；项目路径持有 Boundary、Backend、Broker 三层 durable identity，普通写入错误应该保留 run 供同一 result 或重启后的 lookup 重试。两个调用场景的失败策略被错误合并。

## 修复

为内部 bind helper 增加明确的持久化失败策略：legacy direct dispatch 默认保持 stop-on-error；公开 `bindAuthorizedDispatch` 在普通 append 错误时不 stop，保留已注册 binding并原样抛错。相同 tool result 重试后重新执行 CAS 写入；terminal lifecycle、requested identity mismatch 及 CAS conflict 刷新为 terminal 时仍必须 stop。

## 验证

新增 tests-only RED，令公开 bind 第一次普通写入失败、第二次成功：第一次必须零 stop 且 Attempt 仍为 `dispatch-requested`，第二次只追加一个 `attempt.bound` 并变为 `active`。同时保留 legacy direct dispatch 普通持久化失败会 stop 的既有或新增断言，并运行 Capsule retry、Backend idempotency、Coordinator terminal/mismatch、真实 Broker 与 doctor 回归。
