# Plan Shutdown 测试提前消费 Run ID

## 现象

多 Plan `session_shutdown` 测试期望 `run-one` 的 RPC stop 失败并汇总为 `AggregateError`，实际 shutdown 正常返回，测试报告 `Missing expected rejection`。

## 影响范围

仅影响新增的 shutdown 单元测试 fixture；生产 active run registry 与 stop 路径尚未因此证明错误，但 GREEN 验证被阻塞。

## 复现步骤

连续启动两个测试 Plan。`id()` 在进入 spawn 前执行 `ids.shift()`；spawn 随后读取 `ids[0]`，得到的 run ID 分别是 `run-two` 和 `run-undefined`，因此针对 `run-one` 的失败分支永远不可达。

## 根因

同一个可变数组同时承担 Plan ID 分配和 spawn run ID 推导，两处读取时序不同。fixture 错误假设 spawn 时当前 Plan ID 仍位于数组首项。

## 修复方案

将 Plan ID 分配与 spawn run ID 分配拆成独立、确定性的序列，保证两个 handle 分别绑定 `run-one`、`run-two`，不依赖已被消费的数组状态。

## 验证方式

重新运行目标测试，确认 `run-one` stop 失败被汇总，同时 `run-two` 仍完成 stop 和 lease cleanup；再运行 launcher、lifecycle、control 全部单元测试。
