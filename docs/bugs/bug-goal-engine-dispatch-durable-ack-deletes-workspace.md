# Bug: durable dispatch 确认失败错误删除 workspace

## 现象
`goal_dispatch` 的 `task.dispatched` 已写入 JSONL 后，注入的 appender 仍可能抛出调用层异常。旧实现把编译和追加放在同一 catch 中，无条件释放 workspace、branch 与 lease，留下已 `dispatched` 的投影却没有可执行资源。

## 影响
重启后无法从持久化投影和 lease 恢复 executor workspace，任务状态、契约与物理资源不一致；错误重试还可能产生重复 dispatch。

## 稳定复现
1. 创建 pending task 并调用 `goal_dispatch`。
2. 使用先真实追加 `task.dispatched`、再抛错的 appender。
3. 观察旧行为：投影为 dispatched，但 worktree、分支和 lease 被删除。

## 根因
追加失败未区分写入前失败、写入后确认丢失和恢复读取失败；catch 只按异常路径清理，而非从 JSONL 重建后比较本次 dispatch 的完整身份。

## 促成因素
- 编译失败与追加失败共用 cleanup 分支。
- 未比较 goal/task、attempt、contractHash 和 workspace 的 path、branch、baseCommit、originRef。
- 缓存 lease 不能作为 durable commit 的证明。

## 修复与验证策略
- 编译失败继续执行 failed-cleanup。
- append 抛错后经 `loadProjection` 重建：恢复投影的 `goalId` 必须是非空字符串且精确等于当前 goal；`loadProjectionFn` 返回错误 goal identity，或 durable dispatch 的 contract/workspace identity 冲突，均必须归类为 `AMBIGUOUS_DISPATCH_COMMIT` 并保留现场。完整身份匹配才为 committed 并注册 lease；只有版本、pending task、attempts 与 workspace 均精确未变化时才为 not_committed 并清理。
- 覆盖 durable-then-throw、写入前失败、恢复失败、错误 goal identity、durable contract/workspace identity 冲突以及重启后 status/integrate 的回归测试。
