# Agent Configuration

Pi config root is `pi/` (not `~/.pi`). See `pi/AGENTS.md` for constraints.

## `pi/settings.json` 提交规则

`enabledModels` 字段为 per-machine 配置（各机器可用模型不同），禁止提交其变更。
`/scoped-models` 命令产生的 diff 应丢弃（interactive discard hunk 或 `git checkout -- pi/settings.json`）。
其他字段（如 `defaultThinkingLevel`、`goalEngine`、`compaction` 等）有变更时正常提交。
