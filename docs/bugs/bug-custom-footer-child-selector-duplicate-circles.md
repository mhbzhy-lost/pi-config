# Bug：Child 选择器显示重复圆形状态标记

## 1. 现象

运行中的 child 在 selector 中显示 `⏺ ● label` 或未选中时显示 `◯ ● label`，选择态与生命周期相邻且均像圆形状态标记。

## 2. 影响

用户难以快速区分当前焦点与任务运行状态，尤其在多个并行 child 和窄终端中会误读状态。

## 3. 稳定复现

1. 启动一个 running child。
2. 通过 Alt+O 打开 child selector。
3. 观察 child 项目前缀有两个相邻圆形符号。

## 4. 证据

`selectorChild()` 当前拼接 `${selected ? "⏺" : "◯"} ${lifecycleGlyph} ${label}`；running 的 `lifecycleGlyph()` 为 `●`。

## 5. 根因

选择态错误使用圆形 radio glyph，和任务生命周期的运行圆点占用了相同视觉语义。

## 6. 修复与验证策略

保留每个 child 唯一的生命周期 glyph，使用方向性、非圆形的焦点提示。测试覆盖选中、未选中、终态、CJK/emoji 和窄宽度截断。
