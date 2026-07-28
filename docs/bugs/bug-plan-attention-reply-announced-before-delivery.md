# Plan Attention reply 在投递失败前被标记为已通知

## 1. 现象

真实 Attention Harness 已写入 fenced `*.reply.json`，但 Plan 状态持续停在
`waiting-attention`。Plan Runner 在 126 秒内产生 111610 行 follow-up 输出，最终超时。

## 2. 影响

用户明确提交的 durable 决策可能永远无法送达 native Supervisor；Executor 保持阻塞，Plan
无法进入验证或终态，同时 tight follow-up 循环大量消耗 CPU、日志和测试时间。

## 3. 触发条件

Plan control timer 在 Agent turn 活跃期间读到新的 Attention reply，并调用
`pi.sendMessage(..., { triggerTurn: true })`；Pi 暂时拒绝或抛出该投递。

## 4. 证据

- durable reply 文件字段完整，`createPlanControl().readAttentionReplies()` 可正常解析。
- Host session 中没有 `pi-plan-attention-reply-v1`、`APPROVED`、ack 或 resolved 事件。
- `processAttentionReplies()` 在 `sendMessage()` 前执行 `announcedAttentionReplies.add()`。
- `startPlanControl()` 吞掉 timer 异常；下次轮询因 requestId 已在集合中直接跳过。

## 5. 根因

`announcedAttentionReplies` 表示“已成功交给 Pi turn queue”，实现却把它当成“开始尝试投递”。
投递和内存去重标记不是原子顺序，失败路径也没有回滚，瞬时错误因此被永久固化。

## 6. 修复与防复发

仅在 `pi.sendMessage()` 成功返回后写入去重集合；若投递抛错，保留 durable reply 未 ack 状态并让
下一次 control tick 重试。单测注入首次投递失败，要求第二次返回同一 command 且只记录一次成功
消息。

## 验证结果

Dependencies 的瞬时失败重试 RED/GREEN 通过；真实 Harness 中 reply 生成 custom turn、native
Supervisor ack、Attention resolved，最终 Plan validated。
