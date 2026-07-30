# Root Broker 无订阅时丢失 Lifecycle 与 Supervisor push

## 现象

Root Broker 的 Lifecycle 路径在检查 logical caller 是否存在 live socket 之前，先执行 `entry.delivered.add(...)`。因此 caller 尚未订阅时产生的 Lifecycle 通知被标记为已投递，但实际没有写入 socket。

Supervisor 路径在没有 socket 时只保存 pending request，不保存 push 通知。caller 之后再 `subscribe`，看不到此前产生的 Lifecycle 或 Supervisor 通知。

## 影响

revived caller 或新的 generation 会错过此前的 execution 状态与 Attention，无法获得该 logical caller 已发生的完整通知序列。Lifecycle 提前标记 delivered 还会使后续重复处理被错误抑制。

## 复现

在 Root Broker 尚无该 logical caller 订阅的情况下，依次产生 Lifecycle 通知与 Supervisor push；随后为该 caller 建立 socket 并发送 `subscribe`。此前通知既未进入统一队列，也不会从 pending request 或 delivered 状态恢复，订阅方不可见。

## 根因

实现将 subscriptions 当作 delivery authority：只有 live socket 才被视为可交付目标，脱离订阅期间产生的 push 没有持久化位置。同时 Lifecycle 与 Supervisor 分别处理，缺少按 logical caller 统一排序的 FIFO，导致 pending request 不能承载两类通知，也不能保证产生顺序。

## 修复

Root session 应为每个 logical caller 维护统一 FIFO。不存在 live socket 时，Lifecycle 与 Supervisor push 都进入该 FIFO；Lifecycle 的 queued 状态与 `delivered` 状态分离，只有实际写入时才标记 delivered。Supervisor 也进入同一 FIFO，以保持跨来源通知的产生顺序。`subscribe` ACK 后的 FIFO flush 由 Task61 实现。

## 验证

本任务不运行固定 socket suite。实现变更时应验证：无订阅条件下 Lifecycle 与 Supervisor 按产生顺序进入同一 FIFO；重复 Lifecycle 不重复入队；未实际写入前 `delivered` 保持为空。当前 Task57 仅记录该问题与 FIFO 持久化边界，不修改 tests 或 production。
