# RPC `rpc:v1/session` 协商失败处置（R2）

- taskId: **R2**（统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md` §R2「RPC处置」，Deps=R1，Resources=static-evidence）。
- status: **blocked-evidence**。该分支记阻塞收口，**不计功能完成**；blocked 收口 DAG 交付记录，不替代功能实现，最终账本按 partial 报告。
- 本任务为处置记录：不修代码、不加 fallback、不放宽门禁；生产路径如需修订，由父层在取得真实证据后另行补精确 patch 任务并申请超出计划路径的授权。

## status：R1 结论维持，无升级无降级

- R1（`docs/plans/records/2026-10-13-rpc-provenance.md`，父层已全文验收）的 `blocked-evidence` 结论维持：本轮零新现场样本——未发真实 RPC/Host/provider/网络请求、未读取真实 session/settings/models/auth/credential/authority/state、未重跑历史 T0–T11。用户报错字符串仍是唯一输入，属静态/字段缺失分析，不冒充个案。
- `sourceClass=unconfirmed`、`evidenceMode=static`（与 `docs/plans/records/2026-10-11-runtime-followups/rpc-provenance.json` 一致，未升级）。
- 文案唯一性定位保持：首个可观察偏离为 `assertSpawnCapabilities`（extension.ts:270，编码路径 835 / generic 路径 1044 调用；`extension.ts:294` 带 `pi-subagents` 前缀文案，据此排除 `rpc-client.ts:119` 无前缀同类文案）。该定位为 known（static），**不能猜单一根因**。
- `rpc:v1/session`（extension.ts:292）是六子条件合取的复合标签——version≠1 / methods 无 spawn / sessionId 空 / lifecycle session 身份空 / session.cwd 空 / session.cwd 与 orchestratorCwd 不严格相等——任一失败 push 同一标签，单一复合标签 ≠ 恰好一个条件失败。
- 现场（本任务执行时）对源码锚点复核一致：`extension.ts` 270/292/294/835/1044、`rpc-client.ts:119` 行号与 R1 记录吻合，未发现基线漂移。

## evidenceLinks

- R1 字段级 provenance（含六子条件逐条列举、字段 known/unknown 投影表、最小取证清单）：`docs/plans/records/2026-10-13-rpc-provenance.md`
- 原 bug 文档（本批文末最小追加本批次状态/证据链接/字段级所需输入，历史结论未改动）：`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`
- 历史结构化 provenance：`docs/plans/records/2026-10-11-runtime-followups/rpc-provenance.json`
- 统一计划：`docs/plans/2026-10-13-remaining-runtime-execution.md` §R1/§R2 及「执行门禁及任务终态」schema
- 静态源码锚点：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（assertSpawnCapabilities 及复合标签）、`packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`（文案区分）

## commands（真实执行）

| 命令 | exit | 说明 |
| --- | --- | --- |
| `git diff --check`（写入后） | 0（真实执行） | whitespace 检查通过；未 stage/commit/reset/stash，既有 dirty 现场未触碰；并行 V2/F4g 的变更合法保留，非本任务产出 |
| test/typecheck | 未运行 | F1 占 unit-runner；本任务 Resources=static-evidence，计划未授权本任务运行 test/typecheck |
| 真实 RPC/Host/provider/网络/通知/kill | 未执行 | 禁止事项，全程未发起 |

## unverified（未验证范围）

- 六子条件中哪个或哪些实际失败：unknown（复合标签不可区分）。
- 三个候选机制全部 unconfirmed：上游 session context 未就绪、worktree cwd 判定不一致（originRoot vs 子目录 cwd）、运行中旧 Host/不同资源世代。
- 字段投影全部 unknown（无现场观察）：`stage`（仅静态推断 coding=workflow-spawn / generic=rpc-ping）、orchestrator cwd（`workspace?.originRoot ?? ctx.cwd`）、Git root、worktree 是否派发、报错会话实际加载版本（基线 Pi 1.0.4 / pi-subagents 0.75.0 仅为 static 基线，非现场核实）、session 身份（sessionId/sessionFile/runId）、ping 回包 session 块内容。
- production reachability 未证实；ownerComponent 为 `assertSpawnCapabilities`，ownerScope 仍为「repo-code-contains-assertion、production 根因 unconfirmed」。
- 观察到的 missing 列表仅含 `rpc:v1/session`，无法区分四项 security capability 检查通过或 envelope 检查未执行。

## nextAction

1. 向用户申请 R1 最小取证清单所列非敏感字段级输入（工具结果完整 text+details 投影、派发入参 `worktree`/`cwd`、启动 cwd 与 Git root、实际加载版本、toolCallId/runId 与首个异常日志行、ping 回包 session 块三者有无）；不需要凭据/token、完整 session、authority、`.state`、完整日志正文，不催要。
2. 取得真实证据后按证据分类：若确证生产缺陷，父层先补精确 patch 任务并申请超出本计划 WritePaths 的授权，再修生产；本分支（R1/R2）不修代码，不自动修。
3. 若证据持续不可得：本分支保持 blocked-evidence 收口，Z 最终账本将 RPC 分支按 blocked/partial 如实报告并请求解除具体阻塞，不以关闭记录冒充功能完成。
