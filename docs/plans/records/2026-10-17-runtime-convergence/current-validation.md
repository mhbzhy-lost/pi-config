# Runtime 收尾当前验证与未覆盖范围

## 已实际取得的证据

| 范围 | 命令/记录 | 实际结论 |
| --- | --- | --- |
| TypeScript | `npm run typecheck`；`/tmp/runtime-convergence-typecheck-final3.log` | root/package exit 0 |
| workspace/queue 既有回归 | `node --test test/managed-workspace-ledger.integration.mjs test/managed-workspace-service.integration.mjs test/managed-workspace-integration-queue.integration.mjs test/workspace-operation-tools.test.mjs test/supervisor-gate-wire.test.mjs`；`/tmp/runtime-convergence-settlement-focused.log` | 69/69 exit 0；后续同组合长运行超时不覆盖该快照，也不能单凭旧快照声明后续全量无回归 |
| footer 和 Supervisor wire | `node --test test/background-activity-layout.test.mjs test/background-activity-details.test.mjs test/supervisor-gate-wire.test.mjs` | 59/59 exit 0；其中包括 8 项 wire，不能写成 footer 单独 59 项 |
| physical identity | `node scripts/probes/physical-host.ts` | version 1.0.4 healthy，四 core identity 与 watchdog 一致 |
| fresh SDK 注册 | `node --test --test-name-pattern='configured enhanced local package' test/pi-runtime.integration.mjs` | 1/1 exit 0；隔离 SDK Host，不代表当前交互 Host 内存已加载全部后续修改 |
| resource-isolation description | `node --test --test-name-pattern='model-facing description' test/subagent-runtime-resource-isolation.test.mjs` | 1/1 exit 0；旧英文断言按现行中文描述迁移，未放宽生产资源隔离 |
| ceiling | `test/joint-upgrade-ceiling-runtime.test.mjs`，日志 `/tmp/runtime-convergence-sdk-and-footer.log` | 3 个既有生命周期 case 均通过；该整套 exit 1 来自迁移前 footer 断言，不掩盖整套 exit |
| fresh CLI Supervisor | `PI_TEST_CODING_AGENT_ROOT=<repo>/node_modules/@earendil-works/pi-coding-agent node --test --test-name-pattern='真实physical parent/Node detached supervisor: ask\|真实physical parent/Node detached supervisor: managed' test/joint-upgrade-contact-supervisor.integration.mjs`；`/tmp/runtime-convergence-fresh-contact-final2.log` | 两个实际 case exit 0；修 required binding、ACK 与 terminal reconciliation 等待后取得 |
| proof recovery | `/tmp/runtime-convergence-recovery-focused-final.log` | 12/12 exit 0，覆盖 outbox/supersession/terminal proof/debt |
| integration restart | `/tmp/runtime-convergence-queue-restart-final.log` | 6/6 exit 0，queued/admitted/rebasing/resolving-conflict/prepared |
| integration crash | `/tmp/runtime-convergence-queue-crash-final.log` | 6/6 exit 0，socket 幂等和 after-prepared/after-intent/after-merge/before-queue-complete |
| managed-worktree 工具迁移 | `node --test test/subagent-managed-worktree.integration.mjs`；`/tmp/runtime-convergence-existing-worktree-migration.log` | 5/5 exit 0；coding/generic 分配、绑定、proof 投影、discard、preserve/release 与复合 tool-call ID |
| durable storage | `node --test test/durable-lifecycle.test.mjs`；`/tmp/runtime-convergence-continue-lock.log` | 错误信息改进后 exit 0；不代表真实旧 guard 已回收 |
| 真实旧 workspace 处置 | 只读 Git 事实核对 + 当次 `managed_workspace_status` token + `managed_workspace_dispose(preserve)` + `managed_workspace_release` | worktree clean、HEAD 与 origin 同为 `92b0302`、ahead 0；`preserve` 实际成功，state=preserved；`release` 返回 `MANAGED_WORKSPACE_TERMINAL: release requires an observed terminal proof`，属预期 fail-closed；`managed_workspace_list` 复核仍 preserved，未降级 cleanup-debt |
| H3 settlement 七窗口（新增用例，已授权） | `node --test test/workspace-disposition-settlement.integration.mjs`；`/tmp/rc-settlement-windows-3.log` | **12/12 exit 0**：七个故障窗口逐个注入后由重启 `listen()` 内 replay 收敛，preserve/discard 两分支、queue 终态与 receipt、resume/handoff intent、workspace-only prepare 补建 intent、startup barrier `COORDINATOR_RECOVERY_NOT_READY`、跨分区隔离、篡改不可变字段 fail-closed |
| subagent 详情模型显示修复 | `node --test test/background-activity-details.test.mjs test/subagent-activity-provider.test.mjs test/background-activity-layout.test.mjs test/background-activity-registry.test.mjs test/task-scheduler-activity.test.mjs test/bash-async-activity.test.mjs test/custom-footer-layout.test.mjs`；`/tmp/rc-detail-model-label.log` | 129/129 exit 0 |
| footer/browser 相关既有回归 | `node --test test/custom-footer-input.integration.test.mjs test/custom-footer-subagents.test.mjs test/background-activity-runtime.integration.mjs`；`/tmp/rc-footer-model-label.log` | 62/62 exit 0 |
| 五-child 真实验收 probe（真实 provider，已授权） | 首跑 `--model qoder-pool/DeepSeek-Flash`；`/tmp/rc-five-child-acceptance.log` | wrapper exit 0 但 **`PROBE_EXIT=1`**（19s）：`dispatch receipt has an invalid acceptance taskId: dispatch-19e5682d`，`firstDeviation.phase=public-audit-settlement`。现场保留：repo 仅 base commit、5 个 worktree 停在 base、barrier 空、无残留进程。归因为 probe 过期期望（类别 2），只改 probe；合同测试 44/44 后重跑 |
| 五-child probe 第二跑 | job `9dd08c51-…`；`/tmp/rc-five-child-acceptance-2.log` | wrapper exit 0 但 **`PROBE_EXIT=1`**（122s）：`acceptance barrier timed out`。现场 `…-XYRn5V` 保留：repo 已有 1 个经队列发布的 child commit `4d4b291`、queue 1 completed/1 resolving-conflict/3 queued、4 个 resume intent（1 已 delivered）、proof outbox 1 receipt/4 pending/0 debt、barrier 目录空。首个偏离点是 fixture barrier 读 `PI_SUBAGENT_RUN_ID`，而上游 0.75 无此变量、它只由本仓 `integration-queue` child extension 在其后加载时写回 → 类别 2，只改 fixture（改用生产 `resolveChildBrokerIdentity`），probe 合同测试 44/44。**第二跑不是验收通过** |
| 五-child probe 第三跑 | job `aa8da909-…`；`/tmp/rc-five-child-acceptance-3.log`；现场 `…/repository-merge-queue-acceptance-RrLPSD` | wrapper exit 0、**`PROBE_EXIT=1`**（900s，`OVERALL_TIMEOUT`）。barrier 修通：5 份 ready receipt（同 baseCommit、5 个 runId/pid）+ release.json；队首 `e040eb3` 经 admission→rebase→发布→queue completed→workspace released(discard)→proof receipt 全链贯通；4 个 follower 停 `queued`，各自产生 durable resume intent（1 已投递 handoff）、proof pending、workspace active 保留、无 cleanup-debt、无残留进程。首个偏离点：`child-integration-lifecycle.ts:27` 默认 `maxAdmissionPolls=3 × pollDelayMs=25`（约 75ms），follower 等不到准入即结束，而当前合同不自动 resume 已结束 child → probe 的“五 child 自发布 + 冲突续跑”场景过期。**不是验收通过**。用户裁决“不拖住 child，工作完成即正常退出”→ 保活方向否决，五-child 全部自发布场景判 obsolete，不再重跑；`maxAdmissionPolls` 不是缺陷，未改生产。真实模型验收“五个成果都进 main”只能走主 Agent 接管（resume + activate-resume），属独立立项未实施 |
| 既有 workspace 门禁脚本 | `npm run test:subagent-workspace`；`/tmp/rc-npm-subagent-workspace.log` | 37/37 exit 0 |
| 分组既有回归（授权新增用例后重跑） | 合同/工具组 `/tmp/rc-group-contracts.log`；workspace/settlement 组 `/tmp/rc-group-workspace.log`；重 Git 三件组 `/tmp/rc-heavy-git-trio.log` | 合同组 143 tests / 142 pass / 0 fail / 1 todo；workspace 组 131/131；重 Git 三件组 16/16，全部 exit 0 |
| profile 与黑名单裁决落地 | `node --test test/reviewer-agent.test.mjs test/subagent-model-selection.integration.mjs test/operation-guidance-contract.test.mjs test/joint-upgrade-host-ceiling.test.mjs`；`/tmp/rc-blacklist-removal.log` | 40 tests / 39 pass / 0 fail / 1 todo，exit 0 |
| N1 package 闭包（联网授权） | `npm run test:subagents-enhanced`（官方 registry）；`/tmp/rc-package-test-online.log` | 8/8 exit 0 |
| package verify | `npm run verify:subagents-enhanced` 离线与联网各一次；`/tmp/rc-package-verify-{offline,online}.log` | 均 exit 0：1259 upstream files、166 import edges、1828 tarball files / 17568320 bytes |
| 隔离安装闭包消费 | 临时目录 `npm ci --ignore-scripts`（官方 registry）+ `npm ls` + `PI_TEST_CODING_AGENT_ROOT=<temp> node --test --test-name-pattern='configured enhanced local package' test/pi-runtime.integration.mjs`；`/tmp/rc-fresh-install.log`、`/tmp/rc-fresh-closure-runtime.log` | 安装 exit 0；`pi-coding-agent@1.0.4` 且 `pi-codemode@1.0.4 overridden`；注册面 1/1 exit 0；当前物理 Host 未重装 |
| dispose 可选字段投影 | `workspace-schema-provenance.md`；`operation-tools.ts:106-111` 相对 HEAD 无改动（最后变更 `381f86d`） | 当前模型面 required 仅三字段、`strategy` 可省略，旧 `blocked-interface` 不复现；旧投影为何必填仍缺原始 provider schema 证据，保留“来源尚未证实” |

## 必须保留的验证缺口

1. integration crash 的四个旧 hook 属发布状态机，**不是**新增 disposition settlement 七个 hook；两者分别由各自文件覆盖，不互相替代。新增七窗口已有专项行为证据（见上表），但真实 provider/真实 Host 下的端到端处置仍未验证。
2. 新增用例已由用户在 2026-10-19 明确授权，本轮只新增了 `test/workspace-disposition-settlement.integration.mjs` 一个跨层组合文件；其余改动仍是既有测试/断言/fixture 的迁移。未授权的真实 provider、SIGKILL/危险进程与全仓 glob 回归仍未执行。
3. fresh-contact-3 使用带多余空格的 name pattern，可能零 case；其 exit 0 不作通过证据。有效结果是实际执行两个 case 的 final2。
4. recovery 文件中存在 SIGKILL fixture。此前运行记录仅作已发生事实，不继承为今后危险实验授权，不再重复执行。
5. 不因 `rg` exit 0 就宣布全仓 fixture 迁移完成。本轮扫描只覆盖列出的 fresh contact/heartbeat/注册文件，兼容 probe 与其他调用者仍需逐项 inventory。
6. 当前真实旧 workspace 已 `preserved`、物理回收仍缺 observed terminal proof；当前交互 Host 重启是用户事实，但其后仍有源码改动（settlement 专项用例、黑名单移除、reviewer description），不能外推已加载。
9. 把 28 个文件放进**单个** `node --test` 进程连跑会出现重 Git/proof 用例超时（`/tmp/rc-authorized-focused-suite.log` 1 失败、`/tmp/rc-authorized-focused-suite-rerun.log` 2 失败 1 取消）；同一批文件按上表三组分别运行时全部 exit 0，且 `test/subagent-auto-integration-real-git.integration.mjs` 单独重跑 4/4。分类为**长时同进程资源竞争导致的 harness 超时**，不是生产回归证据；不据此改生产，也不把单进程连跑的失败当作通过。
7. S6 历史 24 文件命令列表**已确认不可还原**：现存 `/tmp/s6-operation-verified.log` 与 `/tmp/s6-operation-final.log` 为 TAP 输出，除失败项外不含文件路径，`/tmp/s6-operation-probe.mjs` 只是工具面 probe。历史 492/492 保留为原报告值，不用本轮不同组合替代，也不重跑猜测清单。
8. 真实旧 workspace 已 `preserved`，但物理回收仍缺 observed terminal proof；不得把 preserved 写成 released，也不得把 release 失败写成缺陷。

## 用户最新裁决

- `pi -c` 锁阻塞不再处理；保留现场和诊断，不删除锁。
- 既有测试/断言/fixture 可随修复修改或删除；新增测试需要明确授权。
- 2026-10-19 追加授权：新增用例与联网。据此新增 H3 专项用例、执行官方 registry 的隔离安装与 package 验证；真实 provider 未包含在该授权内，五-child 真实验收 probe 仍未跑。
- `contact_supervisor` 不写进 profile `tools`（上游 child runtime 注册）；`qoder-pool/DeepSeek-Flash` 启用，SHARED 的 deepseek 禁令由用户删除，本仓硬编码 `providerBlacklist` 按用户要求移除。
- reviewer 的只读属性必须对派发方可见：`pi/agents/reviewer.md` 的 description 已明写无写入/派发能力、不得用于落盘类任务；`pi/AGENTS_GLOBAL.md` 增加不得把写任务派给 reviewer 的规则。
- 其它收尾继续 Inline；未授权 commit/push。
