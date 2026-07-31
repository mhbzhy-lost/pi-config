# Bug：Supervisor Executor owner 可被第二个 Plan 覆盖

## 症状

当前Supervisor pending GREEN在 `spawnLegacy()` 中无条件执行 `caller.ownedRunIds.add(runId)` 与 `runOwners.set(runId, logicalCallerRunId)`。若上游为两个Plan返回同一Executor runId，第二次spawn会覆盖第一个owner；两个Caller都保留该runId。

独立审查探针观察到最终 `runOwners` 指向Plan B，但已promotion的Supervisor request仍归Plan A。后续同payload duplicate因identity只绑定Executor和data而静默幂等，无法暴露owner已经漂移。

## 影响

Plan B可控制Plan A已经认领的Executor，或Plan A继续持有投递到旧owner的Supervisor request，形成跨Plan控制与Attention信息泄漏。`caller.ownedRunIds`、`runOwners`、`supervisorRequests.ownerRunId`三项权威不再一致。

该问题也会破坏Root B旧handle拒绝和同Root多Plan隔离的最终证据，因为错误发生在同一Root内部，不会被rootSession fence拦截。

## 复现

1. 为Plan A、Plan B分别创建合法caller grant。
2. 让两个并发或顺序spawn都返回同一runId与asyncDir。
3. 在A绑定窗口进入一个Supervisor request并完成promotion。
4. 让B的spawn继续完成；观察 `runOwners`被改为B，A/B的 `ownedRunIds`都包含该runId，而request仍归A。

## 根因

`ensureExecutorOwner()`只保证Executor principal/grant按runId幂等，不负责Plan领域owner。`spawnLegacy()`把principal幂等误当成owner可重复绑定，写入前没有compare-and-set，也没有验证既有owner是否等于当前logical caller。

Supervisor request identity有意不包含owner，以保证revived actual caller仍复用stable logical owner；因此不能依靠duplicate conflict补救owner覆盖，owner必须在绑定提交点单独fence。

## 修复

在修改任何caller或owner索引前执行owner compare-and-set：runId无owner时允许当前logical caller认领；已有owner等于当前logical caller时只允许同一caller的幂等路径；已有不同owner时fail closed，不修改两个caller、runOwners、pending或Supervisor request，并清理本次错误spawn副作用。

同一spawnKey重放继续由spawn ledger处理；不能把跨Plan同runId误当成合法重放。失败返回沿用受控spawn cleanup，且不得删除原owner的pending/request或principal。

## 验证

新增两个Plan返回同runId的真实Broker RED，断言第二次spawn失败、原owner与原request保持、Plan B零ownedRunId且不能control/reply。再覆盖stable logical caller revival alias，确认同logical owner的新actual generation不被误判为跨Plan冲突。

真实Harness在这些focused GREEN完成前不得运行。
