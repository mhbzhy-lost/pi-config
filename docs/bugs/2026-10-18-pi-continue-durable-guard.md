# pi -c 恢复已有会话时报 DURABLE_LOCK_HELD

## 现场与来源分类

用户报告：`pi -c` 加载 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 失败，错误 `DURABLE_LOCK_HELD`；直接 `pi` 新会话正常。

生产可达链：`beforeUpstreamSessionStart → supervisorControlPlane.ready(rootSessionId) → transaction → DurableStorage.acquireLock → withLockMutation`。锁 key 为 `supervisor-` 加 rootSessionId 的 SHA-256，恢复同一会话复用同一 key，新会话分配新的 key。

本轮仅投影锁文件类型、大小、修改时间、PID 是否存在及 birth 格式；未读 session、Supervisor state JSON、authority 或凭据正文。发现三个空 `.lock.guard`：

- `supervisor-c44af50e408ede807e40f6abe280890a73d3e01ff7b3deb3252d45d491bda1cb.lock.guard`：同 key 主锁的 PID 28390 已不存在。
- `supervisor-f3ec8129db9a1e87f02e52372d0b5b3d71bd708a225d346267465021d96fafb7.lock.guard`：同 key 主锁的 PID 5312 已不存在。
- `supervisor-3cd2459c064408fafdd93183eceb0e43be2d9ea7cd2104e7fdca9cae49219f97.lock.guard`：无对应主锁。

当前主会话 `PI_SESSION_ID=01a14831-e247-7044-a36d-676dd611aed1` 对应 key 为 `supervisor-59e71ef4e0a3b76960f9752d864d9edb23fbac78ed5ceffd7f8dfdce9bbeb785`，不在上述残留中，因此不能把用户报错会话等同于当前主会话。

## 首个偏离点

`withLockMutation()` 通过 `open(wx)` 创建零字节 guard，然后执行读/建/删主锁。finally 才关闭并 unlink guard。进程在此窗口退出会留下 guard；后续恢复在 open 的 EEXIST 分支立即抛 `DURABLE_LOCK_HELD`，5 秒事务重试结束后失败。guard 没有 owner/PID，不能验证创建进程是否已死亡；主锁 PID 已死亡也不能证明没有另一进程正在操作 guard。

这一路径是合法 production writer 的已知恢复缺口，不是测试制造。用户这次 incident 的精确 key 尚未取得，不能断言就是上述某一个 guard；仍可能存在真实活跃持锁进程。历史记录 `docs/bugs/2026-10-13-durable-lock-restart-owner.md` 已明确把 guard 崩溃窗口保留为 fail-closed 边界。

## 本轮处理

保留 `DURABLE_LOCK_HELD` code，区分主锁仍被 live PID 持有和 mutation guard 已存在，在错误消息中提供锁阶段与 key，避免 extension_error 只剩笼统代码。未新增自动清理、mtime 抢锁、绕过 guard、强制删除或新 fallback。既有测试可以同步调整；不新增测试。

## 当前处理状态

用户已明确要求不再处理本次 `pi -c` 锁阻塞。本分支停止现场恢复，不删除/隔离锁，不继续要求会话 ID。已完成的最小错误信息改进保留为未提交变更；本文仅保存已获证据，不将其写成锁恢复修复完成。

## 下一步

若用户后续重新要求恢复，先取得失败那次报错的精确 key 或会话 ID，结合主锁活性和 guard 事实判断。旧空 guard 缺 owner 不能由源码补元数据恢复出历史身份；需要明确维护窗口和该精确 guard 的隔离决策，保留 Supervisor JSON 与所有其他会话锁。永久自动恢复必须使用具有进程退出释放语义的锁或可证明 owner 的协议；不能用 TTL 或多重 guard 递归声称已解决。
