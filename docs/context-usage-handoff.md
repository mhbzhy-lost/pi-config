# 上下文使用量观测与恢复

`context_usage` 是独立的只读工具，无需启用 Goal。它不触发压缩，不要求编写 handoff 文件，也不在 `agent_end` 或压缩后发送提醒。

## 返回内容

- `tokens`、`contextWindow`、`percent`：Pi 当前上下文估计量、模型窗口上限和占比。
- `remainingTokens`、`remainingRatio`：估计剩余 token 与比例，下限为 0。
- `estimated: true`：这些值不是 provider 保证的精确 tokenizer 计数。
- `status`：`known` 表示当前观测可用，`unknown` 表示尚不能估算余量。
- `note`：估计值说明，位于模型文本及 `structuredContent`；`details` 保留观测快照。

压缩后、下一次有效 assistant response 前，`tokens` 与 `percent` 可能为 `null`。此时剩余量为 `null`，`unknown` 不代表余量充足；后续需要时再次查询。高占用仍为 `known`，不表达 Pi 自动压缩的精确触发阈值。

## compact 与恢复的分工

普通会话使用 Pi 默认 compaction。活动 Goal 将任务、来源、决策和 next action 持续保存到当前 session；compact 前再次保存 checkpoint，失败会取消压缩。压缩成功后由 Goal continuity 在下次模型请求注入完整合同与原始状态。reload 与同 session 重启先核验磁盘状态，再检查已知 run，不依赖临时 handoff 文件。

旧的 `handoffPath`、`tokensBeforeHandoff`、`tokensBeforeUrgentHandoff`、两个 `should*` 字段和 `prepare-handoff/urgent-handoff` 状态已移除。原始历史 session、旧 tool results 和既有 handoff 文件保持原样；本次迁移不删除或改写它们。运行集成人工接管通知属于 subagent runtime，仍按原 typed 处置流程处理。
