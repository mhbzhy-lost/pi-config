# Bug：Task 7 Broker subscription RED 使用单次事件循环等待

## 症状

Task 7 production 已让 pending、reply、Root ingress、private target 和 child Attention 测试转绿，但两个通过真实 Unix socket subscription 接收 push 的测试仍失败：owner routing 观察到空数组，后续 ingress 测试还可能收到 `BROKER_DISCONNECTED`。改用不同 `rootSessionId` 的一次 isolated flow 偶尔通过，曾被误判为固定 socket 污染。

## 影响

测试把异步 socket 投递速度误当成生产行为，既可能拒绝正确实现，也可能把前一测试 teardown 的未消费 `subscription.closed` rejection 归因到后续测试。若据此修改 Broker socket 或协议，会扩大 Task 7 范围并掩盖真实测试缺陷。

## 复现

确认没有其他 `root-subagent-broker.test` 进程、固定 socket listener 或残留 socket 文件后，单独运行四个新 Broker 测试仍稳定为 2/4：pending/reply 通过；owner routing 在一次 `setImmediate` 后仍未收到 push；ingress 可能报告 subscription 断开。新测试均用 `setImmediate` 代替条件等待，且 teardown 没有先消费 `subscription.closed`。

## 根因

Unix socket 的 data callback 不保证在一次 `setImmediate` 前执行；新测试将事件循环轮次当成了投递完成条件。与此同时，`t.after` 先登记 Broker close，subscription 的 `closed` promise 没有被显式消费，Broker shutdown 可产生未处理 rejection。固定 `rootSessionId` 只是放大归因偏差，不是根因。

## 修复

只校准 `test/root-subagent-broker.test.mjs`：用有短超时的条件等待观察目标 push 数量，不使用固定 sleep 或单次 event-loop yield；创建 subscription 后立即消费 `closed` rejection，并在 teardown 中先 dispose subscription/client，再关闭 Broker，确保 shutdown 不向后续测试泄漏异步失败。不得改 production、socket identity 或协议。

## 验证

在无其他 Broker test 进程时串行运行四个新测试，要求 4/4 GREEN；再运行完整 `test/root-subagent-broker.test.mjs`，确保固定 socket suite 全绿且无 unhandled rejection。随后恢复同一四文件 production diff 的 Task 7 累计验收。
