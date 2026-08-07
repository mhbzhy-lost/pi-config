# Goal Engine 多事件 mutation 可能部分提交

## 1. 预期行为

reopen、supersede 等由多个 domain event 组成的 mutation 应作为一个 CAS 批次持久化；故障后的权威 `events.jsonl` 只能是提交前完整日志或包含全部 inner event 的完整日志。

## 2. 实际行为

store 只有单事件 `appendEvent`，调用方连续追加多个事件时，每一行都会分别可见；进程在中间失败会留下语义不完整的事件前缀。

## 3. 稳定复现

先追加批次的第一个合法事件，再在第二次单事件追加前中断；重放会看到第一个事件而看不到后续必须共同出现的事件。

## 4. 根因

权威日志使用逐行追加，CAS 与 reducer 校验只覆盖单个 event，没有在写入前预演整个 mutation，也没有以同目录完整临时日志和原子重命名发布批次。

## 5. 影响范围

恢复和 replay 会把语义前缀当作权威状态，projection 与 registry 的派生快照也可能与调用方期待的 lifecycle mutation 不一致。

## 6. 修复与验证

新增 `appendEventBatch(stateRoot, events, expectedVersion)`：锁内从批次起始 version 重放并顺序预演所有 event，再以完整临时 JSONL 原子重命名发布。测试覆盖无效 inner event 零写入、重命名前失败保留旧日志、重命名后派生发布失败仍可重放完整批次。
