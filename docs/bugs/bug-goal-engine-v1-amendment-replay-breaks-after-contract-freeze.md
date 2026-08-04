# v1 amendment 历史重放在合同冻结后中断

## 现象
固定纯 v1 历史 `goal.created(t1,t2) → task.dispatched(t1) → task.settled(succeeded) → task.accepted(t1) → goal.amended(update t1 acceptance)` 在 baseline replay 的第五个事件失败，报 `cannot update non-pending task`；replay 停在 version=4。

## 影响
已持久的纯 v1 JSONL 无法重建 projection，历史 accepted 任务的验收定义和 `legacy_unverified` 标记不能恢复，事件存储失去向后兼容性。

## 复现条件
使用 `schemaVersion=goal-engine.event.v1`、固定事件 ID 和时间写入上述五条历史事件后调用 `loadProjection()`，或按同一顺序调用 reducer。

## 根因
94654c5 将 `goal.amended()` 的 pending 且 workspace released 门禁无差别用于所有 schema；调用处未将事件 schemaVersion 传给 reducer，因而把 v2 的新写入安全合同错误施加到 v1 历史重放。

## 修复方案
将 schemaVersion 传入 `goalAmended()`：仅 v1 使用历史 amendment 语义（accepted 可 update，accepted remove 仍拒绝，其他非 accepted 可按旧语义 remove），v2 及后续安全 schema 保持严格 pending + released gate，并持续验证候选 DAG。

## 防回归
固定 JSONL/store replay 断言 v1 version=5、accepted 与 `legacy_unverified`；固定 v2 accepted amendment 断言拒绝且 projection、version 和任务证明不变；现有 Extension accepted/active workspace 资源保留回归继续执行。
