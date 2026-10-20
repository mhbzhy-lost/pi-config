# Runtime Convergence 收尾验收记录（T18）

本记录是本批 Inline 收尾的交付门禁核对，不替代各分支自己的验收记录，也不把未验证项写成通过。当前状态权威表见 `closure-matrix.md`；实际命令与缺口见 `current-validation.md`。

## 1. 实现状态

| 分支 | 状态 | 依据 |
| --- | --- | --- |
| M1 reply guard 持久化对称 | completed | `supervisor-control-plane.ts` saveRoot/事务重载同覆盖 `supervisor-reply-guard.v2:<root>:`；wire focused 通过 |
| H1 opaque intent id | completed | 新增 `supervisor-intent-id.ts`（`svi1-`+SHA-256）；fresh CLI ask/managed 2 场景 exit 0 |
| H2 bound release proof 收紧 | completed | `service.ts` 去掉 `challenge.used` shortcut，preserve 持久化 observed proof；本轮真实 `release` 因缺 observed proof fail-closed，正是该门禁生效 |
| T29 coordinator errorInfo | completed | 新增 `coordinator-errors.ts`，protocol 严格 optional，只传 code/detail/keypath |
| T26 public disposition facade | completed | 新增 `disposition-facade.ts`，public 写操作经 coordinator 且显式 await |
| T25A/B/C prepare-apply-settlement-barrier | behavior-verified（专项用例已授权并实跑） | 新增 `disposition-contract.ts`、`disposition-settlement.ts`；`test/workspace-disposition-settlement.integration.mjs` 12/12 exit 0 覆盖七窗口、workspace-only prepare 补建 intent、startup barrier 与分区隔离，见 `settlement-window-audit.md` |
| runtime 文本政策清理（T2/T3/T3E/T4） | completed | `runtime-policy-audit.md`；最终扫描见 §4 |
| footer 空行 | completed | `src/background-activity/layout.ts`；footer+wire 联合 59/59 |
| fixture 迁移（F3/R12） | completed（可验证部分） | `fixture-inventory.md`；`root-provider.mjs` 由 probe 合同测试 43/43 验证，`scripted-model-server.mjs` 全仓无消费方无法验证 |
| 历史个案与生命周期边界归档（T13/T14/T15） | completed（文档） | `historical-provenance.md`、`lifecycle-boundaries.md` |
| scheduler 并发（T12/R04） | blocked-upstream | `scheduler-provenance.md`；用户已裁决移出本批活跃修复 |
| 真实旧 workspace 后置处置（T28） | preserved；release blocked-terminal-proof | `current-workspace-settlement.md`、`workspace-schema-provenance.md` |

新增未跟踪生产文件：`supervisor-intent-id.ts`、`coordinator-errors.ts`、`disposition-contract.ts`、`disposition-facade.ts`、`disposition-settlement.ts`。

## 2. 证据索引（本轮实际执行）

| 证据 | 命令/记录 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck`（root 与 package，官方 registry + offline） | 两边 exit 0；最终一次在 `durable-storage.ts`（10-19 11:15）修改之后重跑，日志 `/tmp/rc-typecheck-root-final.log`、`/tmp/rc-typecheck-package-final.log` |
| workspace/queue/Supervisor 组合 | 五文件 `node --test` | 69/69 exit 0（快照，见 current-validation 限制） |
| footer + wire | 三文件 `node --test` | 59/59，其中 wire 8 项 |
| fresh CLI Supervisor | contact ask/managed 两场景 | exit 0，`/tmp/runtime-convergence-fresh-contact-final2.log` |
| proof recovery / queue restart / queue crash | focused | 12/12、6/6、6/6 |
| managed-worktree 迁移 | `node --test test/subagent-managed-worktree.integration.mjs` | 5/5，`/tmp/runtime-convergence-existing-worktree-migration.log` |
| model-selection 迁移 | 同文件迁移前后 | 迁移前 0/23 → 迁移后 23/23，`/tmp/rc-model-selection{,-migrated}.log` |
| real-git auto integration 迁移 | 同上 | 迁移前 1 失败 → 4/4，`/tmp/rc-auto-integration-migrated.log` |
| acceptance-evidence 子合同 | `node --test test/subagent-acceptance-evidence.integration.mjs` | 3/3 exit 0，`/tmp/rc-acceptance-evidence.log` |
| deterministic provider / model-only 兼容 probe | `node --test test/deterministic-provider.test.mjs test/joint-upgrade-model-only.test.mjs` | 8/8 exit 0，`/tmp/rc-compat-fixtures-final.log`（旧名引用属上游兼容面，有意保留） |
| resource-isolation 整文件 | `node --test test/subagent-runtime-resource-isolation.test.mjs` | 9/9 exit 0，`/tmp/rc-resource-isolation-now.log` |
| ceiling-runtime 整文件 | `node --test test/joint-upgrade-ceiling-runtime.test.mjs` | 3/3 exit 0，`/tmp/rc-ceiling-now.log`；历史失败归为 unconfirmed，未改生产 |
| 非隔离 top-level RPC 兼容 lane | `node --test test/pi-subagents-runtime.integration.mjs` | 5 tests / 3 pass / **2 fail**，exit 1，`/tmp/rc-pi-subagents-runtime.log`；归因见 `compat-lane-provenance.md`，不计入通过项 |
| guidance contract | `node --test test/operation-guidance-contract.test.mjs` | 裁决前 11/12（`/tmp/rc-guidance-contract.log`）→ 按用户裁决同步 GLOBAL 与断言后 **12/12 exit 0**（`/tmp/rc-guidance-after-decision.log`） |
| 本轮最终合并快照 | `node --test test/subagent-model-selection.integration.mjs test/subagent-auto-integration-real-git.integration.mjs test/operation-guidance-contract.test.mjs` | 裁决前 39 tests / 38 pass / 1 fail（`/tmp/rc-round-final.log`，唯一失败是 profile 白名单断言）→ 裁决落地后 **39/39 exit 0**（`/tmp/rc-round-final2.log`） |
| physical Host identity | `node scripts/probes/physical-host.ts` | 1.0.4 healthy |
| fresh SDK 注册面 | `test/pi-runtime.integration.mjs` focused | 1/1，14 工具 model-only |
| 真实 workspace 处置 | 只读 Git 事实 + 当次 status token + `dispose(preserve)` + `release` | preserve 成功（state=preserved）；release `MANAGED_WORKSPACE_TERMINAL`；`managed_workspace_list` 复核仍 preserved |
| merge queue 验收 probe 合同 | `node --test test/repository-merge-queue-acceptance-probe.test.mjs` | 43/43 exit 0，`/tmp/rc-merge-queue-probe.log`；验证已迁移的 `root-provider.mjs`，本地 fixture provider、无网络 |
| resumed-child handoff 合同 | `node --test test/subagent-auto-integration-resumed-child.integration.mjs` | 1/1 exit 0，`/tmp/rc-resumed-child.log` |
| H3 settlement 七窗口专项（新增用例，已授权） | `node --test test/workspace-disposition-settlement.integration.mjs` | **12/12 exit 0**，`/tmp/rc-settlement-windows-3.log`；临时 Git/state/socket，无网络、无真实 provider、无 SIGKILL |
| profile/黑名单裁决落地 | `node --test test/reviewer-agent.test.mjs test/subagent-model-selection.integration.mjs test/operation-guidance-contract.test.mjs test/joint-upgrade-host-ceiling.test.mjs` | 40 tests / 39 pass / 0 fail / 1 todo，exit 0，`/tmp/rc-blacklist-removal.log` |
| N1 package 闭包（联网，官方 registry） | `npm run test:subagents-enhanced` | **8/8 exit 0**，`/tmp/rc-package-test-online.log` |
| package verify（离线 + 联网） | `npm run verify:subagents-enhanced` | 两次均 exit 0：1259 upstream files、166 import edges、1828 tarball files / 17568320 bytes（`/tmp/rc-package-verify-{offline,online}.log`） |
| fresh 安装闭包消费（隔离目录，不改当前 Host） | 临时目录 `npm ci --ignore-scripts`（官方 registry）+ `PI_TEST_CODING_AGENT_ROOT=<temp>/node_modules/@earendil-works/pi-coding-agent node --test --test-name-pattern='configured enhanced local package' test/pi-runtime.integration.mjs` | 安装 exit 0；`npm ls` 显示 `pi-coding-agent@1.0.4` 且 `pi-codemode@1.0.4 overridden`；注册面用例 1/1 exit 0（`/tmp/rc-fresh-install.log`、`/tmp/rc-fresh-closure-runtime.log`） |
| 分组重跑（合同组 / workspace 组 / 重 Git 三件组） | 见 `current-validation.md` 命令列 | 143 tests / 142 pass / 0 fail / 1 todo；131/131；16/16，三组均 exit 0（`/tmp/rc-group-contracts.log`、`/tmp/rc-group-workspace.log`、`/tmp/rc-heavy-git-trio.log`） |
| 单进程 28 文件连跑（不作为通过证据） | 同一批文件一次 `node --test` | 第一次 289 tests / 287 pass / 1 fail；重跑 285 pass / 2 fail / 1 cancelled，失败集中在重 Git/proof 超时用例；分组与单文件重跑均通过，分类为资源竞争而非生产回归 |
| 五-child 真实验收 probe（授权前） | `scripts/probes/repository-merge-queue-acceptance.ts` | 授权前**未执行**：`--subagents 1` 的参数校验尝试直接退出，未启动 child（`/tmp/rc-acceptance-probe-attempt.log`）。用户随后授权真实 provider，已另行启动，见上表 |
| 既有 workspace 门禁脚本 | `npm run test:subagent-workspace` | 37/37 exit 0，`/tmp/rc-npm-subagent-workspace.log` |
| subagent 详情模型显示修复 | `node --test`（details/provider/layout/registry/scheduler/bash_async/custom-footer-layout 七文件）+ footer 三文件回归 + typecheck | 129/129、62/62、typecheck exit 0（`/tmp/rc-detail-model-label.log`、`/tmp/rc-footer-model-label.log`、`/tmp/rc-typecheck-model-label.log`）；根因与修复见 `docs/bugs/2026-10-19-subagent-detail-model-label-lost.md` |
| 五-child probe 陈旧版本文案 | 改 `scripts/probes/repository-merge-queue-acceptance.ts:580` 后重跑其合同测试 | 43/43 exit 0，`/tmp/rc-probe-text-after-edit.log` |
| 五-child 真实验收 probe（真实 provider，已授权） | `PI_REAL_BIN=<repo cli> node scripts/probes/repository-merge-queue-acceptance.ts --model qoder-pool/DeepSeek-Flash` | 首跑 job `e45a6ba7-…`：wrapper exit 0 但 **`PROBE_EXIT=1`**（probe 过期 taskId 期望，类别 2，只改 probe，现场保留）；修正后 probe 合同测试 44/44；第二跑 job `9dd08c51-…` 仍 `PROBE_EXIT=1`（barrier 超时：fixture 依赖上游 0.75 已不存在的 `PI_SUBAGENT_RUN_ID`，只改 fixture 后用生产 `resolveChildBrokerIdentity` 解析，合同测试 44/44）；第三跑 job `aa8da909-…`：barrier 修通（5 ready receipts + release），队首真实发布并 released，4 个 follower 按“不自动 resume”合同转为 durable resume intent + handoff，probe 15 分钟 `OVERALL_TIMEOUT`，**仍不构成验收通过**；场景是否改写/作废待 owner 决策（`/tmp/rc-five-child-acceptance-3.log`、`acceptance-probe-taskid.md`） |
| 空白/冲突标记 | `git diff --check` | exit 0 |

## 3. WritePaths 与现场审计

- `git status --short --untracked-files=all` 当前 99 条（含本轮新增记录、新增用例与 `pi/extensions/subagent/config.json` 的死键删除）；`git diff --cached --name-only` 为 0 条：**无 staged、无 commit、无 push**。
- 变更集中在计划声明范围：`packages/pi-subagents-enhanced/src/{subagent-dispatch,workspace}/**`、`packages/pi-subagents-enhanced/{extensions/subagent-runtime.ts,AGENTS.md}`、`src/background-activity/layout.ts`、`pi/AGENTS_*.md`、`skill-overrides/**`、`.pi/skills/external-llm-review-provider/SKILL.md`、`test/**`、`docs/**`。
- 保护现场处置：`pi/crashes.json`、`pi/models.json.bak-qoder-thinking-20261016161901` 仍为未跟踪且未读正文；`.pi/handoff/context-handoff.md` 只做了 **append-only** 追加（新增 2026-10-19 当前节，原 2026-10-17 正文逐字保留，并显式标注已被取代的历史表述）。
- 未对受管 workspace 执行 raw git worktree/stash/reset；本轮唯一 worktree 操作是只读 `status/rev-parse/rev-list` 与 runtime 提供的 `dispose(preserve)`、`release`。
- 联网副作用只在授权范围内：官方 registry 的隔离临时目录安装（已删除该临时目录）与 package pack/verify；仓库内 `var/tmp/npm-cache` 约 310MB 属既有脚本缓存目录（未跟踪、未清理），当前物理 Host 的 `node_modules` 未重装或热替换。
- `pi/agents/{delegate,executor,reviewer}.md` 的 frontmatter 漂移**不是**本批脚本产物（四个 `/tmp/*.py` 辅助脚本均不涉及），未擅自回改，见 `agent-profile-drift.md`。
- 17 份任务级记录（T4/T6/T10/T11/T14/T15/T16/T20/T21/T23/T24/T25A/T25B/T25C/T26/T27/T29）已按计划声明的 records WritePaths 补齐；`compat-lane-provenance.md` 是新发现项的追加记录。

## 4. runtime 可达文本最终扫描

`rg` 扫描 `pi/`、`pi/agents/`、`.pi/skills/`、`skill-overrides/`、`packages/pi-subagents-enhanced/{AGENTS.md,src/subagent-dispatch/extension.ts}` 后，剩余的测试相关表述全部是授权条件句，没有默认强制 TDD/先写测试/固定 `tests-added`：

- `pi/AGENTS_SHARED.md`：仅“未经用户明确授权，agent 严禁主动新增测试”。
- `skill-overrides/test-driven-development/*`：标注为可选方法、非默认前置。
- `skill-overrides/writing-skills/*`、`writing-plans/SKILL.md`：新增评估/测试须先授权，既有测试可随已授权修复调整。
- `packages/pi-subagents-enhanced/AGENTS.md`：验收 CLI 与既有检查可选，新增测试/fixture/压力场景需具体授权。
- `.pi/skills/external-llm-review-provider/SKILL.md`：provider 验证按实际执行记录，不要求先 RED。

三个本机个人 skill（megability IDL、whale modules、MTL 依赖调试）按用户精确指定修改，保留业务指导与结果真实性要求。

## 5. 未通过项与未验证项（不得当作完成）

1. ~~guidance contract 1 项失败~~ **已按用户裁决收口**：`contact_supervisor` 由上游 child runtime 注册（`native-supervisor-channel.js:179-193`、`permissions.js` 的 `INTERNAL_TOOLS`、`child-tool-plan.js:242-256`），profile 不声明它是正确的；`pi/AGENTS_GLOBAL.md` 与两处既有断言已同步，`test/operation-guidance-contract.test.mjs` **12/12 exit 0**（`/tmp/rc-guidance-after-decision.log`）。
2. ~~DeepSeek 候选与 SHARED 禁令冲突~~ **已由用户裁决解除并进一步清理**：用户自行删除 `pi/AGENTS_SHARED.md` 的“不得使用 deepseek 系列模型。”，并明确要求去掉硬编码黑名单；已删除 `extensions/subagent-runtime.ts` 的 `providerBlacklist = ["deepseek"]` 常量与其注入点（extension 默认 `[]`，option 仍保留供调用方显式传入），同时删除 `pi/extensions/subagent/config.json` 中未被任何消费方读取的 `providerBlacklist` 死键。既有断言按新事实迁移（`test/reviewer-agent.test.mjs`），`test/subagent-model-selection.integration.mjs` 中显式传入 `providerBlacklist` 的用例仍作为 option 合同保留并通过。
3. ~~新 disposition settlement 七窗口零行为覆盖~~ **已闭环**：用户授权后新增 `test/workspace-disposition-settlement.integration.mjs`，12/12 exit 0，覆盖七窗口、replay 幂等、startup barrier 与分区隔离。仍未覆盖的是真实 provider/真实 Host 下的端到端处置与五-child 真实验收 probe。
4. `test/fixtures/recovery-resume/scripted-model-server.mjs` 全仓无消费方，属孤立 fixture，无法行为验证；`repository-merge-queue-acceptance/root-provider.mjs` 已由消费方合同测试 43/43 验证，但五-child 真实验收 probe 仍未跑（拒绝 fake model，需真实 provider 授权）。
5. 真实旧 workspace 已 `preserved`，物理回收缺 observed terminal proof；不得写成 released。
6. 未执行：全仓 `npm test`、`test:all-integration`、SIGKILL/危险进程实验、TUI L3 观感、上游 clear/inspect exact absence。五-child 真实验收 probe 已获授权并连跑三次，三次 `PROBE_EXIT=1`：① probe 把生产派生的 `details.taskId` 当任务名；② fixture barrier 依赖上游已不存在的 `PI_SUBAGENT_RUN_ID`；③ barrier 修通后 probe 场景与当前“已结束 child 不自动 resume、由主 Agent 接管”合同冲突，15 分钟总超时。前两项已按类别 2 只改 harness/fixture（probe 合同测试 44/44），第三项已由用户裁决：不拖住 child、工作完成即正常退出，因此“五 child 全部自行发布 + 4 次冲突续跑”场景判 obsolete，不再重跑；`maxAdmissionPolls=3 × 25ms` 不是缺陷、未改生产。在拿到成功 receipt 前不得声称五-child 验收通过；若要真实模型验收接管路径（handoff → `subagent_run_resume` → `recovery.activate-resume` → resumed child 发布），属独立立项，未实施。网络安装已按用户授权在**隔离临时目录**执行，当前物理 Host 依赖未被热替换或重装。
7. S6 历史 24 文件精确清单确认不可还原；保留历史 492/492 为报告值。
8. `test/pi-subagents-runtime.integration.mjs` 的两个非隔离 top-level RPC lane 失败（上游 `no_active_session` 与 60 秒 RPC 超时），按“来源尚未证实/环境受限” fail closed；该 lane 会启动真实 Host 并使用仓库 live state，运行期间 `var/` 下出现 supervisor-control 与旧 session 文件 mtime 变化（未读正文、未删除、未发现残留进程），不重复运行。
9. 本轮实际命令与结果已补入上表；未跑项不因为文档补齐而变成通过。

## 6. 测试授权账本

- 用户明确授权：清理 runtime 可达文本中的强制测试措辞（含三个精确指定的本机 skill）；既有测试、断言、fixture 可随已授权修复修改或删除。
- 本批据此修改的既有测试/fixture 全部记录在 `fixture-inventory.md`，每处都能对应到已证生产合同变化（新工具面、H2 proof 门禁、footer 布局、中文描述合同、复合 tool-call ID、模型政策文本）。
- 未获授权、因此**未创建**：任何新增测试用例、全新 fixture、压力/并发实验、危险进程实验。`settlement-window-audit.md` 中的验证范围仅为建议。

## 7. 环境限制

Node v26.x（>=22.19.0）、官方 registry、离线验证；fresh SDK/CLI 检查使用隔离 synthetic provider，无网络、无真实模型。当前交互 Host 由用户重启过一次，但其后仍有源码修改，因此不声称交互 Host 内存已加载全部最新实现。
