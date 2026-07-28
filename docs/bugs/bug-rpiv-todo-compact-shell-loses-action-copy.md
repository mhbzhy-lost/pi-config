# Bug：Todo 去除卡片背景后 list 等操作缺少可读文案

## 1. 现象

`todo list` 在 self-render shell 下只显示 `todo ☰` 和下一行 `✓`，无法从 transcript 判断列出了多少任务或操作含义。

## 2. 影响

Todo 调用虽然成功，但历史记录缺少可扫描的信息；去掉背景后只剩两个符号，用户容易误认为文案或状态数据丢失。

## 3. 稳定复现

调用 `todo` 的 `list` action。`renderTodoCall` 将 action 映射成 `☰`，`renderTodoResult` 对 `list/get/clear` 不读取 content 或 details，统一返回 `✓`。

## 4. 证据

`view/format.ts` 的 `ACTION_GLYPH.list` 为 `☰`；`renderTodoResult` switch 中 `list/get/clear` 直接 break，最终命中固定成功勾。tool result 的 `details.tasks` 和 `content` 实际仍包含完整数据。

## 5. 根因

Rpiv-todo 的 renderer 以符号和背景状态色共同表达操作；切换到无背景 self shell 后，符号本身不足以承载 action 与结果摘要，而 renderer 又主动丢弃已有 result 文本。

## 6. 修复与验证策略

为 list/clear 使用可读 action 名称；为 list/get/clear 生成单行摘要：list 显示任务数量，get 显示任务状态与标题，clear 显示结果文本。先为摘要纯函数添加失败测试，再接入 package renderer，并运行 Pi 全扩展加载验证。
