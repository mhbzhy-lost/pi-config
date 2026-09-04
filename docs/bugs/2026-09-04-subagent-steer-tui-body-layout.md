# Subagent steer 消息在 TUI 中与目标标题挤在同一行

## 现象

主 agent 通过 typed `subagent` 工具向子任务发送 steer 消息时，TUI 将目标任务标题和完整消息正文拼在同一物理行。长消息从标题后开始换行，方向与正文层级不清晰。

## 数据来源与分类

- 实际入口：`subagent({ action: "steer", id, message })`。
- 生成调用链：typed tool -> RPC `steer` -> 原始 tool result -> `formatCompactSubagentSteerResult()`。
- 权威身份：目标 run id 来自 typed 参数，显示标题来自 session title registry，正文是未经改写的原始 `args.message`。
- 首个偏离点：TUI formatter 使用 `→ <title>：<message>` 单行拼接。
- 分类：预期 production 数据未被正确处理。请求由合法 typed 入口产生，目标身份和消息正文均有效。

## 修复边界

只在 TUI renderer 中将动作、目标 agent 与标题作为独立首行，消息正文从第二行开始，形如 `→ [steer] (executor) <title>：`。方括号标记动作类型，圆括号标记 agent identity，title 保持普通文本。run 启动时的 agent 与 title 仅保存在 renderer identity registry。RPC 参数、tool result、event payload、session 内容和 subagent 实际收到的 steer message 均保持不变。
