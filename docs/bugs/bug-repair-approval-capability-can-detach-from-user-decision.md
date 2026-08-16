# Repair 审批 capability 可脱离用户决定

一句话：旧合同允许孤立的 `authorize_task` consume 及缺少完整 challenge/decision 身份的审批链绕过原子物化约束。

## 复现

构造仅含 `repair.capability_consumed(action=authorize_task)` 的写入，或篡改 challenge、用户 entry、分支绑定、任务哈希后分别回放；旧 Store/Reducer 未在所有边界拒绝。

## 修复方案

将 challenge、decision 与 consume 改为精确的 canonical 身份对象，拒绝 decision/entry/nonce digest 重用，且 Store 双向只接受 `goal.amended → repair.capability_consumed → repair.task_linked` 的 user-approved 原子批次。共享纯 remediation candidate 构造器供 S1/S3 使用。
