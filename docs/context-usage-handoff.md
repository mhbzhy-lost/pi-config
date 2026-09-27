# 上下文使用量与 handoff

Pi 配置现在提供 agent-facing 工具 `context_usage`，用于读取当前上下文窗口的估计使用量。

## 返回内容

工具返回当前上下文的：

- `tokens`：当前上下文 token 估计值；
- `contextWindow`：当前模型的上下文窗口上限；
- `percent`：当前占比；
- `remainingTokens`：估计剩余 token；
- `status`：`normal`、`prepare-handoff`、`urgent-handoff` 或 `unknown`；
- `handoffPath`：建议写入 `.pi/handoff/context-handoff.md`。

这些字段来自 Pi 的 `getContextUsage()`，是 Pi 的上下文估计值，不是 provider 保证的精确 tokenizer 计数。compaction 后、下一次有效 assistant response 之前，`tokens` 和 `percent` 可能为 `null`；此时不要自行猜测，应在后续 turn 再次查询。

## handoff 阈值

本扩展使用自己的安全阈值：

- 80%：状态为 `prepare-handoff`，应在继续非必要工作前更新 handoff；
- 90%：状态为 `urgent-handoff`，应立即更新 handoff。

这两个阈值不是 Pi 内部自动 compaction 的精确触发阈值。Pi 当前 API 没有直接返回该内部阈值，因此工具只报告独立的 handoff 安全策略。

扩展在 `agent_end` 时检查状态，并对同一状态发送一次非展示性提醒，避免重复刷屏。它不会自动调用 compaction，也不会自动生成、覆盖或改写 handoff 内容。

## 推荐 handoff 内容

agent 应使用现有 `write` 工具维护 `.pi/handoff/context-handoff.md`，包括：

1. 当前目标和已完成事项；
2. 关键决策及其理由；
3. 当前修改文件和验证结果；
4. 未完成任务、阻塞点和下一步；
5. 需要重新读取的计划或证据文件。

handoff 中禁止写入凭据、token、证书、cookie 或其他秘密。压缩后应优先读取该文件，再调用 `context_usage` 确认新的上下文状态。
