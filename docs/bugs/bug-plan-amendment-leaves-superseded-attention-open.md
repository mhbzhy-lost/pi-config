# Bug: superseded Attempt 遗留未关闭的 blocking Attention

## 症状
`plan.amended` 会把受影响的 `waiting-attention` Attempt 改为 `supersede-requested`，但保留其 Attention 的 pending/escalated 状态。

## 影响
该 Supervisor request 永久显示未解决；Attempt 已不再允许 reply，恢复与状态 UI 却仍看到 blocking Attention，无法区分真实待决请求和被 revision 淘汰的请求。

## 复现
构造两个受影响 Attempt，其中一个有 resolved amendment request，另一个处于 waiting-attention；提交 amendment 后检查后者 `attempt.attention.status`，仍为 pending/escalated。

## 根因
amendment reducer 只推进 Attempt lifecycle，没有把 Attention lifecycle 作为同一原子 supersede 投影的一部分。

## 修复
`plan.amended` 对 supersededFromStatus=waiting-attention 且未 resolved 的 blocking Attention 原子写入 `status:"superseded"` 与 `supersededByRevision`；保留 request identity/evidence，不生成 resolution 或伪造 Supervisor reply。

## 验证
新增双 Attempt RED/GREEN；断言 amendment 后旧 Attention 有显式 superseded closure、reply reducer 拒绝、replay 稳定，resolved source Attention 不被改写。
