# R4 状态证据账本在重放时丢失权威摘要

- **问题描述：** `condition.observation_recorded` 仅持久化 run 与 evidence ID，真实 runtime 事件重放后缺少 R5 判定新鲜度、稳定窗口和任务失效所需的证据身份及 mutation 事实，必然被判为 stale。
- **复现步骤：** 创建 runtime draft，按 Observation 生命周期记录通过证据后重放事件；将重放 projection 交给 `evaluateConditionGraph()`，其 `evidenceHistory` 只有 ID，无法比对 revision、合同、条件、世界、环境和运行终态。
- **修复方案：** 将 Host 派生的 canonical evidence summary 与 verdict 写入 observation 事件，并由 reducer 派生严格 sequence、mutationSequence 和 task mutation facts；Finding 仅可引用账本中的 failed evidence 与其派生 fingerprint；快照完整序列化这些字段。
