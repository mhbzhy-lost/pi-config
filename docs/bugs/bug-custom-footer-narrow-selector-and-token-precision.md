# Bug：极窄 Footer selector 丢失选中标记且 token 精度偏离计划

## 1. 现象

`formatBrowserSelector()` 只在 width 不大于单个 `⏺` 的宽度时强制返回选中 glyph。width 2–3 进入通用 truncate 后只显示省略号，选中标记完全消失。

Child token `54_321` 当前格式化为 `54k tokens`，而计划合同明确给出 `54.3k tokens`。现有测试固定了错误输出。

## 2. 影响

极窄终端无法辨认当前 viewport 选择，违反 selection glyph 优先级。中等 token 数失去一位有效小数，footer 信息与计划和验收文本不一致。

## 3. 稳定复现

- 对有 selected child 的 snapshot 以 width 1、2、3 渲染：width 1 含 `⏺`，width 2/3 分别只得到省略号。
- 对 tokens `54_321` 调用 child footer 渲染：输出 `54k tokens` 而不是 `54.3k tokens`。

独立 advisor 与主会话源码检查均确认该行为。

## 4. 证据

Selector 在 `safeWidth <= visibleWidth("⏺")` 时特殊处理；更宽但不足以容纳 selected item 时，直接调用 `truncateToWidth(items[selected], safeWidth)`，其省略策略不保留首 glyph。

`formatTokens()` 对 `tokens >= 10_000` 使用 `toFixed(0)`。Task 5 示例和 iTerm2 验收预期使用 `54.3k tokens`；当前测试却断言 `54k tokens`。

## 5. 根因

通用字符串截断不了解 selected glyph 的语义优先级。Token formatter 沿用了旧 compact 规则，没有按新 child footer 规格调整精度，测试也从当前实现反推预期而非固定计划合同。

## 6. 修复与验证策略

先增加 width 1–3 RED 测试，要求所有可容纳一个 glyph 的宽度都保留 `⏺`；再增加 54_321、整千值及窄 footer 精度测试。最小实现应显式保留 selected item 首 glyph并仅截断其余内容；token 使用一位小数并去除无意义 `.0`。同时补动态 position callback 与空 transcript `0/0` 测试。不得改变 lifecycle glyph、history run count 或 main context 格式。
