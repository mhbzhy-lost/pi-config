# Bug: Plan cancel 测试复用 production 短 ack 超时导致全量抖动

## 症状
`reads and acknowledges cancel control from a stateRoot separate from the Git origin` 在全量并发回归中报 `Plan cancellation acknowledgement timed out`，单独运行稳定通过。production代码和事件协议没有相关变更。

## 影响
全量回归在高CPU/I/O负载下无法稳定完成，掩盖真实cancel request/ack identity与separate stateRoot合同是否正确。

## 复现
运行全量`npm test`。测试使用`createPlanControl`默认5秒timeout；request写出后测试立即调用`processCancelControl`并写ack，但并发Git/Host测试可让等待ack的JS任务超过5秒才重新调度。request loop先检查wall-clock deadline，未再读取已经存在的ack即超时。隔离运行该用例通过。

## 根因
测试把production默认5秒业务超时同时当作高负载测试总预算。测试目标是验证路径、identity和ack协议，不是验证5秒SLA；并发调度延迟与目标合同无关。

## 修复
仅在两个cancel ack集成用例构造`createPlanControl`时显式传`timeoutMs: 30000`，保持有界并避免并发调度饿死。production默认5秒、poll interval与协议实现不变；专门的`plan-control` timeout单元测试继续覆盖短超时行为。

## 验证
两个cancel用例组合及完整`plan-runner-dependencies.test.mjs`通过；clear-env全量`npm test`通过。确认request/ack identity、cancelled lifecycle和exact-once event断言未放宽。
