# Bug: subagent 展示面板工具调用缺少 renderShell，退回原生 Box 渲染

- **日期**: 2026-08-13
- **状态**: 修复中

## 一句话描述

`subagent-native-conversation` 面板复用共享紧凑渲染器（`compact-tools-renderer.mjs`）渲染 child 会话的工具调用，但该渲染器对象未声明 `renderShell`，导致 `ToolExecutionComponent` 回退到内置工具的 `renderShell`：只有内置 `edit` 声明了 `renderShell: "self"`，其余 `read/bash/write/find/grep/ls` 全部回退为 `"default"` Box 外壳（全宽背景色 + 内边距），与主 agent 的紧凑自渲染不一致。

## 复现流程

1. 派发一个 executor/spark（工具集为 `read,write,edit,bash,grep,find,ls`）。
2. 进入 subagent 展示面板（child viewport），保持工具折叠。
3. 对比：`edit` 渲染为紧凑单行（`∗ edit path (N edits) · done`，无背景、无缩进）；`read/bash/write/find/grep/ls` 渲染为默认 Box 外壳（全宽背景色 + 左右 1 格缩进 + 上下空行），信息密度与主对话不一致。

## 根因

`ToolExecutionComponent.getRenderShell()` 优先级为 `toolDefinition.renderShell ?? builtInToolDefinition.renderShell ?? "default"`。

- 主 agent（`compact-tools.ts`）通过 `pi.registerTool` 显式传 `renderShell: "self"`，7 个工具全部自渲染。
- 面板（`subagent-native-conversation.ts`）把 `compactToolRenderers[name]` 对象直接作为 `toolDefinition` 传入，该对象只有 `renderCall`/`renderResult`，没有 `renderShell`。
- 内置工具定义中仅 `edit` 声明 `renderShell: "self"`（见 `dist/core/tools/edit.js`），其余 6 个工具未声明，回退 `"default"`。

## 修复方案

在共享渲染器 `scripts/lib/compact-tools-renderer.mjs` 的 `createCompactToolRenderers` 末尾循环中，为 `TOOL_NAMES` 每个 renderer 设置 `renderShell: "self"`。这样共享渲染器自带的渲染外壳契约与主 agent（`compact-tools.ts` 的显式 `renderShell: "self"`）一致，面板与主对话自然对齐；主 agent 的显式声明不变，无回归。

## 对应测试

`test/compact-tools-renderer.test.mjs` — 新增用例断言 7 个工具渲染器均声明 `renderShell === "self"`。
