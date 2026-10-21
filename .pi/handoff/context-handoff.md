# Context Handoff（2026-10-17）

## 当前状态

- 用户要求计划完成前持续推进；runtime-closeout 已按用户裁决关闭，TUI L3 为用户后验，新发现另报 bug。
- 独立工具计划 S0–S6、Supervisor G1/G2/G2-wire 已完成；clear C1/C2/C3 因 upstream exact absence 不可证保持 blocked。
- S4 fresh Host main 模型工具已切换为14个独立 model-only 工具；旧 `subagent`/`subagent_worktree`/`subagent_supervisor` 不再注册，membrane 对 upstream 旧 supervisor 名保持捕获。
- S5 guidance 迁移完成；S6 492/492 聚焦验收、typecheck、offline verify、synthetic SDK probe 通过。
- 独立工具计划关键 commits：
  - S1 `e61cb85`
  - S2 `381f86d`
  - S3 `e2ef842`
  - G1 `bcad81a`
  - G2/G2-wire `08ae9ca`
  - S4 `582e055`
  - S5 `d5466e6`
  - S6 `601a32c`
- footer metadata 小优化已完成并提交：`2ca9053 fix(tui): 压缩footer模型元信息`；68/68 footer layout/details/runtime/visual-contract，root typecheck和diffcheck通过。格式为 `<cwd> <provider>/<model> · <thinking> · <context>`，任意provider/model通用。
- 最新已知HEAD：`2ca9053`。
- 暂存区为空。当前保护 dirty：`.pi/handoff/context-handoff.md`（本文件）和外部备份 `pi/models.json.bak-qoder-thinking-20261016161901`；外部备份不读、不提交、不删除。
- 不 push。

## Reviewer成果审阅

- 计划完成后的 reviewer `3b6fce24-6620-442f-be60-deff677b38ce` 已返回完整只读审阅报告，但没有自动落盘到仓库文件；父层需把其内容整理成书面报告。
- 审阅总判定：runtime-closeout按用户裁决完成；supervisor-gate部分完成（B/G0/G1/G2/G2-wire完成，C1/C2/C3 clear blocked）；operation-tools范围内完成（S0–S6完成，真实integration旧fixture迁移另列后续）。
- Reviewer发现的关键风险：
  1. `supervisor-control-plane.ts` 的 `saveRoot` 过滤仍只保留 `root:` 前缀，而 G2 `supervisor-reply-guard.v2:<root>:...` key 可能不落盘；需单独决定修复并补reload重复正文steer测试。
  2. S6 acceptance只写“24文件/492 tests”，未列确切文件清单，独立复现性不足。
  3. Supervisor计划复选框未勾选、架构文档尚未创建；后续文档一致性工作。
  4. scope-unverified pending当前可能阻断该run所有steer，且inspect逃生口未实现；方向fail-closed但有计划措辞张力，clear blocked已记录。
  5. `test/subagent-runtime-resource-isolation.test.mjs`一项失败是陈旧英文description断言；ceiling-runtime三项既有失败已复现但pre-S4归因未独立复证。
  6. 当前物理node_modules的pi-codemode仍为1.1.0，而manifest/lock override为1.0.4；N1隔离安装已8/8，但当前Host未重装。
  7. reviewer观察到review期间footer metadata未提交改动导致当时9项测试红；现已由`2ca9053`完成，不能把该中间现场当当前回归失败。
- Reviewer报告没有写入文件；应创建书面记录，例如 `docs/plans/records/2026-10-17-plan-outcome-review.md`，完整保留上述判定、证据边界和后续建议，不把review建议自动当实现授权。

## 待办/后续

1. 写入并提交 reviewer 书面报告；只读审阅结果整理，不改生产。
2. 评估 `saveRoot` reply-guard v2持久化不对称：若修，补生产最小修复和reload测试；若暂缓，记录理由。
3. 补S6 acceptance精确文件清单（不重新跑测试，仅依据最终命令/日志证据核对）。
4. supervisor计划V/Z文档一致性：勾选已完成G0/G1/G2或以追加验收记录明确，架构说明可另行决定；clear仍blocked。
5. 真实integration fixture旧工具名迁移、ceiling/resource-isolation既有失败、heartbeat清理/覆盖、idle/triggerTurn/resume/scheduler concurrency等均在统一后续索引：`docs/todos/2026-10-16-runtime-independent-followups.md`。
6. 不进行全仓`npm test`，不改外部backup，不push，除非用户另行要求和授权。

---

## 2026-10-19 追加（append-only，上文历史原样保留）

> 本节只追加当前事实，不改写上文任何一句。上文“Reviewer 报告尚未落盘”“最新已知 HEAD `2ca9053`”等表述已被现实取代：报告已落盘为 `docs/plans/records/2026-10-17-plan-outcome-review.md`，当前 HEAD 为 `92b0302`。

### 当前批次

- 计划：`docs/plans/2026-10-17-runtime-convergence-policy-closeout.md`（Inline 执行，用户授权持续推进）。
- 权威状态：`docs/plans/records/2026-10-17-runtime-convergence/closure-matrix.md`；交付门禁：同目录 `acceptance.md`；命令与缺口：`current-validation.md`。
- HEAD `92b0302`；**无 staged、无 commit、无 push**；`git diff --check` 通过。
- 保护现场未触碰：`pi/crashes.json`、`pi/models.json.bak-qoder-thinking-20261016161901`（未读正文）；本文件此前内容原样保留。

### 已完成（本轮）

- M1 reply guard v2 持久化对称；H1 `svi1-` opaque intent id（fresh CLI ask/managed 2 场景 exit 0）；H2 bound release 需 observed proof；T29 coordinator `errorInfo`；T26 public disposition facade。
- runtime 可达文本的强制测试措辞清理（含三个本机个人 skill）；`CODING_ACCEPTANCE_EVIDENCE` 去掉 `tests-added`。
- footer 常驻元数据与动态内容之间空行（`src/background-activity/layout.ts`）。
- fixture 迁移：model-selection 23/23、real-git 4/4、managed-worktree 5/5、merge-queue probe 43/43、resource-isolation 9/9、ceiling 3/3、acceptance-evidence 3/3、deterministic+model-only 8/8、guidance contract 12/12。
- 真实旧 workspace `a8f3cdf0-…`：只读 Git 事实证明无 payload → 当次 token `preserve` **成功**（state=preserved）；`release` 因缺 observed terminal proof fail-closed（预期行为，非缺陷）。
- 用户裁决落地：`contact_supervisor` 不写进 profile `tools`（上游 child runtime 注册、INTERNAL_TOOLS 不可 gate），GLOBAL 与既有断言已同步；`qoder-pool/DeepSeek-Flash` 启用，用户已删除 SHARED 的 deepseek 禁令，生产 `providerBlacklist=["deepseek"]` 只匹配 provider 段故保留。

### 仍未完成 / blocked

- T25A/B/C 新 disposition prepare-apply-settlement 与 startup barrier：**七个新故障窗口零行为覆盖**，新增用例需用户授权（建议范围见 `settlement-window-audit.md`）。
- scheduler 并发：上游实现限制，用户已裁决移出本批。
- C1/C2/C3 clear/inspect：上游 exact absence 不可证。
- 非隔离 top-level RPC 兼容 lane 2 项失败：环境受限/来源未证实，fail closed，不重复运行（`compat-lane-provenance.md`）。
- `pi -c` durable guard：用户明确停止处理，现场保留。
- 未跑：全仓 `npm test`/`all-integration`、真实 provider、网络安装、SIGKILL 类实验、五-child 真实验收 probe。

### 2026-10-19 追加（第二批裁决与授权）

- 用户裁决 1：`contact_supervisor` 不必写进 profile `tools`（上游 child runtime 按 supervisor channel metadata 注册，属不可 gate 的 INTERNAL_TOOL）。`pi/AGENTS_GLOBAL.md` 与既有 guidance/profile 断言已按该事实更新。
- 用户裁决 2：启用 `qoder-pool/DeepSeek-Flash`，SHARED 的 deepseek 禁令由用户删除；按要求移除 `extensions/subagent-runtime.ts` 的硬编码 `providerBlacklist = ["deepseek"]` 与 `pi/extensions/subagent/config.json` 的同名死键（extension 的 option 合同保留，显式传入仍生效）。
- 用户要求：`pi/agents/reviewer.md` 的 description 必须强调只读属性（实操中出现把落盘任务派给 reviewer 的误用）；GLOBAL 同步禁止把写任务派给 reviewer。
- 用户授权：新增用例 + 联网。据此新增 `test/workspace-disposition-settlement.integration.mjs`（H3 七个 settlement 故障窗口 + startup barrier + 分区隔离 + 篡改 fail-closed），**12/12 exit 0**；联网只用于官方 registry 的隔离临时目录 `npm ci` 与 package pack/verify（N1 8/8、verify 离线/联网各 exit 0），当前物理 Host 未重装、未热替换，临时安装目录已删除。
- 仍未执行：五-child 真实验收 probe（需真实 provider 授权）、全仓 `npm test`/`all-integration`、SIGKILL/危险进程实验、真实旧 workspace 的物理 `release`（缺 observed terminal proof）。
- 单进程把 28 个测试文件连跑会出现重 Git/proof 用例超时；按三组分别运行全部 exit 0，已分类为资源竞争，不改生产。

### 2026-10-19 追加（第三批：真实 provider 授权与 TUI 回归）

- 用户授权五-child 真实验收 probe：已用 `PI_REAL_BIN=<repo cli>` + `--model qoder-pool/DeepSeek-Flash`（executor 首位候选）异步启动，结果以完成通知为准，启动回执不代表成功。
- 用户报告的 TUI 回归已修：统一详情壳（`634deb4`）不再进入旧 browser 选择模式，导致 subagent 详情看不到该 child 的模型。修复为 `ActivityRow.metaLabel` 可选展示字段 + `session-browser.formatChildModelLabel` 共享格式 + 详情壳 chrome 追加该段；只改显示层。证据：129/129、62/62、typecheck 0；根因与边界见 `docs/bugs/2026-10-19-subagent-detail-model-label-lost.md`。
- 顺带修正 `scripts/probes/repository-merge-queue-acceptance.ts` 中陈旧的 `Pi 0.87.1` 文案（改为引用 `SUPPORTED_PI_VERSIONS`），其合同测试 43/43 仍通过。
- 五-child 真实验收 probe 首跑 `PROBE_EXIT=1`（19s）：probe 把 production 派生的 `details.taskId`（`dispatch-<8hex>`，`contracts/dispatch-ir.ts:103`）当验收任务名；类别 2（验收 harness 过期期望），只改 probe：任务身份改以 probe 控制的 `toolCallId` 为权威，未知形态与缺 toolCallId 一律 fail closed。probe 合同测试 44/44；现场 `…/repository-merge-queue-acceptance-Xkd9TF` 保留（repo 仅 base commit、5 worktree 停在 base、barrier 空、无残留进程）。修正后重跑 job `9dd08c51-a664-4aed-aba1-10b7e4f3bc93`，结果待完成通知。归因见 `acceptance-probe-taskid.md`。
- 五-child probe 第二跑仍 `PROBE_EXIT=1`（122s，barrier 超时）。现场证据：真实模型下已有 1 个 child 经队列发布到 main（`4d4b291`）、1 个真实冲突（`resolving-conflict` + conflictDigest + 4 份 conflict-evidence）、4 个 resume/handoff intent（1 已 delivered）、proof outbox 1 receipt/4 pending/0 debt、4 个 workspace 停在 active；barrier 目录空。首个偏离点：fixture barrier 读 `PI_SUBAGENT_RUN_ID`，上游 pi-subagents 0.75 无此变量，它只由本仓 `integration-queue` child extension 在 barrier 之后加载时写回（profile 的 `subagentOnlyExtensions` 先于 required child extensions）。类别 2，只改 fixture：改用生产 `resolveChildBrokerIdentity` 解析 run 身份，无法解析时 fail closed；probe 合同测试 44/44。第三跑 job `aa8da909-54e0-4c4f-839d-1dc219383b18` 进行中，结果待通知；第二跑不构成验收通过。
- 五-child probe 第三跑（job `aa8da909-…`，900s）仍 `PROBE_EXIT=1`：`OVERALL_TIMEOUT`。barrier 已修通（5 份 ready receipt 同 baseCommit + release.json），队首 `e040eb3` 经队列真实发布并 released、proof receipt 1；4 个 follower 停 `queued`，各自有 durable resume intent（1 已投递 handoff）、proof pending、workspace active 保留、无 cleanup-debt、无残留进程。首个偏离点：`child-integration-lifecycle.ts:27` 默认 `maxAdmissionPolls=3 × pollDelayMs=25`（约 75ms），follower 等不到 FIFO 准入就结束，而当前合同不自动拉起已结束 child（只发主 Agent 接管提示）→ probe 的“五 child 自发布 + 冲突续跑”场景属 auto-resume 移除前的合同。未改生产轮询预算、未改验收语义；三个处置选项（改写 probe 验收接管 / fixture barrier 保活 child / 判定场景作废）待用户裁决。详见 `acceptance-probe-taskid.md`。
- 用户裁决（child 生命周期）：**不拖住 child，工作完成即正常退出**。因此五-child probe 的“全部自发布 + 4 冲突续跑”场景判 obsolete，不再重跑；`maxAdmissionPolls=3 × 25ms` 不是缺陷，未改生产轮询预算，也未实施任何保活手段。源码依据：child runner 结算后 `process.exit(0)`（`subagent-runner-bootstrap.js:218-222`），只有 run 结束前的 awaited handler 或 follow-up turn 能延长存活，两者都会推迟退出/proof/完成通知。若将来要真实模型验收“五个成果都进 main”，只能走主 Agent 接管：handoff → `subagent_run_resume`（新 run）→ `recovery.activate-resume` 重绑 → resumed child 解决冲突并发布；已登记为独立后续项（operation TODO F8），未实施。三次 probe 临时现场保留未删。
- 用户否决“在 GLOBAL 增加 FIFO 队列静态说明”的建议：队首集成自动完成，其余 child 结束时已有 `subagent-integration-handoff` 定向通知（文案本身即接管指令），常驻 prompt 再解释队列只增加理解负担。GLOBAL/profile/skill/tool description 均未新增队列说明。原则：机制说明不前置进常驻 prompt，只在行动时刻由回执/通知承载可执行指令；将来若出现“把接管提示当失败重派”的真实事故，再按证据决定，不预防性添加。
- 全量 integration gate 首跑：`GATE_EXIT=1`，342/304/28 fail/10 skip（1031s，job `bf46378e-…`）。28 项分类见 `integration-gate-baseline.md`：6 个文件属 fixture/断言过期（contact-supervisor 缺 host 缺省解析、project-workflow/completion-notification/steer 仍发旧 union `subagent`、root-broker-startup 缺 agents-shared 且在仓库根启动导致 state root scope mismatch、repository-identity 混淆展示路径与身份哈希、session-owner-install 期望已废的 `--no-skills`），已按类别 2 只修 harness 并复跑（job `8f34945f-…`）；`pi-subagents-045-workflow`（pin Pi 0.87.1）与 `pi-subagents-runtime` 两条 upstream top-level RPC lane 属覆盖范围决策，未擅改。方法论纠正：旧工具名扫描必须按内容过滤，先前按路径过滤导致 inventory 漏项。
- 门禁整改进展：复跑 7 文件 31 tests/23 pass/8 fail；再修两项过期断言（contact-supervisor `empty` 的 required extensions 补 `agents-shared`；root-broker-startup 改断言 `subagent_start` 且旧 union 不注册），单独复验 **2/2 exit 0**。harness 迁移已提交 `f211702`（未 push）。
- 基线对照结论：用只读 `git archive 92b0302` 展开基线树 + symlink 当前 node_modules + 覆盖当前测试/fixture 后运行，失败清单与当前树**逐项相同**（8 项），故这些失败**不是本批生产改动引入**。注意 `git worktree add` 被本仓 security-gates 拦截（worktree lifecycle bypass），未绕过。
- 剩余 6 项（基线同样失败，未定论、未加兼容分支）：project-workflow 的 `rpc:v1/session` 缺失（lane 未传 `--session-dir`，疑似栈升级后合同收紧）与 `WORKSPACE_SERVICE_UNAVAILABLE`；completion-notification / steer-text-insertion 的 60s “dispatch receipt is missing”（疑同源）；contact-supervisor `invalid-reply`；session-owner-install zsh wrapper exit 1。逐项见 `integration-gate-baseline.md`。
- 仍待用户裁决：`pi-subagents-045-workflow`（pin Pi 0.87.1，本机 1.0.4 不可能通过）与 `pi-subagents-runtime` 两条 upstream top-level RPC lane 的覆盖归属（退役/门禁排除/恢复 upstream bridge context）。F8 真实模型接管验收未开工，等这 6 项分类后再接，避免与重活并行制造假超时。
- 045 历史 lane 已修并通过（1.0.4 Host + npm 安装的 upstream 0.62.0，8.2s）：版本 pin 改为接受 `SUPPORTED_PI_VERSIONS` 或显式 `PI_HISTORICAL_REAL_BIN`。两条 top-level RPC lane 补 `--session-dir` 后仍以相同形态失败（upstream `rpc.js` 的 `no_active_session`），session 假设被否证、改动已回退；是否退役/门禁排除/生产激活 upstream bridge context 仍待用户裁决。project-workflow、completion-notification、steer 三条 lane 的 `rpc:v1/session` 缺失需各自取证，不得沿用该被否证假设。
- top-level RPC lane 取证（用户选 A）：已确证 bridge 服务端唯一注册点 `upstream extension/index.js:631-637`（`getContext: () => state.lastUiContext`），`rpc.js:583-587` 对非 ping 方法在无 context 时抛 `no_active_session`；`lastUiContext` 只由 `resetSessionState`（`:816-845`）或“union `subagent` 工具 + hasUI 的 tool_result”（`:767-772`，本仓栈永不成立）赋值。**本仓生产派发就是这条 bridge 的客户端**（`rpc-client.ts:3-4,230,276` + `subagent-runtime.ts:21,319`），故结论是**不能退役**该 lane；门禁排除只在取证失败时作临时手段。未解释的不对称：contact-supervisor 同为 `--no-session` 却派发成功，且补 `--session-dir` 已否证。两个候选 H1（该 Host 从未跑 `resetSessionState`，成功派发不经 bridge）/H2（应答的 bridge 非本仓 bootstrap 实例）。下一步是单一有界实验：在两个 lane 各加只读观测扩展，记录 `session_start`、`subagents:rpc:v1:ready`、ping 的 session 投影，对照判定 H1/H2；判定前不改生产、不放宽断言。详见 `integration-gate-baseline.md`。
- 并发编排（用户授权“继续 + 先盘并发”）：bash_async 暂不启用（全量门禁重跑与 F8 真实模型 probe 都要等修复/实现落地，且与取证 lane 争 Host 资源，必须串行）；同一时刻只允许一个 child 启动真实 Host；inline 只做整合、账本与决策。已派发三个 subagent：executor `88284cdc-4765-47d0-9601-f945da2ad7db`（RPC bridge context 观测实验，只新增 test/** 观测 fixture，判定 H1/H2，禁改生产）、delegate `dcb9e344-bd67-4e1e-ae6f-225213bff264`（门禁两项取证：session-owner zsh wrapper exit 1 与 contact-supervisor resume runId 漂移，纯静态只读、不得启动 Host）、delegate `4c402da1-a1bb-4cfd-a670-301fa54dae6f`（F8 接管验收实现前诊断与设计，纯只读）。三者产出回来后由主会话整合、按三分类决策，再决定是否进入 F8 实现（需 worktree）与全量门禁重跑。用户已确认：退役 top-level RPC lane 不做，门禁排除登记只在取证失败时作为临时手段。
- F8 诊断结论（child `4c402da1-a1bb-4cfd-a670-301fa54dae6f`，只读）：**F8 不是 fixture 问题而是生产链路缺口**——`subagent_run_resume` 只转发 upstream resume，未查询 intent、未调 `activateResume()`、未重绑 workspace/queue（`src/subagent-dispatch/extension.ts:1441`）；另有两处协议不一致（intent 用 `sourceRunId` 而 `root-broker-server.ts:1226` 按 `event.runId` 路由；`handoff` 不在 `root-broker-protocol.ts:426` 字段表却被 `:440` `exactObject()` 解析）。底层重绑能力齐备（`coordinator-server.ts:459`、`service.ts:250`、`integration-queue.ts:210`）但无 typed 调用方；queue claim 主体是 coordinator daemon，无基于 child 退出的 TTL。同时更正记忆错误：`recovery-protocol.ts`/`coordinator-recovery.ts` 不存在、无 `rebind-superseded-resume`、`coordinator-ledger.ts:14` 只是通用锁与 JSON 读写。权威链路、前置修复顺序 1–5、fail-closed 清单与未验证项见 `docs/plans/records/2026-10-17-runtime-convergence/f8-takeover-gap.md`。**待用户裁决：(a) 授权按 1→5 实施 / (b) 只做 1 并把 2 单独立缺陷 / (c) 暂缓 F8 登记为已知生产缺陷**；未裁决前不改生产。
- 门禁取证 child B **连续两次失败**（`dcb9e344-bd67-4e1e-ae6f-225213bff264`、续跑 `da95253f-894c-4dab-b7e0-c07753f008fa`），两次都只输出意图声明、没有产出结论，不再第三次盲续。已确认的两个事实：项目一真实文件是 `test/session-owner-install.integration.mjs`（无 `pi-subagents-` 前缀），其 wrapper 夹具用 `/usr/bin/expect` 启动 zsh；项目二生产侧以 `runId` 作为 broker/workflow 绑定主身份。重启后应把两项拆成各自单一问题的任务重派（或 inline 做），剩余问题精确为：(1) expect→zsh→launcher→decision CLI 的重定向链中，`wrapper exited with code 1` 且 stdout/stderr 全空的确切成因假设 + 验证所需最小命令（不得启动 Host）；(2) fresh spawn 后通知是否携带新 runId（通知构造处文件:行与字段名）+ 现场 `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/joint-contact-e2e-w1LyzG` 与 `…-VsZWmv` 中 root provider 实际使用的 runId 是否与 active 记录一致（只看 `capture.jsonl`/`parent-events.json`/`parent-stderr.txt` 字段，脱敏），据此判类别 1（生产身份漂移）或类别 2（fixture 未消费新 runId）。
- 观测实验 child A（executor `88284cdc-4765-47d0-9601-f945da2ad7db`）在飞且判定为良性：已推进 18 turns / 20 tools，新增 `test/fixtures/subagent-rpc-bridge-observation.mjs`（只新增、未改既有测试），单次 bash 跑真实 Host lane 数分钟属预期（其中一条 lane 自带 60s RPC 超时）。未干预；处置线为同一 bash 超过约 10 分钟无输出变化才取消该命令。
- 重启后并发编排（第二轮）：已派 3 个 child，只有一个跑 Host。executor `d5045380-fb5b-4c59-9ee7-e547d5291fcf` = 三个同构 lane（`pi-subagents-project-workflow`、`subagent-completion-notification`、`subagent-steer-text-insertion`）的 agents-shared 缺件先取证后修复（writePaths 只限这三个文件，禁改生产、禁放宽断言、遇过期断言只报告不迁移）；delegate `2f0279c7-a9c4-46bd-a3fd-91bbbfbe7efb` = `test/session-owner-install.integration.mjs` wrapper exit 1 的纯静态取证（expect→zsh→fake pi 链、两流为空成因、最小验证命令，不得启动进程）；delegate `54844904-c44c-4b0a-a3d6-ab66d6c547d5` = contact-supervisor `[managed]` resume runId 漂移取证（通知是否带新 runId + 现场 runId 对照，判类别 1/2/3）。静态确认三个 lane 与已修 lane 同构：只建 `configRoot/agents`，未提供 `extensions/agents-shared.ts`，却用 `PI_CODING_AGENT_DIR: configRoot` + `-e projectRuntime`（坐标 project-workflow `:249/:279-312`、`:366/:396-424`；completion-notification `:272/:309-340`；steer `:204/:240-266`）。
- 观测文件评估（待用户裁决②）：`test/subagent-rpc-bridge-observation.integration.mjs`（207 行，两个 test 各启动一次真实 Host、120s 超时）+ `test/fixtures/subagent-rpc-bridge-observation.mjs`（152 行）**是诊断 harness 而非回归 lane**：断言只有 `observation.fixture` 名与“存在一条 label=session-start 的 ping 记录”，判定由 dump 的原始证据承载；form1 故意复现缺件形态、form2 是带 symlink 的正常形态，因此**无论 bug 存在与否它都通过**，无回归价值。两个文件均未跟踪、从未提交。建议删除；诊断结论与复现配方已固化在 `integration-gate-baseline.md`。常驻回归保护其实已隐式存在：已修 lane 若 bridge 未 primed 会在 `test/pi-subagents-runtime.integration.mjs:143`（`compat_spawn failed`）直接红。可选强化（需授权，因为是对既有测试新增断言）：在 `:423` 附近断言 `details.ping.session` 非空（含 sessionId），让未来“bridge 静默未 primed”报成精确症状而不是通用 spawn 失败。
- session-owner-install lane 取证结论入账：`docs/plans/records/2026-10-17-runtime-convergence/session-owner-wrapper-triage.md`。要点：我此前三处前提全错（真实用例是 `:222 fresh zsh wrapper invokes official Pi version…`、仓库里不存在 “wrapper exited with code 1” 这句话、真实耗时 1.7s 且只有 stderr 被观测为空）；最可能层是 `scripts/pi-launcher.zsh:13-14` 的 physical Host 绑定预检在 ambient `PI_TEST_CODING_AGENT_ROOT` 缺失时回落到从不存在的 `$root/node_modules/...` → `resolve-physical-pi.ts:5` ENOENT → exit 1；expect 用 pty 合并子进程两流并写回自己的 stdout，故 `:235` 拿 `result.stderr` 当断言消息结构性恒为空（helper 诊断缺陷，`:236` 永不可达）。分类暂为**类别 3**，已授权三个收敛实验（child `cfe69aef-1027-45be-a193-124547f97b93`）。不需要 production 兼容分支。
- 用户裁决（TUI）：后台活动详情 overlay 的**身份首行整条删除**，信息由 footer 承载（活动 footer 已有 glyph+label+state，subagent footer 已有 model/thinking）。已派 executor `71a01c1c-e776-4b33-8bcf-b5473ff75d78`：删首行、保住 `过期观察` stale 信号（footer 覆盖则随之移除，否则移到保留行）、metaLabel 若无消费方则端到端删除、迁移 `test/background-activity-details.test.mjs:1029/:1055` 为新合同、typecheck + 四个纯单测全绿、禁新增测试文件、禁 commit。
- contact-supervisor “resume runId 漂移” 取证（child `54844904-c44c-4b0a-a3d6-ab66d6c547d5`）**把我的前提整体否证**：该 `[managed] … resumes in place` 场景不存在、`managed` 不在失败清单、fixture 全文 0 次 resume、`rcp-`/`rsm-` 前缀在仓内与所有现场 0 命中；我指定的两个现场是 2026-10-18 的**过期现场**，其失败是已修的 agents-shared 同根因。权威事实与对 F8 的影响见 `docs/plans/records/2026-10-17-runtime-convergence/contact-supervisor-runid-triage.md`（要点：完成通知无 `details`、不带机器可读 runId，权威新身份取自回执 `details.runId ?? details.asyncId`；resume 的唯一身份拒绝路径是 host session 绑定 `async-resume.js:491-495`；观测到的两个 runId 是父 wrapper + 子 run 两个角色，均 active）。真正失败的 `invalid-reply`（缺 `replyTo` 的坏 reply 被判成功投递）已另派 delegate 专项定性。
- session-owner lane 已判**类别 2**（A/B 因果锁定：补 ambient 绿、`env -u` 红），修法裁决为**驳回 gate runner 注入、采用 fixture 自足**（消费权威 helper `test/helpers/pi-runtime.mjs:29-38 resolvePiCodingAgentRoot`），并顺带修 helper 诊断缺陷（`:235` 只用恒空的 `result.stderr`）。child “同批 13 项同根因” 的说法已被 grep 否证（其它 lane 自带缺省）。实施 child：executor `781f57d8-3f78-4bef-af33-9ca9123efd2e`。
- steer 定位合同诊断（child `97eb54d4-4857-454d-bce2-38487afeab0d`，纯静态）判**类别 1（生产合同缺陷）**：唯一实际判据是 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1479`（`params.index === undefined` → `SUPERVISOR_STEER_CHILD_AMBIGUOUS`），该行之前无任何 status/目录读取，故 fan-out 1/1 与 64 child 同码，唯一 child 不消歧；`supervisor-control-plane.ts:297-300` 同样固化（intent 在 `extension.ts:1498/1504` 丢弃 undefined index）；写了唯一候选推断的 `supervisor-gate-policy.ts:551-566 resolveTargetChild` 是**死码**（无生产调用方；`:558` 要求 `complete===true` 而 `:164-166` 明说无 public 证明源；控制面 runtime 只有 `{runId,ownerGeneration,liveRunEpoch,running,steerable}`，见 `supervisor-control-plane.ts:174`、`runtime-state.ts:13-25`）。判责：缺 index 时 fail closed 是**已冻结设计**（`docs/plans/2026-10-15-supervisor-gate-recovery.md:35`、`records/2026-10-15-supervisor-gate/contract.md:73`、`supervisor-gate-policy.ts:547-549`），说谎的是我们自己的 schema/描述（`operation-tools.ts:120-125` required 只有 message、`:240` 写“index 为可选定位”、`extension.ts:124/:131` legacy 面同样）。upstream 侧 index 缺省=向所有 running child 广播（`async-steering-action.js:115-119`），其状态回执 `run-status.js:746/:348` 的 index-less 提示与 upstream 自洽但与我们收紧相反，且 raw payload 不得改写 → 只能登记为无法在本仓修复的已知冲突。`interrupt/resume/stop` 不共享该 resolver（`extension.ts:1527` 直通、接受 dir、不产生 SUPERVISOR_* 码），child 级隔离只存在于 steer。
- 主会话裁决：采纳**选项 2（把公开合同同步到已冻结执行期：steer 的 `index` 必填 + 描述/错误文案同步）+ 选项 3 配套（`test/subagent-steer-text-insertion.integration.mjs:85` 补 `index: 0`，此后不再是绕过）**；**不做选项 1**（唯一候选推断被“child 目录完整性无 public 证明源”阻塞，放宽即降低标准）。实施 child：executor `（见下条派发回执）`，禁改 node_modules、禁启 Host（steer lane 复跑由主会话另行安排）、禁影响 interrupt/resume/stop。遗留产品问题（未裁决、保持现状）：`interrupt/stop/resume` 是否也要 child 作用域。
- **全量门禁零失败基线已确立**（job `de073c08-d23a-4888-9c09-b37f792381e9`，HEAD `e3d20b4`，日志 `/tmp/rc-gate-final.log`）：42 个 integration 文件、**344 tests / 334 pass / 0 fail / 10 skipped**、876s、`GATE_EXIT=0`；`EXCLUDED_INTEGRATION_FILES` 为空（绿不是靠豁免）。轨迹：首跑 342/304/**28**/10 → 344/332/**2**/10 → 344/334/**0**/10。10 项 skip 全部是既有授权/环境门控：8 项视觉快照（`PI_TEST_BG_VISUAL=1`）、1 项 heartbeat 危险实验（`experimentMode`）、1 项 `fixture-sigkill 尚未授权`（`PI_TEST_OWNER_SIGKILL=1`，体内 `t.skip`，故标记行不是 `# SKIP`——统计 skip 应按 `^﹣` 计数并与汇总对齐）。收尾阶段含一次自伤与自愈：展示层提交 `6b1827e` 引入 2 项断言失败，被门禁抓出、定性为断言过期（非渲染回归，附变异测试非空洞性证明）后由 `e3d20b4` 迁移。仍待裁决：①required-child 校验顺序可诊断性（生产）②两个未跟踪观测文件（门禁按 glob 也会跑它们，本轮日志命中 19 次）删或移至 `scripts/probes/` ③F8 的 (a)/(b)/(c) ④`docs/investigations/2026-10-21-pi-1.3.0-upgrade-assessment.md` 归属（非本会话 child 产出，未读未动）。提交口径更正：本批自基线 `92b0302` 起共 **41 个提交**；`main` 相对 `origin/main`（`a9875d6`）**ahead 88**（含此前各批），未 push，push 需用户授权。
