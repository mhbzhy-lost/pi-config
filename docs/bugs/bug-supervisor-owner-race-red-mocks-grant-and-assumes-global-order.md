# Bug：Supervisor owner 竞态 RED mock grant 且假设全局顺序

## 症状

`dc6865e` 新增三个 Supervisor owner 竞态 RED；父级以串行方式复现时为 0/3 通过。失败并不都表示 Root Broker 尚未实现：第一项测试直接重写 `broker.ensureExecutorOwner`，使测试路径脱离真实的 principal/grant single-flight；同一组测试还按 `supervisorRequests` 的全局 `Map` 顺序断言 `A1, B1, A2`。

真实调度中，先完成绑定的 Executor A 应可提升并投递 `A1, A2`，随后才处理 B 的 `B1`。因此该观察结果不满足测试的跨 Executor 全局排列，却没有违反 owner 绑定竞态的合同。

## 影响

若将这三个 RED 直接作为 GREEN 的实现目标，生产代码会被迫迎合 mock 的行为，而不是验证真实状态机的 principal、grant、dispatch 与 spawn 协作。实现可能为等待未绑定 B 而阻塞已可绑定 A，扩大 Supervisor request 的滞留窗口，并错误建立跨 Executor 的全局串行依赖。

这会掩盖真正需要保证的行为：同一 Executor 的 request 不丢失、FIFO 重放、重复项受控，以及关闭开始后不再提升延迟到达的工作。

## 复现

1. 在 `dc6865e` 的父级串行复现中运行新增的三个定向 RED；结果为 0/3 通过。
2. 查看第一项测试：它覆盖 `broker.ensureExecutorOwner`，令 owner 写入和 grant single-flight 不再经过真实实现，故失败或通过都只能证明 mock 编排，不能证明真实状态机。
3. 让 A 的 `A1`、`A2` 在 B 的 `B1` 仍未绑定时到达，并先完成 A 的 owner 绑定。实际可观察顺序为 `A1, A2, B1`；原测试期待 `A1, B1, A2`，从而把不受合同保证的跨 Executor 全局 `Map` 顺序误当成 oracle。

## 根因

测试把依赖注入点选在被测 Broker 的核心方法 `ensureExecutorOwner`，覆盖了真实的 principal/grant single-flight 路径。这样既不能覆盖 owner 绑定和 grant 写入之间的真实竞态，也无法证明 `dispatch`、legacy spawn 与 ensure 的组合仍保持合同。

此外，测试将所有 Executor 的 ingress 线性化为一个全局顺序。合同只保证每个 Executor 内的 FIFO，以及 request 进入同一 caller FIFO 后的顺序；不同 Executor 之间没有全局 FIFO 合同。未绑定的 B 不能阻塞已经可绑定的 A。

## 修复

先修正 tests-only oracle，再进入 GREEN。测试应对注入的 `writeGrant` 使用 deferred promise，以此稳定制造 grant 尚未完成时 Supervisor request 到达的真实窗口；不得覆盖 `ensureExecutorOwner`。

保留真实 Broker `dispatch`、`spawnLegacy` 和 `ensureExecutorOwner` 路径，让测试验证 principal/grant single-flight 与 owner promotion 的实际状态机。断言应按 Executor 分组检查 FIFO，并仅在各 request 已进入同一 caller FIFO 后检查该 caller 内顺序；删除要求 `A1, B1, A2` 的跨 Executor 全局顺序断言，允许可绑定 A 的 `A1, A2` 先于未绑定 B 的 `B1` 被提升。

补充下列定向断言：

1. exact duplicate 在 unbound 到 bound 的转换期间只投递一次。
2. close 已开始后，即使延迟的 spawn 或 grant 完成，也不得 promotion pending request。
3. normal close 的既有 collection 清理断言必须纳入 pending collection，确认正常关闭后不遗留 pending、去重或等待项。

## 验证

本次为 docs-only 豁免：不修改测试或 production，不运行真实 Harness。文档依据 `dc6865e` 已记录的三个 RED 与父级串行 0/3 通过结果，明确将其定位为 tests-only oracle 问题。

后续 tests-only 修正应先运行三个定向用例，确认它们保留真实 Broker dispatch/spawn/ensure 路径，并分别覆盖 deferred `writeGrant` 窗口、每 Executor FIFO、同一 caller FIFO、跨 transition exact duplicate、in-flight close 及 normal close collection 清理。只有这些 oracle 固定后，才可将 RED 作为 GREEN 实现依据；真实 Harness 不属于该验证步骤。
