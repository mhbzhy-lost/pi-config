# Live Executor completion push 丢失 Plan Runner post-proof revival

## 1. 现象

`fb4d1d8` 唯一真实 A2 中，一个 Plan Runner generation 在活跃订阅期间收到 Executor observed completion，随后开始 `plan_continue(reason=integrate)`；子进程在 tool 未结束时 exit 0，Root 接受 official proof 后记录 `wake-missing`，Plan 停在两个 validated Attempt。

## 2. 影响

已持久化的 Executor 完成事实可以被 Plan Runner 读到并完成验证，但 integration/gates 依赖同一 ephemeral generation 的 live follow-up。upstream idle-settle 提前结束该进程时，没有下一代接力，Plan 永久停滞。

## 3. 时间线

- generation `85cbeea2` 收到第二条 Attention reply 并调用 Supervisor reply。
- live Executor completion 作为 lifecycle custom message 到达；第二次 status 得到 projection version 17，两个 Attempt 均 validated。
- `plan_continue` 于 `1785512553453` 开始；进程于 `1785512553770` exit 0，status 仍为 `currentTool=plan_continue`。
- Root 于 `1785512553777` 接受 proof，诊断为 `wake-missing`；另一个 Plan 的 completion 在无订阅时排队并成功 revival/validated。

## 4. 根因

Root 的 `deliverOrQueuePush` 在 socket write 成功后立即把 lifecycle push 视为已交付并从 durable revival 条件中移除。Transport write 只证明消息进入 child socket，不证明该 ephemeral generation 完成了由消息触发的 Plan 领域工作。

## 5. 触发条件

Executor `execution.completed` 在 Plan Runner generation 仍有活跃 subscription 时到达；child 在 follow-up turn 的异步 tool 完成前由 upstream idle-settle 正常退出。

## 6. 修复与验证

仅对 live-delivered `execution.completed` 记录无 payload 的 actual-generation wake debt。当前 generation 仍可立即处理；无论 completion 与 Plan Runner proof 谁先到，Root 都必须在两者齐备后启动下一代。revival 开始时只消费 debt 快照；resume/grant 失败保留全部 debt，in-flight 新增 debt 在 successful handoff 后转移到 revived actual generation，避免一次布尔删除吞掉并发完成。started push、caller push FIFO、Supervisor request、Attention wake、grant schema 和 proof authority不变。RED 必须证明 live socket 已收到 completion 且 FIFO为空，但 proof 后仍需 resume；还必须覆盖 proof-first、同代合并、换代消费与 in-flight 新 debt 转移。
