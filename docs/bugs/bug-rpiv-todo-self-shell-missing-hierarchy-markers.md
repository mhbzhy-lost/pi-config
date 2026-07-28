# Bug：Todo Self Shell 缺少调用与结果层级标记

## 1. 现象

Todo 紧凑渲染显示为顶格的 `todo list` 和 `5 tasks`，新增、删除、完成等调用也没有与其他 tool 一致的前缀和结果缩进。

## 2. 影响

连续 transcript 中 todo 调用与普通文本难以区分，call/result 的父子关系不清晰。

## 3. 稳定复现

调用任意 todo action。`renderTodoCall` 和 `renderTodoResult` 都返回 padding 为 0 的 Text，self shell 不再提供默认卡片边界。

## 4. 证据

截图中 call 和 result 均从第一列开始；compact-tools 的对应约定是 call 使用 `∗ `，result 使用 `  └ `。

## 5. 根因

切换到 `renderShell: "self"` 后只移除了默认 Box，没有在 todo 自身 renderer 中补齐替代的视觉层级标记。

## 6. 修复与验证策略

为 compact todo helper 增加稳定的 call/result 前缀契约，call 前置 dim `∗ `，result 前置 dim `  └ `；保留 tool name 加粗和现有状态颜色。运行 todo renderer 测试及 Pi 全扩展加载验证。
