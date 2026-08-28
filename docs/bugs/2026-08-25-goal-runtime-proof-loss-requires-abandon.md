# Goal runtime proof-loss requires typed abandon_runtime

## 问题记录（2026-08-25）

当前 Goal 只能通过合法的 dispatch/binding/suspension 链路推进：`goal_dispatch` 创建执行工作区与 lease，Root Broker 产生 executor binding，运行时暂停由 `goal.runtime_suspended` 固化 suspension identity、affected task/run 与 quarantine 状态。暂停恢复必须由 `goal_amend` 的 `resume_runtime` 消费当前 session 最新 action token，并要求完整 closure。

本实例来自测试流程遗留，不是新的生产执行。旧 run 的 `asyncDir` 与 sidecar 均为 `ENOENT`，因此既没有可验证 terminal proof，也不能把 proof 缺失解释为进程已经停止。

当前 projection 是 `suspended/ready`，closure 有三个 blocker：

1. terminal proof 缺失（运行终止事实不可验证）；
2. workspace closure proof 缺失（managed workspace/lease 的保留事实需要重新检查）；
3. resource closure proof 缺失（资源 owner 的 closure 事实不可验证）。

首个偏离点是 suspension 之后执行器的持久 sidecar/asyncDir 证据丢失，而不是 Goal dispatch 或 binding 合法性失败。production 分类为第 1 类：terminal proof / sidecar 永久丢失（proof-loss），必须 fail-closed。此记录只允许安全 preserve 外部 managed workspace/resource，不释放、删除、discard 或伪造 terminal proof；在任何活动进程、pending decision、world 漂移或无法安全 preserve 时保持 blocked。

## 根因分析

frontier 的职责是依据 Store projection 与 CurrentWorld 的安全事实签发
`abandon_runtime` 意图；workspace/lease 是否可保留不能从 projection 猜测，必须由
Extension handler 通过真实 Store lease 与 Host workspace inspection 做 exact preflight。
此前将 workspace 字段存在性作为 frontier 的额外门禁，会把可签发的恢复意图错误地变成
不可见状态，且无法替代 handler 的 preserve fence。
