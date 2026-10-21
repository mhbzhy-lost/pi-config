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
