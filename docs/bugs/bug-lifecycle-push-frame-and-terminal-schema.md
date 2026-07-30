# Bug: Lifecycle push 帧上限与 terminal proof 合同不一致

## 症状

`parseBrokerPush()` 对 `processTerminal` 只检查可 JSON 序列化且 proof 本身不超过 64 KiB。Root broker client 却对包含 push envelope、其他 lifecycle 字段和换行的完整订阅帧使用同一个 64 KiB 上限。另一个问题是任意小于上限的 JSON 值都可作为 `processTerminal` 通过，包括字符串、数组和未知字段对象。

## 影响

协议层可接受一个客户端必然以 `BROKER_RESPONSE_TOO_LARGE` 拒绝的合法 push，导致订阅断开。弱 terminal schema 还允许非 pinned `ProcessTerminalV1` 的值进入 lifecycle transport，无法证明 terminal state、runner identity 和 process instances 的结构。

## 复现

1. 构造 proof JSON 小于 64 KiB，但加上 push envelope 与换行后大于 64 KiB；当前 `parseBrokerPush()` 接受，client 收帧后断开。
2. 将 `processTerminal` 设为字符串、未知字段对象，或令 proof state 与外层 state 不同；当前 parser 仍接受。

## 根因

生产代码分别定义了 proof limit 与 client frame limit，没有一个共享的完整 wire-frame 上限。terminal proof 被当作普通 JSON blob，而没有把 pinned upstream 的 `ProcessTerminalV1` 判别联合类型转成 broker wire contract；其中重复的 `runId` 已移到外层，但其余字段未校验。

## 修复

导出单一 broker frame byte limit，并让 client 与 protocol 共用。`parseBrokerPush()` 对所有 push 检查 `JSON.stringify(push) + "\n"` 的完整字节数不超过该上限。为 `processTerminal` 实现 pinned `Omit<ProcessTerminalV1, "runId">` 的 exact variant 校验：base、state-specific fields、process instance、canonical session、枚举和有限数值，并要求 proof state 与 lifecycle data state 一致。

## 验证

增加两个独立 RED 组：完整帧超过上限时 parser 拒绝，而普通 observed proof 保持通过；字符串、unknown field、variant 缺字段、无匹配 runner、state mismatch 分别拒绝，并覆盖 observed/unknown/pending/not-started 的合法 pinned 形状。Root broker、client subscription、owner routing与现有真实 terminal 测试全部回归。
