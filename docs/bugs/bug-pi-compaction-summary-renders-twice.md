# Bug：Pi 0.82.1 在 compact 后重复渲染同一 Compaction 卡片

## 1. 现象

自动 compact 完成后，TUI 显示两张 `tokensBefore` 完全相同的 `[compaction]` 卡片，中间可能夹着触发 overflow recovery 的 context-window 错误。用户会误以为 compact 执行了两次，或压缩没有真正生效。

## 2. 影响

重复卡片掩盖了真实 session 状态，并与 footer 的 context 比例、自动续跑通知叠加，造成“反复 compact 但仍超过 100%”的观感。它是显示重复，不会创建第二个 compaction entry，也不会单独扩大模型上下文。

## 3. 稳定复现

在 `pi-coding-agent@0.82.1` 中让 Responses 请求返回 context overflow，等待自动 compact 成功。现场截图显示两张 `Compacted from 376,978 tokens` 卡片；对应 session JSONL 在该时间段只包含一个 compaction entry `59eb616b`。

## 4. 证据

当前会话在 `2026-07-28T09:25:24.315Z` 仅写入一个 compaction entry，随后首个模型响应 usage 降为 `16,593` tokens，证明 compact 已成功。`interactive-mode.js` 的 `compaction_end` 分支先调用 `rebuildChatFromMessages()`；该函数通过 `sessionManager.buildContextEntries()` 重建聊天，其中已经包含刚持久化的 `compactionSummary`。分支随后再次调用 `addMessageToChat(createCompactionSummaryMessage(...))`，把同一 summary 作为临时消息追加第二次。

## 5. 根因

Pi core 同时采用了两条互斥的更新策略：从 session entries 全量重建，以及在重建后增量追加刚完成的 compaction summary。因为 `AgentSession._runAutoCompaction()` 在发出 `compaction_end` 前已经执行 `appendCompaction()`，全量重建已经覆盖该 entry，后续增量追加必然重复。

## 6. 修复与验证策略

上游最小修复是在 `compaction_end` 成功分支中保留全量重建、删除额外的 `addMessageToChat(createCompactionSummaryMessage(...))`；或者反向保证重建输入不含最新 compaction，但前者更符合 session 作为唯一事实源的模式。测试应构造只含一个 compaction entry 的 session，派发一次 `compaction_end`，断言 chat container 只有一个 `CompactionSummaryMessageComponent`，并覆盖 manual、threshold、overflow 三种 reason。配置仓不直接修改 Homebrew 全局安装文件；升级或上游补丁落地前，以 JSONL entry 数量和 compact 后首个 usage 判断真实结果。
