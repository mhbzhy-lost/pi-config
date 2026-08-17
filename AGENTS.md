# Agent Configuration

Pi config root is `pi/` (not `~/.pi`). See `pi/AGENTS.md` for constraints.

## Goal 改造执行方式

在 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R0–R13 全部完成并通过 R13 验收前，禁止使用 Goal Engine 执行、编排或验收该改造计划；所有任务必须按计划 DAG 采用 Subagent-Driven 执行。既有 `planned-goal` 仅作为冻结的历史账本，不得阻塞 R1–R13；待 R13 通过并启动 fresh Host 后再通过 typed 工具收尾。

## `pi/settings.json` 提交规则

`enabledModels` 字段为 per-machine 配置（各机器可用模型不同），禁止提交其变更。
`/scoped-models` 命令产生的 diff 应丢弃（interactive discard hunk 或 `git checkout -- pi/settings.json`）。
其他字段（如 `defaultThinkingLevel`、`goalEngine`、`compaction` 等）有变更时正常提交。
