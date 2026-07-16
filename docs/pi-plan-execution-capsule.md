# Pi 计划执行仓

## 使用方式

先完成批准计划，再由 Parent Session 启动专属执行仓：

```text
/plan-run docs/superpowers/plans/2026-07-15-example.md
/plan-status <plan-id>
/plan-open <plan-id>
/plan-recover <plan-id>
/plan-cancel <plan-id>
```

一个计划只对应一个 Plan Session 和一个独立 Git worktree。不同计划可并行；同一计划内一次只允许一个会修改文件的 attempt。Plan worktree 从固定 `baseCommit` 创建，分支为 `pi-plan/<planId>`，位置为被 Git 忽略的 `var/plan-worktrees/<planId>`。

## 状态与边界

Plan Session 的 append-only `pi-plan-event-v1` entries 是计划生命周期、Task、attempt 和 Gate 的唯一事实来源。`pi-subagents` lifecycle artifacts 是 worker 运行事实来源。`var/plan-runs/<planId>/status.json` 只是可再生的只读投影，不能作为恢复依据。

Parent 不保存计划 DAG、Gate、attempt 或 `validated` 判定。Parent-owned lifecycle 只负责顶层 run 的启动、稳定停止和 lease。Parent handle 严格只有七个字段：`planId`、`planHash`、`runId`、`asyncDir`、`sessionFile`、`statusPath`、`worktree`。为应对 slash-only Session 在没有 assistant message 时不刷盘，可信 sidecar `var/plan-runs/<planId>/parent-handle.json` 持久化同一七字段，仅观察终态，不扩展状态边界；新的 Parent 不接管旧的 running child，重启也不会继续旧执行。

`/plan-status` 只读取该计划的投影和 artifact；`/plan-open` 返回其 Plan Session artifact；`/plan-recover` 优先使用当前 Parent branch 的 handle，缺失时从可信七字段 sidecar 恢复，再查询原 run，绝不盲目重复 spawn；`/plan-cancel` 先记录 cancel intent，再调用上游 stop 并确认 artifact 终态。失败、blocked、cancelled、interrupted 都保留 worktree、运行 artifact 与证据，供人工排查；不会自动删除现场。

RPC 不必然要求进程隔离。当前上游 async 实现使用 `detached: true` 和 `unref`，因此 Parent 存活期间 runner 可以后台执行。正常 `session_shutdown` 主动稳定停止顶层 run 并清除 lease；persistent 或异常退出则由 lease watchdog 兜底。watchdog 会触发 Plan child 的 `session_shutdown`，按 owned nested run ID 稳定停止后代，不扫描无关 PID。

stable RPC 的真实 `status` 返回 `text` 与 `details`。Launcher 严格解析独立的 `State` 行；格式化 `text` 不作为生命周期事实来源。

## Gate 与完成语义

每个 Gate 只审查执行仓的 `baseCommit..headCommit`、dirty tracked 文件和未跟踪文件；Parent/origin 工作区的变化不在范围内。Gate 结果绑定不可变的 `inputHead` 与 change-set hash。HEAD 或受审文件变化会使原有 Gate stale，必须重新验证。

只有 deterministic、plan-audit、external-review、final-completeness 四类 Gate 都在同一 `headCommit` 通过，才会产生 `validated`。`validatedHead` 是这一验证结果绑定的提交；只有 `lifecycle === "validated"` 且 `validatedHead === headCommit` 才能报告完成。任何 failed、unavailable、active attempt、dirty worktree 或 stale evidence 都 fail-closed。

`validated` 不会合回 origin，也不会 push。merge-back 前必须重新确认 `validatedHead` 仍等于 Plan worktree HEAD，并确认 origin 工作区干净；随后由用户在 origin 仓库显式执行：

```bash
git merge --no-ff "pi-plan/<planId>"
```

若 HEAD 已变化、Gate stale 或 origin 不干净，禁止 merge，先重新验证或处理现场。

## 上层明确非目标

**暂停与恢复：** 上层 Plan 工作流不调用 pause/resume。`pi-subagents@0.34.0` stable RPC v1 不暴露 native resume，因此不会把 interrupt 后的 paused child纳入正常恢复路径，也不会为此维护私有协议补丁。

**Compaction 延续：** 上层不要求 detached subagent 在 compaction 后继续。Pi compaction 可以保留 `plan.created`，但当前 runner 生命周期不支持自动延续；该能力不进入完成标准，不为此维护私有补丁。
