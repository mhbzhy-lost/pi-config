# P4 canary 静态合同修复

- 日期：2026-09-09
- 任务：`goal-f4-canary-static-contracts-retry`（`dispatch-ir.v1`）
- 范围：仅 local fixture/harness；不调用真实 RPC、model 或 provider。

## RED → GREEN

1. `attempts`/`attempt_id` 与 canonical `attempt` 漂移：fixture 先拒绝非正整数或非 canonical 字段，随后统一使用当前 attempt。
2. 两轮 identity：每轮由当前 fixture Host 发行全新的 root/session/goal/run/token/approval/workspace；重复 session、token 或 approval 均 fail closed，不复用上一轮。
3. 事件合同：R13 ledger 断言要求 managed workspace disposition intent/receipt 与 `goal.final_review_started`/recorded；不再以 legacy workspace disposition event 作为成功证据。
4. 失败诊断：tool error、重复/missing attempt 和后置断言失败都携带递归脱敏 diagnostic 与 phase timeline，并由 owner 目录保存；agent 目录清理不会丢失 owner evidence。

## 上一轮 provenance

上一轮真实 R13 round 1 的首个偏离点是 root model 通过合法 RPC Host 调用 `goal_init` 后返回 tool error，随后出现 retry；现有 exactly-one attempt 合同因此 fail closed。由于没有足够的合法 args/typed evidence，来源保持 `unknown`，未伪装成 production success，也未继续 round 2。

## 验证边界

默认 real gate 仍 skip。local canary 必须全绿；typecheck 与 `git diff --check` 作为验收证据。禁止 `git add`、`git commit` 及读取凭据。
