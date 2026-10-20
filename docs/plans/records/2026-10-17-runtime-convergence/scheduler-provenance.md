# Scheduler 共享存储并发归因

## 当前结论

pinned `@amaster.ai/pi-task-scheduler` 0.1.9 的共享 store/lock 算法存在 production 可达缺陷；本轮静态复核上游公开实现，不运行用户真实 scheduler，也不修改 node_modules。已知缺陷不等于用户当前已发生过并发事故。

## 什么情况下共享

`extension.js` 在 session_start 取 `getSessionId()`，计算 storageKey，构造同一 dataDir 中的 `tasks-<storageKey>.json` 和 `scheduler-<storageKey>.lock`。本仓 adapter 的 dataDir 还按 repository identity 分区。

- 两个 Host 同时恢复同一个 session 且落在同一 repository/dataDir：会命中同一 store/lock，具有竞争前提。
- 同进程存在重叠旧/新 scheduler 实例且保留同一 session：同样可能命中相同文件，但本次没有证明当前 lifecycle 一定产生这一重叠。
- 不同 session 正常新建：不同 storageKey，通常不共享任务文件。
- 同一 Host 内多个计划任务同时到期：业务执行并发不等于双 store 写竞争，不能仅凭多个任务就认定此缺陷触发。
- session-owner 门禁阻止两个受控 Host 同时恢复同一 session（用户已确认该前置阻断成立），因此本批不再围绕“双 Host 同 session”这一已被阻断的拓扑设计修复；这不声称 store 自身获得跨实例一致性，也不证明非受控入口可达性已全部覆盖。

## 首个偏离点与后果

1. `JsonScheduledTaskStore.load()` 使用 loaded 标记只加载一次，每实例有独立 Map。B 删除任务 X 后，A 的 Map 仍含 X。
2. mutator 经 updateState 无条件整文件 save，无跨实例 CAS/合并。A 对另一任务的写入可以把 X 写回，两个实例修改不同任务也会互相覆盖。
3. `FileSchedulerLock.acquire()` 先读 holder，随后 unlink 再 wx 建锁。两个进程都先读到无锁时，后一个可 unlink 前一个刚建的锁，双方均返回 acquired。
4. 同 PID 被允许重新建锁，EPERM/坏元数据活性结果也存在误判边界，不能将它当作可靠跨进程互斥原语。

这是公开正常方法和资源顺序产生的算法缺陷，不需要畸形 fixture。历史同 PID 双实例证据只证明 store 算法，不冒充真实双 Host 实验。用户“其它会话删后残留触发”的具体个案仍缺同次 task/Host/store 证据，保持未归因。

## 当前处理与用户裁决

保留 R04 的未修复状态和上游 owner。未增加本仓第二调度器/静默 fallback/TTL 抢锁，也不把只读 activity observer 当作修复。

用户后续裁决（本轮生效，取代此前“未裁决”表述）：

- scheduler 并发**移出本批活跃修复**，只作为上游实现限制留账；本批不新增 store/锁实现，也不做双 Host 验证。
- 双 Host 恢复同 session 已被 session-owner 前置阻断，不围绕该未证拓扑过度设计。
- 完整任务 replace 语义、损坏 JSON fail-closed、legacy `tasks.json` 迁移与上游 execute 拒绝处理仍是上游 owner 的开放产品语义；在用户另行立项前不擅自选定兼容行为。

来源：`docs/bugs/2026-10-13-scheduler-store-concurrency.md`、上游 `dist/stores.js` 和 `dist/extension.js`、本仓 `src/task-scheduler/adapter.ts`。
