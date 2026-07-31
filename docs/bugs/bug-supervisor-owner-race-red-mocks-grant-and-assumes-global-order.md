# Bug：Supervisor owner 竞态 RED mock grant 且假设全局顺序

## 症状

`dc6865e` 新增三个 Supervisor owner 竞态 RED；父级以串行方式复现时为 0/3 通过。失败并不都表示 Root Broker 尚未实现：第一项测试直接重写 `broker.ensureExecutorOwner`，使测试路径脱离真实的 principal/grant single-flight；同一组测试还按 `supervisorRequests` 的全局 `Map` 顺序断言 `A1, B1, A2`。

首次纠正后又发现，测试注入的 deferred `writeGrant` 对 Plan Runner grant 也只返回 `/tmp/...` 假路径，却没有写入真实 grant。`createRootBrokerClient.subscribe()` 因此在 `t.after` 安装前报 `GRANT_NOT_READY`，留下仍在监听的固定 socket；focused 命令显示用例快速失败，但 Node 进程不会退出。这同样不是 owner promotion 缺失产生的目标 RED。

补充 in-flight close RED 后，首次GREEN达到 5/6；剩余用例的 settle-time owner、request 和 Supervisor push 均为零，却因关闭结束时收到一个正常 `root.closing` push 而失败。测试把全部订阅push计为Supervisor delivery，错误禁止了既有shutdown通知协议。

真实调度中，先完成绑定的 Executor A 应可提升并投递 `A1, A2`，随后才处理 B 的 `B1`。因此该观察结果不满足测试的跨 Executor 全局排列，却没有违反 owner 绑定竞态的合同。

## 影响

若将这三个 RED 直接作为 GREEN 的实现目标，生产代码会被迫迎合 mock 的行为，而不是验证真实状态机的 principal、grant、dispatch 与 spawn 协作。实现可能为等待未绑定 B 而阻塞已可绑定 A，扩大 Supervisor request 的滞留窗口，并错误建立跨 Executor 的全局串行依赖。

这会掩盖真正需要保证的行为：同一 Executor 的 request 不丢失、FIFO 重放、重复项受控，以及关闭开始后不再提升延迟到达的工作。

## 复现

1. 在 `dc6865e` 的父级串行复现中运行新增的三个定向 RED；结果为 0/3 通过。
2. 查看第一项测试：它覆盖 `broker.ensureExecutorOwner`，令 owner 写入和 grant single-flight 不再经过真实实现，故失败或通过都只能证明 mock 编排，不能证明真实状态机。
3. 首次改用 deferred `writeGrant` 后，在隔离的 `rootSessionId` 下运行同一 focused 选择器；四项用例均在约 16ms 内报错，但命令 60 秒后仍未退出。检查测试可见 Plan Runner grant 只返回假路径，订阅在 cleanup hook 安装前失败。
4. 完成最小pending/promotion实现后，以隔离 `rootSessionId` 运行六项focused GREEN；结果为5/6。close竞态用例的 `ownerAtSettlement`、`requestsAtSettlement` 和 `pushesAtSettlement` 均符合零值，最终push数组只有正常的 `root.closing`，但原断言要求所有push数量为零。
5. 让 A 的 `A1`、`A2` 在 B 的 `B1` 仍未绑定时到达，并先完成 A 的 owner 绑定。实际可观察顺序为 `A1, A2, B1`；原测试期待 `A1, B1, A2`，从而把不受合同保证的跨 Executor 全局 `Map` 顺序误当成 oracle。

## 根因

测试把依赖注入点选在被测 Broker 的核心方法 `ensureExecutorOwner`，覆盖了真实的 principal/grant single-flight 路径。这样既不能覆盖 owner 绑定和 grant 写入之间的真实竞态，也无法证明 `dispatch`、legacy spawn 与 ensure 的组合仍保持合同。

首次纠正又把 deferred 行为错误扩大到所有角色。Plan Runner grant 是 client 订阅的真实认证前置条件；只返回未落盘路径会让测试停在认证失败，而不是进入 Supervisor ingress 窗口。由于 cleanup hook 尚未安装，Broker server 继续持有固定 socket，外层超时只能杀死测试命令，不能产生可信 RED。

close竞态oracle又把订阅观察面的所有push合并计数，没有按 `type` 区分被禁止的 `supervisor.request` 与关闭协议必须发送的 `root.closing`。因此正确保留shutdown通知的实现也无法GREEN，反而会诱导production删除既有关闭消息。

此外，测试将所有 Executor 的 ingress 线性化为一个全局顺序。合同只保证每个 Executor 内的 FIFO，以及 request 进入同一 caller FIFO 后的顺序；不同 Executor 之间没有全局 FIFO 合同。未绑定的 B 不能阻塞已经可绑定的 A。

## 修复

先修正 tests-only oracle，再进入 GREEN。测试应对注入的 `writeGrant` 只在 `grant.role === "executor"` 时使用 deferred promise，以此稳定制造 grant 尚未完成时 Supervisor request 到达的真实窗口；Plan Runner grant 必须复用 `writeBrokerGrant` 落盘，使真实 client 能完成订阅。不得覆盖 `ensureExecutorOwner`。

保留真实 Broker `dispatch`、`spawnLegacy` 和 `ensureExecutorOwner` 路径，让测试验证 principal/grant single-flight 与 owner promotion 的实际状态机。cleanup hook 必须在任何可能失败的订阅之后仍能回收server；隔离复验须设置测试级 deadline，并确认命令自行退出而非依赖外层强杀。close竞态应分别断言settle-time和最终 `supervisor.request` 数量为零，同时要求正常关闭仍收到exact一个 `root.closing`。断言应按 Executor 分组检查 FIFO，并仅在各 request 已进入同一 caller FIFO 后检查该 caller 内顺序；删除要求 `A1, B1, A2` 的跨 Executor 全局顺序断言，允许可绑定 A 的 `A1, A2` 先于未绑定 B 的 `B1` 被提升。

补充下列定向断言：

1. exact duplicate 在 unbound 到 bound 的转换期间只投递一次。
2. close 已开始后，即使延迟的 spawn 或 grant 完成，也不得 promotion pending request。
3. normal close 的既有 collection 清理断言必须纳入 pending collection，确认正常关闭后不遗留 pending、去重或等待项。

## 验证

本次为 docs-only 豁免：不修改测试或 production，不运行真实 Harness。文档依据 `dc6865e` 已记录的三个 RED 与父级串行 0/3 通过结果，明确将其定位为 tests-only oracle 问题。

后续 tests-only 修正应先运行三个定向用例，确认它们保留真实 Broker dispatch/spawn/ensure 路径，Plan Runner grant 真实落盘，命令在测试级 deadline 内自行退出，close断言区分Supervisor delivery与`root.closing`，并分别覆盖 deferred Executor `writeGrant` 窗口、每 Executor FIFO、同一 caller FIFO、跨 transition exact duplicate、in-flight close及normal close collection清理。只有这些oracle固定后，才可将RED作为GREEN实现依据；真实Harness不属于该验证步骤。
