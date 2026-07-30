# Bug：Root Broker ready 前 Supervisor request 被永久丢弃

## 症状

Root runtime 已注册 native Supervisor `message_end` ingress，但 callback 只在 `brokerStarted===true` 时路由。会话 startup/reload/resume 时，上游 Supervisor channel 先启动并立即扫描 pending request；项目 Broker 后启动且需要异步绑定 socket，因此早到 custom message 会被 callback 静默丢弃。

## 影响

恢复中的 Executor 已写入 request 文件时，Plan Runner 永远收不到对应 Attention。上游扫描器已把文件加入 `seenFiles`，后续 poll 不会重发；Executor 会持续等待 reply，Plan Runner 则看不到 pending request，形成无可见进展的死锁。

## 复现

上游 `pi-subagents/src/extension/index.ts` 的 `session_start` handler 调用 `supervisorChannel.start()`；`native-supervisor-channel.ts` 的 `start()` 先 `poll()` 再安装 interval，poll 在发送消息前将文件加入 `seenFiles`。项目 `subagent-runtime.ts` 的 Broker handler在 bootstrap 之后注册，并异步执行 `startAndBindRootBroker()`；当前 `onSupervisorRequest` 在 `brokerStarted` 为 false 时直接返回。

## 根因

Root ingress 把“Broker 尚未 ready”误当成“消息无需处理”，没有显式 startup mailbox。Pi extension 的 `sendMessage({triggerTurn:true})` 启动异步消息轮次，而 upstream API 不等待该 Promise，导致 native message 与后注册的 Broker startup handler真实并发。

## 修复

先新增独立 unit RED，定义有界 session-local Supervisor startup mailbox：ready 前按接收顺序缓冲原 message/context；activate 后串行 drain；ready 后直接路由；deactivate/dispose 清空旧 session 消息并拒绝旧 handler。Root wrapper 在安装时创建 mailbox，Broker成功启动后 activate，在 shutdown/启动失败时 deactivate，禁止恢复 Standalone fallback。

## 验证

unit 测试证明 ready 前零 route、activate 后严格原引用有序 route、ready 后直接 route、deactivate 后旧消息不跨 session。随后运行 Task 7 全部定向与完整 Root Broker/runtime/Capsule suites，并在真实持久化 Harness 中验证 startup/reload pending Attention 不丢失。
