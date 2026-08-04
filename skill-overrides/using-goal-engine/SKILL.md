---
name: using-goal-engine
description: Use when coordinating a multi-task Goal Engine objective, recovering its persisted state, or dispatching executor worktrees.
---

# 使用 Goal Engine

以 typed schema 和 `goal_status` 的 machine action 为权威；绝不按记忆发明工具或参数。

## 精简参考

| 工具 | 仅在 machine action 指示时 |
|---|---|
| `goal_init` | 建立新的多任务 DAG |
| `goal_status` | 每轮、reload、compaction 或恢复后的第一步 |
| `goal_dispatch` | runnable task 无未释放 workspace |
| `goal_settle` | executor 终止且有真实 artifact/evidence |
| `goal_integrate` | settle 后处置 workspace：`integrate`、`discard` 或 `preserve` |
| `goal_accept` | succeeded、验收通过且已 integrate/released |
| `goal_amend` | 人类改范围，或 blocked/preserved 需要改计划 |

只使用以上七个工具。调用前读取其 typed schema；不得臆造参数。包装层的 failed/timeout 文字不能替代 artifact、session 和 worktree 的实证。

## 初始化检查表

在 `goal_init` 前逐项确认：

- [ ] Executor worktree 有有效 Git HEAD。
- [ ] `.state/goal-engine/` 不受跟踪（应被忽略）。
- [ ] 每个 `writePaths` 都相对 Executor worktree；acceptance `commands` 也相对 Executor worktree，不硬编码 origin 的 `cd`。
- [ ] 为每项选择 `tdd`、`existing-tests` 或 `docs-only` workflow，并给出依赖、验收标准和命令。

已有 active goal 时不重新初始化来绕过修改；应先 `goal_status`，必要时 `goal_amend`。

## 状态驱动闭环

每个协调轮次先 `goal_status`，严格执行返回的 machine action。派发时使用 `subagent-dispatch`：将 `goal_dispatch` 返回的完整 `dispatch-ir.v1` contract 原样交给 subagent，不重写、不补造自由文本。

成功路径：`status → dispatch → 原样 dispatch-ir.v1 → settle → integrate → accept`。先运行 acceptance commands，再 accept。

失败路径：`failed` 或 `blocked` 的 active workspace 必须先用 `goal_integrate` 选择 `discard`；随后按 status 选择 redispatch 或 amend。只有人类明确要求保留现场才选择 preserve；preserved/blocked 先 amend，不要 re-init。

## 禁止项

- 不直接编辑 events 或 projection，不手工清理 Goal worktree。
- 不凭对话历史猜状态；reload、compaction、恢复后首先 `goal_status`。
- 不以 re-init 代替 amend，也不在未 settle 时处置 workspace。
