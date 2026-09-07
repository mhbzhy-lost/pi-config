# Standalone managed worktree facade run 缺少 kind

日期：2026-09-05

## 分类与真实来源

该问题属于“预期 production 数据未被正确处理”。真实入口是 reload 后的 generic standalone managed worktree typed dispatch。workspace `22fb76a7-600b-4436-bfe9-70b4dc98c94f` 由统一 workspace service 分配，child `8712082d-b02f-458d-890b-f3a13a8e7334` 在隔离后的 managed dispatch cwd 中成功读取 README，证明 workspace 分配、dispatch cwd 与 workflow child 启动均已生效。最终 tool 返回 `SUBAGENT_RPC_FAILED: Facade run identity is invalid`，不是测试手工构造的不可达数据。

## 首个偏离点与调用链

完整调用链为：

`generic worktree -> workspace allocate -> workflow child start -> bindRun -> registerFacadeRun(authoritativeBinding) -> RootBrokerServer requires kind -> Facade run identity is invalid`

`createWorkflowChildStartCollector` 的 `onBinding` 按通用 lifecycle contract 只产生 `runId`、`asyncDir`、`sessionId`、`pid`、`agent`。workspace `bindRun` 正确消费这一通用 binding；首个偏离点发生在 extension 的 facade 注册边界：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 又将同一个 `authoritativeBinding` 原样传给 production callback。package runtime callback 随后原样调用 `broker.registerFacadeRun(run)`，而 `RootBrokerServer.registerFacadeRun` 明确要求额外的非空 `kind`，因此拒绝该身份。

coding 与 generic standalone worktree 共享这一缺口。`kind` 是 facade 注册边界已知的 domain identity，不属于 upstream workflow child lifecycle binding，也不属于 public dispatch receipt。

## 修复边界

最小修复只在 extension 调用 facade 注册时补齐 kind：coding 使用 `kind: "coding"`，generic 使用 `kind: "generic"`，同时保留 lifecycle binding 的 `runId`、`asyncDir`、`sessionId`、`pid`、`agent`。不放宽 `RootBrokerServer` validator，不改变 collector/upstream child binding，不向 public receipt 增加 kind。

## 资源处置与后续验证

真实 child 已在隔离目录运行，但 tool 因缺少 kind 返回错误。旧 workspace `22fb76a7-600b-4436-bfe9-70b4dc98c94f` 已通过 typed service 执行 `preserve` 后 `release`，对应临时 clone 已删除；不恢复该 released workspace。

修复完成后仍需 reload Host，再以新的 standalone managed worktree canary 重试 facade 注册与 terminal proof 路径。reload 前不把本地 focused test 结果表述为真实 canary 已通过。
