# Bug：Subagent 启动结果在 TUI 重复显示调度细节

## 一句话描述
Subagent spawn 成功后，TUI 同时显示工具名、runId 和固定调度提示，常规阅读只需要 agent、title 与 started 状态。

## 复现流程
1. 派发任意 executor 或 generic subagent。
2. 观察工具结果显示 `Started <agent>: <title> (<runId>). Completion notifications ...`。
3. 确认 runId 与调度提示已存在于 details、tool result 和系统调度合同，不需要在默认 TUI 重复展开。

## 修复方案
只在项目自有 tool renderer 中用结构化 details 生成 `* subagent started <agent>: <title>`；原始 content/details、RPC、session 和生命周期消息保持不变。
