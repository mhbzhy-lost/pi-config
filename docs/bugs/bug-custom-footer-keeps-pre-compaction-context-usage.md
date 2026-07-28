# Bug：Custom Footer 在 compact 后保留压缩前 Context 比例

## 1. 现象

手动或自动 compact 完成后，custom footer 仍显示压缩前的高 context 比例；只有发送下一条消息并收到新的 assistant usage 后，比例才更新。

## 2. 影响

用户在 compact 完成到下一次模型响应之间看到陈旧的 context 占用，无法判断压缩是否生效，并可能重复触发 compact。

## 3. 稳定复现

构造包含高 token assistant usage 的 session，完成 compact 并追加 compaction entry，但不追加新的 assistant 消息。Pi 已请求 TUI 重绘，custom footer 仍从最后一条压缩前 assistant 消息计算出原比例。

## 4. 证据

Pi `AgentSession.getContextUsage()` 会识别最新 compaction 边界；边界后没有有效 assistant usage 时返回 `{ tokens: null, percent: null }`。原生 footer 将其显示为 `?/<contextWindow>`。Pi 的 `compaction_end` 处理也会调用 `footer.invalidate()` 和 `ui.requestRender()`，因此数据已更新且重绘已经发生，陈旧显示不是缺少核心重绘事件。

## 5. 根因

custom footer 绕过了 `ctx.getContextUsage()`，直接倒序扫描 `ctx.sessionManager.getBranch()` 中最后一条 assistant usage。compact 不会删除旧 entry，所以该算法无法区分 usage 位于 compaction 前还是后，始终把压缩前 usage 当成当前 context。

## 6. 修复与验证策略

改用 Pi 官方 `ctx.getContextUsage()` 作为 context 比例来源；`percent: null` 时立即显示 `?/<contextWindow>`，避免伪造精确值。复用 Pi 已有的 `compaction_end` footer invalidate 与 TUI 重绘，并保留 `model_select` 刷新。先增加 compact 边界 RED 测试，再修改 reloadable TypeScript 入口及测试用布局组件，运行 footer、reload boundary 相关测试。
