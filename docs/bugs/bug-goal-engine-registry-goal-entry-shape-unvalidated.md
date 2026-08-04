# Bug：registry goal entry 结构未校验

## 1. 现象

可解析的 `registry.goals.g=[]` 曾会通过旧校验；此外 `active_goal_ids=['concurrent-goal','phantom']` 中没有对应 `goals.phantom` entry 也会通过。append 会返回新版本并写入 JSONL/projection，坏索引仍留在 registry。

## 2. 触发条件

registry 顶层 schema 正确，但 active 索引重复、goal entry 为数组/非普通对象、lifecycle、objective 或 `updatedAt` 非法，或 active 索引与 entry lifecycle 不一致。

## 3. 根因

旧 `validateRegistry` 仅从 `goals` entries 遍历到 active 索引，未反向遍历 `active_goal_ids` 并以 `Object.hasOwn` 验证其确有自有 entry；因此 phantom ID 漏检。

## 4. 影响范围

坏结构可与已推进的 event/projection 共存；调用失败前可能产生不可按原 expectedVersion 重试的部分提交。

## 5. 修复方案

写前在同一 writer receipt 下读取并严格验证：schema、非空无重复 active IDs、普通 `goals` 对象、每个普通 entry 的合法 lifecycle、字符串 objective、可解析 `updatedAt`，及 active 双向一致性。校验失败抛 `TypeError`，不修复其他 goal。

## 6. 验证方案

TDD 覆盖 `goals.g=[]`、`active_goal_ids=['concurrent-goal','phantom']` 等 parseable 损坏，断言 JSONL/projection/registry 字节不变、无临时工件、修复后同 expectedVersion 仅追加一次；mutation oracle 还验证 release-before-prepare 被 receipt 门禁杀死。
