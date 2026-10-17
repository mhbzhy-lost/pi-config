# Runtime 独立后续事项统一索引

> **统一入口。** 本文汇总原 runtime 统一执行计划、closeout，以及独立工具计划之后仍未完成的独立事项。旧计划/验收中的“未跑、未提交、未授权”等属于各自历史快照，不能直接当作当前待办。本文是账本，不是新实施计划或执行授权，不自动解除已有暂缓决定。

## 1. 当前未完成事项

| ID | 事项 | 当前状态 | 下一步及完成边界 |
| --- | --- | --- | --- |
| R01 | 主会话空闲系统通知 | deferred-user；实现未开始，接口资格仍有缺口 | 用户解除暂缓后，重新冻结run登记、完整ID状态与通知代际合同，再实现/验收 |
| R02 | 纯派发回执选择性关闭triggerTurn | blocked-upstream；未实施 | 取得发送前稳定结构化关联接口；只调整无增量派发通知的唤醒，不丢消息 |
| R03 | resume(model)真正换模型 | deferred-user；待独立立项 | 解决上游参数过滤/启动/合同血缘，不用warning、hard reject或fresh spawn冒充换模 |
| R04 | scheduler store/lock并发 | independent-not-started | 独立诊断与最小修复；只读observer/显示绿色不代表跨Host互斥正确 |
| R05 | 历史RPC rpc:v1/session个案归因 | blocked-evidence | 使用已有诊断取得同次失败的非敏感字段，再做来源分类；不预加fallback |
| R06 | 历史supervisor reply/pending/消费视图个案 | blocked-evidence | 精确请求、回执与消费顺序取证；G2策略修复不等于该历史个案已归因 |
| R07 | Supervisor inspect/clear逃生口 | blocked-upstream | exact absence无法证明，C1/C2/C3清理部分不实现、不签token；待合法接口解阻 |
| R08 | Heartbeat其它拓扑和边界覆盖 | coverage-unverified | generic/binding-failed/detached/bash后代、多child等分别证明，不外推managed coding实验 |
| R09 | 旧heartbeat实验workspace/证据根清理 | blocked-recovery | 旧owner已死且无当前合法public处置出口；保护现场，不raw删除/猜token |
| R10 | Heartbeat fixture正常child报告结算 | fixture-followup | `commandsRun: []`仍在；需fixture-only修正并选择性验收，不能伪造命令证据 |
| R11 | Session-owner剩余验证边界 | coverage-unverified | 真实SessionManager.open失败、跨进程真并发同目标等按合法公开链补证，不扩独占保证 |
| R12 | 独立工具迁移后的真实integration调用者 | migration-pending | 分组改旧工具名/位置依赖，跑对应合同与获授权的integration；历史记录不重写 |
| R13 | ceiling-runtime既有3项失败 | reproduced-baseline；根因待独立分类 | 不能仅因测试红认定production缺陷；检查入口/身份/顺序，再决定只修fixture还是修生产 |
| R14 | resource-isolation既有1项失败 | stale-description-assertion-followup | 已见旧英文description断言；先修测试合同，不凭此扩大生产资源隔离修复 |
| R15 | Gate计划V/Z与架构/链接一致性 | pending-doc-reconciliation | G2 acceptance已经存在；仅补计划状态/架构/引用一致性，不重复列“创建验收记录” |

**这15项是工程/功能待办。** 下方的用户后验、环境部署、现场保护和广域回归不与它们混算。

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
| 全仓npm test/all-integration | 本批未跑，不宣称全仓全绿；如需广域回归先审计危险/网络/敏感配置读取入口，不直接开glob |
| 当前物理Host依赖 | lock/override不代表当前node_modules已重装；未来受控维护/fresh Host验证，禁止热替换运行中依赖 |
| push | 未执行；本机提交不等于远端同步，也不自动授权push |
| 外部models备份 | 保护 `pi/models.json.bak-qoder-thinking-20261016161901`，不读、不提交、不自动删；不是业务bug |

## 6. 证据入口与维护规则

- 原统一计划：`docs/plans/2026-10-13-remaining-runtime-execution.md`。
- 原历史总账：`docs/plans/records/2026-10-13-remaining-runtime-acceptance.md`。
- 最新closeout：`docs/plans/records/2026-10-15-runtime-closeout/acceptance.md`。
- 独立工具总账：`docs/plans/records/2026-10-16-operation-tools/acceptance.md`。
- 旧Runtime TODO：`docs/todos/2026-10-10-runtime-followups.md`（保留历史，只作来源）。

后续更新优先改本统一索引的状态和专项账本，不回写历史验收来伪造完成。暂缓、上游接口、权限、真实验证资源是不同门禁；官方registry来源规则不再被误当成尚未取得的联网授权。每项实施需真实入口/身份/资源顺序来源分类，实施后精确验收并按用户授权单独commit。
