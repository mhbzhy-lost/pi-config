# v1 历史 dispatch 重放在依赖未 accepted 时失败

## 现象
固定纯 v1 `events.jsonl` 中，`task.dispatched(t2)` 早于其依赖 t1 被 accepted 时，`loadProjection()` 报依赖未 accepted，无法恢复历史投影。

## 影响
历史日志不能重建 version、任务 attempts、status 和事件 schema 版本，影响 v1 向 v2 的单向升级兼容。

## 复现条件
写入固定 eventId 和 occurredAt 的 v1 JSONL：`goal.created(t1,t2)`、`task.dispatched(t2)`、`task.settled(t2 failed)`、`task.dispatched(t1)`，然后调用 `loadProjection()`。

## 根因
`taskDispatched()` 不区分事件 schema，无条件调用 `assertDepsAccepted()`；该门禁是 v2 DAG 合约，却错误施加给历史 v1 replay。

## 修复方案
仅在 `taskDispatched()` 中按 `schemaVersion` 隔离：v1 保留历史 dispatch 语义；非 v1 继续执行 `assertDepsAccepted()`。投影已有 v2 后仍由单向 schema upgrade 拒绝任何新 v1 事件。

## 防回归
固定 v1 JSONL 断言完整重放状态；v2 同样的 downstream 顺序断言拒绝且投影不变；覆盖 v1 历史升级后的 downgrade，以及 v1 历史上的 v2 dispatch 仍检查未 accepted 依赖。
