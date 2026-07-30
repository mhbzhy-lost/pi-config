# Bug：Attention single-flight 弱化严格校验

## 症状

poller 已验证合法 Attention 正文并进入 `sendMessage` 等待时，`plan-status` 的严格校验调用会复用该 Attention 的旧 in-flight Promise，而不会重新读取和校验正文。

## 影响

正文在等待发送期间被篡改后，严格的 `plan-status` 仍会成功返回，未能报告证据无效；用户可能据此处理与已验证内容不同的 Attention。

## 复现

建立包含合法正文及 hash 的非终态投影，让 poller 进入 `sendMessage` 栅栏后将正文覆盖为篡改内容；并发调用 `plan-status` 并释放栅栏。错误实现会 fulfilled，而严格调用应以 `evidence is invalid` 拒绝。

## 根因

`forwardAttention` 在查询 `forwardingAttention` map 后才于共享 closure 中计算正文路径、读取正文和核对 hash。后来的 fail-closed 调用因此只等待先前 poller 的宽松校验快照，single-flight 的范围错误地包含了调用级证据验证。

## 修复

每次 `forwardAttention` 调用都在查询或加入 in-flight map 前独立计算可信正文路径、读取正文并核对 sha256，并按本调用的 `failClosed` 决定抛错或跳过。map 中只共享 `sendMessage` 和成功后的已转发标记。

## 验证

新增确定性并发回归用例，确认篡改后的严格 `plan-status` 拒绝、poller 的原发送只发生一次且可完成；同时保留合法并发只发送一次及发送失败后可重试的测试，并运行 Launcher、兼容、恢复和 Doctor 门禁。
