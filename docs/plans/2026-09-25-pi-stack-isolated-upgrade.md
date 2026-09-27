# pi 栈隔离升级（core 0.87.1 + pi-subagents 0.71.0 + 增强层边界重构）实现计划 v4

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。
> v4 依据用户决策引入独立 clone 基线 + managed worktree 并发模型；v3 依据二审报告（`d98b5ed1…/inline`），v2 依据一审报告（`cae814ae…/inline`）。

**目标：** 以独立 clone 为基线，在 managed worktree 并发隔离下完成 pi core 0.85.1→0.87.1（四包同版本）、pi-subagents 0.62.0→0.71.0 升级与 pi-subagents-enhanced 边界重构，全套门禁通过后经受控维护窗口切回主树，全程不触碰本机 live 环境与用户级外部状态。

**架构：** `~/pi-config-upgrade` 是**独立 clone**（非 linked worktree——managed workspace 的 `primaryOrigin` 校验要求 `.git` 为目录，见 `src/workspace/git-worktree.ts:128-134`；linked worktree 的 `.git` 是文件，不满足），分支 `upgrade/pi-stack-0.87`。clone checkout **保持 pristine-clean**（allocation preflight 要求 origin clean），自身只承载：依赖安装、只写忽略路径的测量任务（T2/T11）、最终验收（T11）。**全部改 tracked 文件的 coding 任务经 `execution.worktree: true` 派发**（无依赖冲突的同 Wave 任务真并发，集成队列串行 publish 进 clone 分支；串行链任务逐个排队集成）。live 主树、全局安装、用户级状态全程不动。

**技术栈：** zsh、Node >=22.19.0（原生 TS type-stripping）、npm、node:test、git clone + managed worktree（runtime typed action）。

## 全局约束

- **前置门禁（T1 阻塞项）：** 主树在途 WIP 须由用户先行处置（当前 `git status --short` 仍有大量变更）；clone 从落地后的主树创建，T1 记录基点 SHA、主树 clean 证明与审计差异说明。主 agent 不代用户提交、stash 或清理 WIP。
- **隔离铁律：** 一切变更只发生在 `~/pi-config-upgrade` clone 及其派生的 managed worktree；严禁修改主树工作区、严禁修改全局 pi 安装与用户级状态（`~/.zshrc`、全局 npm、uv tool）；**T1–T11 禁止调用 `init-pi.sh`**（副作用仅在 T12 授权③后发生）。clone 的删除与主树 worktree 管理不由本计划执行；managed worktree 一律经 `subagent_worktree` typed action（list/status/dispose/release）处置，禁止任何 bash git 删受管 worktree。
- **并发模型：**
  - Deps 是唯一调度权威：前驱任务的集成（`dispose integrate` 完成、clone 分支前进）完成后才派发后继。
  - 同 Wave 无写路径交集且无共享符号依赖的任务以 `execution.worktree: true`（`cwd=~/pi-config-upgrade`）**同时派发**，由集成队列串行 rebase/publish；`extension.ts` 串行链（T7→T8→T9）等交集任务按 Deps 逐个派发集成。
  - 只写忽略路径（`var/**`）的测量/验收任务（T2、T11）直接在 clone checkout 执行（`worktree: false`）。
  - **worktree 环境自举约定**：每个 managed worktree 首步 `npm install`（共享 `npm_config_cache="$UPGRADE_ROOT/var/tmp/npm-cache"`）；需要运行时/集成环境的任务加装 `npm install --no-save @earendil-works/pi-coding-agent@0.87.1 @earendil-works/pi-ai@0.87.1 @earendil-works/pi-agent-core@0.87.1 @earendil-works/pi-tui@0.87.1` 并运行 `node scripts/setup-subagent-runtime-deps.ts`；`PI_REAL_BIN` 统一用绝对路径指向 **clone 的** `node_modules/.bin/pi`（各 worktree 不重复安装）。
  - **停止条件**：allocation preflight 失败（origin dirty / ref drift / 非干净前进）时立即停止排查并上报，禁止 force 或绕过。
- **外部副作用隔离：** T1–T11 的所有执行环境必须导出：`PI_SESSION_OWNER_REGISTRY="$UPGRADE_ROOT/var/tmp/session-owner-registry"`、`TMPDIR="$UPGRADE_ROOT/var/tmp"`、`npm_config_cache="$UPGRADE_ROOT/var/tmp/npm-cache"`、`npm_config_prefix`（指向 clone）。clone checkout 执行前后记录 `git status --short` 快照；managed worktree 的脏状态属正常工作区变更（经集成回收）。
- **WritePaths 封闭性：** 任何任务不得写自身 WritePaths 之外；T11（验收）唯一写路径为 `var/upgrade/final-gate-report.md`，失败修复回退原任务重新派发（先修订计划再执行新范围）。
- **提交模型：** 升级分支上的提交由 runtime 集成队列在 `dispose integrate` 时产生（交付机制，不属违规 commit）；**手工 bash `git commit` 全程禁止**。T12 切换前须用户**分别**授权：①整理 clone 分支提交历史并按 `git-commit-convention` 产出最终提交（squash 或保留集成提交，由用户选择）；②从 clone merge 回主树；③运行 `init-pi.sh` 全量副作用（全局安装、shell 配置写入、skills 同步、Basic Memory CLI 重装、依赖重装）。三段授权独立，不得互相解释或提前。
- **目标版本精确值（原子切换，杜绝混合 SDK）：** core 四包 `@earendil-works/pi-coding-agent`/`pi-ai`/`pi-agent-core`/`pi-tui` 全部 0.87.1；pi-subagents `0.71.0`。全部版本锁点在 T4 一次性切换（core + subagents + init-pi.sh + 探针名单），升级中段不存在「新 lib × 旧 SDK」混合态（0.71 peer 要求 `pi-ai >= 0.86.1`）。
- **版本约束位置：** pi-subagents 三处（①enhanced `package.json` `dependencies`；②`scripts/setup-subagent-runtime-deps.ts` `PI_SUBAGENTS_VERSION`；③`packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts` 内部安装版本）；core 四包（root `package.json` `dependencies` 四包 + enhanced `devDependencies` 四包 + `init-pi.sh` `PI_VERSION` + `scripts/probes/pi-subagents-compat.ts` 支持名单）。**真实 lockfile 仅两处**：`package-lock.json`、`packages/pi-subagents-enhanced/package-lock.json`；`pi/npm` 是安装目录，无 lockfile、不创建。
- **缺陷分类门禁：** 所有失败**两列**记录——「版本归因（0.87-core / 0.71-lib / WIP 基线差 / 新引入）」与「AGENTS.md 数据来源三分类」，每条含 provenance 字段：入口（合法 public/typed 入口）、版本锁定（实际解析版本）、权威身份、事件/资源顺序、首个偏离点、修复后重跑命令。来源未证实一律 fail closed，禁止预防性兼容。
- **安全 capability 语义：** 安全相关能力（terminal proof、身份、权限）缺失时 fail closed 并停止升级流程上报；仅展示类能力允许显式降级并记录诊断。禁止未经 T3 证明的「回退 0.62 行为」假设。
- **TDD：** production/配置变更先 RED 后 GREEN；RED 预期只写「待实现行为缺失」，不混入旧实现多偏差。T2、T3 豁免但须落盘证据。
- **`.ts` 测试门禁：** `node --test test/*.test.ts` 依赖 Node 原生 type-stripping。T1 记录 `node --version`；T2/T11 先做无副作用加载探测（`node --test --test-name-pattern=__no_such_test__ <file>`），探测失败则该命令不作门禁、改 typecheck + 对应 runner 覆盖并记录。
- **输出语言：** 新文档、注释一律中文。
- **每任务执行时长（含测试）低于 30 分钟 watchdog**；T3/T5/T11 已预拆。
- **范围声明：** 本计划仅覆盖 Phase 1；「持续跟随机制」为后续独立计划。

## DAG

```text
T1 (clone 基线环境+前置门禁)
 ├──> T2 (0.87.1×0.62 基线，clone 内直跑) ────────────┐
 └──> T3 (0.71 shadow+契约+authority 图)               │
       └──> T4 (全部版本切换+安装链去 patch 化，原子)   │
             └──> T5 (compat facade+调用方迁移) <──────┘（T5 验收对照 T2 基线）
                   ├──> T6 (ordered-models+patch 退役) ─┐（并行 worktree）
                   └──> T7 (lifecycle 两段式) [extension.ts 串行链起点]
                         └──> T8 (RPC capability) ──┬──> T9  (workspace 对齐) [串行链末点]
                                                    └──> T10 (TUI 投影)（另依赖 T5：native-conversation.ts）
T5..T10 全部 ──> T11 (全量门禁矩阵+真实场景回归，clone 内直跑) ──> T12 (受控维护窗口切换)
```

## Waves

- Wave 1：T1
- Wave 2：T2、T3（并行；T2 clone 直跑，T3 managed worktree）
- Wave 3：T4（managed worktree，单独集成）
- Wave 4：T5
- Wave 5：T6、T7（并行 managed worktree，写路径无交集）
- Wave 6：T8
- Wave 7：T9、T10（并行 managed worktree）
- Wave 8：T11（clone 直跑）
- Wave 9：T12（须用户三段授权）

**关键路径：** T1 → T3 → T4 → T5 → T7 → T8 → T9 → T11 → T12。

---

### Task 1：clone 基线环境搭建与前置门禁

**Deps：** `none`

**WritePaths：**
- 无主树写路径；产物：`~/pi-config-upgrade/`（独立 clone）、clone 内 `var/upgrade/`（含 `var/tmp/` 隔离目录树）

**Resources：** 磁盘约 4GB（clone 依赖 + 共享 npm cache）；npm registry 网络。

**Files：**
- Create：`var/upgrade/inputs/`（计划 + 四份报告副本，各附来源路径、基点 SHA、副本 SHA-256）、`var/upgrade/precondition.md`

**接口契约：**
- Consumes：用户对 WIP 处置的确认（阻塞项）
- Produces：基线环境入口约定（T1–T11 统一使用）：
  - `UPGRADE_ROOT="$HOME/pi-config-upgrade"`
  - `PI_REAL_BIN="$UPGRADE_ROOT/node_modules/.bin/pi"`（0.87.1，worktree 任务也用此绝对路径）
  - clone 直跑 shell 模板：`env PI_REAL_BIN=... PI_CODING_AGENT_SESSION_DIR="$UPGRADE_ROOT/var/sessions" PI_CODING_GOAL_DIR="$UPGRADE_ROOT/var/goals" PI_CODING_WORKSPACE_DIR="$UPGRADE_ROOT/var/workspaces" PI_SESSION_OWNER_REGISTRY="$UPGRADE_ROOT/var/tmp/session-owner-registry" TMPDIR="$UPGRADE_ROOT/var/tmp" npm_config_cache="$UPGRADE_ROOT/var/tmp/npm-cache" zsh -f -c 'source '"$UPGRADE_ROOT"'/scripts/pi-shell.zsh; <命令>'`
  - precondition.md：基点 SHA、主树 clean 证明、`node --version`、allocation preflight 四项核验结果、smoke workspace 记录、外部隔离目录初始化清单
- **managed worktree 派发模板**：`execution: { cwd: "$UPGRADE_ROOT", worktree: true }` + 全局约束的环境自举约定 + `output` inline

**验收标准：** ①用户已确认 WIP 处置且主树 clean（记录基点 SHA 与 node 版本）；②clone 为独立仓库（`.git` 是目录），分支 `upgrade/pi-stack-0.87` **直接自记录的基点 SHA 创建**，HEAD attached 于新分支，**clone 全程从不检出/使用 main**（`git branch --show-current` 输出即新分支）；③`node_modules/.bin/pi --version` = `0.87.1`，clone 内实读四包版本均 0.87.1；④隔离 shell 验证（`pi --version`=0.87.1、`PI_CODING_AGENT_DIR` 指向 clone、隔离变量生效）；⑤安装后 clone `git status --short` **为空**（`/var/`、`node_modules/`、`/pi/npm/` 均被 .gitignore 覆盖的证据）；⑥allocation preflight 四项全过（primary `.git` 目录、HEAD attached、ref 无漂移、origin clean）+ 一次 smoke managed worktree `allocate → status → dispose(discard)` 全链路成功；⑦inputs 副本齐全含 hash；⑧执行前后主树 `git status --short` 一致、用户级路径无变化。

- [ ] **步骤 1：前置门禁**——用户确认 WIP 已处置；记录基点 SHA、clean 证明、`node --version`
- [ ] **步骤 2：** `git clone --no-checkout ~/pi-config ~/pi-config-upgrade && cd ~/pi-config-upgrade && git checkout -b upgrade/pi-stack-0.87 <基点SHA>`（`--no-checkout` 保证 main 从未被检出；分支直接自 precondition.md 记录的基点 SHA 创建，不依赖默认分支 HEAD；本地 clone 共享对象存储）；创建 `var/tmp/` 隔离目录树
- [ ] **步骤 3：** `npm install` + `npm install --no-save <四包@0.87.1>` + `node scripts/setup-subagent-runtime-deps.ts`（仍装 0.62，供 T2 基线）
- [ ] **步骤 4：** allocation preflight 核验 + smoke managed worktree（allocate/status/dispose-discard，经 typed action）
- [ ] **步骤 5：** inputs 复制（含 hash）；隔离验证（验收标准 ③④⑤⑧）

---

### Task 2：基线记录（0.87.1 core × 现有代码 0.62.0）——clone 直跑

**Deps：** `T1`

**WritePaths：** `var/upgrade/baseline-0.87.1-0.62.md`（忽略路径，clone 直跑）

**Resources：** `none`

**接口契约：**
- Consumes：T1 环境入口
- Produces：基线报告——每条门禁的命令、退出码、实际解析版本（四包 + pi-subagents，`node -e` 读 package.json，不接受 grep）、通过/失败/skip 数及原因、失败双列归因 + provenance 字段

**验收标准：** 覆盖：`npm test`、`node --test test/subagent-dispatch-extension.test.ts`（先加载探测）、`node --test test/subagent-dispatch-rpc.test.mjs`、`npm run test:subagent-workspace`、`npm run test:delegation-workspace-harness`、`npm run typecheck` 与 `npm run typecheck:subagents-enhanced`、`npm run verify:subagents-enhanced`、`PI_REAL_BIN=<0.87.1> npm run doctor`、`PI_REAL_BIN=<0.87.1> npm run test:integration`、`PI_REAL_BIN=<0.87.1> npm run test:subagents`、`npm run test:subagents-enhanced`。不存在/不适用命令如实记录，不静默跳过。完成后 clone 仍 clean。

- [ ] **步骤 1：** `.ts` 门禁加载探测 → **步骤 2：** 逐条运行记录 → **步骤 3：** 双列归因 + provenance 落盘 → **步骤 4：** clone clean 复验

---

### Task 3：pi-subagents 0.71.0 shadow 探测、适配契约与 authority 图（managed worktree）

**Deps：** `T1`

**WritePaths：** `docs/upgrades/pi-subagents-0.71-adapter-contract.md`（tracked → 经集成提交进 clone 分支）

**Resources：** npm registry；shadow 安装于 `/tmp/pi-shadow-0.71/`；worktree 自举按全局约定（含四包 + setup）。

**接口契约：**
- Consumes：inputs 四份报告副本
- Produces：契约文档五节 + 真实链路 trace（同 v3 要求不变）：
  1. **exports 实测清单**（shadow 真实 `npm install`，逐公开 specifier import 验证 + `.d.ts`/源码/最小调用）
  2. **8 项 compat 映射决策表**（公开 API / 自建 facade / **无安全实现路径→升级决策项**三选一，附证据；通知投递、owner identity、artifact/terminal authority 无公开 API 时停止并上报）
  3. **facade TS 接口签名**
  4. **capability 协商清单**（安全类 fail closed / 展示类可降级；静态不可确认项 → T11 动态矩阵）
  5. **authority/等待边图**（terminal proof 产生方/时点/消费方/等待边；A 段 child 参与型 / B 段终局门控边界，证据 `child-integration-lifecycle.ts:118-121,143-150`、`integration-queue.ts:250-274`）
  另附：**真实最小链路 trace（放行前提）**——以本仓真实 Host extension 入口启动 parent，经合法 public dispatch spawn child，完整记录 parent/root session identity、child runId 与 cwd、RPC ping/spawn reply、`agent_end`/`agent_settled`/terminal proof 事件序列（事件文件留存 `var/upgrade/trace/`，忽略路径）。**禁止**直接 import 内部模块、手工 event、fake child。安全 capability 缺失立即停止形成升级决策项。

**验收标准：** 五节 + trace 齐全；每决策附证据；无「待定」（决策或升级决策项二选一）；中文；集成后 clone 分支含契约提交。

- [ ] **步骤 1：worktree 自举**（npm install + 四包 + setup + shadow 安装）→ **步骤 2：** 8 项映射决策 → **步骤 3：** capability + authority 图 → **步骤 4：** 真实 Host 链路 trace → **步骤 5：** 落盘并 `dispose integrate`

---

### Task 4：全部版本切换与安装链去 patch 化（原子，杜绝混合 SDK）

**Deps：** `T3`（理由：切换可行性 + 真实链路验证已通过）

**WritePaths：**
- `scripts/setup-subagent-runtime-deps.ts`
- `packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts`
- `packages/pi-subagents-enhanced/scripts/verify-package.ts`
- `packages/pi-subagents-enhanced/package.json`（`dependencies.pi-subagents` + devDeps 四包）
- `package.json`（dependencies 四包）、`package-lock.json`、`packages/pi-subagents-enhanced/package-lock.json`
- `init-pi.sh`（`PI_VERSION`）
- `scripts/probes/pi-subagents-compat.ts`（支持名单，`:41,120-123`）与 `test/pi-subagents-runtime.integration.mjs`（名单断言，约 `:416-421`）
- `test/init-pi.test.mjs`（版本断言）
- `test/setup-subagent-runtime-deps.test.mjs`、`test/pi-subagents-enhanced-package.test.mjs`
- `packages/pi-subagents-enhanced/AGENTS.md`、`packages/pi-subagents-enhanced/README.md`
- `README.md`（已验证版本清单）

**Resources：** `none`

**接口契约：**
- Consumes：T3 契约第 2 节
- Produces：**一次性版本切换**——pi-subagents 三处锁点 + core 四包（root deps + enhanced devDeps + `init-pi.sh` + 探针名单）全部到位；package `setup-runtime-deps.ts` 不再 import patch 模块、不执行 patch/自建编译；`verify-package.ts` 新语义：受控比较算法（registry tarball 解包 vs `node_modules/pi-subagents` 受控文件集合，排除 npm 生成元数据；bundle 内 `node_modules` 规则以 `bundleDependencies` 实际行为记录；`npm pack --dry-run` 清单验证）+ 版本 = 声明；删除 0.62 guard 与 patch marker 校验

**验收标准：** 干净安装（删 `packages/pi-subagents-enhanced/node_modules`）成功；`node -e` 实读 pi-subagents=0.71.0、core 四包=0.87.1（无混合）；受控比较与 `npm pack --dry-run` 通过；`npm run verify:subagents-enhanced`（新语义）、`node --test test/setup-subagent-runtime-deps.test.mjs test/pi-subagents-enhanced-package.test.mjs test/init-pi.test.mjs` 通过；`npm ls` 四包一致。**GREEN 仅覆盖安装链/manifest/lock/名单一致性；facade 可加载性由 T5 联合验收。** RED 仅断言待实现版本语义。

- [ ] **步骤 1：RED——版本/安装/verify/名单断言统一更新**（0.71.0 + 0.87.1 + 新 verify 规则）→ **步骤 2：确认 RED** → **步骤 3：全部锁点与脚本实现 → GREEN** → **步骤 4：干净安装演练 + `npm ls` 证据 + 受控比较 + `npm pack --dry-run`** → **步骤 5：`dispose integrate`**

---

### Task 5：compat facade 重写与调用方迁移

**Deps：** `T4`（理由：0.71 + 四包 0.87.1 实际可安装作为编译与加载基础）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.71.ts`（Create）
- `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts`（Delete）
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`extensions/custom-footer.ts`、`src/tui/browser-adapter.ts`、`src/tui/native-conversation.ts`、`src/subagent-dispatch/extension.ts`（仅 import 行）
- `test/pi-subagents-compat.test.mjs`、`scripts/probes/pi-subagents-compat.ts`（compat 探针 subagents 侧）

**Resources：** `none`

**接口契约：**
- Consumes：T3 契约第 2、3 节，逐字实现
- Produces：facade 导出契约第 3 节全部签名；全部调用方仅 import 新 facade；facade 实际 `import` 可加载（联合验收）

**验收标准：** 根与 enhanced typecheck（0.87.1 SDK × 0.71 lib，无混合态）通过；compat 测试 GREEN；`node --input-type=module -e` 实测 import facade 全部能力成功；生产与有效配置路径 grep 无 `pi-subagents-0.62` 残留（历史文档与本计划排除）。

- [ ] **步骤 1：RED——按契约签名重写 compat 测试**（真实实现，不 mock）

```javascript
// test/pi-subagents-compat.test.mjs 骨架（签名以 T3 契约为准）
import test from "node:test";
import assert from "node:assert/strict";
import * as compat from "../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.71.ts";

test("facade 暴露契约定义的全部能力", () => {
  for (const name of ["upstreamSubagentRuntime", "loadConfig", "registerSubagentNotify",
    "resolveCurrentSessionId", "currentCompletionOwnerId", "getArtifactsDir",
    "readFleetTranscript", "renderFleetTranscript", "discoverAgents"]) {
    assert.equal(typeof compat[name], "function", `${name} 必须是函数`);
  }
});
```

- [ ] **步骤 2：确认 RED** → **步骤 3：按契约实现 facade** → **步骤 4：GREEN** → **步骤 5：调用方 import 迁移 + 删旧文件 + 重跑 typecheck/compat/加载验收** → **步骤 6：`dispose integrate`**

---

### Task 6：ordered-models 迁移与 patch 文件退役

**Deps：** `T5`（理由：patch 文件已无 import 方；model-selection 先行稳定）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts`（Delete）
- `packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`
- `test/subagent-ordered-models-runtime.test.mjs`（Delete/重写为 `test/subagent-ordered-models.test.mjs`）

**Resources：** `none`（与 T7 同 Wave 并行 managed worktree）

**接口契约：**
- Consumes：T3 契约第 2 节（`subagentOnlyExtensions` 决策行）
- Produces：**预选与重试分离**——①`resolveModelCandidates(profile)` 纯函数（既有导出风格、向后兼容签名）；②运行中失败重试策略仅定义于 dispatch 编排（错误来源白名单、次数上限、run/workspace 身份与副作用约束；0.71 失败语义不支持时记升级决策项）；③stream-read-error-recovery patch 退役依据（须有 0.71 覆盖证据，否则升级决策项）

**验收标准：** patch 文件与旧测试删除后全仓无引用；候选链解析与全空报错单测过；child extension 注入走 0.71 公开 API 接线测试过；`npm run verify:subagents-enhanced` GREEN。

- [ ] **步骤 1：RED——候选链纯函数测试** → **步骤 2：确认 RED** → **步骤 3：实现 → GREEN** → **步骤 4：child extension 注入切换** → **步骤 5：删除 patch 文件与旧测试 + 回归** → **步骤 6：`dispose integrate`**

---

### Task 7：lifecycle 两段式状态机

**Deps：** `T5`（理由：消费新 facade；`extension.ts` 串行链起点）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`
- `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（lifecycle handler 段及关联共享符号——串行链第一写者）
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`
- `test/subagent-dispatch-extension.test.ts`

**Resources：** `none`（与 T6 同 Wave 并行 managed worktree；写路径无交集）

**接口契约：**
- Consumes：T3 契约第 5 节 authority/等待边图（唯一设计输入）
- Produces：两段式规则——A 段（child 参与型：冲突续接/admission/rebase 启动保持在 awaited `agent_end` 内，现有协议不变）；B 段（终局门控：发布/释放/回收/preserve 处置须消费 terminal proof）；`agent_settled` 仅观察；steer/follow-up delivered 按契约映射 supervisor receipt

**验收标准：** 事件 fixture 四场景全过：①queued follow-up 未消费不提前推进 B 段；②消费后 delivered；③A 段冲突续接时序不回归；④terminal proof 到达前 B 段处置拒绝、到达后放行。fixture 内联；T11 真实链路复验。

- [ ] **步骤 1：RED——四场景 fixture 测试** → **步骤 2：确认 RED（①④ 失败于现状）** → **步骤 3：按契约实现 → GREEN** → **步骤 4：回归**（`.ts` 门禁遵守加载探测规则）→ **步骤 5：`dispose integrate`**

---

### Task 8：RPC capability 协商

**Deps：** `T7`（理由：`extension.ts` 串行链；共享符号由 T7 先行稳定并集成）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（spawn 静态断言段——串行链第二写者）
- `test/subagent-dispatch-rpc.test.mjs`

**Resources：** `none`

**接口契约：**
- Consumes：T3 契约第 4 节（安全类/展示类标注）
- Produces：`negotiateCapabilities()`——启动 `ping` 一次按 methods 启用消费；**安全类缺失 → fail closed：拒绝 spawn 并停止升级上报**；展示类缺失 → 降级 + 诊断；`subagents:rpc:v1` envelope 不变；未知 method/字段透传不误读；spawn reply `runId`/`asyncDir`/`cwd` 按协商校验

**验收标准：** 五分支测试：①全能力→全启用；②安全类缺失→fail closed（断言拒绝与上报，不断言降级）；③展示类缺失→降级+诊断；④未知字段透传不抛错；⑤spawn reply 按协商分支校验。

- [ ] **步骤 1：RED——五分支矩阵测试** → **步骤 2：确认 RED** → **步骤 3：实现 → GREEN** → **步骤 4：回归 rpc 套件** → **步骤 5：`dispose integrate`**

---

### Task 9：workspace/worktree 所有权对齐

**Deps：** `T8`（理由：`extension.ts` 串行链末点；0.71 干净安装由 T4 保证）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/service.ts`、`git-worktree.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（仅 spawn cwd 注入段——串行链第三写者）
- workspace 相关既有测试套件（按需新增用例）

**Resources：** `none`（与 T10 同 Wave 并行 managed worktree；写路径无交集）

**接口契约：**
- Consumes：T3 契约第 4 节 worktree 配置项（0.71 禁用 upstream worktree 的配置键实测）
- Produces：唯一 owner 规则——本仓 workspace service 全权管理 worktree 生命周期；upstream worktree 经 0.71 配置显式禁用；spawn `dispatchCwd` 注入行为锁定

**验收标准：** workspace 套件全过 + 新增：①经新 facade spawn 的 child 不产生 upstream worktree/目录（以 T3 实测 0.71 默认行为为基准写失败预期，基准已满足则记录改锁定测试）；②dirty source fail-closed 回归不变。

- [ ] **步骤 1：RED——用例①** → **步骤 2：确认/记录** → **步骤 3：禁用配置 + 对齐 → GREEN** → **步骤 4：回归** `npm run test:subagent-workspace` + `npm run test:delegation-workspace-harness` → **步骤 5：`dispose integrate`**

---

### Task 10：TUI 状态投影 schema 化

**Deps：** `T5`（理由：`native-conversation.ts` 共享文件，T5 先行集成）、`T8`（理由：消费 `negotiateCapabilities()` schema）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/tui/session-browser.ts`、`native-conversation.ts`
- `test/subagent-session-browser.test.mjs`（既有文件，扩展用例）

**Resources：** `none`（与 T9 同 Wave 并行 managed worktree）

**接口契约：**
- Consumes：T3 契约第 4 节 status projection + T8 `negotiateCapabilities()` 返回类型
- Produces：`projectSessionStatus(negotiated, raw)` 纯函数——active / terminal / awaiting-disposition 三分类；未知状态归 awaiting-disposition 并透传；替换 `session-browser.ts:45-50` 硬编码 0.62 状态集合；渲染组件不变更

**验收标准：** 分类表测试覆盖 0.62 旧状态 + 0.71 新状态（retained/paused/stopped/terminal-proof）+ 未知状态；投影独立于渲染。

- [ ] **步骤 1：RED——分类表测试** → **步骤 2：确认 RED** → **步骤 3：实现并替换硬编码 → GREEN** → **步骤 4：回归 TUI 套件** → **步骤 5：`dispose integrate`**

---

### Task 11：全量门禁矩阵与真实场景回归——clone 直跑

**Deps：** `T5`、`T6`、`T7`、`T8`、`T9`、`T10`（全部集成完成）

**WritePaths：**
- `var/upgrade/final-gate-report.md`（唯一写路径；失败修复回退原任务重新派发）

**Resources：** `PI_REAL_BIN`（0.87.1）+ 隔离 shell（全部外部副作用隔离变量）；超 30 分钟按套件分批。

**接口契约：**
- Consumes：T3 契约第 4 节「动态验证项」+ T2 基线
- Produces：final-gate-report——T12 唯一放行依据

**验收标准：**
1. **静态套件**（逐条记录退出码/通过数/skip 数及原因/实读四包与 pi-subagents 版本）：T2 全清单 + `node --test test/subagent-ordered-models.test.mjs`；`.ts` 门禁先加载探测。
2. **动态场景矩阵**（真实链路，隔离变量齐全，禁止用户级副作用；每项留存事件证据路径）：fresh spawn；fork；**含 `context_edit` 的 fork 与 pruned-fork**（0.87.1 `sessionManager.appendContextEdit()` 真实产生，禁手拼 JSONL；验证模型上下文隐藏/替换语义）；steer→consumed follow-up；interrupt/resume；retained resume；foreground/background native session 差异（provider/required extension 加载）；compaction retry；多 settled handler；nested child 终局关系；watchdog 基本路径；通知去重；loader 激活与 session branch 切换；structured output/acceptance 拒绝；本仓 worktree spawn/preserve/release/discard/baseRef/冲突集成；`--mode json` 事件投影；tool-result details 全量 JSON-Compatible 递归断言。
3. **失败处理**：完整 provenance 字段 + 双列归因；production 缺陷回退原任务修复重跑；安全类 fail closed 触发即停止上报。
4. **收尾核验**：`subagent_worktree list` 无泄漏 workspace；clone `git status --short` 为空（T11 自身只写忽略路径）；`git diff --name-only`（相对基点）只含各任务 WritePaths 声明范围（含不得出现新 lockfile）。

- [ ] **步骤 1：静态套件分批记录** → **步骤 2：动态矩阵逐场景（真实 public 入口）** → **步骤 3：provenance 归因与回退修复循环** → **步骤 4：收尾核验 + 落盘报告 + 基线双列对比**

---

### Task 12：受控维护窗口切换（非原子；须用户三段独立授权）

**Deps：** `T11`（唯一放行依据）+ 用户授权 ①提交历史整理 ②merge ③`init-pi.sh` 全量副作用

**WritePaths：**
- clone 内：升级分支提交整理产物（授权①后）、`var/upgrade/switch-runbook.md`
- 主树：merge 操作（授权②后）；`init-pi.sh` 副作用（授权③后）

**Resources：** 用户在场；维护窗口。

**接口契约：**
- Consumes：final-gate-report 全绿结论
- Produces：live 环境切换到 0.87.1（四包）+ 0.71.0 + 新增强层；三态回滚 runbook

**验收标准：**
1. 切换前：确认最终变更清单与排除项（`var/`、inputs 副本不入库）；`subagent_worktree list` 清零（全部 workspace 已 dispose）；主树与 T1 基点对账无未验证漂移；授权①后按用户选择整理 clone 分支历史（squash 或保留）并按 `git-commit-convention` 产出最终提交，记录**基点 SHA / 交付 SHA / 门禁所测 SHA / merge SHA** 四值。
2. 环境清理：退出旧 Host 会话与相关 child；清理升级专用环境变量（**`PI_REAL_BIN` 不得继承**——`init-pi.sh:33-40` 优先读取会跳过全局安装导致 smoke 假阳性）；核验全局二进制绝对路径。
3. 授权②merge：主树 `git fetch ~/pi-config-upgrade upgrade/pi-stack-0.87 && git merge --no-ff FETCH_HEAD`；授权③运行 `init-pi.sh`（副作用清单已在授权③明示）→ smoke（新终端 `pi --version`=0.87.1、四包版本核验、subagent runtime 注册、会话目录完整）。
4. **三态回滚 runbook**（演练级）：Ⅰ merge 前失败（丢弃分支）；Ⅱ merge 后安装失败（`git revert -m 1 <merge>` + 旧版 `init-pi.sh` + 全局二进制核验 + shell 配置/skills/Basic Memory 恢复）；Ⅲ smoke 失败（同 Ⅱ + `var/` 会话与配置备份恢复位置；**0.87 新会话的 0.85 回读兼容性不做无条件承诺**）。依赖恢复材料（npm cache/offline 包路径）预先记录。clone 的删除由用户手动执行。

- [ ] **步骤 1：前置检查与四 SHA 记录** → **步骤 2：三段独立授权逐项取得** → **步骤 3：环境清理 + 授权①提交整理** → **步骤 4：授权②merge + 授权③安装 + smoke** → **步骤 5：报告结果与回滚预案**
