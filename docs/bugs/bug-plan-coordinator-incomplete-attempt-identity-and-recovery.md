# Plan Coordinator 的 Attempt Identity 与恢复实现不完整

## 现象

Coordinator 首次授权即因 `activeAttempt is not defined` 失败；恢复路径同样缺少 `requestedAttempt`，attempt ID 又通过无绑定的 `this.planId` 生成。

## 影响范围

计划无法派发首个任务，也无法从 dispatch crash window 恢复；即使补齐函数，错误 planId 的 attempt identity 也会破坏事件绑定和重试去重。

## 复现步骤

创建 plan.created projection 后调用 `authorizeNext()`，或重放 dispatch-requested 后调用 `recover()`；当前分别抛 ReferenceError。检查 `nextAttemptId()` 可见其依赖不存在的 `this.planId`。

## 根因

初稿在未完成 projection 查询 helper 和 attempt identity 设计时提前返回，且没有运行 GREEN；Task 6 测试也未同步新增的 dispatch-requested 前置事件。

## 修复方案

Attempt ID 只从重放后的 `projection.planId`、taskId 和既有 attempt 次数生成；实现 requested/active 查询、awaiting-review 阻断、结构化 result 绑定及真实 complete/failed/paused 状态映射。事件测试统一使用 dispatch-requested 后再 bound。

## 验证方式

保留 Coordinator 全套 RED，修正实现后运行 coordinator/events/graph 目标测试和完整单元测试；验证失败重试 ID 递增、未知 dispatch 保守 blocked、已绑定 attempt 不重发。
