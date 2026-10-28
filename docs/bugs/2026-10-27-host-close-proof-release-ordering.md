# Host 关闭期间 terminal proof 先于 workspace 释放

- 日期：2026-10-27
- 影响：Host 关闭并由新 Host 复用同一 sessionFile 后，Goal 侧正确 fail-closed，但 workspace 已经 `released` 且 `terminalProof` 缺失，导致 `PLAN_EXECUTION_FACTS_UNAVAILABLE`，无法重建执行事实。
- 修复范围：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts` 的 coordinator 启动恢复顺序。

## 复现链

真实 smoke 使用 plan `3458c286-9991-4c50-bdbc-0380591f4a4b`：

1. compact 成功，receipt PID 为 `71151`，tokens 从 `179747` 降至 `25998`。
2. 新 Host PID `72493` 使用同一 `sessionFile` 恢复同一 plan/revision；初始状态为 `active / A verifying`，说明 session 恢复本身正确。
3. 后续 inspect 得到 `terminal: unknown`、`integration: blocked`、`workspaceState: released`、blocker `PLAN_EXECUTION_FACTS_UNAVAILABLE`；Goal A 进入 blocked。
4. workspace audit 对应记录为 `state: released`、`terminalProof: null`。
5. 场景 5 保留给修复后的真实 smoke 重跑。

## 根因证据

首个偏离点是 coordinator 的 Host 启动恢复顺序。修复前 `finishStartupRecovery()` 在 `coordinator-server.ts` 第 568 行开始执行：第 570 行先调用 `dispositionSettlement?.replay()`，第 571 行才调用 `await replayTerminalProofs()`。因此，旧 Host 留下的 prepared disposition 可能先执行唯一 Git release 和 workspace ledger 的 `released` 写入；terminal proof outbox 直到之后才被重放。若 proof 仍在 pending，释放已经提交，而 proof 尚未成为 workspace ledger 的持久事实。后续 proof 重放还可能只能观察到已释放记录，无法把已删除 worktree 重新作为事实来源。

代码合同固定了这两个副作用的关系：

- `coordinator-server.ts` 的 `deliverTerminalProof()` 先调用 `workspaceService.recordTerminalProof()`，再通过 `settleOwnedDisposition()` 执行处置；proof 不应在 destructive effect 之后首次落盘。
- `service.ts` 的 `applyPreparedDisposition()` 先执行 `releaseManagedGitWorkspace()`，再把 ledger 状态推进到 `released`；因此调用者必须先确保 proof 已持久化，或让 proof 继续停留在 durable outbox/debt 并保留 workspace。
- `disposition-settlement.ts` 的 `settlePrepared()` 会推进 workspace effect 和 queue receipt；它本身不生成 terminal proof，不能承担 proof authority。

这与 smoke ledger/event 结果一致：恢复后的 workspace 已是 `released`，但 `terminalProof` 为 `null`；Goal 侧随后返回 `PLAN_EXECUTION_FACTS_UNAVAILABLE`，没有放宽 fail-closed，也没有伪造 proof。

## 最小修复

`finishStartupRecovery()` 现在按以下顺序执行：

1. `await replayTerminalProofs()`：先将 outbox 中的 terminal proof 投递到 workspace/coordinator 权威链；投递失败时保留 pending/debt。
2. `dispositionSettlement?.replay()`：只有 proof 已持久化，或该处置本身不要求 proof 时，才允许恢复 prepared disposition 并释放 workspace。
3. `await pumpResumeIntents()`，最后将 coordinator 标记为 `startupReady`。

修复只调整既有 coordinator 恢复顺序，没有新增 authority、没有把 unknown 当作 observed、没有改变 Goal fail-closed 门禁，也没有改变 workspace Git lifecycle 的唯一 owner。

## 验证

- 受影响的既有 disposition settlement 测试继续覆盖 `listen()` 内的跨进程恢复屏障；测试注释已同步为 `proof replay → settlement replay → resume pump → ready`。
- 已运行的命令与结果记录在任务 acceptance report 中。
- 场景 5 需要在不启动真实 provider 的约束下由真实 smoke 重跑确认：proof 持久化完成后，workspace audit 应包含 observed terminal proof；若 proof 投递失败，workspace 应保留并留下可重放的 outbox/debt。
