# Bug：Child overlay 不拥有终端 scrollback

## 1. 现象

进入 subagent 浏览态后，child transcript 能覆盖当前终端可见区域，但在 iTerm2 中向上滚动仍会看到 parent 主会话，无法把终端原生 scrollback 当作 child 的完整历史。

## 2. 影响

当前屏幕看起来像切换了 session，但物理历史仍属于 parent，交互语义不一致。用户容易误以为 child 只有一屏内容，忽略应用内 PageUp/PageDown，且上游 Fleet 默认 240 条记录的读取上限进一步限制了可浏览历史。

## 3. 稳定复现

1. 启动包含多屏输出的 async child。
2. 按 `Alt+O` 进入 child viewport。
3. 当前屏幕只显示 child transcript。
4. 使用 iTerm2 滚轮向上查看，出现 parent 主会话历史。
5. 使用 PageUp 则在当前覆盖层内翻阅 child transcript。

## 4. 证据

`custom-footer.ts` 使用 `ctx.ui.custom(..., { overlay: true })`；Pi 文档将 overlay 定义为在现有内容上方绘制，不会清理 base conversation。`pi-tui` 先渲染完整 base lines，再把 overlay 合成到最后一个 terminal viewport 范围。`SubagentTranscriptViewport` 返回 `terminal.rows - 4` 行并完整补宽，因此可见区域没有透出，问题只存在于 terminal scrollback 的所有权。

当前 Pi 由 `scripts/pi-shell.zsh` 预先进入 DECSET 1049 alternate screen。1049 不是可嵌套栈；extension 再发送 `1049h/1049l` 可能直接退出整个 Pi screen。`TUI` 还维护私有 `previousLines`、cursor row、viewport top 和差分渲染状态，直接调用 `terminal.write()` 切 buffer 不属于受支持的扩展合同。

## 5. 根因

Pi 公开扩展 API 只支持 overlay、widget、editor 和 footer replacement，没有 conversation base replacement 或独立 scrollback owner。当前实现把“覆盖可见 viewport”表述成“切换 session viewport”，超出了 overlay 实际拥有的范围。

## 6. 修复与验证策略

在当前 Pi 版本中，将隔离合同收敛为“当前屏幕与应用内逻辑历史隔离”：保留全屏 overlay，由 PageUp/PageDown、Home/End 在 child line model 内浏览，展示当前位置并确保 renderer 不再截断正常 child session。不要嵌套 alternate screen，也不要清除 parent scrollback。

若产品必须让物理滚轮拥有 child-only scrollback，需要先由 Pi 上游提供 conversation-view replacement 或 screen-owner API，再由 TUI 统一保存与恢复差分状态。当前 extension 不能安全实现这一能力。

## 7. 验证结果

用户在真实 iTerm2 确认应用内 `↑/↓`、PageUp/PageDown、Home/End 与 footer 位置同步均正常，overlay 当前屏幕没有 parent 内容透出；物理 scrollback 仍属于 parent，符合已声明边界。扩大回归 158/158 通过。
