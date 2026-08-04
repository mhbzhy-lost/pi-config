# Bug：malformed registry 校验前写入事件日志

## 1. 现象

registry JSON 或结构损坏时，旧 append 可能先写 event/projection；修复 registry 后原 `expectedVersion` 已失效。

## 2. 触发条件

已有 goal 的 `registry.json` 不可解析，或可解析但违反 schema、goal entry 结构或 active 索引一致性，调用方以当前版本 append。

## 3. 根因

registry 的读取、解析和校验发生在 JSONL/projection 发布之后；校验只覆盖顶层，也未在读取边界验证 writer receipt。

## 4. 影响范围

失败调用留下部分提交，registry 与 replay/projection 可不一致，安全重试被破坏。

## 5. 修复方案

在持有同一 writer receipt 时先 replay/version、预计算 registry 并严格验证所有 entry；之后每个 JSONL、projection、registry 持久化阶段再次 gate。错误不自动重建、不推进版本、不修复其他 goal。

## 6. 验证方案

测试 parseable `goals.g=[]`、重复 active ID、非法时间和索引不一致均抛 `TypeError`，三文件字节不变且无临时工件；恢复 registry 后使用相同版本重试，仅产生一条追加。mutation oracle 覆盖 prepare 与三种发布阶段的 release-before-stage。
