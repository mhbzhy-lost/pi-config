# Bug: Broker subscription 将合并 chunk 误判为超限单帧

## 症状

Root broker client 收到 subscription data chunk 后，先对整个累积 buffer 执行 64 KiB 上限检查，之后才按换行拆帧。Unix socket 可以把 ACK 与 push，或多个合法 push 合并到同一个 data chunk；只要合并后的总字节数超过上限，client 就关闭连接，即使每个独立 wire frame 都满足协议上限。

## 影响

高密度 lifecycle started/completed 或接近上限的 terminal proof 可能造成无效 `BROKER_RESPONSE_TOO_LARGE`。Root ownership channel会据此终止 child，因此一个合法事件批次可错误中止整个 Plan Runner。

## 复现

自定义 broker 在一次 `socket.write()` 中写入合法 subscribe ACK 和两个各自小于 64 KiB、合计大于 64 KiB 的 push。当前 client 在寻找首个换行前检查总 buffer，初始 subscribe直接失败；protocol parser分别接受两个push。

## 根因

`BROKER_FRAME_LIMIT_BYTES` 是单个 newline-delimited frame 的上限，但 client把它应用到了 transport chunk/多帧累积buffer。网络 chunk边界不是协议帧边界。

## 修复

subscription parser先循环提取完整换行帧，对每个 `line + "\n"` 单独执行frame上限检查并解析。循环结束后，仅对尚无换行的残余partial frame执行上限检查。超限单帧仍断开，多个合法coalesced frames保持可处理。普通单response路径可维持单帧语义。

## 验证

增加真实Unix socket测试：ACK与两个合法大push一次写入，总chunk超过上限；client必须完成订阅并按顺序交付两条push。另保留单个超限push被protocol拒绝、subscription EOF语义和dispose门禁。
