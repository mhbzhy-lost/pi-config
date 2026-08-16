# 行动策略可饿死条件或忽略终态事实

**Bug：** 旧行动前沿会将 stale Condition 误跳过，并把 Observation 的请求、租约、进程恢复、终态与 Current World owned-run 库存混为一谈；这会饿死复验、造成恢复死锁，或在冲突时错误记录/释放。

## 复现

1. 将已满足依赖、无未释放 run 且 claims 可用的 Condition 标为 `stale`。
2. 为 Observation 分别构造 requested、lease_allocated、process_bound、terminal 及 Current World 中同 runId 的 active inventory。
3. 旧策略会跳过 stale，或对缺失 inventory 的请求/租约只 future-wake；terminal run 仍在 inventory 时还会错误提供 record/release。

## 修复方案

实现纯语义行动前沿：stale 以递增 cycle 请求 Observation；请求/租约启动、进程按 inventory 唤醒或恢复；冲突 fail closed。非 active runtime、pending capability 与全局门禁只保留明确安全收债动作；ledger 接受真实 no-progress 连续记录，fingerprint 只保留 active run kind/state 多重集，不使用随机 runId。
