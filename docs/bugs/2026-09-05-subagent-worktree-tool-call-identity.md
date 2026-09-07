# Worktree owner 标识与 Pi Host toolCallId 不兼容

## 问题

合法 Pi Host public tool execute 入口提供的复合 `toolCallId`（例如
`call_Wvt...|fc_0f04...`）包含竖线，并且可能超过 160 个字符。standalone
managed worktree 在分配前将该不透明 Host 标识原样写入持久化 owner，随后被
managed workspace 的 SAFE_ID 边界拒绝：

`Managed workspace contract: owner.toolCallId must be a safe identity`

## 数据来源与实际入口

真实失败记录在
`var/sessions/2026-09-04T10-43-20-359Z_01a06c04-0ea7-77f1-84f3-822d866ce2c9.jsonl`
第 464 至 469 行。记录中的 Pi Host `subagent` tool call 使用 typed executor
请求和 `execution.worktree=true`；Host 分配的 `toolCallId` 形如
`call_Wvt...|fc_0f04...`。同一记录显示 multi-tool wrapper 拆成独立 subagent
调用后仍报相同错误，因此不是 workspace 并发资源冲突。

实际生产入口是 Host 对已注册 typed tool 的 public `execute` 调用，而不是测试
harness 或 workspace service 的内部调用：

`Pi Host tool execute(toolCallId, input, ..., ctx)`

## 完整调用链与首个偏离点

1. `Pi Host tool execute toolCallId`
2. `createTypedSubagentExtension.execute`
3. `executeCoding` 或 `executeGeneric`
4. `standaloneWorkspaceRequest`
5. `createManagedWorkspaceRequest`
6. `owner identity validation`

首个偏离点在第 4 步：`standaloneWorkspaceRequest` 构造
`owner: { kind: "standalone-subagent", rootSessionId, toolCallId }` 时，将 Host 的
opaque `toolCallId` 误当作 persisted SAFE_ID。第 5、6 步的拒绝是正确的合同执行：
持久化 `owner.toolCallId` 必须匹配 SAFE_ID，长度不超过 160，且用于路径与持久化
边界，不能放宽。

## 修复与验证

在 extension 边界新增 deterministic canonicalization。安全且合同内的历史
`toolCallId` 保持原值；含竖线、其他非法字符或过长的值改为
`host-tool-call-<sha256>`。该标识有可读来源前缀、固定 79 字符，并使用完整
SHA-256 以保持碰撞抗性。空值在创建 workspace request 前以
`WORKSPACE_TOOL_CALL_ID_UNAVAILABLE` fail closed。

`test/subagent-managed-worktree.integration.mjs` 覆盖超过 160 字符的复合 Host
ID、两个不同 ID 的不同 owner identity、`Promise.all` 并行分配和 spawn，以及
安全历史 ID 保留原值。测试还确认 child spawn 使用 `worktree:false`，即它使用
已分配的隔离 managed workspace，而非回退到共享主 worktree。
