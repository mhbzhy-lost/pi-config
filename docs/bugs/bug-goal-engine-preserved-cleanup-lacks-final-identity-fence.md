# Bug：Goal Engine 保留工作区清理缺少 destructive primitive 内最终身份栅栏

## 表现

`goal_integrate(action="discard")` 释放已 preserved 的 Executor workspace 时，会在 Extension 中执行两次 HEAD/identity inspection；但两次检查都在 `releaseExecutorWorkspace()` 之外。检查完成后到 `git worktree remove --force` 之间若出现新提交、dirty/untracked 文件或 branch 变化，cleanup primitive 不再复验，仍会强制删除工作区和 branch，并随后持久化 release 事实。

## 影响

- preserved 明确表示人工要求保留的现场，检查后新增的未跟踪或未提交内容可能被 `--force` 永久删除。
- 检查后新增 commit 或 branch retarget 会让实际被删除的资源不再匹配 projection 绑定的 `executorHead`。
- 外层“双检查”只能缩小竞态窗口，无法证明 destructive primitive 删除的就是已验证资源，违反 unverified/head drift 不得 cleanup 的 fail-closed 要求。

## 根因

`releaseExecutorWorkspace()` 的 `discarded-cleanup` 路径只判断 path 是否存在，然后直接执行 worktree remove、branch delete 和 lease delete。只有 `integrated-cleanup` 会检查 clean；函数也没有接收 preserved `executorHead`、cleanliness policy 或确定性 barrier，因此调用方无法把身份验证与删除收敛到同一受控 primitive。

## 触发条件

1. task workspace 已进入 `phase=disposed, disposition=preserved, released=false`。
2. 调用 `goal_integrate(action="discard")`，外层两次 inspection 均成功。
3. 在第二次 inspection 返回后、`releaseExecutorWorkspace()` 删除前，另一进程新增 commit、写入 dirty/untracked 文件、切换 live branch 或重定向 branch tip。
4. cleanup 继续执行 `git worktree remove --force`。

## 修复方案

为 `releaseExecutorWorkspace()` 增加仅由 preserved release 启用的 cleanup fence：传入 exact `expectedExecutorHead`、必须 clean 的策略和返回值被忽略的 deterministic barrier。primitive 在 barrier 前后都重新验证 persisted lease、worktree top-level/common-dir、live branch、branch tip、HEAD 与 cleanliness；任何漂移都在 `--force` 前失败。其它 failed/discarded cleanup 保持现有显式丢弃 dirty 现场的语义。

## 验证方案

1. workspace 单元测试在 primitive 第一次内部复验后分别注入 untracked dirty 文件、新 commit 和 live branch 变化；断言 cleanup 拒绝且 workspace、branch、lease 与新内容全部保留。
2. extension 集成测试在外层第二次 inspection 完成后、primitive cleanup 内注入 commit/dirty 变化；断言结构化 identity error、无 preservation release event、资源保持。
3. barrier 返回伪造值，确认生产逻辑忽略返回值并以真实 Git inspection 为准。
4. 运行 workspace、extension 和全部 Goal Engine 回归。
