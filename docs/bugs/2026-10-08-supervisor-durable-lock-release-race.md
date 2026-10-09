# supervisor durable lock 释放窗口被误判为 lock 读取失败

## 现象

主仓 Pi `1.0.2` 合回后的全量 Node 26 回归中，现有测试 `test/supervisor-consumption.test.mjs` 的两个 fresh plane 并发公开操作失败：

```text
ENOENT: no such file or directory, stat .../supervisor-<digest>.lock
```

同一进程内两个独立 `createSupervisorControlPlane({ persistenceRoot })` 实例合法共享同一 root，并发执行 `registerSupervisorRequest` 和 `commitDelivery`。

## 数据来源与首个偏离点

- 权威入口：`supervisor-control-plane.ts` 的公开 `registerSupervisorRequest/commitDelivery`，经 `transaction` 使用 `DurableStorage.acquireLock`；存储实现为 `durable-storage.ts`。
- 资源事实：两个 fresh plane 使用同一临时 persistence root、各自通过公开API注册/提交；不是手工 append projection/event，也不是非法时间或缺字段数据。
- 调用链：`registerSupervisorRequest → transaction → DurableStorage.acquireLock → writeFile(lock,{flag:"wx"})`；竞争方遇到 `EEXIST` 后读取 lock 的 `stat`；持有者在此窗口释放 lock，竞争方的 `stat(lock)` 得到 `ENOENT`。
- 首个偏离点：`acquireLock` 对 `EEXIST` 后的瞬时 `ENOENT` 直接抛出，而不是回到既有 deadline 内重新尝试抢锁。
- stale lock 的 quarantine、owner校验与 `DURABLE_LOCK_UNPROVEN` 约束不应被放宽；只处理精确的“竞争持有者刚释放”的 ENOENT 窗口。

## 分类

**分类 1：预期 production 数据未被正确处理。** supervisor 的持久化公开入口设计上支持多个 fresh plane 同 root 并发，现有测试正验证该 production 合同。

## RED 证据

- 全量回归：`/tmp/pi-102-subagents075.ye2_0hoh/evidence/main-post-merge-full-26.8.1-v3.log`。
- 测试：`test/supervisor-consumption.test.mjs:31`。
- 错误首点在 `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts:28` 的 `stat(lock)`，不是 state digest 或 owner/request identity。

## 最小修复边界

在 `acquireLock` 的 EEXIST 分支加入以 staleLockMs 设定截止时间的短暂 ENOENT 重试；若 deadline 到期、stat成功且锁仍新鲜，仍返回 `DURABLE_LOCK_HELD`；若锁 stale，仍只通过现有 quarantine流程；其他错误继续原样失败。修复后重跑并发测试及全量回归。
