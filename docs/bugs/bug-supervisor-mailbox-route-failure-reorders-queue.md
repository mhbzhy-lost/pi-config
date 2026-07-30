# Bug：Supervisor mailbox route 失败后遗留队列越序

## 症状

mailbox 在 startup queue drain 时若第一条 `route()` reject，`draining` 会在 finally 中清空，但 `active` 保持 true，后续未处理消息仍留在 queue。此后新 `handle()` 看到 active 且无 draining，会直接 route，越过旧队列。

## 影响

早到 request `1,2` 中 `1` 路由失败后，新 request `3` 可先于 `2` 被 Plan Runner 观察，实际顺序成为 `1,3,2`，或 `2` 永久滞留。Root startup 通常会 rollback，但 mailbox 的异步事件与 session_start catch 存在交错窗口，公开 helper 也不应依赖调用方补偿内部非法状态。

## 复现

inactive 时依次 handle `1,2`，让 route `1` 首次抛错并等待 activate reject；随后 handle `3`。当前实现立即 route `3`，第二次 activate 才 route `2`，稳定观察到 `[1,3,2]`。

## 根因

`activate()` 只在 drain 成功路径隐含维护 active/queue 一致性；reject 路径只清 `draining`，没有把 mailbox 恢复为 inactive，也没有保留“所有新消息继续排队”的状态不变量。

## 修复

先补独立 RED：首次 activate reject 后，`2` 仍在队首；handle `3` 不得直接 route；第二次 activate 必须得到 `[1,2,3]`。最小 production 修复是在 drain reject 时令 `active=false` 后原样 rethrow，保留未处理 queue；Root startup catch 仍可 deactivate 清空本 session 队列。

## 验证

运行 route-reject RED、成功顺序、active direct、deactivate、overflow 和完整 runtime/Root Broker suites。额外确认 deactivate 发生在 in-flight route 时会丢弃尚未开始的旧队列，下一 session 消息可正常 activate。
