# 三份遗留文档再审记录

## 范围与事实

用户要求阅读、审核并查漏补缺以下三份文档，期望后续完成其真正未交付事项；本轮先审查，不自动开始实现：

- `docs/architecture/task-scheduler-adapter-contract.md`
- `docs/plans/2026-10-11-runtime-followups.md`
- `docs/plans/2026-10-13-background-activity-footer.md`

核查时HEAD为 `a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`，index和工作区初始干净。锁定Pi 1.0.4、pi-subagents 0.75.0、scheduler 0.1.9；Node最低要求仍为 >=22.19.0，不升级依赖。reviewer与delegate只读审查，因断网失败后经用户要求resume收口。父层inline修订计划；无生产代码、测试、任务、配置或历史基线变更，无commit/push。

## 分类结论

| 文档 | 真实性质 | 本轮处置 |
| --- | --- | --- |
| scheduler adapter合同 | 已实现的架构/安全合同，不是待实施DAG | 校正安全过滤与显示投影、details拒绝行为、摘要扫描限制；记录observer所需事实与缺口 |
| runtime followups | 2026-10-11历史调查与暂缓账本，不是五项修复已完成证明 | 保留checkbox/基线/acceptance；纠正投影描述、解除永久关闭误读，补增量入口 |
| background activity footer | 有条件实施候选，存在关键接入缺口 | 修正geometry方案、拆精确派发单元、补scheduler身份与安全验收；ownership继续作为前置门禁 |

已实现的四工具门禁、routing提示、bash_async及其renderer不重新列为未实施。scheduler store/lock暂停事项不由footer承接，RPC/supervisor未证实个案不借本轮绿色显示测试销账。

## 问题与修订对应

| 编号 | 严重度 / 事实 | 本轮修订 / 剩余门禁 |
| --- | --- | --- |
| R1 | 高：overlayOptions函数只在挂载求值 | 详情footer最多3行，静态reserve4；resize由viewport终端高度计算。不每帧动态margin，不常规remount；极小终端验收明确 |
| R2 | 高：注册scope隔离不证明业务事件来源 | 加P0有限ownership接口冻结；无合法public能力时T2b停止，不读私有global、不暗中降低多Host支持 |
| R3 | 高：refresh按ctx对象相同过滤，SDK工具ctx是fresh对象 | T4a记录public调用链分类，锁定manager/session/epoch身份及新ctx正例/旧epoch反例；未在本轮修生产 |
| R4 | 高：list成功不代表共享store最新 | available定义为本实例查询成功，observedAt是该观察时间，store缓存陈旧不能全部由stale错误分支识别 |
| R5 | 高：安全包装表述与代码不符 | details是拒绝非undefined；list/get扫描返回文本而非全store；既有模型输出预算与renderer截断分层，详情受控get |
| R6 | 高：历史缺接口被误作永久关闭 | triggerTurn继续核合法options接点；idle registry/epoch可设计，但不借footer registry推断权威状态；RPC/supervisor仍要缺陷provenance |
| R7 | 中：runtimeFromStatus现状描述不准确 | 记录details/顶层state优先、asyncSnapshot精确ID回退；不复用running布尔值作idle完整分类 |
| R8 | 中：子单元路径和能力未闭合 | DAG/Waves按实际派发单元；T4拆observer与source；T5a仅布局、不交viewport；T6b测试失败返回正确owner |
| R9 | 中：expanded、invalidate、输入未冻结 | 新request epoch/source handle/key/token晚回拒绝及dispose；x重取详情，source/主题变更刷新；Esc仅关闭不传播 |
| R10 | 中：验证授权与glob覆盖混淆 | 历史禁新增case不限制将来实施后验证；integration.mjs显式命令，npm test全量先审暴露面，不预称全绿 |

## 可重建的源码依据

以下行号为本轮锁定版本的定位提示，执行时重新定位，不以易失/tmp报告替代原代码：

- Pi `dist/core/extensions/types.d.ts:111–131,212–223`：setFooter、custom、mode；`dist/core/extensions/runner.js:613–699`：同runner manager引用与fresh tool context。
- Pi `dist/modes/interactive/interactive-mode.js:2309–2360`：resolveOptions挂载一次；pi-tui `dist/tui.d.ts`：OverlayHandle无update options。
- `packages/pi-subagents-enhanced/extensions/custom-footer.ts:210–242,331–441`：selector遮蔽scheduler、editor/draft/overlay与未经源归属过滤的事件订阅。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts:49–116`、`extension.ts:1955–1963`：内部getHostIdentity与completion ownership，不是已公开footer能力。
- pi-subagents `src/shared/completion-owner.js:1–7`：process-global owner生成，非公开exports；仅核源码，不读取运行中的私有global。
- `src/bash-async/{contracts,controller,index}.ts`：唯一jobs Map、snapshot、terminal delivery、64条内存history；无现成subscribe。
- `src/task-scheduler/adapter.ts:134–167,207–268`：安全包装、fresh ctx即时refresh缺口、initial与30秒查询。scheduler `dist/tools.js`/`dist/index.d.ts`：原始text JSON摘要与实际字段。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-state.ts:12–27`：控制面helper的实际状态选择逻辑。

静态公开调用链可证明API和实现事实，不自动成为用户个案发生证明。display fixture是renderer验收输入，不当成production缺陷provenance。

## 真正的后续依赖

- footer：协议 → 独立sources/layout → 详情/接线 → 生命周期验收；P0只阻塞subagent provider资格，不阻塞bash、scheduler和纯布局的设计。
- scheduler字段observer与fresh ctx刷新同单元，独立于store并发修复；跨Host最新视图要求才依赖另案store工作。
- triggerTurn修改投递options，idle需要成功派发ID登记与权威status；二者都不依赖footer或heartbeat全覆盖，也不共享显示registry的权威含义。
- RPC/supervisor等待非敏感字段级生产事实；没有证据时保留fail-closed，不重跑历史全文调查、不增加兼容。
- 同文件写冲突作为Resources/隔离处理，不人为把三份工作串成总队列。

## 未解除的授权与产品决策

1. 修订后的计划由用户选择Subagent-Driven / Inline或继续review；本轮仅审查，不启动实现。
2. P0若证明缺公共能力，父层须明确受支持owner观察接口及精确写路径，或由用户确认缩小Host/bus支持范围；不能自动降级。
3. 真实Host视觉验收、macOS通知/权限、危险进程实验分别单独授权，不由选择执行方式捎带。
4. scheduler是否要求跨Host最新状态、是否恢复store安全合同，需用户明确选择；默认footer保留本实例时效限制。
5. 不自动commit/push；本次文档修订后的额外review不自动派发。

## 验证范围

本轮为完整文档阅读、精确源码/API核查、计划DAG与写路径自检。没有运行Node tests、typecheck、npm test、真实Host/RPC/provider/child/scheduler/osascript/kill实验；不宣称行为验收通过。父层执行 `git diff --check` 与精确git status/diff检查，结果以本轮工具回执为准。历史baseline/acceptance不覆盖，没有读取真实settings/models/auth、凭据、完整session或authority。

## 用户后续决策与独立整体复核

用户进一步明确：不改上游或依赖 fork/patch；session owner只补本仓受控launcher/interactive路径；特殊session文件复制不扩大范围；通知必须实际可见；heartbeat用独立测试主Host派发child后SIGKILL实测。人工共用bus多Host不列footer支持，scheduler不纳入store/lock修复。

统一计划首稿为 `docs/plans/2026-10-13-remaining-runtime-execution.md`。用户显式授权一次独立reviewer整体复核，结果为未达可执行标准；父层inline重写，没有自动二次review。审查没有新增产品待决策项，不能把以下技术缺口推给用户设计。

| 整体复核项 | 父层处置 | 完成边界 |
| --- | --- | --- |
| P0-1 session切换CAS未证 | S1g有限target/rollback探索、S1a事务、S1b接线、S1v验证；new/fork无target不伪造claim | gate冻结才实现，不改上游；blocked不算session功能完成 |
| P0-2 event generation混用 | F0及子计划区分session事件与本地闭包token | 合法reload已观察任务完成仍可接收 |
| P0-3 package导入/discovery | F1精确manifest/root dependency/lock/tsconfig，bare public export；F0核实际agentDir发现 | 未发现入口则阻塞，不改settings或last-wins |
| P0-4 idle owner/status/notifier | I1冻结实际成功handle、root/leaf完整集合、resume、新世代、已有rpc注入；I2 package内controller/status/notifier；I3唯一entry接线；I4可见 | 登记失败coverage unknown，不stop合法run，不用footer计数代权威 |
| P0-5 Q sender未证 | Q1明确上游sender实际消息无稳定details；缺合法关联则blocked-upstream | 无新sender/标题选择/私有读取；阻塞不算不唤醒已完成 |
| P0-6 heartbeat无fixture合同 | H1明确physical Pi+local provider、临时根、合法coding派发、binding/lease barrier；H2 PID birth allowlist、90s观察与残留处理 | 只kill父fixture；child不补杀，失败需申请精准清理 |
| P0-7 refresh概念合同 | F4g capture-before-await manager/session/epoch，F4a raw JSON安全metadata及controlled get，F4b展示 | 旧epoch和正常pending均有精确验收 |
| P1-1/2 dirty与历史授权 | B列五条计划输入；历史禁止只限旧阶段，新I4/H2授权单列 | 不覆盖旧baseline/acceptance |
| P1-3/4 pending与安全API | summary pending入typed合同；raw list扫描/校验不反解析bounded模型JSON；detail受控get | 模型输出/RPC状态不变 |
| P1-5/6 ID登记与终态 | I1 root/leaf与resume成功接点；统一terminal枚举+Z partial规则 | 真实目标blocked不能转green |
| P1-7/8 测试路径/命令 | 精确展开文件，确认session-owner-runtime.integration.mjs确实存在；所有integration显式命令 | 禁未审计npm test/all-integration，不因review误述删现有文件 |
| P1-9 文档入口 | F7根/package README精确范围，Z链接changed/not-needed审计 | 不扩通用文档重构 |
| P2完整格式/bus/geometry/证据 | Tasks写Deps/Resources/Files/接口/命令/停止；F6 pi.events unsubscribe；F5b too-small状态；I4/H2字段schema | 不用fake/exit0冒充可见/child自退出 |

本次修订后的统一清单可以从基线和有限技术gate开始执行，但实现节点有明确冻结条件；这不是承诺所有未知接点已经可用或所有目标必然完成。若gate证明在“不改上游”下不可达，须显式交付partial/blocked及具体事实，不暗中降低用户目标。

## 统一计划执行进展追加（2026-10-15，Z 总账收口）

统一计划已按用户选择的 Subagent-Driven 方式执行至 Z 账本收口；本节仅追加执行进展与本轮 review 条目的对应终态，不改上方任何 review 结论。总账：`docs/plans/records/2026-10-13-remaining-runtime-acceptance.md`（总状态 **partial**；账本任务完成 ≠ 全部功能完成）。

| Review 条目 | 执行终态（引用各任务自有记录） |
| --- | --- |
| P0-1 session切换CAS未证 | S1g gate verified（import 子路径 blocked-upstream）；S1a registry 38/38+18/18、S1b 40/40 已实现验证；S1v 非 PTY 范围 8/8（真实 exit 0）。6 项真实 CLI/PTY 隔离测试 blocked-environment，待审计+visibleHost 授权，不得写成环境永久不可做 |
| P0-2 event generation混用 | F0 静态 verified；F2b 五 tests 123/123 + packagecheck 0（主层已核，不重复待验） |
| P0-3 package导入/discovery | F1 实现验证；F6-package `verify:subagents-enhanced` exit 0；F6v 中 6 例 package fixture 用例 blocked-environment（离线缓存缺 `typescript` packument + `typescript-5.9.3.tgz`），未删用例未放宽校验器 |
| P0-4 idle owner/status/notifier | I1 blocked-upstream（公开 rpc.status 无逐 run 结构化 state）+ coverage blocked-evidence；I2/I3/I4 未派发；实际可见通知未实现 |
| P0-5 Q sender未证 | Q1 blocked-upstream 维持；Q2 not-applicable 未派 coding；Q3 收口记录；`triggerTurn` 原语义保留，功能未实现 |
| P0-6 heartbeat无fixture合同 | H1p run4 prepare-only exit 0（3/3，前三轮类别 2 修复实证生效）；H2 核心 verified：真实一次 SIGKILL 父 PID、child 依 lease 到期自退出（latencyMs 62449，无补杀，remaining []）；cleanup 独立 blocked-environment（4 active 证据根无合法 public 处置出口） |
| P0-7 refresh概念合同 | F4g 静态 verified；F4a/F4b 实现验证（F4b 16/16 + rootcheck 0，主层已核） |
| P1-1/2 dirty与历史授权 | B 基线 JSON 落盘；I4/H2 真实实验授权按计划单列执行（H2 已跑、I4 未达） |
| P1-3/4 pending与安全API | F4a/F4b 验收覆盖 pending 语义与 raw 安全处理 |
| P1-5/6 ID登记与终态 | I/Q 终态按 blocked 如实入 Z partial；R1/R2、V1/V2 均 blocked-evidence 无样本未修 |
| P1-7/8 测试路径/命令 | 全部显式命令执行（无 npm glob）；全仓 `npm test` / all-integration 未跑，不能 wholegreen |
| P1-9 文档入口 | F7 文档 verified（4 路径写入、一致性核对、链接审计 exit 0）；V1–V14 真实视觉全部 pending-user，未观察，不声明通过 |
| P2 完整格式/bus/geometry/证据 | F5b 28/28 + rootcheck 0（主层已核）；F6v runtime 13/13 + display 98/98；I4 字段 schema 未使用（I4 未派发）；H2 字段齐备（`terminationReason:null`、`publicProcessProof:pending` 不补造） |

其他登记未销账：scheduler store/lock 并发修复本批不做；resume 换模型 bug 只登记未修（`docs/bugs/2026-10-14-subagent-resume-model-override.md`，用户期望仍支持换模型，不擅自改 warning/reject）。HEAD 仍 `a9875d62…`，主代码未 commit 未 push，index 空；用户前次『都提交』不视为本批自动提交授权。
