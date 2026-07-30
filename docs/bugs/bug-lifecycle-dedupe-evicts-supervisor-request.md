# Bug：lifecycle 去重淘汰 Supervisor exactly-once 证据

## 症状

Root-owned child extension 用同一个有界 `dedupe` Set 记录 Supervisor request 与 execution lifecycle push。Supervisor request `R1` 被记录后，只要足够多无关 lifecycle key 进入集合，FIFO 淘汰就会移除 `R1`；相同 `R1` 重放时再次生成 Plan Attention。

## 影响

同一 native requestId 可在一个 Plan Runner session 中形成两次 Attention，后续 authorize/result 可能面对重复决策入口。默认上限 1024 只推迟问题，长会话、密集 lifecycle 或订阅边界重放都可触发。

## 复现

以 `lifecycleDedupeLimit=2` 安装 root-owned extension，依次输入 Supervisor `R1`、两个不同 lifecycle push、再输入 `R1`。共享集合在第二个 lifecycle push 后淘汰 Supervisor key，第二次 `R1` 再次调用 `pi.sendMessage`。现有测试仅覆盖相邻 Supervisor duplicate 和 lifecycle 自身淘汰，没有组合两类流量。

## 根因

实现把不同语义的去重生命周期合并：lifecycle 事实只需有限窗口抑制重复通知；Supervisor requestId 是 session 内一次性 Attention 身份，不能被无关 lifecycle 流量释放。

## 修复

先补独立 RED，证明小 lifecycle limit 下经过 lifecycle churn 后重放 `R1` 仍只有一条 Supervisor Attention。随后使用独立 session-lifetime Supervisor requestId Set；lifecycle 继续保留现有有界 FIFO Set。dispose 时随 extension 实例释放，不引入跨 Root 持久化。

## 验证

运行新组合测试、现有 lifecycle eviction、Supervisor duplicate 和完整 adapter/Root Broker/Capsule suites，确认 Supervisor 只发送一次、lifecycle 事件与 follow-up 数量不变、内存仅随当前 session extension 生命周期存在。
