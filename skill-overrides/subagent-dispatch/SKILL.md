---
name: subagent-dispatch
description: Use when delegating coding work to executor, delegating non-coding work to another configured Pi agent, or executing an existing implementation plan after the user chooses Subagent-Driven.
---

# Subagent Dispatch

## Plan DAG Orchestration

User-selected Subagent-Driven execution is a work-conserving DAG scheduler, not a task-by-task review loop. Read the plan's complete `Deps`, `WritePaths`, and `Resources`, then repeat:

1. Compute the ready set from every incomplete task whose dependencies are complete and, when coding workspace isolation applies, integrated.
2. Before any wait or status call, dispatch every ready task whose resources are compatible and writes can be isolated, up to the available concurrency capacity. A dispatchable ready task plus a free slot makes waiting invalid.
3. After any task completes and passes its applicable integration gate, immediately recompute the ready set and fill free slots. A `Wave` is documentation for human review, never a barrier that waits for peer tasks in that Wave.
4. Review blocks only successors that consume the reviewed artifact. It does not stop unrelated ready tasks or drain all in-flight work.

Limit concurrency only for a real DAG dependency, mutually exclusive resource claim, write conflict that cannot be isolated, an explicit concurrency limit, or an actual dispatch failure. A dirty worktree, a desire to see one result first, per-task review, coordination cost, or reduced simultaneous work is not by itself a serial-execution reason. Record the concrete limiting fact when the ready set is not fully dispatched.

## Coding

`executor` requires `dispatch-ir.v1`, never a free-form task; never invent `delegate(...)`. Deadlines never waive. Verify cwd, relevant paths, and facts; unknowns are not `knownFacts`, placeholders. Exact top-level/nested shape; no extra fields; repo-relative POSIX `relevantFiles`/`writePaths`; supported enumeration; non-empty arrays; positive integer timeout; criteria-only acceptance. `tdd` reason forbidden; `existing-tests`/`docs-only` reason required. Without `modelTier`, candidates come from ordered `models` agent metadata. Explicit `modelTier: "terra" | "luna"` overrides the primary with the matching codex-pool model; ordered `models` remains the fallback chain. Run/status/artifact actual-model metadata is authoritative. Generic dispatch must not bypass the typed coding contract to select an executor model.

Worktree defaults false: missing/false preserves cwd, RPC, prompt, and hash. Use true only for parallel writes or explicit isolation: Generic top-level `worktree`; coding `execution.worktree`. True needs a clean attached source; dirty fails `WORKTREE_SOURCE_DIRTY`. Directory-scoped `writePaths` must end with `/**` or `/`（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。

Completion/status is not terminal proof. Call public JSON ABI `subagent({action:"workspace_status",workspace_id:workspaceId})`, then `subagent({action:"workspace_disposition",workspace_id:workspaceId,disposition,action_token:actionToken})`. `workspace_status` returns `action_token`、`allowed_dispositions`、`integrate_blocked_reasons`（如 `origin-advanced-nonlinear` / `writePaths-out-of-scope`）。Only official observed terminal proof permits destructive discard/integrate. `preserve` keeps it; `discard` releases clean workspace; `integrate` is coding-only after `writePaths` checks，且允许 origin 干净前进（并行 worktree 逐个合入）。`release` 释放 `preserved` worktree，无需 `action_token`。Generic cannot integrate。No disposition: retain long-lived `awaiting-disposition`。

禁止 raw git worktree add/remove/prune/move/repair/lock/unlock；所有 standalone、Goal task 和 Goal validation workspace 都由 typed subagent 的统一 workspace service 创建、绑定和处置。交互处置只用 `workspace_disposition` 或 typed Goal disposition，须 public `leaseId`/action token 授权。根级 `node scripts/worktree-lifecycle.ts audit|reconcile` 仅用于统一 inventory、dry-run cleanup plan 和显式 public lease authorization apply，不再提供旧 mutation API；禁止 `--force` remove、raw branch cleanup，`/tmp`、TTL、clean 不授权删除。

```js
subagent({ version: "dispatch-ir.v1", taskId: "harden-dispatch-skill", title: "Harden example", agent: "executor", risk: "normal", objective: "Compile example.", workflow: { mode: "existing-tests", reason: "Existing coverage verifies the change." }, requirements: ["Preserve the public ABI."], context: { knownFacts: ["Source is verified."], decisions: ["Keep safety rules."], relevantFiles: ["skill-overrides/subagent-dispatch/SKILL.md"] }, boundaries: { writePaths: ["skill-overrides/subagent-dispatch/SKILL.md"], excludedWork: ["No schema changes."], forbiddenActions: ["Do not commit."] }, acceptance: { criteria: ["Example compiles."] }, execution: { timeoutMs: 900000, worktree: true } });
```

## Generic

`delegate` forwards `{ agent, title, task }` unchanged.

```js
subagent({ agent: "delegate", title: "Review isolated diff", task: "Inspect the current diff and report findings.", worktree: true });
```
