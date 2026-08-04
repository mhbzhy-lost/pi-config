# Bug：Goal Engine writer lock owner 发布窗口会永久阻塞 store

## 现象

协调器黑盒探针预置没有 `owner.json` 的 `.writer.lock` 后调用 `appendEvent`，约 501ms 抛出 `GOAL_ENGINE_STORE_LOCK_TIMEOUT`，且 lock 目录仍存在。

## 影响

任意进程若在创建最终 lock 目录后、发布 owner 元数据前崩溃，会让同一 state root 的后续事件永久无法写入，直到人工删除目录。

## 复现

创建 version 为 1 的 goal；在 state root 手工创建空 `.writer.lock`（或写入损坏的 `owner.json`）；再以 expectedVersion 1 调用 `appendEvent`。旧实现持续等待至 timeout，事件未追加且锁残留。

## 根因

旧获取流程先以 `mkdir(.writer.lock)` 发布最终目录，随后才写 `owner.json`。这两个步骤之间可崩溃；`readLockOwner()` 对缺失或损坏元数据返回 null，但竞争分支只隔离已解析且 PID 死亡的 owner。

## 修复

在 state root 内先创建本调用唯一 candidate 目录，写完并设置 `0700` 目录和 `0600` owner.json 后，单次原子 rename 发布为 `.writer.lock`。缺失或损坏的最终 owner 属于不可能由新协议产生的残留，原子 quarantine 后删除；竞争失败只清理本调用 candidate。

## 验证

空和损坏 owner lock 都能恢复并成功追加事件，state root 与 goal 目录没有 `.tmp`、candidate 或 quarantine 残留；真实并发仍恰好一方成功，存活 owner 仍 timeout 且不被删除。
