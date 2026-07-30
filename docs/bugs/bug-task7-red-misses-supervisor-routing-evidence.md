# Bug：Task 7 RED 未证明完整 Supervisor 路由合同

## 症状

Task 7 tests-only 提交虽然产生了五个独立 RED，但 pending/reply 测试只检查 Broker 返回成功，没有证明 Root native Supervisor target 的调用次数和 exact 参数；ingress 测试没有订阅 owner，无法证明 duplicate request 不会重复 push。runtime target 测试还假设 upstream closure 只接收两个参数，偏离现有 Supervisor Adapter 的五参数执行合同。

## 影响

生产实现可能通过这些 RED，却仍把 `to` 等 Plan 输入泄漏给 native target、重复回复或重复推送 request，或者为了满足错误测试而绕过现有 `createSupervisorAdapter`。此外测试使用实际 upstream 不会产生的 `reason: "approval"`，不能证明真实 `need_decision` 消息链路。

## 复现

检查 `b7bfaf0`：`Supervisor pending and reply...` 没有注入或检查 `executeSupervisor`；accepted reply 后没有再次 reply，也没有 unknown request；`rejects conflicting Supervisor ingress...` 没有 subscription/push 断言；`internal Supervisor target...` 断言 native closure 收到 `[params, context]`，而现有 adapter 的公开执行合同是 `(toolCallId, params, signal, onUpdate, ctx)`。

## 根因

测试派发合同同时要求多层行为，但实现者以最小 RED 数量为目标，只确认当前 production 缺 API，没有逐条回读 acceptance evidence。父级设计也没有把内部 wrapper 与既有 adapter 的参数映射写成精确期望，留下了错误二参数解释空间。

## 修复

只校准三个测试文件：所有 Supervisor fixture 使用真实 `need_decision`；runtime wrapper 对外保持 `executeSupervisor(params, ctx)`，但断言其通过现有 adapter 以固定内部 toolCallId 和五参数调用 native closure；Broker 测试注入 target spy，证明 owner reply exact 一次、去除 `to`、unknown/duplicate fail closed；ingress 测试建立 owner subscription，证明 unknown 零 push、exact duplicate 单 push、conflict 不改 owner。

## 验证

重新运行五个定向测试，要求仍全部 RED，但每项失败来自缺失 runtime/Broker/child 行为，无 TypeError、超时或取消。单独检查 target、duplicate push、unknown/repeated reply 的断言都能在未来生产 API存在后执行；Capsule/Dependencies 既有 Attention characterization 保持 GREEN。
