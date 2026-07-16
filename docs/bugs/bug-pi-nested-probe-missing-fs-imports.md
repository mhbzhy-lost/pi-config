# Bug：Nested Probe 缺失文件 API 导入

## 1. 现象

普通 worker 和 Plan worker 均已启动，但 `/nested-probe` 不发送报告，外层最终以 RPC timeout 失败。

## 2. 影响

Nested capability、三层工具边界和结构化 lifecycle 都无法进入断言阶段；Plan 子任务会脱离 probe 继续运行并产生无关模型调用。

## 3. 稳定复现

运行 nested integration。顶层 RPC stdout 在 command 启动后立即记录 `extension_error`，随后只收到后台任务通知，没有 `PI_SUBAGENTS_NESTED_REPORT`。

## 4. 证据

失败输出明确包含 `{"type":"extension_error","extensionPath":"command:nested-probe","event":"command","error":"readFile is not defined"}`。生成的 `nested-probe.mjs` 调用了 `readFile`、`access` 和 `join`，但仅导入 `createSubagentsRpcClient`。

## 5. 根因

测试文件顶部的 `readFile/access` 导入不会自动进入运行时生成的独立 Extension 模块。生成模板遗漏自身依赖，导致 command 在第一次读取 Plan events 前抛出 `ReferenceError`。

## 6. 修复与验证策略

在生成的 `nested-probe.mjs` 内显式从 `node:fs/promises` 导入 `access/readFile`，从 `node:path` 导入 `join`。先复跑单个 nested RED，确认能够收到结构化报告，再继续验证 Extension 加载标记与三层工具快照。
