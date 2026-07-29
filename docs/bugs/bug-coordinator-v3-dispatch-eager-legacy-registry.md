# Coordinator v3 派发被 legacy 验证 registry 提前阻断

## 现象

使用真实 `plan-ir.v3` revision 和公开 `continuePlan()` 时，Coordinator 尚未分配 Attempt 就在 `createTaskCommandRegistry()` 抛出 `Approved contract verification command is invalid`。v3 parser 会把 `verification` 归一化为 command objects，而当前 legacy registry 只接受字符串。

## 影响范围

任何 event-committed v3 Plan 都无法通过 Plan Runner 公开路径派发首轮 Executor，因此 revision 2 replay、完整 prompt 和事件 hash 虽在 Coordinator 单元层可用，真实 runtime 路径仍不可达。

## 复现步骤

创建真实 revision store，准备严格 `pi-plan.v3` revision 1，重放带完整 revision identity 的 `plan.created`，然后调用 `createPlanRunnerDependencies(...).continuePlan()`。调用在 workspace allocation、dispatch event 和 backend spawn 之前失败，堆栈指向 `coordinatorFor()` 立即构造 command registry。

## 根因

`coordinatorFor()` 把 Attempt 验证阶段才需要的 command registry 作为 Coordinator 构造前置条件。Task 7 已切换到 v3 IR 派发，但 Task 8 才负责把 Gate/validator registry 正式迁移到 v3 command objects；这个 eager 初始化把后续消费者迁移错误地变成了当前 dispatch 的前置条件。

## 修复方案

在 Task 7 仅延迟 command registry：Coordinator 构造和 dispatch 不解析 verification；只有 `verificationForTask()` 首次执行时才创建 legacy registry。不得在此修复中提前实现 Task 8 的 v3 Gate/validator 接口，也不得把 v3 command objects 降级为字符串。

## 验证方式

保留真实 revision store + public `continuePlan()` RED 测试，修复后证明 revision 1 可派发，并完成 Supervisor 授权的 `plan_amend`、supersede cleanup 与 revision 2 二次派发。断言第二次 prompt/hash来自 revision 2、revision 1 bytes 不变；随后运行 Coordinator、runner dependencies、amendment recovery 和 clear-env Host/migration 回归。
