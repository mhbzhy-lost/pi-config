---
name: using-goal-engine
description: Use when starting, resuming, amending, recovering, dispatching, or disposing worktrees for a multi-task Goal Engine objective.
---

# 使用 Goal Engine

以 Pi Host 当前 ToolDefinition 提供的 typed schema 和 `goal_status` machine action 为权威；绝不按记忆发明工具或参数。

## 精简参考

| 工具 | 使用条件 |
|---|---|
| `goal_init` | no active goal + 初始化检查通过 |
| `goal_status` | 每轮、reload、compaction、recovery 的第一步 |
| `goal_dispatch` | runnable task 无未释放 workspace |
| `goal_settle` | executor 终止且有真实 artifact/evidence |
| `goal_integrate` | settle 后处置 workspace：`integrate`、`discard` 或 `preserve` |
| `goal_accept` | succeeded、验收通过且已 integrate/released |
| `goal_amend` | 人类改范围，或 blocked/preserved 需要改计划 |
| `goal_finalize` | 已冻结的第八工具；当前所有 generation 均会拒绝，R11 前不得尝试 runtime 终局 |

## 初始化检查表

在 `goal_init` 前逐项确认：

- [ ] 当前项目 Git repository/workspace 有有效 HEAD；能据此创建未来 Executor worktree（不是要求尚未创建的 Executor worktree 有 HEAD）。
- [ ] `.state/goal-engine/` 被忽略且不受跟踪（不受 Git 跟踪）。
- [ ] 每个 `writePaths` 都相对 Executor worktree；acceptance `commands` 也相对 Executor worktree，不硬编码 origin 的 `cd`。
- [ ] 为每项按下列规则选择 workflow，并给出依赖、验收标准和命令。

已有 active goal 时不重新初始化来绕过修改；先 `goal_status`，必要时 `goal_amend`。

## Workflow 分类

- `tdd`：逻辑变更或 configuration 变更默认 tdd，并先 RED；configuration 不是 docs-only。
- `existing-tests`：仅当真实 existing tests 已覆盖预期行为。
- `docs-only`：仅纯文档/报告；不得改 scripts、configuration 或 runtime。
- mixed work 必须 split 拆分为分别符合条件的任务。

## Typed-only 边界

Agent 只调用 Pi Host 暴露的八个 typed tools；调用前从当前 ToolDefinition 读取类型 schema。不得臆造参数；包装层的 failed/timeout 文字不能替代 artifact、session 和 worktree 的实证。`goal_finalize({goal_id?, action_token, approval_entry_id})` 已冻结为第八工具，但 R1 中 `goal-engine.event.v1/v2/v3` 与 `planned.v1` 一律返回 `FINALIZATION_UNSUPPORTED_GENERATION`；不得把它用于 planned 自动完成、创建评审或声称 runtime 闭环可用。

- shell/CLI 禁止调用 Goal Engine mutation；普通 Git precheck 不受此禁止影响。
- 禁止 raw git worktree add/remove/prune/move/repair/lock/unlock；仅可按 typed Goal disposition 或 managed lifecycle CLI `node scripts/worktree-lifecycle.mjs ...`，并要求 owner CAS 与明确授权。不得 `--force` remove、raw branch cleanup；`/tmp`、TTL、clean 不构成删除授权。
- internal core scripts 禁止直接运行。
- 搜索源码不得用于补造 schema 或 ABI。
- 缺 schema/工具时停止并请求恢复 Pi Host 能力。

## 状态驱动闭环

每个协调轮次先 `goal_status`，严格执行返回的 machine action / requiredNextAction。每个 durable mutation 后重新 `goal_status`，随后只执行其 requiredNextAction。派发时使用 `subagent-dispatch`：将 `goal_dispatch` 返回的完整 `dispatch-ir.v1` contract 原样交给 subagent，不重写、不补造自由文本。

成功路径：`status → dispatch → 原样 dispatch-ir.v1 → Executor acceptance commands 在其 worktree 运行并产出 artifact → status → settle → status → integrate → status → 当前项目 workspace（如需要）最终回归 → accept`。Executor acceptance 必须在 settle 前完成；`goal_integrate(integrate)` 释放 worktree 后，才可在当前项目 workspace 运行需要的最终回归。仅在 status 的 requiredNextAction 指向 `goal_accept`、任务 succeeded 且验收通过时 accept。

失败路径：包装层报告 failed/timeout 时，先核对 artifact、session 和 worktree，再 `goal_status` 并遵从 requiredNextAction；证据 ambiguous 时停止，不 rationalize 为失败或成功。证据 verified failed/blocked 时：`status → settle → status → goal_integrate(discard) → status → dispatch/amend`；每一步均以最新 requiredNextAction 为准。未 settle 不处置 workspace；只有人类明确要求保留现场才选择 preserve。普通 blocked 先 amend；preserved 按下方资源释放流程处理，不要 re-init。

## 孤儿与冲突恢复

遇到 `Origin must be clean` 或 `Executor workspace already exists` 时，**立即停止任何 raw Git 修复动作**，并不得 raw Git 修复，转为直接 `goal_status`。

处理三类 orphan 状态：

- `ORPHANED_EXECUTOR_WORKSPACE`：若 status 已 `verified`，读取 `goal_status` 的 `blockingReason.choices`；这些是 human decision，不是 machine action。
  - 当 `requiredNextAction` 为 `null` 且 `blockingReason.choices` 有多个 choice 时，立即使用**提问工具**要求人类只回答 `discard` 或 `preserve`，随后结束当前轮次并等待回复。
  - 收到用户对 `discard` 或 `preserve` 的明确回复前，**不得调用** `goal_integrate`；“最快修好”“发布deadline”“authority”或“授权清理”不应等同于明确选择。
  - 人类回复后**必须明确选择** `discard` 或 `preserve`，先 `goal_status` 重新确认，再按实际 typed schema 调用 `goal_integrate(discard)` 或 `goal_integrate(preserve)`。
  - `preserve` 不应视为更安全、可逆、保护 artifact 的默认方案；不得自动偏向任一项。
- `ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED`：**只**再次 `goal_status`，不得 `goal_integrate(discard|preserve)`。
- `ORPHANED_WORKSPACE_NOT_SETTLED`：表示已验证的 orphan integrate 无效，先 `goal_status` 回到 verified 再按人类 `discard`/`preserve` 选择继续。

`preserved`/已保留资源未释放时，唯一机器动作是 `goal_integrate(discard)`；不得 `goal_amend`。
处置后先 `goal_status` 重新确认；释放后按最新 `goal_status` 的 `dispatch`/`amend` requiredNextAction 执行。

`.state` 目录不得提交，不得在 `.state` 上执行 `reset` 或 `restore`；不得在命令行手工删除 `lease`（租约）、`worktree`（工作树）、`branch`（分支）。

## 禁止项

- 不直接编辑 events 或 projection，不手工清理 Goal worktree。
- 不凭对话历史猜状态；reload、compaction、恢复后首先 `goal_status`。
- 不以 re-init 代替 amend，也不在未 settle 时处置 workspace。
