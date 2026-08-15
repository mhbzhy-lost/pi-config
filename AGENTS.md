# Agent Configuration

Pi config root is `pi/` (not `~/.pi`). See `pi/AGENTS.md` for constraints.

## Goal 改造执行方式

在 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R0–R13 全部完成并通过 R13 验收前，禁止使用 Goal Engine 执行、编排或验收该改造计划；所有任务必须按计划 DAG 采用 Subagent-Driven 执行。既有 `planned-goal` 仅作为冻结的历史账本，不得阻塞 R1–R13；待 R13 通过并启动 fresh Host 后再通过 typed 工具收尾。
