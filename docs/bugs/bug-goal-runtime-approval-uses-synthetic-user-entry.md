# Runtime activation 审批使用伪造用户条目

一句话：runtime activation 输入钩子把不存在于 Pi `InputEvent` 的 `entryId`（或随机值）写入审批，导致审计条目并非真实用户消息。

## 真实 Pi 复现

1. 在真实 Pi 中创建等待 runtime activation 审批的 Goal，并调用 `goal_status` 生成 challenge。
2. 提交 ABI 规定的 `{ type, text: "approve", source: "interactive" }` InputEvent；该事件没有 `entryId`、`sessionId` 或 `occurredAt`。
3. 当前输入钩子立即以 `event.entryId || randomUUID()` 写入 decision；随后 Pi 才追加带真实 `id`、`parentId`、`timestamp` 的 user SessionMessageEntry，故审批记录绑定了伪造 ID。

## 修复方案

输入钩子只追加与当前 challenge 身份精确绑定的 canonical approval intent；下一次 `goal_status` 仅通过 `sessionManager.getBranch()` 在 active branch 配对 intent 后唯一的真实纯文本 user message，并以该 message.id 写入 decision 和 Goal approval。intent/decision 仅作为 Pi 域收据，Goal event 与 Projection 是最终权威；orphan、transfer、metadata challenge 的共享 helper 迁移留作后续债务。
