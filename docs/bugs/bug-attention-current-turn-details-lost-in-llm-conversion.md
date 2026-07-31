# Attention current-turn details 在 LLM 转换中丢失

## 1. 现象

`b42ecf9` 唯一真实 A2 中，Root 为四条 Attention reply 创建了正确 FIFO generations；四个 `events.jsonl` 也都包含 requestId 完全匹配的 `pi-plan-attention-reply-v1` custom message，但 provider 只调用 `plan_status`，没有调用 `plan_executor_supervisor`。

## 2. 影响

Plan Runner 能恢复 durable command，却无法把 replyTo、Executor runId 与决定文本交给模型。四个 Executor 一直等待 Supervisor reply，两个 Plan 停在 projection version 11，Harness 超时。

## 3. 时间线

- `b42ecf9` 修复 wake identity、current-turn 注入与 nested prompt。
- 唯一真实 A2 证明 Root wake、bootstrap 和 custom 注入均成功。
- 对照 installed Pi `convertToLlm()` 后发现 custom message 被转换成普通 user text。

## 4. 根因

Pi 的标准 LLM 转换只保留 custom message 的 `content` 与时间戳，丢弃 `customType` 和 `details`。当前 content 仅为用户决定文本；requestId、runId、projectionVersion 只存在 details，provider context 无法构造 fenced Supervisor reply 参数。现有单测直接把内部 custom message传给 provider state，绕过了真实转换。

## 5. 触发条件

通过 `before_agent_start` 注入 custom Attention reply，并进入任意真实 provider turn 时必现。内部 AgentMessage 与 canonical session 看似完整，但 LLM-compatible messages 已丢失身份。

## 6. 修复与验证

将 schemaVersion、Plan/Task/Attempt/Executor/request 身份、projectionVersion 与 decision 编入版本化单行 content envelope；details 继续保留。Provider fixture 必须从 Pi 转换后的普通 user message解析 exact envelope，再调用 `plan_executor_supervisor`。RED 使用 installed `convertToLlm()`，禁止再直接把 custom details 当作 provider 可见数据。
