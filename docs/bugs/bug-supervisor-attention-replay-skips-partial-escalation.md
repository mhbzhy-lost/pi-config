# Bug：Supervisor Attention exact replay 跳过半提交 escalation

## 症状

`recordSupervisorRequest`对已存在的同runId、requestId、kind和message hash直接返回幂等结果。如果首次调用已append `attempt.attention-requested`，但随后`attempt.attention-escalated`或derived status写入失败，重试会命中该提前返回分支，不再补齐后续步骤。

## 影响

Plan projection可永久停在“已请求但未escalated”的半提交状态，Root notification和恢复逻辑看到的Attention事实不完整。adapter随后发送`supervisor.ack`，Broker会停止official-proof重放，使缺口固化。

progress update也有同类status缺口：事件已append但derived status失败后，exact replay不重算status。

## 复现

1. 对blocking Supervisor request成功append `attempt.attention-requested`。
2. 让下一次`attempt.attention-escalated` append失败。
3. generation-local adapter保留request并重试，或新generation收到Broker未ACK重放。
4. exact replay找到已有Attention后直接返回；事件流仍没有escalation，status未重算。

## 根因

幂等判断只验证了request身份和内容，没有把`recordSupervisorRequest`视为由request event、可选escalation和derived status组成的可恢复事务。

“事件已存在”被误当成“整个领域操作已完成”。

## 修复

exact replay验证身份后：

- blocking Attention若仍pending且`escalated !== true`，用当前projection version和原evidence补append一次`attempt.attention-escalated`；
- 已escalated或progress replay不得重复append领域事件；
- 所有exact replay都重新执行`derivedStatus(ctx)`；
- payload冲突、resolved/不匹配状态继续fail closed。

只有上述恢复步骤完成后adapter才能把record阶段标记成功并发送Broker ACK。

## 验证

RED让第一次escalation append失败并保留已提交request事件；fresh dependency用恢复ctx重放同一message，必须得到exact一次request和exact一次escalation。冲突payload仍拒绝，完整成功后的普通replay仍零新增事件。
