# Bug: Flat Harness 误信 upstream isNested route 标记

## 症状

真实flat Harness已清除全部`PI_SUBAGENT_*`环境，Plan Runner仍在raw `status.json`中得到`isNested:true`。测试把该字段要求为`false`，因此会把Root直接启动的一级run误判为嵌套run。

## 影响

Plan Runner和Executor即使由同一Root broker直接拥有、位于顶层async目录且没有runtime parent，Task 10 Harness仍无法通过。若为满足断言改写raw artifact，会破坏upstream生命周期权威并制造双重事实源。

## 复现

1. Root通过pinned `pi-subagents@0.37.2` RPC执行普通async spawn。
2. Upstream executor在无继承route时仍为潜在后代创建新的`nestedRoute`。
3. Root launch没有`nestedSelf`、parent/depth/path，目录位于顶层`async-subagent-runs/<runId>`。
4. Runner却仅按`config.nestedRoute`存在写入`isNested:true`，而非按`config.nestedSelf`判定。

## 根因

Harness把upstream的route基础设施标记当作runtime拓扑权威。当前pinned实现中，`nestedRoute`表示该run可承载后代事件，不表示该run本身有父run；字段命名和写入predicate与upstream自身的top-level目录判定不一致。

## 修复

不删除拓扑验证，也不把`isNested:true`表述成正确结果。Harness改用可证伪的真实拓扑证据：每个run的`asyncDir`必须位于本次Root `TMPDIR`内的顶层`async-subagent-runs/<runId>`，不得位于`nested-subagent-runs`；status不得携带parent/depth/path；三个run共享Root persisted session identity且runId互异。保留raw artifact不变。

## 验证

Plan Runner和两个Executor都满足上述顶层目录、无父身份、共享Root session约束；Harness继续验证v4 handle、Plan事件和exact dispatch。compat文档记录`isNested`是`0.37.2`已知quirk；未来升级到按`nestedSelf`判定的版本后再恢复字段级断言。
