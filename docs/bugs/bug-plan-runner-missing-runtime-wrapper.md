# Bug: agent 无法程序化调用 `/plan-run`

## 现象

主 session 中选择 Plan Runner Dispatch 后，agent 无法启动 plan-runner。
先后尝试了两种方式均失败：

1. `subagent({ agent: "plan-runner" })` 直接派发 → `.pi-subagents/plan-runner-entry.mjs` 不存在
2. `bash({ command: "/plan-run ..." })` → `/bin/bash: /plan-run: No such file or directory`

## 根因

`/plan-run` 是 Pi 的 **slash 命令**（由 `plan-launcher-extension.mjs` 通过
`pi.registerCommand()` 注册），只能由用户在 TUI 中输入。
agent 无法通过任何 tool（subagent / bash / 其他）程序化调用 slash 命令。

`plan-runner-dispatch` skill 写的 "invoke `/plan-run`" 对 agent 而言是不可执行的指令。

历史启动链（本问题复现时）：
1. 用户 TUI 输入 `/plan-run <path>` → plan-launcher-extension 处理
2. 创建 worktree + parent lease
3. RPC spawn plan-runner（cwd 指向 worktree），但当时未生成 `.pi-subagents/plan-runner-entry.mjs`

此前文档错误地把第 2 步写成 Launcher 已生成 wrapper；实际缺失的入口正是本缺陷的一部分。

agent 能参与的只有计划编写，启动必须由用户手动触发。

## 影响范围

所有通过 agent 触发 plan-runner 的场景（无论主 session 还是子 agent）。

## 触发条件

agent 加载 plan-runner-dispatch skill 后尝试执行，
无论用 subagent / bash / 其他 tool 都无法调用 `/plan-run`。

## 修复方案

在 `plan-launcher-extension.mjs` 中新增 `plan_run` tool（`pi.registerTool()`），
与 `/plan-run` slash command 共用提取出的 `launchPlan()` 核心逻辑。

agent 通过 `plan_run({ planPath: "..." })` tool 调用启动 plan-runner，
tool 模式跳过 interactive confirm，其余流程（worktree、入口、lease、RPC spawn）完全一致。

## Task 2 修复边界

Launcher 现在是唯一生产入口生成者：worktree lease 成功后、RPC spawn 前，以配置仓中 canonical `pi/child-extensions/plan-runner.ts` 的 file URL 生成普通文件 `.pi-subagents/plan-runner-entry.mjs`。入口目录权限为 0700，文件权限为 0600；成功启动后保留入口，供 Runner 生命周期和恢复使用。

若入口已存在但内容、身份或权限不可信，拒绝启动、不覆盖外来内容，并在安全时回滚 lease。启动或授权失败时按“先停止已绑定 Runner，再删除仍归 Launcher 所有的入口，最后回滚 worktree”补偿。停止失败或入口所有权检查失败时保留 worktree，分别以包含原始启动错误与清理错误的 AggregateError 失败，避免删除活跃 Runner 或未知现场。

仍然禁止：
- `subagent({ agent: "plan-runner" })` 直接派发
- `bash({ command: "/plan-run ..." })` shell 调用
