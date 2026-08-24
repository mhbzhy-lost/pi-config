# Agent Configuration

Pi config root is `pi/` (not `~/.pi`). See `pi/AGENTS.md` for constraints.

## Goal 改造执行方式

在 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R0–R13 全部完成并通过 R13 验收前，禁止使用 Goal Engine 执行、编排或验收该改造计划；所有任务必须按计划 DAG 采用 Subagent-Driven 执行。既有 `planned-goal` 仅作为冻结的历史账本，不得阻塞 R1–R13；待 R13 通过并启动 fresh Host 后再通过 typed 工具收尾。

## `pi/settings.json` 提交规则

`enabledModels` 字段为 per-machine 配置（各机器可用模型不同），禁止提交其变更。
`/scoped-models` 命令产生的 diff 应丢弃（interactive discard hunk 或 `git checkout -- pi/settings.json`）。
其他字段（如 `defaultThinkingLevel`、`goalEngine`、`compaction` 等）有变更时正常提交。

## `pi/models.json` 本机配置

本机专用 provider/model 定义可通过 `git update-index --skip-worktree pi/models.json` 仅保留在本地，禁止提交。上游修改 `pi/models.json` 时，必须先执行 `git update-index --no-skip-worktree pi/models.json`，再进行同步；同步完成并恢复本机定义后，如仍需隐藏本地差异，再重新设置 `--skip-worktree`。

## 缺陷数据来源分类门禁

测试、恢复或实际运行发现异常时，在增加任何 production 兼容、防御或 fallback 逻辑前，必须先记录数据来源、首个偏离点和完整生成调用链，并完成以下分类：

1. **预期 production 数据未被正确处理**：数据可由合法 public/typed 入口、权威 Host/Store 与正常事件顺序产生，且身份、时间和资源事实均有效。按生产缺陷处理：中文问题记录、精确 RED、最小修复。
2. **测试制造的非预期数据**：数据来自手工拼 projection/event、绕过 public 入口的直接 append、非法或倒退时间、缺字段 mock、过期 fixture，或设计中不可达的状态组合。只修测试、fixture 或 harness；禁止为其增加 production 兼容分支。
3. **来源尚未证实**：无法证明 production 可达，也无法证明仅为 fixture 污染。必须 fail closed、保留现场并补充 provenance 证据；在完成分类前禁止预防性兼容。

分类证据必须覆盖实际入口、权威身份、事件/资源顺序和与 production 事实的差异。仅有测试失败、标题矩阵、模拟对象或“理论上可能”均不足以证明 production 可达。不得将三类异常一视同仁。
