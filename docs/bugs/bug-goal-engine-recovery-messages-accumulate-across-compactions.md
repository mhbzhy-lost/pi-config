# Bug：Goal Engine recovery 消息在连续压缩中累积

## 现象
同一 session 连续触发 `session_before_compact` 与 `session_compact` 时，每次 compact 都用 `deliverAs: "nextTurn"` 排队一条 recovery 消息；持久 checkpoint 虽更新，队列仍保留历史提醒。

## 影响
下一轮 agent start 会收到重复、过期的 recovery 注入，造成上下文噪声并可能引导 Agent 重复处理已经被最新 checkpoint 覆盖的状态。

## 稳定复现
创建一个 active Goal，在同一 session 至少连续两次触发 `session_before_compact`/`session_compact`。原实现会观察到两条 `deliverAs: "nextTurn"` 消息；重载 Extension 后 `before_agent_start` 也不能只恢复最新 checkpoint。

## 根因
`session_before_compact` 已将 continuity checkpoint 持久化，但 `session_compact` 又以瞬时消息通道重复发布相同恢复信息。消息队列不是 durable projection，无法随 checkpoint 替换而收敛。

## 促成因素
测试只覆盖一次 compact，未在同一 session 验证连续 checkpoint、消息队列与 reload 后 recovery latch 的组合语义。

## 修复与验证策略
移除 `session_compact` 的 recovery enqueue，保留 `session_before_compact` checkpoint、reload 和 recovery latch 的既有语义。测试应确认连续 compact 零条 nextTurn 消息、durable projection 仅保留最新 checkpoint，且 reload 后一次 `before_agent_start` 只返回一条最新 recovery。
