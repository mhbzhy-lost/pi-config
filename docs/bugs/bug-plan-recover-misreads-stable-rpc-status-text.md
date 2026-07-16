# Plan Recover 误读 Stable RPC Status 文本

## 现象

旧 run 已明确 `failed` 并退出，但新 Parent `/plan-recover` 仍返回 `ownerState: "orphaned-owner"`、`blocked: true`，错误地把终态 run 当作仍在运行。

## 影响范围

所有使用真实 `pi-subagents@0.34.0` stable RPC status 的恢复判断。使用 `{state}` mock 的单元测试不会暴露。

## 复现步骤

第一 Parent 关闭并等待 run terminal；第二 Parent调用 `/plan-recover`。真实 RPC 返回 `{ text: "...\nState: failed\n...", details: {...} }`，恢复结果却被标成 orphaned owner。

## 根因

stable RPC 的 status 方法转发 subagent status tool result，状态位于稳定文本行 `State: <value>`；Launcher 的 `runtimeState()` 只读取 `status.state` 或 `status.status.value.state`，这是测试自造 envelope，不是上游真实合同。

## 修复方案

保留已有结构化兼容分支，并增加严格锚定的 `State:` 单行解析作为真实 stable RPC v1 合同处理；不从任意文本片段猜状态。单元测试使用真实 `{text, details}` envelope。

## 验证方式

单元测试确认 `State: failed` 被识别为终态且不标 orphaned；重跑 restart E2E，确认恢复同一 run终态、无 blocked/takeover、无新 handle/run/lease。
