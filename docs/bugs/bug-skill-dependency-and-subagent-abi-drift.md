# Skill 依赖与 Subagent ABI 漂移

## 问题描述

Skill 文档将 `workspace_status` 和 `workspace_disposition` 写成独立函数，但当前 ToolDefinition 只注册 `subagent`，两者是其 `action` 分支。同时，`using-goal-engine` 未显式声明对 `subagent-dispatch` 的功能依赖；Playwright 的触发描述与 headed 登录态交接的条件依赖不够明确。

## 影响

调用者可能臆造不存在的工具、遗漏 Goal Engine 派发所需的 subagent-dispatch，或在浏览器 UI/E2E、手动登录和登录态交接场景错过 Playwright/browser-auth-session 的正确使用边界。

## 修复方案

1. 将 workspace 查询和处置示例改为 `subagent({action: ...})` 的真实 ABI。
2. 显式声明 using-goal-engine 必须使用 subagent-dispatch；缺少 typed tools 时停止。
3. 扩展 Playwright 的触发条件，并把 headed 登录态交接时的 browser-auth-session 标为条件性必需依赖，不复制凭据流程。

## 验证

新增文档 ABI 回归测试，先在修复前失败，再连同 subagent、Playwright、using-goal-engine 的定向 Skill 测试通过。
