# opt-in ceiling候选注册到错误session identity

## 来源分类：1（目标合法production入口未正确处理）

- 实际入口：Pi1.0.2公开createAgentSession + DefaultResourceLoader + 正式subagent-runtime入口，SessionManager.create提供persistent会话；真实SDK bindExtensions产生session_start。
- 权威身份：getSessionId() UUID与getSessionFile()实际persistent路径由SessionManager生成。
- 完整调用链：session.bindExtensions → ExtensionRunner session_start → typed beforeUpstreamSessionStart → registerConfiguredChildToolCeiling → registerSubagentCapabilityCeiling(rootSessionId)。
- 首偏离点：本仓传UUID，上游0.75 resolveCurrentSessionId却优先使用sessionFile，因此合法persistent session查不到ceiling，内存session才偶然正确。
- 未手写request/event/proof；SDK常规事件顺序有效。broker/workspace基于UUID的authority保持，不改它们的身份。
- RED：p0-real-runtime-correct-red-22.log：真实lifecycle identity返回undefined，预期显式allowedTools。
- 最小修复：ceiling使用既有lifecycleSessionId。无配置行为不变；真实registry及shutdown继续验收。

## cleanup债务第二偏离点

- 正常公开session_shutdown → typed beforeRuntimeDispose → RootBroker.closeRootSession失败（真实broker I/O关闭边界注入，身份/registry/生成顺序未模拟）。
- 原实现收集错误却继续清空broker与dispose ceiling，导致可重试债务丢失、仍存活child的策略先被释放。
- 分类1：Root Broker drain可能由正常I/O失败产生；本次故障注入只用于精确RED，不把注入的payload当production。
- 最小修复：broker drain失败立即保留资源并报告；coordinator关闭失败同样保留，成功后才解绑workspace和ceiling。不新增兼容路径。
