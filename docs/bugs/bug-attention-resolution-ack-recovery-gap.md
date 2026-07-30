# Bug: Attention resolved 事件与 Root ack 之间失败后不可恢复

## 症状

`resolveSupervisorReply()` 先追加 `attempt.attention-resolved`，再写 Root Attention ack。若 ack 写入或后续状态派生失败，重试会因 projection version 已推进而报 stale；control loop 又只处理 `waiting-attention` Attempt，因此会永久跳过已经 resolved 但仍无 ack 的 durable command。

## 影响

Plan projection 显示 Attention 已解决，Executor 的 native reply 也已成功，但 Root 侧持续看不到 delivered acknowledgement。reply command 留在磁盘，进程内 announcement/authorization 状态可能卡住；进程重启后内存状态丢失也无法从 durable event 恢复，形成跨存储不一致。

## 复现

1. 准备已授权 Supervisor reply，并让第一次 `writeAttentionAck()` 抛错。
2. `resolveSupervisorReply()` 已追加 `attempt.attention-resolved` 后失败，reply command 仍可读取。
3. 用同一 authorization 重试，当前实现因 expected projection version 过期拒绝。
4. 调用 `processAttentionReplies()`，当前实现因 Attempt 已是 active/resolved 而跳过 command，不补写 ack。

## 根因

实现把 append、ack 和 status 当作一次同步事务，但它们分属 session event stream 与 stateRoot 文件系统，无法原子提交；恢复逻辑只识别 pending Attention，没有把 exact resolved event 作为 native delivery 已发生的 durable reconciliation evidence。

## 修复

允许 `resolveSupervisorReply()` 在发现与 authorization 完全匹配的既有 resolved event 时跳过 append，幂等补写 ack 和状态。`processAttentionReplies()` 在发送新 follow-up 前先查找与 command 的 plan/request/attempt/run/message hash 匹配的 resolved event，存在时只补 ack，不再次发送或追加事件。Plan control factory可注入以确定性测试 ack 故障，production默认仍使用真实实现。

## 验证

第一次 ack 故障后 event 只追加一次且 command 保留；同 authorization 重试成功补 ack，不产生第二个 resolved event。新 dependencies 实例仅凭 durable event 和 command 运行 control reconciliation 也能补 ack，且不会发送第二条 follow-up。无 matching resolved event 的 stale command 仍不 ack。
