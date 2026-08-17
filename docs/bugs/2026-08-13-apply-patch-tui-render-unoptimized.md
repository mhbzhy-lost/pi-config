# Bug: apply_patch 未走 TUI 紧凑渲染，占面积过大

- **日期**: 2026-08-13
- **状态**: 修复中

## 一句话描述

`apply_patch` 自定义工具没有提供 `renderCall`/`renderResult`，未像 `edit`（compact-tools 方案）那样走 TUI 紧凑渲染：默认 shell 下调用只显示标题、结果回退为原始文本，HTML 导出时更会以 `JSON.stringify(args, null, 2)` 回退显示整段 patch，多文件 patch 占面积过大。

## 复现流程

1. 触发一次多文件 `apply_patch` 工具调用。
2. 观察 TUI：工具行无紧凑单行摘要；展开/折叠无差异，无彩色 diff 预览。
3. `/export` 导出 HTML：apply_patch 调用块显示整段 patch JSON（`*** Begin Patch ... *** End Patch`），面积大。

## 根因

`pi/extensions/apply-patch.ts` 仅注册了 `execute`，未注册 `renderShell: "self"` / `renderCall` / `renderResult`。渲染回退到：
- TUI `ToolExecutionComponent.createCallFallback`/`createResultFallback`（标题 + 原始文本）；
- HTML 模板 default 分支 `JSON.stringify(args, null, 2)`（整段 patch）。

而 `edit` 等内置工具经 `compact-tools` 扩展重注册为单行摘要（折叠）+ 展开详情。

## 修复方案

为 `apply_patch` 增加紧凑渲染：
- 抽取纯函数 `patchToOps`（扫描 header 汇总文件操作）与 `patchToDiff`（转成带行号的 diff 字符串供 `renderDiff` 上色）到 `scripts/lib/apply-patch/render.mjs`；
- 注册 `renderShell: "self"`：折叠态单行 `∗ apply_patch +N ~M -K`（结果后缀 `· N files`），展开态显示彩色 diff；结果折叠态空、展开态显示 A/M/D 列表。

## 对应测试

`test/apply-patch-render.test.mjs` — 覆盖 `patchToOps` 与 `patchToDiff`。
