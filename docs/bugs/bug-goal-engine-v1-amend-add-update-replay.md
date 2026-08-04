# v1 同事件新增后更新任务的历史重放失败

## 现象
固定 v1 `events.jsonl` 中，`goal.created(t1)` 后单个 `goal.amended(addTasks.t2, updateTasks.t2)` 无法重放，`loadProjection()` 在第二个事件报 `unknown task: t2`。

## 影响
历史日志不能恢复到 version 2，新增任务的修订描述、依赖、写路径或验收定义丢失，破坏 v1 向后兼容。

## 复现条件
以固定 eventId 和 occurredAt 追加上述两条真实 v1 JSONL 事件，再调用 `loadProjection(root, goalId)`；同一 amendment 的 `updateTasks` 指向本事件 `addTasks` 的未删除任务。

## 根因
`goalAmended()` 在构造 candidate Map 前，对所有 `updateTasks` 目标调用原 projection 的 `requireTask()`。因此候选中本应新增的 t2 被提前判为未知任务。

## 修复方案
预验证只对原 projection 已有任务执行 schema 对应的 update 冻结门禁；同时预先拒绝未知目标及 remove/update 冲突。随后在 candidate 中 add、update 并验证 DAG，令本事件新增且未删除的任务可被更新，最后一次性替换 projection。

## 防回归
固定真实 v1 JSONL 断言 version=2 和 t2 更新字段；覆盖 v2 同事件 add+update 也按 candidate 语义成功，并保留既有 v2 已执行或未释放任务拒绝、未知目标、remove/update 冲突和 DAG 失败原子性的回归测试。
