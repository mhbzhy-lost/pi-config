# flat Harness 假定 public status 暴露 asyncDir

## 1. 现象

修正runtime artifact clean oracle后，新的真实persisted flat Harness已通过最终Plan洁净检查，但随后失败于：

```js
const runs = [{ runId: handle.planRunnerRunId, asyncDir: handle.asyncDir }, ...status.tasks.flatMap((task) => task.attempts)];
assert.ok(runs.every((run) => run?.runId && run?.asyncDir));
```

final status中的两个attempt都有exact `runId`，但没有`asyncDir`，因此断言失败。冻结基线只运行一次，报告见`.pi-subagents/artifacts/verification/task63cg-flat-harness-status-asyncdir-red.md`。

## 2. 真实证据与反证

本次owned root仍达到Plan `validated`、projection 22、两Task accepted、两attempt integrated、四gate passed。Plan session恰好有2个typed `subagent` call、2个exact `coding-dispatch-handle.v1` result和2个`attempt.bound`事件；actual runtime恰好有2个Executor与3代Plan Runner。

两个handle、final status的`attemptId/dispatchId/runId`、`attempt.bound`的`attemptId/dispatchId/runId/asyncDir`全部精确匹配。5个run均official observed exit 0且无runtime parent/depth/path。

`createPlanStatus()`源码明确只投影attempt的`attemptId/status/dispatchId/baseCommit/workspace/runId/attention/resultCommit/release/artifacts`等人审字段，不投影内部`asyncDir`与`sessionFile`。这不是terminal recovery丢失：append-only `attempt.bound`事件和内部projection都完整持有binding，revived backend也依赖它完成恢复。

## 3. 根因

Harness把两个不同权威面混为一个：

- public derived status负责生命周期、任务、attempt状态和稳定runId；
- append-only Plan event log负责完整execution binding，包括`asyncDir/sessionFile`。

`assertFutureGreen()`在稍后已经读取Plan事件并验证dispatch，但它在读取事件之前就用status attempt直接构造runtime run列表，隐式要求status包含从未承诺的字段。此前Harness总在更早断言失败，该过时假设未被执行。

## 4. 正确修复

只修改flat Harness：

1. 在构造Executor run列表前，从初代Plan Runner status取得persisted sessionFile并读取Plan events。
2. 要求exact两个`attempt.bound`事件；按`attemptId`为每个final status attempt找到唯一bound。
3. 精确比较bound与status的`attemptId/dispatchId/runId`，任何零匹配、多匹配、missing identity或不一致都fail closed。
4. Executor runtime run对象使用status的stable `runId`与matching bound event的`asyncDir`。
5. 后续Plan revision/dispatch event断言复用同一events数组，不重复读取或改变public status schema。

不得把`asyncDir`加入public `pi-plan-status.v1`，不得按TMPDIR扫描猜测run，不得从handle数量反推Executor目录，也不得放宽runtime identity断言。

## 5. TDD 验证

这是tests-only Harness oracle纠错，无production逻辑变更。task63cg真实Harness提供RED：clean断言通过后，唯一失败精确为status attempt缺`asyncDir`。旧基线不得重跑。

修复后运行syntax与既有Plan projection/event focused tests，证明public status继续不暴露`asyncDir`而bound event继续保存完整binding。再冻结新HEAD/index/porcelain/migration/root-basename S0，只运行一次新的persisted Harness；预期status↔bound exact cross-check、flat topology、official proof、final validated和PID cleanup全部通过。

新基线无论GREEN/RED也只能运行一次。

## 6. 影响边界

变更只影响flat Harness取证顺序和数据源，不修改Plan events、projection、Root broker、backend、provider、artifact或migration。

若不修，正确的public status最小化会让Harness永久假RED；在runtime-clean断言通过后暴露，修复代价低。若改成扫描async directories或宽松匹配，则可能把重复/foreign Executor误判为合法，修复代价高，因此必须使用exact bound event identity。
