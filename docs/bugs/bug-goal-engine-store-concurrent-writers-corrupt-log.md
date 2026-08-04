# Bug：Goal Engine event store 并发 writer 损坏日志与 projection

## 现象

多个独立 Pi/Node 进程以相同 `expectedVersion` 向同一 state root 写入时，多个调用都返回成功；审计复现中八个进程全部成功。六个 `task.workspace_disposition_started` 同时落盘后，replay 永久报出 already started。

## 影响

JSONL 可能包含 reducer 不可重放的事件序列，`projection.json` 与日志可能不一致；共享 `registry.json` 也可能被固定临时文件的竞争覆盖，导致 Goal Engine 恢复和后续调度不可依赖。

## 复现

先创建 version 为 1 的 goal，再由六个真实独立 Node 进程并发调用 `appendEvent(stateRoot, checkpointEvent, 1)`。无锁实现会让多个进程都在 append 前看到 version 1，随后同时 append；固定 `projection.json.tmp` / `registry.json.tmp` 还可能令 rename 失败或互相覆盖。

## 根因

CAS 的 replay/version check 只在单个进程内执行，未与 JSONL append、projection replace、registry replace 组成跨进程临界区。临时文件名固定，彼此没有调用身份隔离。

## 修复

在 state root 使用 `mkdir` 原子创建 `.writer.lock`，以 owner token/PID 协议串行整个写入事务；存活 owner 有界等待，死亡 PID 的锁原子 quarantine 后清理。projection 和 registry 的临时文件使用本调用唯一身份，release 复核 token 后才删除锁。

## 验证

真实多进程竞争应恰好一个成功，其余为 `PROJECTION_CONFLICT`；另验证存活锁 timeout、死亡锁恢复和旧 owner 不得释放新 owner 锁，竞争后 JSONL、projection、registry 可解析重放且无本调用临时残留。
