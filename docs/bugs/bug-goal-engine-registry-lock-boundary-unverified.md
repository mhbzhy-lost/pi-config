# Bug：registry 更新锁边界未被验证

## 1. 现象

reviewer 将 `appendEvent` 内的 `updateRegistry` 移到 `releaseWriterLock` 后，既有并发测试仍全部通过。

## 2. 触发条件

多个不同 goal 的 writer 在各自 event/projection 已完成后并发更新共享 `registry.json`，而 registry 更新不再持有 writer lock。

## 3. 根因

旧测试只断言最终 goal ID 和 projection version；它没有在 registry 写入生产边界验证当前 writer receipt，因而只能概率性暴露 lost update，不能机械证明调用仍在锁内。

## 4. 影响范围

共享 registry 的 read-modify-write 可被并发覆盖，active goal 索引和 goal 元数据丢失，同时错误调用可能静默返回成功。

## 5. 修复方案

`updateRegistry` 在实际读写边界复核当前 `.writer.lock` 的 owner token；锁缺失或 token 不匹配时 fail closed 并抛稳定 `GOAL_ENGINE_STORE_LOCK_LOST`。`appendEvent` 将 receipt 传入该生产内部契约，因此把调用移到 release 之后会稳定失败。

## 6. 验证方案

覆盖无有效 writer receipt 的 registry 边界必须返回稳定锁丢失 code，并保留不同 goal 并发 registry 回归；对 release-before-registry 的 mutation，调用边界检查应使目标测试稳定失败，而非依赖概率性 lost update。
