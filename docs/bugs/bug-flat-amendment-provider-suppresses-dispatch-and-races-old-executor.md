# Flat amendment provider 抢占 dispatch 并提前完成旧 Executor

## 1. 现象

provider 把 Plan Runner amendment 控制提取到 `decideDeterministicAmendmentTurn` 后，只识别 `plan_executor_supervisor` reply。旧 Executor 收到的工具结果仍名为 `contact_supervisor`，因此回落到通用分支并立即写入 `decision.txt`。另一方面，revision 2 的 `plan_continue` 已返回 `dispatch-required` 后，amendment 分支仍根据上一份 pending status 再次调用 `plan_continue`，没有把 dispatch contract 交给通用 `subagent` 逻辑。

## 2. 影响

旧 Executor 可能在 event-to-pointer barrier 到达前提交被 amendment 否决的文件，使最终 `decision.txt` 缺失断言失败，workspace 证据也不再代表被中断的 active Attempt。revision 2 则可能在 `plan_continue` 循环中永远不派发 amended/repair Executor，Plan 无法进入 validated。

## 3. 时间线

- Executor 先调用 `contact_supervisor`，Plan Runner 通过 durable `plan_executor_supervisor` reply 完成投递。
- Executor 下一轮只看到 `contact_supervisor` tool result；新 amendment API 因没有 Plan Runner reply identity 返回空。
- 通用 provider 立即执行 `decision.txt` bash。
- Plan Runner recovery 后调用 `plan_continue(amendment-recovery)` 并取得 `dispatch-required`，但最新 status 仍为 revision 2 pending/superseded。
- amendment API 再次根据旧 status 选择相同 `plan_continue`，压过通用 dispatch selector。

## 4. 根因

重构用“是否存在任意 revision 2 status”作为 amendment 独占整轮的判断，没有按最新控制动作决定所有权。Plan Runner 专用状态和 Executor fault-window 状态又被放进同一入口，却只实现了前者的 reply identity。

## 5. 触发条件

启用 `PI_PLAN_HARNESS_AMENDMENT=1`：旧 decision Executor 收到 Supervisor reply，或 revision 2 `plan_continue` 返回包含 dispatch contract 的 `dispatch-required` 结果。普通 flat Harness 未启用 amendment mode，因此原有测试不会暴露。

## 6. 修复与验证

先用 provider stream RED 证明 amendment mode 下旧 Executor 只启动足够长的 blocking command，fault 前不提交；再证明 `plan_continue` 的 `dispatch-required` 结果必须产生原始 `subagent` tool call。amendment API 对已出现的新 `plan_continue` 结果返回“不拥有本轮”，provider 只在 API 明确返回 tool/text 时抑制通用逻辑；等待 lifecycle 时仍返回稳定文本，不能误触发 verify。修复后运行 deterministic provider、fixture 与迁移 focused tests，真实 Harness 仍不在该 checkpoint 运行。
