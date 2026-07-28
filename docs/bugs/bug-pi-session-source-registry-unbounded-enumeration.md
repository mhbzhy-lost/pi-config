# Pi Session Source Registry 目录枚举无界增长

## 现象

Pi 会话源目录包含大量条目时，注册表构建会占用异常高的内存和 CPU，严重时可能触发进程内存不足。

## 触发条件

目标目录中存在大量会话 descriptor 文件或其他目录条目，且调用会话源注册表扫描流程。

## 根因

扫描逻辑通过 `readdir` 一次性读取整个目录，随后为所有候选项创建数组并按 mtime 全量排序；候选集合及排序辅助内存随目录 descriptor 总数无界增长。

## 影响

大目录会放大瞬时内存占用和排序 CPU 时间，影响捕获流程稳定性；现有最多 2000 个 descriptor 的校验限制只能限制后续校验数量，不能限制前置候选收集。

## 修复方案

使用 `fs.opendir` 流式枚举目录；仅维护按 mtime 最新的最多 `maxDescriptors` 个候选项，避免完整候选数组与全量排序。保留 owner、type、size、header、mtime 的现有校验语义，以及最多 2000 个 descriptor 的校验上限。

## 验证方案

新增 RED 用例，以远超上限的 descriptor 输入断言候选集合峰值不超过 `maxDescriptors`，并验证最终保留最新 mtime 的条目；实现后运行 registry、capture 与 smoke 回归测试。额外检查暂存区为空。
