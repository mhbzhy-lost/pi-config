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
- 遗留事项已统一收口到 `docs/plans/records/2026-10-17-runtime-convergence/outstanding-items.md`（**唯一入口**，按“谁能解除阻塞”分为 A 需用户裁决 / B 需用户后验 / C 生产已知缺口 / D 上游阻塞 / E 用户暂缓 / F 证据或授权阻塞 / G 孤立 fixture 与死码）。`closure-matrix.md` 中被本会话推翻的 5 行已同步更正：top-level RPC 兼容 lane（blocked → completed，根因是 fixture 缺 agents-shared，且该 lane 不可退役）、全量门禁（→ 0 fail 基线）、A8F3（→ released 行政出口）、五-child probe 接管路径（更正为“尚未接通”，指向 `f8-takeover-gap.md`）、详情面板模型显示（补记 2026-10-21 改由详情 footer 承载、`metaLabel` 不可删的原因）。新会话读该清单即可接续，不要再从旧的 closure-matrix 行或首跑日志推断状态。

---

## 2026-10-21 最新接续：Pi 1.3.0 独立升级，用户已选 Subagent-Driven

> 本节优先于上文全部历史待办与旧状态。只追加，历史原文不改写。本次用户明确要求更新 handoff 后继续，并明确选择 **Subagent-Driven**。不得再次停下来询问执行方式；不得把历史 1.0.4 小收尾重新作为升级前置。

### 目标、工作目录与授权

- 原始目标：联合评估 1.0.4 收尾遗留项与 Pi 1.3.0 升级，避免重复建设；用户已同意旧低影响事项归档/冻结。
- 原 `/Users/leshi.zhy/pi-config` 是运行中的 1.0.4 环境；旧批次 90 个提交已经 push，main/origin/main 为 `35e3e77`。升级期间只作只读基线核对，不安装、不测试、不改源码/配置/依赖、不切运行入口。**这次按用户明确要求追加本 handoff 是单独授权的恢复记录，不是原环境升级。**
- 升级独立根：`/Users/leshi.zhy/pi-upgrade-1.3.0`；开发 checkout：其 `repo/`，独立 clone（不是 worktree），分支 `upgrade/pi-1.3.0`，HEAD 仍 `35e3e7706af99b43578c6771056a4968d08cc601`，全部升级改动尚未 stage/commit/push。
- 开始新正式计划前，代码约 52 个 tracked 修改、5 个新交付文档，后来增加计划文件；当前 handoff 也会成为独立修改。**不能按数量打包，U1 必须使用精确白名单。** handoff 为持续更新的操作记录，排除在升级候选与 runtime fingerprint 外。
- 环境入口：`/Users/leshi.zhy/pi-upgrade-1.3.0/env/isolated-env.sh`；隔离说明：同根 `ISOLATION.md`。每条升级执行命令用独立 bash 子 shell source 此入口。不要运行真实 `init-pi.sh`，不要原地热替换当前 Host 的 ESM。
- 用户没有为此次 release 指定真实 provider/model，也没有授权复制原仓凭据或发起本轮真实调用。过去 1.0.4 五-child 的历史授权不能自动延用到本轮新场景。不读取 auth/models/backup 正文，不让用户在聊天发送 key。
- 不新增测试/全新 fixture；现有测试可在当前计划授权内运行；实际 MCP、H2/SIGKILL、五-child 真实模型 probe、正式原仓切换、提交/推送均未授权。计划 U4 的现有受控 PTY/视觉检查属于所选计划的隔离验证范围，无真实模型、无 SIGKILL。
- 默认按角色派发，不指定 model（除非用户明确指定）；主会话做计划编写/修订、派发、技术决策和验收，不自行代写生产代码。修复与真实运行分开派发，真实 Host/PTY/登录总槽位 1；无冲突 ready 任务立即派发。不要轮询等待 subagent/bash_async。

### 当前正式计划与执行选择

- **计划权威文件：** `/Users/leshi.zhy/pi-upgrade-1.3.0/repo/docs/plans/2026-10-21-pi-1.3-upgrade-release.md`（约 369 行；需读最新版本，不按此行数定位）。
- 首轮 reviewer `0451683c-b0e5-4306-8d71-c4a289ef2fb0` 已完成；报告：`/Users/leshi.zhy/pi-upgrade-1.3.0/reports/upgrade-release-plan-review-1.md`。4 high + 2 medium 已由主会话 inline 修订并自检；**未自动第二轮 review，也未获成果 review 授权**。
- 用户最新明确选择：**Subagent-Driven**。下一步执行 U1/U5，不能再问“是否开始”或再问执行方式。
- DAG：U1→U2、U3；U3→U4、U5C；U5→U5C；U5C→U6；U2/U4/U6→U7；U7 ready 且用户选择试运行→U8。U5 可先写 awaiting-user，U5C/U6 可以产 not-run；U7 可交付 candidate-only，不因真实模型未选而无限等待。
- U1：候选冻结/文件指纹/已有证据绑定，独立根 cwd，写 `evidence/release/**`、`reports/release/candidate.json`。冻结源、两个 lock、6 个新文档（5 文档+本计划）和环境入口，明确排除 handoff、运行状态、机器配置。辅助批处理脚本只放产物目录，不给 production 接入 scripts/lib。
- U2：开发 checkout 补跑 5 个尚未覆盖的既有文件：joint-upgrade-provider、joint-upgrade-session、joint-upgrade-model-policy、joint-upgrade-rpc-wire、joint-upgrade-ceiling-runtime；先审计 MCP/信号/网络，仅 local HTTP、SDK/临时 Git。写 contracts.json、日志、cache/tmp，遵守短 IPC 例外。
- U3：`.../replay/repo` 再独立 clone，应用 U1 冻结补丁与精确新文档，复制 env 到 `replay/env/`，安装不借开发 node_modules。**全新目录首次 source 时无 CLI，安装后必须再次 source replay env** 再检查 PI_REAL_BIN；setup 已运行 verify:package，输入没变可复用其真 exit。
- U4：replay 的现有 8 场景受控视觉检查：`PI_TEST_BG_VISUAL=1 node --test test/background-activity-visual.integration.mjs`；先读 controlled-pty 合同，正常 Ctrl+D/reap，失败留证不补杀；不把 lifecycle 帧测试当完整工具恢复已证。
- U5：主会话一次性询问用户精确 provider/model、是否允许有限真实调用、独立配置方式；记录非敏感 selectionStatus/授权布尔，缺输入字符串 null、授权 false，不启动 Host。
- U5C：等 U3+U5 后准备 replay 独立配置；无选择/无准备授权直接 not-run。登录专用 CLI禁业务扩展，不复制原 auth；登录 Host 占总槽。
- U6：只有配置 ready 且真实调用明确获准才执行；parent CLI与 generic/coding typed 调用都显式选精确模型。只在 `replay/trial-project` 建 attached main、局部 Git 身份、初始 README commit，clean HEAD 后才 worktree coding；临时项目提交不等于可提交候选。未获准写 not-run，不假填 passed。
- U7：独立根 cwd，写 `repo/docs/...readiness.md`、`reports/release/readiness.json` 和文档补充包；不覆盖 U1 原 patch/hash；只有 source/lock/env fingerprint 相同才复用证据。文档 hash 单列，不触发源码证据失效；U3 真失败必须 blocked，不能以not-run掩盖。
- U8：用户新 shell只进入 trial-project，绝不在冻结 replay/repo 做日常任务；精确 parent/child 模型，正常退出即退回原环境，不改 .zshrc 或原代码。
- 计划/所有任务需更新勾选和执行状态；计划开始后持续推进 ready set，不为协调成本串行化，不在还有可执行任务时停等用户。
- 本次 handoff 写入时：上一阶段所有修复/验证任务都已完成，**尚无新计划 U1–U8 活跃 run**；下一步应立即派 U1、并行落 U5 awaiting-user（在收到输入前不得调用模型）。后续 runId 在追加日志中更新，原历史 running 通知都已过期。

### 隔离关键事实（首审修订已纳入计划）

- 新闭包：四核心/codemode `1.3.0`，subagents `0.79.2`；scheduler/shared/croner `0.1.9/0.1.9/10.0.1`。两个 lock 已重建，旧 override/chord 移除，npm 官方源。
- env 已修：PI_CONFIG_HOME=checkout根；PI_CODING_AGENT_DIR=checkout/pi；*_AGENT_GOAL/WORKSPACE_DIR aliases 与非 alias 同时指向独立 state；registry 是 caller-owned 非 symlink 0700 **目录** `state/owner-registry`；HOME/XDG/TMP/npm/uv 都独立，parent session/coordinator/旧 Host/T8 等残留清理。
- 真实 runtime 的短 IPC **不受 TMPDIR 重定向**：`/tmp/pi-root-subagent-<uid>` 下按 rootSessionId/runId hash 的 socket/grant；`/tmp/pi-workspace-coordinator-<uid>` 下按本次 absolute Git common-dir hash 的 socket。计划 §3.1 明确例外：仅 lstat 父目录 owner/non-symlink/0700，不枚举、碰触或清扫其它 namespace；不符合前提就停相关阶段，不替用户改公共目录权限。
- replay 必须独立 clone，避免 common-dir/coordinator与原仓共用。安装/peer绑定不与同根 Host 并发。
- 正式原仓源码/入口切换需以后另行明确授权；当前只交付独立候选与可选择的新 shell 试用。

### 已完成的升级代码与有效验证（不要重复开发或把历史红灯当现状）

- 3 个必要生产适配：
  1. host-runtime probe：0.79.2 watchdog返回 SubagentMessageBlock extends Host Box；用 Host Box 子类同源谓词，不取消 identity 检查。
  2. fullscreen overlay wheel：viewport/detail-shell 增公开 handleMouse，以真实 wheelDelta复用scrollLines，presenter纯转发，MainScreen rawSGR保留；两个既有测试仅补 renderNow，原滚轮断言不变。
  3. supervisor idle：真正分界是 **subagents>=0.76.1两段wake**，不是 SDK1.3 新改；1.0.4/1.3 _appendCustomMessage相同，只Host/RPC事件不触发扩展message_end。新增 before_agent_start扫描当前active branch真实custom请求→原register，保留message_end、durable查重、root/session/requestId单飞，身份/canonical child call校验不放松。
- 最新有效报告全部位于独立根 reports/（大量原始 logs在logs/；不可跨轮加总为全仓绿）：
  - `final-supervisor-completion-1.3.0.md`：types两工程、doctor、package均过；membrane112/112、gate-wire8/8、supervisor14/14（5原fail+7safe+C8+C10）、completion2/2约5.3秒，正常EOF无timer兜底。
  - `recheck-wheel-1.3.0.md`：6文件60/60+types；未验真实终端/detailfullscreen专门场景/多行wheel。
  - `recheck-peer-workspace-1.3.0.md`：peer4/4、queue28/28、settlement12/12、proof1/1，共45/45；故障窗口为fault注入，不是真Host SIGKILL。
  - `recheck-ui-scheduler-1.3.0.md`：15文件302/304，历史两wheel失败已被wheel轮取代；scheduler51/51。
  - `recheck-host-lifecycle-1.3.0.md`：heartbeat prepare-only3/3（公开结算、remaining=[]、父exit0），该报告旧completion和5supervisor红灯已被final轮取代。
  - `recheck-core-1.3.0.md`：77/78，唯一peer theme.bg缺项后来已补并peer4/4过。
- 旧1.0.4全gate 344/334/0/10 只是历史，不等于目标1.3 fullgate已跑。
- 当前收尾入口：`repo/docs/todos/2026-10-21-pi-1.3-upgrade-closeout.md`；联合评估：`repo/docs/investigations/2026-10-21-pi-1.3-combined-assessment.md`。旧outstanding正文仅作历史，顶上有冻结指针。
- 未验：真实provider、真实TUI/PTY/视觉、detailfullscreen、多行wheel、busy/held supervisor真Host、长会话scan成本、subagents>=0.77 的2000字符preview+artifact、details.runs[]映射、Host级tools恢复/reload、H2/SIGKILL、五child、fullglob/MCP。新计划补选定的实际使用验证，不把所有缺口重新立为blocker。
- 原源码用户现场（.gitignore、pi/agents/delegate.md删除DeepSeek候选、deepseek-search skill、原始1.3调研、crash/backup、两个观测文件）不搬入新候选、不删除、不提交；只读基线输入副本在独立根 reports/input。

### 已发现的产出质量问题与治理

- 用户问 executor质量，已如实说明：artifact first版本泛化file白名单/允许内网registry，parent收紧到真实manifest精确enhanced本地链接+官方npm；误dynamic import执行test导致该run acceptance拒绝，续跑缺structured报告又被拒，保留失败事实，后独立6/6验证有效。
- watchdog fixture漏bg已返修并4/4；completion第一次fixture迁移外层模板正则漏一层转义，实际捕获空格；parent查到生成代码后仅两处反斜杠翻倍，独立final2/2过。不能将此误归为未决产品语义。
- 一个验证executor违约重复跑completion3次补exit，报告保留，无追认；final验证每命令单次，source set-e包装改可靠子进程exit采集。以后不能为补exit或“追绿”自动重跑。
- 模型角色默认由runtime按profile选；不要擅自升档/换model。review只读不得让其落盘，第一计划review已用完，后续每轮需用户明确授权。
- 多次steer携带dir/多定位alias被SUPERVISOR_STEER_TARGET_ALIAS拒绝；被拒不改道。不要照completion通知中的旧union控制示例调用工具。subagent_run_resume的output:false实际RPC路径曾拒绝，需使用明确非空输出路径。

### 新计划执行已启动（Subagent-Driven，原始回执仅表示开始）

- U1 executor run：`5a973f91-87cb-44e6-af2c-de4b0aaf30b5`，cwd 独立升级根，写 `evidence/release/**` 与 `reports/release/candidate.json`。任务包含精确 6 新文档、handoff 排除、binary patch/hash/证据关联；不运行 Host/测试/安装，不改开发源码或原仓。**待自动完成通知**；收到后验 candidate，再立刻派 U2/U3（互不冲突可并行）。
- U5 executor run：`1cdb1a61-62f4-46a0-a62f-e2ac1e5ee6d1`，写 `reports/release/provider-selection.json` 与 `provider-setup.md`，当前只记录 awaiting-user，模型字符串 null、准备/调用授权 false，不登录/调用/读密钥。主会话将一次性询问用户精确模型、有限真实调用许可和独立配置方式；未收到答案不妨碍 U1–U4。
- 主计划已 inline 改为用户选择 Subagent-Driven，并将 U1 原先整树 git diff 改为显式 tracked 白名单导出，排除恢复 handoff。U1 冻结期间不再修改计划；后续进度暂记此 handoff（它被排除，不影响 candidate fingerprint）。
- 当前无其它尚需等待的旧阶段 run；不得对 U1/U5 sleep/poll。无独立工作时结束当前 turn，completion 自动唤醒后继续 DAG。

- U5 原 run `1cdb1a61-62f4-46a0-a62f-e2ac1e5ee6d1` 已完成，两个非敏感状态文件已读验：真实模型仍 null、setup/realCallsAuthorized=false、awaiting-user。其初稿多要求用户指定 parent/child profile，parent 已否决该多余门槛：parent 只绑定精确模型，child 角色按任务约定由主会话选择并核对模型准入。文案修正 run `6b2bcd3f-a88b-4b77-b42f-4b9765bccbbd` 在飞，仅写两份 provider 状态文件，不改 candidate/repo。
- 主会话已经向用户问过一次真实验收的三项输入：精确 provider/model、有限真实调用是否获准、独立配置方式（支持 /login 或用户准备）。不要再重问“六项/必须选 profile”；未回复不视为同意，也不阻塞 U1–U4。U1 当前仍等待最终完成通知，不能把 workflow 派发回执当冻结完成。

- U5 文案修正 run `6b2bcd3f-a88b-4b77-b42f-4b9765bccbbd` 已完成，主会话读验 JSON：missingInputs 仅 3 项、model 字段 null、两项授权 false；parent 不需要 profile，child 角色由主会话按任务约定决定并核对精确模型准入，非用户额外 blocker。U5 当前已完成状态记录，真实使用仍 awaiting-user；U1 等最终通知。

---

## 紧急恢复点：2026-10-21，Subagent-Driven 正式执行中，U1 刚返回

**这节是最新状态，优先于上面所有“U1在飞/尚待执行方式”的历史描述。** 用户刚再次要求紧急使用 write 更新 handoff，主会话先完整 read 后以 write 保留旧正文并追加本节；不是覆盖掉历史。原仓此次只允许该用户明确指定的 handoff 更新，仍不安装/测试/升级原环境。

### 立即接续动作

1. 先核验独立根 `reports/release/candidate.json`、`evidence/release/README.md`、`freeze-verification.json`、补丁/文件SHA256与指纹算法。本节记录的是 U1 子代理回报，**主会话尚未独立验证产物，不能直接视为最终验收**。
2. 核验通过后立即并行派 U2（5个未覆盖既有合同检查）与 U3（第二独立clone干净重放/安装）。它们依赖U1而不互相依赖；不能因U5缺真实模型而停住。若U1产物有实质不一致，按证据修复对应freeze，不重做已完成三处生产适配。
3. U5现已完成状态记录与文案纠偏：`reports/release/provider-selection.json` 为 awaiting-user，provider/modelId/qualifiedModel/configMethod均null，两项授权false；**不要求用户选parent/child profile**。主会话已问过一次三项：精确provider/model、有限真实调用许可、独立配置方式；不要重复问六项或重新问Subagent-Driven。
4. U3完成后，U4可跑现有受控PTY8场景；U5C若仍缺真实模型准备输入则写not-run，U6写not-run；U7可交付candidate-only。U8仅ready且用户选择后执行；原仓切换/commit/push均未授权。
5. 主计划当前文件：`/Users/leshi.zhy/pi-upgrade-1.3.0/repo/docs/plans/2026-10-21-pi-1.3-upgrade-release.md`。第一review已返回且主修6项；不要自动再次review。角色用executor/适用delegate且省略model；coding完整writePaths+acceptance，generic不要无writePaths却带acceptance。

### U1 回报内容（待主验）

- run `5a973f91-87cb-44e6-af2c-de4b0aaf30b5` 已 completed，artifact主入口：`/Users/leshi.zhy/pi-upgrade-1.3.0/reports/release/candidate.json`。
- 回报 candidateFingerprint：`8e54a186f2012d64d74a0d71bff234ee4eb492d22970f01fd80e915b62277f7e`；patchSha256摘要 `c039b0b7…c2a55d`；environmentSha256摘要 `8bf591df…9cf30b`。应从JSON取完整hash后重算，不使用摘要作比较。
- schemaVersion pi130-candidate.v1；sourceFiles 47、lockFiles 2、packageVersions 9、documentFiles 9、evidenceMap25摘要条目；baseCommit35e3e77、branch upgrade/pi-1.3.0。
- 冻结包目录 `evidence/release/`：
  - `candidate.patch`约176.7K，52个精确tracked文件。53 tracked改动中的handoff已排除。
  - `files.sha256`58行；`artifacts.sha256`17项；`untracked-documents.json`；`evidence-map.json`91K；`freeze-verification.json`。
  - `documents/docs/**`6份新文档副本（5交付文档+本计划），保留repo相对路径；`env/isolated-env.sh`、`env/ISOLATION.md`。
  - `build-candidate.py`、`recompute-fingerprint.py`、`README.md`在产物目录，不是production模块/自动化测试。
- U1报告自校验：临时Git只写52个基线HEAD blob，gitapplycheck/apply都0，逐文件hash全等，包含init-pi.sh可执行权限；未运行Host/模型/测试/npm安装。
- 证据map：proved15 / proved-unchanged4 / superseded6，notRun4及11未验边界。final轮400源manifest与当前400/400相等；缺同轮hash的4条降为proved-unchanged。有历史superseded红灯，**不能加总跨轮为全仓绿**。
- 所有hand​​off、.pi/subagents、deps、机器settings/auth/models/crash/backup/.env/runtime文件不进补丁或指纹；后续handoff更新不会使冻结失效。不要在U2/U3执行中修改候选源码；计划勾选/收尾docs仅后续作为单独文档补充，不覆盖U1冻结证据。
- U1披露一次误 `ls -la /Users/leshi.zhy/pi-config`（目录元数据只读，无文件正文/写入），违反该child更严格“不访问原仓”的任务措辞；已停止该方向，不能抹去披露。用户总体要求“不要影响原环境”仍未被升级写入破坏。下个child只需要独立路径，不重演。

### 接续派发的完整关键约束

- cwd推荐独立根 `/Users/leshi.zhy/pi-upgrade-1.3.0`；开发checkout子目录repo，rootHEAD35e3e77，真实原Host仍1.0.4，新开发已是1.3.0+subagents0.79.2+scheduler0.1.9/shared0.1.9/croner10.0.1，尚无stage/commit/push。
- U2 writePaths：`logs/release/contracts/**`、`reports/release/contracts.json`、`cache/tmp/**`、`cache/subagents/**`。5个既有文件：joint-upgrade-provider/session/model-policy/rpc-wire/ceiling-runtime，先审计再逐文件单次真实执行，完整stdout/stderr/exit。不运行MCP、真实外部provider、SIGKILL、不新增测试、不修源；数据分类后报告。
- U3 writePaths：`replay/**`、`logs/release/replay/**`、`reports/release/replay.json`。目标新clone `.../replay/repo`；先检查不存在或核验已有，禁覆盖/reset/stash；git clone --no-local来自开发repo，HEAD必须35e3e77；apply精确candidate.patch+复制6文档；复制env进replay/env，其BASH_SOURCE求根自动落replay。
- U3首次source时尚无CLI，**安装后必须再次source replay/env/isolated-env.sh**，否则PI_REAL_BIN unset。分步npmci --ignore-scripts（官方源独立cache）、node scripts/setup-subagent-runtime-deps.ts；再source、ensure-settings、sync-skills、metadata/typecheck/doctor。setup已有verify:package，输入未变可复用该次真实exit，不机械重复。不要真实init-pi.sh、不要从开发root借node_modules或symlink旧 /tmp extracted依赖。
- 现有短IPC例外：/tmp/pi-root-subagent-uid 与 /tmp/pi-workspace-coordinator-uid 不受TMPDIR影响；前置仅lstat父目录当前uid/non-symlink/0700，否则停相关运行，不能替用户chmod公共目录；仅新session/common-dir派生精确namespace，禁枚举/清理其它端点。其余state/config/session/cache全部独立。
- 原auth/models/settings/旧session/proof/ledger/crash/backup都不读不复制。provider输入未给，只是缺输入，不是新实现缺陷/全计划blocker。
- 不新增测试/fixture、MCP/H2/SIGKILL/五child/成果review/commit/push/正式切换均未授权。
- 截至本紧急write时，没有U2/U3 run，U5及其纠偏已完成，U1刚completed；应先主验freeze，再立即派U2/U3。所有先前阶段run已完成，无须查询旧status或轮询。

### 紧急 handoff 后已完成主验并继续 DAG（最新动作）

- 主会话已独立核验 U1：58 个候选文件、52 个 patch header、17 项包完整性 hash、env 原件/副本 hash、baseCommit 与 candidateFingerprint 全部一致，errors=[]；handoff 不在交付文件里。U1 可进入下游；无需再重复主验或重跑 build-candidate.py。
- U2 已启动 executor `cd2e25e0-82f8-4d51-ad4c-1da37d23c5a4`，cwd独立根；只跑计划5个既有SDK/model/RPC合同文件，写 `logs/release/contracts/**`、`reports/release/contracts.json` 和允许tmp，不修源码。等待自动完成通知。
- U3 已同时启动 executor `11d4a73f-79e3-41d6-8e7f-0224f19e5e6c`，cwd独立根；新 `replay/repo` 独立clone/apply冻结包/安装/二次source/元数据/typecheck/doctor/复用setup内verify，写 `replay/**`、`logs/release/replay/**`、`reports/release/replay.json`。等待自动完成通知。
- 上述两任务均 worktree:false、模型未手选，互不共用依赖与cache；无其它旧run需处理。派发成功只表示开始，不是测试通过。
- 接续先收 U2/U3 最终结果，核验状态与证据：U3 passed后U4现有受控PTY视觉可ready；U5仍awaiting-user时U5C/U6产not-run并汇合U7 candidate-only。用户若此期间给真实模型/调用授权/独立配置方式，保留新输入并按U5更新，不把它当取代本升级目标的新任务。
- 不查询旧run轮询、不sleep、不重复用户执行方式；不擅自新增review/commit/push/正式切换。计划勾选只在不污染冻结源码/环境指纹的文档补充阶段更新，进行中状态以本handoff/仓外reports为准。

- **U2 已完成并经主会话读验**（run `cd2e25e0-82f8-4d51-ad4c-1da37d23c5a4`）：`reports/release/contracts.json.status=passed`、绑定同一 `8e54a186…62277f7e` 指纹。5 个目标既有文件逐个单次执行，13/13 pass、0 fail、0 skip；主会话逐一读取5个 `.exit`，全部0并与JSON一致。source47+lock2/env前后无漂移；本地synthetic SSE不是真provider。U2不需要重跑。U3 run `11d4a73f-79e3-41d6-8e7f-0224f19e5e6c` 仍等最终通知；不要轮询。U5仍awaiting-user，不阻塞U3/U4。

- **U3 已完成且主会话独立核验通过**：run `11d4a73f-79e3-41d6-8e7f-0224f19e5e6c`；`reports/release/replay.json.status=passed`。parent重新读replay实际58文件、9依赖版本、4个peer realpath、自有.git/common-dir并重算FP，均与 `8e54a186…62277f7e` 一致；直接读setup/17bCLI/typecheck/doctor四个exit文件均0。U3曾有17a包装器字面参数错误，已记录并用正确17b检查；不是目标产品回归。verify stdout被setup捕获，只有其链式exit0与输入未变证据，不要伪写独立stdout已拿到。
- **U4 已启动** executor `3a787062-d07e-4f6a-b13b-e253d4d34e12`，总Host/PTY槽由它独占；新replay环境source后跑既有controlled-pty合同与8场景（允许按精确pattern每场景单次，失败未能自然reap立即停后续），无真实模型/SIGKILL/MCP，写 `logs/release/tui/**` 与 `reports/release/tui.json`。等待自动结果，不轮询。
- **U5C not-run 分支已启动** executor `40c0e7f7-47c1-4047-ab9e-63430ad7fc74`，只写 `reports/release/provider-readiness.json` 和provider-setup.md；U5仍awaiting-user/setupfalse，不启动Host、不读任何auth、无需占U4槽。待其完成核验后立即派U6仅生成not-run记录（若用户在此期间给了真实授权/模型，则按新输入更新而不是继续陈旧not-run）。
- 当前ready进度：U1 passed、U2 passed、U3 passed；U4 running；U5状态记录completed但awaiting-user；U5C running；U6待U5C；U7待U2/U4/U6；U8需ready及用户另选。不要重复U2/U3或再次询问执行方式。

### U4 首轮失败后的最新接续：既有夹具修复与第二候选

- **U4 首轮已终态 failed**（run `3a787062-d07e-4f6a-b13b-e253d4d34e12`）：controlled-pty 合同7/7 pass；唯一执行base在session_start前被Trust project folder?阻断，waitProbe20s超时、test exit1；其余7not-run。分类2：临时HOME让真实home祖先.agents/skills变成项目资源，产品按设计询问信任，未证渲染缺陷。原报告 `reports/release/tui.json` 和 `logs/release/tui/**` **保持原样**。
- 历史base PID40663/driver40662，root `replay/cache/tmp/bg-visual-base-izq8eR`；close `exited:false/reaped:false/exit:null`。事后ps无这些精确PID/root活进程，但**不能写自然退出已证**；无补杀/组杀/SIGKILL，不删旧现场。
- **U4F 实现正在执行**：executor `2194fda5-c0c7-45e0-b0cc-10e048688492`（标题U4R1），只改开发repo已有 `test/helpers/background-activity-visual.mjs` 的visualArgs，加入官方单次 `--no-approve`，原HOME/资源发现关闭/显式-e/断言/timeout/driver不变。公开CLI/docs+trustOverridefalse链已由parent读证，override不写trustStore。实现任务不运行测试/PTY，不动replay或第一冻结包；报告 `reports/release/tui-fixture-correction.json`。等它的真实完成通知。
- 计划已追加 **§12** 修订链并更新U1/U2/U3/U5复选框。下一步 **U4F完成主验→U1R2冻结新候选→U3R2精确同步owned replay→独立U4R2八场景→U7**。U1R2只写 `evidence/release/r2/**` 和 `reports/release/candidate-r2.json`，保留第一U1所有bytes；full patch给base新clone，helper-only delta给旧replay，纯文档copy只限已声明plan。新helper会加入sourceFiles而改变FP，不能拿旧FP当当前源码已完全验。
- U3R2不重装：先核对owned replay原58file+helper旧hash/自有common-dir，再apply精确delta+新plan；两lock/生产源码/安装脚本/env/9versions/peer保持不变才复用原干净安装证据，生成 `reports/release/replay-r2.json`，明确mode owned-replay-update。U2/PTY原绿仅映射成proved-unchanged，不改旧报告FP；不明闭包标未证。
- **U5C 已完成not-run并核验状态；U6已完成not-run且parent读验**：run U6 `280bf374-a647-4f3a-ba02-3026d496ded1`，`reports/release/real-smoke.json` statusnot-run、actualRealCalls0、3checks未执行/exitnull。U5仍awaiting-user，只有既有3项输入，未再询问。
- U5C附带纠偏已在U6写实：前U5C run `40c0e7f7-47c1-4047-ab9e-63430ad7fc74` 实际ls了隔离配置目录文件名/metadata，故readiness原“未查auth准备”false声明已更正为authReadinessCheckedtrue、metadata-only、scope exceeded；credentialBodyReadfalse，未再次去查auth路径，setup.md §7留记录。不是泄漏/登录失败，不新增审批。原U6记录仍绑定第一FP；第二revision只可明确携带authorization-only状态，不能改历史运行指纹。
- 当前仅U4F run存活；U1R2/U3R2/U4R2/U7尚未启动。原1.0.4环境仍未安装/测试/切换，仅用户授权handoff写入。无额外review/commit/push/新tests或真实provider权限。

- **U4F 已完成并主验**：helper-only diff为2insert/1delete，新sha `05ad2e40d4dbcc8b6b0873da98d79f10faf94fc4613cafe14818c60664e4aad6`，旧base/replay sha `f5df8bf2de9e9e1c51c5199c143a3d021f1d004c5acb476e803699f01fca777c`；parent读完整修复报告/diff并diffcheck0，未运行修复后Host。修复报告的productionDifference由parent澄清：合法production隔离运行也可产生相同HOME/祖先组合，产品prompt按设计；类别2指夹具自动化启动准备遗漏，不能声称组合在production不可达。
- parent新preflight：原candidate58中仅 `docs/plans/2026-10-21-pi-1.3-upgrade-release.md` 有文档变化；额外dirty只有该helper与excluded handoff，errors=[]。新计划已勾U4F完成、U6not-run完成。**打包期间不再改开发源码/plan**，只更新handoff。
- **U1R2 已启动** executor `1cb8c7dd-3700-49f8-8c6f-05325f9f8750`，cwd独立根；write仅 `evidence/release/r2/**` 与 `reports/release/candidate-r2.json`，预期source48/locks2/docs9=59项、53tracked+六newdocs，新helper进source后FP必须改变；第一candidate/原包/原日志bytes不覆盖。它还要给helper-only delta、六doc/env副本、old-evidence proved-unchanged映射并在r2内无依赖临时clone验apply；禁止tests/Host/install/原仓访问。
- 待其自动完成后parent核验：新59hash/canonicalFP、53fullpatch/1helperdelta、新plandoc副本及旧包17artifacthash未变；U2/原U3/原PTY运行仍是FP1，只显式复用不变inputs。然后立即派U3R2 only helper+plan精确更新knownowned replay（不重装），pass后派另一验证U4R2八case（不重跑不变PTY合同），最后U7。U1R2还在运行，不能把dispatch receipt当完成。

### 第二候选已主验、U3R2 同步运行中

- U1R2 run `1cb8c7dd-3700-49f8-8c6f-05325f9f8750` 已完成。parent独立重算59file、canonicalFP、53fullpatch header、helper-only delta1及两代artifact各17项全部相符，errors=[]；原source47+lock2的49项未变。
- **当前正式候选改为 R2**：`reports/release/candidate-r2.json`；FP `e34eee2dd315141d8294352b879f580f27ccbd47db0c206da863372e258de37e`；previous为 `8e54a186…62277f7e`。fullpatch `evidence/release/r2/candidate.patch` sha `e21506a6f3ffafad423199aa1e3a83f6b08ede3f303b9ba49441b3cf62fcc675`（53tracked）；delta sha `d61a37b71ed7c83266321d7c3f2bac3bc95510082cd7a7972ba65473d02606a9`（helper-only）。source48/locks2/docs9共59；env仍 `8bf591df…9cf30b`。
- 新计划doc旧sha `abe3e71c4e0115617759329daa13c90caac472e45fe32c5d2b36d017552e39c8`→新 `0cce6fe060042fc05afee83991cf88c40215d2bddefe0434f2558137dcc18bda`，其它doc不变。R1 400manifest现399/400，唯一不同helper，不能仍说400/400。两个directimporters为visual.integration和visual-contract，U2/PTY/安装闭包不含helper。
- parent验收时修了r2README相对JSON路径（应 `../../../reports/release/candidate-r2.json`）与实际字段 `changedSinceV1.sourceFiles/documentFiles`，同步其builder模板及两个artifacthash，重验两代17项0error；在r2/self-check.json.parentDocumentationCorrection留证。R2 runtimeFP/fullpatch/delta/第一包bytes均未改，不要重新运行builder。
- **U3R2 已启动** executor `2c08c083-ea9b-412f-8f25-23da7f096a70`；只写replay既有helper+plan两文件、logs/release/replay-r2/**、reports/release/replay-r2.json。preflight原58hash+helperold/self.git/旧精确PID birth，再applydelta+copy唯一plan，实际59/FP2/9metadata/4peer核验；禁止重新安装/测试/Host/改变旧报告。等待自动完成，不轮询。
- 之后parent验证owned-replay-update通过，再派**独立U4R2**：除8个现有视觉case单次外，先运行唯一改动helper的另一个直接importer `test/background-activity-visual-contract.test.mjs`（parent已完整读，4个纯进程内既有断言、无Host/网络）。不重复旧controlled-pty7/7，因为driver/其inputs未变。日志用tui-r2，原tui failed仍保留；新root/lease/calls参数--no-approve。若某断言失败但Host正常code0且reap可继续其余case；close不证立即停，不补杀。
- U6已parent核验not-run/0calls；U7未启动。不要因新FP改写旧U2/U3真实执行归属，读取r2/evidence-map明确proved-unchanged复用；U5C/U6的缺输入状态仅authorization-only关联，未来真实使用结果仍需自己记录且不得伪通过。当前无真实provider/commitpush/正式切换授权。

### U3R2 已主验，独立 U4R2 正在真实运行

- U3R2 run `2c08c083-ea9b-412f-8f25-23da7f096a70` 已completed/passed，报告 `reports/release/replay-r2.json` schema `pi130-replay-update.v1`，mode `owned-replay-update`；parent从replay实际59file重新算FP `e34eee2dd315141d8294352b879f580f27ccbd47db0c206da863372e258de37e`，errors=[]。依赖闭包原U3安装证明明确复用，未再安装/CLI/typecheck/doctor。
- **U4R2 已启动** 独立 executor `1af1b290-1266-4774-8171-370fa620925e`，write仅replay/cache/tmp/**、logs/release/tui-r2/**、reports/release/tui-r2.json；独占Host/PTY总槽。先run已审现有visual-contract 4纯断言，再现有8视觉case精确pattern每case单次。未变controlled-pty7/7引用不重跑。若失败但Host code0/reap真可继续其它case；close不证立停、无补杀/延时/重跑。全部新root/session/lease，--no-approve效果要raw/probe真实证据，原失败report/root不改。
- parent已读验原报告/59file，但U4R2当前还无终态结果；不可把workflow回执当case通过。当前只有这个run活跃，U7尚未ready。
- U4R2通过后：parent核验真实exits/8场景close、helperContract4、before/afterFP。仅按实际断言声称范围（base缩进/宽、long延续、sizes、draft、themes、lifecycle、RPC；footer空行若没明确assert不补写已证）。真实terminal惯性/14工具恢复/专门fullscreen等保留缺口。
- 然后按既定授权派U7汇合：最新FP2+replay-r2 match；U2/旧U3/PTY用r2map proved-unchanged，保留原指纹/报告。U5仍awaiting-user、U6not-run时结论candidate-only，不等新输入、不重复询问，不自动U8。若U4R2出现新失败先provenance分类/最小修复，不能草率收尾。
- U7最终包入口应为**R2 fullpatch+同六docs/env+纯文档supplement**；不能叠v1full+r2full、不能覆盖旧包/旧raw失败。parent可在U4R2终态后更新plan复选框，作为doc-only supplement；U7写readiness.md/json、closeout和documentation-supplement.patch/copies/hash，在一次临时独立clone检查supplement可应用即可，不跑模型/测试/安装/commit。原运行环境未改只指runtime/source/deps/config/入口，用户明确要求更新的handoff作为例外说明。

### U4R2：7/8；新一轮只修 lifecycle fixture，准备 R3

- U4R2 run `1af1b290-1266-4774-8171-370fa620925e` 已终态failed，`reports/release/tui-r2.json` 原样保留：4helper合同pass；base/long/widths/heights/draft/themes/rpc 7pass，lifecycle testexit1；**所有8Host自然code0、reap完整**，无补杀/timeout修改。parent读取完整JSON程序筛查矩阵和closeResults确认该事实；原R1 trust prompt已真正消除，7TUI rawstream无询问，start真实到达，无truststore写入。
- lifecycle确切root `replay/cache/tmp/bg-visual-lifecycle-Si59f3`，Host63379/driver63376，原close已完整；错误 “fixture resume 需要已保存的合法会话”。两个start的模块epoch均1，证明newSession后extension factory重新创建，旧factory-local resumeFile丢失。分类2 fixture跨runtime闭包假设，**不改production**。
- parent已读官方1.3 extensions.md全文、AgentSessionRuntime.newSession teardown/createRuntime链、loader moduleCache:false，**发现直接上游机制**：public SessionStartEvent.reason new/resume/fork + previousSessionFile。无需新sidecar/global缓存或扫描sessions！在现有fixture的session_start reason=new分支用该真实previousSessionFile恢复resumeFile，保持epoch reset语义、new/switch/fork/reload与原guard/断言/timeout。不要预修尚未观察到的reload watcher race。
- **U4F2 已启动** executor `b30cefc6-b51e-4187-ac1a-2dd00e8d7ece`，只改开发repo `test/fixtures/background-activity-visual.ts`、logs/release/tui-lifecycle-correction/**、reports/release/tui-lifecycle-correction.json；静态tsc必须实际覆盖此已有TS文件，可logs内临时extends config(noEmit/incrementalfalse)，无node--test/Host/PTY/网络/安装，不改replay/旧包/plan。等自动完成。
- plan已追加 **§13**，并勾U1R2/U3R2/U4R2执行完成（U4R2结果仍7/8failed，不是通过）；R3链为 **U4F2主验→R3 artifact executor（冻结成功再同步owned replay，两个先后阶段可同一run）→独立U4R3 4合同+8视觉→U7**。这样不重复安装，也保持实现与真实验证分离。
- R3预期仅新增修改的既有fixture进入sourceFiles：source49/locks2/docs9共60，54tracked+6doc（实际清点裁决），前一R2全部运行inputs/env/locks不变。新包 `evidence/release/r3/**`、`reports/release/candidate-r3.json`，delta-from-r2仅fixture（R2中该fixture仍base原文）；doc只更新已列plan。同步只改replay fixture+plan，产 `reports/release/replay-r3.json` /logs/replay-r3，不再次npm/tsc/doctor/CLI/真实runtime。原R1/R2字节/报告不覆盖。
- 因公共fixture源变化，U4R3仍重验4helpercontract与完整8visual（不把旧7passed retag成FP3运行）；controlledPTY7/7 driver闭包未变可引用。U2/原U3与生产输入不变的范围仍显式proved-unchanged，400manifest只算实际相同数，不无条件400/400。U5C/U6仍仅授权状态not-run，真实provider冒烟调用0，不等于subagent推理调用0。
- 目前仅U4F2存活；R3/U4R3/U7未启动，原环境未切换。U7终包将改为**最新R3 fullpatch+同六doc/env+文档supplement**，不会叠R1/R2/R3的fullpatch。真实输入仍未给，不再重复问3项，不新增review/commitpush/正式切换。
- 注意 `tui-r2.json` 超过工具单次50KB，直接JSON.parse(read返回截断文本)会报Showing；这是读取工具输出限制，不是坏JSON或产品异常。用完整原文件的JSON处理或offset分段，**不重跑测试**。

### U4F2 已主验，R3 冻结+同步两阶段正在执行

- U4F2 run `b30cefc6-b51e-4187-ac1a-2dd00e8d7ece` completed：只改已有 `test/fixtures/background-activity-visual.ts` +4/-2。session_start在 reason=new && previousSessionFile 时恢复resumeFile；删除new分支旧局部赋值。公开event为唯一来源，无sidecar/globalcache，无断言/timeout/API流程改动。旧/base/replay sha `c48121b8decb3879e8acb7ea239917f0adda12db8a6b95af18240f5f540cfb5d` → 开发新sha `2c003589faf4630429357ef127440e11b4031537984ec194a412b9a38cdcc53c`。
- parent已读报告/完整diff+核验inventory，errors=[]：旧R2的59里只plan doc变；额外dirty仅该fixture与excluded handoff；replayfixture仍old/basehash，gitdiffcheck0。roottsc原本不包含该fixture；临时logs extends配置(listFilesOnly证明fixture在program)与真实noEmit均0，实际覆盖已确认，修复后runtime仍未运行。
- plan §13 U4F2已勾完成，U7Deps明确最新U4R3/R3替代上个revision。**从此不再编辑源码/plan，直到本轮freeze+验证完成**，仅handoff例外。
- **R3 两阶段run 已启动** executor `812b0737-0345-433d-b443-db42023eca01`。同一artifact executor先A冻结、自检成功才B同步ownedreplay；无Host/tests/install/网络。write为r3/**、candidate-r3.json、replay-r3.json、logs/replay-r3/**及replay现有fixture+plan两文件。期望source49/lock2/doc9=60、54tracked+6docs；actual whitelist裁决。
- A生成 `evidence/release/r3/candidate.patch`、fixture-only `delta-from-r2.patch`、同六doc/env/manifest/真实FP3与originalFP2关系；base独立临时clone apply自检60项。第一/R2包和旧报告不覆盖；old400manifest按实际数，不硬套400/399。B先验R2原59+fixtureoldhash+owncommon-dir/no unknown，然后applydelta+唯一plandoc，实际60hash/FP3/9versions/4peer核验；原U3 cleaninstall只明确复用不变input，不重装、不重复tsc/doctor/CLI。
- native run启动不等于完成。待812自动终态后parent核验新FP3/60files/fullpatch54/delta1/旧包各17sha、两阶段状态，立即派独立U4R3（4helpercontract+全部8visual各单次、新root/session/lease，旧PTY7/7可不变复用）。R3公共fixture变化所以旧7pass不retag新运行。
- 通过再U7最新R3fullpatch+六docs/env+doc supplement，provider输入仍未给时candidate-only；不自动U8，不重复问模型/执行方式、不新增review/commitpush/正式切换。当前仅812run活跃。

### 用户“继续”后的恢复：R3实际早已完成，U4R3 已派发

- 原R3 run `812b0737-0345-433d-b443-db42023eca01` native failed，status诊断 **Connection error** / process_terminal observed，属偶发provider/transport错误；不是产品/测试失败。其human末句仍是“write Stage B driver”，但不能据此重做，因为A/B实际全部落盘。
- parent检查实际state：candidate-r3/replay-r3均存在、replay报告passed；开发与replay fixture均新2c0035...、plan均a188e8...；随后独立核验两侧60file+canonicalFP、R1/R2/R3 artifact各17/17/18项、54fullpatch+1fixturedelta和StageB的17个.exit，**全一致/0/errors=[]**。R3实际工作已通过parent验收。
- **正式最新FP3** `e7b7d7a62cfa3ba6054f316999c4044357cd445f6bd87ba0677b93b2b42eab2d`；candidate `reports/release/candidate-r3.json`，replay `reports/release/replay-r3.json`（owned-replay-update）。fullpatchsha `3d3813ff6973e41706520181600bbe5b0318ffce5e44a3abbf7aa258f3a70e59`；delta-from-r2sha `2f14db9fc28f58acc210eba779af5df9747da0d10e83c3d368f1a0b8803ee0c8`；plan docsha `a188e8056162970eb9707389fcb1f31c7f5e31f9c786d4e3905386fdf4418ef9`。60项source49/locks2/docs9。
- parent按恢复规范resume原持久会话，只补只读最终结构化acceptance，不重建/不apply/reverse/不改包/源码/plan/旧报告。新run `53e944d1-ebeb-45d1-a252-fd9dba2f9151` 已completed；最终报告 `logs/release/replay-r3/resume-output.md`（parent已read，scope只读）。不得再resume旧812去重做StageB。
- 诚实保留R3包装器先前失误：第一次StageB step07 cwd已replay却还git-C replay/repo导致128，delta已应用但doc未copy；child精确reverse自已的单fixture改动恢复oldhash+R2状态后修正runner完整执行一次。详replay-r3.json.priorAttempt、00-partial-apply-revert.*；不称“首次全通过”，无reset/stash/未知现场覆盖，最终17步实exit0。A独立clone60hash成功，原R1/R2旧包/日志都保留。
- **U4R3已启动** 独立executor `ca3d939a-9cb0-4854-923e-c42db292b218`，只写replay/cache/tmp、logs/release/tui-r3/**、reports/release/tui-r3.json；独占Host/PTY槽。FP3和fixture2c/typedhandoff/publicevent、no-approve和4+8单次/正常close/失败停条件完整派发；旧controlledPTY7/7不重跑。尚无终态结果，native工作流dispatch回执不是测试通过，不轮询。
- 目前仅U4R3活跃；R3原/恢复run均终态。U4R3完成后parent验证12项分组结果/exits/8close/reap+FP稳定，再U7；如果新失败先provenance分类不能草率交付。U5/U5C/U6仍awaiting/not-run，真实provider冒烟0；不再问执行方式/那3项输入，不自动review/commitpush/U8/正式切换。

### U4R3 全通过且已主验，U7 正在最终交付汇合

- U4R3 run `ca3d939a-9cb0-4854-923e-c42db292b218` 已completed/passed。最新 `reports/release/tui-r3.json`：**helperContract4/4、visual8/8** 分组计数；source/lock/env前后0drift、FP3未变；新start/cmd证明生命周期已真实完成。
- parent独立核验：9个.exit分别全0、对应TAP helper4/pass4及每case1/pass1/fail0；8个Host自然code0/reapedtrue；lifecycle exactroot `replay/cache/tmp/bg-visual-lifecycle-mtQTzT` 的真实probe有5start、command恰new/switch/fork，reload后start4→5；base/long/widths/heights/themes实际帧分别1/1/4/5/1，draft与lifecycle为probe行为、RPC为stdioJSON，不伪造帧。实际replay60文件全同R3manifest，errors=[]。7TUI lease +1RPC EOF，不说8个PTYlease。
- 当前只有U7未交付。parent已完成plan文档进度更新：原U4综合步骤、U5Cnot-run步骤1/4、R3两阶段与U4R3已勾；U5C认证2/3、U6真实步骤2–5和U8仍未执行。更正U7 Files为**最新R3full+六doc/env+文档supplement**，保留三代冻包；新增U7只改自身plancheckbox/交付状态的明确writePath，避免完成后再改plan让文档hash过期。开发plan纯doc现与R3冻结版不同是预期，replay快照保持原60。
- **U7已启动** executor `dfa8f97c-82af-44d6-ab15-559b6923ecea`，cwd独立根，write仅repo三doc（readiness新record、closeout、plan自身U7checkbox）+reports/release/readiness.json+evidence/release新documentation产物；**不能改R1/R2/R3原包或replay任何文件**。当前无Host/PTY/真实调用任务，U7禁止tests/Host/install/network/review/stagecommitpush/正式切换。
- U7必须decision **candidate-only**：replayMatchtrue、U2原FP1 13/13经r3map proved-unchanged，tui-r3 FP3本轮4+8真pass，真实provider只fresh读取selection/authorization在本次FP3 readiness嵌套记录not-run/executedfalse/actualSmokeCalls0，旧real-smoke/provider记录FP不改；agentProfile不是新用户门槛。
- 文档附件生成方式已明确：从R3 doc快照到最终**plan/closeout两个已有doc delta**+唯一新readiness.md，三doc白名单；不能gitdiffHEAD整树或gitadd untracked。交付documentation-supplement.patch/最终三doc副本与documentation.sha256、51项runtime-inputs.sha256（source49+locks2，不含docs），各cwd写清；R3/files60在supplement前验证，supplement后用runtime51与finaldocs3检查。
- 只做一次最终doc装配重放：documentation/**自有临时独立clone base35e3e77→R3fullpatch+六doc/env→原60hash→docdelta/新doc→runtime51/finaldocs/FP3与模式验证；无依赖/测试/Host，保留真实exit。所有旧失败/close缺口保留，不总计多轮成全仓绿；manualfalse/10条未验、旧低影响冻结和原runtime未改（handoff用户例外）表达一致。U7最后勾自己的实际完成状态并刷新附件/hash。
- 等U7 native自动完成后parent核验readiness结论、docpatch headers/sha、assembly真实exit、新旧包不变和代码FP3，修正仅必要doc缺陷，不追加新review/测试。若通过即可给用户**本轮授权范围交付完成**，仍没有真实模型冒烟/U8/原环境切换/commitpush；不重复询问此前未答三项。最新对外入口应是 repo/docs/plans/records/2026-10-21-pi-1.3-release/readiness.md 与reports/release/readiness.json。

### U7 产物已齐且技术校验通过；最后文档事实补正中

- U7 run `dfa8f97c-82af-44d6-ab15-559b6923ecea` 已completed：三个repo文档（plan/closeout/newreadiness）+readiness.json+documentation附件齐全。FP3仍e7b7...，decisioncandidate-only/replayMatchtrue，U2 13/13 proved-unchanged、tui4/4+8/8 passed、realProvider notrun0smoke。原plan U7 checkbox已x，U8和真实步骤未执行。
- parent最终只读核验：R1/R2/R3/doc artifact各17/17/18/241条，runtime-inputs51和finaldoc3全部hash一致；docpatch恰三声明docheader无code；self-check oktrue/16steps均exit0；source无漂移。U7因两次真实纯文档措词变动做过3次doc装配重放，oldattempt1/2完整保留，不是重跑功能测试。
- 发现最后必要事实更正而尚未宣布最终验收：readiness.md §9和closeout只写“开发checkout handoff追加”，漏了用户明确授权的原 `/Users/leshi.zhy/pi-config/.pi/handoff/context-handoff.md` 更新；JSON还笼统“无任何写入”。必须明确原仓授权handoff+隔离副本，同样排除产品包/FP，运行面其余未改。documentation README另有R3 artifact计数17应18；“如replay是R2”例子要说明当前replay已R3无需再apply；rollback默认继续原入口/退出新shell并保留独立根证据，无需丢弃整根。
- **U7最后文档补正resume已启动**：新run `c6796dcc-52d4-460a-a641-bdfebec8e786`，复用dfa原会话；只在原scope改上述doc与documentation生成模板/JSON，保留old3次logs到attempt3，刷新docpatch/manifest/readiness/保全记录，再因新doc变化只重验一次文档装配。禁止任何source/原三代包/replay/旧报告修改，不运行功能test/Host/npm/网络/模型/review/commitpush。
- 最终输出将由runtime保存 `evidence/release/u7-final-errata-output.md`，明确不纳入正在生成的documentation manifest以免运行中hash失效。当前只有c679活跃，所有Host已退出。等native通知，不轮询。
- parent后续只需读补正结果、核验corrected originals exception/README18/currentreplay/rollback、final四manifest+51/3/3docpatch+16真实退出码、FP3/source不变/planU7x/U8未执行；不要再做新一轮review或无理由回归。通过即最终交付，本轮范围已完成，最终给readiness.md/json+文档包README路径、验证4+8/U2复用/原环境边界，candidate-only因为真实provider未验，不重复问用户3输入或执行方式。

## 2026-10-21 最终接续：Pi 1.3.0 隔离候选交付完成（candidate-only）

**本轮已经完成。没有活跃升级 subagent，不要再次启动或恢复历史run。** U7原run dfa与最后补正 c679 均completed，主会话最终验收已通过。条件性U8未执行，真实provider未授权/未运行，原环境没有升级或切换；本轮不再等待输入，不重问执行方式或此前3项模型输入。

- 最终候选：Pi五核心/codemode1.3.0 + subagents0.79.2，scheduler/shared0.1.9/croner10.0.1不变；FP3 `e7b7d7a62cfa3ba6054f316999c4044357cd445f6bd87ba0677b93b2b42eab2d`。开发/replay两侧source49+locks2/env实际独立重算同FP3，source0drift，staged0，无commit/push。
- 验证：U2实际FP1五文件13/13，按r3明确不变输入proved-unchanged复用；FP3本轮helper4/4与visual8/8分别通过，9exit0、8自然close/reap、lifecycle start5/new-switch-fork+reload真实到达。旧PTY7/7不变复用，不将多轮加总成全仓green。原R1/R2失败、R1close缺口永久保留。真实provider端到端/U8/manual观感等仍未验，详最终readiness10条。
- **最终交付入口（相对独立根 /Users/leshi.zhy/pi-upgrade-1.3.0）**：
  1. `repo/docs/plans/records/2026-10-21-pi-1.3-release/readiness.md`
  2. `reports/release/readiness.json`（decisioncandidate-only/replayMatchtrue/FP3/realProvidernot-run actualSmokeCalls0）
  3. `evidence/release/documentation/README.md`（装配顺序和校验域）
  4. `repo/docs/todos/2026-10-21-pi-1.3-upgrade-closeout.md` 与正式plan（U7四步x）
- 代码包仍 `evidence/release/r3/candidate.patch` fullsha `3d3813ff6973e41706520181600bbe5b0318ffce5e44a3abbf7aa258f3a70e59`；产品以**R3 fullpatch+同六docs/env+最终文档supplement**装配，不能叠R1/R2/R3 fullpatch。现有replay/repo已经R3，不要再apply代码。
- **最终文档补充包**：`evidence/release/documentation/documentation-supplement.patch`，仅plan/closeout/newreadiness三doc；sha `6635c8b434beac507c58cf6797082ffdfd388113b5f71937923b0c9e8d69209a`。runtime-inputs.sha256为51项（source49+locks2），documentation.sha256为最终3doc，artifact清单316项。原三代artifacts清单17/17/18条均保持全OK。
- parent最终只读自验（补正后）：三代包+doc316项全sha相符、runtime51/doc3全相符、docpatch3header仅声明docs、selfcheck oktrue、16个装配step及其真实.exit逐读全0、两侧FP3相同、U7四checkboxx，errors=[]。未再跑功能tests/Host/npm/网络/模型或引入新review。四次doc装配各因实际文字变更，attempt1/2/3原日志和旧selfcheck都保留，最终为最新self-check.json；无code重新验证伪称。
- 最后文档事实已纠准：原仓唯一授权文件写入是 **/Users/leshi.zhy/pi-config/.pi/handoff/context-handoff.md**，同步 **/Users/leshi.zhy/pi-upgrade-1.3.0/repo/.pi/handoff/context-handoff.md**；不是笼统原仓无任何写入/从未访问。除handoff外原runtime/source/deps/config/入口无升级写入。U1 ls范围偏差有历史披露，非baseline本身。原handoff与副本始终排除产品补丁/指纹。父层本条追加是同一授权例外。
- 回退说明已改成默认继续原1.0.4入口；日后若另开隔离shell试用，正常退出该shell即可。**保留独立root和全部证据，无需删除**，不downnpm/reset/清受管workspace/旧runtime状态。只有自己新建的临时文档校验clone由脚本自建自删。
- 后续仅在用户新指令下重开对应动作：模型选择/独立配置/有限真实调用→U5/U5C/U6；正式试运行需满足ready及选择；commit/push/原环境启用另看真实新授权。本轮没有这些权限，不自动执行。老1.0.4低影响账本继续冻结，不重开A2/F8等建设。

## 新任务接续：重新评估 1.0.4 遗留项在 1.3.0 中的必要性（只读评估，尚未出结论）

用户最新明确要求：“现在可以看一下之前1.0.4遗留的任务了，看看在1.3.0环境中还有没有必要继续完成，还是说已经被升级后的环境吃掉了，没必要了”。这是新的**源码/证据再评估授权**，不是执行旧修复、删除组件、跑测试或修改账本的授权。此前隔离升级交付仍完成，FP3/candidate-only等不变。

- main已告知按当前1.3/.79实际源码+已有运行证据判断关闭/归档按需/保留或继续；“上游完整替代”与“本轮已验证补齐/原条目过期”必须区分，不凭同名feature下结论，也不默认所有技术缺口都要继续。
- **三个新run并行已启动**（cwd独立根，无worktree、模型未手选）：
  1. executor inventory `690295e4-0d28-4f77-aaac-c6a4145cb06c` → `reports/legacy-1.0.4-reassessment/inventory.md` 与 `inventory.json`。覆盖旧outstanding/closure-matrix/三份followups/bug链接+当前closeout，canonical/别名/原需求/账本状态/来源行号，捕捉过期或已完成，F8作/悬分开，旧10skip中的8visual本轮已有证。
  2. delegate recovery-dispatch `53cc5387-5f0a-430f-84ff-2bb35aa141eb` → `reports/legacy-1.0.4-reassessment/recovery-dispatch.md`。主查A2/C1/C2/C3/E1/E2/F8作及关联恢复派发/通知/模型控制。追typedresume是否调用activation/queue、owner/root/child授权、同Hostvs跨Host/持久化范围和上游实际接入，重新核对旧“未替代”判断。
  3. delegate host-runtime `06aa0124-1645-4381-bd9b-e6248542acf7` → `reports/legacy-1.0.4-reassessment/host-runtime.md`。主查E3 pi-c guard、D2scheduler并发、owner/queue/heartbeat父死vs普通结算、TUI/model-label/peer隔离等旧项与旧skip是否已补/可关闭。
- 权威主入口为isolated repo/docs/plans/records/2026-10-17-runtime-convergence/outstanding-items.md、closure-matrix和引用followups。子代理要rg找真实路径不能假定；旧评估只作线索不能照搬，实际target node_modules Pi1.3/subagents.79.2，本仓最新wrapper必须追到公开入口。scheduler仍.1.9，不能因Pi升了就说其并发bug被修。
- 已注入新关键事实：Pi1.3 new/switch/fork/reload重建extension runtime，公开SessionStartEvent.reason/previousSessionFile已用在fixture并真8/8；需评估是否消解旧部分Host恢复需求，但不能将显示8case当14tools恢复。既有supervisor14/completion2/queue28等可用但不加总；真实provider/U8未运行。
- 报告只新写上述仓外paths，不改任何code/旧todos/冻结包/已交付readiness；不运行tests/Host/CLI/模块import/真实模型/MCP/安装/网络，不读auth/models/settings正文或真实session/proof/ledger，不访问原pi-config。main仍可在用户既有授权下追加handoff，两副本保持历史。
- 下一步等自动native结果，不轮询。先收inventory核完整coverage，对比两domain报告有无漏项或互相矛盾；有新独立ready缺口需及时派小诊断或给既有live child明确steer（仅id，不用多locator别名绕gate）。main最终给可关闭/可归档/保留/值得继续的自然矩阵+具体代码/证据引用和最小后续投入建议；不自动修代码、关账本、发reviewer或写实施计划走额外审批。

### 遗留评估：inventory 完成，两组源码报告待返回

- inventory run `690295e4-0d28-4f77-aaac-c6a4145cb06c` 已completed。parent完整read247行inventory.md及解析JSON：主账OUT31项(A1–G3)、矩阵37行、R01–R15/OPF1–F8等全索引；items46/duplicates13/closedOrStale12/missing12/sources26。**46是记录数，不是46独立需求**：含A4=C1、IDLE1010=E1/D1/F4等重复别名。
- 已有可退出开发清单的明确线索：旧push已完成（历史事件+隔离baseline refs相同，不是实时远端fetch）、G1fixture已删24dc、A8F3已行政release、OP F3/R12/F4/R13/F5/R14已完成；OUT F3的8visual由FP3本轮8/8补齐、OUT F8悬由heartbeat prepare-only3/3补齐、旧RPC lane由修fixture缺agents-shared补齐，**不是上游替代**。原10skip另外heartbeat父死/ownerSIGKILL仍未跑，不能自动当必须做。
- inventory揭示重点需源码确认：OUT C4 indexlesssteer提示、OUT D1纯派发回执triggerTurn sender前run关联、OUT D3clear/inspect exactabsence+CAS、OUT G3resolveTargetChild死码、OUT F6历史个案归因；host组B1/B3文档方案有先后冲突（旧bug写detail追加metaLabel，矩阵后来改header删除/footer承载，以代码裁决）；F4多拓扑与E3/D2。
- main曾向两个live delegate补发inventory提示，**错误地重复传dir/id/runId定位字段**；两条均被 `SUPERVISOR_STEER_TARGET_ALIAS` 拒绝，未送达，已向用户说明。**没有改参数重投/绕gate**。原合同本来已要求读outstanding和同domain相关项，仍继续；等报告回收后main按完整inventory验覆盖，不能假称补充指令已消费。
- 当前待回收原有两个source run：recovery-dispatch `53cc5387-5f0a-430f-84ff-2bb35aa141eb`；host-runtime `06aa0124-1645-4381-bd9b-e6248542acf7`。不轮询status。若终态报告真有漏项，再作为新的明确只读诊断需求处理，不能靠改道给被拒run塞同消息。
- 注意inventory缺口中MISS12只是盘点未读仓外readiness.json，不是真证据不存在；main已在上轮交付读验过，当前源文件存在。旧/tmp日志/原repo现场按规未访问，不能为补账去读备份/真实proof/session。旧H2在1.0.4有managed+worktree单拓扑历史证据，目标1.3未跑，不能抹掉历史或外推当前。
- 下一步收两domain矩阵，按需求去重逐项评估。尤其核E1是否已有原生通知而inventoryneedsSourcefalse只表示其ledgerdeferred，不能据此跳过“是否上游覆盖”；D2 scheduler并发不能因Pi升版本被当已修。核心判断仍为公开入口/identity/状态持久化范围/本仓是否真正接入，具体上游完整覆盖才可判吃掉；已完成与无需求归档另列。

### 两domain报告已完成；只剩控制面三个具体判据补核

- 用户再次“继续”。主报告均completed：recovery `53cc5387-5f0a-430f-84ff-2bb35aa141eb` → recovery-dispatch.md（214行）；host `06aa0124-1645-4381-bd9b-e6248542acf7` → host-runtime.md（约32K）。parent用read/存储快照读完两者并独立核验若干source。**未实施任何旧功能/源码或账本修改**。
- 已确定的上游消解项：Pi1.3 coding-agent对内部pi-codemode等精确pin1.3.0（parent read package.json依赖），旧1.0.4 mixed-version bug根因被上游消除，本地两override已删除。TUI fullscreen已有changedRows/previousScreen逐行差分（parent read tui-alt-screen.js1464+），旧“空帧全屏重写”假设过期；每tick仍写sync/cursor，CPU/耗能没有测量，不称全解，不建议继续本仓专项。
- 完成而非上游替代：8visual FP3真8/8、heartbeat正常结算prepare-only3/3、RPC fixture缺agents-shared5/5、详情metaLabel现由presenter.ts316+footer首行消费、detailcontroller719+只滚动header，旧B3已修/旧两方案属先后。B1/B2实现可关闭，目标版专门footer断言/真人观感仍未验，不列继续开发。
- 关键历史定性纠正：C2 sourceRunId/runId错误在**当前producer不可达**（resume-child恒走同Host sink快路径并return），缺handoff字段是latent合同不一致，不先修不可达路径；真实跨Host消费与C1activation仍未接，合并A4/C1/C2/F8作按真实接管需求归档。E2 0.79.2 **显式拒绝** resume.model（parent readsubagent-executor1594+），当前typed也不暴露；接受当前合同可归档，需换模型新start并不等同旧workspace恢复。
- E3 guard在本仓durable-storage82+仍无owner，-c同sessionID不变，**升级没修**；parent不接受“普通使用完全不受影响”过强表述：正常无残留不触发，但已知残留确会阻塞-c，若日常再遇按真实影响提级。用户之前停止，建议留记录/遇到再做owner证据修复，不用TTL。D2scheduler仍.1.9一次loadMap+savewhole+非原子lock(parentreadstores全文)，双Host共享store缺口在，单Host单session现用途不重建存储。
- E1额外parent核验：Pi1.3 ProgramStatusReporter仅agent_start/agent_settled父状态、dialog、compaction→OSC7501，settings有OSC9;4进度；**不追全部child精确活跃集合**，不等同旧macOS全局空闲通知。所以继续作为偏好功能归档，不因原生“done”当被替代。
- 两domain把“session重建后broker/owner/supervisor往返”列新P1观察，但它**没复现bug**；main技术决定应降为下次已获准真实使用冒烟时顺带覆盖，不为此另开大修/验收矩阵。确定的C3 schema误导可能优先于观察项，需要补证。
- **新增唯一active只读补核run** delegate `1f5250ee-0247-46ae-9ede-f8cc75288264` → `reports/legacy-1.0.4-reassessment/control-gaps.md`。原domain D3只沿用blocked未实核、新D1仅notify.details.runs不够证明workflow派发receipt：该run追D1发送前**纯派发vs终态notify**结构化事实、D3当前publicexactabsence/root/CAS资格、附C3合法typedindex是否真被interrupt/stop忽略的路径。不是reviewer，不绕之前被拒steer；新明确诊断scope独立，无code/test/Host/provider权限。
- 已用codemode存 `legacyMainDecisions` 共46个inventoryrecord的去留初稿，当前pending只有OUT:C3/D1/D3。其它按closecompleted / archiveunneeded / localartifact / verificationboundary等区分，别把46记录当独立需求数。若compact导致store不可用，按本条及inventory重建而非重跑诊断。
- 接续：等1f525自动结果，不轮询。parent读验三判据并更新技术决定，整合最终 `reports/legacy-1.0.4-reassessment/recommendations.md/json`（仓外，只整合subagent结论/验收技术决定，可main写），覆盖所有46record/aliases但按真实需求去重展示；保留原三报告/旧账本，不把建议关闭实际写回旧todos。核FP3源码/locks/env未变即可，无功能测试。最终给用户可关闭/归档/保留少量有价值项的清楚表格+链接；重点当前不建议重启旧整套计划，C3若证准确仅参数合同小修可优先，生命周期仅下次smoke带过。不要又问一轮批准，当前只是评估交付，实施另待用户新指令。

## 2026-10-21 最新：1.0.4 遗留在 1.3.0 中的只读复评已完成

**本任务已完成，所有四个评估子代理均终态，无活跃run。** 不再恢复或轮询其历史ID。用户最新“继续”已用于完成报告汇合，不等于实施C3/关旧账本/清理现场/新测试/真实模型授权。

### 最终交付

- 综合建议：`/Users/leshi.zhy/pi-upgrade-1.3.0/reports/legacy-1.0.4-reassessment/recommendations.md`
- 逐记录机器映射：同目录 `recommendations.json`（46个inventoryrecord全部映射，含重复别名，不作46个独立功能统计，待决推荐0）。
- 其余来源报告：inventory.md/json、recovery-dispatch.md、host-runtime.md、control-gaps.md。host/control报告文首已加main验收更正，必须先读再引用原文。
- parent最终核验：dev/replay source49+locks2/env实际FP均 `e7b7d7a62cfa3ba6054f316999c4044357cd445f6bd87ba0677b93b2b42eab2d`；原R1/R2/R3/doc冻结368项artifacthash全部相符；源/锁/env无漂移，未运行tests/Host/CLI/网络/模型/MCP，无commitpush。只写仓外评估报告/用户既有handoff，旧todo未回写。

### 最终技术决定（取代上文pending）

1. **不重启旧整套收尾**。关闭已有完成证据；过期或当前不需要的需求归档；只保留一个近期小修候选 **OUT:C3 interrupt/stop参数作用域**，尚未实施。
2. 上游真正消解：内部Pi依赖exactpin1.3.0让旧codemode混装根因消失，本地override不用恢复；TUI逐行差分令旧空帧整屏写假设过期，但sync/cursor仍写、CPU/功耗未测；workflow-running child完成增量通知上游已triggerTurnfalse，属D1部分改善，非全部receipt噪声已解。
3. 关闭本仓已完成/新补证（非上游替代）：FP3 visual8/8、heartbeat prepare-only正常结算3/3、详情footer metaLabel/旧B3实现、peer/watchdog、session-owner历史三bug、OPF3/4/5/R12/13/14、旧push/G1删除/A8F3行政release、RPC fixture缺agents-shared等。B1/B2实施可收口，真人观感/目标专门footer断言依旧未验，不继续旧开发。
4. C1/C2/A4/F8作归并按真实接管需求归档：typedresume仍不activatequeue，跨Host无消费者；C2旧sourceRunId/runId故障当前producer不可达（resumechild快路径return），不先修latent字段路径。新start普通使用不依赖这些，不能删除root/owner/queue/proof。
5. E2上游显式拒绝resume.model（subagent-executor1594+）不是参数过滤待打通：接受现合同归档，换模型新start可做，但不等旧workspace恢复。E1严格allchildren-idle通知未被nativeagent_settled/OSC父状态覆盖，偏好功能继续暂缓。
6. E3guard仍无owner、-c同sessionID，所以没被修。main已纠正“普通使用完全不受影响”：无残留前提正常，残留确会阻塞日常-c；此前用户停止，留记录实际再遇按影响提级，不加TTL/擅自清理。D2scheduler仍.1.9缺共享storeCAS，单Host现用途不重建存储；多Host/store真需求再做。A2缺件诊断按需，failclosed保留。
7. **D1已补核清楚**：workflow-root dispatchcomplete与child终态通知共享notify sender，发送前details.runs身份关联现在有（旧blocked原因部分解除）；缺“相对tool结果无新增”结构化字段，idleparentWake已内部改为sendUserMessage，host/membrane只翻triggerTurn无效；还需考虑unanswered记账。建议低优先级归档，不抄一个本地抑制策略或第二sender。
8. **D3补核报告有两处main纠正**：当前请求登记是message_end+awaitedbefore_agent_start两个入口，不是仅message_end；policy识别administrativeResolution仅预留，**durable request V1/V2类型+exactparser拒该字段**（supervisor-control-plane7/65/107），全文命中该字段只policy，不能说硬前置全就绪/只差producer工具。原exactobserver/challengeCASaudit合同仍未覆盖，TTL降低紧迫性不等于clear已实现。gate-onlyclear是另一语义，不据此宣布原blocked已解；最终D3归档待需，不新增clear。
9. **C3静态确定且值得小修**：typedinterrupt/stop共用TARGET_FIELDS允许index，上游interrupt/stop分支不吃index（interrupt不支持workflow；stopchildscope用childId而typed未暴露）。建议先删除/拒绝无效index+description明确run级；resumeindex和steer门禁保留，不顺手新增childId或新控制框架。未跑多child实验，不声称发生过误停止。
10. session重建后业务typed活动集/broker-owner-supervisor往返仅为**下次已获准真实使用冒烟顺带观察**，没有复现bug，不单立P1工程；先排C3确定契约问题。T25C/ownerSIGKILL/其它拓扑不为填skip跑，F6历史个案无同次证据不追认已修，S6evidencegap永久记录；原现场A3/A5/A6/F5/opF7不清理，G2/G3死码低优先级可选cleanup。

### 接续边界

最终给用户清楚去留表和综合报告链接即可；评估建议不等于已经回写关闭旧todo。若用户下一步明确要“按建议收口/修C3”等，再按新的具体授权派发；不为评估任务自动发新计划/reviewer/测试/真实模型/commitpush。原升级候选交付仍candidate-only，真实provider/U8未做，原1.0.4运行面未切换，handoff继续是用户明确文件写入例外。

## 最新接续：真实链路验收已获授权，模型已指定，等待限定配置迁移决定

用户随后明确要求「执行真实链路验收」，再指定「用deepseekflash」。**本轮有限真实调用已经授权，精确模型已确定为 qoder-pool/DeepSeek-Flash；不要再次询问这两项。** parent 和 generic/coding child 都绑定该模型，child 使用 executor。用户尚未授权切换原环境、升级候选commit/push、修C3、新自动测试或危险实验。

已完成两个诊断子任务，均已收到完成通知，无活跃run：
- e2e99264-455a-4691-b148-6124bb3a46ae：运行输入/启动入口预检，报告在独立根 reports/release/real-chain-r1/preflight.md/json、fingerprint-check.json。
- fb5daf19-37f9-43a0-8db8-bee66ac75697：所选provider接入路径诊断，报告同目录 provider-path.md/json。
- main新增selection.json与status.json，后者为最新决策入口，状态 blocked-on-provider-configuration，验收Host启动0/实际验收provider调用0；历史FP1 provider选择/准备/冒烟报告和所有冻结包未改。

已证：dev/replay FP3 两侧均一致（49source/2lock/9版本/env/baseCommit）；dev的2份doc漂移精确匹配U7文档补充附件，不使FP3失效。launcher从自身求根；agent从PI_CODING_AGENT_DIR发现；source replay/env末尾会cd到replay/repo，所以必须source后再cd trial-project。无需重跑已绿安装、U2、U4。

真实阻塞具体为：qoder-pool并非内置/扩展provider，而是机器级models.json自定义项；transport由api、端点由baseUrl决定。当前禁读原models/auth，不能猜这些值。replay实际provider配置/认证未准备验通。通用/login只给自定义provider输入API key，不会自动生成provider定义或账号池OAuth。child不会继承parent --api-key，须独立agent-dir认证来源。只核名称和pi auth check不带--credentials；禁止print-api-key等输出秘密命令。

下一步问用户是否准许**仅提取原环境qoder-pool/DeepSeek-Flash所需provider定义及认证项，写为replay/repo/pi中的隔离副本**，原文件只读、不整份复制其它providers/settings/models-store/sessions，不将认证值输出给模型或日志。这是当前禁止复制原auth/models约束的小范围例外，须明确决定。或者用户自己提供非敏感baseUrl/api与replay自有凭据来源。不要重复追问是否允许调用、使用哪个模型或要求贴key。

main技术说明：provider-path中“凭据必须全新/只能人类重输”是当前禁读复制范围下的路径，不是产品要求不同账号/不同key。用户若明确授权限定迁移，允许同账号的本地隔离副本；必须检查动态!command/$ENV是否还指回原环境，不能伪称完全独立。以status.json的补正为准。

过程偏差保留：模型补充steer因同时传多定位字段被控制面拒绝，未送达（SUPERVISOR_STEER_TARGET_ALIAS），没有绕过重投；首份preflight模型未知仅是其当时合同状态，已由selection.json补充。第二诊断违反任务“禁跑Node”做了一次原目录node -e读取已安装package.json版本，仅只读元信息，无Host/模型/网络/写入/配置访问。不得据此放宽原环境边界。

获得配置迁移/独立配置输入后，按既有U5C→U6继续：限定配置准备和名称/认证就绪核验，再新建replay/trial-project最小Git README基线；真实parent一普通回合，generic executor一次派发及父续跑，coding executor README一个确定改动且queue正常自发布/集成/released，parent正常退出，核实际模型、processTerminal/proof、queue/workspace、usage。只有这个trial项目的初始commit/child集成在授权内，原仓/升级候选均不能commit。实际失败留failed，不换模扩测。新报告仍放real-chain-r1，不改历史FP1/冻结artifact；交付层次到真实验收通过再据证据更新，不自动U8/切换。

### 最新推进：限定迁移已获准且完成，U6 真实验收正在执行

用户已明确回复「允许」，限定配置迁移不再阻塞，也不再追问调用/模型/配置许可。U5C delegate 6eb06286-f5ca-4132-bf65-ce1558670201 已收到终态通知，main已完整读验新 provider-readiness.md/json：
- 仅qoder-pool服务级定义（openai-completions）+1个DeepSeek-Flash模型+该provider一条api_key迁入replay/repo/pi。
- 认证为literal，无动态ENV/command或原文件引用；目标models/auth文件0600，原两源前后hash不变；没有复制其它provider/settings/models-store/sessions。公开list-models与auth check均exit0，localready，实际provider调用此阶段0。
- dev/replay均重算FP3一致；tracked源码/profiles/旧冻结报告未动；原目录没有为迁移启动进程或写配置。既有replay/repo/pi目录0755未改，私密文件0600。
- main不读取认证正文，后续也不能打开/打印任何auth/models敏感内容。

**当前唯一活跃执行任务：executor 8aa26d85-4d84-4d8f-9410-a94d63ce2187，U6真实parent+两child验收**，model=qoder-pool/DeepSeek-Flash，cwd独立根，writePaths在replay/trial-project/sessions/state/cache/config及本轮reports/logs。不要poll状态；等完成通知或实际supervisor请求。
- 用户授权支持试验项目README初始化commit与child正常queue自发布/集成；禁止候选/原仓commitpush。
- 真实typed工具必须来自新起physical1.3.0 parent，不能拿当前外层旧Host派发当验收。
- main技术决定允许复用已有PTY或公开RPC助手顺序驱动，RPC必须报告RPC真实使用，不能冒充真人TUI。不新建test/fixture/provider/control框架。
- 三场景固定：parent inline读README回复PARENT_CHAIN_OK；generic executor只读README返回GENERIC_CHAIN_OK并自然唤醒父续跑；coding executor托管worktree仅给README追加「验收模型：qoder-pool/DeepSeek-Flash」，现有child-owned queue正常集成released。parent和child实际模型均须核验，正常退出/reap与terminal/workspace proof留证。
- 真实失败必须分类并留failed，不自动换模/盲目重试/扩场景/修源码。无真实结果前不改变candidate-only。
- executor将新增本轮real-smoke.md/json并更新status.json；原FP1/U7旧report和冻结包不覆盖。完成后main按实际结果整合最新readiness，必要时只增加real-chain-r1下新readiness记录，不改旧证据为通过。U8/正式入口切换仍不自动执行。

### U6 R1 已实际执行：普通与 generic 通过，coding 未正常集成，正做只读归因

2026-10-22 最新状态取代上文“等待真实结果”：
- 真1.3.0 parent session：replay/sessions/2026-10-22T07-43-52-890Z_01a16291-0239-70a1-9d3b-d17bd224dac0.jsonl。实际读README并回复PARENT_CHAIN_OK。
- generic真run09c27da3-ac9c-4a7c-a0b2-95ae21126f19，complete，run-level processTerminal observed/runner exit0/signalnull，输出GENERIC_CHAIN_OK；父无新用户prompt自然续跑GENERIC_PARENT_CONTINUED。parent/child实际注册模型均qoder-pool/DeepSeek-Flash。
- coding真run10c0ef0a-e363-4273-9b0d-970ceb8399dc、workspace d77b5057-f034-4d96-bd15-21bea05987ab，publicationallowed，child正常exit0，只追加README目标行但没commit。driver生成给child的task只说“如需git提交…”，未明确正常提交/自发布要求。queue advance-error：workspace admission requires the authorized clean committed HEAD。
- runtime生成handoff要求父接管commit再送mergequeue，父按此在worktree提交0a6e71d，尝试managed_workspace_dispose(integrate)被CHILD_OWNS_INTEGRATION拒。main trial HEAD仍a4ca16c，README没集成，workspace保持active。没rawmerge/cherry-pick。该轮coding未通过，不得改写为pass。
- executor的一次性RPCdriver（reports/release/real-chain-r1/u6-drive.py）只等CODING_PARENT_CONTINUED，明明父已settled失败却会多等900秒。main因needs_attention读原始RPC、精确进程树和两child terminal后，校验PPID/命令身份，仅对一次性Pythondriver PID60672发SIGINT，使其已有finally关闭stdin。真parent和两child均自然exit0/reap，无目标Host存活；未对parent/child发信号、未interrupt外层executor。不是来源不明SIGINT，executor已通过supervisor reply获知。
- main的steer再次因typed目标alias控制面拒绝而未送达，不绕过重投；实际决策已针对收到的supervisor request a73409b1-0e01-4683-80d6-240d785bc122 通过supervisor_request_reply提交。选择A：本轮failed留证，普通/generic单项pass，停止该轮真实调用，不处置残留workspace，不启动旧F8/resume接管，不修production。

当前协调任务：
1. 外层executor8aa26d85-4d84-4d8f-9410-a94d63ce2187 正按reply收尾本轮real-smoke.md/json/status失败报告，完成通知未到前不poll。
2. 新delegate7ce10a86-591b-4e30-8912-27ed49fcdf0e 已启动只读coding来源/正常路径核对，写本轮coding-path-analysis.md/json，无Host/模型调用/代码状态修改。任务要求还原child收到的真实system/task/工具、dirty门禁和handoff/父权限链，判定正常路径最小要求及下一轮coding-only补验方式；不把所有真实验收异常误归fixture，更不能未证就加生产fallback。

下一步：先读R1失败报告与coding-path-analysis；若源证明确只需把正常提交/自发布合同写清，可在既有用户授权内派一次有界coding补验，保留R1失败，不重复已过普通/generic，不扩到旧F8恢复/新框架。若必须改生产，先完成数据分类和具体最小范围决定。残留workspace保持现场，不能由新root跨scopepreserve/release或rawgit集成。当前ready结论仍candidate-only，原入口未切换。

### 最新：归因完成，R2 coding-only 真补验已启动

R1 executor8aa26d85已终态并写 reports/release/real-chain-r1/real-smoke.md/json/status。native通知为failed表示其场景未通过，不是偶发provider故障，不要resume重放。main已读验并独立解析三session：parent15+generic2+coding8=25条完成的assistant生成，全部provider/model精确DeepSeek-Flash，无error/aborted消息；该口径不证明SDK内部HTTP重试数或账单。两个child run-level terminal observed/code0/nullsignal。R1原始failed永久保留。

归因delegate7ce10a86已终态，报告 coding-path-analysis.md/json：
- 机械integration lifecycle只在agent_end推进，不自动gitcommit；child必须先自己commit。R1task的“如需commit”遗漏了正常验收所需义务，child合法不commit，触发正确的clean-committed-HEAD门禁。
- runtime handoff要求父接管commit再送queue，但父integrate硬拒、child已退且authorizedHead只能由其lifecycle刷新，是真实production可达的合同缺陷，与旧冻结F8接管同族。不是fixture污染，不放开父integrate，不新增fallback/自动提交/恢复框架。本轮不修该旧族问题。
- 旧trial的唯一非终态FIFO队首queued会阻塞新项；补验必须新Git common-dir，不处置R1workspace/queue。
- 正常显式childcommit可在不改production/profiles/ceiling/FP3下补验。publishedArtifact可null，以integrationReceipt/目标mainHEAD/queuecompleted/terminalproof/released为权威。

补验准备executor a899a766已终态，写 real-chain-r2/coding-drive.py（sha256 754143567bebe9738a5d5169b392c3d56b0bceb27ee04250b7273a33b262e6d0）、execution-method.md/json，仅静态pycompile，无Host/真实调用。main读验全文件，复用R1 Driver class，不改旧方法/证据；新childtask明确自己gitadd/commit README并给SHA，父只能只读status，禁止代提交/dispose。等待不绑定自由文本token，允许合法rebase SHA变化/暂态reminder，核心看终局数据。main发现文档source后相对reports路径错误，已在真实执行合同纠正为绝对脚本路径（不需要改driver）。

**当前唯一活跃run：executor c82d4228-6deb-437f-93da-a456bd0d76bc，U6 coding-only R2真实补验**。cwd独立根，model qoder-pool/DeepSeek-Flash，Host总槽1，使用新replay/trial-project-r2；source独立环境后才gitinit/局部identity/README初始commit。唯一新parent+一个coding executor，禁止重复R1普通/generic；实际脚本执行一次，记录真实退出码，不用管道tail/timeout杀组掩盖。输出reports/release/real-chain-r2/coding-smoke.md/json、status、coding-evidence.json和新logs；R1所有报告/状态/现场、原环境与FP3/冻结物不变。等完成通知，不poll；失败只留证不边改边跑、不进入F8或自动换模。

main额外验收事实/后续需补正：R1公开RPC get_state的model对象确有baseUrl字段（只核字段存在性，没有打印值），apiKey/headers字段不存在。因此R1报告“原始日志不含端点”过度陈述不准确；非敏感provider端点元数据不等同认证泄漏。R2合同允许原始RPC保留非敏感model metadata，认证值不得入prompt/log/chat；必要时仅用隔离auth对应key做内存扫描输出布尔。最终汇合用main追加说明，不改R1原始证据或夸大安全事件。

接续：R2完成立即读验实际证据、source/旧R1不变与自然退出，不能只信script code0。若正常coding通过，把R1普通/generic与R2coding分别映射到相同FP3正常使用覆盖，明确跨round/不同session，不改写R1失败、不加总测试数字。可以据整体证据新写本轮最新readiness记录，保留旧U7/冻结物历史candidate-only。真实未全部证实前不预先升ready；即使正常链通过，F8/handoff缺陷、R1active失败现场、C3和真人TUI/未验边界仍准确保留。原1.0.4不切换，U8不自动执行。

## 最新完成状态：真实正常链验通，已交付 ready-for-isolated-trial

**本轮用户“执行真实链路验收”任务已完成。全部子代理均终态，无活跃任务、无业务验收Host。不要恢复/轮询这些历史run，也不要重复询问模型、调用许可或限定迁移许可。**

最新权威入口（原U7旧candidate-only是历史快照，不覆盖）：
- /Users/leshi.zhy/pi-upgrade-1.3.0/reports/release/real-chain-final/readiness.md
- 同目录 readiness.json（sha256 f5e5ad5b279a9ec51f303a88c2561c6a4a9d17a996dec2c5ee5ccb797f88dd38）
- 同目录 final-verification.json（sha256 897f1768123122345307bb3b213c113106826c2822eb8f9eec12a8e8a971916b）、artifact-notes.md、delivery-check.json
- 正式结论 **ready-for-isolated-trial**，仅当前replay/DeepSeek-Flash的正常路径、附已知限制；未正式切换原1.0.4、未启动U8、未commitpush候选。

R2真实补验executor c82d4228已完成，main读验原报告/证据并经独立最终核验：
- 新trial replay/trial-project-r2（commonDir与R1不同），基线8e18d433052cc3f7e39e27626944e49c3ba37b42，主分支最终83e6e436ca90850ea7fe7a7eda438b8edbc0e056，只有README一行新增，clean/staged0。
- parent session01a162b2-4f64-7111-8a13-357d994e71dd（replay/sessions/2026-10-22T08-20-15-333Z_…jsonl），child8314e26f-2311-48f6-bf04-c894ca62f7d4；parent5+child10条完成assistant生成，所有p/model精确qoder-pool/DeepSeek-Flash，不等HTTP重试/账单，不与R1测试数相加。
- child自己gitadd/commit83e6e43，queue25959373-8ce7-4ca9-bb2e-f88c99e7be31 completed/admissionGeneration1；workspace20267f07-907c-4bf2-8dec-6ba1e41cbb9e released，integrationReceipt426f081b-10c3-4c06-a60e-110ac5810305的candidateHead等mainHEAD，terminalproofd982b578…observed，outbox无pending/debt。
- 现有lifecycle自动集成与清理，无父git写/集成/处置。parentexit0+EOF、childrunlevelobserved0/nullsignal，worktree/branch自动删除；精确PID76582/76565均不存在。
- released后managed_workspace_status按既有行为isError=true“终态不可查询”，未改写此回执为工具成功；用ledger+receipt+Git+清理交叉证实终态。publishedArtifact可null，不能据此误判失败。

最终静态核验executor1da41741已终态：
- dev/replay实际source49/49、lock2/2、env/base/9版本无漂移，FP3仍e7b7d7a62cfa3ba6054f316999c4044357cd445f6bd87ba0677b93b2b42eab2d；两份dev纯doc漂移精确为既有U7附件，不进指纹。
- 四份冻结artifact manifest共368项（17+17+18+316）全部hash相符、0缺失/0不符。R1原报告/日志/driver/activeworkspace/queue/branch内容不变。
- R2importlib曾在R1目录新增唯一自产pyc，已按main限定决定验证magic/source-mtime-size/uid/nlink/birth窗口等后移动至real-chain-r2/auxiliary-cache/u6-drive.cpython-313.pyc，空源__pycache__目录rmdir。pyc前后hash2d865c821d49a95826ca32988f5a70fb43ba9a4992c353404895067c22213063，不把事后归位说成R1目录从未新增写入。
- 报告中的非敏感get_state baseUrl元数据、版本号对象（pi-subagents0.79.2 vs enhanced0.1.0）、raw1146行 vs recordCount1147等errata记录在artifact-notes；没有重写原始协议/旧失败记录或夸大凭据泄漏。
- main装配自检 passed：5个文档链接都存在，正式decision正确，final验证hash绑定正确，R1依然failed/R2passed，未外推一次会话三场景全绿/全仓绿。没有为收尾重跑功能测试/模型/Host。

最终覆盖矩阵必须按round分述：
- R1 parent普通读README passed，generic child+父自然续跑 passed。
- R1 coding failed **永久保留**，workspace d77b5057仍active、queue8a22ab7b仍queued、父worktreecommit0a6e71d未进入旧trialmain。保留失败现场，不跨root处置。
- R2仅一次coding正常提交/queue自集成/释放 passed，无production修改。不是把R1failed改绿，不是全仓/所有角色/真人终端已验。

实际限制仍保留：
1. coding交付必须明确授权并要求child在自己的managed worktree里commit后结束，生产不auto commit。
2. 未提交就退出后的handoff/typed-resume接管生产合同缺口已被R1真实证实，属旧F8族；会留queued队首阻塞同仓后续发布。本轮不修恢复、不放松parent integrate，不新建fallback。
3. C3 interrupt/stop的index作用域未修，应按run级理解。
4. 真实使用是RPC；U4既有PTYvisual8/8与helper4/4分别保留，未真人TUI/U8、MCP、父死SIGKILL、长结果、多provider或切会话后完整业务往返。本隔离配置只迁入DeepSeek-Flash，真实child仅executor；reviewer/其它角色工作流没扩配验收。
5. U2合同13/13实际属于FP1并按闭包proved-unchanged，不改归属；U4R3为FP3，所有计数不机械加总。

若用户接下来要求开始隔离试用，已有模型/配置明确，无需再问这些输入。已验证入口：
bash --noprofile --norc
source /Users/leshi.zhy/pi-upgrade-1.3.0/replay/env/isolated-env.sh
cd /Users/leshi.zhy/pi-upgrade-1.3.0/replay/trial-project-r2
zsh -f /Users/leshi.zhy/pi-upgrade-1.3.0/replay/repo/scripts/pi-launcher.zsh --no-mcp --no-approve --provider qoder-pool --model qoder-pool/DeepSeek-Flash --session-dir /Users/leshi.zhy/pi-upgrade-1.3.0/replay/sessions
这是未来用户入口，本次未执行U8。原1.0.4入口/源码/依赖/配置仍无升级写入；原handoff是持续的用户授权文档例外，原models/auth只作已授权限定提取且前后hash不变。所有Git提交仅在两个明确授权的试验项目。不要自行正式切换/合并提交候选、扩旧遗留修复或清理失败现场。
