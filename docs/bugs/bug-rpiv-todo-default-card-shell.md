# Bug：Todo Tool 仍使用默认大色块容器

## 1. 现象

`todo` tool 的调用与结果横向铺满，并带有绿色或进行中状态背景，与其他 compact tools 的无背景样式不一致。

## 2. 影响

频繁的任务状态更新占用大量垂直空间，破坏工具调用的统一扫描体验。

## 3. 稳定复现

调用 `todo update` 将任务切换为 `in_progress` 或 `completed`，每次结果都会显示完整宽度的状态背景块。

## 4. 证据

`@juicesharp/rpiv-todo/todo.ts` 注册了 `renderCall` 和 `renderResult`，但没有 `renderShell`。Pi 的 `ToolExecutionComponent` 因此选择默认 `contentBox` 并应用状态背景；compact tools 使用 `renderShell: "self"` 后不会创建该背景块。

## 5. 根因

Todo extension 自定义了内容渲染，却未选择 self-render shell，因此仍继承 Pi 默认工具卡片容器。

## 6. 修复与验证策略

在 todo tool 注册定义中增加单行 `renderShell: "self"`。这是单行逻辑变更，按仓库 TDD 豁免执行；随后通过 Pi 全扩展加载 smoke test 验证注册兼容性。包升级可能覆盖 node_modules 内修改，需要后续将该选项提交上游或固化为安装补丁。
