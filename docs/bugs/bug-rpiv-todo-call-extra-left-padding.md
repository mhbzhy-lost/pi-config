# Bug：Todo 调用比其他紧凑工具多一列左缩进

## 1. 现象

`todo` 已使用紧凑标题和 self shell，但其调用标题仍比 `read`、`bash`、`edit` 等工具向右偏一列；结果行看起来基本对齐。

## 2. 影响

连续工具调用的标题起始列不一致，`todo` 的 `∗` 层级标记无法与其他工具形成稳定的视觉基线。

## 3. 稳定复现

依次调用 `todo list` 和任意 compact tool。观察 self shell 输出：todo call 的 `∗` 前还有一列空格，其他 compact call 从组件第 0 列开始。

## 4. 证据

`renderTodoCall()` 已在文本中加入 `TODO_CALL_PREFIX = "∗ "`，但返回 `new Text(text, 1, 0)`；`Text` 的第 2 个参数会再加入一列左右 padding。compact-tools 的 call renderer 直接从第 0 列输出标题。todo result 与 compact-tools result 均使用 `Text(..., 1, 0)`，因此 result 不是本次差异来源。

## 5. 根因

Todo 从默认 shell 切到 `renderShell: "self"` 并补层级前缀时，沿用了默认容器时期的 call 文本 padding，导致 self shell 中前缀与组件 padding 重复承担左缩进。

## 6. 修复与验证策略

只把 todo call 的 Text 横向 padding 改为 0，保留 result 的横向 padding 为 1。先为 compact helper 增加 call/result padding 契约测试并确认失败，再让实际 renderer 使用该契约；最后运行 todo 测试与 Pi 扩展加载 smoke test。
