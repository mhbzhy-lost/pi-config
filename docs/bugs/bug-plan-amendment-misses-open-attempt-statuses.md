# Bug: Plan amendment 遗漏开放 Attempt 状态

## 症状
`validateAmendment()` 只对 `active` 和 `waiting-attention` Attempt 收集 supersede 与资源占用；`workspace-allocated`、`dispatch-requested`、`validated` 未被纳入。

## 影响
这些阶段的 Attempt 仍持有 workspace 或 resource claim。Plan effective hash 改变时旧 Attempt 可能继续执行或集成；降低 resource capacity 时也可能错误接受低于实际占用的 revision。

## 复现
构造上述三个状态的 Attempt，修改对应 Task effective hash 或把新 IR resource capacity 降到 claim 数以下，运行 `node --test test/plan-amendment.test.mjs`；当前实现不会完整收集 supersededAttemptIds，容量校验也会漏算。

## 根因
新模块单独定义了 `SUPERSEDE_STATUSES = {active, waiting-attention}`，没有与 `plan-events.mjs` 的开放 Attempt 生命周期保持同一语义，也没有覆盖资源释放发生在 settle/integration 之后的阶段。

## 修复
在 amendment 领域模块显式定义全部持有合同/资源的开放状态：`workspace-allocated`、`dispatch-requested`、`active`、`waiting-attention`、`validated`；supersede 与 capacity 校验复用同一集合。

## 验证
新增参数化测试，逐一断言五种开放状态在 effective hash 变化时进入 supersededAttemptIds，并断言 `workspace-allocated`、`dispatch-requested`、`validated` 的资源 claim 都阻止 capacity 下调；settled 状态不计入。
