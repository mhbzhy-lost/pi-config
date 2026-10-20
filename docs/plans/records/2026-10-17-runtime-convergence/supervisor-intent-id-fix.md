# T24：H1——Host opaque tool-call ID → 内部 intent ID

## 修复

- 新增 `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-intent-id.ts`：`createSupervisorIntentId({ hostToolCallId, kind, rootSessionId, runId })` 返回版本化 `svi1-` + SHA-256 摘要，把身份绑定进摘要而不依赖 Host ID 的字符形态。
- 两处消费点改为派生 ID：steer `extension.ts:1501`、reply `extension.ts:1590`。
- native adapter 仍收到原始 Host tool-call ID，投递语义与幂等键不变；`supervisor-reply-guard.v2` 的持久化/清理由 M1 覆盖（`supervisor-control-plane.ts` 的 `saveRoot()` 与事务重载前清理同 namespace）。

## 证据

- `test/supervisor-gate-wire.test.mjs` 既有 wire 场景迁移为复合 `call_*|fc_*` 后通过（与 footer 联合 59/59，其中 wire 8 项）。
- fresh CLI 真实 ask/managed 两个场景 exit 0：`/tmp/runtime-convergence-fresh-contact-final2.log`；其中 status 在 complete 后读取 receipt，并等待 durable consumed/replied（最多 5 秒），不把 queued 当 consumed。
- root/package typecheck exit 0。

## 边界

- 只证明当前受支持的 Host ID 形态（含 Responses 复合形态）能被稳定转换；未穷举所有 provider 的 ID 形态。
- 历史 R06 个案不回填归因；`pending` 可见仍不等于 delivered/consumed。
