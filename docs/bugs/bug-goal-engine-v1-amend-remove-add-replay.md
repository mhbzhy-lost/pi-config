# v1 同事件 remove→add→update replacement 历史重放失败

## 现象
固定 v1 `events.jsonl` 中，`goal.created(t1 pending)` 后单个 `goal.amended(removeTasks:[t1], addTasks.t1, updateTasks.t1)` 重放失败，报 `task already exists: t1`，而基线 `94654c5^` 重放至 version 2 且描述为 `refined`。

## 影响
合法的历史 replacement 日志无法恢复，v1 投影停在创建事件，导致任务定义及其随后更新字段丢失。

## 复现条件
使用固定 eventId 与 occurredAt 写入两条真实 v1 JSONL 事件；第二条同时移除、重新新增并更新同一 `t1`，然后调用 `loadProjection()`。

## 根因
amendment 预验证在模拟候选变更顺序前，对所有 `addTasks` ID 直接以原 projection 的存在性拒绝，并把所有 remove+update 直接视为冲突，未保留历史的 remove→add→update 顺序。

## 修复方案
预验证按候选顺序判定：原有且在 `removeTasks` 的 ID 可以在同事件 `addTasks` 重新加入；remove+update 只在同 ID 也新增时允许；未移除的已有 ID 仍拒绝重复新增。v2 replacement 先对原任务执行 remove 门禁，只有 pending 且无工作区或 discarded+released 可替换；v1 维持仅 accepted 不可移除的历史语义。

## 防回归
固定 v1 JSONL 断言重放 version=2、replacement 后的 update 字段为 `refined`；覆盖 v2 pending replacement 成功，以及 accepted、active/disposing/applied/preserved/integrated 和未释放工作区 replacement 原子拒绝。保留新增后更新、未知更新、remove+update 无新增、DAG 和 schema downgrade 回归。
