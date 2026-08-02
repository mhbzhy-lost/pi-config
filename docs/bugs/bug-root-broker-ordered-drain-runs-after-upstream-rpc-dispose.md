# Bug: Root Broker 有序关闭晚于上游 RPC 销毁

## 症状
生产扩展触发 `session_shutdown` 时，上游 `pi-subagents` 先执行自身清理并销毁 RPC bridge，随后项目侧才调用 Root Broker 的 `closeRootSession()`。Broker 尝试停止仍在运行的 Executor 时没有 RPC 接收方，等待终态证据直至超时，且 broker marker 保持启用。

## 影响
Root session 无法可靠完成 Executor → Plan Runner → transport 的有序关闭。运行中的 Executor 可能未收到 stop；第一次失败后，上游 RPC bridge 已不可恢复，后续 shutdown 重试也无法偿还 cleanup debt，造成关闭阻塞和资源残留。

## 复现
通过真实 `DefaultResourceLoader/createAgentSession` 生产加载路径启动项目扩展并创建一个 Root Broker 所属运行；触发 session shutdown。当前注册顺序使上游 handler 先调用 `rpcBridge.dispose`，项目 handler 随后发送 stop；约 5 秒后抛出 `Root executor drain failed`，运行未收到 stop，`PI_ROOT_SUBAGENT_BROKER_ENABLED` 仍为 `"1"`。

## 根因
`installHeadlessTypedSubagentRuntime()` 在调用 upstream bootstrap 时直接把项目 Pi API 暴露给上游。上游因此把 `session_shutdown` handler 直接注册在项目 API 上，并且注册时间早于项目侧 `beforeRuntimeDispose` handler。Pi 按注册顺序执行 shutdown，导致依赖 RPC 的 ordered drain 晚于 RPC bridge 销毁。

## 修复
在 headless membrane 中捕获上游注册的 `session_shutdown` 清理，不让它直接进入 Pi 的 shutdown handler 队列；项目唯一 shutdown owner 先执行 Root Broker ordered drain，再执行捕获的上游清理，最后 dispose 项目 RPC/registry。若 ordered drain 失败，不执行上游清理并保留全部 ownership 供重试；上游清理与项目 dispose 均保持幂等。

## 验证
先增加真实生产加载路径回归测试，证明 owned run 的 stop 必须在上游 RPC bridge dispose 前送达，并验证第一次 ordered drain 失败后可重试。确认测试在旧实现上以预期的关闭顺序失败，再做最小实现；最后运行 runtime membrane、resource isolation、Root Broker、完整 `npm test`、Doctor、Pi integration、Python external-review tests 和 `git diff --check`。
