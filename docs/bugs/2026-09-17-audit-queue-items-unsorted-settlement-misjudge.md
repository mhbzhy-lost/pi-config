# 2026-09-17 管理审计的 queue items 顺序不确定导致 settlement 误判

## 现象

R8 双 child 真实验收中，两个 queue item 均 completed、workspace 均 released，但 `isAcceptanceAuditSettled` 永远返回 false，settlement 超时。诊断显示 audit 的 `queue.items` 顺序为 `[sequence=2, sequence=1]`（目录顺序）。

## 根因

`auditManagedWorkspaces`（`packages/pi-subagents-enhanced/src/workspace/administration.ts`）按 `readdirSync` 顺序收集 queue item 文件（APFS 下接近随机）；`isAcceptanceAuditSettled` 的 FIFO 校验要求 `sequence` 严格递增，隐含“items 已按 sequence 排序”的前提。单 child 验收（1 个 item）从未暴露该顺序依赖；多 item 审计按目录顺序投喂时随机失败。

## 修复

audit 在返回前按 `sequence` 排序 queue items（确定性公共投影，settlement 不依赖目录顺序）。RED/GREEN：
- `test/managed-workspace-administration.test.mjs` 新增排序断言（5/5）；
- R8 queued 场景（两 item）由间歇失败转为稳定通过（4/4 × 3 次）。

## 分类

预期 production 数据未被正确处理（类别 1）：多 item queue 是合法 public 入口可达状态，审计投影必须确定性。
