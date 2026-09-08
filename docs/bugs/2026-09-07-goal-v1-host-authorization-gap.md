# v1 Goal Host 授权桥接缺口

## 现象与 public 入口

合法的 public 调用按以下顺序进入：

```text
goal_init(planned.v1)
  → goal_dispatch
  → dispatch-ir.v1 subagent
  → Goal runCoordinator.prepareSpawn
  → prepareRunBindingTicket
```

`planned.v1` 和 `goal-runtime.v1` 是当前唯一新写 Goal generation，但
`prepareRunBindingTicket()` 只接受 v2 projection。因此合法 v1 dispatch 没有
Goal ticket，typed subagent 将其误作 standalone coding 请求；这不是测试手写
ledger 或非法 fixture 能够造成的状态。

## provenance 与首个偏离点

测试通过 `goal_init`、`goal_status` 和 `goal_dispatch` public tool 建立临时
Goal state，随后从当前 Host registry 的 coordinator 请求 ticket。Goal/task、
attempt、contract hash、workspace request、root session 均由 projection/Host
提供。首个偏离点是 ticket 函数的 v2-only guard 在任何 workspace allocation、
Broker registration 或 `task.executor_bound` append 前返回 `null`。

这属于预期 production 数据未被正确处理：T0 已冻结 writer 到 v1，默认 public
writer 产生的 v1 projection 本应可由现有 Host-owned `RunAuthorization` 授权。
修复只在 composition boundary 将 v1 的既有权威字段映射为 Host ticket；v1 ledger
继续写 `task.executor_bound`/`executorBinding`，不写 v2 Goal event，也不恢复
legacy grant/proof writer。

## fail-closed 边界

当 dispatch-ir 的 taskId 精确匹配 Goal task 时，ticket 缺失或任意
task/attempt/contract/workspace/session/revision 漂移都必须在 ledger append、
workspace 和 Broker 副作用前拒绝，不能降级 standalone。真正不匹配 Goal task 的
standalone coding 请求维持原有路径。agent profile 只是 binding identity，绝不作为
capability 来源；可信 Host `RunAuthorization` 是唯一权限来源。
