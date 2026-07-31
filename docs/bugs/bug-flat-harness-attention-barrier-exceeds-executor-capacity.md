# 双 Plan Harness 批量等待 Attention 超过 Executor 容量

## 1. 现象

真实双Plan Harness在45秒Attention轮询超时。失败投影稳定显示3个Attempt为`waiting-attention`，第4个Attempt为`active`；三个已阻塞Executor均未收到回复，第四个无法推进到`contact_supervisor`。

## 2. 影响

Harness无法进入四个Attention roundtrip、integration、Gate和graceful shutdown，导致flat happy path最终验收失败。失败不是Root owner隔离错误，而是测试驱动方式制造的容量死锁。

## 3. 时间线

- 两个Plan各派发两个独立Executor，共4个run。
- pinned runtime同时推进3个Executor，它们提交blocking Supervisor request并保持占用。
- `waitForAttentionStatuses()`要求每个Plan先同时出现2个`waiting-attention`。
- Harness在条件满足前不发送任何`plan_attention_reply`。
- 第4个Executor因容量未释放保持`active`，条件永远不能满足。

## 4. 根因

测试把“收集全部四个请求”错误地设计成回复前全局barrier，没有考虑blocking Attention期间Executor仍占并发容量。真实工作流应在每个durable request出现后立即验证并回复，同时继续收集剩余请求。

## 5. 触发条件

待收集blocking Attention数大于运行时可同时推进的Executor容量；本场景固定为4个请求、3个可推进Executor。

## 6. 修复与验证

新增纯测试support driver及可信RED：模拟前三个请求已pending、第四个只有在任一回复后才出现；driver必须逐个调用`onPending`并最终收集每Plan两个唯一request。Harness callback继续逐项验证Plan event、body hash、typed marker和owner identity，再用单请求Root prompt立即执行`plan_attention_reply`并核对结果。禁止提高并发容量或放松四请求oracle。下一冻结HEAD真实Harness是最终GREEN。
