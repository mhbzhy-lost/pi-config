# Supervisor reply 成功回执在 TUI 中重复展示

## 现象

主 agent 已通过面向 subagent 的消息展示表达决定后，TUI 在 `subagent_supervisor` tool call 下继续显示 `Replied to supervisor request <id>.` 成功回执。该回执只确认 native channel 已写入回复，没有新增用户需要感知的信息。

## 数据来源与分类

- 实际入口：`subagent_supervisor({ action: "reply", replyTo, message })`。
- 生成调用链：project supervisor adapter -> upstream native supervisor tool -> `writeReply()` -> success tool result -> Pi tool renderer。
- 权威身份与顺序：`replyTo` 对应 pending request；写入成功后 upstream 删除 pending 并返回包含 replyTo、runId、agent 的 details。
- 首个偏离点：project supervisor tool 未提供 TUI renderer，Pi 使用通用 tool call/result 展示成功回执。
- 分类：预期 production 数据未被正确处理。调用和回执均来自合法 typed/native 入口。

## 修复边界

只在 TUI renderer 中将成功 `reply` 的通用 tool call 与回执替换为 `→ [reply] (<agent>) <title>：` 和实际回复正文。方括号标记动作类型，圆括号标记 agent identity，title 保持普通文本。工具执行、原始参数、成功回执、structured details、session 内容和 subagent 实际收到的回复均保持不变；失败结果继续可见，`pending/status` call 与结果保持可见。
