# Bug：Child 原生回放未使用紧凑工具渲染

## 1. 现象

Child 原生会话在折叠工具输出时沿用 Pi 默认工具样式，未显示主对话使用的紧凑摘要；按 `x` 展开时也无法保证与主对话同一套输出渲染。

## 2. 影响

用户在 main 与 child 间切换时，`read`、`bash`、`edit`、`write`、`find`、`grep`、`ls` 的信息密度和摘要不一致，长输出占据不必要的屏幕空间。

## 3. 稳定复现

1. 创建包含上述任一工具调用和结果的 child Pi session。
2. 进入 child viewport，保持工具折叠。
3. 对比 main conversation：child 未显示紧凑结果摘要。

## 4. 证据

`NativeChildConversationRenderer.renderItems()` 构造 `ToolExecutionComponent` 时第五个参数传入 `undefined`。主会话的 `compact-tools.ts` 则通过 `createCompactToolRenderers()` 提供 `renderCall` 与 `renderResult`。

## 5. 根因

原生 child 回放复用了 Pi 的组件，却遗漏了项目已存在的工具定义渲染器依赖，组件因此回退到 Pi 默认格式。

## 6. 修复与验证策略

从 `scripts/lib/compact-tools-renderer.mjs` 导入并创建共享 renderer，按工具名传入对应定义。新增测试确认折叠结果含摘要、展开结果含原始输出，并运行原生回放与 Footer 套件。
