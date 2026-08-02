# Bug：上游恢复事件早于 Root Broker 生命周期监听

## 1. 现象

新 shutdown debt 门禁在生产 `session_start` 中先调用 `runtime.ready()`，随后才创建并启动 `RootBrokerServer`。`ready()` 会执行上游 `pi-subagents` 的恢复 handler；若恢复过程立即发布 `subagent:async-started`、完成或终态事件，此时 Broker 尚未订阅这些事件。

## 2. 影响

恢复出的 Executor 或 Plan Runner 可能没有进入 Broker 的运行所有权账本。后续 Root shutdown 将无法完整停止和验证这些运行，revival 路由、grant 清理及终态证明也可能缺失，形成孤儿进程或不可偿还的资源债务。

## 3. 稳定复现

构造 headless runtime：上游 `session_start` handler 同步发布一条合法 `subagent:async-started`，项目启动钩子负责启动真实 `RootBrokerServer`。当前实现没有“上游恢复前”钩子，因此恢复事件先发生，Broker 的 `ownedRuns` 中不存在该 run。

## 4. 根因

`installHeadlessTypedSubagentRuntime()` 只提供单一 `beforeSessionStart` 内部阶段，并在其中直接执行捕获的上游 handler；生产扩展只能在另一个、注册更晚的 `pi.on("session_start")` handler 中启动 Broker。旧 debt 偿还、项目基础设施启动和上游恢复三个阶段没有显式排序接口。

## 5. 修复

为 headless runtime 增加受控的 `beforeUpstreamSessionStart` 钩子。`ready()` 先偿还旧 generation debt，再执行该项目钩子以 renew RPC、创建并启动 Broker，最后才运行上游恢复 handler 并激活其事件订阅。生产扩展删除独立的晚注册 `session_start` handler，把现有 Broker 启动事务迁入该钩子。

## 6. 验证

先增加真实 Broker 回归，证明上游恢复同步发布的 started 事件能被已启动 Broker 捕获；旧实现应稳定 RED。修复后运行 production shutdown、runtime membrane、resource isolation、Root Broker、完整 `npm test`、Doctor、integration 与 `git diff --check`。
