# deterministic provider 未识别 Pi 转换后的 Attention reply

## 1. 现象

真实 Attention Harness 已收到 `pi-plan-attention-reply-v1` turn，但 deterministic Plan Runner
仍输出 `PLAN_HARNESS_WAITING_ATTENTION`，没有调用 `subagent_supervisor reply`，最终超时。

## 2. 影响

生产控制链已正确投递 reply，却被测试 provider 误判为未回复，使真实 Harness 产生假失败并额外
等待约 126 秒，掩盖前序修复是否有效。

## 3. 触发条件

Pi 将 extension custom message 投影到 provider LLM context；`role: custom` 被转换为普通
`role: user`，`customType/details` 不进入 provider 消息。

## 4. 证据

- session JSONL 保存了 `customType=pi-plan-attention-reply-v1` 与 requestId。
- Pi `convertToLlm()` 明确把 custom message 转成只有 content/timestamp 的 user message。
- fixture 仅搜索 `role === "custom"`，现有单测也构造了不会出现在 provider context 的形状。
- 运行时 turn 的 content 为 `APPROVED`，前序 Supervisor pending tool result 保留 requestId。

## 5. 根因

测试 fixture 把 session 持久化消息形状误当成 provider 输入形状，没有按 Pi 的公开消息转换边界
建模，因此单测与真实 SDK 行为分裂。

## 6. 修复与防复发

保留 custom 形状兼容，同时识别转换后的 user reply，并从最近一次带 pending details 的
`subagent_supervisor` tool result 取得精确 requestId；delivery 后忽略陈旧的 waiting status，重新进入
bounded control loop。

## 验证结果

Provider 的 session 形状与转换形状测试 `10/10`；真实 Attention roundtrip 约 12.9 秒完成，Executor
写入并提交 `decision.txt`，Attention resolved，Plan 最终 validated。
