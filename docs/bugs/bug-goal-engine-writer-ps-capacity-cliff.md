# Bug：writer 锁同步 ps 轮询造成容量断崖

## 1. 现象

高 fan-in 下不同 goal 的合法 writer 大量 `GOAL_ENGINE_STORE_LOCK_TIMEOUT`，50 路探测曾只完成 38、40、45 路。

## 2. 触发条件

每个竞争者每 10ms 在 writer/guard 等待路径同步启动 `/bin/ps`，并且每次获取 lock/guard 都重复查询自身出生身份。

## 3. 根因

进程启动与同步等待被放在热轮询中，竞争越多越放大阻塞，耗尽固定 1500ms deadline。

## 4. 影响范围

不同 goal 本应仅短暂串行 registry 写入，却会因探测风暴超时；正常 live owner 等待也无谓反复启动 ps。

## 5. 修复方案

本进程出生身份只查询一次并缓存；live identity 探测采用 1400ms freshness 缓存，仍每轮先以 `kill(pid, 0)` 立即识别死亡。缓存只延迟陈旧/PID 重用恢复，身份未知继续 fail closed。`LOCK_TIMEOUT_MS` 保持 1500ms，不以放大超时掩盖问题。

## 6. 验证方案

ready/start barrier 真实启动 50 个不同 goal worker，全部在既有有界 1500ms deadline 内完成，registry 保留 50 项、各 projection 为 v2 且无遗留物；连续多轮与组合回归通过。
