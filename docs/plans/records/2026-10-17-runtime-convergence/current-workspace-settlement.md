# 当前真实 workspace 结算记录

## 最新处置（以本节为准）

- 本次重新取证前先做只读 Git 事实核对：worktree 存在、`git status --porcelain --untracked-files=all` 为空、HEAD `92b03021b52959237c2642560435cb8fd0528728` 与 origin HEAD 相同、分支 `pi-managed/a8f3cdf0-fbca-4c19-abb3-f5971dedc750`、相对基线 ahead 0，即无已证 payload。
- 当次 `managed_workspace_status`：`state=active`、`process_terminal=pending`、`allowed_dispositions=[preserve, release]`、`integrate_blocked_reasons=[terminal-unobserved, origin-dirty]`，并取得一次性 token（未复用旧 token）。
- 当前模型面 `managed_workspace_dispose` 的 required 仅 `workspace_id`、`disposition`、`action_token`，`strategy` 已可省略；省略后 `preserve` **实际成功**，回执 `state=preserved`。此前的 `blocked-interface` 不再复现，归因见 `workspace-schema-provenance.md`。
- preserved 后 `managed_workspace_status` 按合同返回 `MANAGED_WORKSPACE_STATE`，并指明 allowed action 为 `release`。
- `managed_workspace_release` 返回 `MANAGED_WORKSPACE_TERMINAL: release requires an observed terminal proof`。这是 H2 收紧后的预期 fail-closed：该 child run 没有 observed terminal proof，不伪造 proof、不 raw 删除 worktree 或分支。
- `managed_workspace_list` 复核当前仍为 `state=preserved`，失败未把它降级为 `cleanup-debt`，现场保留。
- 因此当前终态是：**泄漏已结算为 preserved，物理回收仍 blocked-terminal-proof**。解阻条件是该 run 取得合法 observed terminal proof（或上游提供不依赖 proof 的受控回收入口），不通过放宽 proof 门禁实现。

## 历史现场（保留，不作为当前状态）

- workspace：`a8f3cdf0-fbca-4c19-abb3-f5971dedc750`
- 最新 typed status：`active`，`process_terminal=observed`，`lease_id=b9d7912c...`，`integrate_blocked_reasons=["origin-dirty"]`。
- typed list 同时投影 `process_terminal=unknown`；该差异只记录为当前投影不一致，不据此伪造 terminal proof。
- 最新 status 已取得新的 action token，但没有执行 destructive action。
- 当前 public model 调用面把 `strategy` 表示为必填；runtime 对 preserve/discard/release 携带该字段返回 `INVALID_WORKSPACE_STRATEGY`，源码 factory 仍声明 `required:false`。本轮不重复相同参数、不绕 raw git 或旧工具。
- 因此现场结果是 `blocked-interface`，不是 preserve/release 成功，也不是 queue 已结算。解阻条件是修复/确认 Host/provider schema 投影后，在同 owner、fresh Host 和当次 token 下重新取证；不能复用本记录 token。
- worktree 无已证 payload 交付，且 origin-dirty 阻塞 publication；不创建空提交、不自动合入父仓 dirty 内容、不删除目录。
