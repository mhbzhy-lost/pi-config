# Bug：Compact Tool 适配器泄漏底层换行

## 1. 现象

在特定终端宽度下，折叠态 `grep`、`read` 等 tool call 仍会渲染为两到三行。第一行显示工具名和行尾状态，长路径继续出现在后续行。

## 2. 影响

连续工具调用重新占用大量垂直空间，折叠态“单行 call + 行尾状态”的展示契约失效。热重载后的长会话更容易触发该问题。

## 3. 稳定复现

让 compact-tools 的外层适配器接收一个 `render(width)` 返回三行的底层组件。在 96 列宽度下，适配器会截断第一行并追加状态，但仍原样返回第二、第三行。

## 4. 证据

`pi/extensions/compact-tools.ts` 的 `installCollapsedSingleLineRenderer()` 返回 `[firstLine, ...lines.slice(1)]`。合成截图中的长 grep 路径后，输出稳定为 3 行；现有测试只调用新的 `.mjs` renderer，没有覆盖该 reload-safe 适配器。

## 5. 根因

外层适配器错误地把底层组件的后续行视为应保留内容。`.mjs` 传递依赖在 `/reload` 后可能保留旧 renderer，旧组件或原生 `Text` 会按宽度换行；适配器虽然负责兜底单行契约，却只约束第一行，因此陈旧 renderer 的换行会泄漏到最终 TUI。

## 6. 修复与验证策略

先增加适配器级回归测试，模拟底层组件返回多行，并断言折叠态只返回第一行、总宽度不超过容器且行尾状态保留。随后让适配器丢弃折叠态后续行；展开态维持原有多行语义，并运行 compact renderer 与 reload boundary 全部测试。
