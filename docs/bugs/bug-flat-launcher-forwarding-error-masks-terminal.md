# Bug: Attention 转发异常遮蔽 Runner 终态

## 症状

Attention 轮询已经观察到 Plan Runner 为 `failed`、`complete` 或 `stopped` 时，如果随后读取正文或调用 `sendMessage` 抛错，轮询回调进入统一的 `catch`，不会停止对应 timer。

## 影响

已终态的 Plan Runner 会继续保留 Attention 轮询，持续发起状态查询和文件读取；在转发异常恢复后还可能向已结束的计划发送不再需要的 Attention。

## 复现

构造 hash 合法、状态为 `waiting-attention` 的 Attention，Root Runner 状态返回 `failed`，并令 Host `sendMessage` 抛错。当前实现执行一次 poll 后，取消 timer 的记录仍为空。令 Runner 保持非终态时，同一异常不应取消 timer，下一次 poll 应能再次尝试发送。

## 根因

poller 在 `await forwardAttention(handle, plan)` 完成后才检查 `runnerTerminal`。`forwardAttention` 的真实 `readFile` 或 `sendMessage` 抛错会跳转到外层 `catch`，跳过终态检查。`576f61e` 中的 tampered 测试只因 `failClosed=false` 在 hash 不匹配时 `continue`，没有触发真实读取或发送异常，因而未覆盖该分支。

## 修复

在 poll callback 内独立累计已观察到的 Runner 或投影终态；无论 Attention 解析或转发成功、跳过还是抛错，都在 `finally` 依据该终态停止 poller。非终态的转发异常保持 timer，使后续 poll 可以重试。

## 验证

先新增 `sendMessage` 注入异常的 RED 测试，确认失败仅为 terminal 分支未取消 timer；再以最小实现使其 GREEN。另验证非终态发送失败不取消 timer，第二次 poll 在发送恢复后会再次调用 Host。Root broker 的既有 close fence 另补充关闭后 grant 被拒绝且 `writeGrant` 调用数不增长的直接断言。
