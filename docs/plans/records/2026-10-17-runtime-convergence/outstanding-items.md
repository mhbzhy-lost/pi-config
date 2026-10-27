# 遗留事项统一清单（2026-10-21 收口）

> 本文是本轮 runtime 收口后的**唯一遗留清单入口**，按“谁能解除阻塞”分类，不按时间排列。每项给出状态、坐标/证据、以及推进它所需要的确切条件。
> 基线事实：全量 integration gate **0 fail**（`/tmp/rc-gate-final.log`：42 文件、344 tests / 334 pass / 0 fail / 10 skipped、876s、`GATE_EXIT=0`，排除清单为空）；本批自 `92b0302` 起 41 个提交，`main` 相对 `origin/main`（`a9875d6`）**ahead 89**，未 push。
> 细节证据见同目录 `integration-gate-baseline.md`、`f8-takeover-gap.md`、`contact-supervisor-runid-triage.md`、`session-owner-wrapper-triage.md`、`steer-locator-contract.md`、`closure-matrix.md`。

> **当前状态指针与冻结说明（2026-10-21 Pi 1.3.0 升级收尾追加；正文逐字保留、不逐行改写旧数字）**
>
> - 本文正文是 **1.0.4 运行时收口轮**的历史账本，只供追溯。正文中已过期的表述**保留原样**，引用前必须先叠加下列更正：`A1` 的「ahead 89 / 未 push」已过期（`main` 与 `origin/main` 同步在 `35e3e77`）；`G1` 孤立 fixture 已于 `24dc18a` 删除；`F8` 编号在两份账本里指两件不同事项（本文 `F8` = R10 heartbeat 正常结算复跑；`2026-10-16-subagent-operation-followups.md` 的 `F8` = 五-child「主 Agent 接管」验收），引用一律带账本前缀。
> - **冻结清单（1.0.4 小补强冻结）**：`A2` 启动诊断顺序、`C1`/`F8(作)` typed resume → activation 与跨 Host handoff（含 `C2`）、`C3` child 作用域、`E1` 空闲通知、`E2` `resume(model)`、`E3` `pi -c` guard、`D2` scheduler 并发，**均不再作为 Pi 1.3.0 升级前置，也不再逐项等待用户旧裁决**；恢复讨论的唯一触发条件是「Pi 1.3.0 目标版实际需要」，届时另立合同。`F1`–`F7`、`F9` 等证据/授权阻塞项同理维持冻结。
> - **独立清理事务**：`A3` 未跟踪 observation 文件、`G2` probe dead 分支、`G3` `resolveTargetChild` 死码可清，但属**独立事务**，不带入升级 diff；无证据支持删除任何大领域模块（root broker、workspace/queue/proof、session-owner、typed tools、heartbeat 全部保留）。
> - **现场事务独立**：本文涉及的 observation 未跟踪文件、`pi/crashes.json`、models 备份、4 个旧 heartbeat 证据根与 3 次 probe 临时现场，全部**原地保留、不复制**到升级 checkout；原仓 `pi-config` 未被本次升级访问或修改。
> - 升级侧的当前结论、三处必要生产适配与逐轮定向验收证据见 `docs/investigations/2026-10-21-pi-1.3-combined-assessment.md` §8 与升级收尾唯一入口 `docs/todos/2026-10-21-pi-1.3-upgrade-closeout.md`。

## A. 需用户一句话裁决（阻塞在主会话，未裁决前不动）

| # | 事项 | 现状与坐标 | 推进条件 |
|---|---|---|---|
| A1 | **push** | `main` ahead 89（本批 41）。全部工作已提交，工作树只剩 B/C 类未跟踪物 | 用户授权 push；不自动 push |
| A2 | **required-child 校验顺序的可诊断性**（生产） | `src/subagent-dispatch/extension.ts:2102` 的 `registerRequiredChildExtensions` 校验早于 `:2113` 的 `beforeSessionStart`；缺件时 upstream session_start handler（`node_modules/pi-subagents/src/extension/index.js:816-845`、`:1041`）整体不执行，外部症状退化为 `no_active_session` / `WORKSPACE_SERVICE_UNAVAILABLE` / `missing: rpc:v1/session`，而不是“缺 agents-shared”。本批 **5 个 lane** 因此绕远路 | 裁决是否把校验移到 `beforeSessionStart` 之后，或降级为非致命 + 明确诊断。裁决前保持 fail-closed，不加兼容分支 |
| A3 | **两个观测文件删/移** | `test/fixtures/subagent-rpc-bridge-observation.mjs`（152 行）、`test/subagent-rpc-bridge-observation.integration.mjs`（207 行），均未跟踪。门禁 runner 按 glob 选文件，**未跟踪也会跑**：本轮日志 `rpc-bridge-observation` 命中 19 次、tests 342→344 即来源于它，每次多启动 2 次真实 Host，且 form1 故意复现“bridge 未 primed”形态；其断言只有 2 条（fixture 名 + 存在一条 session-start ping），**bug 在或不在都绿**，无回归价值 | 裁决：删除，或移到 `scripts/probes/`（门禁 glob 选不到）。常驻回归保护已隐式存在于 `test/pi-subagents-runtime.integration.mjs:143`（bridge 未 primed 时 `compat_spawn failed` 直接红） |
| A4 | **F8 接管验收** | 诊断证明链路不通（见 C1）。选项 (a) 按前置 1→5 实施 / (b) 只做 1，把两处协议不一致单独立缺陷 / (c) 暂缓并登记为已知生产缺陷 | 用户选 a/b/c。未裁决前不改生产 |
| A5 | **保护现场处置** | `pi/crashes.json`、`pi/models.json.bak-qoder-thinking-20261016161901`（未读取正文、未动）；4 个旧 heartbeat 证据根；3 次 probe 临时现场（`…-Xkd9TF`、`…-XYRn5V`、`…-RrLPSD`，含真实模型跑出的 worktree/queue 证据） | 用户决定保留或清理；不 raw 删除、不自动清理 |
| A6 | **非本会话产出物的归属** | `.gitignore`（+1 行 `/skill-overrides/deepseek-search/.env`）、`skill-overrides/deepseek-search/`（`SKILL.md`、`deepseek.py`、`references/`）、`docs/investigations/2026-10-21-pi-1.3.0-upgrade-assessment.md` —— 三项均非本会话 child 产出（writePaths 不覆盖），主会话未读正文、未提交、未改动 | 用户自行提交或指示处置 |

## B. 需用户后验（重启 Host 才能观测）

| # | 事项 | 预期观感 |
|---|---|---|
| B1 | 详情面身份行改由 footer 承载（`6b1827e` + `e3d20b4`） | ctrl+O / Alt+O 进入详情面：**首行不再有** `› ● 任务X · 运行中 …`，只剩 `行 a-b/n · 跟随底部 · x 展开`（过期来源追加 `· 过期观察`）；所选任务的 `n/N ● 标题 · 状态 · 模型 (provider) id · thinking: level` 出现在**面板下方 footer 首行**；footer 仍 3 行，超宽走既有截断，无模型信息时不留悬空 `·` |
| B2 | footer 常驻元数据后保留一个空行（`fea49cd`） | 常驻元数据与动态内容之间有一个空行 |
| B3 | subagent 详情模型显示（原 bug `2026-10-19`） | 模型标签在 B1 的 footer 首行可见；若不可见按新 bug 提 |

## C. 生产已知缺口（需立项，未实施）

| # | 事项 | 坐标与事实 | 备注 |
|---|---|---|---|
| C1 | **F8：typed resume 未接 workspace 恢复** | `src/subagent-dispatch/extension.ts:1441` 的 `executeControl()` 对 resume 只校验 message 后调 `rpc[action](params)`，成功分支只取新 run ID 与继承 title；**未查询/消费 resume intent、未调 `activateResume()`、未重绑 workspace/queue**。底层能力齐备但无 typed 调用方：`workspace/coordinator-client.ts:99`、`coordinator-server.ts:459`、`service.ts:250`、`integration-queue.ts:210`、`coordinator-proof-outbox.ts:90` | 前置修复顺序 1→5、fail-closed 清单与未验证项见 `f8-takeover-gap.md` |
| C2 | **两处协议不一致（handoff 到不了 root）** | intent 用 `sourceRunId`（`recovery-resume-contract.ts:38`，pump 原样展开 `coordinator-server.ts:294`），而 `root-broker-server.ts:1226` 按 `event.runId` 选订阅，缺字段落入 `root-not-subscribed` debt（`:1228`）；`root-broker-server.ts:1224` 输出 `handoff`，但 `root-broker-protocol.ts:426` 字段表无 `handoff` 且 `:440` 用 `exactObject()` 严格解析 | 属 C1 的前置 2 |
| C3 | **`interrupt`/`stop`/`resume` 无 child 作用域** | `extension.ts:1527` 直通 `rpc[action](params)`，不共享 steer resolver，接受 `dir`、不产生任何 `SUPERVISOR_*` 码；child 级隔离只存在于 steer（`extension.ts:1476-1487`） | 产品语义问题，未裁决前保持现状 |
| C4 | **upstream steer 提示与本合同相反（无法在本仓修）** | `node_modules/pi-subagents/src/runs/foreground/run-status.js:348`、`:746` 给出 index-less 的 `Steer` 提示；upstream 语义是 index 缺省 = 向所有 running child 广播（`async-steering-action.js:115-119`）。本仓已把 `index` 收紧为 steer 必填（`cd06cf9`），raw payload 不得为展示而改写（仓库根 `AGENTS.md` TUI 精简边界） | 登记为已知冲突；只能由上游改或本仓 fork 该提示 |

## D. 上游阻塞（不改上游无法推进）

| # | 事项 | 解阻条件 |
|---|---|---|
| D1 | R02/F2 纯派发回执选择性关闭 `triggerTurn` | 上游提供**发送前**稳定的 receipt/run 结构化关联；发送后事件与文本正则不能当安全选择器。不改上游、不建第二 sender 绕过 |
| D2 | R04 scheduler 并发 | 上游 store/lock owner 与产品语义决定（`docs/bugs/2026-10-13-scheduler-store-concurrency.md`、`scheduler-provenance.md`） |
| D3 | R07/F1 Supervisor `clear`/`inspect` 逃生口 | 上游提供可证明的 exact absence / root ownership 接口；exact absence 无法证明前不实现 |

## E. 用户暂缓（解除前不动）

| # | 事项 | 现状 |
|---|---|---|
| E1 | R01 主会话空闲系统通知 | 用户明确暂缓；实现未开始，接口资格仍有缺口。解除前不建常驻重试、不自动调用 `osascript` |
| E2 | R03 `resume(model)` 真正换模型 | 待独立立项；核心事实：revive 复用 canonical 旧 sessionFile，SDK 有显式 model 能力，但上游 resume 参数过滤与启动合同未打通。不用 warning 兜底 |
| E3 | `pi -c` durable guard | 用户明确停止处理（`docs/bugs/2026-10-18-pi-continue-durable-guard.md`） |

## F. 证据/授权阻塞（需单独授权或新证据）

| # | 事项 | 缺什么 |
|---|---|---|
| F1 | T25C 真实 Host 进程级崩溃（SIGKILL）恢复 | 危险实验，需单独授权。七个 settlement 窗口已由 `test/workspace-disposition-settlement.integration.mjs` 12/12 覆盖（临时 Git/state/socket，无 SIGKILL） |
| F2 | `session-owner-runtime` 的 SIGKILL 用例 | 门禁 skip：`test/session-owner-runtime.integration.mjs:518` 体内 `t.skip("fixture-sigkill 尚未授权")`，受 `PI_TEST_OWNER_SIGKILL=1` 门控 |
| F3 | 8 项真实后台活动视觉快照 | 门禁 skip：`test/background-activity-visual.integration.mjs:84` 受 `PI_TEST_BG_VISUAL=1` 门控 |
| F4 | R08 heartbeat / R11 session-owner 其它拓扑覆盖 | blocked-evidence：核心父死证据已有，其它拓扑无证；不新增危险实验（`lifecycle-boundaries.md`） |
| F5 | R09 旧 heartbeat 证据根清理 | blocked-recovery：旧 owner 已死且无当前合法 public 出口；不 raw 删除、不猜 token |
| F6 | R05/R06 历史 RPC / Supervisor 个案归因 | blocked-evidence：需要同次失败的非敏感字段链（`historical-provenance.md`） |
| F7 | R15/S6 精确 24 文件清单 | evidence-gap：现存 TAP 日志只有失败项带文件路径，**不可还原**；保留历史 492/492 为报告值，不重跑猜测 |
| F8 | R10 heartbeat 正常结算 Host 复跑 | local-fix-ready：fixture 已迁移 read/commandsRun 逻辑，正常结算 Host 未重跑 |
| F9 | 五-child 真实模型验收 | 原场景 obsolete-by-user-decision（child 不保活）；若要验收“五个成果都进 main”，只能经 C1 的接管路径，属 F8 立项 |

## G. 孤立 fixture / 死码（owner 决定删或留）

| # | 事项 | 事实 |
|---|---|---|
| G1 | `test/fixtures/recovery-resume/scripted-model-server.mjs` | 全仓无消费方，属孤立 fixture，无法行为验证 |
| G2 | `scripts/probes/dispatch-branch-probe.ts` | 死路径，由 owner 决定 |
| G3 | `supervisor-gate-policy.ts:551-566 resolveTargetChild` | 本轮确认为**死码**：无生产调用方（仅定义与 `test/supervisor-gate-policy.test.mjs`）；`:558` 要求 `complete === true`，而 `:164-166` 明说无 public 来源可证完整性；控制面 runtime 只有 `{runId, ownerGeneration, liveRunEpoch, running, steerable}`（`supervisor-control-plane.ts:174`、`runtime-state.ts:13-25`），没有 children。删除或保留待 A2/C1 路线确定后再定；**不得**通过放宽 `complete` 前置来激活它 |

## 交付边界（不变）

不自动 commit/push；`pi/crashes.json` 与 models 备份未读取正文、未自动清理；handoff 只 append-only 追加，原历史正文逐字保留；受管 workspace 不用 raw git 处置。既有测试/断言/fixture 的修改只为迁移已证生产合同或落实用户裁决；新增测试仅在用户明确授权下进行（本批唯一授权项为 `test/workspace-disposition-settlement.integration.mjs`）。真实 provider、SIGKILL/危险实验与全仓 glob 回归仍需单独授权。
