# 缺少持久化的真实 Goal RPC smoke

## 覆盖缺口

此前 canary 仅覆盖本地 JSONL client、ToolResult 解析、production entry、状态根定位和 restart；虽然临时真实运行已经观察到 `goal_init`、`goal_status`、`goal_dispatch` 与 `subagent`，但没有持久化为默认安全的测试。

## 修复

`test/goal-runtime-real-canary.integration.mjs` 新增 `real root RPC binds one Goal typed subagent`。该测试只有在 `PI_RUN_GOAL_REAL_CANARY=1` 时才会启动 `/opt/homebrew/bin/pi`，固定使用 `openai-codex/gpt-5.6-luna`，没有 provider 或 model fallback。默认测试将其 skip，因此不会调用模型。

真实路径复用现有临时状态根、JSONL client、public ToolResult parser 和 Goal ledger locator。child 保留 parent 的 `PI_CODING_AGENT_DIR`，使 Host 的安全 credential resolver 仍使用既有 Pi 配置；临时 Goal settings 只由薄 wrapper 以 `settingsPath` 传给 production entry。它要求 root 按顺序调用 `goal_init`、`goal_status`、`goal_dispatch` 和返回的 typed `subagent`，并将 taskId、dispatch contract hash、subagent `details.runId`/`details.asyncDir` 与权威 ledger 的 executor binding 对照。客户端 deadline 为 900 秒；无论成功或失败都会 abort、terminate 并清理临时目录；失败时先写入脱敏事件诊断文件。

## 本次验证状态

唯一一次 env-gated 运行在发送 prompt 时被 Pi 以 `No API key found for openai-codex` 拒绝。该次运行曾错误将 child 的 `PI_CODING_AGENT_DIR` 覆盖到临时 settings 目录；静态核对后已改为保留 parent 路径，且按一次运行约束没有重跑。下一次获批真实运行前，需要操作者在该既有 Pi 配置中通过交互式 `/login` 建立 `openai-codex` 登录；不得把 key 提供给测试或对话。
