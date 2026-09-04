# Supervisor request 在 TUI 中显示回复调用提示且标题位置错误

## 现象

Executor 向主 agent 发出需要回复的 supervisor request 时，TUI 在正文后完整显示 `Reply with: subagent_supervisor(...)`，并把 dispatch title 作为末尾方括号文本。用户需要看到的是“哪个带标题的 subagent 说了什么”，不需要面向主 agent 的工具调用提示。

## 数据来源与分类

- 实际入口：Executor 通过 native supervisor channel 发出需要回复的 request。
- 生成调用链：`pi-subagents@0.62.0` `requestVisibleText()` -> 固定追加 `Reply with:` 提示 -> runtime membrane `decorateVisibleMessage()` -> 在原始消息末尾追加 `[title]`，同时保留 `details.title` -> `formatCompactSupervisorRequest()`。
- 权威身份与顺序：消息中的 agent、request id、run id 与 `expectsReply` 由 native supervisor channel 产生；dispatch title 来自当前 session 的 title registry。
- 首个偏离点：TUI formatter 只过滤 wrapper 和 metadata 行，未过滤固定 reply hint，也未把 `details.title` 投影到标题行。
- 分类：预期 production 数据未被正确处理。该消息由合法 runtime 通道和正常事件顺序产生。

## 修复边界

只在 TUI renderer 中将标题投影为 `← <agent> <title>:`，并从显示正文中移除 `Reply with:` 及其后续固定提示。原始 custom message、request identity、tool reply 指引、structured details、session 内容和主 agent 实际收到的信息均保持不变。
