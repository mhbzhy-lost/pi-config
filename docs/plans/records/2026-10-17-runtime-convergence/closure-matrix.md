# Runtime Closure Matrix

> 当前收口矩阵。`completed` 只表示该条边界已有对应实现/证据；`local-fix-ready` 表示本地实现已写入但缺独立行为证据；`blocked-*`、`deferred-user`、`user-post-check` 不升级为完成。

| ID | 当前状态 | 证据 | 未完成/解阻条件 |
|---|---|---|---|
| T1 code_mode | completed | `codemode-discovery.md`；model-only 合同 | 不扩 exposure |
| T2/T3/T3E/T4 policy | completed | `runtime-policy-audit.md`；当前文本扫描 | 外部不可编辑 owner 另行处理 |
| M1/T5 reply guard | completed | focused Supervisor wire、typecheck | 无 |
| H1/T20/T24 opaque intent | completed | 真实 fresh contact ask/managed、wire focused | 无 |
| H2/T23 proof-safe release | completed | workspace service/operation focused；69/69 | 真实旧 workspace 仍需合法处置 |
| T29 errorInfo | completed | protocol/client/server typecheck 与 focused 合同 | 无 |
| T25A prepare/apply | behavior-verified（专项用例）| strict schema、ledger/service 接线、typecheck；`settlement-window-audit.md` | 七个窗口已由 `test/workspace-disposition-settlement.integration.mjs` 12/12 覆盖（preserve/discard、queue/resume intent、replay 幂等、篡改 fail-closed） |
| T25B settlement/replay | behavior-verified（专项用例）| queue settlement contract、69/69 既有 queue/recovery、queue crash/restart focused；`settlement-window-audit.md` | receipt/handoff 与 queue 终态收敛已由同一专项用例覆盖 |
| T25C startup barrier | behavior-verified（专项用例）| startup barrier typecheck、queue restart/recovery focused；`test/workspace-disposition-settlement.integration.mjs` 覆盖恢复未就绪时 mutation 返回 `COORDINATOR_RECOVERY_NOT_READY`、只读 `queue.audit` 可用、恢复失败后重试路径一致 | 真实 Host 进程级崩溃（SIGKILL）未做，属危险实验，需另行授权 |
| T26 public facade | completed | fresh registration、managed-worktree 5/5、typecheck | 无 |
| footer 空行 | completed | footer/details 59/59、Host 已重启 | 用户实际观感仍属后验 |
| N1/T16 安装闭包与 package verify | verified-isolated | `/tmp/rc-fresh-install.log`（隔离目录 `npm ci`，官方 registry）、`npm ls` 显示 codemode 1.0.4 overridden、`/tmp/rc-package-test-online.log` 8/8、`/tmp/rc-package-verify-{offline,online}.log` exit 0 | 当前物理 Host 未重装/未热替换；五-child 真实验收 probe 需真实 provider，未执行 |
| F3/R12 fixture migration | completed（可验证部分） | `fixture-inventory.md`；model-selection 23/23、real-git 4/4、managed-worktree 5/5、merge-queue probe 43/43、resumed-child 1/1、fresh contact 2 场景 | `recovery-resume/scripted-model-server.mjs` 全仓无消费方，属孤立 fixture，无法行为验证；五-child 真实验收 probe 未跑；`dispatch-branch-probe.ts` 死路径由 owner 决定 |
| R04 scheduler | blocked-upstream | `scheduler-provenance.md` | 上游 store/lock owner 与产品语义决定 |
| R08 heartbeat breadth | blocked-evidence | `lifecycle-boundaries.md`；核心父死证据 | 其它拓扑无证，不新增危险实验 |
| R09 heartbeat roots | blocked-recovery | 当前账本 | 无合法 public owner 出口，不 raw 删除 |
| R10 heartbeat normal settlement | local-fix-ready | fixture 已迁移 read/commandsRun 逻辑 | 正常结算 Host 未重跑 |
| R11 session-owner breadth | blocked-evidence | `lifecycle-boundaries.md` | open failure/跨进程/外部 import 边界补证 |
| R05/R06 historical RPC/Supervisor | blocked-evidence | `historical-provenance.md` | 需要同次非敏感字段链 |
| R07 C1/C2/C3 clear/inspect | blocked-upstream | G2 acceptance、operation TODO | exact absence/root ownership 上游接口 |
| R13 ceiling | completed | 3 lifecycle checks pass | 保留历史失败记录，不改产品 ceiling |
| R14 resource-isolation | completed | 既有 description 断言迁移后 focused pass | 生产隔离未放宽 |
| R15 V/Z docs | completed（文档）；S6 清单 evidence-gap | `supervisor-gate-recovery.md`、G2 acceptance、`2026-10-16-operation-tools/acceptance.md` | 精确 24 文件清单不可还原：现存 `/tmp/s6-operation-verified.log`、`/tmp/s6-operation-final.log` 为 TAP 输出，只有失败项带文件路径；保留历史 492/492 为报告值，不重跑猜测 |
| F1 idle notification | deferred-user | 原专项记录 | 用户解除暂缓并重新立项 |
| F2 triggerTurn | blocked-upstream | 原专项记录 | 发送前 stable receipt/run 关联 |
| F3 resume(model) | deferred-user | 原专项记录 | 独立立项 |
| F6 TUI L3 | user-post-check | footer 59/59、用户已重启 Host | 用户发现实际观感问题后另立 bug |
| F7 models backup | protected-local-artifact | 保护现场 | 用户自行决定 |
| A8F3 old workspace | released（行政出口） | `current-workspace-settlement.md`；`node scripts/worktree-lifecycle.ts reconcile --apply --authorization-stdin`（plan hash 校验 + 逐条 `{workspaceId, leaseId}` 显式授权 + 内部铸 `processInstance:"reconcile"` 证明） | 已 released，worktree/branch 已清理、origin HEAD 不变。常规 `release` 因缺该 run 的 observed terminal proof 而 fail-closed 属预期行为，未伪造 proof、未放宽门禁、未 raw 删除 |
| R09 heartbeat 旧根 | blocked-recovery（owner scope） | 本会话 `managed_workspace_list` 只返回 A8F3，未投影其它 owner 的旧实验 workspace | 需旧 owner 合法 public 出口或上游 orphan 回收入口；不 raw 删除、不猜 token |
| 非隔离 top-level RPC 兼容 lane | completed（2026-10-21 推翻原 blocked 判定） | `integration-gate-baseline.md`（观测实验判定节 + 修复结果节）；`/tmp/rpc-lane-fix2.log` EXIT=0、5/5 绿 | 原判定“需隔离 lane 或同次 context 激活证据”已闭合：根因是 fixture 缺 `agents-shared` 绑定，导致 session_start 链在 required-child 校验（`src/subagent-dispatch/extension.ts:2102`，早于 `:2113`）抛错、upstream bridge 从未 primed（`ready` 不发、ping 的 `session:{}`、spawn 在 `rpc.js:585` 抛 `no_active_session`）。补 symlink + 迁移过期工具面断言后转绿。该 lane **不可退役**：本仓 typed 派发就是这条 bridge 的客户端（`rpc-client.ts:3-4`） |
| Agent profile 与 provider 黑名单（用户裁决已落地） | completed | `agent-profile-drift.md`；`/tmp/rc-guidance-after-decision.log` 12/12、`/tmp/rc-blacklist-removal.log` 40 tests/39 pass/1 todo | `contact_supervisor` 不写进 profile（上游 runtime 注册、INTERNAL_TOOLS 不可 gate），GLOBAL 与既有断言已同步；deepseek 禁令由用户删除，`extensions/subagent-runtime.ts` 的硬编码 `providerBlacklist` 与 `pi/extensions/subagent/config.json` 的死键已移除（option 合同保留，显式传入仍生效） |
| reviewer 只读属性可见性（用户要求） | completed | `pi/agents/reviewer.md` description 明写无写入/派发能力、不得承接落盘任务；`pi/AGENTS_GLOBAL.md` 增加不得把写任务派给 reviewer；`test/reviewer-agent.test.mjs` 断言该 description 与三档位 tools 面 | 实操中若再出现把落盘任务派给 reviewer，属派发方违规，按新 bug 记录 |
| 五-child 真实验收 probe | not-run（需真实 provider 授权） | `/tmp/rc-acceptance-probe-attempt.log`（`--subagents 1` 参数校验即退出，未启动 child）；probe 合同测试 43/43 | 本轮授权只含新增用例与联网；probe 明确拒绝 fake model。另其 `PI_REAL_BIN must identify the real Pi 0.87.1` 文案与本仓受支持版本 `1.0.4` 不一致，属陈旧文案，未在本批修改 |
| 单进程 28 文件连跑 | harness-contention（非生产回归） | `/tmp/rc-authorized-focused-suite{,-rerun}.log` 1–2 失败/1 取消；同批文件三组分别运行 143/142+1todo、131/131、16/16 全 exit 0；`subagent-auto-integration-real-git` 单独重跑 4/4 | 不据此改生产或延长 timeout；广域回归需另行授权与资源窗口 |
| 五-child probe 验收场景 | obsolete-by-user-decision（场景过期）；接管路径经诊断证明**尚未接通** | `acceptance-probe-taskid.md` 第三跑节；现场 `…/repository-merge-queue-acceptance-RrLPSD` 保留；`f8-takeover-gap.md`（诊断 child `4c402da1-…`） | 用户裁决“不拖住 child，工作完成即正常退出”，保活方向否决；现行合同下只有 FIFO 队首能自发布，`maxAdmissionPolls=3 × 25ms` 不是缺陷。**更正原表述**：接管路径 `handoff → subagent_run_resume → recovery.activate-resume` 在当前工作区**并不成立**——`extension.ts:1441` 的 typed resume 只转发 upstream resume，未查询 intent、未调 `activateResume()`、未重绑 workspace/queue；另有两处协议不一致（intent 用 `sourceRunId` 而 `root-broker-server.ts:1226` 按 `event.runId` 路由；`handoff` 不在 `root-broker-protocol.ts:426` 字段表却被 `:440 exactObject()` 解析）。底层重绑能力齐备（`coordinator-server.ts:459`、`service.ts:250`、`integration-queue.ts:210`）但无 typed 调用方。需用户裁决 (a) 按前置 1→5 实施 / (b) 只做 1 / (c) 暂缓登记 |
| subagent 详情面板丢失模型显示 | completed（显示层修复 + 2026-10-21 按用户裁决改承载位置） | `docs/bugs/2026-10-19-subagent-detail-model-label-lost.md`；`6b1827e`、`e3d20b4`；`/tmp/verify-1-runtime-integration.log` 13/13、`/tmp/verify-2-tui-suites.log` 79/79、tsc 0 | 用户裁决“详情面首行信息整条删除、都放到 footer”：overlay header 只剩滚动信息行（stale 时追加 `· 过期观察`），身份与模型改由 presenter 详情 footer 首行承载（`n/N glyph label · state · metaLabel`，`presenter.ts:317`）。`ActivityRow.metaLabel` 保留为只读展示投影（**不可删**：presenter 路径下 footer 的 meta 只读父 ctx，删掉就等于重新引入原 bug）。真实 TUI 观感仍属用户后验 |
| 五-child probe 陈旧文案/taskId/barrier 身份 | completed（harness 侧）| `scripts/probes/repository-merge-queue-acceptance.ts:580` 改为引用 `SUPPORTED_PI_VERSIONS`，不再钉 `0.87.1`；`/tmp/rc-probe-text-after-edit.log` 43/43 | 无 |
| 全量 integration gate | completed（0 fail 基线） | `integration-gate-baseline.md`（最终全量门禁节）；`/tmp/rc-gate-final.log`：42 文件、344 tests / 334 pass / **0 fail** / 10 skipped、876s、`GATE_EXIT=0` | 轨迹 342/304/28/10 → 344/332/2/10 → 344/334/0/10。排除清单为空（绿不是靠豁免）；10 项 skip 全是既有授权/环境门控（8 视觉快照 + heartbeat 危险实验 + `fixture-sigkill 尚未授权`）。28 项中仅 steer 一项为类别 1 生产合同缺陷，其余为类别 2；无一项靠放宽断言、skip/only 或豁免变绿。收尾含一次自伤自愈（`6b1827e` 引入 2 项断言失败 → `e3d20b4` 迁移） |
| pi -c guard | user-deferred | `2026-10-18-pi-continue-durable-guard.md` | 用户明确停止处理 |

## 交付边界

当前没有自动 commit/push。crashes 与 models backup 未读取正文或自动清理；handoff 只做 append-only 追加，原历史正文逐字保留。用户于 2026-10-19 授权新增用例与联网：新增 `test/workspace-disposition-settlement.integration.mjs`（12/12）一个跨层组合文件，联网只用于官方 registry 的隔离安装与 package 验证；真实 provider、SIGKILL/危险实验与全仓 glob 回归仍未授权、未执行。既有测试、断言和 fixture 的修改仍只为迁移已证生产合同或落实用户裁决。
