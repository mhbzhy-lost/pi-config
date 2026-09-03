# Pi 专属全局约束

本文件仅由当前 `PI_CODING_AGENT_DIR` 的全局 Extension 追加到 Pi system prompt，不参与 cwd、父目录或项目级规则发现。

## Subagent

所有 subagent 派发必须遵循 `subagent-dispatch` skill；主 agent 默认只收集报告、形成决策和编写计划，coding 由 executor 执行，除非用户明确要求主 agent 直接执行。禁止每个 subagent 完成后做全量独立审查。

## Goal Engine 计划执行方式

Pi 额外提供以下计划执行方式：

- **Goal Engine：**加载 `using-goal-engine`，通过 typed tools 持久化编排。

仓库或具体计划对执行方式的显式禁令优先；Goal 改造 R0–R13 通过验收前，继续遵守仓库根 `AGENTS.md` 中禁止 Goal Engine 自举的边界。

## Goal Runtime Manual Preview

`goal-runtime.v1` 仅为 Manual Preview：只可由人工依据 `goal_status` 与其返回的 typed tool action 推进，不得 auto-continuation。既有 generation 语义保持不变；R13 完成前不得 production cutover。本节只定义操作边界，不复制运行时状态机。

## Worktree 生命周期

禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock` 和猜测性 cleanup；只读 `git worktree list` 可用。创建、销毁、repair、lock 仅可经 typed Goal disposition 或 `node scripts/worktree-lifecycle.mjs ...` managed lifecycle CLI，且须 owner CAS 与明确授权。禁止 `--force` removal、raw branch cleanup；`/tmp`、TTL、clean 状态均不构成删除授权。

## Git Commit 机械门禁

commit message 的机械校验由 Pi `security-gates` Extension 执行。
