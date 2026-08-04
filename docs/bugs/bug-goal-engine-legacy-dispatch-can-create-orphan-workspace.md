# Bug：Goal Engine 历史 Goal 派发可形成孤儿 workspace

## 1. 现象

门禁上线前创建的 v2 Goal 可被 `goal_status` 兼容读取，但 `goal_dispatch` 未重新执行当前仓库与 task contract 门禁：它放行了硬编码 origin 绝对 `cd` 的 acceptance commands，也没有拒绝仍受 Git 跟踪的 `.state/goal-engine`。派生 Executor contract 未要求完成前提交，`goal_settle(outcome=succeeded)` 也可在 workspace 无 commit 时持久化成功。随后 integrate 因无 commit、越界文件、origin 脏状态或 HEAD 漂移正确拒绝；若操作者再用 raw Git 回退受跟踪的状态文件，projection 会回到 pending，而 lease、worktree 和 executor branch 仍存在，下一次 dispatch 只返回 `Executor workspace already exists`。

## 2. 影响

历史 Goal 可以把 acceptance command 送到 origin 而不是 Executor worktree，破坏执行隔离；派发本身会修改受跟踪的状态文件，使后续 integration 注定无法通过 clean-origin 门禁；无 commit 的任务可被过早 settle 为 succeeded。事件日志与实际 Git 资源分叉后，七个 typed tools 既不在 `goal_status` 暴露孤儿资源，也没有可审计地接管并 discard/preserve 的恢复路径，协调 agent 容易继续使用 `reset`、`restore` 或手工 worktree 清理扩大事故。

## 3. 稳定复现

1. 准备仅含一个历史 v2 `goal.created` 的 Goal；task acceptance command 使用 `cd <origin-absolute-path> && ...`，并让 `.state/goal-engine/**` 仍在 Git index 中。
2. 在当前版本调用 `goal_status`：历史日志可读取且 task 显示 runnable。
3. 调用 `goal_dispatch`：得到包含绝对 `cd` 的 `dispatch-ir.v1`，同时成功创建 attempt-1 lease/worktree；事件追加令 origin 出现受跟踪状态变更。
4. Executor 只修改文件但不 commit；`goal_settle(succeeded)` 仍成功，而 `goal_integrate(integrate)` 报 `No commits to integrate`。
5. 补 commit 后，integration 又因 writePaths、origin dirty 或 HEAD identity 门禁拒绝。
6. 将 events/projection/registry 回退到只含 `goal.created` 的快照，但保留 worktrees 目录；`goal_status` 报 task pending/runnable，`goal_dispatch` 报 workspace 已存在，且没有 typed recovery action。

TokenRec 事故证据：

- 当前 origin：`87504daff8b17ff8961d869b1ad6b018bbf75688`，工作区干净，`.state` 已取消跟踪。
- 当前事件日志：version 1，仅含 `goal.created`；task1 显示 pending。
- 孤儿 lease：attempt 1，base `659c8cd727b0eea0c3aecab12f196ed2c08f6377`。
- Executor 成果：`8907c529315ca6180624e30ecd5653961878816d`，改动 4 个授权产品文件。
- 被 raw Git 回退前的 5 条事件已固定为 `refs/recovery/goal-engine/tokenrec-20260805-state-v5`，指向 `f955e35ea43d3c91e045ef57724f84208bc698a5`。

## 4. 根因

安全校验只放在 `goal_init`/`goal_amend` 的新 mutation 边界，历史 replay 为兼容而跳过 later-added task-definition 门禁后，`goal_dispatch` 没有在实际 `ExtensionContext.cwd` 下重新验证完整 candidate，也没有复用 Git state preflight。`compileTaskContract()` 的 IR 未表达“完成前必须形成 clean commit”，`goal_settle` 只验证 evidence 字段而不检查对应 lease/worktree 的 commit、cleanliness 与 writePaths。最后，projection 是唯一 machine-action 输入；它没有与磁盘 lease/worktree/branch 做只读一致性检查，事件日志被外部回退后无法识别孤儿资源。

## 5. 促成因素

现有回归分别覆盖了历史 v2 只读兼容、新 `goal_init` 门禁、dispatch append 三态恢复、integration Git 门禁和 persisted workspace restart，却没有覆盖“历史 task 真正 dispatch”“受跟踪 state 在 dispatch 前阻断”“succeeded settle 必须有 clean commit”以及“事件日志回退但 lease 仍在”的组合场景。Skill 已禁止直接编辑 events/projection 和手工清理 Goal worktree，但 typed 错误只给出原始 `already exists`，没有稳定 code、`stateChanged=false` 与可执行恢复动作，无法机械阻止协调 agent 转向 raw Git。

## 6. 修复与验证策略

1. 将 repository top-level、attached HEAD、state untracked+ignored preflight 复用于每次 `goal_dispatch`，并在分配 workspace 前以真实 cwd/realpath 重新验证完整 task candidate；历史日志继续可读，但不安全 contract 必须先 `goal_amend`。
2. 在派生 `dispatch-ir.v1` 中加入 clean commit 完成要求；`goal_settle(succeeded)` 在 append 前验证精确 lease identity、至少一个 commit、clean workspace 和 writePaths，失败保持 events/projection/registry 零副作用。
3. 增加只读 orphan inventory：当 projection 未记录 workspace、但预期 attempt 的 lease/worktree/branch 存在时，`goal_status` 不再把 task 标为 runnable，`goal_dispatch` 返回稳定 `ORPHANED_EXECUTOR_WORKSPACE`。
4. 在现有七工具内扩展 `goal_integrate`：只允许人类明确选择 `discard` 或 `preserve` 来接管 identity 完全匹配的孤儿 workspace；先追加专用恢复事件，再走既有三阶段 disposition。孤儿不得直接 integrate，identity mismatch 必须 fail-closed。
5. 使用真实临时 Git 仓库构造事件回退 fixture，覆盖 clean/dirty、有 commit/无 commit、origin HEAD 前进、lease tamper、append failure 和重启重试；保留纯 v1/v2 replay 与 exact-seven ABI。
6. 部署后先固定 TokenRec executor HEAD，再通过 typed `goal_integrate(discard)` 释放孤儿 attempt；随后一次 `goal_amend` 修正所有绝对 commands、task1 writePaths/workflow，再从 attempt 2 重派。禁止直接写 JSONL/projection、手工删除 worktree 或 re-init。
