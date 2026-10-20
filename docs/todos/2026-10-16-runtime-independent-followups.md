# Runtime 独立后续事项统一索引

> **统一入口。** 本文汇总原 runtime 统一执行计划、closeout，以及独立工具计划之后仍未完成的独立事项。旧计划/验收中的“未跑、未提交、未授权”等属于各自历史快照，不能直接当作当前待办。本文是账本，不是新实施计划或执行授权，不自动解除已有暂缓决定。

## 1. 当前未完成事项

| ID | 事项 | 当前状态 | 下一步及完成边界 |
| --- | --- | --- | --- |
| R01 | 主会话空闲系统通知 | deferred-user；实现未开始，接口资格仍有缺口 | 用户解除暂缓后，重新冻结run登记、完整ID状态与通知代际合同，再实现/验收 |
| R02 | 纯派发回执选择性关闭triggerTurn | blocked-upstream；未实施 | 取得发送前稳定结构化关联接口；只调整无增量派发通知的唤醒，不丢消息 |
| R03 | resume(model)真正换模型 | deferred-user；待独立立项 | 解决上游参数过滤/启动/合同血缘，不用warning、hard reject或fresh spawn冒充换模 |
| R04 | scheduler store/lock并发 | upstream-production-defect；用户已裁决移出本批 | 同 repository/session 双实例共享文件时可触发；双 Host 同 session 已被 session-owner 前置阻断，不围绕未证拓扑设计修复。来源与开放语义见 `scheduler-provenance.md` |
| R05 | 历史RPC rpc:v1/session个案归因 | blocked-evidence | 使用已有诊断取得同次失败的非敏感字段，再做来源分类；不预加fallback。边界见 `historical-provenance.md` |
| R06 | 历史supervisor reply/pending/消费视图个案 | blocked-evidence | 精确请求、回执与消费顺序取证；G2策略修复与本轮 H1/M1 不等于该历史个案已归因。边界见 `historical-provenance.md` |
| R07 | Supervisor inspect/clear逃生口 | blocked-upstream | exact absence无法证明，C1/C2/C3清理部分不实现、不签token；待合法接口解阻 |
| R08 | Heartbeat其它拓扑和边界覆盖 | coverage-unverified | managed coding + worktree:true 父死核心验收通过；generic、binding-failed、detached、bash后代、多child、长续租仍未外推。见 `lifecycle-boundaries.md` |
| R09 | 旧heartbeat实验workspace/证据根清理 | blocked-recovery | 旧owner已死且无当前合法public处置出口；本会话 `managed_workspace_list` 只投影 A8F3，未见其它 owner 的旧实验 workspace；不raw删除 |
| R10 | Heartbeat fixture正常child报告结算 | fixture-code-updated/behavior-unverified | 已迁移新工具名并用实际 read 证据生成 commandsRun；正常结算端到端尚未重跑。见 `fixture-inventory.md` |
| R11 | Session-owner剩余验证边界 | coverage-unverified | CLI 5/5 与已证P3边界保留；真实 open failure/跨进程竞争/外部import无header仍未证。见 `lifecycle-boundaries.md` |
| R12 | 独立工具迁移后的真实integration调用者 | migration-verified（除孤立 fixture） | 位置依赖与旧工具名已按 `fixture-inventory.md` 迁移并实跑关键组（含 merge-queue probe 43/43）；`scripted-model-server.mjs` 全仓无消费方，无法行为验证，历史记录不重写 |
| R13 | ceiling-runtime既有3项失败 | existing-checks-passed | 本轮3项生命周期检查通过，保留原基线为历史；不扩大 capability ceiling |
| R14 | resource-isolation既有1项失败 | fixture-contract-fixed | 旧英文 description 断言按现行中文合同迁移，focused 通过；生产隔离未放宽 |
| R15 | Gate计划V/Z与架构/链接一致性 | doc-reconciled；S6 清单 evidence-gap | 架构与引用已补；S6 精确 24 文件清单确认不可还原（现存 TAP 日志无文件路径），保留历史 492/492 报告值 |

**这15项是工程/功能待办。** 下方的用户后验、环境部署、现场保护和广域回归不与它们混算。

## 本轮执行证据

当前命令与未覆盖范围见 [current-validation.md](../plans/records/2026-10-17-runtime-convergence/current-validation.md)。scheduler 并发触发条件与首个偏离见 [scheduler-provenance.md](../plans/records/2026-10-17-runtime-convergence/scheduler-provenance.md)。用户最新要求不再处理 `pi -c` 锁阻塞，未删除或隔离其现场。

本批逐项收口状态见 [closure-matrix.md](../plans/records/2026-10-17-runtime-convergence/closure-matrix.md)，交付门禁核对见 [acceptance.md](../plans/records/2026-10-17-runtime-convergence/acceptance.md)，fixture 迁移清单见 [fixture-inventory.md](../plans/records/2026-10-17-runtime-convergence/fixture-inventory.md)，新 settlement 窗口覆盖缺口见 [settlement-window-audit.md](../plans/records/2026-10-17-runtime-convergence/settlement-window-audit.md)。

**本批新增项已按用户裁决收口（不并入上述 15 项工程待办）：** `pi/agents/*.md` 的 frontmatter 改动确认为用户手动修改。① `contact_supervisor` 不写进 profile `tools` 是正确做法——上游 child runtime 按 supervisor channel metadata 注册它，且属不可被 permission gate 的 INTERNAL_TOOL；`pi/AGENTS_GLOBAL.md` 与既有 guidance 断言已按该事实更新，12/12 通过。② `qoder-pool/DeepSeek-Flash` 启用，用户已自行删除 `pi/AGENTS_SHARED.md` 的 deepseek 禁令；生产 `providerBlacklist=["deepseek"]` 只匹配 provider 段，不拦该 pool 别名，保留不变。事实与源码依据见 [agent-profile-drift.md](../plans/records/2026-10-17-runtime-convergence/agent-profile-drift.md)。

## 2. 产品功能与独立修复

### R01：主会话空闲系统通知

- 用户目标：主agent settled且所有已登记subagent都不活跃时发macOS通知；paused和终态都算不活跃，不添加“必须成功/工作区释放/消费完毕”等条件。
- 仍未实现；不等于macOS不支持通知。登记完整性、逐完整ID权威状态、活动epoch/过期候选失效等仍需重新冻结，不能从有界footer/fleet缺行推断空闲。
- 用户已明确暂缓；解除前不建常驻重试、不自动调用osascript。
- 依据：`docs/decisions/2026-10-10-idle-system-notification.md`、`docs/plans/records/2026-10-13-idle-notification-contract.md`。

### R02：派发通知triggerTurn

- 保留真正完成、失败、需决策、部分结果和混合批量通知的原唤醒语义。
- 只考虑相对于工具最终返回没有有效新增信息的纯派发回执；消息仍正常投递与持久化，不静默丢弃、不改为TUI-only。
- 当前上游sender缺发送前稳定receipt/run关联；发送后事件与文本正则不能当安全选择器。不改上游或建立第二sender来绕过。
- 依据：`docs/decisions/2026-10-11-dispatch-receipt-trigger-turn.md`、`docs/plans/records/2026-10-13-trigger-turn-contract.md`。

### R03：resume换模型

- 用户明确单独立项、这批不处理；包括不实施临时拒绝/warning替代方案。
- 核心事实：revive复用canonical旧sessionFile；SDK有显式model能力，但上游resume参数过滤和启动合同未打通。fresh spawn会丢失resume身份/独占lease等语义，不能冒充修复。
- 后续评估RPC参数、直连守卫、revive启动、模型准入、retained capability ceiling、lease、launch digest与实际模型元数据；上游修改/升级仍需单独决策。
- 依据：`docs/bugs/2026-10-14-subagent-resume-model-override.md`、`docs/research/2026-10-14-subagent-resume-model-override-design.md`。

### R04：scheduler并发

- observer/ActivitySource只证明当前adapter实例观察，不保证共享store跨Host最新性或锁互斥。
- 不能用footer、scheduler_get/list成功销掉存储并发问题；先核实正常public变更、权威任务ID与锁顺序，分类后最小修复。
- 依据：`docs/bugs/2026-10-13-scheduler-store-adapter.md`、`docs/bugs/2026-10-13-scheduler-store-concurrency.md`。

## 3. 取证与清理边界

### R05/R06：历史RPC和Supervisor个案

- D0–D3安全诊断已实现并提交；G1/G2 child gate、queued放行、失败重试也已实现。不能继续把这些功能写成“未修任何控制面”。
- 但具体历史个案没有完整同次字段链：RPC需stage/capability布尔/cwd匹配/版本等；Supervisor需run/request/index/owner generation、登记/reply/steer/consumption时序。
- 只取最小安全字段，不读取完整真实session、正文、凭据、authority/state。来源未证时fail closed，不增加预防性兼容。
- 依据：`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`、`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`。

### R07：clear/inspect

- Gate已修，清理未实现。pending空数组无法区分真正无请求、wrong-session过滤、channel读取错误被吞。
- C1 observer、C2 challenge/CAS/audit、C3清理工具仍blocked；不是等消费的旧门禁，也不是可用的行政恢复工具。
- 不能签发token、批量clear、手删request或强制放行；若需要上游协作，另行决定接口和授权。
- 专项详情：`docs/todos/2026-10-16-subagent-operation-followups.md` F1；事实合同：`docs/plans/records/2026-10-15-supervisor-gate/contract.md`。

### R08/R09/R10：heartbeat覆盖、清理和fixture报告是三件事

- **已证**managed coding + worktree:true父死后child在lease到期附近自退出；不能外推generic、绑定失败、detached、bash后代、多child或更长续租序列。
- **未清**四个旧active证据根：`hb-vhjjea`、`hb-fTmWES`、`hb-iKUNgy`、`hb-BXRJmy`；`hb-b9YtbN`对应workspace已released但证据根保留。无当前public清理出口，不raw删workspace/分支/socket/台账。
- **fixture结算缺口**：`test/fixtures/heartbeat-provider.ts` 的child报告仍有`commandsRun: []`，历史prepare的正常child结算与H2父死实验不是同一次验收。需要真实合法执行证据，不能为绿色填虚假命令。
- 依据：`docs/plans/records/2026-10-13-heartbeat-acceptance.md`、`docs/plans/records/2026-10-13-heartbeat-experiment.md`。历史一次SIGKILL授权不得继承给新实验。

### R11：session-owner验证边界

- P2五项CLI、P3一次SIGKILL→ESRCH和非PTY八项已过，不再列为待授权或未跑。
- 历史记录中真实open失败路径与跨进程真并发目标竞争仍未被同PID/串行claim场景替代；是否需要补端到端证明按独立验证合同决定。
- 外部import目标尚无header的路径保持blocked-upstream/fail closed，不能称全import支持；不外推受控launcher之外的CLI/SDK/RPC独占保证。
- 依据：`docs/plans/records/2026-10-13-session-owner-acceptance.md`、`docs/plans/records/2026-10-15-runtime-closeout/owner-cli.md`、`docs/plans/records/2026-10-15-runtime-closeout/owner-esrch.md`。

## 4. 独立工具专项剩余

R12–R15的详细文件路径与边界继续维护在 `docs/todos/2026-10-16-subagent-operation-followups.md`，本文件作为总入口，不复制全部迁移清单。

注意：G2验收文件 `docs/plans/records/2026-10-15-supervisor-gate/acceptance.md` **已经存在**。V/Z剩余是计划复选框、架构说明和交接一致性，不是重新创建同一份acceptance；历史测试数字不覆写成最新数字。

## 5. 不当作未完成实现的项目

| 项 | 当前事实/处理 |
| --- | --- |
| runtime-closeout | 用户已明确关闭；不因后续任务未完成而重开 |
| 独立工具S0–S6 | 实现及范围内验收完成，S6 492/492；R12不冒充已验真实integration |
| N1官方npm安装 | 已修官方codemode1.0.4版本约束，online/offline各8/8，verify通过；不是仍缺联网授权 |
| P3与heartbeat类型尾项 | 已过，不再列未授权/待执行 |
| TUI L3 | 用户后验；发现问题按新bug，不是当前阻塞验收 |
| Skills偶发不可见 | 用户重试恢复，未稳定复现、无根因证明；不改配置、不保留活跃修复任务，复发另报bug |
| 全仓npm test/all-integration | 本批未跑，不宣称全仓全绿；已跑的是 `fixture-inventory.md`/`current-validation.md` 列出的聚焦组合。如需广域回归先审计危险/网络/敏感配置读取入口，不直接开glob |
| 真实旧 workspace `a8f3cdf0-…` | 已用当次 status token `preserve` 成功（state=preserved）；`release` 因缺 observed terminal proof fail-closed。不是已回收，也不是缺陷。见 `current-workspace-settlement.md` |
| 当前物理Host依赖 | lock/override不代表当前node_modules已重装；未来受控维护/fresh Host验证，禁止热替换运行中依赖 |
| push | 未执行；本机提交不等于远端同步，也不自动授权push |
| 外部models备份 | 保护 `pi/models.json.bak-qoder-thinking-20261016161901`，不读、不提交、不自动删；不是业务bug |
| 非隔离 top-level RPC 兼容 lane | `test/pi-subagents-runtime.integration.mjs` 两个 live-state lane 失败（上游 `no_active_session`、RPC 60s 超时）；历史已判为环境受限，保持 blocked-evidence，不延长 timeout、不加 fallback、不重复运行。见 `compat-lane-provenance.md` |
| Agent profile frontmatter | 用户手动改动并已裁决：`contact_supervisor` 由 child runtime 注册、profile 不声明；deepseek 禁令已由用户删除，`qoder-pool/DeepSeek-Flash` 可用。GLOBAL 与既有断言已同步，12/12 通过。见 `agent-profile-drift.md` |

## 6. 证据入口与维护规则

- 原统一计划：`docs/plans/2026-10-13-remaining-runtime-execution.md`。
- 原历史总账：`docs/plans/records/2026-10-13-remaining-runtime-acceptance.md`。
- 最新closeout：`docs/plans/records/2026-10-15-runtime-closeout/acceptance.md`。
- 独立工具总账：`docs/plans/records/2026-10-16-operation-tools/acceptance.md`。
- 旧Runtime TODO：`docs/todos/2026-10-10-runtime-followups.md`（保留历史，只作来源）。

后续更新优先改本统一索引的状态和专项账本，不回写历史验收来伪造完成。暂缓、上游接口、权限、真实验证资源是不同门禁；官方registry来源规则不再被误当成尚未取得的联网授权。每项实施需真实入口/身份/资源顺序来源分类，实施后精确验收并按用户授权单独commit。
