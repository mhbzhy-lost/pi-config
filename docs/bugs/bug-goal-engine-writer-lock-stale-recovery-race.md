# Goal Engine writer lock stale recovery 竞态

## 1. 现象

coordinator 连续执行 20 轮 Goal Engine 并发压力测试时，首轮多进程 acquire/stale quarantine/release 竞争出现一个 worker `code=ENOTEMPTY`；其余失败 worker 为 `PROJECTION_CONFLICT`。

## 2. 触发条件

多个 worker 同时取得同一 state root，且已有 missing、malformed 或 dead owner 的 `.writer.lock`。旧协议在没有共同恢复互斥的情况下观察 owner 后，将主锁 rename 到各自的 quarantine 路径，同时其他 worker 可以发布 replacement lock 或 release。

## 3. 根因

stale observe、quarantine rename、replacement publish 和 token release 没有由同一 state-root 短时 guard 串行。观察到旧 lock 的进程可在 rename 前被其他进程穿插，随后对 replacement 执行 rename，目录非空时泄漏 `ENOTEMPTY`，并形成 ABA 窗口。

## 4. 影响范围

并发 loser 本应得到 `PROJECTION_CONFLICT`（或按合同等待），却暴露底层 `ENOTEMPTY/EEXIST`。极端时 lock 元数据及清理残留会破坏单 writer 保证；JSONL、projection 和 registry 的一致性也可能受影响。

## 5. 修复方案

主锁 acquire/publish、stale cleanup/quarantine 与 token-checked release 一律先持 state-root recovery guard。guard 使用原子 no-clobber 创建、有限 deadline 和 owner token 校验释放；guard 超时 fail closed，且不自动抢占无法证明 stale 的 guard。guard 仅涵盖 lock 元数据操作，event append、projection 和 registry 写事务仍只由 writer lock 保护。

## 非目标

malformed registry 会在 event/projection 写入后才失败是独立原子性问题，本次只记录，不改变其行为；由 coordinator 另行按 bug-first 流程处理。

## 6. 验证方案

新增多轮、多 worker stale-owner 并发测试，逐 worker 保留 `code/message`，每轮断言恰有一个成功，其余仅 `PROJECTION_CONFLICT`，不得出现 `ENOTEMPTY/EEXIST`；重放 event log/projection/registry，并检查 candidate、quarantine、guard 与 tmp 无残留。保留 missing、malformed、dead 和 live owner 回归，并执行 20 轮压力命令。
