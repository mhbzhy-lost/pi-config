# suspended/ready 在 closure 未完成时静默无 machine action

## 生产事实与 public 入口

真实 Goal 经公共 typed `goal_amend(operation="propose_execution_change")` 进入执行合同修订；该入口在 `scripts/lib/goal-engine/extension.mjs` 调用 `suspendOwnedRuntime(ctx, "execution_amendment")`，再由公共 `goal_status` 读取权威 Projection 并展示 machine action。现场 Goal 为 `goal-dispatch-subagent-spawn-handle-task.executor_bound-settle-integrate-accept`，runtime 为 `suspended`、readiness 为 `ready`、`resourcesQuarantined=false`。

## owner、binding 与权威事实

唯一未 transferred session binding 是 owner 的权威来源；Projection/event ledger 是 runtime、suspension 与 action offer 的权威。受影响 Task 是 `binding-smoke`，其 exact Executor binding 的 run ID 为 `77c124bb-d889-4752-ba51-ca8b6610d731`。该 run、Task workspace 与 Executor-owned resource 是同一 suspension closure 的三个权威对象。

## 事件顺序与空 refs

正常生产顺序为：typed execution amendment → durable `goal.runtime_suspended`（撤销旧 offer）→ terminal observed proof → workspace closure proof → resource closure proof → 仅在完整 closure 后签发 `resume_runtime`。

现场 suspension 已持久化，但 `terminalProofRefs`、`workspaceClosureProofRefs` 与 `resourceClosureProofRefs` 都为空；因此 closure 不完整，且 `resourcesQuarantined=false`。

## 首个偏离点

`obligation-policy.mjs` 的 `actionableFrontier()` 无条件把 suspended runtime 作为 `resume_runtime` 候选。随后 `extension.mjs` 以私有 `fullSuspensionClosure` 条件删除这个已选 action，既不签 token，也不把缺失 closure 显示为 blocker。连续 `goal_status` 因而返回空 machine action，形成恢复死区。

## 分类结论

这是 AGENTS 第 1 类：**预期 production 数据未被正确处理**。数据由合法 public typed 入口、唯一 owner binding、权威 Store Projection 和正常 suspension 事件顺序产生；不是手工 projection、非法 fixture 或旧 generation 兼容需求。本修复只建立 closure 状态合同与可见 blocker，不执行 Root Broker terminal recovery、closure side effect persistence 或当前 Goal 的 resume/settle/disposition。

## Terra 终审 Critical：fresh Broker recovery provenance

终审发现 fresh Root Broker 曾可凭 `runId/asyncDir/sessionId`（甚至 terminal artifact 的缺省 identity）恢复 terminal。其首个偏离点是 `extension.mjs` 从 Store projection 导出 authority 后，在调用 production Host 时缩减为三字段；因此 reload 后 Broker 无法独立证明该 artifact 属于持久化的 `task.executor_bound`。

分类仍为 AGENTS 第 1 类 **预期 production 数据未被正确处理**：这是合法 Goal public dispatch 产生并持久化的 exact binding，而不是 legacy 兼容或测试手写 projection。修复要求 Store-derived authority 原样贯穿 Extension → production Host → Root Broker：`goalId/taskId/attempt/runId/asyncDir/workspacePath/leaseId/sessionId/baseHead/headAtDispatch/executionRevision/contractHash/agent`。fresh recovery 必须同时要求 status 的完整 authority 精确匹配，并要求 terminal artifact 的 `runId/sessionId/asyncDir/agent` 存在且精确匹配；任一 unbound、active、漂移、冲突或缺 artifact 均只返回 attention，绝不注册 owner 或 stop process。

## Root Broker Goal binding sidecar authority 缺口

真实 pi-subagents runtime 写出的 `status.json` / `process-terminal.json` 只包含 runtime 可观察的 run、session、asyncDir、agent 与 terminal 事实；它不包含完整 Goal authority。此前 canary 以手写 authority status 伪造这些字段，生产 runtime 不可达，不能证明 fresh Broker 的恢复路径。这是 AGENTS 第 1 类 **production authority 缺口**：合法 public Goal dispatch 的 durable `task.executor_bound` 有完整 binding，但其到 runtime artifact 的可信绑定没有持久化。

修复在 coordinator 成功 append `task.executor_bound` 后，经 Root Broker internal facade 写入 `root-broker.goal-binding-authority.v1`。它绑定 canonical executor ticket、Goal/attempt/workspace/lease/head/revision/session 与真实 run/asyncDir；普通 caller 没有写入口。fresh recovery 读取安全 sidecar，并仅以 runtime 实际拥有的 status/terminal 字段交叉验证；sidecar、mode/link/hardlink、schema、ticket 或任一 identity 漂移均 stable attention，绝不注册 owner 或 stop PID。历史缺 sidecar run 不兼容。

## Terra Important/Minor：partial closure crash 与 preservation receipt provenance

这同样是 AGENTS 第 1 类 **production 可达恢复缺口**。terminal、workspace、resource 三个 closure side effect 之间可以在任一 append 前崩溃，或在 Store 已 durable 后向调用者抛错；fresh Extension 必须从 Store refs 继续，严格跳过已经 durable 的对应 stop/preserve/quarantine side effect。append 的歧义仅在重新加载的 Projection 与本次 expected Projection 完全一致时可视为成功，不能以局部 ref 或进程内标记推断。

此前 production Host 以 `preservedReceipts` 进程内 Map 作为 preserve 幂等依据，Host restart 后该 authority 消失，且 resource proof 未绑定 managed lifecycle 的 durable receipt。这会使合法的 suspended recovery 在 restart 后重复 preservation 或以漂移的 lease/HEAD/path 生成 proof。修复将 preservation authority 归还 managed manifest：每次 workspace/resource quarantine 都从真实 lease、workspace inspection 与 idempotent managed preservation receipt 重证；receipt 只公开 owner CAS、workspace path、executor HEAD、disposition 与由 durable manifest 导出的 hash，绝不公开 ownerToken。任一 owner CAS、path、HEAD、receipt hash 或 lease identity 漂移均 fail closed。

## Host restart managed lease canonical-path RED

Host A/B 的真实 managed-worktree attestation 首次运行在 macOS `/tmp` alias 上暴露另一个 AGENTS 第 1 类 production 缺陷。`allocateExecutorWorkspace()` 将 managed lifecycle 返回的 canonical `/private/var/.../worktrees/...` 写入 lease；随后 `loadExecutorWorkspaceLease()` 用词法 `/var/.../worktrees/...` 与该持久字段直接比较。在 public allocation → persisted managed receipt → Host A `quarantineWorkspace` 的第一个 load 边界即报 `Executor workspace lease path does not match`，因此合法的 durable receipt 根本不能被重读。

修复仅在 lease 身份比较边界对已存在的 expected workspace path 调用 `realpathSync`，使它与 managed lifecycle 持久的 canonical identity 同源。不会接受不存在路径（`realpathSync` 抛错）、不同真实 root/inode，且替换为符号链接后得到不同 canonical target 会继续 fail closed；不会吞掉解析错误或扩大 alias 兼容。

## 未完成真实 RPC attestation 与 Task5 阻断

本轮曾新增 test-only 真实 Goal RPC canary、`runRpcConversation` 辅助流程、`goal-binding-recovery-probe` 与 deterministic provider 的 canary marker/路由。该四进程 canary 在 Pi 0.84.3 restored-session 的工具 inventory 与 harness 限制下反复超时，未能生成可接受的 attestation；因此已完整删除，未将其伪装为 pass、skip 或 TODO。

当前旧 run 的 `asyncDir` 已为 ENOENT，且没有 Goal binding sidecar。设计明确不兼容缺少 sidecar 的历史 run；按无历史兼容决策，不能从该 run 恢复或进入 Task5。production binding sidecar、full authority、partial closure、durable receipt、path canonicalization 及其低层和 public Goal harness 覆盖仍保留。真实 RPC attestation 将另立独立任务处理，不在本轮执行真实 Goal mutation。
