# Bug：Goal Engine 孤儿复验漂移仍暴露破坏性选择

## 表现

`goal_integrate` 首次把 exact orphan inventory 判定为 `verified`，但第二次复验发现 Executor HEAD 或其它身份事实已漂移时，顶层错误码会变为 `ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED`，`blockingReason` 却继续复用第一次 verified inventory 的 `discard|preserve` choices。错误中的安全结论和可选动作相互矛盾。

## 影响

- 只读取 `blockingReason.choices` 的协调器可能在身份已不可确认时继续执行 destructive discard 或 preserve。
- `Error.code`、`blockingReason.code` 和消息中的 `recoveryContract` 不能表达同一个恢复状态，机器消费者无法安全决定下一步。
- 若第二次 inventory 由 verified 变为 `none`，现有构造路径还可能返回空 `blockingReason`，进一步破坏恢复契约完整性。

## 根因

二次复验失败分支把第二次 inventory 直接传给统一的 `unverified()` helper。该 helper 虽固定顶层错误码为 unverified，却调用 `orphanWorkspaceActionState()` 按传入 inventory 的原始 kind 生成动作：漂移后的第二次结果仍可能是另一个 `verified` snapshot，或变为 `none`，所以不能代表“两个 snapshot 不一致”这一安全事实。

## 触发条件

1. projection 中没有 workspace，但 exact candidate attempt 的首次 inventory 为 `verified`。
2. 调用 `goal_integrate(action="discard"|"preserve")`。
3. 在两次 handler inventory 之间改变 Executor HEAD、lease 或资源，使第二次 snapshot 与第一次不完全一致。
4. handler 进入二次复验失败分支并构造错误。

## 修复方案

为“首次 inventory 非 verified”和“二次 snapshot 漂移”分别构造 unverified blocking reason。二次漂移无论第二次 kind 为 `verified`、`unverified` 或 `none`，都必须返回统一的 `ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED`，只允许 `goal_status`，明确不含 destructive choices；verified orphan 的 integrate 拒绝也必须使用与顶层 `ORPHANED_WORKSPACE_NOT_SETTLED` 一致的 blocking reason。

## 验证方案

1. 使用确定性 barrier 在第二次 inventory 前只追加一次真实 Executor commit，断言顶层 code、`blockingReason.code` 和消息内 `recoveryContract` 完全一致，且没有 `choices`。
2. 使用确定性 barrier 在第二次 inventory 前移除 exact attempt 资源，使结果变为 `none`，断言仍返回完整 unverified contract，而不是空 blocking reason。
3. verified orphan 调用 integrate 时断言 `blockingReason.code=ORPHANED_WORKSPACE_NOT_SETTLED`，并保持 events、projection、registry、lease、refs 与 worktree 不变。
4. 运行定向、完整 extension 和全部 Goal Engine 回归。
