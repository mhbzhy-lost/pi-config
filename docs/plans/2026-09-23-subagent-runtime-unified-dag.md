# Subagent Runtime 缺口修复统一执行 DAG

> **给执行 agent：** 本文档是本轮 runtime 缺口修复的**唯一调度入口**。后续派发必须使用本文的 canonical Task ID、Deps、WritePaths 与 Resources；不得直接按计划 A 或 v2 文档中的局部 DAG 派发。实现步骤与代码片段仍以本文「详细来源」指向的原计划为准，但若局部计划与本文的依赖、资源或验收分组冲突，以本文为准。
>
> **状态：** DAG 已建立；证据恢复与现场快照已完成但尚未提交；隔离 harness 与代码任务尚未完成。

**目标：** 将计划 A 的派发合同修复、v2 中 workspace/proof 修复、宿主工具面与测试卫生任务统一为一张可机械调度、可独立验收、可记录资源竞争的 DAG。

**架构：** 前置批次先固化调查证据、只读快照 live 现场并完成宿主交接，再进入 A → B → C 三个严格阶段。阶段内部仅在真实依赖不存在且 WritePaths 可隔离时并行；共享测试文件与全量测试通过 Resources 串行化。本文不复制数千行实现步骤，而是为每个节点提供 canonical ID、依赖、写入边界、资源锁、详细来源和独立验收出口。

**技术栈：** Node.js `>=22.19.0`、原生 TypeScript type-stripping、TypeScript、`node:test`、`jiti`、固定 `pi-subagents@0.62.0`、package exports。

## 全局约束

以下约束对本文全部节点生效；子任务不得以局部计划遗漏为由降低约束：

- 工作树与 `var/workspaces/` 是案发现场；禁止 `git stash`、`git reset`、`git clean`、`git checkout -- <path>`、raw `git worktree` mutation、清理遗留 worktree、queue item 或 proof debt。
- `pi/agents/reviewer.md`、`pi/settings.json`、`pi/models.json`、`var/workspaces/` 是受保护路径；每个代码节点开工前必须实际运行 `git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`，命中门禁立即停止。
- 仓库和 package 的最低 Node 版本为 `>=22.19.0`；新增或迁移 TypeScript 必须由 `npm run typecheck` 或等价 `tsc --noEmit` 覆盖。
- `scripts/` 只放 CLI、初始化脚本和诊断探针；production 模块不得 import `scripts/**`。共享实现归属 feature 或 package 的公开入口。
- `pi/extensions/`、`packages/*/extensions/` 只放 Host 入口；可复用实现放在 `src/`，不得把入口反向当实现库。
- 不得为新的 production/CLI 实现选择 `.mjs`；`.mjs` 仅保留在测试、fixture、测试辅助模块及既有外部兼容入口。
- 严格 TDD：先写失败测试，再确认具体断言级 RED，再写最小实现，再确认 GREEN。`TypeError`、`module not found`、typecheck 失败不是合法 RED。
- 新增导出的 RED 例外：测试首行必须用 `assert.equal(typeof X, "function", "X 必须已导出")`，使失败表现为断言失败而非调用未定义函数。
- 按仓库「缺陷数据来源分类门禁」处理异常：来源未证实时 fail closed；不得为测试制造的不可达数据增加 production 兼容分支。
- 代码、注释、文档和任务报告使用中文；错误 code、标识符、命令、路径与标准技术术语保持原样。
- 每个节点只能修改自己的 WritePaths；共享 WritePaths 必须由共同 Resources 或 DAG 顺序覆盖。Resources 是资源竞争，不替代真实业务依赖；DAG 依赖也不得仅因资源竞争而添加。
- 计划中所有 `文件:行号` 仅用于首次定位；执行必须按符号或代码片段确认，行号漂移不得成为跳过改动的理由。
- lifecycle 批次既有改动必须保持内容指纹；禁止用绝对行号判断 hunk 未变，必须使用 patch/context 比较。
- 验收使用临时 fixture，不以 `var/workspaces/` live 内容作为测试断言。live 现场只允许只读观察，并以快照作为对照。
- 深层 `pi-subagents` import 只能集中在 `src/compat/pi-subagents-0.62.ts`；不得从 `scripts/**`、`pi/extensions/**` 反向依赖 production feature。
- `pi/settings.json` 的 `enabledModels` 与 `pi/models.json` 本机定义不得提交；不得读取、输出或写入凭据、密钥、cookie、token、private key、authorization 内容。
- `workflow` 删除策略、`bash cwd` 方案 A、contractHash 不做兼容层但增加旧 record 加载测试、不新增 TDD 合同机械门禁，均为已裁决事项；执行节点不得重新论证或反向实现。
- 提交不是默认步骤；只有用户明确授权后，才按 `git-commit-convention` 处理指定文件，且不得顺带提交其他批次的 untracked 文件。

## 证据基线与节点状态

| 节点 | 当前状态 | 说明 |
|---|---|---|
| `P-EVIDENCE` | 已完成，未提交 | 9 份调查产物已恢复到 `docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/`；7 份 write/edit 型报告已独立逐字节重放一致，D 是 live 重跑快照；提交需单独授权 |
| `P-SNAPSHOT-CONTRACT` | 已完成，结论修正后可消费 | 源码确认缺失 records 会被 list/listScoped 跳过；outbox 为数组/对象集合；root coordinator 另行存在且可解析 |
| `P-SNAPSHOT` | 已完成 | 四个 partition、root coordinator 与 worktree 数量已按契约快照 |
| `P-HARNESS` | 已完成 | 临时 origin/state/coordinator/Root Broker/Git harness 通过 |
| `A-ENV` | 已完成，`degraded` | contract-level fencing 通过，真实 supervisor transport 未证实 |
| `A0`–`A-ACC` | 已完成 | A 阶段确定性验收通过，真实 Pi lane 环境受限 |
| `B6`–`B-ACC` | 已完成 | B 阶段确定性验收通过，历史 debt 未清理 |
| `C9`–`C-ACC` | 已完成 | C 阶段确定性验收通过，C11 来源未证实、E-PI 未验证 |
| `C13` | 已完成 | workflow 合同迁移测试卫生收尾，workspace suite 36/36 |
| `E-PI` | 已完成，环境受限 | 普通真实 Pi RPC 子集通过；attention lane 超时，真实 supervisor lane 未验证 |
| `L-ORPHAN` | 已完成，来源未证实项保留 | 两个 lifecycle orphan 无 production importer，未删除/接线 |
| `D-AUDIT` | 已完成 | 基于快照只读分类历史 proof debt，未执行 cleanup |
| `E-PI-ISOLATION` | 已完成，探针 blocked | 隔离测试设计已落盘，attention lane 因无法证明不连接 live coordinator 保持 blocked |
| `L-ORPHAN-WIRING` | 已完成，外部 loader 未证实 | durable registry 可做生产组合点定位；coordinator-process 需仓外 loader 权威证据 |
| `H-PI-1` | 已完成 | fake parent/child 进程组回收 helper 4/4 通过，未启动真实 Pi |
| `H-PI-2` | 已完成 | 真实 Pi Host 0.85.1 E2E 全链路通过（12.7s）：dispatch→workspace 分配→child bash commit→Auto Integration admission/rebase/publish→terminal proof→release→origin clean。同文件 hostile-legacy/rename-canary 为预存断裂（A2 workflow 字段删除后 fixture 未迁移），不属于本节点范围 |
| `BUG-PRESERVE-REASON` | 已完成 | 协议允许可选 bounded `reason`，RED→GREEN，提交 `ddcf487`；protected-path 门禁后由用户将 settings/models 转 per-machine 解除 |
| `BUG-TERMINAL-PROOF-GATE` | 已完成 | E2E 首个偏离点暴露：`executorProofSnapshot` 用 Goal 授权门禁 terminal proof 可见性，standalone run 永远 null。历史 529 条 debt 大量 `terminal-unobserved` 的根因。RED→GREEN 提交 `145c25a`；bug 记录 `docs/bugs/2026-09-28-standalone-terminal-proof-invisible.md` |
| `L-REGISTRY-ENTRY` | 已完成，blocked-unknown | 无合法 production composition importer；需 owner/authority/reference 契约后再接线 |
| `D-CLEANUP` | blocked，根因已修复但保持冻结 | 历史 debt provenance 候选为 0；本轮不进行 live mutation。注意：`145c25a` 已修复 terminal-unobserved 根因，后续重新评估 debt 分类时可消费此事实；用户已明确“不急”，保持冻结 |

`P-EVIDENCE` 已有完整产物时不得重复从 `/tmp` 恢复；执行器应以恢复目录、README、独立重放结果和当前 `git status` 作为其完成证据。

## Canonical DAG

```text
P-EVIDENCE ─────┐
                 ├──> P-SNAPSHOT-CONTRACT ──> P-SNAPSHOT ──> P-HARNESS ──> A-ENV
                 │                                               │
                 │                                               v
                 │                                      A0 ──> A1 ──┬──> A2 ──> A6 ──┐
                 │                                                  └──> A3 ────────┤
                 │                                      A4 ──────────────────────────┤
                 │                                      A5 ──────────────────────────┤
                 │                                                                      v
                 │                                                                    A-ACC
                 │                                                                      │
                 │                                                                      v
                 │                                             ┌───────────────> B6 ────┐
                 │                                             │                  B7 ────┤
                 │                                             │                  B8 ────┤
                 │                                             │                       v
                 │                                             └─────────────────── B-ACC
                 │                                                                      │
                 │                                                                      v
                 │                                             C9 ─────┐
                 │                                             C10 ────┤
                 │                                             C11 ────┤──> C-ACC ──> C13 ──┐
                 │                                             C12 ────┘                     │
                 │                                                                           ├──> E-PI
                 │                                                                           ├──> L-ORPHAN
                 │                                                                           ├──> D-AUDIT ──> D-PROVENANCE ──> D-INTERFACE-DESIGN ──┐
                 │                                                                           ├──> E-PI ──> E-PI-ISOLATION ─────────────────────────────┼──> D-CLEANUP-RECHECK ──> D-CLEANUP [单独授权门]
                 │                                                                           └──> L-ORPHAN ──> L-ORPHAN-WIRING ───────────────────────┘
```

### Canonical 依赖表

| Task ID | 映射的旧任务 | Deps | 依赖理由与具体产物 |
|---|---|---|---|
| `P-EVIDENCE` | 调查证据恢复批次 | `none` | 产出 tracked 调查报告、恢复脚本、README 与完整性对照 |
| `P-SNAPSHOT-CONTRACT` | 新增前置探针 | `P-EVIDENCE` | 消费生产 ledger/outbox 源码与当前只读布局，产出缺失目录及摘要字段的可执行契约；已确认 root coordinator 不属于 partition 子目录 |
| `P-SNAPSHOT` | 总纲 §2 步骤 2 | `P-EVIDENCE,P-SNAPSHOT-CONTRACT` | 证据先固化，且先确认稀疏分区如何快照，之后才能形成可解释的现场基线 |
| `P-HARNESS` | 新增隔离环境节点 | `P-SNAPSHOT` | 用临时真实 harness 替代无意义的旧 host 重启，产出可重复的 coordinator/Root Broker/Git 环境证据 |
| `A-ENV` | 计划 A / T-ENV | `P-HARNESS` | 消费隔离 harness 与当前 runtime 探针结果，产出 `full`/`degraded` 控制面判定 |
| `A0` | 计划 A / T0 | `A-ENV` | 消费 host 判定，建立孤儿模块 allowlist 守卫 |
| `A1` | 计划 A / T1 | `A0` | 消费 allowlist 与孤儿清单，删除双孤儿并建立 canonical 合同 |
| `A2` | 计划 A / T2 | `A1` | 消费 canonical 合同，删除 `workflow`、迁移 TDD 信号并锁定 contractHash 影响 |
| `A3` | 计划 A / T3 | `A1` | 消费 canonical path parser，修正 `writePaths` 分类和 SKILL 文法 |
| `A4` | 计划 A / T4 | `A-ENV` | 模型候选清单只依赖独立的 model-selection 模块；host 判定是统一停止条件前置 |
| `A5` | 计划 A / T5 | `A-ENV` | execution contract 与既有 grant fixture 独立；消费统一的 host 停止条件 |
| `A6` | 计划 A / T13 | `A2` | 必须在删除 `workflow` 后的字段面上做 branch probe 与方案决策 |
| `A-ACC` | 计划 A / A-ACC | `A0,A1,A2,A3,A4,A5,A6` | 汇总 A 全部代码、探索和机械门禁产物；不依赖 live mutation |
| `B6` | v2 / T6 | `A-ACC` | A 完成后再统一 workspace 词表，避免跨批次状态契约漂移 |
| `B7` | v2 / T7 | `A-ACC` | A 完成后再调整 terminal proof 绑定，避免与孤儿守卫、canonical 入口冲突 |
| `B8` | v2 / T8 | `A-ACC` | A 完成后再扩展 workspace Git 错误透传；共享 contract test 由资源锁保护 |
| `B-ACC` | B 批次验收 | `B6,B7,B8` | 分别验收状态词表、proof 绑定、Git 诊断；产出 B 验收记录 |
| `C9` | v2 / T9 | `B-ACC` | 严格按 A→B→C 阶段执行；放开声明式 cwd 但保留目录性校验 |
| `C10` | v2 / T10 | `B-ACC` | 只修改既有测试期望，消费已确认的 `c35c596` 删除决策 |
| `C11` | v2 / T11 | `B-ACC` | 只读归因文档；不得修改 compat 生产代码与测试 |
| `C12` | v2 / T12 | `B-ACC` | 只修改测试时序参数；全量测试资源独占 |
| `C-ACC` | v2 / T14 修订版 | `C9,C10,C11,C12` | 三组验收：确定性本地套件、环境依赖套件、只读现场观察；不要求已知失败的全量 `npm test` 伪造 exit 0 |
| `C13` | 后续测试卫生收尾 | `C-ACC` | 迁移剩余旧 workflow contract fixtures；不恢复 production workflow，workspace suite 需恢复 36/36 |
| `E-PI` | 后续真实 Pi lane 验收 | `C13` | 在临时、可终止环境中验证真实 Pi 普通 RPC/attention lane；不能连接旧 host 或 live coordinator |
| `L-ORPHAN` | 后续 lifecycle 接线诊断 | `C13` | 只读确认 durable-run-registry/coordinator-process owner、入口与删除/接线建议 |
| `D-AUDIT` | 后续历史 proof debt 审计 | `C13` | 只读消费 P-SNAPSHOT 快照，按 provenance 分类历史 debt，不执行 mutation |
| `D-PROVENANCE` | 历史 debt 身份链核验 | `D-AUDIT` | 只读比对快照与权威 session/receipt 事件；逐类证明或否证 public 入口、owner、资源顺序，不以 reason 或缺失 records 推断身份 |
| `D-INTERFACE-DESIGN` | proof debt 处置接口契约设计 | `D-PROVENANCE` | 分开 proof debt 与 workspace release；设计单项授权、durable audit、幂等和中断恢复形状，不在探索中改生产 |
| `E-PI-ISOLATION` | 真实 Pi attention 测试隔离探索 | `E-PI` | 设计独立 cwd/state root 和进程组回收；真实 lane 不可结束时保留环境受限 |
| `L-ORPHAN-WIRING` | lifecycle orphan 归属方案 | `L-ORPHAN` | 两个无 importer 模块分别确认 owner/entry；接线或删除须单独 TDD，不靠 allowlist 声明 |
| `H-PI-1` | 测试专用进程组 launcher | `E-PI-ISOLATION` | 消费隔离方案的进程组回收契约；先以 fake parent/child 实测，不运行真实 Pi |
| `H-PI-2` | 真实 `worktree:true` Host E2E | `H-PI-1` | 复用 `test/pi-subagents-project-workflow.integration.mjs` 的真实 Pi Host；child commit 后由 production integration queue 完成 admission/publish/proof/release，不新增 grant 探针 |
| `BUG-PRESERVE-REASON` | Root Broker preserve 参数修复 | `L-ORPHAN-WIRING` | 只改 protocol/test 声明路径；先记录 bug、RED，再最小 GREEN；当前被 protected-path dirty 门禁阻塞 |
| `L-REGISTRY-ENTRY` | durable registry 生产入口定位 | `L-ORPHAN-WIRING` | 只读定位 Host composition、权威 inventory 事实与实际接线所需的最窄边界；当前 blocked-unknown |

| `D-CLEANUP-RECHECK` | cleanup 安全门复核 | `D-INTERFACE-DESIGN,E-PI-ISOLATION,L-ORPHAN-WIRING` | 只读核对 provenance、接口与 transport 证据；缺任一前置则保持 blocked |
| `D-CLEANUP` | 历史 proof debt 处置 | `D-CLEANUP-RECHECK` | 单独明确授权门；只在复核通过且有合法 typed 实现后允许 mutation，默认 blocked |

### Waves 与并行规则

- **Wave 0：** `P-EVIDENCE`（已完成，可跳过）。
- **Wave 1：** `P-SNAPSHOT-CONTRACT`，确认生产目录与 outbox schema。
- **Wave 2：** `P-SNAPSHOT`，按 Wave 1 契约形成快照。
- **Wave 3：** `P-HARNESS`，在临时目录构造并销毁真实测试环境；没有 harness 验收记录不得派发 `A-ENV`。
- **Wave 4：** `A-ENV`。
- **Wave 5：** `A0`。
- **Wave 6：** `A1`、`A4`、`A5`。A1 只等待 A0；A4/A5 只等待 A-ENV，因此三者均可在各自前驱完成后进入 ready set。A4 无共享资源；A5 持有 `extension-ts` 与 `execution-contract-test`。
- **Wave 7：** `A2`、`A3`。二者共享 `dispatch-ir` 与 `skill-md`，必须由资源锁串行；A2 还与 A5 共享 `extension-ts`，若 A5 尚未完成则由锁等待，不新增虚假的 DAG 边。
- **Wave 8：** `A6`，等待 A2；A-ACC 仍按显式 Deps 等待 A0–A6 全部完成，不增加隐式依赖。
- **Wave 9：** `A-ACC`。
- **Wave 10：** `B6`、`B7`、`B8`。B6/B8 可同时进入 ready set，但共同消费 `managed-workspace-contract-test` 锁，执行器必须串行消费该锁；B7 不与二者共享写文件，可并行。
- **Wave 11：** `B-ACC`。
- **Wave 12：** `C9`、`C10`、`C11`、`C12`。C12 持有 `full-test-suite`，其他三个节点不得占用该资源；C9/C10/C11 之间无真实 WritePaths 竞争，可并行。
- **Wave 13：** `C-ACC`。
- **Wave 14：** `C13`（测试卫生收尾，不改 production）。
- **Wave 15：** `E-PI`、`L-ORPHAN`、`D-AUDIT`（互不共享 WritePaths，可并行；E-PI 真实 lane 必须有进程组 timeout）。
- **Wave 16：** `D-PROVENANCE`、`E-PI-ISOLATION`、`L-ORPHAN-WIRING`，三个只读探索可并行。
- **Wave 17：** `D-INTERFACE-DESIGN`，只消费已核验的 debt 身份链；若 D-PROVENANCE 不能证明 production 可达，只交付 fail-closed 候选契约和缺失证据，不启动实现。
- **Wave 18：** `D-CLEANUP-RECHECK`，已执行的只读复核保持 blocked；`H-PI-1` 与 `L-REGISTRY-ENTRY` 两项写路径不相交，可并行。
- **Wave 19：** `H-PI-2` 复用真实 Pi Host project-workflow fixture，待 `PI_REAL_BIN` 可用后运行一次窄 `worktree:true` child commit→queue→proof→release 验收；不得运行 attention lane 或连接 live coordinator。`BUG-PRESERVE-REASON` 在 protected-path dirty 门禁解除后按 TDD 独立执行；`D-CLEANUP` 保持 blocked。

**关键路径：** `P-EVIDENCE → P-SNAPSHOT-CONTRACT → P-SNAPSHOT → P-HARNESS → A-ENV → A0 → A1 → A2 → A6 → A-ACC → B6/B7/B8 → B-ACC → C9/C10/C11/C12 → C-ACC → C13 → D-AUDIT → D-PROVENANCE → D-INTERFACE-DESIGN → D-CLEANUP-RECHECK → D-CLEANUP [授权]`；E-PI-ISOLATION 与 L-ORPHAN-WIRING 独立完成后才允许 D-CLEANUP-RECHECK。

## 资源锁登记

| Resource | 竞争节点 | 并发上限 | 保护对象 |
|---|---|---:|---|
| `dispatch-ir` | `A1`、`A2`、`A3` | 1 | `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts` |
| `extension-ts` | `A2`、`A5` | 1 | `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` |
| `skill-md` | `A2`、`A3` | 1 | `skill-overrides/subagent-dispatch/SKILL.md` |
| `execution-contract-test` | `A5` | 1 | `test/subagent-execution-contract.test.mjs` |
| `managed-workspace-contract-test` | `B6`、`B8` | 1 | `test/managed-workspace-contract.test.mjs` |
| `root-broker` | `B7` | 1 | `root-broker-server.ts` 与 proof runtime 交界 |
| `full-test-suite` | `C12`、`C-ACC` | 1 | `npm test` 与全量/环境套件的独占执行 |
| `plan-a-acceptance` | `A-ACC` | 1 | 计划 A 定向套件与 typecheck |

资源锁不是隐式约束：派发请求的 `Resources` 字段必须逐字声明表中对应资源。任务之间有 DAG 边时，即使资源不同也必须等依赖完成；没有 DAG 边但资源冲突时，调度器只等待锁，不追加虚假依赖。

## Canonical 派发节点

以下每个节点都是一个可独立派发的最小单元。`Source` 指向详细实现步骤；执行者必须读取对应原文，不得只依据本表的摘要猜测实现。

### Task P-EVIDENCE：固化并独立核验调查证据

**Deps：** `none`

**WritePaths：**
- `docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/**`

**Resources：** `evidence-recovery`（最多 1 个并发）

**Dispatch：** 已完成节点；若目录与独立重放结果存在，跳过派发，仅消费其验收证据。

**Source：** 已恢复目录的 `README.md`、调查报告 A–G、恢复脚本；恢复方法为按 session JSONL 中成功 toolResult 门控后的 write/edit 顺序重放。

**Produces：** 9 份调查产物、README、恢复脚本与完整性对照。7 份 write/edit 型报告必须满足逐字节重放一致；D 的 Markdown/CSV 明确标为 live 重跑快照，不宣称原字节恢复。

**验收标准：**
- [ ] 恢复目录存在 8 份 Markdown、1 份 CSV、README 与 `_scripts/`。
- [ ] 原始 session JSONL 只读；成功调用重放的 `oldText` mismatch 为 0；被拒绝 tool call 不进入重放。
- [ ] G 报告与独立重放副本逐字节一致；C 的 schema rejected edit 被明确跳过。
- [ ] 不读取、不输出凭据；不修改源码、测试、live worktree 或配置。

### Task P-SNAPSHOT-CONTRACT：确认快照对象的生产契约

**Deps：** `P-EVIDENCE`（理由：快照规则必须建立在已固化调查证据和当前源码契约之上）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/P-SNAPSHOT-CONTRACT.md`

**Resources：** `live-scene-readonly`（最多 1 个并发；只读检查，与 P-SNAPSHOT 不并行）

**Dispatch：** generic 只读契约探针；禁止写入 live 现场、禁止创建临时 production fixture、禁止调用 supervisor。

**Source：** `packages/pi-subagents-enhanced/src/workspace/ledger.ts` 的 `list/listScoped/ensureDirectory` 实现；`packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts` 的 `State`、`read()` 与 `empty()`；四个 partition 的当前只读目录布局。

**Produces：** 一份可执行快照契约，分别确认 `records/` 缺失是可选稀疏组件还是必需结构；确认 `terminal-proofs.json` 的安全摘要应记录为数组/对象长度而非假设数字字段；确认 state root 与 coordinator 元数据可读取。

**验收标准：**
- [ ] 只读源码确认 `records/` 缺失时生产 `list/listScoped` 的实际行为，不能仅凭目录名推断。
- [ ] 只读确认 outbox 顶层 schema：`pending` 是数组、`receipts/debts` 是对象；报告记录长度（`pendingCount`、`receiptCount`、`debtCount`）而不是输出内容或把字段当数字。
- [ ] 四个 partition 的目录类型与缺失项逐项记录；缺失目录不能静默等同于 0，必须由源码契约决定后续是 `absent / uninitialized` 继续还是 No-Go。
- [ ] 报告仅写入本节点 WritePaths；不输出 runId、proofId、token、绝对敏感路径或凭据；不修改任何现场。

### Task P-SNAPSHOT：只读快照 live 现场

**Deps：** `P-EVIDENCE`、`P-SNAPSHOT-CONTRACT`（理由：先固定证据时点，再消费生产契约解释稀疏目录和 outbox 摘要）

**WritePaths：**
- `var/snapshots/2026-09-23-pre-remediation/**`
- `docs/plans/records/2026-09-23-runtime-remediation/P-SNAPSHOT.md`

**Resources：** `live-scene-readonly`（最多 1 个并发）

**Dispatch：** generic 只读/快照任务；不得使用 worktree，不得执行 raw git worktree mutation。

**Source：** 总纲 §2 步骤 2，结合 `P-SNAPSHOT-CONTRACT` 的实际结论。**源 state root 固定为 `/Users/leshi.zhy/pi-config/var/workspaces`，四个目标 partition 位于该目录的 `repositories/<partition-id>/`；绝不可在 `/Users/leshi.zhy/new-api-account-pool` 仓库目录下寻找 partition。**快照各 partition 的 `records/`、`integration-queue/`、`terminal-proof-outbox/`；另从 `/Users/leshi.zhy/new-api-account-pool/.git/.pi-coordinator/coordinator.json` 快照 root coordinator，并从该 root repository 读取 worktree list。复制前通过内存脚本校验 coordinator 的 `canonicalStateRoot` 与当前 `PI_CODING_WORKSPACE_DIR` 的 realpath 均等于上述 state root、coordinator 的 `storageRepositoryId` 是四个指定 partition 之一；只报告布尔结果，不输出元数据内容。partition 内不要求存在 coordinator.json。

**Produces：** 可与重启后现场对比的快照和实际命令输出记录。

**验收标准：**
- [ ] 先验证 state-root/coordinator/env 三方身份一致及四个指定 partition 的实际源路径；若一致，从 `/Users/leshi.zhy/pi-config/var/workspaces/repositories/<partition-id>/` 逐项处理：存在且为目录则只读复制；`records/` 缺失则在 manifest/报告记录 `absent`，不创建 live 目录、不伪造空目录，也不把 records 数量记为 0；存在但类型错误、无权限读取、JSON 损坏或复制期间发生变化则停止并报告。
- [ ] 单独复制 root coordinator.json 并记录“存在 / 普通文件 / JSON 可解析”，从 root repository 只读生成 worktree list；记录 queue state/admissionGeneration、proof outbox 的 `pendingCount`/`receiptCount`/`debtCount`、records 目录状态和 worktree 数量。
- [ ] 不因 partition 内缺失 coordinator.json 阻塞；root coordinator 缺失、类型错误、JSON 不可解析或 worktree list 无法执行时才按来源未证实 / No-Go 停止。
- [ ] 快照目录与记录文件存在；未执行清理、修复、提交或 coordinator mutation。

### Task P-HARNESS：构造隔离真实测试环境

**Deps：** `P-SNAPSHOT`（理由：先保存 live 基线，再构造与 live 完全隔离的临时环境；旧 host 重启不是后续 worktree 测试的有效前置）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/P-HARNESS.md`

**Resources：** `isolated-runtime-harness`（最多 1 个并发）

**Dispatch：** generic 只读/测试环境探针；在临时目录创建并在 finally 中销毁 origin repo、state root、coordinator socket、Root Broker registry 和真实 Git worktree。不得触碰 live `var/workspaces/`，不得重启用户 host。

**Source：** 复用既有真实 harness：`test/subagent-auto-integration-real-git.integration.mjs` 的 `fixture()`、`test/managed-workspace-recovery-rebind.integration.mjs` 的 coordinator fixture、`test/subagent-runtime-root-broker-startup.integration.mjs` 的 root broker startup 断言。不得另造绕过 production 入口的假目录模拟。

**Produces：** 隔离环境能力报告：临时 origin/state/socket 存在性、真实 coordinator listen/connect、Root Broker bind/close、至少一次真实 managed workspace allocate/bind/queue/proof 观测、cleanup 结果；敏感路径只记录“临时目录已创建/已销毁”，不输出具体路径、token 或 session identity。

**验收标准：**
- [ ] 测试只在 `mkdtemp` 临时根下创建 origin/state/socket/worktree；live state root、live queue、遗留 worktree 和 root host 均未读写。
- [ ] 通过真实公开入口启动 coordinator、连接 client、创建真实 Git worktree，并完成最小 lifecycle 观测；不能只构造普通对象 stub。
- [ ] coordinator/Root Broker 在 `finally` 中关闭并删除临时根；删除后 `test -e` 为 false；清理失败必须报告具体阶段，不得宣称 harness 完成。
- [ ] 报告记录命令/测试名、实际 exit code、资源生命周期和限制；若 root broker 接线依赖当前 Host API 无法在隔离进程复现，标记 `环境受限未验证`，不得伪造 `full`。
- [ ] 不重启 `~/new-api-account-pool` host，不修改用户会话，不把 live 快照数据作为临时 harness 验收断言。

### Task A-ENV：执行宿主兼容性探针

**Deps：** `P-HARNESS`（理由：control-plane 能力必须在隔离 harness 上实测，不能依赖旧 host 重启）

**WritePaths：**
- `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md`

**Resources：** `none`

**Dispatch：** coding/documentation 任务；对应详细计划 A 的 T-ENV。

**Source：** `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md` 的 `Task T-ENV` 全部步骤；步骤 2 的 probe target 必须来自 P-HARNESS，不能对 live root host 发送 steer。

**Produces：** `full` 或 `degraded` 的宿主能力判定；若 degraded，产出后续任务使用的降级停止条件。

**验收标准：**
- [ ] AuthorityStore 注入、宿主启动时间、runtime mtime 与 control-plane 最小探针均有原始输出。
- [ ] 明确列出受影响任务；降级时禁止依赖 `contact_supervisor`，改为记录阻塞点后结束。
- [ ] 只读探针无 live 现场副作用；只回写本计划的探针结论。

### Task A0：孤儿模块守卫

**Deps：** `A-ENV`（理由：消费宿主能力判定与停止条件）

**WritePaths：**
- `test/package-orphan-export-guard.test.mjs`

**Resources：** `none`

**Dispatch：** coding；详细实现见计划 A `Task 0`。

**Source：** 计划 A `Task 0` 的 allowlist 守卫、受保护路径步骤 0、临时副本负向自检与 package 回归。

**Produces：** 可识别孤儿模块、腐化 allowlist 与生产 importer 缺失的测试守卫。

**验收标准：**
- [ ] 测试先取得断言级 RED，再实现守卫并 GREEN。
- [ ] allowlist 每项有非空中文理由；负向自检在临时副本执行并清理。
- [ ] 计划 A 已知的 3 个 lifecycle allowlist 项目保留，待 A1 删除的两个孤儿条目可被机械检出。

### Task A1：canonical 派发合同与双孤儿删除

**Deps：** `A0`（理由：删除文件必须由守卫和 allowlist 共同验收）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts`（删除）
- `packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts`（删除）
- `test/package-orphan-export-guard.test.mjs`
- `test/subagent-dispatch-validation-errors.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-ir-coercion.test.mjs`
- `test/subagent-runtime-resource-isolation.test.mjs`
- `test/pi-subagents-runtime.integration.mjs`
- `test/subagent-dispatch-readonly-writepaths.test.mjs`

**Resources：** `dispatch-ir`（最多 1 个并发）

**Dispatch：** coding；详细实现见计划 A `Task 1`。

**Source：** 计划 A `Task 1` 全部步骤。特别保留既有空 `writePaths` 测试，只迁移 import；不得用新测试替代原回归。

**Produces：** canonical `dispatch-ir.ts` 单一入口；空 `writePaths` 显式只读语义；unknown/missing 字段的完整 shape 提示；双孤儿删除及守卫更新。

**验收标准：**
- [ ] `writePaths: []` 通过；旧测试保留；两个孤儿不存在且全仓无深层引用。
- [ ] unknown/missing 两类错误均含完整对象模板。
- [ ] `npm run typecheck` 与 A1 定向回归通过。

### Task A2：删除 workflow、迁移 TDD 信号并锁定 contractHash 影响

**Deps：** `A1`（理由：canonical renderer 收敛后才可安全删除 workflow）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `pi/agents/delegate.md`
- `pi/agents/executor.md`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-workflow-removed.test.mjs`
- `test/subagent-dispatch-contract-hash-compat.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`
- `test/subagent-generic-prompt-contract.test.mjs`
- `test/subagent-generic-prompt-contract-security.test.mjs`

**Resources：** `dispatch-ir`、`extension-ts`、`skill-md`（各最多 1 个并发）

**Dispatch：** coding；详细实现见计划 A `Task 2`。

**Source：** 计划 A `Task 2` 全部步骤。保留 delegate/executor 的 contact_supervisor、need_decision、不得委派、证据优先和未验证不得声明完成语义；仓库外 SKILL 副本只条件化读取。

**Produces：** 不含 `workflow` 的合同、profile/SKILL TDD 信号迁移、旧 workflow contractHash record 可加载测试与变更前现场快照钉。

**验收标准：**
- [ ] `workflow` 从 schema、类型、renderer、测试、文案与残留扫描中清零。
- [ ] 旧 schema 生成的持久化 record 可加载，`requestHash` 校验不被放宽；跨变更点 hash 比较风险明确记录。
- [ ] 不新增 TDD 字符串机械门禁；TDD 机械强制问题由 A6 探索记录。

### Task A3：writePaths 文法与 SKILL 文案修正

**Deps：** `A1`（理由：path parser 只保留 canonical 实现）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `test/subagent-dispatch-writepaths-grammar.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`

**Resources：** `dispatch-ir`、`skill-md`（各最多 1 个并发）

**Dispatch：** coding；详细实现见计划 A `Task 3`。

**Source：** 计划 A `Task 3` 全部步骤；优先处理 `/**` 分支可达性，补 NUL、双 glob、尾随字符、双 slash 等差分用例；SKILL 使用全文句子锚点。

**Produces：** path 文法分类可行动错误、与实现一致的 SKILL 文案和边界测试。

**验收标准：**
- [ ] `/**` 不再被绝对路径分支提前吞掉；全部边界样本断言稳定。
- [ ] 文案与 canonical parser 一致；无错误尾随 `/` 教学。
- [ ] 相关测试与 typecheck 通过。

### Task A4：模型不可用错误返回候选清单与唯一建议

**Deps：** `A-ENV`（理由：统一执行前置；代码本身不消费其他 A 产物）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`
- `test/subagent-model-candidates.test.mjs`

**Resources：** `none`

**Dispatch：** coding；详细实现见计划 A `Task 4`。

**Source：** 计划 A `Task 4` 全部步骤；保持四种 source 与匹配控制流不变，错误 detail 提供 declared/available/suggestion，禁止 alias、substring、模糊匹配。

**Produces：** `ModelSelectionError.details` 正式结构、可用候选清单和唯一建议。

**验收标准：**
- [ ] bare/qualified/blocked/ambiguous 四类测试断言 detail 与 message。
- [ ] 成功路径返回 `{ model, source, warnings? }` 语义逐位不变。
- [ ] 定向测试与 typecheck 通过。

### Task A5：本地 preflight 使用独立错误码

**Deps：** `A-ENV`（理由：统一停止条件可用性前置）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts`
- `test/subagent-execution-contract.test.mjs`
- `test/subagent-dispatch-cwd-taxonomy.test.mjs`

**Resources：** `extension-ts`、`execution-contract-test`（各最多 1 个并发）

**Dispatch：** coding；详细实现见计划 A `Task 5`。

**Source：** 计划 A `Task 5` 全部步骤。必须复用既有六字段 `HostExecutionGrant` 构造，不得凭空制造 fixture；确认 `failure()` 第三参是 cause，正式设计 detail。

**Produces：** state-root cwd 拒绝的 `INVALID_EXECUTION_CWD` 与 detail；不含 operation，避免被 extension catch 误判为 RPC failure。

**验收标准：**
- [ ] state-root fixture 真实通过 grant 校验后才进入目标分支。
- [ ] 原有 failure message 主体不变；新错误不含 operation。
- [ ] execution contract、cwd taxonomy、共享回归和 typecheck 通过。

### Task A6：coding/generic 分支可发现性探索

**Deps：** `A2`（理由：必须消费删除 workflow 后的实际 12 字段面）

**WritePaths：**
- `docs/research/2026-09-23-dispatch-branch-discoverability.md`
- `scripts/probes/dispatch-branch-probe.ts`

**Resources：** `none`

**Dispatch：** generic/只读探索任务；不得修改生产代码。

**Source：** 计划 A `Task 13` 全部步骤。必须运行无副作用 route probe，覆盖至少 8 类输入并记录实际错误码/分支，不得只静态阅读。

**Produces：** 至少 3 个候选方案、provider 兼容性矩阵、精确推荐接口契约、TDD 强制层级决策输入。

**验收标准：**
- [ ] 根级 union provider 约束有原始证据；8 类样本都有实际路由结果和复现命令。
- [ ] 每个方案含可见性、误判率、错误码、实现面和历史拒绝量影响。
- [ ] 文档明确推荐方案与待用户裁决点；无生产代码改动。

### Task A-ACC：计划 A 验收

**Deps：** `A0`、`A1`、`A2`、`A3`、`A4`、`A5`、`A6`（理由：验收必须同时消费守卫、合同、模型、preflight、path 与探索产物）

**WritePaths：**
- `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md`

**Resources：** `plan-a-acceptance`（独占）

**Dispatch：** coding/验收任务；详细实现见计划 A `Task A-ACC`。

**Source：** 计划 A `Task A-ACC` 全部步骤；A-ACC 是唯一可把 A 阶段标为完成的节点。

**Produces：** A 阶段定向测试、typecheck、机械门禁、探针和环境受限结果的验收记录。

**验收标准：**
- [ ] 定向套件连续两次通过，`npm run verify:subagents-enhanced` 通过。
- [ ] 机械自检校验任务字段、资源、占位词、步骤 0 和共享 WritePaths。
- [ ] `npm run test:subagents` 环境受限时如实记录，不通过改环境制造 PASS。
- [ ] live 现场只读观察与快照对照通过；不清理既有现场。

### Task B6：workspace 状态词表单一权威化

**Deps：** `A-ACC`（理由：严格执行 A→B，消费 A 的稳定合同与门禁）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`
- `test/managed-workspace-contract.test.mjs`
- `test/managed-workspace-state-vocabulary.test.mjs`

**Resources：** `managed-workspace-contract-test`（最多 1 个并发）

**Dispatch：** coding；详细实现见 v2 `Task 6`，并应用本节点对 `Resources` 与步骤 0 的修订。

**Source：** v2 `Task 6` 全部步骤。统一从 ledger 导出 `MANAGED_WORKSPACE_STATES`、`ManagedWorkspaceState` 与 `allowedActionsFor`；service 错误 detail 必须含 state、allowedActions、nextAction；tool 文案引用权威词表。

**Produces：** 7 个合法 ledger state 的单一权威词表与 fail-closed action 映射。

**验收标准：**
- [ ] 先盘点全部状态词使用点，再以断言级 RED 实现。
- [ ] 非 ledger 词不再被当作 state；所有状态错误可行动化。
- [ ] 状态词表专测、workspace 回归和 typecheck 通过。

### Task B7：无 managed workspace 的 run 不再产生 proof debt

**Deps：** `A-ACC`（理由：严格执行 A→B；proof 分类消费 A 阶段的 canonical runtime 基线）

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts`
- `test/subagent-proof-binding-classification.test.mjs`

**Resources：** `root-broker`（最多 1 个并发）

**Dispatch：** coding；详细实现见 v2 `Task 7`，并应用本节点对 hunk 门禁、RED、proof 字段集与导出位置的修订。

**Source：** v2 `Task 7` 全部步骤，并按 canonical 目录边界修订实现位置。`classifyTerminalProofBinding` 与其类型/辅助函数必须放入新建的 `packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts`；`extensions/subagent-runtime.ts` 只保留 Host 入口绑定与依赖注入。`readLedger` 在函数内按 runId 过滤；`buildTerminalProof` 无参；unknown fail closed 为 debt，合法空绑定为 not-applicable。

**Produces：** 无 workspace 的合法普通 run 不再记录 debt；非法/不可信绑定仍 fail closed。

**验收标准：**
- [ ] `worktree:false` 空绑定得到 `not-applicable`，debt/enqueue 均为 0。
- [ ] 单绑定投递的 proof 字段集保持 7 个既有身份字段，不把 workspaceId 塞入 proof。
- [ ] 多绑定、非法数组、ledger/transport 异常按矩阵分类；未知状态仍 debt。
- [ ] patch/context hunk 门禁通过；proof 分类专测、broker 回归和 typecheck 通过。

### Task B8：Git 失败原因分类与脱敏透传

**Deps：** `A-ACC`（理由：严格执行 A→B；共享 workspace 合同应在 A 阶段稳定后扩展）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`
- `test/managed-workspace-git-diagnostics.test.mjs`
- `test/managed-workspace-contract.test.mjs`

**Resources：** `managed-workspace-contract-test`（最多 1 个并发）

**Dispatch：** coding；详细实现见 v2 `Task 8`，并应用本节点的 UTF-8、porcelain、args 脱敏修订。

**Source：** v2 `Task 8` 全部步骤。必须实现正式 `GitFailureDetail`、分类优先级、失败时只读 porcelain 补采、路径/token 脱敏；`truncateUtf8` 使用 `Buffer.byteLength` 预算。

**Produces：** `MANAGED_WORKSPACE_GIT` 的 category/categories/stderr/porcelain/args 诊断详情。

**验收标准：**
- [ ] stderr-only 不猜 modified/untracked；porcelain 正确区分 dirty、untracked、ignored、submodule、unmerged。
- [ ] rename、quoted path、含空格路径、submodule 路径均有测试；`args` 与正文同样脱敏。
- [ ] stderr/porcelain 均不超过 512 UTF-8 bytes；unknown 仍保留 bounded stderr。
- [ ] B8 与 B6 共享测试文件只能经 `managed-workspace-contract-test` 锁串行写；专测、workspace 回归和 typecheck 通过。

### Task B-ACC：计划 B 验收

**Deps：** `B6`、`B7`、`B8`（理由：三项 workspace/proof 产物必须分别 GREEN 后才能汇总）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/B-ACC.md`

**Resources：** `plan-b-acceptance`（独占）

**Dispatch：** coding/验收任务；验收记录由该节点写入独立记录，不修改 v2 历史账本。

**Source：** 本文 B6/B7/B8 的验收标准与 v2 对应任务的定向回归清单。

**Produces：** B 阶段验收记录、已通过的定向命令、未验证环境项及未清理债务说明。

**验收标准：**
- [ ] B6、B7、B8 的专测和 typecheck 全部通过。
- [ ] `managed-workspace-contract-test` 资源使用记录无重叠写入。
- [ ] 既有 492 条 debt 不清理；记录为“阻止新增误判”，不宣称历史债务已处置。
- [ ] 不把 live 现场数据当作测试断言；只记录只读观察结果。

### Task C9：放开声明式 bash cwd 的工作区范围限制

**Deps：** `B-ACC`（理由：严格执行 A→B→C，C 阶段统一从 B 的稳定 workspace 错误面开始）

**WritePaths：**
- `src/bash-cwd/policy.ts`
- `src/bash-cwd/extension.ts`
- `pi/extensions/bash-cwd.ts`
- `test/bash-cwd-policy.test.mjs`
- `test/bash-cwd-extension.test.mjs`

**Resources：** `none`

**Dispatch：** coding；详细实现见 v2 `Task 9`。

**Source：** v2 `Task 9` 全部步骤。移除声明式 cwd 的 workspace containment 限制，保留存在性、目录性、realpath、相对路径解析与 symlink 行为；导出 `isWithinWorkspace` 供真正需要 containment 的调用方使用。

**Produces：** 工作区外存在目录可作为声明式 cwd，同时保留目录与存在性错误。

**验收标准：**
- [ ] 工作区外目录、缺失目录、文件、空参数、相对路径、symlink 六类用例均通过。
- [ ] 生产代码、测试中旧的“必须在工作区内”文案清零；文档命中逐条记录。
- [ ] bash cwd 定向测试、package guard、typecheck 通过。

### Task C10：init-pi 测试期望与 external-review 删除决策对齐

**Deps：** `B-ACC`（理由：严格执行 A→B→C；该节点只处理 HEAD 既有测试与 c35c596 删除决策）

**WritePaths：**
- `test/init-pi.test.mjs`
- `test/external-review-config-home.test.mjs`

**Resources：** `none`

**Dispatch：** coding；详细实现见 v2 `Task 10`。

**Source：** v2 `Task 10` 全部步骤。先确认 c35c596 与 bug 文档的删除意图；只删除对已删目录的引用，保留其他断言，必要时将该目录断言改为反向断言；不得修改 init-pi.sh 或恢复目录。

**Produces：** 与当前仓库删除决策一致的两个测试文件。

**验收标准：**
- [ ] 删除意图证据明确；若不明确则停止，不自行恢复目录。
- [ ] 两个测试文件通过；保留断言数量与语义有清单对照。
- [ ] HEAD 导出复现结果记录为既有缺陷归因，不把测试修复误报为 production 修复。

### Task C11：compat supervisor target 行为归因

**Deps：** `B-ACC`（理由：严格执行 A→B→C；只读归因不修改 runtime，但统一在 B 后执行以固定观察基线）

**WritePaths：**
- `docs/bugs/2026-09-22-compat-local-package-source-supervisor-target-resolves.md`

**Resources：** `none`

**Dispatch：** generic 只读归因；不得修改 production、测试或配置。

**Source：** v2 `Task 11` 全部步骤。工作树、HEAD 导出、`env -i` 三组复现；定位 `SUPERVISOR_TARGET_UNAVAILABLE` 的首个偏离点；按三分法分类，证据不足则归为来源未证实。

**Produces：** 含现象、复现、首个偏离点、完整调用链、分类证据、至少两个待裁决修复方向的 bug 文档。

**验收标准：**
- [ ] 三组环境复现输出来自实际运行，不直接复制主 agent 数字。
- [ ] 文档结构机械检查全部通过；无生产代码或测试改动。
- [ ] 证据不足时 fail closed，不以测试失败单独证明 production 可达。

### Task C12：测试时序参数修正

**Deps：** `B-ACC`（理由：严格执行 A→B→C；全量测试资源需要作为 C 阶段最后的实现节点独占）

**WritePaths：**
- `test/root-subagent-broker.test.mjs`
- `test/durable-lifecycle.test.mjs`

**Resources：** `full-test-suite`（独占）

**Dispatch：** coding；详细实现见 v2 `Task 12`。

**Source：** v2 `Task 12` 全部步骤。只调整测试传入的 `timeoutMs`/`staleLockMs`，不得放大 production deadline；逐点判断 9 处 timeoutMs，不得一刀切。

**Produces：** 对全量负载不敏感的测试时序参数，production 代码零改动。

**验收标准：**
- [ ] 两个目标文件各单独运行 3 次通过。
- [ ] 全量 `npm test` 连跑 2 次；记录所有已知失败与 `BROKER_TIMEOUT`，不把环境/既有失败混入目标结论。
- [ ] 确认 production 目录无本节点新增改动。

### Task C-ACC：统一终点验收

**Deps：** `C9`、`C10`、`C11`、`C12`（理由：四个 C 节点的代码、测试、归因和时序产物必须分组验收）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/C-ACC.md`

**Resources：** `full-test-suite`（独占）

**Dispatch：** coding/验收任务；不得修改生产代码，不得清理 live 现场。

**Source：** 本文 C9–C12 验收标准；替代 v2 T14 的“全量 exit=0”单一判定。

**Produces：** 跨计划集成验收记录和三组结果：确定性本地套件、环境依赖套件、只读现场观察。

**验收标准：**
- [ ] **确定性本地套件：** A/B/C 相关单测、typecheck、package guard 和可重复定向回归分别按命令运行并记录实际 exit code。
- [ ] **环境依赖套件：** `npm run test:subagents`、真实 Pi lane、外部 SKILL 副本等逐项记录 `通过`、`环境受限未验证` 或真实失败；不得要求已知环境失败伪造 `exit=0`。
- [ ] **只读现场观察：** 对照 `P-SNAPSHOT` 与 P-HARNESS 记录，只读比较 queue、proof outbox、worktree/record 数量；禁止把现场修复当作验收动作。
- [ ] 明确列出 32 条缺陷中已处置、只产出探索、仍延后和来源未证实的条目；未完成项不得打勾为完成。

### Task C13：workflow 合同迁移测试卫生收尾

**Deps：** `C-ACC`（理由：消费 C-ACC 已确认的 4 个 workflow unknown-field 失败清单；只迁移测试 fixture，不改 production contract）

**WritePaths：**
- `test/subagent-managed-worktree.integration.mjs`
- `test/managed-workspace-service.integration.mjs`
- `test/managed-workspace-contract.test.mjs`
- `test/managed-workspace-ledger.integration.mjs`
- `test/managed-workspace-ledger.test.mjs`

**Resources：** `none`

**Dispatch：** coding；只处理已定位的测试卫生残留，不恢复 `workflow` 到 production。

**Source：** C-ACC 的 workspace suite 输出与 C13 任务报告；实际失败文件、行号和旧 fixture 必须先从当前工作树确认。

**Produces：** 与 `dispatch-ir.v1` 当前 schema 一致的 workspace 测试 fixture；workspace 专项套件恢复为确定性全绿，或对非目标失败给出分类记录。

**验收标准：**
- [ ] 先复现并记录 4 个旧 `workflow` unknown-field 失败及文件:行号。
- [ ] 只删除/迁移 dispatch contract fixture 中的 `workflow`；保留 `workflowScript`、`workflowKey`、`parentWorkflowRunId` 等合法 workflow-spawn 生命周期语义。
- [ ] `npm run test:subagent-workspace` 达到 `36/36`，或对剩余非目标失败给出真实分类；不得恢复 production workflow、不得删除无关断言。
- [ ] git diff --check 通过，无 staged 文件，仅修改必要 WritePaths。

### Task E-PI：真实 Pi lane 环境验收

**Deps：** `C13`（理由：先消除已知确定性 workspace 测试卫生残留，再测真实 Pi lane，避免混合两个失败来源）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/E-PI.md`

**Resources：** `pi-real-lane`（最多 1 个并发）

**Dispatch：** generic 只读环境验收；不得重启旧 `new-api-account-pool` host，不得连接其 live coordinator。

**Source：** P-HARNESS、A-ENV、C-ACC 记录；已有真实 Pi 普通 RPC 通过证据与 attention lane 超时证据。

**Produces：** 真实 Pi lane 的通过、真实失败或环境受限结论；若运行长任务，必须使用 process-group wrapper 和总 timeout，确保子进程可回收。

**验收标准：**
- [ ] 只临时设置 `PI_REAL_BIN`，不持久修改环境；仅使用隔离临时 HOME/XDG/TMP/agent/state，证明不会连接仓库 `.git/.pi-coordinator`。
- [ ] 普通真实 Pi RPC 子集和 attention/supervisor-resume 子集分别记录实际 exit/timeout；timeout 不归因生产缺陷。
- [ ] 进程组超时后 TERM→等待→KILL，确认本次测试产生的 Node/Pi/jiti 子树已回收。
- [ ] 报告明确 `full`、`environment-constrained` 或 `source-unverified`，不伪造全量 `npm test` 通过。

### Task L-ORPHAN：lifecycle orphan 归属与接线诊断

**Deps：** `C13`（理由：在确定性测试卫生完成后，单独处理 A0 allowlist 暴露的 lifecycle 接线残余）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/L-ORPHAN.md`

**Resources：** `none`

**Dispatch：** generic 只读归属诊断；不删除、不接线、不修改 allowlist。

**Source：** A0 orphan guard 输出与限定 production roots 的静态/dynamic importer 搜索。

**Produces：** `durable-run-registry.ts` 与 `coordinator-process.ts` 的 owner、production importer、public entry 和后续动作建议。

**验收标准：**
- [ ] 分别报告静态 importer、dynamic importer、package exports、CLI/宿主入口计数；测试/docs/artifact 不算 production importer。
- [ ] 未证实的“宿主外部动态装载”必须标为来源未证实；不得用 allowlist 文本替代证据。
- [ ] 明确保留 allowlist、另立接线任务或删除候选；本节点不执行 mutation。
- [ ] git diff --check 通过，无 staged 文件，仅修改 L-ORPHAN.md。

### Task D-AUDIT：历史 proof debt 只读审计

**Deps：** `C13`（理由：只读消费已冻结 P-SNAPSHOT 与 B7 边界，避免把测试卫生失败混入 debt 分类）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/D-AUDIT.md`

**Resources：** `live-scene-readonly`（最多 1 个并发；优先只消费 P-SNAPSHOT，不读 live）

**Dispatch：** generic 只读聚合审计；不得清理、迁移、重写 debt。

**Source：** P-SNAPSHOT outbox 集合、P1 records 快照、coordinator-proof-outbox schema 与 B7 报告。

**Produces：** 带时点的 pending/receipt/debt/supersession 聚合、reason/category 分类、partition 分布和 provenance 证据。

**验收标准：**
- [ ] 默认将无法证明完整入口/权威身份/事件顺序的 debt 分类为来源未证实，fail closed；不得把 492/529 任何历史数字当当前 live 数。
- [ ] 明确 B7 仅阻止新增错误 debt；本节点不执行任何 mutation。
- [ ] 不输出 proofId、runId、token、完整敏感路径或凭据；git diff --check 通过，无 staged 文件。

### Task D-CLEANUP：历史 proof debt 处置（用户授权门）

**Deps：** `D-AUDIT`、`E-PI`、`L-ORPHAN`（理由：只有完成 provenance 审计、真实 lane 结果和 orphan owner 归属后，才可能设计安全处置）

**WritePaths：**
- `var/workspaces/**`
- `docs/plans/records/2026-09-23-runtime-remediation/D-CLEANUP.md`

**Resources：** `live-state-mutation`（独占）

**Dispatch：** **默认 blocked，不得自动派发**。只有用户另行明确授权 cleanup/recovery mutation，且先有独立 cleanup 计划、幂等测试和审计字段契约时，才可派发。

**Source：** D-AUDIT、E-PI、L-ORPHAN 的实际产物；不得以历史计划自称“已完成”替代当前授权。

**Produces：** 经用户授权的、可审计、可回滚/重试的 debt 处置结果；未授权时只保留 blocked 记录，不修改 live state。

**验收标准：**
- [ ] 未取得用户单独授权时，节点保持 `blocked`，不读取/修改 live state，不清理任何 debt/worktree/queue。
- [ ] 获授权后必须先在临时 fixture 验证 identity、幂等、审计和 fail-closed 行为，再执行最小 mutation。
- [ ] 每次 mutation 记录前后聚合计数、授权依据、失败原因和可重试状态；禁止 bulk rewrite 或 force cleanup。

### Task D-PROVENANCE：历史 proof debt 身份链核验

**Deps：** `D-AUDIT`（理由：消费已冻结快照及 529 条 debt 的聚合基线，不把历史计数当当前 live 数）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/D-PROVENANCE.md`

**Resources：** `live-scene-readonly`（独占，只读快照；默认不读 live）

**Dispatch：** generic 只读调查；只消费 P-SNAPSHOT、权威 session/receipt 的只读记录及 public 入口源码，不执行 workspace/queue/proof mutation。

**Source：** D-AUDIT、P-SNAPSHOT、`coordinator-proof-outbox.ts`、`terminal-proof-binding.ts`、Root Broker 的终态证明入口。对每一种身份匹配必须记载入口、权威 owner、事件先后和与生产事实的差异；只凭相同 reason 或时间邻近不得宣称绑定成立。

**Produces：** 聚合层 provenance 矩阵，区分已证实 production 可达、仅测试/fixture 制造、来源未证实；原始敏感身份仅在内存中比较，不写入报告。

**验收标准：**
- [ ] 只读验证 debt 的入口、owner、session/run/workspace 身份、terminal proof 与资源顺序；无法证明时保留 `unknown`，不把无 record 解释成无 workspace。
- [ ] 记录每类数量、证据来源和最早偏离点；未证实的身份不得纳入可清理集合。
- [ ] 仅读/写本任务声明范围，报告不含 proofId、runId、token、cookie、授权值或敏感绝对路径，不修改 live state。

### Task D-INTERFACE-DESIGN：proof debt 安全处置接口契约

**Deps：** `D-PROVENANCE`（理由：处置目标和身份匹配规则必须消费上游实际 provenance 结果）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/D-INTERFACE-DESIGN.md`

**Resources：** `none`

**Dispatch：** generic 只读接口设计；**不得编码实现或调用 live apply**。明确区分 proof outbox debt 与 workspace release；现有 `applyManagedWorkspaceCleanup` 不能直接用于历史 proof debt。

**Source：** D-PROVENANCE 和 D-CLEANUP 阻断报告；`administration.ts` 的多 action 顺序 release 与 proof outbox 的 `recordDebt/receipt` 现状。

**Produces：** 单项 proof debt 处置的 public/typed 契约草案：权威身份、预期 revision、授权材料、幂等键、durable audit record（先持久化意图，后执行，再记录结果）、中断恢复与失败保留；不承诺跨多个 action 原子回滚。若上游无可证明的清理目标，只给出 blocked 与缺失证据，禁止生产实现。

**验收标准：**
- [ ] 逐项列出类型/函数签名、请求/返回 shape、状态机、权限、重放与失败原子性边界；明确不把多 action 顺序 release 伪装成事务。
- [ ] 临时 fixture 的安全场景清单包含错 owner、错 lease、stale revision、重复 key、写 audit 后崩溃、执行后回执前崩溃；这些是后续 TDD 任务的 RED 规格，不在本任务伪造 GREEN。
- [ ] 不修改 production、测试、live state；若来源未证实，以 `blocked-unknown` 收尾。

### Task E-PI-ISOLATION：真实 Pi attention 隔离方案

**Deps：** `E-PI`（理由：消费普通 RPC 通过与 attention lane 超时、遗留子进程的实际证据）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/E-PI-ISOLATION.md`

**Resources：** `pi-real-lane`（独占）

**Dispatch：** generic 只读方案节点；不得直接重复整个 `test:subagents`，不得在仓库 cwd 上启动可能绑定 live coordinator 的新 Host。

**Source：** E-PI 与窄测诊断结果；现有 `test/pi-subagents-runtime.integration.mjs` 的真实 RPC/attention 用例、`test/subagent-runtime-root-broker-startup.integration.mjs` 的 cwd/state root 配置。

**Produces：** 可复现的隔离测试契约：临时 Git origin/cwd、agent/home/config/state/tmp、process-group timeout、TERM→KILL 与 orphan 检查；若无法证明完全隔离，则输出环境受限与缺口，不运行 attention lane。

**验收标准：**
- [ ] 对普通 RPC 通过证据和 attention 超时分别给出入口与首个不可观察点；不把超时直接判 production 缺陷。
- [ ] 明确 launcher 的进程组清理边界和 cwd/state-root 绑定证据；禁止读取/修改旧 host、live coordinator、`var/workspaces/`。
- [ ] 给出后续实现与测试的精确 WritePaths 和验收命令；本节点仅写报告。

### Task L-ORPHAN-WIRING：两个 lifecycle orphan 的 owner/接线决策

**Deps：** `L-ORPHAN`（理由：消费静态/dynamic importer 诊断；不把 allowlist 理由当作生产接线证据）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/L-ORPHAN-WIRING.md`

**Resources：** `none`

**Dispatch：** generic 只读方案节点；实现接线或删除必须另立 coding 计划，不在本节点直接修改源码。

**Source：** L-ORPHAN 报告、A0 guard、lifecycle batch plans 和 production root 搜索结果。

**Produces：** 每个 orphan 的明确 owner、候选 public/typed 入口、接线/删除/继续保留的可执行下一任务，以及 owner 不确定时的 blocked reason。

**验收标准：**
- [ ] `durable-run-registry.ts` 与 `coordinator-process.ts` 分别给出 owner 和至少一个可验证 production entry 方案；若无方案，明确 blocked/source-unverified。
- [ ] 不把测试 Node spawn、README、handoff、artifact transcript 或 allowlist 文本当 production importer。
- [ ] 明确后续 coding 任务的 WritePaths、TDD RED/GREEN、回归命令和删除/接线安全门；本节点不修改源码/allowlist。
- [ ] 只写报告，git diff check 通过，无 staged 文件。

### Task D-CLEANUP-RECHECK：审计出口与 provenance 复核

**Deps：** `D-INTERFACE-DESIGN`、`E-PI-ISOLATION`、`L-ORPHAN-WIRING`（理由：只在身份链、处置接口、宿主隔离与 owner 方案均有可验证结论后复核；未知保持 blocked）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/D-CLEANUP-RECHECK.md`

**Resources：** `live-scene-readonly`（最多 1 个并发）

**Dispatch：** generic 只读复核；不执行 mutation。

**Source：** D-AUDIT、D-PROVENANCE、D-INTERFACE-DESIGN、E-PI-ISOLATION、L-ORPHAN-WIRING、P-SNAPSHOT。

**Produces：** 对 D-CLEANUP 的阻塞矩阵：哪些仍未知、哪些已有 typed 实现与独立审计证据。接口草案不是实现；仅有设计时结论必须为 `blocked`。

**验收标准：**
- [ ] provenance 仍不能证明时保持 `blocked-unknown`；不得仅因 projection 存在就把历史 debt 自动归为 production 正常。
- [ ] 只有 owner、scope、**已实现并通过 TDD 验证**的 audit/idempotency/retry 接口与用户针对 live mutation 的独立授权全部满足时才给出“可进入 mutation 计划”的结论；接口设计草案不满足此项，本节点不 mutation。
- [ ] 报告写明未处理集合、聚合数量和安全边界，不输出敏感 identity；git diff check 通过。

### Task H-PI-1：测试专用进程组 launcher

**Deps：** `E-PI-ISOLATION`（理由：消费其对 timeout、TERM/KILL、进程组回收的契约；不需要债务接口或 orphan 接线结果）

**WritePaths：**
- `test/helpers/pi-process-group.mjs`
- `test/helpers/pi-process-group.integration.mjs`

**Resources：** `pi-process-group-test`（独占，仅操作本任务 fake 子进程组）

**Dispatch：** coding；仅创建测试专用 helper 与真实 fake parent/child 集成测试，不启动 Pi。

**Source：** `E-PI-ISOLATION.md` §下一步可执行的隔离测试契约、现有 `test/pi-subagents-runtime.integration.mjs` 的 `runRpcUntil` 单进程超时缺口。

**Produces：** 可复用的测试专用 `spawnIsolatedProcessGroup` 与 fake parent/child 的回收证据，供后续 H-PI-2 在隔离 Git origin 中消费。

**Files：**
- Create：`test/helpers/pi-process-group.mjs`（测试专用 launcher，不向 production 导出）
- Create：`test/helpers/pi-process-group.integration.mjs`（fake parent/child、成功退出、TERM 忽略与 KILL 验收）

**接口契约：**
- Consumes：Node `spawn` 的 `{detached:true,stdio:["pipe","pipe","pipe"]}`、`process.kill(-pgid, signal)`；不调用 Pi 或 workspace API。
- Produces：`spawnIsolatedProcessGroup({command,args,cwd,env,input,totalTimeoutMs,termGraceMs,onRecord?})`。返回 `{status,signal,timedOut,records,termination:{termSent,killSent,groupAliveAfterTerm,groupAliveAfterKill}}`；异常/超时也必须完成进程组收敛检查，若仍存活则显式失败且保留诊断证据。只回收本 helper 创建且已核验的 PGID；不得按名称或全局 PID 杀进程。

**验收标准：**
- [ ] 先写 fake Node parent 派生 child 的失败测试；测试首行若需新增导出先断言函数存在，使 RED 为断言级失败，不以 module-not-found 或 TypeError 为 RED。
- [ ] 正常提前退出不发送信号；超时先 TERM，短 grace 后组仍活则 KILL；leader 与 child 均被回收，输出和错误按测试目录的已有策略保留。
- [ ] 非 POSIX/不能证明独立 PGID 时 fail closed，不退化为仅 `child.kill()`；不能误杀外部进程。
- [ ] `node --test test/helpers/pi-process-group.integration.mjs` 与相关 typecheck 通过；本节点**不**启动真实 Pi，不触碰仓库 `.git/.pi-coordinator` 或 live `var/workspaces`。

### Task H-PI-2：隔离临时环境验证真实普通 Pi RPC

**Deps：** `H-PI-1`（理由：消费已通过 fake parent/child 验证的独立进程组 launcher；不运行 attention lane）

**WritePaths：**
- `test/pi-subagents-runtime.integration.mjs`

**Resources：** `pi-real-lane`（最多 1 个并发）

**Dispatch：** coding/test harness；只运行窄普通 RPC 测试，不连接 live coordinator，不修改 production。

**Source：** `E-PI-ISOLATION.md` 的 H-PI-2 契约和 H-PI-1 helper。

**Produces：** 临时 Git origin/cwd/state/agent/HOME/XDG/TMP/session 绑定的普通真实 Pi RPC 验收结果，或明确 `blocked-before-probe`/`environment-constrained`。

**验收标准：**
- [ ] 先以断言级 RED 证明当前普通 RPC fixture 缺少隔离绑定，再最小接线；不把 Host grant 启动错误、timeout 或 module-not-found 当 RED。
- [ ] 普通 Pi RPC 使用临时 cwd/state 与 Host identity，exit 0、terminal complete、process group 无 orphan；不得运行 attention 或整体 `test:subagents`。
- [ ] 不连接仓库 `.git/.pi-coordinator`、旧 host 或 `var/workspaces`；临时资源只在进程组收敛后清理。
- [ ] 失败时记录首个阻塞点和实际 exit/timeout，不把验证失败归为 production bug；git diff check/typecheck/无 staged 结果如实记录。

### Task BUG-PRESERVE-REASON：修复 preserve_integration_debt 的 Root Broker 参数契约

**Deps：** `L-ORPHAN-WIRING`（理由：源码归属和 production composition 已完成只读核对；不依赖历史 debt cleanup 或真实 Pi E2E）

**WritePaths：**
- `docs/bugs/2026-09-28-preserve-integration-debt-reason.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `test/root-subagent-broker-protocol.test.mjs`

**Resources：** `root-broker-protocol`（最多 1 个并发）

**Dispatch：** coding；必须先读取 `/Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md` 和 `writing-good-tests.md`，先写并运行断言级 RED，再做最小 GREEN。代码节点开工前必须检查 `pi/agents/reviewer.md`、`pi/settings.json`、`pi/models.json`、`var/workspaces/`；任何 protected-path dirty 命中立即停止，不读取、回滚或覆盖现场。

**Source：** `docs/bugs/2026-09-28-preserve-integration-debt-reason.md`、`packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`、`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`。

**Produces：** Root Broker `preserve_integration_debt` 合法 `{ reason }` 请求的 RED/GREEN 证据和 focused 回归；不增加 fallback、探针或吞错兼容。

**验收标准：**
- [ ] RED 必须是 `parseBrokerRequest` 对合法 production shape 的具体断言失败，不能用 TypeError/module-not-found/typecheck 失败替代。
- [ ] GREEN 只允许 protocol 参数校验与必要 focused test 改动；请求能到达 coordinator preserve handler 的合同边界。
- [ ] preserve reason 仍受非空/长度约束，未知字段仍拒绝；不改变其他 coordinator operation。
- [ ] focused protocol/coordinator tests、`npm run typecheck:subagents-enhanced`、`git diff --check` 通过；protected path 无命中；无 staged/无 live state mutation。

### Task L-REGISTRY-ENTRY：定位 durable registry 生产组合点

**Deps：** `L-ORPHAN-WIRING`（理由：消费两个 orphan 的限定 importer 搜索和 lifecycle owner 结论）

**WritePaths：**
- `docs/plans/records/2026-09-23-runtime-remediation/L-REGISTRY-ENTRY.md`

**Resources：** `none`

**Dispatch：** generic 只读归属探索；不得修改生产 composition 或删除 orphan。

**Source：** `L-ORPHAN-WIRING.md` 的零 importer 结论、lifecycle 总计划 P2-T4，以及 durable registry/Host composition 的实际源码。

**Produces：** 经源码验证的最小生产接线合同，或说明权威输入缺失的 blocked-unknown 记录。

**Files：**
- Create：`docs/plans/records/2026-09-23-runtime-remediation/L-REGISTRY-ENTRY.md`
- Read：`packages/pi-subagents-enhanced/src/subagent-dispatch/durable-run-registry.ts`、`extensions/subagent-runtime.ts`、`src/subagent-dispatch/authority-store.ts`、lifecycle plans 与测试。

**接口契约：**
- Consumes：L-ORPHAN-WIRING 报告、durable inventory 的合法 Host owner 和实际生产入口；无权威资源顺序时必须标来源未证实。
- Produces：可单独派发的最小接线任务合同：精确 Host composition 文件/接口签名、owner receipt→inventory 引用和事件顺序、WritePaths、断言级 RED、最小 GREEN、聚焦回归。找不到合法真实入口时产出 blocked 与缺失证据，而不是为了移除 allowlist 虚接线。

**验收标准：**
- [ ] 明确生产 composition 是否真会在授权后的 run lifecycle 调用 registry，不能把测试 jiti import、模块自身导出或 plan 声明当接线证据。
- [ ] 记录具体函数、可用的权威 owner receipt/lease、workspace reference 的取得时点与 provenance；证据不足标 blocked-unknown。
- [ ] 只写目标中文报告，不修改 production/测试/allowlist/live state；`git diff --check` 通过。

## 统一派发协议

后续每次派发只从本表选择一个 ready 节点，并使用 canonical Task ID：

1. 读取该节点的 `Source` 原文和本文全局约束。
2. 确认全部 `Deps` 已通过对应验收；`P-HARNESS` 必须有临时环境生命周期与 cleanup 记录。
3. 为 coding 节点使用 `dispatch-ir.v1`；为只读归因/快照节点使用 generic 结构；不得以 generic 绕过 coding 合同。
4. 将该节点完整的 `WritePaths` 与 `Resources` 原样放入派发请求；禁止把其他任务文件塞进 `WritePaths`。
5. acceptance 只写该节点可观察的结果；不得用 completion/status/prompt 声明替代 terminal proof 或测试输出。
6. 子任务遇到前提与现场矛盾、需要越界写入、或验收条件不可同时满足时停止；control-plane 可用时使用 `contact_supervisor(reason: "need_decision")`，`A-ENV` 判定 degraded 时按降级停止条件记录并结束。
7. 子任务完成后，主 agent 先验收产物，再按 DAG 重新计算 ready set；不得等待整批 Wave 清空，也不得跳过已完成前驱。
8. 只有用户明确授权时才提交；提交范围必须由用户指定，不得把本 DAG、恢复报告、lifecycle 计划和其他 untracked 文件混为一个提交。

## 统一 DAG 机械自检

保存本文后，执行以下只读检查；输出必须作为计划审阅证据保留。脚本不修改文件：

```bash
PLAN=docs/plans/2026-09-23-subagent-runtime-unified-dag.md
python3 - "$PLAN" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
blocks = [x for x in re.split(r"\n(?=### Task )", text) if x.startswith("### Task ")]
ids = []
for block in blocks:
    m = re.match(r"### Task ([A-Za-z0-9-]+)：", block)
    if not m:
        print("结构错误：存在无法解析的 Task 标题")
        raise SystemExit(1)
    tid = m.group(1)
    ids.append(tid)
    required = ["**Deps：**", "**WritePaths：**", "**Resources：**", "**Dispatch：**", "**Source：**", "**Produces：**", "**验收标准：**"]
    missing = [x for x in required if x not in block]
    if missing:
        print(tid, "缺字段", missing)
        raise SystemExit(1)
if len(ids) != len(set(ids)):
    print("结构错误：Task ID 重复")
    raise SystemExit(1)
print("Task IDs:", ", ".join(ids))
print("Task count:", len(ids))
print("结构检查: PASS")
PY

grep -nE 'TBD|TODO|以后实现|类似 Task|待补充|填充细节' "$PLAN" | grep -v 'grep -nE' || echo "占位词检查: PASS"

grep -n '^### Task ' "$PLAN" | wc -l
```

判定要求：Task ID 唯一；每个节点都有 Deps、WritePaths、Resources、Dispatch、Source、Produces、验收标准；占位词零命中。该检查只验证统一索引结构，不替代各节点自身的测试、typecheck、hunk、快照和现场验收。

## 文档关系与使用规则

| 文档 | 角色 | 使用规则 |
|---|---|---|
| `docs/plans/2026-09-23-subagent-runtime-unified-dag.md` | **唯一调度入口** | 读取 canonical Task ID、Deps、Wave、Resources、WritePaths；派发与 ready-set 计算以本文为准 |
| `docs/plans/2026-09-23-subagent-runtime-remediation-roadmap.md` | 裁决与背景总纲 | 读取四项用户裁决、32 条缺陷登记、延后项、全局事实；不单独派发 |
| `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md` | A 详细实现步骤 | 读取 A0–A-ACC 对应的代码片段、测试命令和局部验收；不得按其局部 DAG 独立调度 |
| `docs/plans/2026-09-22-subagent-runtime-confirmed-gaps.md` | B/C 历史细节来源 | 仅读取 B6–B8、C9–C12 的实现细节；其旧 DAG、旧 T14、旧自评章节均不得执行 |
| `docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/` | 调查证据 | 只读消费；文中 `/tmp/wt-analysis/...` 是失效历史引用，README 已说明；不把历史快照当作当前 live 验收 |

**唯一有效执行入口：** `P-SNAPSHOT` 完成且 `P-HARNESS` 有临时环境验收记录后，从 `A-ENV` 开始按本文 DAG 派发；已完成的 `P-EVIDENCE` 只消费证据，不重复恢复。
