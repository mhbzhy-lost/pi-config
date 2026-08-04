# Bug：registry goal entry 结构未校验

## 1. 现象

可解析的 `registry.goals.g=[]` 会通过旧校验；append 返回新版本并写入 JSONL/projection，数组仍留在 registry。

## 2. 触发条件

registry 顶层 schema 正确，但 active 索引重复、goal entry 为数组/非普通对象、lifecycle、objective 或 `updatedAt` 非法，或 active 索引与 entry lifecycle 不一致。

## 3. 根因

旧 `validateRegistry` 仅验证顶层 `goals` 是对象，未闭合每个 goal entry 和 active 索引的双向不变量。

## 4. 影响范围

坏结构可与已推进的 event/projection 共存；调用失败前可能产生不可按原 expectedVersion 重试的部分提交。

## 5. 修复方案

写前在同一 writer receipt 下读取并严格验证：schema、非空无重复 active IDs、普通 `goals` 对象、每个普通 entry 的合法 lifecycle、字符串 objective、可解析 `updatedAt`，及 active 双向一致性。校验失败抛 `TypeError`，不修复其他 goal。

## 6. 验证方案

TDD 覆盖 `goals.g=[]` 等 parseable 损坏，断言 JSONL/projection/registry 字节不变、无临时工件、修复后同 expectedVersion 仅追加一次；mutation oracle 还验证 release-before-prepare 被 receipt 门禁杀死。
