# Repair 审批 capability 可脱离用户决定

一句话：旧合同允许孤立的 `authorize_task` consume 及缺少完整 challenge/decision 身份的审批链绕过原子物化约束。

## 复现

构造仅含 `repair.capability_consumed(action=authorize_task)` 的写入，或篡改 challenge、用户 entry、分支绑定、任务哈希后分别回放；旧 Store/Reducer 未在所有边界拒绝。

## 修复方案

将 challenge、decision 与 consume 改为精确的 canonical 身份对象，拒绝 decision/entry/nonce digest 重用，且 Store 双向只接受 `goal.amended → repair.capability_consumed → repair.task_linked` 的 user-approved 原子批次。共享纯 remediation candidate 构造器供 S1/S3 使用。

## 审查发现

候选实现仍遗漏 `challengeHash` 在 capability、consume 与 decision 中的完整绑定，且 capability 校验退化为宽松对象。challenge 误将 activation 初始 HEAD 当作当前世界 HEAD；其 ID 也没有从完整 canonical body 的 hash 派生。Store 未逐项比对 consume 与新增 remediation Task 的 taskId、taskDefHash、executionRevision、subjectHash，Reducer 独立回放也未核对 challenge 与 Task 的完整身份。

## 本轮评审复现与方案

1. 两个不同 challenge 可用不同 `userEntryId` 记录同一 `userEntryHash`，使同一真实用户输入重复授权。policy 入口与 Reducer 均改为同时检查 ID 和 hash，任一既有 challenge 的相同 hash 都拒绝。
2. 调用者省略 `deps` 时，`goal.amended` Reducer 将任务归一为 `deps: []`，但候选 metadata 在省略字段上计算哈希，随后 `repair.task_linked` 重算失败。仅在 Repair candidate 边界、校验和哈希前补为显式空数组，保留调用者给出的 deps，避免改变共享任务合同哈希 ABI。
3. Store 曾把 remediation amendment 固定在 batch 第 0 项，拒绝合法的 autonomous `goal.action_consumed → goal.amended → repair.task_linked`。恢复该单一前缀；user-approved 仍只接受无前缀的精确三事件链，前缀、双前缀和重排均在写入前拒绝。

## Repair 恢复与时钟边界

S1/S2 的 durable-then-throw 证明必须比较 reducer 重放得到的完整 challenge Projection，不能只匹配 event data；否则可信恢复读取中的额外字段或非 decision 字段漂移可使授权链误恢复。Host 显式提供但无效的时钟值必须闭锁，不能使用 ambient 时间掩盖故障。S3 若时钟回拨至用户决定记录前，必须在 capability 签发前报告 DRIFT。
