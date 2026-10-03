# pi 栈升级仓 main 合并与统一完善实现计划（v2，按 reviewer 修订）

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 将旧仓 main（0b59878，16 个真实入流提交）merge 进新仓 `upgrade/pi-stack-0.87`，完成 v2 dispatch schema × 0.71 运行时适配的分层合并与兼容性调整，重跑全部门禁，并把已登记的三项缺陷（resumed-child 挂起、session-owner 守卫拦截、terminal-proof 语义）纳入收尾任务。

**架构：** 合并采用「合同层采 v2（theirs）、运行时层保 0.71（ours）、交界面手工交织」的分层策略（依据 `var/upgrade/main-merge-conflict-analysis.md` §2-DD1 的正交性实证）。工作区先按文件边界提交为代码/文档两笔原子提交，`pi/settings.json` 以 pathspec 显式排除（随主仓策略转为未跟踪本机配置）。

**技术栈：** git 三方合并（真实 merge-base `2c72bbf`）；pi core 0.87.1 × pi-subagents 0.71.0；node --test 双门禁（npm test 主 glob + test:all-integration 串行集成门禁）。

## 全局约束

- **真实 merge-base 是 `2c72bbf`**（不是 578537d）：新仓分支是旧仓 main 前 36 提交的等树重写，52 提交中仅 T5 后 16 个真实入流；merge 前必须 `git fetch origin`（新仓 origin/main 陈旧于 0518fb9，否则 merge no-op）。
- **冲突面互斥统计**：merge 产生 **76 个冲突路径** = 46 内容冲突 + 26 添加/添加 + 4 修改/删除。处置分类（对冲突路径的划分）：**A 类 22**（双方真改，手工交织；均为内容/添加冲突）；**B 类 25**（主仓单侧语义，整文件取 theirs）+ **C 类 29**（新仓单侧语义，整文件取 ours）= 54 个可整侧处理；**修改/删除 4**（3 取 theirs 删除侧：settings.json、skill-overrides/subagent-dispatch/SKILL.md、test/subagent-dispatch-skill.test.mjs；1 取 ours 删除侧：ordered-models-runtime-patch.ts）。另有 **2 个僵尸文件**（generic-prompt.ts、model-tiers.yaml）**不计入 76**——它们是 merge 静默保留的 ours 路径（theirs 相对 base 无变化），须 merge 后手动删除。
- 合并语义优先级：**合同层（dispatch-ir/execution/protocol/AGENTS_APPEND/probes/约 20 个测试）取 v2；运行时层（compat 0.71/rpc-client/membrane/authority/model-selection/workspace/extensions）保 ours**。
- **S1（采纳 v2 合同层）已拍板：采纳**（2026-09-30，用户决策）；**S3（rename canary 语义）已拍板：A 新仓裁决版**（2026-09-30，用户决策；依据：broker 身份经代码验证是 managed workspace 生命周期的配套服务——integration 订阅/proof settlement/lease 存活三项全部资源导向，无 workspace 的 coding run 不需要任何一项，b332005 门控为正确设计，HANDOFF #10 同时关闭）；S4（effects 计数）为实施规则（按 merge 后实测，不拍数字）；S5-S8 为计划批准即确认项（settings 删除、保持 patch 删除、删僵尸文件、doctor 迁 v2）。
- `pi/settings.json`：T1 提交以 pathspec 显式排除（`:!pi/settings.json` 或 `:(exclude)`），T2 冲突时取 theirs 删除侧；提交与 merge 全程必须验证其不进任何提交。
- **`var/upgrade/**` 为 gitignore 的本地证据目录**：所有任务报告（merge-task*.md、诊断报告等）只作本地验收证据，不进入任何 Git 提交；提交类任务的证据指针写在 commit message 与 HANDOFF。
- lockfile ×2 取 ours 后必须**分别在根目录与 `packages/pi-subagents-enhanced/` 目录**执行 `npm install --package-lock-only` 并核对两个 lockfile 无非预期 diff。
- 提交遵循 `git-commit-convention` skill（执行时先 read）；本计划已获用户授权提交与 merge（用户指令「将 main merge 进来」）。
- 全部操作仅在新仓 `~/pi-config-upgrade` 执行；旧仓 `~/pi-config` 只读。
- 已知决策项默认值（用户批准本计划即视为确认，依据分析报告 §4.2）：S1 采 v2、S2 1a 期望反转、S3 canary 取新仓裁决版、S4 effects 计数按实测、S5 settings 删除、S6 保持 patch 删除、S7 删僵尸文件、S8 doctor 迁 v2；S9（terminal-proof 语义）在 T9 前单独向用户确认。
- 三项已登记缺陷（HANDOFF #11a/#11b/#12）在 merge 稳定后执行（用户指示：先登记不立即修复，纳入本计划统一收尾）。T7/T8 的诊断必须先重新核对已存档证据的观测是否在 merge 后仍然成立（v2 合并可能改变调用链），不得直接假定嫌疑面不变。
- 30 分钟 watchdog：subagent 不跑全量 `npm test`（全量由主会话执行）；集成门禁单次约 12 分钟可由 subagent 跑但须 timeout 包裹。
- **「后续切换阶段」**（原 HANDOFF 登记的 T12 第三段：合回主树+全局安装+shell/skills 同步）不在本计划任务范围内；本计划 T10 只产出其前置状态登记。

## DAG

```text
T1 (工作区分组提交) ──> T2 (fetch+merge+批量取侧) ──> T3 (A类生产文件交织)
    ──> T5 (doctor.ts v2 迁移, 需 T3 后的已解决生产面) ──> T4 (A类测试交织+merge commit)
    ──> T6 (全量门禁与漂移修复)
T6 ──> T7 (resumed-child 挂起诊断+修复)
T6 ──> T8 (session-owner PTY 守卫诊断+修复)
T6 ──> T9 (terminal-proof 裁决实施, 用户门控)
T7+T8+T9* ──> T10 (HANDOFF 终版与收尾; T9 可 suspended)
```

**串行化理由（reviewer 阻塞项 1）**：T2 产物是 MERGE_HEAD 挂起 + A 类 22 文件含冲突标记的 UU 状态。`typecheck:subagents-enhanced` 覆盖 `packages/**/src|extensions/*.ts`（含 A 类 extension.ts），必须等 T3 解决全部生产 .ts 后才能通过；`typecheck:root` 的 include 不含 packages 与 test（doctor.ts 的编译检查实际由 doctor.test.mjs 的直接 import 承担，且该测试自包含、不依赖任何 UU 文件）。T5 必须在 T4 的 merge commit 之前完成，使 doctor 迁移进入 merge 提交树；A 类测试文件（.mjs 为主，唯一 .ts 不在任何 tsconfig include 内）不受 typecheck 影响，由 T4 统一交织与验证。

## Waves

- Wave 1：T1（git index 独占）
- Wave 2：T2（merge 独占）
- Wave 3：T3
- Wave 4：T5
- Wave 5：T4（含 merge commit）
- Wave 6：T6（全量门禁，主会话执行）
- Wave 7：T7、T8、T9（可并行；T9 受用户裁决门控）
- Wave 8：T10（T9 可 suspended）

**关键路径：** T1 → T2 → T3 → T5 → T4 → T6 → T7/T8/T9 → T10。

---

### Task 1：工作区分组提交（代码/文档两笔，动态清单）

**Deps：** `none`

**WritePaths：**（只动 git index/commit，不改文件内容）

**Resources：** git index 独占；单任务。

**Files：**
- Modify（git index）：当前全部工作区变更（**动态清单**：实测为 100 条 = 77 tracked 变更 + 23 未跟踪；以执行时 `git status --short` 实际输出为准，先存档清单再操作）。
- 未跟踪文件归属表（实测基线，执行时核对）：`HANDOFF.md`、`docs/bugs/**`（11 个新记录）、`docs/plans/2026-09-30-main-merge-and-consolidation.md`、`docs/upgrades/**` → **文档提交**；`packages/pi-subagents-enhanced/src/compat/pi-subagents-0.71.ts`、`src/subagent-dispatch/runtime-state.ts`、`scripts/run-integration-gate.ts`、`test/{integration-gate-selection,subagent-authority-retry,subagent-completion-notification.integration,subagent-ordered-models,subagent-runtime-state,subagent-spawn-rollback}.mjs` → **代码提交**。
- **`var/upgrade/**` 不进入任何提交**（gitignore 本地证据）。

**接口契约：**
- Consumes：当前工作区（动态清单核对）。
- Produces：两个提交（代码+测试一笔、文档一笔）+ 干净工作区 + `pi/settings.json` 未跟踪状态，供 T2 merge。

**验收标准：**
- [ ] **步骤 1：动态清单存档**——`git status --short > var/upgrade/t1-preflight-status.txt`；逐条核对该清单与归属表，任何无法归类的条目停下报告（不得静默处置）。
- [ ] **步骤 2：先 read `/Users/leshi.zhy/.agents/skills/git-commit-convention/SKILL.md`。**
- [ ] **步骤 3：第一笔提交（代码+测试）**——`git add -A -- . ':(exclude)pi/settings.json' ':(exclude)docs' ':(exclude)HANDOFF.md' ':(exclude)var'`（pathspec 显式排除，杜绝 settings.json 经宽泛 add 回流）；提交主题：升级主体 + 四项生产缺陷修复 + 悬空集成测试修复 + 集成门禁（正文分节概述与本地证据指针 var/upgrade/*，注明「本地证据不随提交」）。
- [ ] **步骤 4：第二笔提交（文档）**——`git add docs/ HANDOFF.md`；提交主题：升级验收文档与缺陷记录。
- [ ] **步骤 5：排除验证（reviewer 阻塞项 4）**——`git diff HEAD~2 --name-only | grep -Fx pi/settings.json` 必须无输出；`git status --short -- pi/settings.json` 显示 `??`（未跟踪）而非 staged；`git status --short` 除 `?? pi/settings.json` 外为空；`git log --oneline -2` 两笔新提交。
- [ ] **步骤 6：`pi/settings.json` 本地保留**——文件仍在磁盘（未删除，供本会话继续使用；其 0.87.1 changelog 标记随 T2 并入的 fed4655 模板机制承接）。

### Task 2：fetch + merge + 批量取侧与僵尸清理

**Deps：** `T1`（理由：merge 需要干净已提交的 ours 树）

**WritePaths：** git index 与 B/C 类 54 个文件 + 修改/删除 4 个文件的取侧结果。

**Resources：** git index 独占；单任务。

**Files：**
- Merge 引入：B 类 25 文件取 theirs（清单见分析报告 §3「B 类」段）；C 类 29 文件取 ours（含 `ordered-models-runtime-patch.ts` 删除侧）。
- Delete：僵尸文件 `packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts`、`skill-overrides/subagent-dispatch/model-tiers.yaml`（S7）；`skill-overrides/subagent-dispatch/` 目录随之清空。
- 排除不动：A 类 22 文件保持 UU 状态留给 T3/T4。

**接口契约：**
- Consumes：T1 的两笔提交；`origin/main` = 0b59878。
- Produces：merge 进行中状态（MERGE_HEAD 存在，仅剩 A 类 22 文件 UU），供 T3/T5/T4。

**验收标准：**
- [ ] **步骤 1：`git fetch origin`** 并核对 `git rev-parse origin/main` = 0b59878。
- [ ] **步骤 2：`git merge origin/main --no-ff --no-commit`** → 预期 76 个冲突路径（46 内容 + 26 添加/添加 + 4 修改/删除）；实际冲突清单与预期偏差 >5 项时停下报告。
- [ ] **步骤 3：B 类批量取 theirs**：按分析报告 §3 清单逐文件 `git checkout --theirs -- <file> && git add <file>`；其中 `skill-overrides/subagent-dispatch/SKILL.md` 与 `test/subagent-dispatch-skill.test.mjs` 为修改/删除冲突的 theirs 删除侧：`git rm`。
- [ ] **步骤 4：C 类批量取 ours**：`git checkout --ours -- <file> && git add <file>`；`ordered-models-runtime-patch.ts` 为 ours 删除侧：`git rm`；lockfile ×2 取 ours。
- [ ] **步骤 5：`pi/settings.json` 修改/删除冲突取删除侧**：`git rm --cached pi/settings.json`（本地未跟踪保留）。
- [ ] **步骤 6：删除僵尸文件**：`git rm packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts skill-overrides/subagent-dispatch/model-tiers.yaml`；确认目录清空。
- [ ] **步骤 7：lockfile 双目录校验（reviewer 建议 1）**——分别在根目录与 `cd packages/pi-subagents-enhanced` 执行 `npm install --package-lock-only`；`git diff --name-only` 确认两个 lockfile 无非预期 diff。
- [ ] **步骤 8：验证**——`git status` 仅剩 A 类 22 文件 UU；`git diff --name-only --diff-filter=U | wc -l` = 22；不 commit（T4 完成后统一提交）。

### Task 3：A 类生产文件手工交织（v2 合同层 × 0.71 运行时层）

**Deps：** `T2`（理由：消费 merge 冲突现场）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/package.json`
- `packages/pi-subagents-enhanced/scripts/verify-package.ts`
- `scripts/probes/repository-merge-queue-acceptance.ts`
- `test/fixtures/recovery-resume/scripted-model-server.mjs`
- `test/fixtures/repository-merge-queue-acceptance/root-provider.mjs`
- `var/upgrade/merge-task3-report.md`

**Resources：** none

**Files：**
- Modify：上述 7 个 A 类生产/probe/fixture 文件（extension.ts 29 冲突块为最重）。

**接口契约：**
- Consumes：分析报告 §2-DD1/DD2/DD3 的逐块裁定结论；T2 的冲突现场。
- Produces：全部生产 .ts 已解决的 merge 树（enhanced typecheck 可通过），供 T5/T4。

**验收标准：**
- [ ] **步骤 1：逐块裁定 extension.ts（29 块）**——原则：schema/routing/超时/文案块取 theirs（v2 字段表、`compileDispatchIR` 入口、TYPED_SUBAGENT_PARAMETERS v2、Host 注入超时无硬杀、list control 动作与描述）；spawn/capability/admission/import 块取 ours（`negotiateCapabilities`、`spawnBinding`、`assertSpawnCapabilities`、`registerRequiredChildExtensions`、repository admission 分支、`discover` 接线指向 compat 0.71 投影）。每块处置记入报告。
- [ ] **步骤 2：root-broker-server.ts（2 块）取 ours**（Bug #4 重试 + kind 观察 + generic owner receipt）；确认 373ef99 goal 去门控区域保持自动合并结果不回退。
- [ ] **步骤 3：package.json（依赖版本块取 ours 0.87.1 四包 + `./generic-prompt` 导出删除取 theirs 叠加）；verify-package.ts（清单变化取 theirs + 其余 ours）；两个 probe/fixture 文件按「v2 合同形态为骨架 + 0.71 服务端行为保 ours」交织。**
- [ ] **步骤 4：验证（生产面限定）**——`npm run typecheck:subagents-enhanced` 通过（此时全部 packages 内 .ts 已解决；A 类测试文件多为 .mjs 不在 typecheck 范围，唯一 .ts 测试不在任何 tsconfig include 内）；**本任务不跑测试**（A 类测试文件仍 UU，聚焦测试归 T4——reviewer 阻塞项 1/建议 3 的边界拆分）。
- [ ] **步骤 5：报告落盘** `var/upgrade/merge-task3-report.md`：逐块处置表、typecheck 证据。
- [ ] **停止条件**：发现 v2 与 0.71 在某块需要改写对方层内部逻辑才能共存（分析报告判定之外的架构性矛盾）→ 停下用 contact_supervisor 报告。

### Task 5：doctor.ts v2 API 迁移（在 T3 后、T4 的 merge commit 前）

**Deps：** `T3`（理由：doctor 的运行验证需生产面已解决；且必须在 T4 提交 merge 前完成使修复进入 merge 树——reviewer 阻塞项 1）

**WritePaths：**
- `scripts/doctor.ts`
- `test/doctor.test.mjs`（如需跟新探测断言）
- `var/upgrade/merge-task5-report.md`

**Resources：** none

**Files：**
- Modify：`scripts/doctor.ts:13`（import `compileCodingDispatchIR` → `compileDispatchIR`）、`:112` 附近（`request.version === "dispatch-ir.v1"` 探测分支 → v2 探测合同）。

**接口契约：**
- Consumes：v2 `compileDispatchIR` 导出签名（T2 已取 theirs 的 `src/contracts/dispatch-ir.ts`）；T3 解决后的生产面。
- Produces：v2 兼容的 doctor 探针（进入 merge 提交树），供 T6 全量门禁。

**验收标准：**
- [ ] **步骤 1：读 v2 `dispatch-ir.ts` 导出面**，确定 doctor 探测合同新写法。
- [ ] **步骤 2：RED**——`TMPDIR=/tmp node --test test/doctor.test.mjs` 当前形态（doctor.ts 引用已消失的 v1 导出；该测试自包含——仅 import doctor.ts 与 node 内置模块，不受 UU 文件影响；记录失败形态）。
- [ ] **步骤 3：迁移 doctor.ts**——import 与探测分支改 v2；其余检查不动。
- [ ] **步骤 4：GREEN**——`test/doctor.test.mjs` 全绿 + `npm run typecheck:root`（include 不含 doctor.ts，作回归面）+ `npm run typecheck:subagents-enhanced`（T3 后应保持绿）。
- [ ] **步骤 5：报告落盘** `var/upgrade/merge-task5-report.md`（TDD 声明：行为迁移类，RED 为 v2 下断裂形态）。

### Task 4：A 类测试文件交织、语义反转与 merge commit

**Deps：** `T3`、`T5`（理由：测试期望依赖 T3 生产语义；merge commit 必须在 T5 doctor 迁移完成后——reviewer 阻塞项 1）

**WritePaths：**
- `test/pi-subagents-project-workflow.integration.mjs`
- `test/pi-subagents-runtime.integration.mjs`
- `test/repository-merge-queue-acceptance-probe.test.mjs`
- `test/subagent-delegation-workspace.e2e.mjs`
- `test/subagent-dispatch-contract-hash-compat.test.mjs`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-model-selection.integration.mjs`
- `test/subagent-runtime-membrane.test.mjs`
- `test/init-pi.test.mjs`
- `var/upgrade/merge-task4-report.md`

**Resources：** none

**Files：**
- Modify：上述 10 个 A 类测试文件（含 init-pi.test.mjs 模板断言合并）。

**接口契约：**
- Consumes：T3 生产语义、T5 doctor 迁移；分析报告 DD2/DD4 裁定。
- Produces：全冲突解决完毕的 merge commit（含 doctor 迁移），供 T6。

**验收标准：**
- [ ] **步骤 1：project-workflow（7 块）**——1a 期望反转（S2，计划批准即确认）：`proof.terminal` 断言改回非空（`instances.length > 0`）**并保留 ours 的 `authorization.state === "unavailable"` 佐证**；canary 按 **S3 用户决策**实施（默认建议 A：新仓裁决版 worktree:true + workspace_id 断言 + 吸收主仓 records-emptiness 断言；若用户选 B 则按主仓版 worktree:false + proof null）；fixture = v2 形态 + ours 的 configRoot 内置 profile 复制；`pinned to 0.62.0` 文案改 0.71.0；测试名取 ours。
- [ ] **步骤 2：model-selection（5 块）**——theirs v2 合同形态 + ours 的 R10 admission 测试与 preflight 分离计数保留；`effects` 计数按聚焦实测重导出（S4 实施规则）。
- [ ] **步骤 3：其余 8 文件**——按「v2 形态为骨架 + 0.71 行为断言保 ours」交织（对照分析报告 §3 表）；`test/init-pi.test.mjs` theirs 模板断言 + ours 0.87.1 断言合并。
- [ ] **步骤 4：聚焦验证（全绿标准，reviewer 建议 3）**——`TMPDIR=/tmp timeout 600 node --test <上述全部 test 文件 + test/doctor.test.mjs>` 全绿；失败零容忍（此时无任何 UU 文件，「预期失败」概念不成立）。
- [ ] **步骤 5：提交 merge**——`git commit` 完成 T2 发起的 merge（含 T3/T5 全部解决；commit message 按 git-commit-convention：merge 主题 + 分层策略摘要 + 76 冲突处置统计）。
- [ ] **步骤 6：验证**——`git status` 干净（除 `?? pi/settings.json`）；`git log --oneline -2` 显示 merge commit；`git diff HEAD --stat` 为空。
- [ ] **步骤 7：报告落盘** `var/upgrade/merge-task4-report.md`：逐文件处置、S4 实测计数依据、聚焦验证输出、merge commit 哈希。

### Task 6：全量门禁与 merge 后漂移修复

**Deps：** `T3`、`T4`、`T5`（理由：需要合并树完整落地）

**WritePaths：**（漂移修复时才产生；预期集中在 v2 测试迁到 0.71 膜后的断言校准）
- `test/**`（v2 迁移测试的 0.71 行为校准）
- `var/upgrade/merge-gate-report.md`

**Resources：** 全量门禁由主会话执行（30 分钟 watchdog 约束）。

**Files：**
- Modify：按实测漂移清单（预期：spawn reply/status 投影类断言，DD1-5 残余风险）。

**接口契约：**
- Consumes：T4 的 merge commit。
- Produces：全绿基线（新数字），供 T7/T8/T9 与后续切换阶段引用。

**验收标准：**
- [ ] **步骤 1：`TMPDIR=/tmp npm test`**——记录新总数（原 989/987/0 基线 + theirs 新增测试）；失败项逐个按缺陷数据来源分类门禁处置：v2-on-0.71 断言漂移（修测试）/ 真实合并缺陷（修生产，bug 记录+TDD）/ 既有排除项。
- [ ] **步骤 2：`TMPDIR=/tmp npm run test:all-integration`**——runner 自动枚举（theirs 新入集成文件自动接线；预期文件数 > 30）；排除表核对：resumed-child、session-owner-runtime 维持 PENDING-DIAGNOSIS，terminal-proof-handoff 维持 PENDING-ADJUDICATION。
- [ ] **步骤 3：`npm run typecheck:root && npm run typecheck:subagents-enhanced && npm run verify:subagents-enhanced`**。
- [ ] **步骤 4：聚焦语义钉子**（分析报告 §4.3-5 全清单）——含 `test/pi-subagents-compat.test.mjs`（R10 admission 回归）、`test/session-owner-decision-log.test.mjs`（7f58a12 吸收）、`test/ensure-pi-settings.test.mjs`（**merge 输入产物**，T2 落地后才存在）、`test/pi-shell.test.mjs`。
- [ ] **步骤 5：真实 Host 探针**——按 R10 模式：typed dispatch（executor 通过 / probe-worker fail-closed）+ 一次 managed workspace coding run 验证 373ef99 × 0.71 proof 链合成行为（terminal proof 可见）。
- [ ] **步骤 6：漂移修复**——每个失败先分类再修；生产缺陷走 TDD+bug 记录；测试漂移只改期望。
- [ ] **步骤 7：报告落盘** `var/upgrade/merge-gate-report.md`：双门禁新基线、漂移清单与分类、探针证据。

### Task 7：resumed-child 系统性挂起专项诊断与修复（HANDOFF #11a）

**Deps：** `T6`（理由：在稳定合并基线上诊断；且必须先重新核对证据——merge 可能改变调用链）

**WritePaths：**
- 诊断报告：`var/upgrade/resumed-child-hang-diagnosis.md`
- 修复（诊断后定）：`packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts` 及对应测试
- `docs/bugs/<日期>-resumed-child-integration-hang.md`
- `scripts/run-integration-gate.ts`（解除排除项，reviewer 阻塞项 5）
- `var/upgrade/resumed-child-hang-fix.md`

**Resources：** 单文件运行需 timeout 包裹（挂起用例各 ~180s）。

**Files：** Create：bug 记录、两份报告；Modify：待诊断定案 + 门禁排除表删条目。

**接口契约：**
- Consumes：`var/upgrade/fix-resumed-child-fixture.md` §4 证据链（**merge 前观测**：182s 挂起、queue 恒空、2 active workspace、9 次模型请求、proof debts 恒 unresolved；四用例同族）。
- Produces：merge 后重新核实的根因定案 + TDD 修复 + 门禁排除移除后的集成门禁绿。

**验收标准：**
- [ ] **步骤 0：证据重核（reviewer 建议 4）**——在 merge 后基线上重跑该测试文件，确认挂起签名（~180s、queue 恒空、proof debts 不解）仍然成立；若已消失/变形，更新诊断前提并按新形态继续（不得直接套用 merge 前嫌疑面）。
- [ ] **步骤 1：诊断**——定位首个偏离点（重点：auto-integration admission 为何从未发生、proof debt 为何不解、generic owner receipt 持久化块与集成队列的关系）；production 可达性按分类门禁论证。
- [ ] **步骤 2：bug 记录（中文：现象/证据/根因/RED）。**
- [ ] **步骤 3：TDD 修复**——RED → 最小实现 → GREEN。
- [ ] **步骤 4：文件级验证**——`TMPDIR=/tmp timeout 1200 node --test test/subagent-auto-integration-resumed-child.integration.mjs` 4/4 绿。
- [ ] **步骤 5：解除门禁排除**——删除 `scripts/run-integration-gate.ts` 排除表条目；`npm run test:all-integration` 全绿（主会话跑）。
- [ ] **步骤 6：报告 + bug 记录闭环。**

### Task 8：session-owner PTY 守卫拦截专项诊断与修复（HANDOFF #11b）

**Deps：** `T6`（理由：同 T7，含证据重核）

**WritePaths：**
- 诊断报告：`var/upgrade/session-owner-pty-guard-diagnosis.md`
- 修复：`test/session-owner-runtime.integration.mjs` 或相关生产文件（诊断定案后定）
- `docs/bugs/<日期>-session-owner-pty-guard-interception.md`
- `scripts/run-integration-gate.ts`（解除排除项）

**Resources：** PTY 套件串行；单文件两遍验证。

**Files：** Create：bug 记录、诊断报告；Modify：待定案（merge 前机制：fixture pi 被「会话正由另一个 Pi 窗口使用」守卫拦截后干净退出、registry 空）+ 门禁排除表删条目。

**接口契约：**
- Consumes：`var/upgrade/fix-three-orphaned-tests.md` 文件 6 节证据（**merge 前观测**）。
- Produces：merge 后重核的定案 + 修复 + 门禁排除移除。

**验收标准：**
- [ ] **步骤 0：证据重核**——merge 后重跑，确认三 PTY 用例失败签名（exitCode 0、live records []、守卫提示）仍成立；变形则更新前提。
- [ ] **步骤 1：诊断**——守卫为何对 fixture pi 生效（跨会话目录串扰？registry 残留？PTY 启动形态与 `-c` 的 session 定位交互？）；按分类门禁定案（注意 merge 并入了 7f58a12 审计日志——它可能直接提供新的诊断信号）。
- [ ] **步骤 2：bug 记录 + TDD 修复**（生产缺陷走 RED-GREEN；fixture 问题只修测试并声明豁免理由）。
- [ ] **步骤 3：文件级验证**——`TMPDIR=/tmp timeout 900 node --test test/session-owner-runtime.integration.mjs` 连跑两遍全绿。
- [ ] **步骤 4：解除门禁排除 + 全集成门禁绿（主会话跑）+ 报告闭环。**

### Task 9：terminal-proof 语义裁决实施（HANDOFF #12，用户门控）

**Deps：** `T6`；**执行前置：用户在 (a)/(b) 中拍板**（默认建议 (a)）。**允许 suspended**：用户未裁决时任务挂起，不阻塞 T10（T10 按 suspended 状态收尾——reviewer 建议 5）。

**WritePaths：**
- 方案 (a)：`packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts`、`packages/pi-subagents-enhanced/src/workspace/ledger.ts` 或 `service.ts`（跨 scope 复查接线）、对应测试
- 方案 (b)：`test/managed-workspace-terminal-proof-handoff.integration.mjs`
- `scripts/run-integration-gate.ts`（解除排除项）
- `var/upgrade/terminal-proof-adjudication.md`

**Resources：** none

**Files：** 见 WritePaths（按裁决选项二选一）。

**接口契约：**
- Consumes：分析结论（`var/upgrade/orphaned-integration-triage.md` §4：跨 owner scope unresolved binding 被 `classifyTerminalProofBinding` 的 `owned.length===0` 分支判 not-applicable 吞没；基线即如此）。
- Produces：裁决落地实现 + 门禁排除移除；或 suspended 登记。

**验收标准：**
- [ ] **步骤 1：向用户确认裁决**——(a) 生产修复（跨 scope 复查命中异 owner workspace 则 `recordDebt`）；(b) not-applicable 为有意语义（改测试期望）。未回应 → 标记 suspended，跳过后续步骤。
- [ ] **步骤 2（选 a 时）：bug 记录 + TDD**——RED（跨 scope binding 场景期望 debt 可观测）→ `classifyTerminalProofBinding` 在 owned 为空时按 runId 跨 scope 复查 → GREEN。
- [ ] **步骤 3（选 b 时）：改测试期望 + 豁免声明。**
- [ ] **步骤 4：文件级验证绿 → 解除门禁排除 → 全集成门禁绿（主会话跑）→ 报告。**

### Task 10：HANDOFF 终版与收尾

**Deps：** `T7`、`T8`、`T9`（T9 允许 suspended——reviewer 建议 5）

**WritePaths：**
- `HANDOFF.md`
- `var/upgrade/main-merge-closure.md`

**Resources：** none

**Files：** Modify：HANDOFF.md；Create：closure 报告。

**接口契约：**
- Consumes：T1–T9 全部报告。
- Produces：新 HANDOFF（merge 后状态、双门禁新基线、三缺陷闭环状态——T9 suspended 时如实登记「未裁决，集成门禁排除项保留」），供用户决策后续切换阶段。

**验收标准：**
- [ ] **步骤 1：HANDOFF 重写**——升级状态一句话（merge 完成、双门禁新基线、缺陷闭环状态含 T9 实态）；「后续切换阶段」前置条件更新（旧仓 3 个未提交文件**只登记同步要求，不声称已同步**——reviewer 建议 6）；决策项清单刷新（已决划线、保留项、S9 悬置如实标注）。
- [ ] **步骤 2：closure 报告**——全程变更总账（提交数、76 冲突处置统计、门禁数字、token 量级）；T9 suspended 时明确「三项缺陷：两项闭环一项悬置」。
- [ ] **步骤 3：`git status` 干净（除 `?? pi/settings.json`）+ `git log --oneline -5` 终态快照进报告。**

---

## 计划外登记（不属本计划任务）

- 旧仓 3 个未提交文件（`pi-new()`、pi-shell.test 改名、context-handoff）：**后续切换阶段**（原 HANDOFF T12 第三段）同步处置；本计划 T10 只登记要求。
- 上游回馈两项、五项上游依赖决策项、产品语义观察项 #10、footer 低优先项：维持 HANDOFF 休眠登记。
