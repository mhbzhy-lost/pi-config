# Plan Runner 将业务 blocked 误判为无提交验证失败

## 1. 现象

Crash Fix V2 子仓 Plan `c8ebd7a1-e500-4f16-bc5a-b039853566ff` 的 Executor 按计划读取候选物料后发现 `ready=false`，向 Supervisor 报告 blocker，并在权威结果文件写入 `status=blocked`。Executor 进程正常退出且没有提交，这是 fail-closed 路径的预期行为。

Plan projection 却将 Attempt 记录为 `succeeded`，把原始 HEAD 写入 `resultCommit`，随后以 `attempt_validation_failed` / `NO_RESULT_COMMIT` 阻塞 Plan。最终状态没有准确表达业务 blocker。

## 2. 直接原因

`coordinator.mjs` 只把 RPC runtime 的 `complete` 映射为 Attempt `succeeded`。成功结算时立即读取 Attempt HEAD 并执行提交验证，没有读取由 Plan Runner 分配的权威结果文件，也没有 `blocked` Attempt outcome。

## 3. 根因

Runtime 进程生命周期与 Executor 业务结果被错误合并成同一个二态信号：exit 0 被当成业务成功。Harness 已为 Executor 分配结构化输出路径，但协调器未建立受限的结果 disposition 契约。

## 4. 影响范围

- 合法的 fail-closed 或 HITL 后 blocked 执行会被错误显示为提交验证失败。
- 真实 blocker codes 和证据摘要不能进入结构化 Plan 状态。
- Attempt 被标记为 `succeeded`，与 Executor 权威结果及无提交事实矛盾。
- 不会错误集成代码，但会误导恢复决策和故障定位。

## 5. 修复方案

1. 在 Executor runtime 终态为 complete 后，先从协调器分配的权威结果路径读取有界 JSON。
2. 仅识别严格校验的 `status=blocked` disposition；blocker code 和可选证据 SHA 使用白名单格式与数量上限。
3. 新增 `attempt.settled` 的 `blocked` outcome，随后以 `executor_blocked` 阻塞 Plan。
4. blocked 路径不得读取 HEAD、运行 Attempt 验证、进入集成队列或伪造提交。
5. 缺失、过大、无效或非 blocked 的结果文件保持现有成功验证流程，避免模型通过畸形输出绕过提交门禁。

## 6. 验证策略

- 协调器回归测试复现真实组合：runtime complete、结构化 blocked、HEAD 未变化。
- 事件状态机测试证明 `blocked` 是合法 settled outcome，且不要求 `resultCommit`。
- 结果解析单元测试覆盖合法输入、无效 blocker、过大文件和非 blocked 输入。
- 运行 Plan Runner 定向测试、完整 `npm test`、Plan Capsule/Subagents/Pi runtime 集成门禁，并以新的真实子仓 Plan 验证结构化 blocked。
