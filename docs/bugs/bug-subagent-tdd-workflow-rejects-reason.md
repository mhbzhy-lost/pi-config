# Subagent TDD workflow 拒绝 reason 字段

## 现象

并行派发两个 executor 时均返回 `INVALID_CONTRACT: workflow.reason is forbidden when mode is tdd`，任务没有启动。

## 影响范围

首批 AI 服务端和客户端 TDD 实现未派发；工作区没有产生代码修改。

## 复现步骤

提交合法 `dispatch-ir.v1`，将 `workflow` 设置为 `{"mode":"tdd","reason":"行为新增"}`。虽然工具公开 schema 把 `reason` 标为可选字段，运行时验证器仍立即拒绝。

## 根因

工具 schema 允许所有 workflow mode 携带 `reason`，但运行时契约对 `tdd` 使用更严格的判别规则：只有非 TDD 模式才允许解释 reason。派发器请求按公开 schema 构造，因此触发运行时二次校验。

## 修复方案

不修改基础设施；对 `mode: "tdd"` 的派发只发送 `{"mode":"tdd"}`。TDD 原因通过 objective/requirements 表达，不在 workflow 中重复。

## 验证方式

移除两个请求的 `workflow.reason` 后重新并行派发；两个 executor 均返回 started，且后续各自提供 RED、GREEN 和验收命令证据。
