# Attempt settled 后中断导致 validation 不可恢复

## 1. 现象

Task64A1在冻结HEAD `d9c36d8`上唯一运行双Plan真实Harness。一个Plan完成`validated`，另一个Plan停在projection 10：task-1 Attempt为`succeeded`，task-2为`validated`，没有integration/gates。完整报告见`.pi-subagents/artifacts/verification/task64a1-dual-plan-flat-red.md`。

卡住Plan的generation 1在第二次`plan_status`开始后退出，transcript有tool start但没有tool end/result。退出前已durable写入task-1 `attempt.settled(succeeded)`，但尚未写`attempt.validated`。generation 2恢复后读到该精确状态，`plan_continue`返回`ready-to-integrate`，随后等待一个永远不会再来的外部lifecycle push。

## 2. 真实证据与反证

本次真实Root已成功产生两个v4 Plan handle、四个typed Executor和十个top-level actual dirs。两个logical caller都完成generation 0→1→2，十个official terminal均observed exit 0，所有PID均`ESRCH`。因此不是caller饥饿、跨Plan路由、Executor未结束或flat topology失败。

卡住Plan的事件链精确为：两个`attempt.bound`、两个`attempt.settled`，只有task-2一个`attempt.validated`。task-1 result commit与owned Attempt worktree都存在。terminal fact已被generation 1消费，不能要求Root重发或从status/artifact猜测一次。

成功Plan在同一Root、同一provider和同一代码上恰好一次性消费两条completion并完成，说明单Plan/理想批次GREEN掩盖了“工具在两个领域事件之间退出”的恢复缺口。

## 3. 根因

`settleBoundAttempt()`的成功路径按顺序执行：

1. 读取Attempt HEAD；
2. append `attempt.settled(succeeded)`；
3. 执行approved validation；
4. append `attempt.validated`；
5. enqueue integration。

步骤2之后进程可随时退出，所以`succeeded`是合法durable checkpoint，不是理论上的瞬时状态。但当前Coordinator只在`recover()`中遍历`activeAttempts`并查询backend terminal；`coordinatorFor()`只把`validated` Attempt重建到integration queue。`succeeded`既不会再次validation，也不能重新消费已经出队的execution fact。

Capsule的Root-owned路径又不会为本地`ready-to-integrate`重复登记`plan-opened` wake，这是正确的one-shot约束；因此不能用重发旧wake掩盖领域恢复不完整。

## 4. 正确修复

把成功验证拆成可幂等恢复的领域步骤：

1. Coordinator新增仅接受`succeeded` Attempt的validation恢复原语。
2. 从current projection、immutable IR、persisted workspace lease和approved verification完整重建输入；不得接受caller补充字段。
3. 复用与正常settle完全相同的`validateAttemptResult`、validation hash和`attempt.validated`事件。
4. validation失败继续append `plan.blocked(attempt_validation_failed)`，不得把失败当成可忽略重试。
5. validation成功后向当前generation的integration queue enqueue；已`validated`或后续状态幂等跳过，禁止重复事件/queue entry。
6. `plan_status`和`plan_continue`在返回/调度前恢复persisted succeeded Attempts，使没有新execution fact的generation也可前进。

不得重放terminal fact、再次spawn/poll Executor、从Git HEAD直接伪造validated、把`succeeded`视为accepted，或重置one-shot `plan-opened` wake。

## 5. TDD 验证

先在Coordinator测试构造真实append-only projection：active Attempt已有`attempt.settled(succeeded)`但无`attempt.validated`，创建新Coordinator实例后执行恢复，预期：

- exact一次validation；
- exact一个`attempt.validated`；
- exact一个integration queue entry；
- 再次恢复不重复；
- malformed/missing lease或validation rejected仍fail closed。

再在Plan Runner dependencies测试证明：fresh generation无execution facts时，`plan_status`或`plan_continue`可从persisted succeeded恢复validation并继续integration；不得调用backend spawn/status猜测终态。

RED使用已保存task64a1唯一真实Harness，旧HEAD不得重跑。focused GREEN后冻结新HEAD并只运行一次新的双Plan真实Harness。

## 6. 影响边界

影响所有在`attempt.settled(succeeded)`与`attempt.validated`之间退出的Plan Runner，不限双Plan。中断可能来自Root lifecycle新generation、Pi tool取消、进程退出或系统故障。

若不修，Plan保留正确提交却永久停在`succeeded`，只能人工修改事件或丢弃工作；在并发completion分批到达时暴露，修复代价中。若错误依赖runtime fact重放或伪造validated，可能重复执行或集成未验证代码，修复代价高。
