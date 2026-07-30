# Bug: Fresh Attention ack 未绑定 command 的 Attention projection version

## 症状

Fresh-process reconciliation 用 plan/request/task/attempt/run/message hash 匹配 resolved event，但没有验证 durable command 的 `expectedProjectionVersion` 等于该 Attempt 在 resolution 前的 `attention.projectionVersion`。仅修改 command version 的 stale command 仍会被写 delivered ack。

## 影响

stateRoot 中过期或被替换的 command 可能借用同身份、同消息的历史 resolution event 获得 ack，削弱 Root reply 的 projection fence。不能简单比较 command version 与 resolved event 的 `expectedProjectionVersion`：前者绑定 Attention，后者绑定 native delivery 时的全局 projection，并行事件会使两者合法不同。

## 复现

1. 创建 pending/escalated Attention，记录其 `attention.projectionVersion`。
2. 追加 message hash 和身份均正确的 `attempt.attention-resolved`。
3. 写入相同身份/消息但 `expectedProjectionVersion` 改为另一正整数的 durable command。
4. Fresh dependencies 调用 `processAttentionReplies()`，当前实现仍写 ack，command 从 pending 列表消失。

## 根因

`matchingAttentionResolution()` 分别搜索 request/resolved event，但没有重建 resolution 事件之前的 projection，因此丢失了 command version 应与哪个领域状态比较的语义。

## 修复

按 event 顺序重放 projection；遇到候选 resolved event 时，在应用该事件前检查 matching Attempt 仍为 `waiting-attention`、request pending、task/run 一致，且 `attempt.attention.projectionVersion === command.expectedProjectionVersion`。再验证 resolved event 的 identity/message hash；authorization 重试额外验证 resolved event 的全局 expected version。

## 验证

新增 exact hash + stale command version 独立 RED，旧实现会误 ack。修复后 command 保留且零 send/append；wrong-hash 对照继续保留。并行 progress 后 command Attention version 与 resolution 全局 version 不同的既有 ACK recovery 测试继续通过，证明没有混淆两种版本。
