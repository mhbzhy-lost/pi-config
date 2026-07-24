# Bug：Compact Tool 长路径在窄窗口换行占用多行

## 1. 现象

`read/edit/write/ls` 遇到长文件路径时，tool call 会自动换成两到三行；文件名虽完整显示，但单次调用占用过多垂直空间。

## 2. 影响

连续文件操作在窄窗口下难以扫描，compact tool 的单行目标失效；路径前部通常是重复的临时目录，反而挤占真正有价值的文件名。

## 3. 稳定复现

在窄终端中调用 edit/write，路径使用 `/tmp/account-pool-fork-baseline-migration/.agent-state/goal-contract/goals/.../state.json`。当前 renderCall 返回普通 `Text`，稳定自动换行。

## 4. 证据

截图显示路径从 tool name 下一行开始并跨越多行。`compact-tools-renderer.mjs` 对 call 直接构造 `new Text(...)`，没有使用 render(width) 或截断 API，因此宽度控制完全交给 Text 自动换行。

## 5. 根因

文件路径被当作普通文本而非“应优先保留尾部”的结构化字段。渲染器没有根据实际 width 为固定前缀、路径和后缀分配空间，也没有在换行前做尾部截断。

## 6. 修复与验证策略

增加窄宽测试，要求 edit/write/read/ls 的 call 始终只渲染一行、宽度不超过容器，并保留 basename。实现单行路径组件：固定 tool title 与必要后缀，路径超限时用 `sliceByColumn()` 保留尾部并在前方加 `…`，最后用 `truncateToWidth()` 防御性约束整行。
