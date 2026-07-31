# Flat amendment Harness 缺少 event-to-pointer 崩溃 revival

## 1. 现象

现有 flat Root Harness 能证明双 Plan、并行 Executor、Attention、Gate 和 Root shutdown，但没有证明 `plan.amended` 已持久化而 `current.json` 尚未切换时 Plan Runner 退出后的恢复。唯一纵向证明仍在旧 Host Harness 中，且其 provider 使用 `subagent_supervisor` 与 `subagent_wait` 等旧控制路径。

## 2. 影响

删除旧 amendment Harness 会丢失 durable event-to-pointer crash boundary 的真实进程证明；直接保留旧 Harness 又会继续认可 Standalone Host、稳定 `hostRunId` 和跨 Host restart。当前架构无法用最终门禁证明同一 Root 对旧 Executor terminal、supersede release、pointer 修复和 revision 2 dispatch 的完整收敛。

## 3. 时间线

- revision service 已保证先提交 immutable `plan.amended`，再更新 current pointer。
- 单元测试已覆盖 missing pointer、supersede checkpoint、binding recovery 和 no-spawn 等领域矩阵。
- flat Harness 已验证 Root-owned Plan Runner generations 与 Executor lifecycle push，但未进入 amendment 崩溃窗口。
- 旧 amendment provider 仍从 `subagent_supervisor` 结果取 request identity，并以 `subagent_wait` 轮询活跃 Executor。

## 4. 根因

旧场景以停止和重启 Standalone Host 作为崩溃边界；flat runtime 的所有权边界改为单一 Root 后，没有为测试提供“先停止旧 Executor、再停止当前 logical Plan Runner”的 Root-owned 故障注入，也没有把 amendment 控制循环改为应用层 `plan_executor_supervisor` 与 broker completion push。

## 5. 触发条件

在旧 Executor 已绑定且 Attention 获批后调用 `plan_amend`，当 `plan.amended` 已写入 session、revision 2 pointer 尚未落盘时终止当前 Plan Runner generation。若没有同 Root lifecycle debt 驱动 revival，或 provider 仍等待旧工具，Plan 会停在 revision 1 pointer 或 revision 2 pending 状态。

## 6. 修复与验证

把该场景迁入真实 flat Root：测试 fixture 只在第一次 revision 2 `writeCurrent` 前阻塞；Root 测试控制扩展先停止旧 Executor，再按 logical caller 停止当前 Plan Runner，使 official terminal 与 completion debt 驱动同一 Root revival。恢复代读取 durable event 修复 pointer，不重放 amendment 和旧 task hash，取得旧 Executor official terminal 后记录一次 `superseded-preserve` release，再各派一次 revision 2 的 amended/repair Task，最终 validated 且 `decision.txt` 不存在。provider 必须用 `plan_executor_supervisor` 身份恢复 request，并在 lifecycle push 后刷新 `plan_status`，不得用 `subagent_wait` 冒充完成证明。
