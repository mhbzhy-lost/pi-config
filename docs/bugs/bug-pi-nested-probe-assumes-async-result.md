# Bug：Nested Probe 只接受 async result shape

## 1. 现象

Plan child 已完成一次真实 nested `subagent` 并在 47 秒正常结束，但 `/nested-probe` 仍等待到 120 秒，外层最终 180 秒 timeout。

## 2. 影响

成功的 foreground nested fanout 被误报为缺失 lifecycle evidence；probe 无法 notify，三层工具边界断言和 Task 1 完成门禁被永久阻塞。

## 3. 稳定复现

最新 top-level Plan events 中存在 `tool_execution_end`，`result.details.runId` 和 `results[0].sessionFile/artifactPaths` 完整；Plan status 为 complete。Probe 的 event predicate 同时要求 `result.details.asyncDir`，因此不匹配该 foreground result。

## 4. 证据

上游 Details schema 对所有模式提供 `runId/results`，只对 async 启动提供 `asyncId/asyncDir`。真实 foreground nested result 的 `details.results[0]` 包含 sessionFile、artifactPaths、transcriptPath、model attempts 和 acceptance；真实 async result 才有 asyncDir并投影到 parent nested children。

## 5. 根因

测试把模型可能选择的 async 调用方式当成 nested capability 的固定协议，混淆了“nested 被授权并产生结构化结果”和“nested 以 detached 模式运行”。event matcher 错误收紧到 async-only shape。

## 6. 修复与验证策略

Probe 接受两种稳定 shape：共同要求 `details.runId`；foreground 要求 `results[0].sessionFile/artifactPaths`，async 要求 `asyncDir`。Foreground 直接 notify并等待 Plan 自然终态；async 在取得 sentinel 后请求 stop并等待 parent/nested artifacts。测试按 mode 分支验证，但三种 tool set和 nested session证据始终必需。
