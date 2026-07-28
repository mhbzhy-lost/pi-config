# Bug：Footer 长期展示不可选择的 main 项

## 1. 现象

主会话和 Child 浏览模式的 Footer 都长期展示 `main`，但方向键只能在真实 Child 之间切换，无法选择该项。

## 2. 影响

`main` 占用有限的 Footer 宽度，还把不可操作的文本呈现为选择器项，造成错误的交互暗示；窄终端下它也会挤占真实 Child 标题和隐藏项计数。

## 3. 稳定复现

1. 启动至少一个异步 Child。
2. 在主会话观察 Footer，始终显示 `⏺ main`。
3. 按 `Alt+O` 进入 Child 浏览，再按 `←/→`，选择只会在 Child 之间移动，`main` 从不成为选中项。
4. 只能通过 `Esc` 或 `Alt+O` 退出浏览并返回主会话。

## 4. 证据

`formatBrowserSelector()` 无条件把 `main` 放在 `items[0]`，同时又把 Child 的选中索引统一加一。浏览状态仅保存 `selectedKey`，其值来自真实 Child；输入控制器的 `moveChild()` 也只遍历 Child roster。退出主会话由 `exitBrowser()` 独立处理，与 selector item 无关。

## 5. 根因

早期设计把“当前是否处于主会话”编码成一个伪选择器项，但最终交互采用了模式切换：`Alt+O` 进入，`Esc` 或 `Alt+O` 退出。显示模型没有随交互模型收敛，留下了永远无法由方向键选择的 `main` 项及其索引偏移。

## 6. 修复与验证策略

选择器只渲染真实 Child；主模式继续展开活动 Child，并只在仍有活动 Child 时显示只读 `history N`。Child 模式直接按 Child 索引定位 `selectedKey`，保留 `›`、生命周期符号、窄宽截断和隐藏项计数。用 RED 测试验证两种模式都不出现 `main`，第一个和中间 Child 仍能正确选中；现有输入、draft 恢复和 reload 测试继续证明退出行为不依赖伪项。

## 7. 验证结果

RED 先有 8 项只因 `main` 伪项失败；最小实现后 Footer/input/layout/reload 39/39 通过，最终扩大回归 158/158。用户在 final reload 后确认 Footer 不再显示 `main`，Esc/`Alt+O` 退出与 history 浏览仍正常。
