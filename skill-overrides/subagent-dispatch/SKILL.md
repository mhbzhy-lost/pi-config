---
name: subagent-dispatch
description: Use when delegating coding work to executor, or non-coding work to another configured Pi agent.
---

# Subagent Dispatch

## Coding

`executor` requires `dispatch-ir.v1`, never a free-form task; never invent `delegate(...)`. Deadlines never waive. Verify cwd, relevant paths, and facts; unknowns are not `knownFacts`, placeholders. Exact top-level/nested shape; no extra fields; repo-relative POSIX `relevantFiles`/`writePaths`; supported enumeration; non-empty arrays; positive integer timeout; criteria-only acceptance. `tdd` reason forbidden; `existing-tests`/`docs-only` reason required.

Worktree defaults false: missing/false preserves cwd, RPC, prompt, and hash. Use true only for parallel writes or explicit isolation: Generic top-level `worktree`; coding `execution.worktree`. True needs a clean attached source; dirty fails `WORKTREE_SOURCE_DIRTY`. Directory-scoped `writePaths` must end with `/**` or `/`（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。

Completion/status is not terminal proof. Call `workspace_status(workspace_id)`, then `workspace_disposition(workspace_id, disposition, strategy?, action_token)`. `workspace_status` returns `action_token`、`allowed_dispositions`、`integrate_blocked_reasons`（后者说明 integrate 被拒原因，如 `origin-advanced-nonlinear` / `writePaths-out-of-scope`）。Only official observed terminal proof permits destructive discard/integrate. `preserve` keeps it; `discard` releases clean workspace; `integrate` is coding-only after `writePaths` checks，且允许 origin 干净前进（并行 worktree 逐个合入）。`release` 释放 `preserved` worktree，无需 `action_token`。Generic cannot integrate。No disposition: retain long-lived `awaiting-disposition`。

禁止 raw git worktree add/remove/prune/move/repair/lock/unlock；只用 managed lifecycle CLI `node scripts/worktree-lifecycle.mjs ...` 或 typed Goal disposition，须 owner CAS/授权；禁止 `--force` remove、raw branch cleanup，`/tmp`、TTL、clean 不授权删除。

```js
subagent({ version: "dispatch-ir.v1", taskId: "harden-dispatch-skill", title: "Harden example", agent: "executor", risk: "normal", objective: "Compile example.", workflow: { mode: "tdd" }, requirements: ["Test first."], context: { knownFacts: ["Source is verified."], decisions: ["Keep safety rules."], relevantFiles: ["skill-overrides/subagent-dispatch/SKILL.md"] }, boundaries: { writePaths: ["skill-overrides/subagent-dispatch/SKILL.md"], excludedWork: ["No schema changes."], forbiddenActions: ["Do not commit."] }, acceptance: { criteria: ["Example compiles."] }, execution: { timeoutMs: 900000, worktree: true } });
```

## Generic

`delegate` forwards `{ agent, title, task }` unchanged.

```js
subagent({ agent: "delegate", title: "Review isolated diff", task: "Inspect the current diff and report findings.", worktree: true });
```
