# Bug: Goal Engine docs-only 派发失败并遗留孤儿 worktree

## 症状

对 `workflow=docs-only` 的 Goal task 调用 `goal_dispatch` 时，worktree 已成功创建，随后 `compileCodingDispatchIR` 报 `workflow.reason is required when mode is docs-only`。任务 projection 仍为 pending/attempts=0，但磁盘上存在 attempt 1 的 lease、worktree 和分支；后续再次 dispatch 会报 workspace 已存在。

## 影响

任何文档或独立审查任务都无法通过 Goal Engine 派发。失败不是可重试状态：事件流不知道已创建的 workspace，`goal_integrate` 也无法按 projection attempt 恢复并清理它，长任务必须人工干预。

## 复现

1. `goal_init` 创建一个 `workflow: docs-only` 的 pending task。
2. 调用 `goal_dispatch`。
3. 观察 `git worktree list` 已包含 executor worktree，但 handler 抛出缺少 workflow.reason；`goal_status` 仍显示 task pending、attempts=0。

也可用编译器会拒绝的 task 数据复现资源泄漏：只要错误发生在 `allocateExecutorWorkspace` 后、`task.dispatched` 事件写入前，当前实现都不会释放 lease/worktree/branch。

## 根因

Goal task schema 只保存 workflow mode 字符串，没有为 `docs-only` 生成 dispatch-ir 要求的 reason。`goal_dispatch` 的副作用顺序是“分配 workspace → 编译合同 → 追加 dispatched 事件”，但没有 try/catch 补偿；合同编译或事件追加失败时，已创建的外部资源没有对应持久事件，也没有清理。

## 修复方案

1. `compileTaskContract` 在 task mode 为 `docs-only` 时生成稳定、非空的 workflow reason。
2. `goal_dispatch` 在 workspace 分配后的合同编译/事件追加阶段使用补偿清理；失败时调用 `releaseExecutorWorkspace(..., failed-cleanup)`，删除 worktree、branch 和 lease，然后重抛原错误。
3. 只有合同编译和事件追加都成功后才写入 `activeLeases` 并返回 dispatch 结果。

## 验证方式

- 新增集成测试：docs-only task dispatch 成功，合同包含 workflow reason。
- 新增失败测试：构造合同编译失败，断言 task 仍 pending，且 worktree、lease、executor branch 均不存在。
- 重跑全部 Goal Engine 测试。
- 清理 crash-analyzer 当前 orphan reviewer attempt 1 后重新 dispatch，完成独立审查。
