# Runtime 后续待办（不纳入当前现代化计划）

本文是待办账本，不是实施计划，也不构成自动执行、真实流程验证、系统权限申请或提交授权。`docs/plans/2026-10-10-pi104-runtime-modernization.md` 已在授权范围内收口，成果已由 commit `7aa0e18e102effa24f146773eb0999f35e3a7aff` 提交；后续计划 `docs/plans/2026-10-11-runtime-followups.md` 已按用户选择 Inline 执行静态调查。用户清理并行现场后，T0 已重建文档路径基线；当前成果限于静态记录与暂缓实施决策，生产 provenance、通知生命周期设计及行为验证仍未完成。实际范围与限制记录于 `docs/plans/records/2026-10-11-runtime-followups/acceptance.md`。真实 Host、RPC、模型和危险进程仍未运行。以下三项仍未实施。

## 建议顺序 / 状态总览

| 建议顺序 | 条目 | 当前状态与边界 |
| --- | --- | --- |
| 1 | RPC `rpc:v1/session` 协商调查 | 静态 provenance 已记录，`sourceClass=unconfirmed`；首个生产偏离待字段级 metadata，保持 fail-closed，未修复。 |
| 2 | supervisor reply/pending/steer 视图调查 | 静态状态映射已记录，真实消费样本未证实；gate 保持 fail-closed，未修控制面。 |
| 3 | heartbeat / 孤儿清理覆盖 | 静态覆盖矩阵已补；generic、绑定失败、detached descendant 边界仍未做生产实验，未修复。 |
| 4 | 纯派发 `triggerTurn` | 所查 sender 为上游 notify.js，本仓可用 selector 字段及接入方式尚未证明；本轮暂缓实现，不代表所有接入方案不可行。 |
| 5 | 主会话空闲系统通知 | 产品语义保留；run registry/epoch 是待设计能力，缺少现成实现不代表不可实现；用户暂缓，未实施。 |

以上排序只是建议，不自动执行；本轮 Inline 仅授权调查、记录和资格/关闭决策，不授权上述 production 实现或真实流程。文档与 JSON 结构检查已通过，但 T0–T11 不作生产问题解决或完整行为验收；任何后续 production 修复、真实 Host/RPC、危险进程实验或 macOS 通知调用都需重新授权。新模型列表工具另行交付，不属于这五项，也不纳入已完成现代化历史。

## 三项遗留任务

- [ ] **主会话空闲系统通知**（用户明确暂缓实现）
  - 已确认产品条件：`agent_settled` 且全部成功派发并登记的 subagent 不活跃；paused 与终态都算不活跃。登记表提供 ID 集合，逐 ID 查询 status，不用本地计数推断。
  - 新活动使旧通知候选失效，status 查询失败或身份不明不发送；不另加任务成功、workspace 释放、terminal proof 或 completion 消费要求。
  - macOS `osascript` 可发系统通知，常驻样式由系统设置决定，不能保证永久常驻。
  - 依据：`docs/decisions/2026-10-10-idle-system-notification.md`。
  - 未来实现前仅需核实本通知所需的登记及主会话生命周期覆盖，不能把“所有 child 都受 heartbeat 保护”当作已证事实；heartbeat 覆盖调查不是其它待办的硬依赖。尚未发送通知或申请权限。

- [ ] **纯派发回执选择性关闭 `triggerTurn`**
  - 以相对于本仓 subagent tool 最终返回的有效新增信息为判据。重复 child ID、仍在运行、空 results 与诊断路径通常无需单独唤醒主 agent。
  - 候选范围仅无实际结果/错误/需决策事项的纯派发回执；真正完成、失败、部分结果、决策请求及混合批量通知保持原语义。
  - 方向为仅改变投递 options 的 `triggerTurn`，消息仍投递、持久化、可供后续上下文使用，保 TUI、投递确认与下游事件；不是静默丢弃，也不是纯 TUI 化。
  - 精确选择器与信息对照必须在实施时核实，不复用会误匹配批量首行的宽正则，不全局关闭 subagent 通知唤醒。
  - 依据：`docs/decisions/2026-10-10-idle-system-notification.md` 的 triggerTurn 补充，以及 `/tmp/pi-workflow-dispatch-receipt-context-impact.md`（报告部分“必须入会话/首次 child ID”结论已在决策记录中纠正）。

- [ ] **heartbeat / 主进程意外退出后的孤儿清理覆盖**
  - 静态诊断显示：完整绑定的 managed/coding child 有 broker 15 秒续租、60 秒 lease、child 5 秒检查；正常调度前提下主进程 SIGKILL 后约 45–65 秒终止 runner。
  - 现有保证并非全覆盖：generic detached、绑定失败的 child 及 runner 执行的独立 bash/后代进程存在清理缺口；自终止只有 SIGTERM，未证明强制升级或全部后代清理。
  - 依据：`/tmp/pi-heartbeat-parent-death-orphan-cleanup-current.md`，静态报告，未做真实 parent-SIGKILL 端到端实验。
  - 后续先核实合法 production 入口、权威身份、启动/ACK/lease/进程顺序与实际首偏离，完成数据来源分类，才设计最小修复及获授权的隔离验证。不要把独立 session-owner registry 测试当 subagent 清理证据。
  - 不在本轮扩大 broker 能力、改变 child 生命周期、运行危险 kill 实验或增加预防性 fallback。

## 另外两项独立调查（不混入上述三项）

- RPC `rpc:v1/session` 协商失败：`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`，来源待证，按用户要求现代化后处理。
- supervisor reply/pending/steer 视图差异：`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`，门禁与消费窗口已解释，存疑样本及产品限制保留待查，未修控制面。

以上三项遗留任务保持未勾选；RPC/supervisor 是生产 provenance 待补的独立调查，triggerTurn/idle 是接入或生命周期设计待完成的暂缓项。用户已明确要求当前仅文档化并推送，不作实际代码改动；文档提交不构成上述 production 实施授权。

## 恢复工作所需输入与决策

| 条目 | 必要输入或决策 | 边界 |
| --- | --- | --- |
| RPC | 失败样本已有的 `code/stage/missingCapabilities`、主会话 cwd/Git root/worktree 标志、实际 Host/Pi 版本、session identity 是否存在；未知项显式标未知 | 仅非敏感字段投影，不提供完整 session、prompt、凭据或 authority |
| Supervisor | 精确 `runId/requestId/replyTo/index`、登记/reply/steer 时间、receipt 的 `status/consumed`，以及权威消费事实是否存在 | 不把 reply 成功、pending 空或 attention 当消费证明；若无事实继续保持 fail-closed |
| Heartbeat | 决定接受当前静态覆盖边界，或另行授权清理能力设计与隔离验证范围 | 不自动启动 SIGKILL/真实 child 实验；不假定实验是唯一 provenance 来源 |
| triggerTurn | 决定继续核实稳定 receipt 字段及本仓合法 options 接入点，或暂时保留现状 | 不改 node_modules、不建第二 sender；尚未证明上游新增字段是唯一解法 |
| 空闲通知 | 明确是否解除暂缓；先决定登记/epoch 方案，再单独决定真实 macOS 通知调用授权 | 不把缺少现成 registry 当作不可实现；未授权不调用 osascript |

在取得对应输入或新的实施授权前，所有 production 行为保持现状。

## 统一计划批次现状（2026-10-15 追加：Z 总账收口）

> 本节仅追加统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md`（Subagent-Driven）执行后的新现状；上文各『暂缓/未实施/未授权』表述是各自历史调查阶段的快照，不构成对当前状态的声明。当前权威状态以 `docs/plans/records/2026-10-13-remaining-runtime-acceptance.md`（总状态 partial）为准。

- **主会话空闲系统通知**：仍未实现。I1 静态 gate 判 blocked-upstream（公开 `rpc.status` 无逐 run 结构化 state，snapshot 为有界展示投影）+ coverage blocked-evidence；I2/I3/I4 未派发；实际桌面通知从未发出。解除条件见 idle contract §9。
- **纯派发 `triggerTurn`**：仍未实现。Q1 blocked-upstream（上游 sender 消息无稳定 details/receipt 字段，本仓无合法接点）；Q2 not-applicable 未派 coding；现有 sender 与 `triggerTurn` 原语义保留。
- **heartbeat / 孤儿清理**：managed coding+worktree:true 拓扑已由 H2 真实 SIGKILL 验证——父死 62449ms 后 child 依已记录 lease 到期自退出，无补杀、无残留进程；generic/binding-failed/detached/bash descendants 不外推。H2 fixture cleanup 为独立 blocked-environment（4 个 active 证据根 + 1 个已 released 根，无存活 owner 可产出 public 处置出口，现场冻结待父层只读核查）。
- **RPC `rpc:v1/session`**：R1/R2 维持 blocked-evidence（静态处置收口，无字段级样本，未修代码）。
- **supervisor reply/pending/steer 视图**：V1/V2 维持 blocked-evidence（无消费样本，fail-closed 门禁未动）。
- **统一后台活动区（footer）**：F6/F6-package/F7 文档已验收（runtime 13/13、display 98/98、verify-package/typecheck exit 0）；6 个 package fixture 用例 blocked-environment（离线缓存缺 `typescript` packument 与 `typescript-5.9.3.tgz`，待联网授权或补缓存后重跑）；V1–V14 真实视觉全部 pending-user，未观察前不得记为通过。
- **session-owner resume 事务**：S1a/S1b 已实现并验证（registry 38/38+18/18、lifecycle 40/40）；S1v 非 PTY 范围 8/8 通过；6 项真实 CLI/PTY 隔离测试 blocked-environment（需独立审计 + visibleHost 窗口授权，当前未授权 ≠ 环境永久不可做）。
- **resume 换模型 bug（独立后续事项，状态 deferred-user / 待独立设计实施）**：用户最新明确指令『resume 单独立项，记到后续 todo，本次先不处理』——本批不实施任何修复，包括不实施 preflight 显式拒绝（hard error）与 warning+继续两类契约信号，也不用 fresh spawn 冒充 resume 支持（研究 §4.3 明确不推荐：会丢失 canonical sessionFile 续写与独占 revival lease、不继承 retained capability ceiling、并依赖可被 retention 清理的 run 工件）。根因登记：`docs/bugs/2026-10-14-subagent-resume-model-override.md`；只读调研与补设计：`docs/research/2026-10-14-subagent-resume-model-override-design.md`。研究已核实（不得据此宣称所有恢复均不可能换模型）：revive 复用旧 canonical sessionFile 并经 pi 核心 `SessionManager.open` 续写；`model` 在上游 `resumeParams` 重建式白名单处被静默丢弃（首偏离点，成功回执无 warning）；底层 SDK 显式 `options.model` 优先、可在同一 session 文件上以不同显式 model 启动——即「真正切模型」目标存在技术路径，但不被拒绝参数或替代路径所替代、冒充。后续真正实现需独立范围立项，至少评估：上游接口协同改动（RPC 参数层 / 直连守卫 / revive 启动层三处）、模型准入、revival lease 身份、launch contract digest 血缘与 `ResumedRunIdentity` metadata（需 v2 合同），并单独决定是否授权上游修改或升级（本次不接受上游修改）；解除暂缓前，fresh spawn 显式 model 仍是已验证可用的换模型替代路径（bug record §1 步骤 4 实证）。不建工单、不写新计划、不实现。
- **scheduler store/lock 并发修复**：本批不做（计划全局约束），不因 footer 显示验收销账。
- **交付状态**：HEAD 仍 `a9875d62…`，主代码未 commit 未 push，index 空，dirty 72 路径全部保护；全仓 `npm test` 未跑，不能 wholegreen。


## 2026-10-16 Inline closeout 当前状态（取代上方旧快照的完成状态）

- 用户已选择主线剩余任务Inline，并授权每个验收单元commit；后又明确官方源联网许可，N1隔离补缓存与安装已执行。所有npm只用官方registry。后续新supervisor计划已授权subagent执行，当前closeout仍父Inline。
- P0：7行为测试+after账本通过；P1：8非PTY+78合同测试通过；P2：受控真实CLI 5/5通过；P3后续明确授权，1/1通过，一次SIGKILL→reap→ESRCH→replacement，无补杀。
- F1/F6基础接线：综合回归184/184；V1/V2：真实TUI8/8、L2通过、L3pending-user。
- D0–D3：诊断已实现并提交；最后组合纯合同/诊断248/248。历史RPC/supervisor个案归因未升级为已修复。
- edit原生diff：91/91、root typecheck通过；prompt override：32/32，关联32pass+1既有TODO；H1-key identity：111/111、package typecheck通过。
- scheduler只读observer：49/49，store/lock并发问题仍独立未实施。
- 旧heartbeat H2证据保持通过；4active workspace仍保留。本窗口只跑默认关闭harness（2pass+1skip），不重复kill；heartbeat fixture显式tsc原被Error.code类型阻塞，后按用户“明确就直接做”授权完成三处最小类型修复，8/8身份测试、fixture tsc0，commit2ff3b61。
- idle/resume(model)/triggerTurn继续原暂缓决定；每操作独立工具、MD/tool guidance迁移只有调研，尚未实施；不能当作本次closeout完成。
- supervisor child级gate/inspect-clear仍是新计划，尚未实施，不把D3诊断当gate修复；部署必须fresh Host，不能热改当前控制状态。
- 已完成代码正逐项commit，未push；不再沿用“HEAD a9875d6/dirty72/主代码未commit”的旧快照。
- N1安装链失败已解决：根与enhanced安装根override官方pi-codemode1.0.4，官方online/offline各8/8、verify0；无上游patch、无真实node_modules改动。外部consumer需其Host安装根消费约束，当前物理Host未重装。closeout已按用户裁决关闭，TUI后验问题另报新bug。
- 独立操作工具计划：S1/S2/S3、G1/G2、S4、S5与S6已完成并提交；fresh Host工具面为14个独立model-only工具，clear C1/C2/C3仍blocked-upstream；未跑真实provider/CLI兼容，旧integration fixtures的旧工具名引用另列后续。
- 最新总账：`docs/plans/records/2026-10-15-runtime-closeout/acceptance.md`。
