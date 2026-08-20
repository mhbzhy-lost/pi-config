# R12 Doctor/Skill/Migration/Canary 验证记录

## 组合结果

本次在 fresh `main`（R11 D：`0ad8235`）按普通 cherry-pick 顺序组合，均无冲突：

- Skill/说明：`ce387c5` → `d221d22`
- Doctor：`9796eba`、`39cdb62`、`be8bd36` → `6c70d53`、`e8368f2`、`eda63ab`
- Generation：`81b4876` → `cbfc174`
- Canary：`4012346`、`14939a4`、`026fae9` → `196f6b0`、`8f1e72a`、`7ed4af9`

候选修复的 Critical 是 Observation artifact request 漏传 `stateRoot`：bug 记录在 `docs/bugs/bug-goal-observation-artifact-request-omits-state-root.md`，`8f1e72a` 已修复，并由 `7ed4af9` 的真实 canary 覆盖。R12 不进行独立外审或过度建设裁决；该项留给 R13 的只读统一复审，不能把本记录当成外审结论。

## 两阶段实际命令与统计

以下第一阶段命令均在 R12 isolated worktree 实际执行；其环境阻塞记录保留，随后在 fresh `main` 完成复验。长输出保存在 `/tmp/r12-*.log`。

### R12 isolated worktree 原始记录

| 命令 | 结果 | 统计/说明 |
|---|---|---|
| `node --test test/doctor.test.mjs test/goal-runtime-doctor.integration.mjs` | 环境阻塞 | 35：34 pass、1 fail。失败的是 Doctor CLI readiness 断言，原因见下。runtime boundary probes 通过。 |
| `node scripts/doctor.mjs` | 环境阻塞 | 退出 1；缺少 `pi-subagents@0.45.2`、`typebox@1.1.38`、`@amaster.ai/pi-task-scheduler@0.1.9`、`@amaster.ai/pi-shared@0.1.9`、`croner@10.0.1`；另报告宿主的 unmanaged/dirty/sequencer worktree warnings，未伪称 ready。 |
| `node --test test/goal-engine-generation-compatibility.integration.mjs` | GREEN | 3/3 pass。v1/v2/v3/planned 基线 replay/mutation/completion 均保持，runtime 不从旧日志推断。 |
| `node --test test/goal-runtime-real-canary.integration.mjs` | GREEN | 1/1 pass。真实 Pi production Host 在独立临时 repo/state root 中记录 PASS artifact、两轮 observation 均 released、终审记录完成，资源无 cleanup debt。 |
| `node --test test/goal-engine-finalization*.integration.mjs test/goal-engine-final-review*.integration.mjs` | GREEN | 212/212 pass。D finalization/final-review 的纯账本与 fail-closed 覆盖通过。 |
| `node --test test/goal-engine-managed-validation*.integration.mjs` | GREEN | 22/22 pass。managed validation 的 lease、crash recovery、terminal/release 与 cleanup-debt 边界通过。 |
| `PI_REAL_BIN=$(command -v pi) node --test test/pi-runtime.integration.mjs` | 环境阻塞 | 2：1 pass、1 fail。真实 Pi RPC 无法加载缺失的 `pi/npm/node_modules` 中 pi-subagents、task-scheduler 依赖。 |
| `node --test test/goal-engine-*.test.mjs test/goal-engine-*.integration.mjs` | GREEN | Goal full suite 1090/1090 pass。 |
| `npm test` | 环境阻塞 | 在时限内完成，527：513 pass、14 fail；失败集中于缺失的本地 Pi/subagent/task-scheduler 依赖及其相关测试，非 timeout。 |

### 随后 fresh `main` 复验

main 的受管依赖已消除上述 worktree 环境阻塞，以下为实际复验结果，全部 GREEN：

| 命令 | 结果 | 统计/说明 |
|---|---|---|
| `node --test test/doctor.test.mjs test/goal-runtime-doctor.integration.mjs` | GREEN | 35/35 pass。 |
| `node scripts/doctor.mjs` | GREEN | rc 0；保留 Doctor 报告的 preserved/identity-mismatch workspace warnings。 |
| `PI_REAL_BIN=$(command -v pi) node --test test/pi-runtime.integration.mjs` | GREEN | 2/2 pass。 |
| `npm test` | GREEN | 634/634 pass。 |
| `node --test test/goal-engine-*.test.mjs test/goal-engine-*.integration.mjs` | GREEN | Goal full suite 1215/1215 pass。 |
| `node --test test/goal-runtime-real-canary.integration.mjs` | GREEN | real canary 1/1 pass。 |

validation timeout fixture `d10f672` 仅将超时预算由 100 调整为 1000，断言不变。

## Skill 与退役测试

Skill 候选压力 GREEN 的既有证据使用候选绝对路径加载：`/Users/mhbzhy/pi-config/.state/subagent-dispatch/worktrees/c16ea28f-4a3c-40f8-be72-4391ffeb8f71/skill-overrides/using-goal-engine/SKILL.md`；允许 approved runtime finalize。三个无 Skill 基线均正确。该候选压力执行不是本工作树本次重新运行的命令，故不把它计入上表实际统计。未创建或复活退役的 `using-goal-engine-skill.test.mjs`、`migration-contract.test.mjs`。

## Manual Preview 限制

`pi/AGENTS.md` 明确：`goal-runtime.v1` 只由人工基于 `goal_status` 与其 typed tool action 推进，没有 auto-continuation；旧 generation 语义不变；R13 完成前不 production cutover。此处不复制状态机。

## 残余风险

Doctor 报告 preserved/identity-mismatch workspace warnings，需由 R13 进行只读核验并作 typed 处置。R12 未进行外审；除上述 workspace warnings 外，不再声称存在依赖缺失。

## R13 内部只读验收（NO-GO，2026-08-13）

本轮在受管依赖可用的 `main`（开始时 `b58e7e9`）执行；长输出仅写入
`/tmp/r13-verification/`，未修改生产、测试、Skill、配置或 `.state`。按 R13
失败即停止规则，第二项行为测试失败后不再运行 Doctor、worktree audit、Pi、全量
或外源复审命令；因此本轮结论为 **NO-GO**，不得作为 R13 完成或 production
cutover 依据。

| 命令 | 结果 | 真实统计/原因 |
|---|---|---|
| `node --test test/goal-engine-*.integration.mjs test/goal-runtime-*.integration.mjs` | GREEN | 1095/1095 pass，0 fail，209.720 s。覆盖 exact-eight、planned accept-auto、runtime finalize 与 Manual Preview 的现有集成断言。 |
| `node --test $(find test -maxdepth 1 -type f \( -name '*subagent*.test.mjs' -o -name '*subagent*.integration.mjs' -o -name 'root-subagent-broker*.test.mjs' -o -name 'root-subagent-broker*.integration.mjs' -o -name 'worktree-lifecycle-*.test.mjs' -o -name 'worktree-lifecycle-*.integration.mjs' \) -print \| sort -u)` | RED | 39 个实际存在的 glob 文件，500 tests：494 pass、5 fail，61.277 s。首个失败为 `test/pi-subagents-045-workflow.integration.mjs`，断言 `PI_REAL_BIN` 必须指向受支持 Pi host，但本次命令未显式提供该变量；后续 4 个失败同属真实 Pi host/顶层 child 环境（其中 `PI_SUBAGENT_CHILD` 使 top-level runtime 拒绝启动）。R13 禁止修复或重跑掩盖该失败。 |

只读审计补记：开始前主工作区 clean，`pi/settings.json` 无 diff，暂存区为空；
`.state` 没有未跟踪条目（仓库已有的 8 个已跟踪状态路径未变）；Attempt5 recovery
ref `b623cf7` 存在。`git worktree list` 显示 main 及 preserved managed worktrees，
未作 repair/release/discard/clean。planned-goal 仍按冻结债务保留，须在 R13 真正
GREEN 后由 fresh Host typed 收尾。外源复审仍 pending。

### R13 残余风险与恢复入口

- 必须由对应前序验收阶段以显式 `PI_REAL_BIN=$(command -v pi)`、且非 child 的顶层
  环境定位并修复/确认这 5 个失败，然后从 R13 重跑全部规定命令。
- 本轮因停止规则未产生 Doctor、worktree audit、Pi、canary、`npm test`、
  `npm run test:goal-engine` 的 R13 新证据；R12 旧证据不能替代。
- 外源只读复审尚未开始；Manual Preview 保持人工 `goal_status` typed action 推进，
  auto-continuation 仍须在 R13 后另立 fresh Host typed 计划。

## R13 重跑与最终门禁结论（NO-GO，2026-08-20）

首次 R13 因 harness omission（未显式提供受支持的 `PI_REAL_BIN`，并受 child
环境影响）按失败即停止，保留该次 NO-GO 历史。随后纳入 fixture 修复
`c7f7885`（候选提交 `2b1fdfc`）并完成重跑；本节只记录只读验证证据，未改变
R13 计划、代码、测试、Skill 或配置。

### 重跑 GREEN 证据

- 39 个 harness 文件、500/500 tests GREEN；`npm test` 634/634 GREEN。
- Goal full suite 1215/1215 GREEN；Doctor/Generation/Canary/Pi 组合 41/41
  GREEN；`node scripts/doctor.mjs` rc 0。
- Root exact-eight 完整且顺序为：`goal_init`、`goal_status`、`goal_dispatch`、
  `goal_settle`、`goal_integrate`、`goal_accept`、`goal_amend`、`goal_finalize`。
  退役的 `using-goal-engine-skill.test.mjs` 与 `migration-contract.test.mjs`
  均 absent；`pi/settings.json` 无 diff。
- Attempt5 recovery object 与 recovery ref `b623cf7` 均存在；R0 workspace
  只读证据存在。未创建或复活退役测试。

### 资源审计与只读边界

Worktree audit rc 0，但仍有 28 项 cleanup-debt、53 项 released。Doctor stderr
分类保留为：109 preserved、27 unmanaged、27 identity mismatch、5 dirty、2
sequencer、1 owner-active、1 cleanup-debt。R13 未执行 repair、release 或
discard；这些 durable worktree/process/resource debt 仍未满足门禁。

### DeepSeek Round1 外审 triage

最终 exhaustive review 范围为 `0eaad6d..c7f7885`，diff 120000（truncated），
返回 12 项。逐项以 HEAD、测试及协议证据核对后均不成立，且不得声称 reviewer
给出 Ready：

1. lock scopes/provider outside：现有锁范围与 provider 边界正确；
2. offer +1：实现符合 offer 语义；
3. condition definition：定义完整；
4. status 布尔值：取值正确且有 critical 测试；
5. 重复 pending/strict compaction：属于有意设计；
6. unknown stop：保持 suspended，符合 fail-safe；
7. amendment：使用 current-world baseHead CAS；
8. concurrent event：stale 行为是有意设计；
9. serialized queue：序列化队列正确；
10. doctor draft 缺 obligation：按预期拒绝；
11. metadata intent 失败：必须 fail closed；
12. 其余关联项均为上述边界的重复归并，无独立代码 blocker。

### 最终结论

代码与行为验收为 **GREEN**，外审无采纳的代码 blocker；但 R13 总体仍为
**NO-GO**，原因是 durable worktree/process/resource debt 未满足门禁。只有在
用户明确授权后，才能进入 managed lifecycle 或 typed disposition；unknown
terminal 仍只能 preserve。production 仍为 **Manual Preview**：不 cutover、
不 push、不收尾 frozen planned-goal。

## 受管清空、clean-start 重测与 reset 外审（最终验证摘要）

### 受管 reset

- feature：`e4ef449`。
- 授权 CAS hash：`2c479333...`。
- 受管清空已完成：`planned-goal` cleared；after hash：`b671115e...`。
- active `goalIds=[]`，Goal worktrees 为空。
- 本节仅记录验证摘要，不记录 ledger 正文。

### clean-start 串行真实 GREEN

clean-start 后串行重测全部为真实 GREEN：Goal full 最终 `1224/1224`，39 文件
`500/500`，Doctor/Generation/Canary/Pi `41/41`，`npm` `634/634`，reset target
`9/9`。Doctor/npm 并行运行的 30 秒 timeout 仅作为竞争证据；串行结果为权威结论。

安全修复 `f9904cd` 包含 `fd` 的 `O_NOFOLLOW` identity 校验与 cleanup rollback。

### reset diff 外审

Round1 接受 TOCTOU 与 rollback 两项，其余反馈均证伪。Round2 返回项全部证伪，
包括 fd inode 安全、非合作 worktree 修改应为 `RECOVERY_REQUIRED`、pending 无资源时
允许清空，以及其他诊断/风格反馈。不运行第三轮，不声称 reviewer Ready。

### 最终门禁与发布边界

Goal active runtime 已从干净状态验收 **GREEN**；但全局 subagent/worktree 历史
warnings 未清理，若 R13 门禁解释为全仓资源则仍为 **NO-GO**。production 继续
**Manual Preview**，不 push。
