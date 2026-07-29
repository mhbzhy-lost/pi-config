# Bug: amendment Harness provider 重用陈旧状态导致 continue tight loop

## 症状
revision 2 增加依赖 Task 2 后，真实 Harness 已完成 Task 2 的 `repair.txt` 提交并产生 stable terminal artifact，但 Plan 状态持续为 Task 2 active。Plan Runner session 在数分钟内重复调用大量 `plan_continue {reason:"integrate"}`，始终返回 `waiting-executors`。

## 影响
真实 amendment Harness 无法消费 Executor terminal fact、集成 Task 2 或进入 Gate；测试最终超时。重复工具调用还使 exact-once 控制循环断言失去意义，并可能掩盖真正的恢复协议错误。

## 复现
运行两 Task revision 2 amendment crash/restart Harness。Task 1 validated 后的最后一次 `plan_status` 保留在模型上下文；一次 `plan_continue` 集成 Task 1 并 dispatch Task 2。Task 2 active期间provider继续基于旧 status中的 Task 1 validated匹配通用 integrate分支，无需刷新status即再次调用continue。

## 根因
Deterministic provider的amendment分支在“latest status之后已有动作”时回落到通用compat状态机。通用状态机用全文正则判断任意 Attempt的 `validated/succeeded`，没有同时检查仍active的Task，也没有要求每个动作后读取fresh status，因此陈旧Task 1状态被无限重用。

## 修复
revision 2由amendment专用结构化状态机接管：每次status后最多执行一个wait/continue/verify动作；动作完成后必须先调用`plan_status`刷新。active Attempt只做有界`subagent_wait`后刷新；validated/succeeded Attempt只触发一次integrate；初始恢复continue与后续integrate使用不同reason；终态Task齐备后只verify一次。

## 验证
真实session不再出现连续continue；Task 2 terminal fact被消费并产生settled/validated/integration/workspace release；continue调用序列有界为初始、一次amendment-recovery和每个集成步骤，`plan_verify` exact once，最终四Gate passed并validated。复跑两次确认稳定性。
