# Lifecycle started fixture 缺少可信字段

## 症状

Root Broker 的既有 lifecycle 测试通过 event bus 发送 `subagent:async-started` fixture 时，部分事件缺少 `pid`，并把 `sessionId` 写成 `/sessions/...` 的 session file 路径。

## 影响

当前 production 尚未消费 started ownership 字段，因此旧测试可能仍然通过；当 trusted validation 启用后，这些 fixture 会被视为不可信事件，导致生产验证出现假失败，掩盖真实的 lifecycle 行为。

## 复现

运行 Root Broker lifecycle 测试，观察约 1120 行附近的 `lifecycleEvents()` fixture：`subagent:async-started` 使用 `sessionId: "/sessions/..."` 且没有 positive safe `pid`。

## 根因

pinned `async-started` 事件的真实 `sessionId` 是 Root context 的 `currentSessionId`，不是 session file 路径；同时进程身份校验要求事件携带有效 pid。既有 fixture 沿用了早期 lifecycle payload，未随可信 ownership 约束校准。

## 修复

仅校准真实 event-bus started 链路的测试 fixture：补充 positive safe pid、Root logical `sessionId`、absolute `asyncDir` 以及完整 `agent`/`cwd`，并注入稳定的 `captureProcessBirthIdentity`，避免 fake pid 触发真实进程查询。直接 protocol parser 测试中的独立 sessionId fixture 保持不变。

## 验证

严格串行运行定向 lifecycle Root Broker 测试，确认现有 lifecycle 测试为 GREEN；再运行 started ownership 与 birth identity pattern，确认已验收的 7 项 intentional RED 仍仅以预期 ownership 断言失败，而没有运行时错误、超时或取消。
