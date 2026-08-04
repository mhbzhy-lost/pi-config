# 终态 frontier 与机器动作不一致

## 现象
blocked/cancelled 目标仍可能列出 pending runnable task；active/all-accepted 没有可执行的最终动作。

## 影响
调度器可能在终态继续派发，或在最后验收确认丢失后无路可走。

## 根因
`runnableFrontier` 未先检查 lifecycle，`taskActionState` 对 accepted 一律返回空动作。

## 复现
构造终态含 pending task 的投影，或构造 active 且全部 accepted 的投影。

## 修复
终态 frontier 恒为空；active/all-accepted 仅 Map 顺序第一个任务给出 `goal_accept`，所有机器动作参数注入 task_id。

## 验证
精确 action matrix 断言 task_id，覆盖 completed/blocked/cancelled 及唯一 finalization action。
