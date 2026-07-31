# Bug: Goal Engine 跨轮次丢失 Executor Worktree Lease

## 症状
`goal_dispatch` 成功分配 executor worktree 后，如果 Pi Extension 进程重建、会话 compact 或下一轮通过新 Extension 实例调用 `goal_integrate`，工具报错 `No active workspace lease for task`，即使 worktree 和 lease 文件仍存在。

## 影响
真实长任务无法完成 `settle → integrate → accept` 流程。该问题破坏 Goal Engine 的核心承诺：状态应跨进程、跨轮次和跨 compaction 恢复；当前只有同一 Extension 实例内的冒烟测试能够通过。

## 复现
在 crash-analyzer 上调用 `goal_dispatch(stats-core)` 后结束创建该 Extension 的 Node 进程；executor 在分配的 worktree 中完成并提交代码。随后创建新的 Extension 实例并调用 `goal_integrate(stats-core)`，稳定得到 `No active workspace lease for task: stats-core`。

## 根因
`allocateExecutorWorkspace` 将 lease 持久化到了 `.state/goal-engine/worktrees/.<goal>-<task>-<attempt>.lease.json`，但 `extension.mjs` 同时将 lease 仅保存在进程内 `activeLeases: Map`。`goal_integrate` 只读取该 Map，没有从持久化 lease 恢复；Extension 重建后 Map 为空。

## 修复
在 `workspace.mjs` 增加根据 `goalId/taskId/attempt/stateRoot` 读取并校验持久化 lease 的 API。`goal_integrate` 先查内存缓存，缺失时根据 projection 中 task.attempts 从磁盘恢复。状态响应同时保留足够的 attempt 信息，确保 compact 后可确定当前 lease。

## 验证
新增集成测试：实例 A 执行 `goal_init + goal_dispatch` 并在 worktree 创建 commit；销毁实例 A，实例 B 重新注册 Extension，直接调用 `goal_integrate`。测试应确认成果进入主 worktree、executor worktree 被释放、分支被删除。随后重跑 `node --test test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs`。
