# Bug：RPIV Todo 热重载后前缀显示 undefined

## 1. 现象

执行 `/reload` 后，折叠态 Todo 调用显示为 `undefinedtodo + ... · ○ pending`，每次 create/update 均带有相同的 `undefined` 前缀。

## 2. 影响

Todo 工具的层级标记损坏，连续任务操作产生明显视觉噪音；已恢复的 action 和状态图标仍无法形成一致的 compact tool 展示。

## 3. 稳定复现

先在 Pi 进程中加载不含 `TODO_CALL_PREFIX` 的旧 `compact-result.mjs`，再让更新后的 `format.ts` 从该模块读取新导出并执行 `/reload`。调用任意 Todo action 时，`theme.fg("dim", undefined)` 参与字符串拼接，稳定得到 `undefinedtodo`。

## 4. 证据

Jiti 缓存产物 `view-format.*.mjs` 仍执行 `_compactResult.TODO_CALL_PREFIX`。现场截图的 `undefined` 恰好位于 `todo` 之前；action 和状态仍正常，说明故障只发生在新增前缀导出。`compact-result.mjs` 还未列入 `rpiv-todo` 的 package files，属于本地新增传递依赖。

## 5. 根因

上次修复只移除了 `createCompactTodoText` 这一项 reload-unsafe MJS 导出，但 `format.ts` 仍依赖同一 MJS 中后来新增的前缀、action 和摘要导出。Pi `/reload` 不刷新原生 ESM 传递依赖，因此旧 namespace 返回 `undefined`，修复边界不完整。

## 6. 修复与验证策略

先增加回归测试，要求 Todo 的生产 `format.ts` 不再导入 `compact-result.mjs`，并直接导出和验证前缀、action、摘要格式。随后将这些小型纯格式化定义移入 reloadable 的 TypeScript renderer，运行 Todo 与 extension reload 测试，并在现有 Pi 会话中执行 `/reload` 目视确认。
