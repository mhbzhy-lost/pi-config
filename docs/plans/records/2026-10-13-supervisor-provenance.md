# V1 supervisor 消费字段增量记录（统一计划 2026-10-13）

- taskId: V1（supervisor消费字段增量）
- status: **blocked-evidence**
- date: 2026-10-13
- contract: dispatch-cb06ce2f（统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md`，B 基线通过）
- inputs: `docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`、`docs/plans/records/2026-10-11-runtime-followups/supervisor-provenance.json`、`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-consumption.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- sourceClass: **unconfirmed**；evidenceMode: **static**
- 边界：本记录为纯静态证据，未运行 test/typecheck/Host/provider/网络；未读 settings/models/auth/credential/实际 session/authority/state；未修改 gate，未 poll pending，未执行任何 steer/resume/stop。

## 1. 字段级事实 known/unknown

未取得任何新的字段级样本；下表 `known` 项均为静态代码合同，`unknown` 项在现有证据源（bug 文档、历史 JSON）中无实际值。

| 字段 | known（静态合同） | unknown（无样本） |
|---|---|---|
| requestId | 上游 native `id` 必为 string，注册时经 `safeId` 校验（`/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/`），作为 durable request 主键之一（control-plane.ts:176-184）；reply 以 `params.replyTo` 经 `findRequestAsync` 查找（extension.ts:1270） | M01/M05A/M05B/M07 各样本的实际 requestId 值；登记与调用的实际时间戳 |
| runId | `native.runId` 必为 string 且须与 owner receipt.runId 一致，否则 blocked（control-plane.ts:165-172） | 各样本实际 runId |
| replyTo | reply 意图的 `requestId` 即 `params.replyTo`，须匹配 pending request 的 requestId+requestGeneration（control-plane.ts:195-204）；缺失/不匹配返回 `SUPERVISOR_REQUEST_NOT_PENDING` | M01 曾误抄一个字符的实际值；M05A/M05B 两次 replyTo 的实际值 |
| index（childIndex） | correlation.childIndex 须为安全整数 ≥0，来自 `native.childIndex`，用于定位 `status.steps[childIndex]`（supervisor-consumption.ts:31-34） | 各样本实际 childIndex |
| order | 静态顺序已核实：native request → `message_end` 本仓登记（extension.ts:1670，correlation 在 subagent-runtime.ts:298-302 捕获）→ reply/steer `resolveSupervisorControl` → 上游 `adapter.execute`/`rpc`（extension.ts:1292）→ `commitDelivery`（extension.ts:1293/1239）→ `subagent:process-terminal` 触发 `reconcileSupervisorConsumption`（subagent-runtime.ts:301/294） | 各样本在真实运行中的实际先后观测 |
| delivery | 默认 commitDelivery 只写 receipt `status="queued"`、`consumed=false`，request 仍为 pending（control-plane.ts:229、232）；queued 回执不等于 child 已收到 | M07 reply 的实际 delivery 事实（是否被 child 收到） |
| consumption | 可信消费唯一路径：terminal proof `state==='observed'` + canonical 会话 correlation 全字段对齐（sessionFile/childSessionId/toolCallId/reason/agent/requestBodyDigest/timestamp∈[createdAt, observedAt]）+ reply 前缀 `**Reply from supervisor:**\n` → `observeReplyConsumption` → receipt `delivered/consumed=true`、request `replied`（supervisor-consumption.ts:52-101，control-plane.ts:261-269） | **无任何样本取得可信 consumption 事实**；M07 之后 run 完成、pending 空、attention 均不构成消费证明 |

## 2. 五类状态的权威来源分离（静态核实）

| 状态 | 权威来源 | 静态依据 | 非权威干扰项 |
|---|---|---|---|
| submitted | 上游 native channel 的本侧调用接受（`adapter.execute`/`rpc[action]` 正常返回）；不是持久 receipt 状态 | extension.ts:1292 | 上游 pending 变空不代表本仓 durable 状态 |
| queued | 本仓 control plane receipt.status（`commitDelivery` 默认值，consumed=false），durable request 保持 pending | control-plane.ts:229、232 | 工具 `pending` 视图、reply 提交成功 |
| delivered | 本仓 receipt.status，仅经 `consumed=true` 的可信观察推进（idempotent queued 回执也可被该观察一次性推进） | control-plane.ts:216-227、238-269 | 输出文本、终局成功猜测 |
| consumed | receipt.consumed=true，必须来自 `reconcileSupervisorConsumption` 对可信 child session 的字段级对账 | supervisor-consumption.ts:52-101 | pending 空、延迟 attention、run 正常完成 |
| gate-open | `resolveSupervisorControl(steer)` 对 durable pending 的派生判定（任一 pending 即 `SUPERVISOR_REPLY_REQUIRED`）；非持久字段 | control-plane.ts:203、184 | 上游 pending 空、attention 快照、20min TTL（仅持久化重载路径 L114-118） |

## 3. 存疑样本归因处置

- M05A/M05B（首次 reply `NOT_PENDING`、随后成功）：实际 replyTo、登记 createdAt、调用时间均不足，**不得归因**为参数错误或 race；维持 unconfirmed。
- M07（reply 成功、pending 空、steer `REPLY_REQUIRED`、随后 run 完成）：与静态合同一致（queued 回执 + durable pending → gate 关闭；run 完成 ≠ `observeReplyConsumption` committed，terminal 对账也可能走 `expireTerminalRequests` 的 failed/expired 分支），**不构成 production consumption proof**。
- 无精确存疑样本字段（实际 ID/时间/消费事实）→ 本任务按无新样本记 **blocked-evidence**，不以 pending 空、attention 或提交回执补证明。

## 4. blocked-evidence 说明与 nextAction

- 未证实的：真实 consumption 样本、首个偏离（gate 在可信消费证成后仍拒绝）是否存在于生产。
- 已证实的：状态映射与门禁 fail-closed 合同与历史 JSON `stateMapping`/`requestOrder` 一致，本轮源码未见改变该合同的迹象（静态）。
- nextAction：如需解除，仅向用户申请最小字段取证——各样本的 `requestId`/`runId`/`replyTo`/`childIndex`/登记与调用时间戳/receipt 状态投影（非敏感元数据，不读取正文、凭据或完整会话）；取得后另行核对，不在本记录内归因。
- 不修改 gate、不新增 authority、不放宽 `SUPERVISOR_REPLY_REQUIRED` fail-closed 语义；处置（terminal status/证据归档）由 V2 依本记录进行。

## 5. 验证

- 命令：`git diff --check`（见验收报告，真实 exit code）；本任务无其它命令（静态记录禁止 test/typecheck/Host/provider/网络）。
- 未验证范围：全部运行时行为（消费对账实际触发、TTL 过期、close/terminal 清理）仅静态阅读，未运行。
