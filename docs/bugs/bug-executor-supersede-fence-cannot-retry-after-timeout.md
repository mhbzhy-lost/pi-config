# Bug: Executor supersede fence timeout 后不可重试

## 症状
`backend.supersede()` 首次 timeout 后永久缓存 rejected promise；late start 虽会触发 stop，但后续 supersede 仍立即返回旧错误。dispose 或 late stop 的未消费 rejection 还可能成为 unhandled rejection。

## 影响
恢复循环无法在 authoritative terminal artifact 稳定后提交 `attempt.superseded`；进程可能因未处理 Promise rejection 异常退出。构造期 mixed-session bindings 也可能绕过单 session 约束。

## 复现
让 unbound supersede timeout，随后发送 matching start 并提供 stopped artifact，再次调用 supersede；当前仍返回 `EXECUTION_DISPATCH_UNCERTAIN`。对无 supersede waiter 的 unbound entry dispose 或让 late stop reject，可观察 unhandled rejection。

## 根因
transport cancel intent、一次调用 promise 和可重试 proof acquisition 被合并在同一永久缓存；deferred 生命周期没有显式 consumed 标记；constructor 只采用第一条 binding 的 session，并把“预期 session”误当成“已完成 capability negotiation”。

## 修复
保留 cancelling fence，但失败后清除 per-call supersede promise供重试；并发调用仍共享当前 promise。stop failure 可重试且后台 rejection 被消费/发布 violation。dispose 安全结算 waiter；所有 recovered bindings 统一 session；独立记录 capability negotiation 完成状态；supersede input exact。

## 验证
新增 timeout-late-start-retry GREEN、terminal artifact 后成功 proof、stop retry、dispose 无 unhandledRejection、mixed-session constructor 拒绝、extra input 拒绝；既有 reply/event race 回归通过。
