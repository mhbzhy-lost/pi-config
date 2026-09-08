# Subagent workspace session owner scope 与完成提醒缺失

## 分类

这是第 1 类：**预期 production 数据未被正确处理**。记录由合法 public Host/tool/event 路径、权威 Host session identity、统一 ledger 的有效 receipt 和正常事件顺序产生；不是测试手工拼接的非法 owner 或状态。

## 处置调用链与首个偏离点

```text
Host subagent({action:"workspace_status"|"workspace_disposition", workspace_id})
  -> createTypedSubagentExtension.execute
  -> requireWorkspaceService(pi, ..., currentRootSessionId)
  -> executeWorkspaceAction(input, service)
  -> service.status/issueDisposition/dispose/release({workspaceId})
  -> ledger.load(workspaceId)
```

权威 session 身份是 Host 通过 `resolveRootSessionId(ctx.sessionManager)` 解析的 `rootSessionId`，而不是 workspace ID、title、agent profile、路径或模型参数。当前 service 以全局 state root 的 workspace ID 定位 ledger record，却没有比较 `receipt.owner.kind` 与 `receipt.owner.rootSessionId`。首个偏离点是 facade 到 service 的处置合同未携带 owner scope；因此可见 ID 可能触达 foreign standalone、`goal-task` 或 `goal-validation` receipt。修复必须在 record load 后、inspection、challenge、pending intent 和 Git mutation 前执行 service 内原子 owner scope 校验。

## 完成提醒调用链与首个偏离点

```text
upstream subagent:async-complete
  -> RootBrokerServer.observeTerminal
  -> project completionNotifierFactory/registerSubagentNotify
  -> pi.sendMessage(customType="subagent-notify")
  -> 主 agent 新 turn / TUI renderer
```

spawn 时 workspace 已经通过 `service.bindRun({workspaceId, run})` 持久化；但 completion 链没有以 authoritative event 的 `runId` 反查当前 session 的 standalone receipt，也没有生成 typed disposition 提醒。首个偏离点是 completion event 与 bound receipt 之间缺少只读关联 adapter。

## T1 边界

T1 建立 service 的独立 scoped API。旧 agent-callable facade 在本任务结束时仍存在，需由 T2 删除；因此 T1 不能单独宣称 agent-callable 安全闭环已经完成。Goal owner 及其他 session workspace 一律不能由 standalone scope 接管。
