# Goal budget 全局 gate 阻断无关 Task

## 预期行为

observation 与 repair budget 只限制创建各自对应的新行动。没有 Condition 或 Finding 需要新行动时，tasks-only Goal 即使两个 budget 都为 0，仍应继续派发 Task；Task 已 accepted 且所有 Condition 都满足时，仍应能够完成 Goal。

## 实际行为

Manual Preview 中，一个 tasks-only Goal 的 runtime readiness 为 ready，`max_observations=0`、`max_repairs=0`。Goal 处于 active 时，planner 仍把两个无关 budget 耗尽作为全局 gate，阻断了 `goal_dispatch`。用户选择 keep-debug 后，Goal 已 suspend，现场保持以供后续复现。

## 根因

R9 唯一 planner 将 observation 与 repair budget blocker 放入 global gate；该 gate 随后过滤所有业务 action，未按候选 action 是否会创建新的 observation 或 repair episode 区分。

## 修复与验证

将 budget 判断收窄到候选 action：只抑制新的 `request_observation` 或 `materialize_repair`，保留已有 run 的 record、release、recover 与已有 repair episode 的闭合、reverification。集成测试覆盖 tasks-only 的零预算 dispatch、finalize 以及已有债务继续推进。
