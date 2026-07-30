# Plan Runner Flat Runtime

## 架构边界

```text
领域拓扑: Main -> Plan Runner -> Executor
runtime 拓扑: Root -> [Plan Runner, Executor]
生命周期: Root session 单一 owner，其他 Root 不恢复
dispatch: tool -> child adapter -> Root broker -> local pi-subagents RPC
授权: dispatch event + one-shot contract hash
Supervisor: broker ownership routing
淘汰: Standalone Host、re-root、fanout-child、跨 Root attach
```

领域拓扑描述职责与合同传递：Main 批准 Plan，Plan Runner 根据批准的 Plan IR、revision、Attempt 与 Gate 规则组织执行，Executor 只执行已授权的 Attempt。runtime 拓扑描述实际 session 进程：Plan Runner 和 Executor 都是同一个 Root 的直接运行单元。因此领域父子关系与 runtime siblings 不冲突，前者不是进程父子关系。

Root session 是唯一生命周期 owner。Launcher 通过 `pi.appendEntry(HANDLE_TYPE, handle)` 将 session-local v4 handle 写入当前 Root session branch；`root-session-owner.ts` 不保存 handle，而是在 child 中订阅 `root.closing` 与 ownership EOF 并以 `SIGTERM` 终止该 child。Root broker 维护本地 pi-subagents RPC 的派发和 ownership routing；另一个 Root 不恢复、不接管、不发送控制请求。每次派发的 `spawnKey` 只在创建它的 Root 内有效，是私有关联键，不能作为跨 session 的恢复标识。

Plan Runner 模型原样调用项目 `subagent` 工具；Plan Capsule 仅对该 tool call 做一次性授权，既不直接 spawn，也不禁止工具调用。已授权请求由 child adapter（`root-owned-subagent`）转给 Root broker，broker 再调用本地 `pi-subagents` RPC。dispatch event 与一次性 contract hash 绑定请求、Attempt 和执行合同；官方 terminal proof 是 Executor 终态的依据，格式化 RPC status 仅用于诊断与对账。

Executor 的 native supervisor request 经 broker ownership routing 只到 owning Plan Runner；Plan Runner 持久化 Attention。当前 Root 的 Launcher projection 通知桥面向 Main，Main 的 `plan_attention_reply` 从当前 projection 写入 durable command，Plan Runner 再以 fenced `plan_executor_supervisor` reply 投递该命令。Executor 不直接向 Root 请求。

同 Root 的关闭顺序固定：停止新派发，对 Executors 请求 `stop` 并等待官方 terminal proof，再对 Plan Runner 请求 `stop` 并等待 proof，最后关闭 broker transport 并 dispose upstream。`interrupt` 不是 shutdown 控制。该顺序保留 Attempt、Gate 和审计所需事实，且不允许其他 Root 介入。
