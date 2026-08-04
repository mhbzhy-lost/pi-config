# 终态 frontier 与机器动作不一致

## 现象
blocked/cancelled 目标仍可能列出 pending runnable task；active/all-accepted 没有可执行的最终动作。

## 影响
调度器可能在终态继续派发，或在最后验收确认丢失后无路可走。

## 根因
`runnableFrontier` 未先检查 lifecycle，`taskActionState` 对 accepted 一律返回空动作。原提交的 terminal graph 测试仅检查 taskActionState、matrix 也只有一个 accepted task，缺少 completed/blocked/cancelled 的 runnableFrontier RED 与两 accepted task 的唯一 finalizer RED。另一个 terminal 重试边界不能按当前 `completionVerdictFor` 重算：后续 evidence 语义升级会改变历史证据的分类，从而错误拒绝已 durable 的 completed projection。

## 复现
构造终态含 pending task 的投影，或构造 active 且全部 accepted 的投影。

## 修复
终态 frontier 恒为空；active/all-accepted 仅 Map 顺序第一个任务给出 `goal_accept`，所有机器动作参数注入 task_id。

## 验证
精确断言 completed/blocked/cancelled 的 runnableFrontier 为 []，并对两 accepted task 断言 Map 首 task 的 goal_accept+task_id 和第二 task 的 noAction；completed retry 直接返回合法的 durable verdict。
