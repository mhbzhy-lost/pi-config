# V2 supervisor 处置记录（统一计划 2026-10-13）

- taskId: V2（supervisor处置）
- status: **blocked-evidence**
- date: 2026-10-13
- deps: V1（`docs/plans/records/2026-10-13-supervisor-provenance.md`）
- contract: dispatch-af605990（统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md`，V1 基线 blocked-evidence）
- evidenceMode: **static**；sourceClass: **unconfirmed**（承继 V1，本批未取得任何新字段级样本）
- 边界：本记录为纯静态处置，未运行 test/typecheck/Host/provider/RPC/网络/通知/kill；未读 settings/models/auth/credential/实际 session/authority/state；未修改 gate/authority/源码/测试；未 poll pending，未执行任何 steer/resume/stop；未 stage/commit/stash/reset。

## 1. V1 事实承继（按原样保持，无新增证据）

V1 的 blocked-evidence 状态、sourceClass=unconfirmed、evidenceMode=static 按事实承继；本批无新的实际 `requestId`/`runId`/`replyTo`/`childIndex`/登记与调用时间戳/consumption 事实，V1 结论无一被推翻或补证：

- queued 为本仓 receipt 默认（`commitDelivery`，consumed=false），durable request 保持 pending，gate-open 为 pending 的派生判定。
- M07 reply 成功、pending 空、steer 返回 `SUPERVISOR_REPLY_REQUIRED`、随后 run 完成：与静态合同一致；pending 空、run 完成、延迟 attention 均不构成消费证明（consumed 须 terminal proof + canonical correlation 全字段对账 + reply 前缀 → `observeReplyConsumption` committed）。
- M05A/M05B 维持 unconfirmed，不归因为参数错误或 race。
- 字段级 known/unknown 表、五类状态权威来源的行号级静态证据、样本归因细节均以 V1 记录为准，本记录不复制行号以免双源漂移。

## 2. 五类状态来源（静态合同重申）

| 状态 | 来源 | 非权威干扰项 |
|---|---|---|
| submitted | 上游 native channel 本侧调用接受（`adapter.execute`/`rpc` 正常返回） | 上游 pending 变空 |
| queued | 本仓 receipt.status 默认值（consumed=false），request 仍 pending | 提交回执、`writeReply` 成功 |
| delivered | receipt.status，仅经可信观察（consumed=true）推进 | 输出文本、终局成功猜测 |
| consumed | receipt.consumed=true，须 `reconcileSupervisorConsumption` 对可信 child session 字段级对账 | pending 空、attention 快照、run 正常完成 |
| gate-open | `resolveSupervisorControl(steer)` 对 durable pending 的派生判定，fail-closed | 上游 pending 空、attention、TTL |

## 3. 处置结论

- 本批性质：**文档处置记录，不是 production fix**。未修改 gate、authority、控制面、源码或测试；`SUPERVISOR_REPLY_REQUIRED` fail-closed 门禁语义保持不变。
- 无真实 consumption 样本、无首个偏离（可信消费证成后 gate 仍拒绝）的生产证据 → V2 终态 **blocked-evidence**，不冒充生产修复，不计为功能完成。
- bug 文档既有历史段落（含「未运行测试、真实 reply/steer/Host、模型或 MCP；未修改 production」等表述）限定其各自历史轮次的事实快照；该表述不构成本批或未来修改控制面的授权，本记录亦不虚构此类授权。控制面修改仍须用户明确授权的独立任务。
- 若未来取得「权威证实消费但 gate 仍拒绝」的生产事实，须由父层另列精确修复任务并申请超出本计划的写路径；不得以错误文案改进、第二 authority 或放宽 gate 代替修复。

## 4. Terminal schema

- taskId: V2
- status: blocked-evidence
- evidenceLinks:
  - `docs/plans/records/2026-10-13-supervisor-provenance.md`（V1 字段级事实/状态来源/样本归因）
  - `docs/plans/records/2026-10-11-runtime-followups/supervisor-provenance.json`（历史结构化 provenance）
  - `docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`（bug 历史 + 本批追加章节）
- commands: `git diff --check`（真实 exit code 见本任务验收报告；本任务唯一命令，未运行 test/typecheck/Host/provider/RPC/网络）
- unverified: 全部运行时行为（真实 reply→consumed 对账、TTL 过期、terminal 清理、gate 解除时序）；M05A/M05B/M07 各样本实际字段值；是否存在生产首个偏离。均未验证，维持 unconfirmed。
- nextAction: 如需解除 blocked-evidence，仅向用户申请最小字段取证——各样本的 `requestId`/`runId`/`replyTo`/`childIndex`/登记与调用时间戳/receipt 状态投影（非敏感元数据，不读取正文、凭据或完整会话）；取得后另行核对归因，不在本记录内归因。若证实消费后 gate 仍拒绝而需修复，由父层另立任务并申请写路径授权。
