# Bug：registry 更新锁边界未被机械验证

## 1. 现象

仅有 registry publish 的旧测试；将 prepare/read、JSONL append 或 projection publish 移到 release 后，边界没有生产门禁可证明失败。

## 2. 触发条件

writer receipt 已释放、缺失、陈旧，或 `.writer.lock` owner 是 legacy/malformed 协议时，任何 append 阶段仍继续执行。

## 3. 根因

旧实现只在 registry 最终发布处比较 token，且未要求 owner 是 v2 完整 owner；其余持久化阶段未显式绑定 receipt。

## 4. 影响范围

锁外读改写或部分写入可静默发生，shared registry 与 event/projection 的一致性依赖调度概率。

## 5. 修复方案

统一 `assertWriterLockOwned(stateRoot, token)`：只接受合法 v2 owner 且精确 token，其他情况稳定抛 `GOAL_ENGINE_STORE_LOCK_LOST`。append 在 replay/version、registry prepare、JSONL、projection 和 registry publish 边界复核同一 receipt。

## 6. 验证方案

隔离源码 mutant 对四个 release-before-stage 替换逐一机械确认一次，再运行一致性 probe；四者均无法成功 append（prepare 无写入，后续阶段暴露部分写入）并被稳定 kill。此证明仅覆盖进程内 receipt 边界，不声称跨文件断电原子性。
