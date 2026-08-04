# Bug：registry 更新锁边界未被机械验证

## 1. 现象

仅有 registry publish 的旧测试；将 prepare/read、JSONL append 或 projection publish 移到 release 后，边界没有生产门禁可证明失败。

## 2. 触发条件

writer receipt 已释放、缺失、陈旧，或 `.writer.lock` owner 是 legacy/malformed 协议时，任何 append 阶段仍继续执行。

## 3. 根因

旧实现把 `assertWriterLockOwned` 与 replay/version read、JSONL append、projection tmp+rename 放成可分离的相邻语句；source mutant 可在 assert 后、IO 前 release token。旧 oracle 又把 JSONL/projection/registry 的 partial write 当作“后续阶段会暴露”的 kill 条件，因而错误接受越界写入。

## 4. 影响范围

锁外读改写或部分写入可静默发生，shared registry 与 event/projection 的一致性依赖调度概率。

## 5. 修复方案

统一 `assertWriterLockOwned(stateRoot, token)`：只接受合法 v2 owner 且精确 token，其他情况稳定抛 `GOAL_ENGINE_STORE_LOCK_LOST`。将 replay/version read、JSONL append、projection tmp+rename、registry publish 分别封装为内部 boundary function，并在每个函数第一步复核同一 receipt；prepare 也保留内部校验。

## 6. 验证方案

隔离源码 mutant 对 replay/version、prepare、JSONL、projection、registry 五个 release-before-boundary 替换逐一机械确认一次，再运行一致性 probe；五者均在阶段副作用前抛 `GOAL_ENGINE_STORE_LOCK_LOST`，events/projection/registry 全部字节不变；统一 stage marker 也不得到达。projection 和 registry mutant 仅为隔离目标而跳过先前阶段，不声称跨文件 WAL 或断电原子性。
