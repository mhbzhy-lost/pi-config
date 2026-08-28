# Goal runtime proof-loss requires typed abandon_runtime

## 问题记录（2026-08-25，Task 6 真实首次尝试）

合法 public `goal_amend(abandon_runtime)` 已到达 handler，Store/Host preserve 已成功；首个偏离点是 `runtime_abandoned` reducer 将 40 位 Git head 误用为 64 位 SHA-256 hash，导致事件 append 拒绝。该缺陷 production 可达，且首次尝试可能已幂等地 preserve managed workspace；Goal ledger 未追加（version 保持 28）。不得掩盖这一 preserve side effect 或把它描述成 terminal proof。

**当前第二个 production 首偏离点（2026-08-25，Task 6 真实第二次尝试）：真实 Store/Host preserve 幂等成功，ledger version 仍为 58，但 `runtime_abandoned` append 被 reducer 拒绝；原因是 managed `receipt.disposition` 为 `{state,reason}` 对象，`preservationReceipt.material.manifest.disposition` 未归一化为 `state` 字符串。该偏离点不得掩盖。**

当前 projection 是 `suspended/ready`，closure 有三个 blocker：

1. terminal proof 缺失（运行终止事实不可验证）；
2. workspace closure proof 缺失（managed workspace/lease 的保留事实需要重新检查）；
3. resource closure proof 缺失（资源 owner 的 closure 事实不可验证）。

首个偏离点是 suspension 之后执行器的持久 sidecar/asyncDir 证据丢失，而本次 abandon 失败的直接根因是上述 reducer proof schema 类型错误，不是 dispatch、binding 或 preserve 失败。production 分类为第 1 类：terminal proof / sidecar 永久丢失（proof-loss），必须 fail-closed。此记录只允许安全 preserve 外部 managed workspace/resource，不释放、删除、discard 或伪造 terminal proof；在任何活动进程、pending decision、world 漂移或无法安全 preserve 时保持 blocked。

## 根因分析

frontier 的职责是依据 Store projection 与 CurrentWorld 的安全事实签发
`abandon_runtime` 意图；workspace/lease 是否可保留不能从 projection 猜测，必须由
Extension handler 通过真实 Store lease 与 Host workspace inspection 做 exact preflight。
此前将 workspace 字段存在性作为 frontier 的额外门禁，会把可签发的恢复意图错误地变成
不可见状态，且无法替代 handler 的 preserve fence。

`runtimeAbandoned` 的 preserve receipt 同时包含 Git executor/manifest head（40 位 SHA-1）和 owner CAS、receipt hash、reason digest（64 位 SHA-256）。旧校验器把前者交给 SHA-256 校验，导致合法 preserve receipt 在 append 阶段被拒绝；修复仅调整 schema 类型边界和 manifest identity 校验，不在 append 失败后 discard、delete 或 rollback。
