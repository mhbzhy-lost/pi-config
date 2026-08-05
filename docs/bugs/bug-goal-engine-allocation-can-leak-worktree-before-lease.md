# Bug：Goal Engine 在 lease 持久化失败前可能泄漏 worktree

## 1. 现象

`allocateExecutorWorkspace()` 先执行 `git worktree add -b`，随后才写临时 lease 并 rename 为正式 lease。若 lease 写入或 rename 失败，函数直接抛错，但已创建的 worktree 与 branch 没有 durable allocation intent，也没有本地补偿回收。

## 2. 影响

projection 仍可能没有 `task.dispatched`，正式 lease 也不存在，但 Git worktree 和 `ge/<goal>/<task>/<attempt>` branch 已存在。现有 orphan inventory 对缺 lease 的部分资源会 fail closed，导致协调者无法通过正常 typed path 自动证明归属并回收，只能人工保留现场。

## 3. 复现步骤

1. 在临时 Git 仓构造有效 Goal workspace allocation 参数。
2. 让 lease 目录在 `git worktree add` 成功后拒绝 `writeFileSync` 或 `renameSync`。
3. 调用 `allocateExecutorWorkspace()` 并观察抛错。
4. 运行 `git worktree list` 与 branch 查询，确认 worktree/branch 存在；正式 `.lease.json` 不存在。

## 4. 根因

资源创建顺序没有 write-ahead allocation intent。`git worktree add` 是第一个外部副作用，lease 却是之后才建立的唯一 durable ownership 证据；lease 写入代码也不在能执行幂等 compensation 的 `try/catch` 中。

## 5. 为什么此前未发现

既有回归覆盖合同编译失败、event append 三态、目录缺失和 disposition 恢复，但默认文件系统允许 lease 写入。测试没有在 `git worktree add` 与正式 lease rename 之间注入 I/O 失败，因此该崩溃窗口未进入状态矩阵。

## 6. 修复方向

在任何 Git 副作用前写入带 owner token、目标 path/branch/base/origin identity 的 allocation intent；worktree 创建和正式 lease 持久化完成后再将 intent 标记 active。任一步失败都运行幂等 compensation；若 compensation 也失败，保留 intent 作为 cleanup debt，使 `goal_status`/审计器能安全识别而不是生成无主资源。
