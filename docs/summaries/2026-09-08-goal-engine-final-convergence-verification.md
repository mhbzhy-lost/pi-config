
## P4 静态合同修复（2026-09-09）

本次仅修复 `test/goal-runtime-real-canary.integration.mjs` 的 local fixture 合同：统一 `attempt` 字段，增加当前 Host 每轮独立发行 identity（含 token/approval），以 canonical managed-workspace receipt/intent 和 final-review intent 替代 legacy workspace event 作为 R13 ledger 证据；tool error、重复 attempt 与后置断言失败均保留递归脱敏诊断及阶段 timeline。默认真实 gate 继续 skip，未调用真实 RPC/model/provider。

上一轮真实 R13 round 1 的 provenance 仍准确标记为 unknown：合法 RPC Host 的 `goal_init` 首次 tool error 后发生 retry，但当时实际 args/typed evidence 不足；因此 exactly-one 合同 fail closed，未运行第二轮，也未将 unknown 伪装成 production 结果。
