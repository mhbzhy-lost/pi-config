# Goal generation 半迁移：v2 public writer 未冻结

## 现象与 public 入口

`goal_init` 的 public runtime 分支接受调用者的
`execution.schema="goal-runtime.v2"`。调用链为：

```text
goal_init(params.execution)
  → normalizeRuntimeGoalInit(params, runtimeHost.registries)
  → goal.runtime_drafted(goal-runtime.v2) append
  → 后续 goal_dispatch
  → prepareRunBindingTicket（当时仅接受 planned.v2/goal-runtime.v2）
```

因此默认 `schemaVersionForMutation(undefined) → planned.v1` 与可显式创建
`goal-runtime.v2` 的 public writer 并存；后者又是旧 coordinator 的唯一可绑定
generation，构成半迁移。

## 权威身份与数据来源

| 分类 | 身份/位置 | 结论 |
| --- | --- | --- |
| production registry state | Host `runtimeHost.registries`、Goal JSONL ledger、managed workspace service、Root Broker registry | 只有 Host/服务拥有这些权威事实；本任务不读取或修改现存 `var/goals`、workspace 或 Broker state。 |
| 测试临时 state | Node test 创建的临时 Git root、临时 `.state/goal-engine`、fixture registry | 仅证明 public 调用和 reducer 行为，不是 production state。 |
| 来源未证实 | 手工拼装的 projection/event、未关联 public init 的旧 v2 JSONL | 不作为 writer 可达性证据；保持 decoder exact replay，mutation fail closed。 |

没有访问、打印或记录任何凭据。

## 事件/资源顺序与首个偏离点

目标顺序应为：generation preflight →（若允许）ledger append → dispatch request
append → workspace allocation → Broker registration/run binding。v2 的首个偏离点是
`goal_init` 在 generation preflight 缺失时调用 `normalizeRuntimeGoalInit` 后构造并
append `goal.runtime_drafted(goal-runtime.v2)`；这发生在 workspace allocation 和
Broker registration 前，但已经写入 ledger。随后 `prepareRunBindingTicket` 的 v2-only
条件使这条不应再写的新 generation 成为 coordinator 可达路径。

## 修复边界

新写只允许 `planned.v1`、`goal-runtime.v1`。public v2 init 与已持久化
planned/runtime v2 的 mutation、dispatch、settle、integrate、accept 必须以稳定
`GOAL_GENERATION_READ_ONLY` 在 append 和资源副作用前拒绝。保留 v2 codec、
`generationCapabilities()` decoder entry、`applyEvent(..., { replay: true })` 和 golden
fixture 的 exact replay；不得把 v2 隐式回写为 v1。Host-owned RunAuthorization 与
Broker capability grant v2 不属于本次 Goal writer 回退范围。
