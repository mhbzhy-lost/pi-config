# `origin/main` 合并冲突独立只读审计

**日期：** 2026-08-17
**审计对象：** 当前 `HEAD`、已 fetch 的 `origin/main`、当前未提交工作树
**结论：** **现在不能把“checkpoint + merge”作为一个连续动作安全执行。** 可以先在专用分支保存经脱敏和范围核验的 checkpoint，但在模型路由、AGENTS/测试政策、远端真删除测试的去留三项决策完成前，不应开始 merge。
**边界：** 未显示或修改 remote URL；未读取 auth、`.env`、凭据、cookie、token；未运行 Goal Engine 或其测试；未创建/切换分支、tag、stash、commit，未 stage、merge、rebase、pull、checkout、reset、restore；未调用 raw worktree 生命周期命令；未派发子代理。唯一写入是本报告。

## 1. 版本与工作区快照

| 项目 | 证据 |
|---|---|
| 当前 `HEAD` | `01d1c7ab4bae0ced48630462f68bfe3ab3a843af` |
| `origin/main` | `b5c0ce7d88a1dbefbb542ae5c15798c234b1111f` |
| merge-base | `4d0634cef3789a0043476f19ea3d22c5f4e9a1a9` |
| ahead / behind | `git rev-list --left-right --count HEAD...origin/main` → `100 / 9` |
| 工作树（写报告前） | 56 个 tracked 变更；`git status --untracked-files=normal` 为 36 个 untracked 条目，展开后为 50 个文件；0 staged |
| tracked 规模 | `56 files changed, 985 insertions(+), 985 deletions(-)` |
| 本地 committed 规模 | merge-base 到 `HEAD`：`96 files changed, 6267 insertions(+), 151 deletions(-)` |
| 远端净变化规模 | merge-base 到 `origin/main`：71 files，1928 insertions、624 deletions |

> 36 是 Git 默认折叠目录后的 untracked 条目数，50 是 `git ls-files --others --exclude-standard` 展开的实际文件数；两者不矛盾。本报告写入后实际文件数会增加 1，但审计输入快照仍以上表为准。

## 2. 远端 9 个提交的业务主题

| 提交 | 业务主题 | 关键证据 |
|---|---|---|
| `66f2fab` | subagent workflow root 在 leaf 启动前失败时快速返回，不再耗尽总 timeout | `workflow-spawn.ts`、`extension.ts`、`test/subagent-workflow-spawn.test.mjs` |
| `fc94d95` | Goal Engine 增加默认关闭的 settings gate；关闭时不导入核心模块、不注册工具 | `pi/extensions/goal-engine.ts`；新增 gate 测试，后被归入 `.integration.mjs` |
| `ac63cc1` | 删除 spark、收敛 agent 配置；把 Goal/worktree 测试从默认 `.test.mjs` 分到显式 `.integration.mjs`；删除若干配置/文档镜像测试 | `pi/agents/spark.md` 删除；`package.json` 新增两个测试脚本；50 路径统计 |
| `b9d0751` | 修复并行 managed worktree 的 integrate、preserve 后 release、续作 run 重绑和阻断原因可见性 | workspace controller/ledger、dispatch extension、Skill、集成测试 |
| `783e998` | 仅记录 apply-patch 紧凑渲染问题 | 新增 bug 文档 |
| `13223f3` | 收敛 AGENTS、增加 settings 提交规则和凭据泄露处置规则 | 根 `AGENTS.md`、`pi/AGENTS.md` |
| `6f865c0` | 调整模型目录；单 executor 改用 `codex-pool`，移除共享 `enabledModels` 选择 | `pi/models.json`、`pi/settings.json`、executor profile |
| `beb552d` | subagent 结构参数兼容字符串化 JSON，并返回精确 keypath 错误 | dispatch `extension.ts`/`ir.ts`，3 个新单元测试 |
| `b5c0ce7` | 合并同步提交，把此前主分支的 Goal/worktree 修复汇入远端线 | 双亲为 `beb552d` 与 merge-base `4d0634c`；本身是 merge commit |

## 3. 三层变更面

### 3.1 本地 committed：100 个提交

本地 committed 变化不是零散配置，而是一条连续的 Goal obligation runtime 改造线：从 `d093794` 计划、`13293c4` 固定非 Goal 执行方式，到 `01d1c7a` 修复授权账本评审阻断。主要变化面：

1. **Goal runtime 与安全边界：** obligation、condition evidence、current-world、managed validation、observation/recovery、repair、final review/finalization、approval capability；占 `scripts/lib/goal-engine/` 与 Goal tests 的主体。
2. **Root broker / managed worktree：** Goal-owned run 安全 stop、owner token 标准输入、workspace disposition 能力；见 `root-broker-server.ts:217`、`root-broker-registry.ts:105`。
3. **八工具 ABI：** 新增并冻结 `goal_finalize`；`scripts/doctor.mjs:33-43` 与 `using-goal-engine/SKILL.md:23,45` 都按 exact-eight。
4. **计划与缺陷文档：** 新增 obligation runtime design/plan 和约 20 个安全/恢复 bug 文档。
5. **测试：** `HEAD` 仍有 32 个 `test/goal-engine-*.test.mjs`，其中 17 个是 merge-base 后本地新增；这与远端把 Goal 测试隔离到 `.integration.mjs` 的结构尚未对齐。

### 3.2 当前未提交层

| 主题 | 主要路径与意图 |
|---|---|
| Pi 0.84.2 / fullscreen | `pi/settings.json`、footer/viewport/runtime、`init-pi.sh`、fullscreen/runtime tests；增加 fullscreen 与 resume hint |
| 核心 Skill 本地化 | 删除 `.gitmodules`、`vendor/superpowers`、`skill-overrides/skills.list`；新增 TDD / writing-plans / writing-skills；自动发现与 sync/Doctor 改造 |
| AGENTS/Skill 一致性 | `pi/AGENTS.md` 收窄到全局规则；TDD、Playwright、writing、subagent、Goal 细节迁往 Skills；新增定向政策测试 |
| provider/config | `pi/models.json` 增加内建 provider override；`pi/settings.json` 删除缺失 adapter；manage-providers 安全修订 |
| subagent 展示 | dispatch extension 注入 `renderCall`，紧凑 call/result 与对应 tests |
| external review | 配置根、Pi auth bridge、文档与 Python tests |
| 文档 | 多个 bug、plan、review、summary；现有跟进复审仍记录 manage-providers 与 Doctor test 的未关闭问题 |

现有跟进报告 `docs/reviews/2026-08-17-agents-skills-consistency-followup.md` 证明当前未提交层仍有发布阻断：三个核心 Skill 尚未跟踪；manage-providers 仍回显敏感 header 名且 `remove-model` 无确认；Doctor test 尚有漂移。它们适合 checkpoint 保存，但不应未经决策直接并入最终主线。

### 3.3 远端与 dirty 的 15 路径交集

这些路径会让**现在直接 merge** 因“本地修改将被覆盖”而停止；这只是 dirty 层阻断，不等于 15 个 committed merge 冲突：

```text
pi/AGENTS.md
pi/models.json
pi/settings.json
scripts/doctor.mjs
scripts/lib/subagent-dispatch/extension.ts
skill-overrides/subagent-dispatch/SKILL.md
test/doctor.test.mjs
test/global-rules.test.mjs
test/migration-contract.test.mjs
test/models-config.test.mjs
test/pi-subagents-compat.test.mjs
test/plan-runner-removal.test.mjs
test/subagent-dispatch-skill.test.mjs
test/subagent-runtime-membrane.test.mjs
test/using-goal-engine-skill.test.mjs
```

## 4. Clean committed merge：真实冲突，而非路径重叠

### 4.1 `merge-tree` 结果

已按要求运行：

```text
git merge-tree 4d0634cef3789a0043476f19ea3d22c5f4e9a1a9 HEAD origin/main
```

结果中只有 3 个文本冲突标记：

1. `AGENTS.md`
2. `pi/extensions/goal-engine.ts`
3. `scripts/lib/subagent-dispatch/extension.ts`

另外有 8 个“本地修改、远端删除”的 legacy merge-tree 条目。结合 `git diff --find-renames --name-status` 和 blob 身份后，其中 6 个其实是 **R100 重命名后承接本地修改**，不是机械删除冲突；只有 2 个是真删除/修改冲突。因此，rename-aware 的 clean committed merge 预计有 **5 个真实冲突路径**，不是 11 个，更不是 15 个。

### 4.2 5 个真实 committed 冲突

| 严重度 | 路径 | 本地意图 | 远端意图 | 推荐语义结果 |
|---|---|---|---|---|
| 需人工语义合并 | `AGENTS.md` | 冻结当前 Goal 改造的执行方式，R13 前只走 Subagent-Driven（`HEAD:AGENTS.md:5`） | 禁止提交 per-machine `enabledModels`，其他 settings 字段正常提交（`origin/main:AGENTS.md:5-9`） | 两段都保留，分为两个独立章节；不能选 ours 丢失 settings 规则，也不能选 theirs 解除 Goal 改造冻结 |
| 需人工语义合并 | `pi/extensions/goal-engine.ts` | 核心 factory 是 exact-eight，含 `goal_finalize` | settings 缺失/非法时 fail-closed；disabled 时动态导入也不发生 | 以远端 lazy gate 入口为骨架，启用后加载本地 exact-eight factory；`goalEngine.enabled` 默认保持 false；不得退回 eager import 或 seven-tool core |
| 需人工语义合并 | `scripts/lib/subagent-dispatch/extension.ts` | workspace status/disposition 的模型可见文本使用完整 JSON | 新增 preserved workspace 的 `release`、blocked reasons、续作重绑、timeout 上限、schema/keypath | 保留远端所有 lifecycle/schema/fail-fast 行为，同时让 status 和 disposition 都返回完整 public JSON；之后叠加 dirty `renderCall`，不能选任一整侧 |
| 需人工语义合并 | `test/migration-contract.test.mjs` | 本地 committed 增加 managed subagent workspace ignore 约束；dirty 又改成 Skill 自动发现/移除 Superpowers | 远端真删除该镜像/存在性测试文件 | 不保留旧路径；把仍有行为价值的 discovery 检查迁到 `test/skill-list.test.mjs` 或 Doctor 的临时 fixture 行为测试，删除配置字面值/文件存在镜像断言 |
| 需人工语义合并 | `test/using-goal-engine-skill.test.mjs` | 本地 committed 固化 exact-eight 文档；dirty 增加 Skill 依赖与真实 subagent ABI | 远端真删除 Skill 文档字面值测试 | 不复活旧文件；依赖 ABI 迁到 `test/skill-dependency-abi.test.mjs`，exact-eight 由 runtime/tool-definition 测试负责；是否保留任何 Skill 文本 lint 取决于 §9 的测试政策决策 |

### 4.3 远端重命名/分组迁移，不是真删除

远端 `ac63cc1` 的业务意图是让默认 `npm test` 不运行 Goal/worktree 集成面，并新增：

```json
"test:goal-engine": "node --test \"test/goal-engine-*.integration.mjs\" \"test/worktree-lifecycle-*.integration.mjs\""
```

净 diff 明确识别：

- 15 个既有 `goal-engine-*.test.mjs` → 同名 `.integration.mjs`（多数 R100；workspace 为 R099）。
- `subagent-dispatch-workspace`、`subagent-workspace-controller`、`subagent-workspace-ledger` → `.integration.mjs`。
- 4 个 `worktree-lifecycle-*` → `.integration.mjs`。
- `goal-engine-settings-gate.integration.mjs` 是远端新测试，不是本地文件被删除。

下列 6 个 legacy merge-tree “removed in remote” 在远端都是 R100 rename，且远端目标 blob 等于 merge-base；本地修改应迁到新目标，内容三方没有竞争：

```text
test/goal-engine-dispatch.test.mjs
  -> test/goal-engine-dispatch.integration.mjs
test/goal-engine-executor-binding.test.mjs
  -> test/goal-engine-executor-binding.integration.mjs
test/goal-engine-extension.test.mjs
  -> test/goal-engine-extension.integration.mjs
test/goal-engine-graph.test.mjs
  -> test/goal-engine-graph.integration.mjs
test/goal-engine-human-decision.test.mjs
  -> test/goal-engine-human-decision.integration.mjs
test/worktree-lifecycle-managed.test.mjs
  -> test/worktree-lifecycle-managed.integration.mjs
```

**不能保留旧路径和新路径两份。** 否则 default `npm test` 会继续运行旧 Goal tests，破坏远端隔离。`HEAD` 的 17 个本地新增 `goal-engine-*.test.mjs` 也应随同迁为 `.integration.mjs`；两个 `test/fixtures/goal-observation/*.test.mjs` 是被测试进程使用的 fixture，需改名或移出默认 glob，不能误当普通 test 自动执行。

### 4.4 真删除

下列才是远端真实删除：

- `pi/agents/spark.md`
- `test/global-rules.test.mjs`
- `test/migration-contract.test.mjs`
- `test/models-config.test.mjs`
- `test/package-scripts.test.mjs`
- `test/plan-runner-removal.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`
- `test/using-goal-engine-skill.test.mjs`

其中 `spark` 删除与单 executor 路由绑定；7 个 tests 多为读配置/Skill/文件存在性的镜像测试，和 `origin/main:pi/AGENTS.md:10` 的禁止规则一致。当前 dirty 又修改了其中 6 个，恢复时将形成 modify/delete；应迁移行为覆盖或接受删除，不能因“本地有修改”就复活旧测试。

## 5. Clean committed 自动合并但需语义复核的热点

| 严重度 | 路径 | 双方意图与风险 | 推荐结果 | 非 Goal 验证 |
|---|---|---|---|---|
| 需人工语义复核 | `scripts/doctor.mjs` | 本地 exact-eight；远端单 executor/`codex-pool`；文本可自动合并，但 dirty 又引入 0.84.2 与 Skill 自动发现 | exact-eight、0.84.2、自动发现都保留；profile 数量和 executor model 必须服从模型路由决策 | `node --check scripts/doctor.mjs`；把非 Goal Doctor fixture 拆到独立 test 后运行；当前 `test/doctor.test.mjs` 会加载 Goal 面，不应作为本轮非 Goal 验证 |
| 需人工语义复核 | `scripts/lib/subagent-dispatch/root-broker-server.ts` / registry | 本地增加 Goal-owned stop 的身份/终止证明；远端只接受 executor，不再接受 spark | 两者都保留；`startedFacts()` 只收 executor，同时保留 `stopGoalOwnedRun()` 及 registry facade | `node --test test/root-subagent-broker.test.mjs test/root-subagent-broker-protocol.test.mjs` |
| 需人工语义复核 | `test/doctor.test.mjs` | committed 两侧可自动拼接 exact-eight 与单 executor；dirty 大改 Skill fixtures，并和远端 profile fixture 同区 | 先决定模型路由；再让 fixture 动态发现 Skill，且只构造最终单 executor profile | 不运行整文件；先拆分非 Goal tests，再只跑拆出的配置/Skill discovery tests |
| 自动可解，需回归 | `package.json` | 远端只新增显式 Goal/worktree test scripts | 保留；在所有本地 Goal tests 迁名后再使用 | 用 JSON 解析检查 scripts；本阶段不执行 `test:goal-engine` |
| 自动可解，需回归 | `scripts/lib/subagent-dispatch/root-broker-server.ts` 的远端 executor-only hunk与本地 stop hunk | hunk 分离，`merge-tree` 无 marker | 合并后做身份/终止证明回归 | 同上 broker tests |

## 6. Dirty / untracked 叠加层

### 6.1 现在会阻止 merge 的远端变化

§3.3 的 15 路径全部会让当前 dirty worktree 的 merge 预检停止。其余 41 个 tracked dirty 路径与远端净变化没有路径交集，通常会原样留在工作树，但这不构成直接 merge 的安全理由。

### 6.2 先完成 clean committed merge，再恢复当前层时

**确定的文本或 modify/delete 冲突（10 路径）：**

1. `pi/AGENTS.md`：远端保留大段 TDD/Playwright/writing 规则，dirty 把它们迁到 Skills 并新增 Worktree/Bugfix/自主模式。
2. `scripts/doctor.mjs`：远端单 executor/`codex-pool` 与 dirty 仍保留 openai executor + spark，在同一 profile 常量区。
3. `skill-overrides/subagent-dispatch/SKILL.md`：远端删除 spark、增加 release/blocked reasons；dirty 在同一 lifecycle 行改成真实 `subagent({action:...})` ABI。
4. `test/doctor.test.mjs`：远端单 executor fixture与 dirty 动态 Skill fixture修改相交。
5. `test/global-rules.test.mjs`：远端删除，dirty 修改。
6. `test/migration-contract.test.mjs`：远端删除，HEAD 和 dirty 都修改。
7. `test/models-config.test.mjs`：远端删除，dirty 新增 provider override 字面值断言。
8. `test/plan-runner-removal.test.mjs`：远端删除，dirty 改 Skill discovery 断言。
9. `test/subagent-dispatch-skill.test.mjs`：远端删除，dirty 改自动发现/ABI 文本断言。
10. `test/using-goal-engine-skill.test.mjs`：远端删除，HEAD 和 dirty 都修改。

**预计文本可自动叠加，但必须做语义复核：**

- `pi/settings.json`：远端改默认 provider、移除 executor override/`enabledModels`、加入 `goalEngine.enabled=false`；dirty 增加 0.84.2/fullscreen 并删除缺失 adapter。hunk 大体可组合，但最终模型路由是产品决策。
- `pi/models.json`：远端重组 provider 目录，dirty 只在尾部增加内建 provider context override；结构上可组合，不能把远端删除的 provider 机械保留。
- `scripts/lib/subagent-dispatch/extension.ts`：dirty 的 `renderCall` 注入与 committed 冲突 hunk分离；应在先解决 release/JSON 后再恢复 renderer。
- `test/pi-subagents-compat.test.mjs`：远端删除 spark coverage，dirty增加 0.84.2；可同时保留。
- `test/subagent-runtime-membrane.test.mjs`：远端增加 release/continuation tests，dirty增加 renderer tests；测试块分离，但都依赖最终 extension API。

#### 15 路径处置矩阵

| 路径 / 严重度 | 当前本地意图 | 远端意图 | 不能整侧选择 / 推荐结果 |
|---|---|---|---|
| `pi/AGENTS.md` / 阻断 | 规则瘦身、Skill 持有流程、保留 worktree/bug/autonomous | 测试行为禁令、泄露处置，同时仍保留旧流程正文 | ours 丢远端治理，theirs 重建双事实源；按 §7.2 语义重写 |
| `pi/models.json` / 人工 | 增加内建 provider context override | 重组 provider catalog | ours 回滚 catalog，theirs 丢 override；远端基线加经验证 override |
| `pi/settings.json` / 阻断 | 0.84.2/fullscreen、删 adapter、保留当前执行路由 | Goal 默认关闭、单 executor、删共享选择 | 任一侧都会丢失可启动性或安全 gate；按最终模型决策组合 |
| `scripts/doctor.mjs` / 阻断 | exact-eight、0.84.2、Skill 自动发现 | 单 executor/`codex-pool` | ours 要求已删除 spark，theirs 退回旧 ABI/发现；四项按最终路由组合 |
| dispatch `extension.ts` / 人工 | JSON public output、dirty renderCall | release/blocked reasons/continuation/coercion/fail-fast | ours 丢生命周期，theirs 丢模型可见 JSON/renderer；以远端行为为骨架叠加本地接口 |
| `subagent-dispatch/SKILL.md` / 人工 | 真实 `subagent({action:...})` ABI | executor-only、release、blocked reasons、writePaths 目录语义 | ours 教旧 spark，theirs 教不完整调用外形；合并两种意图 |
| `test/doctor.test.mjs` / 人工 | 自动 discovery fixture、0.84.2、exact-eight | 单 executor fixture | ours 保留 spark，theirs 丢 discovery；按最终 Doctor 契约重建 fixture |
| `test/global-rules.test.mjs` / modify/delete | 把 TDD/安全规则字面值断言迁到本地 Skill | 删除镜像文本 test | ours 违反远端测试政策，theirs 丢当前意图；不复活，改为行为 fixture 或删除 |
| `test/migration-contract.test.mjs` / modify/delete | workspace ignore、Skill discovery、Superpowers 移除 | 删除迁移/存在性镜像 test | 不保留旧聚合文件；discovery 行为迁到 `skill-list`，其余接受删除 |
| `test/models-config.test.mjs` / modify/delete | 断言 provider override 和旧 provider 字段 | 删除 models 字面值 test | 不复活；用 JSON parse/provider loader 行为覆盖最终配置 |
| `test/pi-subagents-compat.test.mjs` / 自动 | 增加 Pi 0.84.2 支持矩阵 | 删除 spark，仅验证 executor | 任一整侧少一项；自动组合后跑 compat test |
| `test/plan-runner-removal.test.mjs` / modify/delete | 用自动 Skill discovery继续断言退休产品不存在 | 删除文件存在性 test | 不复活；如仍需保护，改为 Doctor 对输入 fixture 的行为测试 |
| `test/subagent-dispatch-skill.test.mjs` / modify/delete | 自动发现、真实 ABI 与 Skill正文 lint | 删除 Skill字面值 test | 不复活；ABI迁到 parser/dependency test，全文 lint删除 |
| `test/subagent-runtime-membrane.test.mjs` / 自动 | call/result renderer | release、continuation、executor-only | 两组行为互补；自动组合后跑 membrane test |
| `test/using-goal-engine-skill.test.mjs` / modify/delete | exact-eight、dispatch依赖、用户提问语义 | 删除 Goal Skill全文 test | 不复活；依赖 ABI迁到非 Goal test，exact-eight由显式 Goal suite在以后验证 |

### 6.3 untracked 覆盖风险

对远端所有 `A` 和 rename target，与 50 个实际 untracked 文件同时做了 exact 与父子路径检查：**0 个碰撞**。因此当前没有“untracked 文件会被远端新增文件覆盖”的证据。

仍需注意：无碰撞只说明 Git 路径安全，不说明内容可直接提交。三个核心 Skill 和多个新 policy tests 是当前机器依赖，必须在 checkpoint 中完整纳入 Git；本报告路径位于已存在的 untracked `docs/reviews/` 目录，也不与远端新增路径相撞。

## 7. 逐热点语义合并建议

### 7.1 根 `AGENTS.md` — 需人工语义合并

- **本地意图：** 100-commit Goal 改造在 R13 前不得由旧 Goal Engine 自我编排。
- **远端意图：** `enabledModels` 是 per-machine 工作树差异，不能进入提交；其他 settings 字段可提交。
- **不能选 ours/theirs：** 两条规则互不替代，任一整侧都会丢失一条安全边界。
- **推荐结果/验证：** 保留两个章节；人工通读与 `git diff --check`，不需要运行 Goal tests。

### 7.2 `pi/AGENTS.md` 与 policy tests — 阻断决策

- **本地意图：** 全局只留路由/安全规则，详细 TDD、Playwright、writing 规则进入 Skills；保留 managed worktree、bug 文档和自主模式。
- **远端意图：** 仍在 AGENTS 保留较多流程，并明确禁止读取配置/Skill 字面值和文件存在性的镜像测试。
- **不能选 ours/theirs：** ours 会丢失远端测试治理与泄露处置；theirs 会重新制造 AGENTS/Skill 双事实源，并丢失本地 worktree/bug/autonomous 约束。
- **推荐结果/验证：** 采用本地“AGENTS 只路由、Skill 持有流程”结构，加入远端泄露处置和行为测试禁令；把当前字面值 tests 改成 parser/validator/fixture 的输入输出测试后运行非 Goal Skill/discovery tests。

### 7.3 `pi/settings.json` — 阻断决策

- **本地意图：** Pi 0.84.2 fullscreen；删除不存在的 adapter；保留 per-machine enabledModels 和 DeepSeek executor override。
- **远端意图：** 单 executor，profile 默认 `codex-pool/gpt-5.6-terra` 并有 fallback；删除共享 `enabledModels` 和 executor override；Goal 默认关闭。
- **不能选 ours/theirs：** ours 会丢失 fail-closed Goal gate和远端单 executor路线；theirs 会恢复本机不存在的 adapter并丢失 0.84.2/fullscreen。
- **推荐结果/验证：** committed 结果保留 0.84.2/fullscreen、移除 adapter、`goalEngine.enabled=false`、不提交 `enabledModels`；executor provider/override须先决策。用 JSON parse、默认 model 可解析性和非 Goal Pi 启动 smoke 验证。

### 7.4 `pi/models.json` — 需人工语义合并

- **本地意图：** 给内建 `openai-codex/gpt-5.6-sol` 增加 1.05M context override。
- **远端意图：** 重组 Idealab model 目录、删除旧共享选择，并由 settings 使用 `codex-pool`。
- **不能选 ours/theirs：** ours 会回滚远端目录重组；theirs 会丢失本地 context 修正。
- **推荐结果/验证：** 以远端 provider 目录为基线，只追加经运行时验证的 `openai-codex` override；JSON parse，并用 provider loader 的非 Goal测试验证，不保留被远端删除项。

### 7.5 `scripts/doctor.mjs` — 需人工语义合并

- **本地意图：** exact-eight Goal ABI、Pi 0.84.2、Skill 自动发现。
- **远端意图：** 只要求 executor，模型为 `codex-pool`，不再要求 spark。
- **不能选 ours/theirs：** ours 与远端已删除的 spark 不一致；theirs 退回 seven-tool/旧 Pi/固定 Skill list。
- **推荐结果/验证：** exact-eight + 0.84.2 + 自动发现 + 最终模型决策下的单 executor；先 `node --check`，再把非 Goal Doctor tests拆开运行，避免本阶段载入 Goal test 面。

### 7.6 subagent dispatch extension / Root broker — 需人工语义合并

- **本地意图：** workspace public JSON 对模型可见、Goal-owned stop 保持身份和终止证明；dirty 增加紧凑 renderCall。
- **远端意图：** executor-only、release preserved workspace、阻断原因、origin 前进容忍、续作重绑、fail-fast timeout、schema coercion/keypath。
- **不能选 ours/theirs：** 任一整侧都会丢失安全 stop 或新的 worktree 生命周期；extension 的唯一 marker 正好位于 disposition 分派。
- **推荐结果/验证：** 远端行为全部保留，status/disposition 均输出完整 public JSON，再注入 renderCall；运行 dispatch IR/coercion/workflow/membrane/broker 非 Goal tests。

### 7.7 `subagent-dispatch` / `using-goal-engine` Skills — 需人工语义合并

- **本地意图：** 使用真实 `subagent({action:...})` ABI；Goal Skill 显式依赖 dispatch；exact-eight/frozen finalize。
- **远端意图：** executor-only、release/blocked reasons、目录 writePaths 语义、Goal测试隔离。
- **不能选 ours/theirs：** ours 仍教 spark且缺 release；theirs 丢失真实调用外形和 exact-eight依赖说明。
- **推荐结果/验证：** subagent Skill采用 executor-only + 远端 lifecycle + 本地真实调用；Goal Skill保留本地 exact-eight/依赖。验证应测试 parser/ABI行为，不再逐句镜像全文。

### 7.8 测试重命名与删除 — 需人工语义合并

- **本地意图：** 100 commits 新增/修改 Goal runtime tests，dirty 新增 Skill/安全/配置回归。
- **远端意图：** 所有 Goal/worktree重测试显式分组，删除配置/文档字面值镜像 tests。
- **不能选 ours/theirs：** ours 使默认 suite 再次运行 Goal；theirs 会丢失大量 obligation runtime 回归。
- **推荐结果/验证：** 本地 Goal tests全部迁到 `.integration.mjs`，本阶段不运行；真删除 tests不复活，行为价值迁入非 Goal parser/fixture tests。

## 8. 严重度与预计写入热点

### 8.1 严重度

| 级别 | 项目 |
|---|---|
| **阻断** | 当前 15 个 dirty overlap 使直接 merge 不可开始；模型路由、AGENTS/测试政策、真删除 tests 去留尚未决策 |
| **需人工语义合并** | 5 个真实 clean committed conflicts；settings/models/Doctor/profile；subagent lifecycle/Skill；所有本地 Goal test 分组迁移 |
| **自动可解** | 远端新增 bug/plan 文档；package test scripts；无本地修改的 R100 renames；pi-subagents compat 的 0.84.2 + executor-only；runtime membrane 分离测试块；0 个 untracked target collision |

### 8.2 预计写入热点

1. **规则/Skill：** `AGENTS.md`、`pi/AGENTS.md`、`skill-overrides/{subagent-dispatch,using-goal-engine,test-driven-development,writing-*}` 及 policy tests。
2. **模型/Doctor：** `pi/settings.json`、`pi/models.json`、`pi/agents/{executor,spark}.md`、`scripts/doctor.mjs`、Doctor/compat tests。
3. **subagent runtime：** dispatch extension、workflow spawn、workspace controller/ledger、Root broker、runtime membrane tests。
4. **Goal入口/测试结构：** `pi/extensions/goal-engine.ts`、`package.json`、32 个 Goal test rename targets、2 个 fixture 路径。
5. **Skill extraction：** `.gitmodules`/vendor 删除、三个新核心 Skill、auto-discovery/sync tests。

### 8.3 建议的 conflict-resolution commits

合并提交本身必须一次结束 index 冲突；语义修正应拆成后续窄提交：

1. **Merge commit：** 只解决 5 个 clean committed conflicts，并确认 6 个本地修改随 R100 rename 落到 `.integration.mjs`。
2. **Goal gate/test layout：** exact-eight lazy gate；把其余 17 个本地新增 Goal tests和 observation fixtures迁入显式 Goal suite。
3. **Agent/model/Doctor：** executor/profile/settings/models/Doctor 一次对齐，避免多提交间出现不可启动组合。
4. **Subagent lifecycle/presentation：** release、blocked reasons、continuation、keypath、JSON public output、renderCall、Root broker stop。
5. **AGENTS/Skills/test policy：** 去双事实源、真实 ABI、行为测试替代字面值 tests。
6. **Skill extraction/config hardening：** Superpowers移除、三个核心 Skill纳管、adapter/provider/manage-providers安全闭环；不要把仍失败的安全修订伪装成已完成。

## 9. 推荐安全更新序列（不执行）

1. **先完成三项产品决策，做脱敏/范围核验。** 明确 §10 的模型、规则、真删除 tests；确认 checkpoint 不含真实凭据，且 `enabledModels` 的 per-machine差异不进入最终提交。
2. **在当前 dirty 状态创建专用 checkpoint 分支，而不是在 `main` 直接提交。** 分支只用于保存当前层；按 fullscreen、Skill extraction、subagent rendering、provider/security、docs 分成可审阅 commits。不要 stash。
3. **checkpoint 全部落盘并使该分支 clean 后，再创建只指向 checkpoint tip 的保护分支。** 在未 commit 前创建保护分支只能保护旧 `HEAD`，保护不了 56+36 的工作树。
4. **从原始 `main`/`01d1c7a` 创建独立 integration 分支。** 在 clean worktree 上 merge `origin/main`；**使用 merge，不用 rebase**。100 个本地连续 Goal commits 若 rebase 会逐提交放大测试 rename 与入口冲突，并破坏现有审计锚点。
5. **先解决 clean committed 层。** 顺序：测试 rename识别 → Root `AGENTS` → Goal lazy gate/exact-eight → dispatch release/JSON → 两个真删除 test 决策；完成 merge commit。
6. **此时才恢复当前未提交层。** 按 checkpoint commits逐个 cherry-pick/移植到 integration 分支，先模型/Doctor，再 Skill/AGENTS，再 subagent renderer，最后 provider/security/docs；不要在 clean committed merge 之前恢复 dirty patch。
7. **恢复时解决 10 个确定 overlay conflicts。** 真删除 tests不复活；把 coverage迁到新结构。settings/models虽可能文本自动合并，也必须人工检查最终 provider、默认 model、Goal disabled、adapter缺失和 per-machine字段。
8. **每个非 Goal提交后跑定向验证。** 在所有 `goal-engine-*.test.mjs` 迁出默认 glob 前，禁止 `npm test`，因为当前 `HEAD` 的默认 glob会运行32个 Goal tests。
9. **非 Goal验证全绿后启动 fresh Host。** `goalEngine.enabled=false` 下确认无 `goal_*` 工具注册、Pi 0.84.2/fullscreen与 subagent runtime可用；不调用 Goal工具。只有在 R13/另行授权阶段才运行 `test:goal-engine`。
10. **最终再把 integration 分支合回 main。** 合并前复核 staged文件清单、无凭据、无旧 `.test.mjs`/新 `.integration.mjs` 双份、无 `spark` 残留引用、无 `enabledModels`提交差异。

### 建议的非 Goal验证命令

```bash
node --check scripts/doctor.mjs
node -e 'const fs=require("node:fs"); for (const p of ["pi/settings.json","pi/models.json","package.json"]) JSON.parse(fs.readFileSync(p,"utf8"))'
node --test \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-ir-coercion.test.mjs \
  test/subagent-dispatch-schema-coercion.test.mjs \
  test/subagent-dispatch-validation-errors.test.mjs \
  test/subagent-workflow-spawn.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/root-subagent-broker.test.mjs \
  test/root-subagent-broker-protocol.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/skill-list.test.mjs \
  test/skill-whitelist-extension.test.mjs
```

如最终保留 TDD/Skill policy tests，必须先按远端“行为而非字面值镜像”规则重写，再加入上面的非 Goal命令。不要运行 `npm test`、`npm run test:goal-engine`、任何 `test/goal-engine-*` 或 Doctor整文件测试，直到测试分组和本轮安全边界满足。

## 10. 现在能否开始 checkpoint + merge

**整体答案：不能。** 可以先做“专用分支 + 脱敏核验 + checkpoint 保存”，但不能紧接着 merge。当前 merge 会被 15 个 dirty overlap直接阻止；即使先 checkpoint，仍有 5 个 clean committed冲突和至少 10 个 dirty恢复冲突。

缺失决策如下：

- **[Agent/model 路由]**：executor最终用远端单 `codex-pool` + fallback，还是保留本地 openai/DeepSeek override及 spark。
- **推荐**：采用远端单 executor和 fallback，删除 spark/settings override，因为 runtime、Doctor、Skill、tests必须只有一个权威路由。
- **不选原因**：混用会让 Doctor、RPC coding-agent识别和实际执行模型不一致。
- **选错代价**：首次 coding dispatch或 fresh Host Doctor时暴露，修复代价高。

- **[AGENTS/Skill/测试治理]**：是否采用“AGENTS只路由、Skill持有流程”，并接受远端禁止文档/配置字面值镜像测试。
- **推荐**：采用该分层，保留远端泄露处置与行为测试规则；重写当前 policy tests为 parser/validator/fixture行为测试。
- **不选原因**：保留两套全文规则和全文镜像 tests会继续制造双事实源。
- **选错代价**：下一次 Skill或规则更新时暴露，修复代价中高。

- **[远端真删除 tests]**：6 个 dirty-modified但远端真删除的 tests是接受删除、迁移行为覆盖，还是复活旧路径。
- **推荐**：不复活旧路径；迁移仍有价值的 discovery/ABI行为，删除 provider/文档/存在性字面值镜像。
- **不选原因**：复活会违反远端测试政策，并让默认 suite再次绑定配置文本。
- **选错代价**：默认 test范围漂移或配置变动时暴露，修复代价中。

- **[Checkpoint 发布边界]**：是否允许把跟进复审中仍未关闭的 manage-providers/Doctor问题仅作为隔离 checkpoint保存，而不视为可发布变更。
- **推荐**：允许隔离 checkpoint，但 merge回 main前必须关闭或明确拆出；因为 checkpoint用于防丢，不等于验收通过。
- **不选原因**：直接把混合 WIP当发布提交会掩盖已知安全缺口。
- **选错代价**：敏感错误日志、model误删或 fresh clone缺Skill时暴露，修复代价高。

## 11. 审计命令与限制

主要只读命令：

- `git rev-parse`、`git merge-base`、`git rev-list --left-right --count`
- `git log --reverse --stat --summary`
- `git diff --find-renames --find-copies --name-status/--stat/--dirstat`
- `git merge-tree <base> HEAD origin/main` 及 marker/removed-entry解析
- `git show`、`git cat-file -e`、`git ls-tree`、`git ls-files --others --exclude-standard`
- `git status --porcelain=v2`、`git diff --cached --name-status`

没有运行代码测试；本任务是只读冲突审计，且用户明确禁止 Goal Engine及其 tests。没有依赖一次失败的 process-substitution merge-file实验作为结论；dirty恢复结论以 Git三方 hunk、rename/status和明确的 delete/modify关系为证据。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "§4 将 clean committed merge 收敛为 3 个文本冲突加 2 个真 modify/delete；§6 单列 15 个 dirty 阻断、10 个恢复冲突和 untracked 0 碰撞。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "§7 逐项覆盖根/pi AGENTS、settings、models、Doctor、dispatch/Root broker、Goal入口、Skills和tests，给出双方意图、不能整侧选择的原因、语义结果与非 Goal验证。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "§4.3 用 --find-renames 与 blob身份识别远端 Goal/subagent/worktree测试分组迁移；明确6个本地修改的R100来源应迁到.integration.mjs，并把8个真删除另列。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "§8.3 给出合并/后续冲突提交拆分；§9 给出checkpoint分支、保护分支、merge而非rebase、先clean committed后恢复dirty及非 Goal验证顺序。"
    },
    {
      "id": "criterion-5",
      "status": "satisfied",
      "evidence": "§10 明确整体不能开始checkpoint+merge，只能先隔离checkpoint，并列出四项缺失决策。"
    }
  ],
  "changedFiles": [
    "docs/reviews/2026-08-17-origin-main-merge-conflict-audit.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git rev-parse HEAD origin/main；git merge-base HEAD origin/main；git rev-list --left-right --count HEAD...origin/main",
      "result": "passed",
      "summary": "确认HEAD 01d1c7a、origin/main b5c0ce7、merge-base 4d0634c、ahead/behind 100/9。"
    },
    {
      "command": "git log --reverse --stat --summary 4d0634c..origin/main",
      "result": "passed",
      "summary": "确认远端9提交主题、父拓扑与每提交变化面。"
    },
    {
      "command": "git diff --find-renames --find-copies --name-status 4d0634c..origin/main；同范围HEAD比较",
      "result": "passed",
      "summary": "识别远端测试rename、真删除、本地committed 96文件变化面。"
    },
    {
      "command": "git merge-tree 4d0634c HEAD origin/main及marker/removed-entry解析",
      "result": "passed",
      "summary": "发现3个文本marker；结合rename/blob证据收敛为5个真实committed冲突。"
    },
    {
      "command": "git status --porcelain=v2 --untracked-files=all；git diff --cached --name-status；git ls-files --others --exclude-standard",
      "result": "passed",
      "summary": "写报告前确认56 tracked、36折叠untracked条目/50实际文件、无staged。"
    },
    {
      "command": "远端A/rename targets与untracked exact及父子路径交集检查",
      "result": "passed",
      "summary": "0个untracked覆盖碰撞。"
    },
    {
      "command": "python3 解析报告末尾 acceptance-report JSON并校验枚举/criteria/changedFiles",
      "result": "passed",
      "summary": "JSON有效，5项criteria齐全，changedFiles仅本报告，tests列表为空。"
    },
    {
      "command": "git status --short -- docs/reviews/2026-08-17-origin-main-merge-conflict-audit.md；git diff --cached --name-only",
      "result": "passed",
      "summary": "本报告为唯一新增审计文件；staged清单为空。"
    },
    {
      "command": "Goal Engine或其测试",
      "result": "not-run",
      "summary": "按安全边界明确未运行。"
    }
  ],
  "validationOutput": [
    "Clean committed merge：3个文本冲突 + 2个真modify/delete冲突；6个本地修改来源是R100测试迁移，不算机械删除冲突。",
    "Dirty层：15个路径会阻止现在直接merge；恢复层10个确定文本/modify-delete冲突。",
    "Untracked：远端新增/rename target碰撞为0。",
    "无Goal Engine调用或Goal tests。"
  ],
  "residualRisks": [
    "模型路由尚未决定：单codex-pool executor与当前openai/DeepSeek/spark意图冲突。",
    "AGENTS只路由/Skill持有流程及远端禁止字面值镜像测试尚未获产品确认。",
    "6个dirty-modified但远端真删除的tests尚未决定具体迁移/删除清单。",
    "当前checkpoint候选仍含跟进复审记录的manage-providers与Doctor已知缺口。",
    "未实际merge，rename-aware最终结果仍须在clean integration分支由Git和review gate确认。"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅新增中文只读合并冲突审计报告；未修改任何现有文件。",
  "reviewFindings": [
    "blocker: 当前15个dirty overlap使直接merge无法开始。",
    "blocker: Agent/model路由、AGENTS/测试治理、真删除tests去留未决。",
    "important: 32个本地Goal .test.mjs需迁入远端.integration.mjs分组，否则默认npm test仍会运行Goal tests。",
    "important: clean committed层有5个真实冲突；不能用路径重叠或ours/theirs批量解决。",
    "no untracked overwrite collision detected。"
  ],
  "manualNotes": "报告未显示remote URL或models中的用户/端点元数据；未读取或输出真实凭据。Review gate仍为required。"
}
```

## 12. 后续人类决策（2026-08-17）

以下审计时的产品决策已经由用户明确确认，后续冲突处理以此为准：

1. **Agent/model 路由：**采用远端单 executor + fallback 的权威路线；删除 spark 与本机 settings override，不混用两套路由。
2. **AGENTS/Skill/测试治理：**采用“AGENTS 只保存最小加载路由，Skill 保存详细流程”；吸收远端凭据泄露处置和行为测试规则，不恢复文档/配置字面值镜像测试。
3. **远端真删除 tests：**接受 7 个旧测试文件全部删除，不复活旧路径。仍有价值的覆盖按行为迁移：Skill discovery → `discoverManagedSkills`/真实 Pi RPC；model 配置 → Provider loader；Subagent ABI → IR/schema/runtime；Goal 行为 → 显式 `.integration.mjs` suite；历史移除/文件不存在断言直接删除。
4. **Checkpoint 边界：**manage-providers 与 Doctor 的审计缺口已在本报告之后修复；Scheduler adapter 仍在实现中，待其完成并通过非 Goal 验收后再确定 checkpoint 内容。

这些决策消除了 §10 的前三项产品阻塞；开始 checkpoint/merge 前仍需完成当前 Scheduler WIP、脱敏检查和提交授权。
