# 行动策略可饿死条件或忽略终态事实

**Bug：** 若只选择单个运行中 Task 的未来结算，策略会饿死已可启动的 Condition，并可能遗漏 Observation 终态记录、释放与资源清理。

## 复现

1. 一个 Task 处于 `running`，其终态只能由未来唤醒获得。
2. 无依赖的 Condition 已满足激活条件且可观察。
3. 旧式单动作策略优先将 Task 伪装为立即 `settle`，不展示 Condition；或在 Observation terminal 后不先记录、释放。

## 修复方案

实现纯行动前沿：展示全部当前动作，依固定优先级和 canonical ID 只挑选一个；仅消费已给出的 Task 当前动作，明确记录 Observation 终态、资源债务、阻断与注意状态。
