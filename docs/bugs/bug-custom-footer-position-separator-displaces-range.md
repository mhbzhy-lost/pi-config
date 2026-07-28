# Bug：Child footer 空 token 分隔符挤掉滚动位置尾部

## 1. 现象

Child footer 宽度不足以显示 token 文本、但足以完整显示位置 `120-139/434` 时，`formatChildContext()` 仍返回前导 ` · 120-139/434`。后续 layout 截断 right label，位置尾部被丢失。

## 2. 影响

窄终端下用户最需要的 viewport 位置不完整，违反计划“宽度不足时先截断 token 文本，保留位置”的优先级。实测 width 11 只显示 ` · 120-139…`，而 11 列本可完整容纳位置本身。

## 3. 稳定复现

构造 selected child、tokens `54321`、position `{start:120,end:139,total:434}`，依次以 width 11、12、13、14 渲染 footer 第一行。width 11–13 的输出保留 separator 并截断 position；width 14 才完整显示。

## 4. 证据

`formatChildContext()` 计算 `tokenWidth = max(0, width - positionWidth - separatorWidth)`，但即使 `tokenWidth === 0`，仍无条件拼接 ``${truncate(token, 0)} · ${position}``。`layoutFooter()` 随后只能截断整个 right label。

现有测试最窄 width 为 18，仍有空间显示部分 token 和 separator，没有覆盖“只够 position”与“连 position 都放不下”的边界。

## 5. 根因

格式化逻辑只收缩 token 内容，没有把 separator 视为 token 部分。separator 应仅在至少一个 token glyph 被保留时出现；位置本身超过宽度时才允许按位置规则截断。

## 6. 修复与验证策略

先增加 width 等于 position 可见宽度的 RED 测试，要求完整位置且无 separator；再覆盖 width 小于 position 的可预测截断和原有 width 18/80 行为。最小修复是在 token 可用宽度不足以显示任何 token 时直接返回 positionLabel；不得修改 main context、selector 或 viewport 状态。
