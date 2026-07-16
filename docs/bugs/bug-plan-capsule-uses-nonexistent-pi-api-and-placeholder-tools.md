# Plan Capsule 使用不存在的 Pi API 且领域工具未接线

## 现象

Extension 从 `pi.getBranch()` 读取分支并发送 `{ role: "user" }` 消息，但 Pi 0.80.6 的 `ExtensionAPI` 没有 `getBranch`，`sendMessage` 也要求 custom message 结构。成功 `plan_open` 后开放的四个工具仍固定返回“not configured”。Agent profile 使用 `extensions`，而 `pi-subagents@0.34.0` 已验证的 per-agent 字段是 `subagentOnlyExtensions`。

## 影响范围

真实 Plan Session 无法从当前分支恢复，completion guard 不能可靠触发 follow-up；`plan_status`、`plan_continue`、`plan_verify`、`plan_block` 全部不可用；Plan child 可能根本不加载 Capsule Extension。

## 复现步骤

对照 Pi 0.80.6 `ExtensionAPI` 类型可见分支入口是事件 handler `ctx.sessionManager.getBranch()`；当前测试 mock 却把 `getBranch` 放在 `pi` 上。调用开放后的任一 Plan tool 会固定返回错误。现有 `pi-subagents` integration fixture 使用 `subagentOnlyExtensions`，与 profile 的 `extensions` 不一致。

## 根因

Task 11 以自定义 mock 推测 API，没有先对照已安装 Pi 类型和仓库中的真实 `pi-subagents` compatibility fixture；测试只断言工具名称出现，没有验证领域操作、事件追加、active tools 更新或真实 context 数据流。

## 修复方案

测试按 Pi 0.80.6 handler context 建模，通过 `ctx.sessionManager.getBranch()` 恢复；使用合法 custom follow-up 消息及 delivery options。四个工具调用注入的 coordinator/status/verify/block 领域接口并 fail-closed，禁止直接写 acceptance/validated。profile 改用 `subagentOnlyExtensions`，并验证只有 Plan child 加载。

## 验证方式

新增真实 context、工具意图、active tool、follow-up payload 和 profile extension 字段测试，先确认 RED；修复后运行 `test/plan-capsule-extension.test.mjs`、完整单元测试，并在后续端到端 Task 中用真实 `pi-subagents` 启动验证。
