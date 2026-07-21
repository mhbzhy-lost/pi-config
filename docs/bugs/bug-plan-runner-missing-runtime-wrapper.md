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

完整启动链：
1. 用户 TUI 输入 `/plan-run <path>` → plan-launcher-extension 处理
2. 创建 worktree + 生成 `.pi-subagents/plan-runner-entry.mjs` + parent lease
3. RPC spawn plan-runner（cwd 指向 worktree）

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
tool 模式跳过 interactive confirm，其余流程（worktree、wrapper、lease、RPC spawn）完全一致。

仍然禁止：
- `subagent({ agent: "plan-runner" })` 直接派发
- `bash({ command: "/plan-run ..." })` shell 调用
