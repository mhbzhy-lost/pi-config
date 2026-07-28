# Bug：Child transcript 使用 Fleet 审计样式而非主对话渲染

## 1. 现象

Child viewport 中的消息虽然带颜色和部分 Markdown，但整体呈现为 `◆ Assistant`、`◇ Supervisor`、`├─ ✓ tool` 与竖向 rail 的事件日志，缺少主对话的用户消息背景、assistant 布局、thinking 和工具专用 shell，用户感知为未格式化原始文本。

## 2. 影响

同一 Pi 会话在 main 与 child 间切换时信息层级和阅读节奏明显变化。初始用户任务与 thinking 不显示，工具提示 `x to expand` 又无法操作，长 transcript 可读性和完整性均低于主会话。

## 3. 稳定复现

1. 派发包含 Markdown、thinking、read/bash 工具调用的 async child。
2. 进入 child viewport。
3. 对比 main：child 使用 Fleet rail 和角色标签；main 使用 `UserMessageComponent`、`AssistantMessageComponent`、`ToolExecutionComponent`。
4. Child 中可以看到 Markdown 标题和列表，但看不到 initial user 与 thinking，工具仍显示不可用的 `x to expand`。

## 4. 证据

Adapter 正确调用 `pi-subagents@0.37.0` 的 `readFleetTranscript()` 与 `renderFleetTranscript()`。后者明确是 Fleet inspector renderer；assistant 正文确实使用与 main 相同的 `Markdown` 引擎，但外层角色、rail 和工具 shell 不同。实际两个 child artifact 共含 25 个非空 thinking block，Fleet events 中为 0；parser 在看到首个 assistant 前会跳过 user，因此 initial task 也为 0。

Pi 根导出公开提供 `SessionManager`、`sessionEntryToContextMessages`、`UserMessageComponent`、`AssistantMessageComponent` 和 `ToolExecutionComponent`。`status.json.steps[].sessionFile` 指向 child 的真实 Pi session；`SessionManager.open()` 可以使用 Pi 自己的 parser 只读加载，`buildContextEntries()` 与 main 重建路径一致，包含 initial user、thinking、tool call/result 和 compaction 语义。

## 5. 根因

早期决策把“复用上游安全 transcript parser/renderer”错误等同于“接近主对话视觉”。Fleet renderer 的目标是紧凑审计，不是 conversation rendering；viewport 本身没有剥除 ANSI 或 Markdown。

## 6. 修复与验证策略

保留 `transcriptPath` + `readFleetTranscript()` 作为安全 fallback，同时优先读取经过 trusted-root、regular-file、symlink 和大小检查的 `sessionFile`。用 `SessionManager.open().buildContextEntries()` 和公开的 Pi message components 组合只读 child conversation，不自行解析 JSONL。

按文件 fingerprint、width、theme、tool-expanded state 缓存渲染，避免 500ms poll 重复同步解析。测试应覆盖 initial user 背景、assistant Markdown、thinking、tool call/result、compaction、写入中 partial line、fallback、缓存失效和与 main component 的规范化输出对比。

## 7. 验证结果

用户在真实 iTerm2 确认 Child initial user、assistant Markdown、thinking 与紧凑工具样式符合主对话，`x` 展开/折叠有效。100-entry/20-tool fixture、缓存与 append reload 覆盖在最终扩大回归 158/158 中持续通过。
