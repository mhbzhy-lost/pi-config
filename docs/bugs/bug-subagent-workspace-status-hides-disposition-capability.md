# Subagent workspace status 隐藏 disposition capability

## 问题描述

父 Agent 通过 typed `workspace_status` 查询 managed workspace 时，公开 `content` 只显示 workspace id 和 state，无法取得执行 disposition 所需的一次性 `action_token` 与 `allowed_dispositions`；同时，首次 allocation 写入的本地 runtime state 未被 Git 忽略，导致 origin 自动变脏。

## 复现步骤

1. 为 Subagent 请求 managed workspace，并调用 typed `workspace_status`。
2. 观察返回的 `details` 有 `action_token`、`allowed_dispositions` 等公开字段，但父 Agent 可见的 `content` 只有 `Workspace <id>: active`，因此不能经 typed tool 完成 disposition。
3. 在主工作区首次 allocation 后执行 `git status --short`。
4. 观察 `/.state/subagent-dispatch/` 下的 ledger/worktree runtime 成为未跟踪候选内容，originClean 为 false。

## 修复方案

复用 `workspacePublic` 生成稳定、机器可读的公开 `content`，包含 `workspace_id`、`state`、`process_terminal`、`allowed_dispositions` 与 active workspace 的 `action_token`；不重复生成 token，且不输出 owner token、私有 proof 或其他秘密。保持 `details` 的既有 snake_case 合同，并在根 `.gitignore` 精确增加 `/.state/subagent-dispatch/`。
