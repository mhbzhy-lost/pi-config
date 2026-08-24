# 普通 idle 输入被误分类为 execution_amendment

## 生产事实与入口

production 数据来自真实 Pi 会话的公共输入 ABI：`source=interactive` 或 `source=rpc`、`streamingBehavior=undefined` 的普通文本输入是合法输入，不携带 typed Goal 操作授权。可达调用链为：`AgentSession.prompt` → `ExtensionRunner.emitInput` → `scripts/lib/goal-engine/extension.mjs` 的 `input` handler。`InputEvent` 在 Pi 将对应 user `SessionMessageEntry` 持久化前触发，因此 handler 不能把尚未存在的 recovery/session custom message 当作用户授权事实。

## 权威身份与顺序

- Goal Projection/event ledger 是 runtime 生命周期、suspension、action offer 和 pending amendment 的权威；Pi custom entry 仅是可恢复的非权威收据。
- owner 由 Projection 的唯一未 transferred session binding（`ownerSessionId`）决定；输入的 `ctx.sessionManager` 必须解析为该 owner，不能由文本或 custom entry 声称。
- 对明确 typed `goal_amend(operation=propose_execution_change)`：先以 owner/active Projection 建立 durable `goal.runtime_suspended`，撤销 action offer；再完成 owned executor stop、workspace/resource quarantine closure；仅在 closure 完整、CurrentWorld 安全且输入 schema 有效时写入 proposal。任一步失败均不创建 proposal（fail closed）。
- 对真实 `followUp`、`steer`、abort，顺序仍是 durable suspend → action offer revoke → owned closure；resume 只能消费已有 suspended closure 的 token。

## 事件顺序与偏离

复现时 active Goal 的 owner 在 idle 状态发送普通 interactive/RPC 文本。当前 input handler 先于 user SessionMessageEntry 执行，在没有 typed `goal_amend`、没有 followUp/steer/abort 的情况下，进入“普通 idle”分支并调用 `suspendOwnedRuntime(ctx, "execution_amendment")`。该调用写入 suspension、撤销 action offer、执行 closure；之后 continuity/before_agent_start 才可能注入 recovery note。

首个偏离点就是 `extension.mjs` input handler 的普通 idle 分支，而不是 recovery note。recovery note 发生在 runtime 已经 suspended 之后，是结果，不是触发授权。

## 分类结论

这是 AGENTS 第 1 类：预期 production 数据未被正确处理。普通 public interactive/RPC 输入不表示 amendment intent，且不得用自然语言猜测意图。修复后只有明确 typed `propose_execution_change` 才触发 execution-amendment suspension；不会自动恢复或改写任何已 suspended Goal，也不修改 smoke Goal ledger/workspace。
