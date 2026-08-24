# Goal 与 Subagent coordinator 身份桥接缺失

## 来源与分类

这是**预期 production 数据未被正确处理**。同一 root session 通过 typed `goal_dispatch` 再调用 `subagent` 可以合法产生该形状：root session 持久化原始 `toolCall` 与对应 `toolResult`，Goal workspace、contract hash、run 与 commit 均为真实事实；但 settle 因缺少 `executorBinding` 被拒绝。

首个偏离点是 coordinator 的 exact `WeakMap` 身份查询未命中：Goal ExtensionAPI 与 Subagent ExtensionAPI/events wrapper 不是同一对象。`executeCoding` 将 coordinator 视为可选，仍会启动 coding run，因而返回的 handle 未在返回前绑定。

## 边界

修复必须按 root session identity 连接同一会话的 ExtensionAPI wrapper，同时保留 exact identity 优先路径。不得由 terminal、会话文本或其他猜测推导 binding。已启动但未绑定的 run 只能由 active branch 中同一 toolCallId 的原始 Pi `subagent` toolCall/toolResult 配对、严格的 task/contract/workspace/lease 身份，以及 Root broker 的官方 exact proof 一并恢复。本文不记录 token 或完整合同正文。
