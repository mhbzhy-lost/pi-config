# Bug: Goal Engine 集成恢复身份、并发边界与终态确认缺口

## 现象
Task 4 三阶段集成流程在正常测试中通过，但独立故障注入暴露出四类恢复缺口：

1. `task.workspace_disposition_started` 写入后若 executor worktree 又新增 commit，后续集成会重新读取移动后的 HEAD，把未经过 `writePaths` 校验、也不等于事件中 `executorHead` 的提交一并合入 origin。
2. projection workspace 与持久化 lease 只校验路径，未校验 `branch`、`baseCommit`、`originRoot` 等身份。篡改 lease 的 branch 后，cleanup 会删除 lease 指向的无关分支，并遗留 projection 记录的真实 executor 分支。
3. worktree 目录已经消失、但 Git worktree 元数据仍存在时，release 跳过 `git worktree remove`，随后删除 branch 会因“branch is used by worktree”失败，无法从部分清理状态恢复。
4. `task.workspace_disposed` 已经持久化、但调用方收到错误（例如 append 后续 registry 写入失败或确认丢失）时，同 action 重试会因 terminal phase 直接失败，无法把 durable success 幂等返回给调用方。

另有返回兼容性回退：新 `goal_integrate` 响应丢失原有的 `strategy/newHead`（integrate）和 `path/branch`（preserve）字段，机器调用方无法继续使用既有结果字段。

## 影响
- 未经边界校验的 commit 可进入 origin，破坏 `writePaths` 机械隔离和审计事件的 executor identity。
- 损坏或被篡改的 lease 可把清理副作用施加到无关分支，并造成真实 workspace 资源泄漏。
- 清理中断后无法重试完成，projection 会停留 `applied`，阻塞 accept 和后续 dispatch。
- 已持久化成功的终态无法幂等确认，调用方只能看到失败并可能重复人工处置。
- 返回字段回退会破坏已有调用方的结果解析。

## 稳定复现
1. 在注入 appender 成功写入 `task.workspace_disposition_started` 后，立即向 executor branch 增加一个越过 `writePaths` 的 commit；当前实现返回 integrated，origin 比 started 事件中的 `executorHead` 多合入一个 commit。
2. dispatch 后把 lease JSON 的 `branch` 改成预先创建的 victim branch；integrate cleanup 后 victim branch 被删除，projection branch 仍存在。
3. allocation 后直接删除 workspace 目录但保留 Git worktree 元数据和 lease，再调用 release；`git branch -D` 报该分支仍被 worktree 使用。
4. appender 先成功持久化 `task.workspace_disposed`，随后抛出“确认丢失”；projection 已是 disposed，但同 action 重试报 workspace already disposed。
5. 对正常 integrate/preserve 结果断言旧字段，可见 `strategy/newHead/path/branch` 缺失。

## 根因
1. Extension 在 started 前校验一次 inspection，却在 started 后让 workspace helper 重新读取活动 branch HEAD 并按移动后的 HEAD 集成；事件中的 immutable `executorHead` 没有传入副作用层作为 expected head。
2. `loadExecutorWorkspaceLease` 只验证通用路径身份；Extension 恢复时没有把 lease 全字段与 projection snapshot、当前 execution cwd 做逐项一致性校验，缓存 lease 也没有复验。
3. release 只依据目录是否存在决定是否执行 worktree 清理，没有处理“目录缺失但 Git admin metadata 尚存”的中间态。
4. terminal 分支把所有 disposed 调用都视为非法变更，没有区分“不同 action 改写终态”和“相同 action 对 durable 结果做幂等确认”。
5. 重写 handler 时只保留新测试使用的 `action/released`，未保留原有响应字段。

## 促成因素
- RED 只注入“append 前失败”，没有覆盖“事件已 durable、确认后失败”的模糊提交结果。
- 写路径测试只覆盖 started 前的静态越界 commit，没有在 started 与 Git 副作用之间移动 executor HEAD。
- lease 恢复测试覆盖 lease 缺失，没有覆盖 lease 存在但身份字段与 projection 冲突。
- 资源测试只覆盖完整存在与完整释放，没有覆盖 filesystem 与 Git worktree admin state 分离的部分清理。
- 结果测试仅断言 `action/released`，没有做旧响应字段兼容断言。

## 修复与验证策略
### 修复策略
- 为 workspace 集成增加 expected `executorHead`：副作用前要求当前 HEAD 与 expected 一致；cherry-pick/merge 使用 expected commit，而不是再次跟随可移动 branch。
- Extension 对 projection、loaded/cached lease 和派生身份做逐项校验：attempt、path、branch、baseCommit、originRoot、stateRoot、leasePath 必须一致；不一致立即 fail-closed。
- workspace 目录缺失时先 prune stale Git worktree metadata，再删除 branch/lease，并在结束后复查三类资源均不存在。
- disposed 同 action、同 strategy 的重试只验证资源终态并返回既有结果；不同 action/strategy 继续拒绝，且不追加重复 terminal event。
- 恢复 integrate 的 `strategy/newHead` 与 preserve 的 `path/branch` 响应字段。

### 验证策略
1. 增加 started append 后注入 rogue commit 的 Extension RED，断言 origin 不变、projection 停在 disposing、资源保留且 rogue commit 未集成。
2. 增加 lease branch/base/origin 身份篡改 RED，断言 victim branch、projection branch、worktree 和 lease 均不被修改。
3. 增加 workspace 目录缺失但 admin metadata/branch/lease 尚存的 release RED，断言重试后资源全 false。
4. 增加 disposed durable-then-throw RED，断言同 action 重试成功、事件不重复、不同 action/strategy 仍拒绝。
5. 增加 integrate/preserve 响应兼容断言，并运行 Extension、workspace 与全量 Goal Engine 测试。
