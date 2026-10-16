# 统一计划 Z 总验收账本（剩余 Runtime 能力统一执行）

- taskId：Z（dispatch-5a83eb38；统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md` §Z，Deps=S1v/F7/I4/Q3/H2/R2/V2 终态证据）
- date：2026-10-15（现场实际日期；文件名沿用计划指定的 2026-10-13 前缀）
- 性质：本批仅整合总账，不做 review、不新增实现、不重跑任何任务验收；各任务结论逐条引用其自有记录。
- 执行方式：Subagent-Driven（用户当前要求『剩余工作盘点』；禁 GPT 系列，本批未涉及任何模型调用）。
- **总状态：partial。**账本任务本身完成 ≠ 全部功能完成；blocked/未验/not-started 逐项如下，不以关闭记录冒充功能完成。

## 0. 本批实际执行命令与退出（全部无管道掩盖）

| # | 命令 | exit | 结果 |
| --- | --- | ---: | --- |
| 1 | `git rev-parse HEAD` / `git log -1 --format=…` | 0 | HEAD `a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`（2026-10-13 17:40:05 +0800「docs(testing): 记录合同围栏测试规范」） |
| 2 | `git diff --cached --name-only` | 0 | 空（index 0 staged） |
| 3 | `git diff --check` | 0 | 全仓 tracked 变更无空白错误 |
| 4 | `git status --porcelain` 路径统计 | 0 | 34 个 tracked 修改 + 38 个 untracked = 72 条 dirty 路径，全部保护未触碰 |
| 5 | 引用路径存在性核对（39 条：统一计划/records/bugs/decisions/架构/todos/tests/README） | 0 | 39/39 全部存在，无断链 |
| 6 | 目标 Z 记录存在性检查 | 1 | `ls: …2026-10-13-remaining-runtime-acceptance.md: No such file or directory`（本文为新建，未覆盖任何现场） |

本批未运行：Node tests、tsc、npm、网络、真实 Host/provider、系统通知、进程信号、任何清理、raw git worktree 操作、npm test / all-integration。未读取真实 settings/models/auth/credential/session authority/state 正文。

## 1. Git / 交付边界（现场实证）

- HEAD 停留 `a9875d62…`；主代码尚未新 commit、未 push；index 空（0 staged）；`git diff --check` exit 0。
- dirty 34 M + 38 ?? 全部为统一计划各任务合法产物（src/packages/pi/extension/tests/docs），原样保护；未 stage/commit/stash/reset/clean。
- **用户前次『都提交』不视为本批自动提交授权**；是否提交由用户对当前 dirty 集合明确决策。
- 全仓 `npm test` / all-integration 本批未跑（计划禁止自动运行），**不能声明 wholegreen**；如用户要求全仓回归，须先独立风险审计。

## 2. 任务账本（task / status / evidence / commandsActualExit / unverified / nextAction）

### 2.1 基线与 session-owner 链

| task | status | evidence | commands（actual exit） | unverified | nextAction |
| --- | --- | --- | --- | --- | --- |
| B | verified | `docs/plans/records/2026-10-13-remaining-runtime-baseline.json`（dispatch-00f7c764，2026-10-14T07:02:16Z；HEAD/版本/index/dirty 分类已记录） | JSON.parse 校验 exit 0（记录内） | 无 | 无 |
| S1g | verified（静态 gate）；外部 import 子路径 blocked-upstream | `…session-switch-contract.md`：resume 可实施资格冻结；new/fork 后置 commit；import fail closed | 静态核对，无运行命令 | 运行期行为归 S1v | 已被 S1a/S1b 消费 |
| S1a | implemented + verified | registry 38/38 + extra 18/18（主层已核） | `node --test test/session-owner-registry.test.mjs`、`npm run typecheck:root` 均 exit 0（各任务记录） | 无 | 无 |
| S1b | implemented + verified | 40/40（contract + extension.integration）+ root typecheck 0（主层已核） | 显式 node --test exit 0 | 无 | 无 |
| S1v | **verified 仅限非 PTY 范围** | `…session-owner-acceptance.md`：最终显式 name-pattern 8 tests / 8 pass / exit 0（旧 7/8 计数口径为历史汇报混淆，不引用）；wrapper 11 项 + contract 15 项归属 S1a/S1b 已验 | 见该记录 §2 表（全部 exit 0） | ①6 项真实 CLI/PTY（`真实 Pi Expect PTY…`、`active recent blocks -c`、`-c pins exact free recent`、`--no-extensions cannot bypass`、`selecting picker blocks`、`SIGKILL owner cleaned by ESRCH`）未跑：**blocked-environment**；②真实 SDK 层 `SessionManager.open` 失败路径 blocked-evidence（仅事件级证据）；③真实进程 ESRCH 清理依赖① | PTY/CLI 隔离测试需要独立审计 + visibleHost 窗口授权后执行；**当前环境未授权 ≠ 环境永久不可做**，不得写成永久阻塞 |

### 2.2 footer / 统一后台活动区

| task | status | evidence | commands（actual exit） | unverified | nextAction |
| --- | --- | --- | --- | --- | --- |
| F0 | verified（静态） | `…background-activity-ownership.md`（事件/闭包/发现合同） | 静态核对 | 真实事件序列由 F2b 验证（已完成） | 无 |
| F1 | implemented + verified | 协议/export/types；`test/background-activity-registry.test.mjs` 包含在 F6v 命令3 98/98 内 | 同 F6v 命令3 exit 0；typecheck exit 0 | 无 | 无 |
| F2a / F2a-v | implemented + verified | 迁移与调用方同步完成；custom-footer-subagents、custom-footer-input.integration 在 F6v 命令2 通过（71/77 中 6 失败均为 package fixture ENOTCACHED，见下） | F6v 命令2 exit 1（仅 6 例环境失败） | 无 | 无 |
| F2b | **implemented + verified（主层已核，不重复待验）** | 五 tests 123/123 + packagecheck 0 | 各任务显式命令 exit 0 | 无 | 无 |
| F2b-v | implemented + verified | fixture 同步（真实 manager/session 双形态、reload 保留断言）随 F6v 命令2 通过 | 同上 | 无 | 无 |
| F3 | implemented + verified | `test/bash-async-activity.test.mjs` 在 F6v 命令3 98/98 内 | exit 0；root typecheck exit 0 | 无 | 无 |
| F4g | verified（静态） | `…scheduler-observer-contract.md`（capture-before-await token / typed observer 合同） | 静态核对 | 行为由 F4a/F4b 验证（已完成） | 无 |
| F4a | implemented + verified | 主层已核：F4b 16/16 + rootcheck 0（adapter/observer 链随 F4a 验收） | 显式命令 exit 0 | 无 | 无 |
| F4b | **implemented + verified（主层已核，不重复待验）** | 16/16 + root typecheck 0 | 显式命令 exit 0 | 无 | 无 |
| F5a | implemented + verified | layout 测试在 F6v 命令3 98/98 内 | exit 0 | 无 | 无 |
| F5b | **implemented + verified（主层已核，不重复待验）** | 28/28 + root typecheck 0 | 显式命令 exit 0 | 无 | 无 |
| F6 | implemented + verified | `…footer-acceptance.md` F6v 节：runtime integration 13/13 exit 0；唯一 setFooter/唯一 Alt+O/握手/RPC 零 UI 全部静态+运行证据 | 命令1 exit 0；命令3 exit 0；`npm run typecheck` exit 0；`git diff --check` exit 0 | 无 | 无 |
| F6-package | implemented + verified | `npm run verify:subagents-enhanced` 通过（manifest/exports、上游 1259 files、import closure 149 edges、tarball 1818 files/17.4MB） | exit 0 | 无 | 无 |
| F7 | **docs verified；视觉 pending-user** | `…footer-acceptance.md` F7 节：4 文档写入、文档—代码一致性核对、链接审计 exit 0；**V1–V14 全部 pending-user，未观察，不得记为通过** | F7 任务本身未跑 test/tsc/npm（S1v 独占 unit-runner）；仅 `git diff --check` 0 + 链接审计 0 | V1–V14 真实视觉全部未观察 | 用户现场观察或后续独立授权视觉 harness |

**F6v 遗留失败分类（不得销账）**：命令2 71/77，6 失败全部为 `test/pi-subagents-enhanced-package.test.mjs` 的 fixture 安装步骤抛 `npm error code ENOTCACHED`——offline 模式下 `var/tmp/npm-cache` 缺 `typescript` packument 与 `typescript-5.9.3.tgz`。**blocked-environment，非 production/测试/校验器缺陷**；未删用例、未放宽校验器。同文件非 fixture 用例（manifest/exports 契约、cache 默认路径）通过。

### 2.3 idle 通知（blocked，未实现）

| task | status | evidence | commands（actual exit） | unverified | nextAction |
| --- | --- | --- | --- | --- | --- |
| I1 | **blocked-upstream**（主缺口）+ coverage blocked-evidence | `…idle-notification-contract.md`：公开 `rpc.status` 返回 details 仅 mode/results、snapshot 为有界展示投影（≤20 root/8 children/depth3/32KiB、partial 可由未知态规范化、leaf 节点 id 为 workflowKey），不能为每个登记完整 ID 提供无歧义 paused/queued/running/terminal 结构化分类；fresh resume 历史 coverage 不能默认空 | 静态 gate：git/status/diff-check 0；Node 内联记录结构检查 0（runtime/notifier tests NOT RUN） | 通知功能整体未实现 | 解除条件：父层提供/批准合法公开接口（exact fullID→原始 state→session 归属）或用户范围决策；然后冻结 I2/I3 合同 |
| I2 | **not-started（前置 I1 blocked，未派发）** | idle contract §9；`test/idle-notification*.test.mjs` 未创建 | 无 | 全部 | I1 解除后另派 |
| I3 | **not-started（前置 I2）** | 同上 | 无 | 全部 | 同上 |
| I4 | **not-started（前置 I3）；实际可见通知从未发出** | 无验收记录（`…idle-notification-acceptance.md` 不存在） | 无 | 全部（含桌面可见性） | 解除 blocked 后按 I4 字段 schema 执行 |
| — | **用户目标状态：主会话空闲系统通知未实现** | 同上 | — | — | — |

### 2.4 triggerTurn（blocked，未实现）

| task | status | evidence | commands（actual exit） | unverified | nextAction |
| --- | --- | --- | --- | --- | --- |
| Q1 | **blocked-upstream** | `…trigger-turn-contract.md`：上游 `sendCompletion(pi,items)`（notify.js:422-438）消息仅 customType/content/display，无 details/receipt/run identity；result-watcher 的 `subagent:async-complete` 是发送后事件；本仓 membrane 仅见 `(message,options)`；bootstrap 不暴露 beforeSend/metadata；用户禁止改上游/fork/patch → 无合法接点 | 静态核对 + sha256 计算 exit 0 | 功能未实现 | 上游提供 public 发送前关联出口或用户解除决策后重启 Q1 |
| Q2 | **not-applicable（未获实施资格，未派 coding）** | Q3 记录 §终态：`dispatch-receipt-policy.ts` 未创建、membrane/extension 未触碰 | 无 | 全部 | Q1 解除后条件实施 |
| Q3 | **blocked-upstream 收口**；`triggerTurn` 保持原语义透传 | `…trigger-turn-acceptance.md`：`test/subagent-completion-notification.integration.mjs` 存在但未读未改未运行 | git status/rev-parse/shasum/diff-check 均 0（记录内） | single/batch/actionable/send-failure 回归全部未跑 | 同 Q1 |

### 2.5 heartbeat

| task | status | evidence | commands（actual exit） | unverified | nextAction |
| --- | --- | --- | --- | --- | --- |
| H1（harness+prepare） | verified（run4 prepare-only 首次全绿） | `…heartbeat-experiment.md` H1p run4：`env -u … PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1 node --test test/heartbeat-parent-death.integration.mjs` **exit 0**，3/3（Host 用例 21266ms，新根 `hb-b9YtbN`）；required 三项/ACK/lease renewalSequence=1/barrier/managed worktree containment/拓扑全真实成立；public workspace discard 后台账 `released` | exit 0 | 前三轮历史失败（required-key/pre-title/跨 locale）均类别 2 已修复并由 run4 实证；lease `renewalSequence>=2` 未出现 | 类别 2 遗留：fixture `childReport().commandsRun: []` 触发 acceptance 拒绝（`Acceptance rejected: commands-run evidence missing from child report.`）**未修**；如需干净 child 结算，父层另派 fixture-only 修正 |
| H1-key | implemented + verified | `extension.ts:1734` `getSessionId()` 修复；membrane 94/94 + package typecheck 0（实验记录引用） | exit 0 | 真实 lease/ACK 证明已由 run4/H2 替代 unit | 无 |
| H2 | **verified（heartbeat 核心）** | `…heartbeat-acceptance.md`：唯一门禁命令 exit 0（3/3，Host 用例 79871ms，根 `hb-BXRJmy`）；一次 SIGKILL 父 PID 91331（12ms 消失）；child/runner 91468 无补杀，`killAt 11:52:59.310Z` → `expiresAt 11:53:59.140Z`（+59830ms 无续租）→ `childExitAt 11:54:01.759Z`（+2619ms，5s watchdog 粒度内），**latencyMs 62449**；`childIdentityEnd.state:"absent"`（非 PID 复用）；`remainingFixturePids:[]`；`childSupplementaryKill:false`；`terminationReason:null`、`publicProcessProof:"pending"`（不补造） | exit 0；收尾 `ps -p 91308/91331/91468` 三次 exit 1（无匹配） | child 结算路径（从未写 release-barrier，acceptance 从未评估）；`renewalSequence>=2`；generic/binding-failed/detached/bash descendants 拓扑；多 child 并发；父 Host stderr（无 failure.json） | 结论严格限定 managed coding+worktree:true 拓扑，不外推 |
| H2 cleanup | **blocked-environment（独立子项，不阻塞/不推翻心跳结论）** | 主管裁决见验收记录：root owner 被实验刻意杀死，public `subagent_worktree status` 无存活调用方 → `allowed_dispositions`/`action_token` 客观不可产出；台账权威值仍 `state:"active"`；**不得宣称 released**。涉及 4 个 active 证据根（`hb-vhjjea`/`hb-fTmWES`/`hb-iKUNgy`/`hb-BXRJmy`，含未处置 managed worktree `0f80fe6d-…`/`fc07e1d9-…`/`0ce4ddea-9284-49e9-890c-260fda350595` 与 stale socket `/tmp/pi-root-subagent-501/cc646255….sock`）+ 1 个已 released 证据根（`hb-b9YtbN`，evidence root retained） | 进程零残留（ps 复核） | 处置面不可达；无当前合法 public exit | 父层另派只读核查受支持恢复/管理路径；若确认无可恢复面，仅生成用户手动精确命令而不执行；不 rm、不 raw worktree、不猜 allowed disposition |

### 2.6 RPC / supervisor（均无样本）

| task | status | evidence | commands（actual exit） | unverified | nextAction |
| --- | --- | --- | --- | --- | --- |
| R1 | **blocked-evidence** | `…rpc-provenance.md`：`sourceClass=unconfirmed`、`evidenceMode=static`；唯一输入为用户报错字符串；复合标签 `rpc:v1/session` 六子条件不可区分；无现场字段级样本 | 静态核对 exit 0 | 全部字段投影 unknown | 向用户申请最小非敏感字段取证清单（R1 记录所列） |
| R2 | **blocked-evidence（处置收口，未修代码）** | `…rpc-disposition.md` + bug 文档追加 | `git diff --check` 0（记录内） | 三候选机制 unconfirmed | 取得证据后分类；确证生产缺陷由父层另派 patch 任务 |
| V1 | **blocked-evidence** | `…supervisor-provenance.md`：无实际 requestId/runId/replyTo/index/consumption 样本 | 静态核对 exit 0 | 全部运行时行为 | 同 R1，最小字段取证 |
| V2 | **blocked-evidence（处置收口，未修控制面）** | `…supervisor-disposition.md` + bug 文档追加 | `git diff --check` 0（记录内） | 真实 reply→consumed 对账等 | fail-closed 保持；证实消费仍被拒时父层另列修复任务 |

### 2.7 Z 本体

| task | status | evidence | commands（actual exit） | unverified | nextAction |
| --- | --- | --- | --- | --- | --- |
| Z | **账本完成；整体 partial** | 本文 | §0 表 6 条全真实执行 | 见 §3 剩余矩阵 | 剩余工作移交父层/用户决策 |

## 3. 剩余工作矩阵（本账本不销账任何一项）

| # | 剩余工作 | 精确阻塞 | 解除路径 |
| --- | --- | --- | --- |
| 1 | S1v 6 项真实 CLI/PTY 隔离测试 | 本批无 visibleHost 独占窗口授权；需先审计 fixture 隔离（临时 HOME/sessionDir/registry、不读用户配置） | 授权 visibleHost + 审计后执行；**不能写成环境永久不可做** |
| 2 | 6 个 package fixture 用例（`test/pi-subagents-enhanced-package.test.mjs`） | offline 缓存缺 `typescript` packument + `typescript-5.9.3.tgz`（`var/tmp/npm-cache` 仅 7.0.2） | 用户授权 official registry 联网，或向仓库缓存补齐两件后显式重跑；不放宽校验器 |
| 3 | 面板真实视觉 V1–V14 | 从未观察；fake/集成测试不替代截图级验收 | 用户现场确认或独立授权视觉 harness（真实 Host 截图/事件日志） |
| 4 | idle 实际可见通知（I2/I3/I4） | I1 blocked-upstream：公开 status 无逐 run 结构化 state；coverage 历史恢复无证据 | idle contract §9 解除条件：合法公开接口或用户范围决策 → 冻结 I2/I3 → I4 可见验收 |
| 5 | triggerTurn 选择性不唤醒（Q2/Q3） | 上游 sender 无稳定 details/receipt 关联；用户禁止改上游/fork/patch | 上游新增 public 接点或用户解除决策 |
| 6 | RPC/supervisor 生产 provenance | 无字段级现场样本（R1/V1 blocked-evidence） | 按两份 provenance 的最小取证清单向用户申请非敏感字段 |
| 7 | 4 个 active heartbeat fixture 的清理 | root owner 已死，无存活调用方可产出 `allowed_dispositions`/`action_token`；无当前合法 public exit | 父层只读核查受支持恢复路径；无恢复面则仅生成用户手动命令不执行 |
| 8 | H1 类别 2 fixture 报告缺口 | `childReport().commandsRun: []` + acceptance level 未声明 → acceptance 拒绝 | 父层如需干净 child 结算，另派 fixture-only 最小修正 |
| 9 | scheduler store/lock 并发修复 | 计划全局约束本批不做；不因 footer 绿色显示销账 | 另案用户决策 |
| 10 | resume 换模型 bug | 只登记未修：`docs/bugs/2026-10-14-subagent-resume-model-override.md`（上游 `resumeParams` 静默丢弃 model，receipt 无 warning）；**用户期望仍支持换模型**（fresh spawn 显式 model 已证可用）；**不擅自实施 warning/reject 类修复** | 用户决策修复方向（本仓显式信号 or 上游对齐直连守卫） |
| 11 | 全仓回归 | `npm test` / all-integration 未跑，不能 wholegreen | 用户要求时先独立风险审计再显式运行 |
| 12 | 主代码提交 | HEAD 停留 `a9875d62…`，未 commit 未 push；index 空 | 用户对当前 dirty 集合明确授权后才提交 |

## 4. 功能终态汇总（partial 的构成）

- **implemented + verified（有真实运行/静态双重证据）**：B、S1g、S1a、S1b、S1v（非 PTY 范围）、F0、F1、F2a、F2a-v、F2b、F2b-v、F3、F4g、F4a、F4b、F5a、F5b、F6、F6-package、F7（docs 部分）、H1、H1-key、H2（heartbeat 核心）。
- **blocked（不算功能完成）**：I1（blocked-upstream + coverage blocked-evidence）、Q1/Q3（blocked-upstream）、R1/R2（blocked-evidence）、V1/V2（blocked-evidence）、S1v PTY 项（blocked-environment）、F7 视觉（pending-user）、F6v 6 例 package fixture（blocked-environment）、H2 cleanup（blocked-environment）。
- **not-started（前置 blocked，未派发）**：I2、I3、I4、Q2（not-applicable）。
- **用户目标级缺口**：主会话空闲系统通知未实现；纯派发不唤醒未实现；RPC/supervisor 个案未证实未修；真实视觉未观察。

## 5. 本批边界

未运行 Node tests/tsc/npm/网络/真实 Host/provider/系统通知/进程信号/清理/raw git worktree；未读真实 settings/models/auth/credential/session authority/state 正文；未 stage/commit/stash/reset/push；未覆盖任何历史 baseline/acceptance 记录；todo 与 review 文件仅追加（见两文件末尾追加节）。
