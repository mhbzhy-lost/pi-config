# Pi 覆盖约束

本章节为上文的覆盖约束，若与上文冲突则以下文为准；其余情形应视为补充说明。

## Subagent

所有 subagent 派发必须遵循 `subagent-dispatch` skill；主 agent 默认只收集报告、形成决策和编写计划，coding 由 executor 执行，除非用户明确要求主 agent 直接执行。禁止每个 subagent 完成后做全量独立审查。

## Goal Engine 计划执行方式

Pi 额外提供以下计划执行方式：

- **Goal Engine：**加载 `using-goal-engine`，通过 typed tools 持久化编排。

仓库或具体计划对执行方式的显式禁令优先；Goal 改造 R0–R13 通过验收前，继续遵守仓库根 `AGENTS.md` 中禁止 Goal Engine 自举的边界。

## Goal Runtime Manual Preview

`goal-runtime.v1` 仅为 Manual Preview：只可由人工依据 `goal_status` 与其返回的 typed tool action 推进，不得 auto-continuation。既有 generation 语义保持不变；R13 完成前不得 production cutover。本节只定义操作边界，不复制运行时状态机。

## Worktree 生命周期

禁止通过任何 bash git 操作清理 worktree，若用户明确要求清理，生成相应 git 命令，让用户手动执行。
