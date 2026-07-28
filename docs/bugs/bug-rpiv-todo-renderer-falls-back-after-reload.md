# Bug：RPIV Todo 热重载后 Renderer 退化为纯文字

## 1. 现象

执行 `/reload` 后，Todo 调用只显示纯文字 `todo`，下一行显示原始结果 `Created #...` / `Updated #...`，原有 `∗`、action 图标和状态图标全部消失。

## 2. 影响

Todo 与普通文本无法区分，create/update 等动作和 pending/in_progress/completed 状态失去视觉提示；频繁更新任务时 transcript 还会额外占用两行。

## 3. 稳定复现

1. 在 Pi 进程中加载不含 `createCompactTodoText` 的 `compact-result.mjs`。
2. 修改 `format.ts`，从该 MJS 导入并调用新函数。
3. 执行 `/reload` 后调用任意 todo action。
4. call 显示 `todo`，result 显示原始 response copy。

## 4. 证据

`format.ts` 的 `renderTodoCall()` 和 `renderTodoResult()` 均调用 `createCompactTodoText()`。Node 原生 ESM 缓存使旧 namespace 中该值为 `undefined`。Pi `ToolExecutionComponent.updateDisplay()` 对 call/result renderer 分别使用 `try/catch`；异常时 call fallback 只渲染 tool name，result fallback 渲染原始 text，输出与现场完全一致。

## 5. 根因

Todo renderer 引入了 reload 前不存在的 MJS 导出，重复触发已确认的传递依赖缓存边界；同时 Pi 的 renderer fallback 静默吞掉异常，使问题表现为“图标消失”而不是 Extension error。

## 6. 修复与验证策略

Todo 的 TypeScript renderer 直接构造 `Text`，不再依赖新增 MJS factory。折叠态使用 `ToolRenderContext.state` 将 result 状态写回 call 组件并返回空 result，使 action/status 图标合并在同一行；展开态保留必要正文。增加 reload 边界、单行渲染和图标契约测试，再执行真实 TUI reload。
