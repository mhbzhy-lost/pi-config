# Goal v1 strict coordinator 未生成 Host ticket

## 现象

public `goal_init` 仍写入 `planned.v1`，`goal_dispatch` 已产生 dispatch request；随后 coding spawn 经过 `prepareRunBindingTicket` 时 strict Goal 门禁仅承认 Goal v2（或被错误地扩展到全部 legacy event generation）。前者返回 `null`，Root coordinator 因而无法生成 `goal-run-binding-ticket.v2` 和 workspace request；后者则错误授权 historical event.v1/v2/v3。

## 调用链与可达性

生产可达路径是 public `goal_init`（planned.v1）→ `goal_dispatch` → Host coordinator `prepareSpawn` → `prepareRunBindingTicket` → strict-generation 判定。`null` 会使 coding dispatch 缺少 Goal workspace binding；匹配 Goal 的无 ticket 路径由 coordinator 以 `GOAL_RUN_AUTHORIZATION_REQUIRED` fail closed，不能降级 standalone。

`goal-runtime.v1` 也经过相同 public init/dispatch/coordinator 路径。Host ticket 协议的 `goal-run-binding-ticket.v2` 是 RunAuthorization 安全协议版本，不代表 Goal ledger generation，v1 ledger 不应被升级。

## 首偏离与根因

首偏离是 run-binding 层将 strict coordinator 资格与 Goal v2 ticket-era capability 绑定，遗漏 T0 后唯一可新写/dispatch 的 planned.v1、goal-runtime.v1。以 legacy executor transport shape 修复该问题时，若直接使用 `isLegacyExecutorGeneration`，又会将只读 historical event.v1/v2/v3 误升级为 strict。

## 修复

在 generation compatibility 边界提供单一公开 `isWritableGoalGeneration`：仅 `planned.v1` 与 `goal-runtime.v1` 为真。run-binding 消费它决定 strict coordinator 资格；legacy shape adapter 仅继续决定 v1 event/binding serialization，不能成为授权条件。v2 继续 read-only，unknown fail closed。
