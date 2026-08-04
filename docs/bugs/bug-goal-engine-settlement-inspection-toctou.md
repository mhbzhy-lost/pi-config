# Bug：Goal Engine 结算检查与处置副作用之间存在 HEAD 漂移窗口

## 1. 现象

`goal_settle(succeeded)` 和首次 `goal_integrate(integrate|discard|preserve)` 会先调用 `inspectExecutorWorkspace()`，再根据返回的 `headCommit` 持久化结算或处置事件。若另一个进程在检查返回后推进 Executor 分支，当前调用仍可能使用旧 HEAD 继续执行。

现有静态漂移测试只覆盖“调用前已经漂移”，没有覆盖“检查完成后、事件追加或资源清理前发生漂移”。因此全量测试通过时，受控并发仍可复现过期结算、遗漏提交或删除未复验提交。

## 2. 影响

- `goal_settle` 可能把提交 A 记录为成功结算，但返回时 Executor workspace 已位于提交 B。
- `integrate` 可能持久化 A 的 started event，随后遗漏 B；失败重试还可能沿旧身份继续恢复。
- `discard` 可能删除检查后新增的提交或现场。
- `preserve` 可能报告已保留已核验现场，但实际 workspace 已不是被核验快照。
- 错误发生在 durable event 或 Git 副作用附近，恢复和人工判断成本高。

## 3. 触发条件

1. task 已 dispatch，Executor workspace、lease 和 live branch 身份均合法。
2. succeeded settle 前至少存在一个 clean、非空、授权提交 A；或 task 已成功 settle 并绑定 A。
3. `inspectExecutorWorkspace()` 返回 A 后，另一个 Git 进程在当前 handler 的下一次 durable event、origin 读取或 cleanup 前推进分支到 B。
4. 当前实现没有在最晚副作用边界重新确认 live branch HEAD 与已检查 HEAD 一致。

## 4. 根因

- `inspectExecutorWorkspace()` 只保证其函数执行期间 HEAD 不变；函数返回后不持有任何跨 Git 与 event store 的事务边界。
- settle 直接把首次 inspection 的 `headCommit` 写入事件。
- active disposition 只将 settlement 与首次 inspection 对比，随后继续读取 origin、追加 started event，并执行 integration/cleanup。
- 现有测试没有可控 barrier，无法把 HEAD 推进精确放在首次 inspection 返回之后。

## 5. 修复策略

1. 为 Goal Engine extension 增加可注入的 workspace inspector，仅用于用真实 Git 构造确定性竞争窗口；生产默认仍使用 `inspectExecutorWorkspace()`。
2. settle 在所有 range、clean、writePaths 检查通过后、追加最终 `task.settled` 前再次检查 workspace；HEAD 或 clean 状态变化时 fail-closed，事件、projection、registry、origin 和 lease 均不得由 handler 改变。
3. 首次 active disposition 在 settlement identity 校验后、任何 origin HEAD/ref 读取和 started event 追加前再次检查，并与首次 inspection 的 HEAD/状态精确比较。
4. 对 succeeded disposition，在 integration、preserve 确认或 destructive cleanup 的最晚可控边界继续复核 durable settlement/starter identity；不得用历史无绑定 replay 伪造新权限。
5. HEAD 漂移返回稳定、可操作的错误 envelope；wrong branch、missing lease、Git infrastructure 仍保留原有优先分类。
6. 不宣称跨外部非协作 Git 进程实现数学上的单事务；通过最晚边界复核和既有 expected-head Git 防线，将可控窗口 fail-closed。

## 6. 验证方案

1. tests-only RED：注入真实 inspector，在首次 inspection 得到 A 后提交 B；`goal_settle` 必须拒绝且无 durable/Git handler 副作用。
2. tests-only RED：对 succeeded `integrate`、`discard`、`preserve` 重复同一竞争，必须在 started event 前拒绝。
3. 验证错误包含稳定 code、`observed`、`remediation`、`stateChanged=false` 和 schema-valid `goal_status` action。
4. 保留历史 v1、门禁前 unbound v2 replay、wrong branch、missing lease、Git infrastructure 及 failed/blocked dirty recovery 回归。
5. 运行 settlement 定向矩阵、events/extension/audit suites、全部 `goal-engine-*` tests 与 `git diff --check`。
