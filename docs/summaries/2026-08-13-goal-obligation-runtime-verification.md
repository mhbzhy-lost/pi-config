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
