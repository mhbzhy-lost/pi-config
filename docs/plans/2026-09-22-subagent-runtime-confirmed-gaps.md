# Subagent Runtime 可确认缺口修复计划（v2 · 已被部分取代）

> **状态（2026-09-23）：本文档的组织方式已被 `docs/plans/2026-09-23-subagent-runtime-remediation-roadmap.md`（总纲）取代。**
>
> 本文经两轮独立执行前审阅，**两轮均判定 No-Go**（合计 8 Blocker + 17 High + 7 Medium）。已按总纲拆分为三份计划，缺陷逐条归属见总纲 §3。
>
> - **计划 A（派发合同与门禁）已重写并独立成文**：`docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md`。本文的 T0、T1、T2、T3、T4、T5、T13、T14 **一律作废，不得执行**，以计划 A 为准。
> - **本文的 T6、T7、T8 仍是计划 B 的任务细节来源**，但执行前必须落实总纲 §3 中标注归属计划 B 的缺陷：BL-4、BL-6、BL-7、BL-8、HI-5、HI-6、HI-7、HI-8、HI-9、HI-10、HI-11、HI-12、HI-16、MD-6、MD-7。**在计划 B 成文之前不得执行本文的 T6/T7/T8。**
> - **本文的 T9、T10、T11、T12、T14 仍是计划 C 的任务细节来源**，执行前必须落实 BL-5、HI-13、HI-15、HI-16、MD-3、MD-4、MD-6。**在计划 C 成文之前不得执行。**
> - 本文的「延后项与原因」「体制性缺口」两节内容已并入总纲 §4 与 §5，以总纲为准。
> - 本文的「计划自检」章节是主 agent 自评，**已被两轮审阅证伪，不得作为任何完成度或正确性的依据**；总纲 §6 的可执行机械门禁取代之。
> - 本文的「修订记录（v2）」保留作为审阅历史，但其「已处置」声明中经二审判定为「部分消除」或「处置方式有误」的条目（B2、B3、B8、H1、H2、H4、M5）以总纲 §3 为准。

---

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 修复经源码级归因、且在新基线（含 lifecycle 批次未提交改动的工作树）上确认可信的 13 项 runtime 缺口，并为「导出能力无生产消费方」这一反复出现的缺陷类建立机械门禁。

**架构：** 全部改动集中在 `packages/pi-subagents-enhanced` 的 canonical 合同层（`src/contracts/dispatch-ir.ts`）、派发扩展（`src/subagent-dispatch/`）、workspace Git 层（`src/workspace/git-worktree.ts`）、根仓 `src/bash-cwd/` 与两处 Skill 副本。每项修复先以精确 RED 锁定当前错误行为，再做最小 GREEN；不引入新抽象层，不重构既有大文件。删除两个孤儿模块以确立 canonical 单一入口，使后续 contract 改动只有一处落点。

**技术栈：** Node.js `>=22.19.0`（原生 TypeScript type-stripping）、TypeScript、`node:test`、`pi-subagents@0.62.0`（固定，深层 import 只能经 `src/compat/pi-subagents-0.62.ts`）、package exports `./dispatch-ir` / `./workspace` / `./workspace/admin`。

## 全局约束

- **工作区是案发现场，不得清理。** 当前工作树含 lifecycle 批次未提交产物（26 个 tracked 文件、947 insertions / 40 deletions，另有 34 个 untracked 实现与测试文件），用户明确要求保留。禁止 `git stash`、`git reset`、`git clean`、`git checkout -- <path>`、`git add`、`git commit`。本计划不含任何提交步骤。
- **触碰 lifecycle 批次已改文件时，diff hunk 必须与其现有 hunk 不重叠，不得回退、重排或重格式化其改动。** 受此约束的文件：`src/subagent-dispatch/extension.ts`（批次 hunk 在 `@@18`、`@@322`、`@@352`、`@@422`）、`extensions/subagent-runtime.ts`（批次 hunk 在 `@@18`、`@@324`、`@@373`、`@@448`）、`src/subagent-dispatch/root-broker-server.ts`、`src/subagent-dispatch/recovery-resume-orchestrator.ts`。
- **验收一律使用临时 fixture，禁止依赖 live 现场。** `var/workspaces/repositories/85369acc…/`（5 个 worktree、1 个卡 `queued` 的 queue item、165 条 debts）由 pid 85087 维护，该进程启动于 2026-09-20 16:32:58，运行的是 lifecycle 批次完成（09-21 20:55）之前 28 小时的代码。以该现场验证新代码会得出无效结论。同样禁止对 live 现场执行任何 `git worktree` mutation、`dispose`、`release`。
- **严格 TDD。** 每个生产变更先观察精确 RED（具体断言失败，不是 `module not found`、不是 typecheck 失败），再写最小实现到 GREEN。执行前必须加载并遵循 `test-driven-development` skill。
- **按仓库「缺陷数据来源分类门禁」归因。** 测试失败时先分类：(1) 预期 production 数据未被正确处理 → 修生产；(2) 测试制造的非预期数据 → 只修测试/fixture/harness；(3) 来源尚未证实 → fail closed、保留现场、补 provenance，禁止预防性兼容。T11 尤其适用。
- **不得为 production/CLI 新增 `.mjs`。** package 内 `src/**/*.ts` 与 `scripts/*.ts` 用 TypeScript；仅 `test/**/*.mjs` 保留 `.mjs`。
- **文档、注释、错误文案中的说明性文字用中文**；错误 `code`、标识符、命令、路径保持原样。错误 message 面向模型消费，采用英文主体 + 精确 keypath，与既有 `INVALID_CONTRACT` / `INVALID_PATH` 风格一致。
- **`pi/settings.json` 的 `enabledModels` 与 `pi/models.json` 不得提交**；本计划不修改这两个文件。
- **不读取、不输出任何凭据。** `pi/auth.json`、`.env.local`、`pi/models.json` 中的密钥内容禁止读取或写入报告。
- **每个任务只能修改自身 `WritePaths` 声明的文件**，不得借用、扩展或合并其他任务的 `WritePaths`。
- **深层 import 边界：** 所有 `pi-subagents/src/*` 深层 import 必须集中在 `src/compat/pi-subagents-0.62.ts`，其他文件只能从该入口消费。
- **workspace 所有权边界：** 禁止在 `src/workspace/` 之外执行 subagent/Goal 的 `git worktree` mutation。T8 只改 `src/workspace/git-worktree.ts` 内部的错误构造，不新增 mutation。
- **本计划不处理**（原因见文末「延后项」）：B2 schema 根级分支重构（T13 只探索不实现）、B3 queue claim 断点、B4 cleanup-debt agent 出口、H2、H5、H6、H7、M1 submodule、M3、M5、M6、M7、R1、R2、R3、R6。

### 行号与符号定位规则（审阅意见 M1）

本计划引用的全部 `文件:行号` 只是 **2026-09-22 工作树快照**的定位辅助。T1/T2/T3 会对 `dispatch-ir.ts` 大量删插，T2/T5 会改变 `extension.ts` 的行号，因此：

- **一律按符号或代码片段定位，不得把行号当作唯一依据。** 每个任务的步骤已给出可搜索的锚点（函数名、常量名、字面量）；行号仅供首次快速跳转。
- 若按行号找到的内容与计划描述不符，**以符号搜索结果为准**，并在任务报告中记录实际行号。
- 禁止因为行号对不上就跳过某个改动点；必须搜索到真正的落点或停下来报告。

### 受保护路径机械门禁（审阅意见 M5）

下列路径**任何任务都不得修改**。每个任务开工前与 T14 之前各跑一次，命中即停止：

```bash
git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/
```

预期：`pi/agents/reviewer.md` 与 `pi/settings.json` 的 ` M` 状态必须与开工前**完全一致**（它们是用户预存编辑，不得回滚也不得追加）；`pi/models.json` 与 `var/workspaces/` 必须无输出。工具链自动格式化、skill 同步、IDE 保存都可能误触这些文件，因此必须机械校验而非依赖记忆。

### 仓库外文件的处理规则（审阅意见 H2）

`/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md` 是**已安装副本**，位于仓库外、不受 git 管理、在另一台机器上不存在。因此：

- **仓库内副本 `skill-overrides/subagent-dispatch/SKILL.md` 是唯一生产交付物**，也是唯一计入 WritePaths 的文件。
- 已安装副本的同步是**条件化的环境步骤**，不纳入任何任务的 WritePaths：先 `[ -f <路径> ]` 判定存在，存在才同步，不存在则记录 `skip: 已安装副本不存在于本环境` 并继续，**不得因此阻塞仓库代码任务**。
- 同步方向固定为「仓库副本 → 已安装副本」，且必须逐字一致。
- 涉及该副本的测试断言（T2/T3 的「两份逐字一致」）必须写成条件式：文件不存在时 skip 该断言而非 fail。

## 可确认可信的判定依据

纳入本计划的每一项都满足：**证据来自磁盘源码 / git 对象库 / 历史 session 日志 / 新起进程的测试运行**，不依赖本会话或任何 live host 加载的 runtime 版本。关键校验：`broker.recordTerminalProof`（`extensions/subagent-runtime.ts:109-150`）不在 lifecycle 批次任何 diff hunk 覆盖范围内，故 T7 针对的缺陷在新旧基线上字节一致；`src/contracts/dispatch-ir.ts`（mtime 09-11）、`src/workspace/git-worktree.ts`、`src/workspace/ledger.ts`、`src/subagent-dispatch/model-selection.ts`、`src/subagent-dispatch/execution-contract.ts`、`src/bash-cwd/*` 均未被批次触碰。

## DAG

```text
T0 (孤儿模块守卫) ──> T1 (只读派发合同) ──┬──> T2 (删除 workflow) ──> T13 (分支可发现性探索)
                                          └──> T3 (path 文法 + SKILL 修正)
T4  (模型候选清单)      ─────────────────────────────────────────────┐
T5  (preflight 错误码)  ─────────────────────────────────────────────┤
T6  (ledger 标签对齐)   ─────────────────────────────────────────────┤
T7  (proof debt 分支)   ─────────────────────────────────────────────┼──> T14 (全量回归验收)
T8  (git stderr 分类)   ─────────────────────────────────────────────┤
T9  (bash cwd 放开)     ─────────────────────────────────────────────┤
T10 (init-pi 测试同步)  ─────────────────────────────────────────────┤
T11 (compat :244 归因)  ─────────────────────────────────────────────┤
T12 (测试时序 flake)    ─────────────────────────────────────────────┘
```

**依赖理由：**

- `T0 → T1`：T0 建立孤儿模块守卫测试与显式 allowlist 机制；T1 删除两个孤儿后必须同步清空对应 allowlist 条目，守卫转绿即 T1 的机械验收信号。T0 未完成时 T1 无法证明「孤儿已彻底消除」。
- `T1 → T2`：T1 删除孤儿 `src/subagent-dispatch/prompt.ts` 后，`workflow` 的渲染点只剩 canonical `src/contracts/dispatch-ir.ts` 一处；T2 因此只需改一个文件。若顺序颠倒，T2 必须同时改孤儿与 canonical 两处，且孤儿会在 T1 才被删除，产生重复劳动与不一致窗口。
- `T1 → T3`：同理，T1 删除孤儿 `src/subagent-dispatch/ir.ts` 后，`normalizeRepoRelativePath` 只剩 canonical 一份实现，T3 的文法分类改造只有一个落点。
- `T2 → T13`：T13 探索 coding/generic 字段分支的可发现性方案，必须在 `workflow` 已删除后的字段面上进行，否则方案会包含即将消失的字段与条件约束。
- `T4`–`T12` 之间**无依赖边**：它们各自只依赖自身的具体产物，且任一任务在其余任务未完成时仍能独立产出可验收结果，故不加边。
- `T14` 是验收终点，依赖 T1–T12 的全部代码产物；**T13 不阻塞 T14**，因为 T13 只产出决策文档，不改代码。

## Resources（资源竞争，非 DAG 依赖）

| 资源 | 竞争任务 | 并发上限 |
|---|---|---|
| `dispatch-ir`（`src/contracts/dispatch-ir.ts` 写锁） | T1、T2、T3 | 1 |
| `extension-ts`（`src/subagent-dispatch/extension.ts` 写锁） | T2、T5 | 1 |
| `skill-md`（`skill-overrides/subagent-dispatch/SKILL.md` 写锁） | T2、T3 | 1 |
| `root-broker`（`src/subagent-dispatch/root-broker-server.ts` 写锁） | T7 | 1 |
| `managed-workspace-contract-test`（`test/managed-workspace-contract.test.mjs` 写锁） | T6、T8 | 1 |
| `full-test-suite`（全量 `npm test` 独占，避免并发负载导致 T12 类 flake 误判） | T12（步骤 4）、T14 | 1 |

资源锁是执行器必须消费的硬约束，不是提醒。两个任务声明同一资源时不得并行，即使它们之间没有 DAG 依赖边。`test/managed-workspace-contract.test.mjs` 的共享在 v1 中只写在「计划自检」里而未进入本表（审阅意见 H1），现补登。

## Waves

- **Wave 1（可全部并行）：** T0、T4、T6、T7、T8、T9、T10、T11、T12
- **Wave 2：** T1（等 T0 的守卫测试与 allowlist 机制）
- **Wave 3：** T2、T3、T5（等 T1；三者受 `dispatch-ir` / `extension-ts` / `skill-md` 资源锁约束，由执行器串行调度，非 DAG 强制）
- **Wave 4：** T13（等 T2 的字段面收窄）
- **Wave 5：** T14（验收终点，等 T1–T12）

**关键路径：** `T0 → T1 → T2 → T13`；`T14` 挂在 T1–T12 之后，不在 T13 的关键路径上。Wave 1 的九个任务与关键路径完全解耦，可立即并行开工。

---

### Task 0：孤儿模块守卫（接线门禁）

**Deps：** `none`

**WritePaths：**
- `test/package-orphan-export-guard.test.mjs`

**Resources：** `none`

**Files：**
- Create：`test/package-orphan-export-guard.test.mjs`
- Test：`test/package-orphan-export-guard.test.mjs`

**接口契约：**
- Consumes：`packages/pi-subagents-enhanced/package.json` 的 `exports` 映射（作为合法终端消费入口白名单）
- Produces：`ALLOWLIST` 常量（`Map<相对 pkgRoot 的模块路径, 豁免理由>`），T1 通过删除条目并删除对应文件来兑现；以及孤儿模块清单，作为 T13 与后续 lifecycle 收尾批次的输入

**验收标准：** 守卫测试 GREEN；运行输出中列出的孤儿模块清单与人工核对一致；allowlist 每个条目都有非空中文理由；allowlist 腐化守卫（条目指向已不存在的文件）在 T1 删文件但未删条目时会 RED。

**背景事实（执行者必读）：** 本仓库已三次出现同一缺陷模式——能力落在生产不 import 的模块里，测试对着该模块跑并全绿，随后被报告为已交付。已确证的实例：

1. `src/subagent-dispatch/ir.ts`：`boundaries.writePaths` 为 `minItems: 0`，而生产入口 `src/contracts/dispatch-ir.ts:168` 为 `minItems: 1`。commit `b332005`（2026-09-18）只改了孤儿那份。生产 importer 数量为 0，仅 3 个测试文件引用。
2. `src/subagent-dispatch/prompt.ts`：孤儿 renderer；生产 renderer 在 `src/contracts/dispatch-ir.ts:275-292`。仅 2 个测试文件引用。
3. `src/subagent-dispatch/lifecycle-policy.ts`、`lifecycle-identity.ts`、`supervisor-replay.ts`：生产 import 数均为 0，仅测试消费。`recoverOrphanRun`（`recovery-resume-orchestrator.ts:36`）作为导出无生产调用方，且模块内部也不调用它。

- [ ] **步骤 1：编写守卫测试（allowlist 留空，预期 RED 并列出全部孤儿）**

创建 `test/package-orphan-export-guard.test.mjs`：

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

// 两个测试职责分离（审阅意见 B7）：
//   测试一「发现」——报告当前全部孤儿，allowlist 只用于暂存已确认归属的项；
//   测试二「腐化守卫」——allowlist 条目对应文件被删后必须同步移除条目。
// 两者不得合并，否则删文件时容易连发现能力一起削弱。

const repoRoot = dirname(new URL(import.meta.url).pathname);
const pkgRoot = join(repoRoot, "packages", "pi-subagents-enhanced");
const pkgSrc = join(pkgRoot, "src");

// package public exports 是合法终端消费入口，不要求另有 importer
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const exportTargets = new Set(Object.values(pkgJson.exports ?? {}).map((p) => p.replace(/^\.\//, "")));

// 显式豁免表：每项必须写明中文理由。条目对应的文件被删除后必须同步移除条目，
// 否则第二个测试会 RED（防止豁免表腐化成永久遮羞布）。
const ALLOWLIST = new Map([]);

// 只有这些目录下的 .ts 才算「生产消费方」；test/ 一律不算
const PRODUCTION_ROOTS = [
  join(pkgRoot, "src"),
  join(pkgRoot, "extensions"),
  join(pkgRoot, "child-extensions"),
  join(pkgRoot, "scripts"),
  join(repoRoot, "src"),
  join(repoRoot, "pi", "extensions"),
  join(repoRoot, "scripts"),
];

function walkTs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// 解析 import 说明符为绝对路径后再比较，绝不用 basename 兜底。
// 审阅意见 B7：`./prompt.ts` 这类 basename 匹配会在不同目录存在同名文件时
// 误报「已被引用」，使守卫漏检真实孤儿；因此只接受能解析到目标模块真实路径的 import。
const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function resolvesTo(consumerFile, specifier, targetFile) {
  if (!specifier.startsWith(".")) return false;              // 裸包名不是本仓内部引用
  const base = join(dirname(consumerFile), specifier);
  const candidates = specifier.endsWith(".ts") ? [base] : [`${base}.ts`, `${base}.d.ts`, join(base, "index.ts")];
  return candidates.some((candidate) => candidate === targetFile);
}

function isReferenced(moduleFile, consumers, texts) {
  return consumers.some((consumer) => {
    if (consumer === moduleFile) return false;
    const text = texts.get(consumer);
    IMPORT_SPECIFIER.lastIndex = 0;
    let match;
    while ((match = IMPORT_SPECIFIER.exec(text)) !== null) {
      if (resolvesTo(consumer, match[1], moduleFile)) return true;
    }
    return false;
  });
}

test("src 下每个模块都有非测试的生产消费方（孤儿模块守卫）", () => {
  const modules = walkTs(pkgSrc);
  const consumers = PRODUCTION_ROOTS.flatMap(walkTs);
  const texts = new Map(consumers.map((f) => [f, readFileSync(f, "utf8")]));
  const orphans = [];
  for (const file of modules) {
    const rel = relative(pkgRoot, file).split(sep).join("/");
    if (exportTargets.has(rel) || ALLOWLIST.has(rel)) continue;
    if (!isReferenced(file, consumers, texts)) orphans.push(rel);
  }
  assert.deepEqual(
    orphans,
    [],
    `发现孤儿模块（无非测试 importer、不在 package exports、不在 allowlist）：\n  ${orphans.join("\n  ")}\n` +
    `处理方式三选一：接线到生产入口 / 删除该模块 / 加入 ALLOWLIST 并写明中文理由。`,
  );
});

test("ALLOWLIST 不含已失效条目（防止豁免表腐化）", () => {
  const stale = [...ALLOWLIST.keys()].filter((rel) => !existsSync(join(pkgRoot, rel)));
  assert.deepEqual(stale, [], `ALLOWLIST 含已不存在的模块，请移除条目：${stale.join(", ")}`);
});

test("ALLOWLIST 每个条目都有非空理由", () => {
  const empty = [...ALLOWLIST.entries()].filter(([, reason]) => typeof reason !== "string" || reason.trim().length === 0);
  assert.deepEqual(empty.map(([rel]) => rel), [], "ALLOWLIST 条目缺少理由");
});
```

- [ ] **步骤 2：运行确认 RED，并记录孤儿清单（硬门禁：本步骤不得跳过）**

运行：`node --test test/package-orphan-export-guard.test.mjs`

预期：FAIL，第一个测试的断言消息列出全部孤儿模块。

**审阅意见 B7 要求的顺序硬约束：** 本步骤必须在 `ALLOWLIST` 仍为**空 Map** 的状态下执行，并把输出清单**原文**粘进任务报告。禁止先填 allowlist 再跑——那样 GREEN 只能证明「allowlist 配好了」，完全没证明孤儿被发现，正是本仓库反复出现的假绿模式（`ir.ts` 的 `minItems:0` 修复就是这么丢的）。

发现与豁免是两个职责，已由两个独立测试承担：测试一报告孤儿（allowlist 仅用于暂存已确认归属的项），测试二守卫 allowlist 不腐化。两者不得合并。

已知至少应包含：`src/subagent-dispatch/ir.ts`、`src/subagent-dispatch/prompt.ts`、`src/subagent-dispatch/lifecycle-policy.ts`、`src/subagent-dispatch/lifecycle-identity.ts`、`src/subagent-dispatch/supervisor-replay.ts`。若清单出现上述之外的条目，逐个人工核对后再决定处置，不得直接塞进 allowlist。若清单**少于**上述五项，说明新的 `isReferenced` 解析仍有漏检（例如多行 import、动态 import、re-export），必须先修算法再继续，不得当成「没有孤儿」。

- [ ] **步骤 3：按归属填充 allowlist，使守卫 GREEN**

只有两类条目允许进入 allowlist，且理由必须写明归属批次：

```js
const ALLOWLIST = new Map([
  ["src/subagent-dispatch/ir.ts", "T1 将删除：与 canonical src/contracts/dispatch-ir.ts 重复的孤儿实现，其 minItems:0 修复从未进入生产路径"],
  ["src/subagent-dispatch/prompt.ts", "T1 将删除：与 canonical renderCodingDispatchPrompt 重复的孤儿 renderer"],
  ["src/subagent-dispatch/lifecycle-policy.ts", "lifecycle 批次 P1-T2 交付的纯契约模块，计划原文即声明该阶段不接入 timer/storage/broker；接线归属 lifecycle 收尾批次，不在本计划范围"],
  ["src/subagent-dispatch/lifecycle-identity.ts", "同上：lifecycle 批次 P1-T2 纯契约模块，待收尾批次接线"],
  ["src/subagent-dispatch/supervisor-replay.ts", "lifecycle 批次 P3-T5 交付物，当前无生产 importer；接线归属 lifecycle 收尾批次，不在本计划范围"],
]);
```

步骤 2 清单中若还有其他条目，按同一格式补入并写明归属；无法判定归属的条目**不得**加入 allowlist，改为在任务报告中列为 `证据不足` 并保留 RED。

- [ ] **步骤 4：运行确认 GREEN**

运行：`node --test test/package-orphan-export-guard.test.mjs`

预期：PASS，3 个测试全绿。

- [ ] **步骤 5：验证守卫真的能抓到回归（负向自检）**

临时把 `ALLOWLIST` 中 `src/subagent-dispatch/ir.ts` 那一行注释掉，运行 `node --test test/package-orphan-export-guard.test.mjs`，预期 FAIL 且消息中出现 `src/subagent-dispatch/ir.ts`。**确认后立即恢复该行**（本步骤不留下任何改动）。再临时向 allowlist 加一条 `["src/subagent-dispatch/does-not-exist.ts", "负向自检"]`，预期第二个测试 FAIL；确认后移除。

- [ ] **步骤 6：运行本任务回归**

运行：`node --test test/package-orphan-export-guard.test.mjs test/pi-subagents-enhanced-package.test.mjs`

预期：PASS。

---

### Task 1：只读派发合同（删除双孤儿 + `writePaths` 允许为空 + `boundaries` 错误模板化）

**Deps：** `T0`（理由：消费 T0 产出的 `ALLOWLIST` 机制与孤儿清单；T1 通过删除文件并移除对应 allowlist 条目来兑现，守卫转绿是本任务的机械验收信号）

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

**Resources：** `dispatch-ir`（最多 1 个并发任务）

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts:82-90`（`validateObject`）、`:165-171`（`normalizeBoundaries`）
- Delete：`packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts`
- Delete：`packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts`
- Modify：`test/subagent-dispatch-validation-errors.test.mjs:7,21,89-93`（import 改指 canonical）
- Modify：`test/subagent-dispatch-ir.test.mjs:7-9`（import 改指 canonical）
- Modify：`test/subagent-dispatch-ir-coercion.test.mjs:4`（import 改指 canonical）
- Modify：`test/subagent-runtime-resource-isolation.test.mjs:106-107`（fixture 路径列表移除两个已删文件）
- Modify：`test/pi-subagents-runtime.integration.mjs:10`（import 改指 canonical）
- Test：`test/subagent-dispatch-readonly-writepaths.test.mjs`

**接口契约：**
- Consumes：T0 的 `ALLOWLIST`（`test/package-orphan-export-guard.test.mjs`）
- Produces：
  - `compileCodingDispatchIR`（`src/contracts/dispatch-ir.ts`，package export `./dispatch-ir`）接受 `boundaries.writePaths: []`，返回 `ir.boundaries.writePaths` 为 `[]`，语义为「显式只读派发」
  - 缺失顶层必填字段时，`INVALID_CONTRACT` 的 message 追加 `full shape: <完整对象模板>`，模板取自新增常量 `FIELD_SHAPE_HINTS`（键为 `${location}.${key}`）
  - canonical 单一入口：仓库内不再存在第二份 `compileCodingDispatchIR` / `renderCodingDispatchPrompt` 实现

**验收标准：**
1. `compileCodingDispatchIR({..., boundaries:{writePaths:[],excludedWork:[],forbiddenActions:[]}, ...}, {cwd:"/repo"})` 成功返回，`ir.boundaries.writePaths` 深度等于 `[]`
2. 省略 `boundaries` 时抛 `CodingDispatchContractError`，`code === "INVALID_CONTRACT"`，message 同时包含 `writePaths`、`excludedWork`、`forbiddenActions` 三个字段名与 `full shape:`
3. `src/subagent-dispatch/ir.ts` 与 `src/subagent-dispatch/prompt.ts` 不存在
4. T0 守卫测试 GREEN 且 `ALLOWLIST` 不再含这两个条目
5. 全仓 grep `subagent-dispatch/ir` 与 `subagent-dispatch/prompt` 只剩 `test/subagent-runtime-resource-isolation.test.mjs` 之外的零命中（该文件的 fixture 路径列表也已移除）
6. `npm run typecheck` PASS

- [ ] **步骤 1：编写失败测试**

创建 `test/subagent-dispatch-readonly-writepaths.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
// 关键：必须穿过 package public export 指向的 canonical 实现，
// 不得 import src/subagent-dispatch/ir.ts（那是孤儿，历史上导致假绿）
const { compileCodingDispatchIR, CodingDispatchContractError } =
  await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");

function contract(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "readonly-probe",
    title: "只读派发合同探针",
    agent: "executor",
    risk: "low",
    objective: "验证 writePaths 可为空的只读派发。",
    workflow: { mode: "docs-only", reason: "只读探针，不修改生产代码。" },
    requirements: ["只读检查并报告。"],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: [], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["报告实际观测。"] },
    execution: { timeoutMs: 1000 },
    ...overrides,
  };
}

test("canonical 合同接受空 writePaths 作为显式只读派发", () => {
  const ir = compileCodingDispatchIR(contract(), { cwd: "/repo" });
  assert.deepEqual(ir.boundaries.writePaths, []);
});

test("空 writePaths 参与 hash，且与非空 writePaths 的 hash 不同", () => {
  const readOnly = compileCodingDispatchIR(contract(), { cwd: "/repo" });
  const writing = compileCodingDispatchIR(
    contract({ boundaries: { writePaths: ["docs/a.md"], excludedWork: [], forbiddenActions: [] } }),
    { cwd: "/repo" },
  );
  assert.equal(typeof readOnly.hash, "string");
  assert.notEqual(readOnly.hash, writing.hash);
});

test("缺失 boundaries 的错误给出完整对象模板", () => {
  const { boundaries: _omit, ...rest } = contract();
  assert.throws(
    () => compileCodingDispatchIR(rest, { cwd: "/repo" }),
    (error) => {
      assert.ok(error instanceof CodingDispatchContractError, "应为 CodingDispatchContractError");
      assert.equal(error.code, "INVALID_CONTRACT");
      assert.match(error.message, /is missing required field boundaries/);
      assert.match(error.message, /full shape:/);
      assert.match(error.message, /writePaths/);
      assert.match(error.message, /excludedWork/);
      assert.match(error.message, /forbiddenActions/);
      return true;
    },
  );
});

test("缺失 context 与 acceptance 时同样给出模板", () => {
  for (const field of ["context", "acceptance"]) {
    const input = contract();
    delete input[field];
    assert.throws(
      () => compileCodingDispatchIR(input, { cwd: "/repo" }),
      (error) => error.code === "INVALID_CONTRACT" && /full shape:/.test(error.message),
      `${field} 缺失时应给出 full shape 模板`,
    );
  }
});
```

- [ ] **步骤 2：运行确认 RED**

运行：`node --test test/subagent-dispatch-readonly-writepaths.test.mjs`

预期：FAIL。第 1、2 个测试因 `INVALID_CONTRACT: boundaries.writePaths must contain at least 1 item(s)` 失败（当前 `dispatch-ir.ts:168` 为 `minItems: 1`）；第 3、4 个测试因 message 不含 `full shape:` 失败。**必须是这些具体断言失败，不能是 import 失败。**

- [ ] **步骤 3：最小实现——canonical 允许空 writePaths**

在 `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts` 的 `normalizeBoundaries`（当前 `:165-171`）中，把 `minItems: 1` 改为 `minItems: 0`，并加中文注释说明语义：

```js
function normalizeBoundaries(value) {
  const boundaries = validateObject(value, "boundaries", ["writePaths", "excludedWork", "forbiddenActions"]);
  return {
    // 空数组是显式只读声明：纯运行/观测/文档类派发不再被迫编造写入路径。
    // 该语义此前只存在于孤儿 src/subagent-dispatch/ir.ts，从未进入生产路径。
    writePaths: normalizeStringArray(boundaries.writePaths, "boundaries.writePaths", { minItems: 0, item: normalizeRepoRelativePath }),
    excludedWork: normalizeStringArray(boundaries.excludedWork, "boundaries.excludedWork"),
    forbiddenActions: normalizeStringArray(boundaries.forbiddenActions, "boundaries.forbiddenActions"),
  };
}
```

- [ ] **步骤 4：最小实现——错误模板**

在同文件 `validateObject` 之前新增常量，并改造 `validateObject`（当前 `:82-90`）：

```js
// 键为 `${location}.${key}`，与 fail() 的 keypath 一致；值为可直接复制的完整对象模板。
const FIELD_SHAPE_HINTS = {
  "$.boundaries": '{"writePaths":["src/a.ts" or "src/**"],"excludedWork":[],"forbiddenActions":[]} (writePaths may be [] for read-only dispatch)',
  "$.context": '{"knownFacts":[],"decisions":[],"relevantFiles":[]}',
  "$.acceptance": '{"criteria":["observable acceptance statement"]}',
  "$.workflow": '{"mode":"tdd"} or {"mode":"existing-tests"|"docs-only","reason":"non-empty"}',
  "$.execution": '{"cwd":"<optional>","worktree":<optional boolean>}'
  ,
};

function validateObject(value, location, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) failTypeMismatch(location, "object", value);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const hint = FIELD_SHAPE_HINTS[`${location}.${key}`];
      fail(
        "INVALID_CONTRACT",
        hint ? `${location} contains unknown field ${key}; full shape: ${hint}` : `${location} contains unknown field ${key}`,
        `${location}.${key}`,
      );
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      const hint = FIELD_SHAPE_HINTS[`${location}.${key}`];
      fail(
        "INVALID_CONTRACT",
        hint ? `${location} is missing required field ${key}; full shape: ${hint}` : `${location} is missing required field ${key}`,
        `${location}.${key}`,
      );
    }
  }
  return value;
}
```

注意：`FIELD_SHAPE_HINTS` 的 `"$.workflow"` 条目会在 T2 删除 `workflow` 时一并移除；本任务先加上，使 T2 之前的一段时间内 `workflow` 相关错误也可行动。

- [ ] **步骤 5：运行确认 GREEN**

运行：`node --test test/subagent-dispatch-readonly-writepaths.test.mjs`

预期：PASS，4 个测试全绿。

- [ ] **步骤 6：删除两个孤儿模块**

```bash
rm packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts
rm packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts
```

- [ ] **步骤 7：把 5 个测试文件的 import 改指 canonical**

逐个修改（每处都从 `src/subagent-dispatch/ir.ts` 或 `.../prompt.ts` 改为 `src/contracts/dispatch-ir.ts`）：

- `test/subagent-dispatch-validation-errors.test.mjs:7`：`await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts")`；同时删除 `:89-93` 那个针对孤儿的 `"coding contract with empty writePaths is an explicit read-only dispatch"` 测试（其语义已由本任务步骤 1 的新测试文件在 canonical 入口上覆盖，保留会造成重复断言）；`:21` 的 fixture 字符串 `writePaths: ["packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts"]` 改为指向仍存在的文件，例如 `writePaths: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"]`
- `test/subagent-dispatch-ir.test.mjs:7`：主 import 改为 `../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`；`:8` 已有的 `compileRuntimeCodingDispatchIR` 别名与之重复，删除该别名并把全部用法统一到单一 import；`:9` 的 `renderCodingDispatchPrompt` 同样改从 canonical 导入
- `test/subagent-dispatch-ir-coercion.test.mjs:4`：改为 `../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `test/pi-subagents-runtime.integration.mjs:10`：改为 `../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `test/subagent-runtime-resource-isolation.test.mjs:106-107`：从 fixture 路径列表中移除 `"packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts"` 与 `"packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts"` 两项

- [ ] **步骤 8：移除 T0 allowlist 中已兑现的两条**

编辑 `test/package-orphan-export-guard.test.mjs`，删除 `ALLOWLIST` 中 `src/subagent-dispatch/ir.ts` 与 `src/subagent-dispatch/prompt.ts` 两个条目。lifecycle 批次那三条保留（其接线不属本计划范围）。

- [ ] **步骤 9：运行确认 GREEN（含孤儿守卫）**

运行：`node --test test/package-orphan-export-guard.test.mjs test/subagent-dispatch-readonly-writepaths.test.mjs test/subagent-dispatch-validation-errors.test.mjs test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-ir-coercion.test.mjs`

预期：PASS。孤儿守卫 GREEN 即证明两个模块已彻底删除且 allowlist 已同步。

- [ ] **步骤 10：验证孤儿引用已清零**

运行：`grep -rn "subagent-dispatch/ir\|subagent-dispatch/prompt" --include=*.ts --include=*.mjs packages/ src/ pi/ test/ scripts/`

预期：**零命中**。若有命中，逐处修正后重跑步骤 9。

- [ ] **步骤 11：运行本任务相关回归**

运行：`node --test test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs test/subagent-execution-contract.test.mjs test/subagent-dispatch-schema-coercion.test.mjs test/subagent-dispatch-schema-security.test.mjs test/subagent-dispatch-skill.test.mjs test/subagent-runtime-resource-isolation.test.mjs && npm run typecheck`

预期：全部 PASS。若 `test/subagent-runtime-resource-isolation.test.mjs` 因 fixture 清单变化而 RED，按其断言语义修正 fixture（该测试属本任务 WritePaths），不得放宽断言。

---

### Task 2：删除 `workflow` 字段并迁移 TDD 信号

**Deps：** `T1`（理由：T1 已删除孤儿 `src/subagent-dispatch/prompt.ts`，`workflow` 的渲染点收敛为 canonical `src/contracts/dispatch-ir.ts` 一处，本任务只需改一个 renderer）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
<!-- 已安装副本 /Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md 不列入 WritePaths：它在仓库外、不受 git 管理、在其他环境不存在。按「仓库外文件的处理规则」作为条件化环境步骤同步，不存在则记录 skip 且不阻塞本任务。 -->
- `pi/agents/delegate.md`
- `pi/agents/executor.md`
- `test/subagent-dispatch-readonly-writepaths.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-validation-errors.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`
- `test/subagent-dispatch-schema-coercion.test.mjs`
- `test/subagent-dispatch-schema-security.test.mjs`
- `test/subagent-dispatch-workflow-removed.test.mjs`

**Resources：** `dispatch-ir`（最多 1 个并发）、`extension-ts`（最多 1 个并发）、`skill-md`（最多 1 个并发）

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts:10`（`WORKFLOW_MODES`）、`:11-27`（`TOP_LEVEL_KEYS` / `COERCIBLE_FIELDS`）、`:144-155`（`normalizeWorkflow`）、`:233`（canonical 装配）、`:259-260`（prompt 文本 `Workflow mode:` / `Workflow reason:`）、`:276`（`workflowReason` 常量）、`:288`（prompt 的 `## Workflow` 段）、T1 新增的 `FIELD_SHAPE_HINTS["$.workflow"]`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:64-71`（schema 的 `workflow` 属性）、`:919`（version heuristic 的特征字段列表）
- Modify：`skill-overrides/subagent-dispatch/SKILL.md` 与 `/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md`（两份内容必须逐字一致）
- Modify：`pi/agents/delegate.md`、`pi/agents/executor.md`
- Test：`test/subagent-dispatch-workflow-removed.test.mjs`

**接口契约：**
- Consumes：T1 产出的 canonical 单一入口（`compileCodingDispatchIR` / `renderCodingDispatchPrompt` 均只在 `src/contracts/dispatch-ir.ts`）
- Produces：
  - `dispatch-ir.v1` 的顶层字段集合为 `version, taskId, title, agent, model, risk, objective, requirements, context, boundaries, acceptance, execution`（**不含 `workflow`**）；必填集合为其中除 `model` 外全部
  - 传入 `workflow` 时抛 `INVALID_CONTRACT`，message 含 `contains unknown field workflow` 且给出 `full shape:` 提示
  - `renderCodingDispatchPrompt(ir)` 输出不含 `## Workflow` 段、不含 `Mode:`、不含 `Exemption reason:`；`## Required Report` 第 3 项保持 `RED/GREEN or exemption evidence` 不变（改为无条件要求，由 profile system prompt 承担 TDD 语义）
  - 两份 `SKILL.md` 不再出现 `workflow.mode` / `workflow.reason` 的任何指引，改为「coding 派发必须在 `requirements` 中包含 TDD skill 绝对路径；纯文档/只读派发（`boundaries.writePaths` 为空）豁免」

**验收标准：**
1. `compileCodingDispatchIR` 对不含 `workflow` 的完整输入成功返回，且 `ir` 无 `workflow` 属性
2. 传入 `workflow: { mode: "tdd" }` 抛 `INVALID_CONTRACT`，message 含 `unknown field workflow`
3. `renderCodingDispatchPrompt(ir)` 的返回值不包含子串 `## Workflow`、`Mode:`、`Exemption reason:`
4. `grep -rn "workflow" packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts` 零命中
5. `extension.ts` 的 schema `properties` 不含 `workflow` 键；`codingWorkflowSpawnParams`（`:364`）与 `genericWorkflowSpawnParams`（`:391`）**保持原样未被修改**（这两个是 workflow spawn 概念，与 IR 的 `workflow` 字段无关）
6. 两份 SKILL.md 的 `diff` 为空（逐字一致）
7. 全库跨会话统计中最高频的 `INVALID_CONTRACT` 文案 `workflow.reason is forbidden when mode is tdd`（182 次 / 41 会话 / 10 项目）在代码中不再可能被产生
8. `npm run typecheck` PASS

- [ ] **步骤 1：先盘点全部消费点，避免漏改**

运行：

```bash
grep -rn "ir\.workflow\|workflow\.mode\|workflow\.reason\|normalizeWorkflow\|WORKFLOW_MODES\|\"workflow\"\|'workflow'" \
  --include=*.ts packages/pi-subagents-enhanced/src packages/pi-subagents-enhanced/extensions \
  packages/pi-subagents-enhanced/child-extensions pi/extensions src
```

把命中清单记入任务报告。**已知必须改的**：`contracts/dispatch-ir.ts` 的 `:10,19,27,144-155,233,259-260,276,288`；`extension.ts` 的 `:64-71`、`:919`。**已知必须保留的**：`extension.ts:364 codingWorkflowSpawnParams`、`:391 genericWorkflowSpawnParams` 及其 `workflowKey` 参数——它们指的是 spawn 编排概念，与 IR 的 `workflow` 字段同名但无关。若盘点发现清单之外的生产消费点，逐个判定后再改，不得为求 GREEN 而保留 `workflow` 字段。

- [ ] **步骤 2：编写失败测试**

创建 `test/subagent-dispatch-workflow-removed.test.mjs`：

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { compileCodingDispatchIR, renderCodingDispatchPrompt, CodingDispatchContractError } =
  await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");
const repoRoot = dirname(new URL(import.meta.url).pathname);

function contract(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "no-workflow-field",
    title: "workflow 字段已删除",
    agent: "executor",
    risk: "normal",
    objective: "验证 dispatch-ir.v1 不再包含 workflow 字段。",
    requirements: ["先读取并遵循 /Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md。"],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: ["src/a.ts"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["合同编译通过且 prompt 不含 Workflow 段。"] },
    execution: { timeoutMs: 1000 },
    ...overrides,
  };
}

test("不含 workflow 的完整输入编译成功，且 ir 无 workflow 属性", () => {
  const ir = compileCodingDispatchIR(contract(), { cwd: "/repo" });
  assert.equal("workflow" in ir, false);
});

test("传入 workflow 抛 INVALID_CONTRACT 且指出是未知字段", () => {
  for (const workflow of [{ mode: "tdd" }, { mode: "docs-only", reason: "只读" }, { mode: "existing-tests" }]) {
    assert.throws(
      () => compileCodingDispatchIR(contract({ workflow }), { cwd: "/repo" }),
      (error) => {
        assert.ok(error instanceof CodingDispatchContractError);
        assert.equal(error.code, "INVALID_CONTRACT");
        assert.match(error.message, /contains unknown field workflow/);
        return true;
      },
      `workflow=${JSON.stringify(workflow)} 应被拒绝`,
    );
  }
});

test("渲染的 child prompt 不再含 Workflow 段与 Mode/Exemption reason", () => {
  const prompt = renderCodingDispatchPrompt(compileCodingDispatchIR(contract(), { cwd: "/repo" }));
  for (const banned of ["## Workflow", "Mode:", "Exemption reason:", "Follow the selected workflow"]) {
    assert.equal(prompt.includes(banned), false, `prompt 不应包含 ${JSON.stringify(banned)}`);
  }
  // TDD 证据要求改为无条件保留在 Required Report 中
  assert.match(prompt, /RED\/GREEN or exemption evidence/);
});

test("canonical 合同源码不再出现 workflow 标识符", () => {
  const src = readFileSync(join(repoRoot, "..", "packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"), "utf8");
  assert.equal(/workflow/i.test(src), false, "dispatch-ir.ts 应完全不含 workflow");
});

test("两份 SKILL.md 逐字一致且不再指引 workflow.mode/reason", () => {
  const override = readFileSync(join(repoRoot, "..", "skill-overrides/subagent-dispatch/SKILL.md"), "utf8");
  const installed = readFileSync("/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md", "utf8");
  assert.equal(override, installed, "仓库副本与已安装副本必须逐字一致");
  assert.equal(/workflow\.mode|workflow\.reason/.test(override), false);
  // 迁移后的 TDD 信号必须存在
  assert.match(override, /test-driven-development\/SKILL\.md/);
  assert.match(override, /writePaths[^\n]*为空|只读派发/);
});
```

- [ ] **步骤 3：运行确认 RED**

运行：`node --test test/subagent-dispatch-workflow-removed.test.mjs`

预期：FAIL。第 1 个测试因 `workflow` 是必填字段而抛 `is missing required field workflow`；第 2 个测试因 `workflow` 当前合法而不抛；第 3、4、5 个测试因 prompt/源码/SKILL 仍含 workflow 而失败。**必须是这些具体断言失败。**

- [ ] **步骤 4：最小实现——canonical 合同移除 workflow**

在 `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`：

1. 删除 `:10` 的 `const WORKFLOW_MODES = new Set(["tdd", "existing-tests", "docs-only"]);`
2. 从 `TOP_LEVEL_KEYS`（`:11-25`）中删除 `"workflow",` 一行
3. 从 `COERCIBLE_FIELDS`（`:27`）中删除 `"workflow"`，改为 `const COERCIBLE_FIELDS = ["requirements", "context", "boundaries", "acceptance", "execution"];`
4. 整体删除 `normalizeWorkflow`（`:144-155`）
5. 从 `compileCodingDispatchIR` 的 canonical 装配（`:233`）中删除 `workflow: normalizeWorkflow(source.workflow),` 一行
6. 从 T1 新增的 `FIELD_SHAPE_HINTS` 中删除 `"$.workflow"` 条目
7. `splitDispatchEnvelope`/hash 相关代码若引用 `ir.workflow`（步骤 1 盘点结果为准），一并删除该引用

- [ ] **步骤 5：最小实现——prompt renderer 移除 Workflow 段**

在同文件：

1. 删除 `:259-260` 两行：`` `Workflow mode: ${ir.workflow.mode}`, `` 与 `...(ir.workflow.reason === undefined ? [] : [`Workflow reason: ${ir.workflow.reason}`]),`
2. 删除 `:276` 的 `const workflowReason = ...` 整行
3. `:288` 由
   ```js
   "", "## Workflow", `- Mode: \`${ir.workflow.mode}\`${workflowReason}`, "- Follow the selected workflow exactly and preserve its evidence.",
   ```
   改为
   ```js
   "", "## Execution Discipline", "- Production code changes follow TDD: observe an exact RED first, then the minimal GREEN.", "- Read-only or docs-only dispatch (empty declared write scope) is exempt from RED/GREEN and must instead cite the observed evidence.",
   ```
4. `## Required Report` 第 3 项 `RED/GREEN or exemption evidence` **保持不变**

- [ ] **步骤 6：最小实现——extension schema 与 version heuristic**

在 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`：

1. 删除 `:64-71` 的 `workflow: runtimeValidated({...})` 整个属性（含其 `mode` enum 与 `reason` 定义）
2. `:919` 的 coding 特征字段启发式当前检测 `taskId`/`objective`/`workflow`；把 `workflow` 替换为 `boundaries`（仍是 coding-exclusive 字段），保持检测强度不下降：
   ```ts
   if (Object.hasOwn(input, "taskId") || Object.hasOwn(input, "objective") || Object.hasOwn(input, "boundaries")) {
     return failure("INVALID_CODING_ROUTER", "input resembles a coding contract but is missing version: \"dispatch-ir.v1\"; coding dispatch routes on the version field");
   }
   ```
   本任务只做等量替换，不扩展启发式覆盖面（M3 属延后项）。
3. **不得修改** `:364 codingWorkflowSpawnParams`、`:391 genericWorkflowSpawnParams` 及其 `workflowKey` 参数。
4. 本步骤产生的 diff hunk 必须与 lifecycle 批次已有 hunk（`@@18`、`@@322`、`@@352`、`@@422`）不重叠；`:64-71` 与 `:919` 均不在其中。

- [ ] **步骤 7：迁移 TDD 信号到 profile system prompt**

`pi/agents/delegate.md`：把正文首段的「生产变更按 TDD 执行：先观察精确 RED，再最小实现到 GREEN。」改写为无条件的强约束表述：

```markdown
你是主力执行代理，承接复杂实现、跨模块 TDD 开发与源码级归因诊断。先完整阅读任务引用的诊断报告原文（若有）与相关实现。

**生产代码变更一律按 TDD 执行，无例外、无需声明：** 先观察精确 RED（具体断言失败，不是 module not found、不是 typecheck 失败），再写最小实现到 GREEN。任务未提供 `workflow` 之类的模式开关，也不接受以「本次是文档任务」为由跳过——是否豁免只由一个事实决定：本次是否修改生产代码或配置。修改即 TDD。

若任务的 declared write scope 为空（纯只读/观测/文档派发），则不要求 RED/GREEN，但必须在报告中给出实际观测证据（命令输出、文件路径、行号），未验证的行为不得声明完成。
```

`pi/agents/executor.md`：正文改为

```markdown
根据收到的任务目标、约束和验收要求完成编码。先阅读相关代码与测试。

**生产代码变更一律按 TDD 执行：** 先观察精确 RED，再最小实现到 GREEN。declared write scope 为空的只读任务豁免 RED/GREEN，但必须给出实际观测证据。

只修改允许的路径，遵守禁止事项，保持最小 diff。运行要求的验证并报告结果。
```

两个文件的 frontmatter（`name`/`description`/`models`/`thinking`/`tools`/`systemPromptMode`/`inheritProjectContext`）**保持原样不动**，尤其不得改动 `pi/agents/reviewer.md`（它有用户预存的未提交编辑，属 R6 用户决策项）。

- [ ] **步骤 8：更新两份 SKILL.md（内容必须逐字一致）**

对 `skill-overrides/subagent-dispatch/SKILL.md` 与 `/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md` 做同样修改：

1. 删除「Coding」节中关于 `workflow` 的全部指引，包括 `` `tdd` 禁止 `workflow.reason`；`existing-tests`/`docs-only` 必须提供 reason `` 这句，以及示例对象里的
   ```js
   workflow: {
     mode: "existing-tests",
     reason: "Existing coverage verifies the documentation change."
   },
   ```
2. 把「派发适合性与探索型工作流」节中的
   > workflow tdd 的派发必须包含 /Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md 路径

   改为
   > 所有 coding 派发都必须在 `requirements` 中包含 `/Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md` 路径并要求执行者先 read（child 环境不继承 skills）。仅当 `boundaries.writePaths` 为空数组（显式只读派发）时可豁免该条，但 `requirements` 必须改为要求给出实际观测证据。

3. 在「Coding」节的字段说明处新增一段：
   ```markdown
   ### TDD 与只读豁免

   `dispatch-ir.v1` 不含 `workflow` 字段；传入会得到 `INVALID_CONTRACT: $ contains unknown field workflow`。TDD 不是可选模式而是默认纪律，由 profile system prompt 与 `requirements` 中的 TDD skill 路径共同承载：

   - `boundaries.writePaths` 非空 → 生产代码变更，必须 TDD，`requirements` 首条写 TDD skill 绝对路径
   - `boundaries.writePaths` 为空数组 → 显式只读派发，豁免 RED/GREEN，`requirements` 改为要求给出命令输出/文件路径/行号级观测证据

   不要为了「声明这是文档任务」而填写任何模式字段；只读语义完全由 `writePaths` 是否为空表达。
   ```

4. 更新示例对象：删除 `workflow` 键，并把 `boundaries.writePaths` 的注释性说明补齐（配合 T3 的文法修正，两份 SKILL.md 的最终文本以 T3 步骤 4 为准；若 T3 在本任务之后执行，本步骤只删 `workflow` 相关内容，不动路径文法那句）。

- [ ] **步骤 9：同步既有测试**

按步骤 3 的 RED 结果，逐个修正以下测试（均属本任务 WritePaths）：

- `test/subagent-dispatch-ir.test.mjs`：删除全部针对 `workflow` 的用例（含 `:217-226` 锁定 mode↔reason 条件的断言），新增一条断言 `workflow` 被当作未知字段拒绝
- `test/subagent-dispatch-validation-errors.test.mjs`：其 `contract()` helper 若含 `workflow` 键，删除该键；涉及 `workflow.reason` 的错误文案断言一并删除
- `test/subagent-dispatch-readonly-writepaths.test.mjs`（T1 创建）：其 `contract()` helper 含 `workflow: { mode: "docs-only", reason: ... }`，**必须删除该键**，否则本任务完成后该文件会 RED。这是 T1→T2 的显式契约衔接点。
- `test/subagent-dispatch-schema-coercion.test.mjs` / `schema-security.test.mjs`：删除 `workflow` 相关的 coercion/security 用例；若存在「`workflow` 字符串化 JSON 可被 coerce」的用例，改为断言 `workflow` 现在是未知字段
- `test/subagent-dispatch-skill.test.mjs`：更新其对 SKILL.md 文本的断言，使其匹配步骤 8 的新文本；若该测试断言仓库副本与已安装副本一致，保留该断言

- [ ] **步骤 10：运行确认 GREEN**

运行：`node --test test/subagent-dispatch-workflow-removed.test.mjs test/subagent-dispatch-readonly-writepaths.test.mjs test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-validation-errors.test.mjs test/subagent-dispatch-schema-coercion.test.mjs test/subagent-dispatch-schema-security.test.mjs test/subagent-dispatch-skill.test.mjs test/package-orphan-export-guard.test.mjs`

预期：PASS。

- [ ] **步骤 11：验证两份 SKILL.md 逐字一致**

运行：`diff skill-overrides/subagent-dispatch/SKILL.md /Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md && echo IDENTICAL`

预期：输出 `IDENTICAL`。若不一致，以仓库副本为准覆盖已安装副本（已安装副本不在 git 管理内，覆盖不产生仓库变更）。

- [ ] **步骤 12：运行本任务相关回归**

运行：`node --test test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs test/subagent-execution-contract.test.mjs test/subagent-dispatch-extension.test.ts test/subagent-dispatch-shared-execution.integration.mjs && npm run typecheck && npm run verify:subagents-enhanced`

预期：全部 PASS。`verify:subagents-enhanced` 会校验 package exports 与发行清单，删除字段不得影响 exports 映射。

---

### Task 3：`writePaths` 文法分类错误 + 修正两处 SKILL 的错误文法

**Deps：** `T1`（理由：T1 已删除孤儿 `src/subagent-dispatch/ir.ts`，`normalizeRepoRelativePath` 只剩 canonical 一份实现）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
<!-- 已安装副本 /Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md 不列入 WritePaths：它在仓库外、不受 git 管理、在其他环境不存在。按「仓库外文件的处理规则」作为条件化环境步骤同步，不存在则记录 skip 且不阻塞本任务。 -->
- `test/subagent-dispatch-writepaths-grammar.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`

**Resources：** `dispatch-ir`（最多 1 个并发）、`skill-md`（最多 1 个并发）

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts:128-142`（`normalizeRepoRelativePath`）
- Modify：`skill-overrides/subagent-dispatch/SKILL.md:122` 与 `/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md:122`
- Test：`test/subagent-dispatch-writepaths-grammar.test.mjs`

**接口契约：**
- Consumes：T1 的 canonical 单一实现；T2 完成后的 SKILL.md 文本（若 T2 先执行）
- Produces：`normalizeRepoRelativePath` 对四类非法输入分别抛出可区分的 `INVALID_PATH` message，每条都含**实际收到的值**（`JSON.stringify`）与**合法写法示例**；合法文法保持不变（不放宽、不收紧），仅改错误文案

**验收标准：**
1. 合法文法完全不变：`README.md`、`src/index.ts`、`.github/workflows/ci.yml`、`src/**`、`packages/a/src/**`、` src/index.ts `（前后空白）全部通过；`src` 仍按精确路径处理
2. 四类非法输入各自命中专属文案：绝对路径/Windows 路径 → `must be repo-relative`；反斜杠或 NUL → `must use POSIX '/' separators`；尾随 `/` → `must not end with '/'` 且文案中明确指出唯一支持的目录范围是末尾 `/**`；其他位置出现 `* ? [ ]` → `contains unsupported glob character "<字符>"`；空/`.`/`..` 段 → `contains an unsafe path segment "<段>"`
3. 每条错误 message 都包含 `JSON.stringify` 后的实际输入值
4. 两份 SKILL.md 的第 122 行不再声称目录范围可以以 `/` 结尾；替换为正确文法，且两份逐字一致
5. `npm run typecheck` PASS

- [ ] **步骤 1：编写失败测试**

创建 `test/subagent-dispatch-writepaths-grammar.test.mjs`：

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { compileCodingDispatchIR } = await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");
const repoRoot = dirname(new URL(import.meta.url).pathname);

function withWritePaths(writePaths) {
  return compileCodingDispatchIR({
    version: "dispatch-ir.v1",
    taskId: "grammar-probe",
    title: "writePaths 文法探针",
    agent: "executor",
    risk: "low",
    objective: "验证 writePaths 文法与错误可行动性。",
    requirements: ["只读验证。"],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths, excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["文法判定符合规格。"] },
    execution: { timeoutMs: 1000 },
  }, { cwd: "/repo" });
}

test("合法文法全部通过且规范化正确", () => {
  assert.deepEqual(withWritePaths(["README.md"]).boundaries.writePaths, ["README.md"]);
  assert.deepEqual(withWritePaths(["src/index.ts"]).boundaries.writePaths, ["src/index.ts"]);
  assert.deepEqual(withWritePaths([".github/workflows/ci.yml"]).boundaries.writePaths, [".github/workflows/ci.yml"]);
  assert.deepEqual(withWritePaths(["src/**"]).boundaries.writePaths, ["src/**"]);
  assert.deepEqual(withWritePaths(["packages/a/src/**"]).boundaries.writePaths, ["packages/a/src/**"]);
  assert.deepEqual(withWritePaths(["  src/index.ts  "]).boundaries.writePaths, ["src/index.ts"]);
  // 裸目录名按精确路径处理，不展开为目录范围
  assert.deepEqual(withWritePaths(["src"]).boundaries.writePaths, ["src"]);
  // 空数组是 T1 引入的显式只读声明
  assert.deepEqual(withWritePaths([]).boundaries.writePaths, []);
});

const CASES = [
  { input: "/Users/me/repo/src/a.ts", code: "INVALID_PATH", re: /must be repo-relative/ },
  { input: "C:/repo/a.ts", code: "INVALID_PATH", re: /must be repo-relative/ },
  { input: "src\\a.ts", code: "INVALID_PATH", re: /POSIX '\/' separators/ },
  { input: "src/", code: "INVALID_PATH", re: /must not end with '\/'/ },
  { input: "docs/plans/", code: "INVALID_PATH", re: /must not end with '\/'/ },
  { input: "src/*", code: "INVALID_PATH", re: /unsupported glob character "\*"/ },
  { input: "src/**/*.ts", code: "INVALID_PATH", re: /unsupported glob character/ },
  { input: "src/**/a.ts", code: "INVALID_PATH", re: /unsupported glob character/ },
  { input: "src/file?.ts", code: "INVALID_PATH", re: /unsupported glob character "\?"/ },
  { input: "src/[ab].ts", code: "INVALID_PATH", re: /unsupported glob character "\["/ },
  { input: "/**", code: "INVALID_PATH", re: /must not be "\/\*\*"/ },
  { input: "./src/a.ts", code: "INVALID_PATH", re: /unsafe path segment "\."/ },
  { input: "src/../a.ts", code: "INVALID_PATH", re: /unsafe path segment "\.\."/ },
  { input: "src//a.ts", code: "INVALID_PATH", re: /unsafe path segment ""/ },
];

test("非法输入命中专属分类文案，且回显实际值与合法示例", () => {
  for (const { input, code, re } of CASES) {
    assert.throws(
      () => withWritePaths([input]),
      (error) => {
        assert.equal(error.code, code, `input=${JSON.stringify(input)} 的 code`);
        assert.match(error.message, re, `input=${JSON.stringify(input)} 的分类文案`);
        assert.ok(error.message.includes(JSON.stringify(input)), `message 应回显实际值：${error.message}`);
        assert.match(error.message, /src\/\*\*|src\/a\.ts/, "message 应给出合法写法示例");
        assert.match(error.message, /boundaries\.writePaths\[0\]/, "keypath 应指向具体下标");
        return true;
      },
      `input=${JSON.stringify(input)}`,
    );
  }
});

test("keypath 指向出错的具體下标", () => {
  assert.throws(
    () => withWritePaths(["src/ok.ts", "/abs/bad.ts"]),
    (error) => error.message.includes("boundaries.writePaths[1]") || error.keypath === "boundaries.writePaths[1]",
  );
});

test("两份 SKILL.md 不再声称目录范围可以尾随斜杠", () => {
  const override = readFileSync(join(repoRoot, "..", "skill-overrides/subagent-dispatch/SKILL.md"), "utf8");
  const installed = readFileSync("/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md", "utf8");
  assert.equal(override, installed, "仓库副本与已安装副本必须逐字一致");
  assert.equal(/以 `\/\*\*` 或 `\/` 结尾/.test(override), false, "错误的文法表述必须已移除");
  assert.equal(/如 `src\/\*\*` 或 `src\/`/.test(override), false, "错误的示例必须已移除");
  assert.match(override, /唯一支持的目录范围写法是末尾 `\/\*\*`/);
  assert.match(override, /尾随 `\/` 会被拒绝/);
});
```

- [ ] **步骤 2：运行确认 RED**

运行：`node --test test/subagent-dispatch-writepaths-grammar.test.mjs`

预期：FAIL。第 1 个测试中 `src` 用例可能已通过，但 `/**` 用例的文案断言失败；第 2 个测试大量失败，因为当前四类原因共用两条泛化文案（`must be a repo-relative POSIX path` 与 `contains an unsupported path pattern`），且都不回显实际值、不给示例；第 4 个测试因 SKILL.md 仍含错误表述而失败。

- [ ] **步骤 3：最小实现——分类错误文案**

把 `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts:128-142` 的 `normalizeRepoRelativePath` 整体替换为：

```js
// 合法文法（唯一规格，不放宽不收紧）：
//   PATH      := EXACT | RECURSIVE
//   RECURSIVE := EXACT "/**"
//   EXACT     := SEGMENT ("/" SEGMENT)*
//   SEGMENT   := 非空，且不等于 "." 或 ".."
// 禁止：前导 "/"、Windows 盘符与 UNC、任何反斜杠与 NUL、尾随 "/"、
//       末尾 "/**" 之外的任何 * ? [ ]、空段与 "."/".." 段。
const PATH_EXAMPLE = 'e.g. "src/a.ts" or "src/**"';

function normalizeRepoRelativePath(value, location) {
  const normalized = normalizeString(value, location);
  const echoed = JSON.stringify(normalized);
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\");

  if (normalized.includes("\0") || normalized.includes("\\")) {
    fail("INVALID_PATH", `${location} must use POSIX '/' separators and must not contain backslashes or NUL; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  if (normalized.startsWith("/") || windowsAbsolute) {
    fail("INVALID_PATH", `${location} must be repo-relative: no leading '/' and no Windows drive/UNC prefix; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }

  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;

  if (!base) {
    fail("INVALID_PATH", `${location} must not be "/**": a recursive scope needs a directory prefix; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  if (base.endsWith("/")) {
    fail("INVALID_PATH", `${location} must not end with '/'; the only supported directory scope is a single trailing '/**'; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  const glob = base.match(/[*?[\]]/);
  if (glob) {
    fail("INVALID_PATH", `${location} contains unsupported glob character ${JSON.stringify(glob[0])}; globs are only allowed as one trailing '/**'; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }

  const segments = base.split("/");
  const unsafe = segments.find((segment) => !segment || segment === "." || segment === "..");
  if (unsafe !== undefined) {
    fail("INVALID_PATH", `${location} contains an unsafe path segment ${JSON.stringify(unsafe)}; empty, '.' and '..' segments are forbidden; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  return recursive ? `${segments.join("/")}/**` : segments.join("/");
}
```

- [ ] **步骤 4：修正两份 SKILL.md 第 122 行的错误文法**

在 `skill-overrides/subagent-dispatch/SKILL.md` 与 `/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md` 中，把这句

```
目录范围 `writePaths` 必须以 `/**` 或 `/` 结尾（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。
```

替换为

```
`writePaths` 的文法只有一种：仓库相对 POSIX 路径，写作精确路径（`src/a.ts`）或末尾带 `/**` 的递归目录范围（`src/**`）。唯一支持的目录范围写法是末尾 `/**`；尾随 `/` 会被拒绝（`src/` 非法，必须写 `src/**`），末尾 `/**` 之外的任何 `* ? [ ]` 均非法，`.`/`..`/空段非法，绝对路径与反斜杠非法。裸路径（如 `src`）按精确条目匹配，不展开为目录范围。`writePaths` 可以是空数组，表示显式只读派发。
```

两份文件必须逐字一致。若 T2 已先执行，注意不要覆盖 T2 在同文件其他位置的改动——只替换这一句。

- [ ] **步骤 5：运行确认 GREEN**

运行：`node --test test/subagent-dispatch-writepaths-grammar.test.mjs`

预期：PASS，4 个测试全绿。

- [ ] **步骤 6：同步既有 path 相关测试**

`test/subagent-dispatch-ir.test.mjs:237-258` 覆盖了部分 escape/glob 拒绝用例，其断言可能匹配旧的泛化文案。逐个更新为新分类文案的断言；**不得删除用例或放宽为只断言 `code === "INVALID_PATH"`**，必须保留对分类文案的断言。`test/subagent-dispatch-skill.test.mjs` 若断言 SKILL.md 文本，同步更新。

- [ ] **步骤 7：验证两份 SKILL.md 逐字一致**

运行：`diff skill-overrides/subagent-dispatch/SKILL.md /Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md && echo IDENTICAL`

预期：输出 `IDENTICAL`。

- [ ] **步骤 8：运行本任务相关回归**

运行：`node --test test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-readonly-writepaths.test.mjs test/subagent-dispatch-workflow-removed.test.mjs test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs test/subagent-dispatch-skill.test.mjs test/package-orphan-export-guard.test.mjs && npm run typecheck`

预期：全部 PASS。

---

### Task 4：`MODEL_NOT_AVAILABLE` 返回候选清单与建议

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`
- `test/subagent-model-selection.test.mjs`
- `test/subagent-model-candidates.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts:27-33`（`ModelSelectionError`）、`:54-101`（匹配算法的各抛出点）
- Test：`test/subagent-model-candidates.test.mjs`

**接口契约：**
- Consumes：`resolveModelSelection()` 现有签名与 `ModelSelectionRequest`（`requestedModel?`, `agentName`, `agentModels?`, `availableModels`, `blockedProviders?`）
- Produces：
  - `ModelSelectionError` 新增只读属性 `details`，形状固定为
    ```ts
    {
      code: "MODEL_NOT_AVAILABLE";
      requestedModel: string;
      requestedKind: "qualified" | "bare";
      agent: string;
      declaredCandidates: string[];   // profile 声明的 full-ID，已按 blockedProviders 过滤
      availableCandidates: string[];  // 当前 available catalog 的 full-ID，已按 blockedProviders 过滤，升序
      suggestion?: string;            // 唯一确定时才给；否则省略
    }
    ```
  - message 追加：候选清单（存在时）、`suggestion`（存在时）、以及一句裸名匹配规则说明
  - 匹配算法**语义完全不变**：qualified 精确匹配 full-ID；bare 在 profile 声明了 `models` 时按声明顺序匹配 id 段且 miss 后不查全局；bare 在未声明时查全局并产生 `MODEL_MATCH_USED_GLOBAL_CATALOG` 警告。**不引入 alias、substring、模糊或大小写不敏感匹配。**

**验收标准：**
1. 请求 bare `astra`、profile 声明含 `codex-pool/gpt-6-astra` 时：抛错，`details.requestedKind === "bare"`，`details.declaredCandidates` 含 `"codex-pool/gpt-6-astra"`，`details.suggestion === "gpt-6-astra"`，message 含 `Did you mean "gpt-6-astra"?`
2. 请求 qualified `qoder-pool/gpt-6-astra` 且该 full-ID 不在 available catalog 时：抛错，`details.requestedKind === "qualified"`，`details.availableCandidates` 为过滤后的升序 full-ID 列表，**不给 suggestion**（qualified 请求不做模糊猜测）
3. `blockedProviders` 中的 provider 不出现在 `declaredCandidates` 与 `availableCandidates` 中
4. `suggestion` 只在**恰好一个**声明候选的 id 段满足「大小写不敏感地以 requested 结尾且以 `-` 或 `.` 分隔」时才给出；零个或多个命中时省略该字段
5. 成功路径与 `MODEL_MATCH_USED_GLOBAL_CATALOG` 警告行为与改动前逐位一致
6. `npm run typecheck` PASS

- [ ] **步骤 1：读取现有抛出点**

运行：`grep -n "ModelSelectionError\|throw new ModelSelection" packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`

记录全部抛出点行号与其所在分支（qualified miss / bare-with-profile miss / bare-global miss）。实现时每个抛出点都必须传入该分支实际可见的候选集合，不得传空数组充数。

- [ ] **步骤 2：编写失败测试**

创建 `test/subagent-model-candidates.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { resolveModelSelection, ModelSelectionError } =
  await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts");

const available = [
  { provider: "codex-pool", id: "gpt-6-astra" },
  { provider: "codex-pool", id: "gpt-5.6-sol" },
  { provider: "qoder-pool", id: "GLM-5.3-0.6x" },
  { provider: "zai-coding-cn", id: "glm-5.3" },
];
const reviewerModels = ["codex-pool/gpt-6-astra", "openai-codex/gpt-6-astra", "codex-pool/gpt-5.6-sol", "qoder-pool/GLM-5.3-0.6x", "zai-coding-cn/glm-5.3"];

test("bare 昵称失败时给出声明候选与唯一建议", () => {
  assert.throws(
    () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available }),
    (error) => {
      assert.ok(error instanceof ModelSelectionError);
      assert.equal(error.code, "MODEL_NOT_AVAILABLE");
      assert.equal(error.details.requestedKind, "bare");
      assert.equal(error.details.agent, "reviewer");
      assert.equal(error.details.requestedModel, "astra");
      // openai-codex/gpt-6-astra 不在 available catalog，但仍属声明候选，应如实列出
      assert.deepEqual(error.details.declaredCandidates, reviewerModels);
      assert.deepEqual(error.details.availableCandidates, [
        "codex-pool/gpt-5.6-sol", "codex-pool/gpt-6-astra", "qoder-pool/GLM-5.3-0.6x", "zai-coding-cn/glm-5.3",
      ]);
      assert.equal(error.details.suggestion, "gpt-6-astra");
      assert.match(error.message, /Did you mean "gpt-6-astra"\?/);
      assert.match(error.message, /Available declared IDs:/);
      assert.match(error.message, /exactly match the full id segment after/);
      return true;
    },
  );
});

test("blocked provider 不出现在任何候选清单中", () => {
  assert.throws(
    () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available, blockedProviders: ["codex-pool"] }),
    (error) => {
      assert.equal(error.details.declaredCandidates.some((c) => c.startsWith("codex-pool/")), false);
      assert.equal(error.details.availableCandidates.some((c) => c.startsWith("codex-pool/")), false);
      // codex-pool 被屏蔽后 gpt-6-astra 不再可用，suggestion 必须省略而非给出不可用建议
      assert.equal("suggestion" in error.details, false);
      return true;
    },
  );
});

test("qualified 请求失败时不给模糊建议", () => {
  assert.throws(
    () => resolveModelSelection({ requestedModel: "qoder-pool/gpt-6-astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available }),
    (error) => {
      assert.equal(error.details.requestedKind, "qualified");
      assert.equal("suggestion" in error.details, false);
      assert.equal(error.message.includes("Did you mean"), false);
      assert.match(error.message, /Available models:/);
      return true;
    },
  );
});

test("建议不唯一时省略 suggestion", () => {
  const ambiguous = [
    { provider: "p1", id: "x-astra" },
    { provider: "p2", id: "y-astra" },
  ];
  assert.throws(
    () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: ["p1/x-astra", "p2/y-astra"], availableModels: ambiguous }),
    (error) => {
      assert.equal("suggestion" in error.details, false);
      assert.deepEqual(error.details.declaredCandidates, ["p1/x-astra", "p2/y-astra"]);
      return true;
    },
  );
});

test("成功路径与全局目录警告行为不变", () => {
  // resolveModelSelection 的真实返回形状是 { model, source, warnings? }；没有 resolvedModel 字段。
  // resolvedModel 只是 global-catalog 分支内的局部变量，仅出现在 warnings[] 元素里
  // （model-selection.ts:62/68/78/92-100）。source 取值：default / qualified / agent-candidates / global-catalog。
  const qualified = resolveModelSelection({ requestedModel: "codex-pool/gpt-6-astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available });
  assert.equal(qualified.model, "codex-pool/gpt-6-astra");
  assert.equal(qualified.source, "qualified");

  const bareDeclared = resolveModelSelection({ requestedModel: "glm-5.3", agentName: "reviewer", agentModels: reviewerModels, availableModels: available });
  assert.equal(bareDeclared.model, "zai-coding-cn/glm-5.3");
  assert.equal(bareDeclared.source, "agent-candidates");

  const bareGlobal = resolveModelSelection({ requestedModel: "glm-5.3", agentName: "reviewer", availableModels: available });
  assert.equal(bareGlobal.model, "zai-coding-cn/glm-5.3");
  assert.equal(bareGlobal.source, "global-catalog");
  assert.ok(bareGlobal.warnings?.some((w) => w.code === "MODEL_MATCH_USED_GLOBAL_CATALOG"), "全局目录路由必须仍产生警告");

  const omitted = resolveModelSelection({ agentName: "reviewer", agentModels: reviewerModels, availableModels: available });
  assert.equal(omitted.source, "default");
});
```

- [ ] **步骤 3：运行确认 RED**

运行：`node --test test/subagent-model-candidates.test.mjs`

预期：FAIL，前 4 个测试因 `error.details` 为 `undefined`（`TypeError: Cannot read properties of undefined`）或 message 不含新文案而失败；第 5 个测试应 PASS（成功路径不变）。若第 5 个测试也 FAIL，说明步骤 2 的 fixture 与真实返回结构不符，先读 `:54-101` 校正 fixture 再继续，**不得修改断言去迎合实现**。

- [ ] **步骤 4：最小实现——扩展错误类型**

把 `model-selection.ts:27-33` 替换为：

```ts
export type ModelSelectionErrorDetails = {
  code: "MODEL_NOT_AVAILABLE";
  requestedModel: string;
  requestedKind: "qualified" | "bare";
  agent: string;
  declaredCandidates: string[];
  availableCandidates: string[];
  suggestion?: string;
};

export class ModelSelectionError extends Error {
  code = "MODEL_NOT_AVAILABLE";
  details: ModelSelectionErrorDetails;

  constructor(requestedModel: string, agentName: string, candidates: {
    declaredCandidates?: readonly string[];
    availableCandidates?: readonly string[];
    suggestion?: string;
  } = {}) {
    const declared = [...(candidates.declaredCandidates ?? [])];
    const availableIds = [...(candidates.availableCandidates ?? [])].sort();
    const parts = [`Requested model is not available: ${requestedModel}; agent=${agentName}.`];
    if (declared.length > 0) parts.push(`Available declared IDs: ${JSON.stringify(declared)}.`);
    if (availableIds.length > 0) parts.push(`Available models: ${JSON.stringify(availableIds)}.`);
    if (candidates.suggestion) parts.push(`Did you mean "${candidates.suggestion}"?`);
    parts.push(`Bare IDs must exactly match the full id segment after "provider/"; no alias or substring matching is performed.`);
    super(parts.join(" "));
    this.name = "ModelSelectionError";
    this.details = Object.freeze({
      code: "MODEL_NOT_AVAILABLE",
      requestedModel,
      requestedKind: requestedModel.includes("/") ? "qualified" : "bare",
      agent: agentName,
      declaredCandidates: Object.freeze(declared) as unknown as string[],
      availableCandidates: Object.freeze(availableIds) as unknown as string[],
      ...(candidates.suggestion ? { suggestion: candidates.suggestion } : {}),
    });
  }
}
```

- [ ] **步骤 5：最小实现——建议推导辅助函数**

在 `ModelSelectionError` 之后新增：

```ts
// 只在恰好一个候选命中时给建议：id 段大小写不敏感地以 requested 结尾，
// 且紧邻的前一个字符是 '-' 或 '.'（避免 "sol" 命中 "gpt-5.6-sol" 之外的意外后缀）。
// 绝不引入 substring/模糊/编辑距离匹配。
function suggestBareModelId(requested: string, declaredFullIds: readonly string[], availableFullIds: ReadonlySet<string>): string | undefined {
  if (requested.includes("/")) return undefined;
  const needle = requested.toLowerCase();
  const hits = new Set<string>();
  for (const full of declaredFullIds) {
    if (!availableFullIds.has(full)) continue;          // 不建议当前不可用的模型
    const id = candidateModelId(full).toLowerCase();
    if (id === needle) continue;                        // 完全相等不会走到失败分支
    if (!id.endsWith(needle)) continue;
    const boundary = id.slice(0, id.length - needle.length).slice(-1);
    if (boundary === "-" || boundary === ".") hits.add(candidateModelId(full));
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}
```

- [ ] **步骤 6：在全部抛出点传入真实候选**

按步骤 1 记录的抛出点逐个改造。每个抛出点都必须构造：
- `declaredCandidates`：该分支可见的 profile 声明 full-ID 列表，已用 `blockedProviderSet(blockedProviders)` 过滤
- `availableCandidates`：过滤后的 available catalog full-ID 列表（用既有 `fullModelId()`）
- `suggestion`：仅 bare 分支调用 `suggestBareModelId(...)`；qualified 分支不传

示例（bare + profile 声明分支）：

```ts
const declared = (agentModels ?? []).filter((full) => !blocked.has(candidateProvider(full)));
const availableIds = availableModels.filter((m) => !blocked.has(m.provider)).map(fullModelId);
throw new ModelSelectionError(requestedModel, agentName, {
  declaredCandidates: declared,
  availableCandidates: availableIds,
  suggestion: suggestBareModelId(requestedModel, declared, new Set(availableIds)),
});
```

其余分支按同样形状传入其实际可见集合。**匹配算法本身的控制流不得改动**——只替换 `throw` 语句的实参。

- [ ] **步骤 7：运行确认 GREEN**

运行：`node --test test/subagent-model-candidates.test.mjs`

预期：PASS，5 个测试全绿。

- [ ] **步骤 8：运行本任务相关回归**

运行：`node --test test/subagent-model-selection.test.mjs test/subagent-model-selection.integration.mjs test/package-orphan-export-guard.test.mjs && npm run typecheck`

预期：全部 PASS。`test/subagent-model-selection.test.mjs:53-96` 锁定了精确匹配语义（bare 不查全局、qualified 精确匹配），若它 RED，说明步骤 6 改动了控制流，必须回退到只改 `throw` 实参。

---

### Task 5：本地 preflight 拒绝使用独立错误码，不再冒充 RPC 失败

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts`
- `test/subagent-execution-contract.test.mjs`
- `test/subagent-dispatch-cwd-taxonomy.test.mjs`

**Resources：** `extension-ts`（最多 1 个并发；本任务只读 `extension.ts` 以确认 catch 行为，不修改它——若步骤 5 判定必须修改，则受该资源锁约束）

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts`（`fail()` 辅助函数与 `:163` 的 state-root 拒绝）
- Test：`test/subagent-dispatch-cwd-taxonomy.test.mjs`

**接口契约：**
- Consumes：`createAuthorizedDispatch(input, hostGrant)` 现有签名；`managedStateRoot()` 现有语义
- Produces：
  - `execution-contract.ts` 的 `fail(message, code?, keypath?)` 抛出的 Error 带 `code` 与 `detail` 属性
  - state-root cwd 拒绝抛出的错误 `code === "INVALID_EXECUTION_CWD"`、`detail === { code: "INVALID_EXECUTION_CWD", keypath: "cwd", detail: <stateRoot 说明> }`
  - 由于 `extension.ts:1381-1384` 的兜底逻辑是 `error?.code ?? (CodingDispatchContractError ? error.code : "SUBAGENT_RPC_FAILED")` 且 `isRpcFailure = code === "SUBAGENT_RPC_FAILED" || typeof error?.operation === "string"`，一旦错误自带 `code` 且不设 `operation`，顶层错误码即为 `INVALID_EXECUTION_CWD`，`details` 走 `error?.detail` 分支，不再产生伪造的 `rpcOperation: "spawn"` 与 `causeCode: "unknown"`

**验收标准：**
1. 传入落在 managed state root 内的 `cwd` 时，`createAuthorizedDispatch` reject，`error.code === "INVALID_EXECUTION_CWD"`，`error.message` 含实际 cwd 与 state root，并给出下一步指引（改回合法 origin，或通过 managed workspace 的续做路径）
2. 该错误对象**不含** `operation` 属性（否则会被 `isRpcFailure` 误判）
3. 其余既有 `fail()` 调用点的 message 文本保持不变（只增加可选 `code`/`keypath` 参数，默认值使旧调用行为等价），且各自获得稳定的 `code`
4. `grep -c "SUBAGENT_RPC_FAILED" ` 在该错误路径上不再出现
5. `npm run typecheck` PASS

- [ ] **步骤 1：读取 `fail()` 当前实现与全部调用点**

运行：

```bash
grep -n "^function fail\|const fail =\|fail(" packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts | head -40
```

记录 `fail` 的定义行与全部调用点。**本任务只给 `fail` 增加可选参数，不改任何既有调用的 message 文本**，以免破坏 `test/subagent-execution-contract.test.mjs` 的既有断言。

- [ ] **步骤 2：编写失败测试**

创建 `test/subagent-dispatch-cwd-taxonomy.test.mjs`：

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createAuthorizedDispatch } =
  await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts");

test("cwd 落在 managed state root 内时报 INVALID_EXECUTION_CWD，而非 SUBAGENT_RPC_FAILED", async () => {
  const root = await mkdtemp(join(tmpdir(), "cwd-taxonomy-"));
  const stateRoot = join(root, "workspaces");
  const inside = join(stateRoot, "repositories", "aa", "worktrees", "wt-1");
  const origin = join(root, "repo");
  await mkdir(inside, { recursive: true });
  await mkdir(origin, { recursive: true });
  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  process.env.PI_CODING_WORKSPACE_DIR = stateRoot;
  try {
    const grant = { allowedProfiles: ["executor"], cwdRoot: root, isolation: "shared" };
    await assert.rejects(
      createAuthorizedDispatch({ agent: "executor", cwd: inside }, grant),
      (error) => {
        assert.equal(error.code, "INVALID_EXECUTION_CWD", `实际 code=${error.code}`);
        assert.notEqual(error.code, "SUBAGENT_RPC_FAILED");
        assert.equal("operation" in error, false, "不得携带 operation，否则会被兜底逻辑判为 RPC 失败");
        assert.match(error.message, /managed state root/);
        assert.ok(error.message.includes(inside), "message 应回显实际 cwd");
        assert.match(error.message, /dispatch from the repository origin|execution\.worktree/, "message 应给出下一步");
        assert.equal(error.detail?.code, "INVALID_EXECUTION_CWD");
        assert.equal(error.detail?.keypath, "cwd");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("合法 cwd 仍正常通过（不得因新增 code 参数而收紧）", async () => {
  const root = await mkdtemp(join(tmpdir(), "cwd-taxonomy-ok-"));
  const origin = join(root, "repo");
  await mkdir(origin, { recursive: true });
  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  process.env.PI_CODING_WORKSPACE_DIR = join(root, "workspaces");
  try {
    const grant = { allowedProfiles: ["executor"], cwdRoot: root, isolation: "shared" };
    const authorized = await createAuthorizedDispatch({ agent: "executor", cwd: origin }, grant);
    assert.equal(authorized.request.cwd, await (await import("node:fs/promises")).realpath(origin));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("既有 fail() 调用点的 message 文本未被改变", async () => {
  const root = await mkdtemp(join(tmpdir(), "cwd-taxonomy-msg-"));
  await mkdir(join(root, "repo"), { recursive: true });
  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  process.env.PI_CODING_WORKSPACE_DIR = join(root, "workspaces");
  try {
    const grant = { allowedProfiles: ["executor"], cwdRoot: root, isolation: "shared" };
    await assert.rejects(
      createAuthorizedDispatch({ agent: "reviewer", cwd: join(root, "repo") }, grant),
      (error) => {
        assert.equal(error.message, "dispatch request agent is not an allowed profile");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
```

注：第 2、3 个测试的 `grant` 形状与 `managedStateRoot()` 的环境变量名以步骤 1 的实际读取结果为准；若与上述 fixture 不符，**修正 fixture 使其匹配真实契约，不得放宽断言**。

- [ ] **步骤 3：运行确认 RED**

运行：`node --test test/subagent-dispatch-cwd-taxonomy.test.mjs`

预期：FAIL，第 1 个测试因 `error.code` 为 `undefined`（当前 `fail()` 不设 code）而失败；第 3 个测试应 PASS。

- [ ] **步骤 4：最小实现——`fail()` 支持 code/keypath，并给 state-root 拒绝专属码**

在 `execution-contract.ts` 中，把 `fail` 改为（保持既有单参调用的 message 完全不变）：

```ts
function fail(message: string, code?: string, keypath?: string): never {
  const error = new Error(message) as Error & { code?: string; detail?: unknown; keypath?: string };
  if (code !== undefined) error.code = code;
  if (keypath !== undefined) error.keypath = keypath;
  if (code !== undefined) error.detail = Object.freeze({ code, ...(keypath ? { keypath } : {}) });
  throw error;
}
```

把 `:163` 的

```ts
if (stateRoot && contains(stateRoot, cwd)) fail("dispatch request cwd cannot be inside the managed state root");
```

改为

```ts
if (stateRoot && contains(stateRoot, cwd)) {
  fail(
    `dispatch request cwd cannot be inside the managed state root: cwd=${cwd}, stateRoot=${stateRoot}. ` +
    `Dispatch from the repository origin instead, or use execution.worktree to obtain a managed workspace. ` +
    `An existing managed workspace cannot be re-entered as a public dispatch cwd.`,
    "INVALID_EXECUTION_CWD",
    "cwd",
  );
}
```

**不要**给该 error 设置 `operation` 属性——`extension.ts:1384` 的 `isRpcFailure` 会因 `typeof error?.operation === "string"` 而重新把它判为 RPC 失败。

- [ ] **步骤 5：确认 extension 兜底逻辑无需修改**

读 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1381-1391`，确认：
- `const code = error?.code ?? (...)` → 现在取到 `"INVALID_EXECUTION_CWD"`
- `const isRpcFailure = code === "SUBAGENT_RPC_FAILED" || typeof error?.operation === "string"` → 两者皆 false
- `details = isRpcFailure ? createSubagentRpcFailureDetails({...}) : error?.detail` → 走 `error.detail`，即 `{ code, keypath }`

若确认成立，本任务**不修改 `extension.ts`**（从而完全避开 lifecycle 批次的 hunk 区域）。若不成立（例如 `trace.stage` 仍被写入 details 造成误导），则改为在该 catch 中把 `stage` 与 `rpcOperation` 限定为仅在 `isRpcFailure` 为真时出现，并声明 `extension-ts` 资源锁、确保 hunk 不与批次 hunk 重叠。

- [ ] **步骤 6：运行确认 GREEN**

运行：`node --test test/subagent-dispatch-cwd-taxonomy.test.mjs`

预期：PASS，3 个测试全绿。

- [ ] **步骤 7：运行本任务相关回归**

运行：`node --test test/subagent-execution-contract.test.mjs test/subagent-dispatch-shared-execution.integration.mjs test/subagent-dispatch-rpc.test.mjs test/package-orphan-export-guard.test.mjs && npm run typecheck`

预期：全部 PASS。若 `test/subagent-execution-contract.test.mjs` 因 message 文本变化而 RED，说明步骤 4 误改了既有调用点，回退到只改 `:163` 一处。

---

### Task 6：workspace 状态词表单一权威化 + `MANAGED_WORKSPACE_STATE` 错误可行动化

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`
- `test/managed-workspace-contract.test.mjs`
- `test/managed-workspace-state-vocabulary.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/ledger.ts:31`（`STATES`）
- Modify：`packages/pi-subagents-enhanced/src/workspace/service.ts`（`MANAGED_WORKSPACE_STATE` 各抛出点，含 `:187` 的 `MANAGED_WORKSPACE_CLEANUP_DEBT`、`:385-387` 的 status 门禁、`:586-588` 的 release 前置）
- Modify：`packages/pi-subagents-enhanced/src/workspace/tool.ts:26`（`SUBAGENT_WORKSPACE_DESCRIPTION`）
- Test：`test/managed-workspace-state-vocabulary.test.mjs`

**接口契约：**
- Consumes：`ledger.ts:31` 的 `STATES` 集合，即 `reserved / allocating / active / disposing / preserved / released / cleanup-debt`
- Produces：
  - `ledger.ts` 导出 `export const MANAGED_WORKSPACE_STATES = [...] as const;` 与 `export type ManagedWorkspaceState = typeof MANAGED_WORKSPACE_STATES[number];`，`STATES` 由该常量派生（单一权威来源）
  - `service.ts` 导出 `allowedActionsFor(state: ManagedWorkspaceState): readonly string[]`，映射固定为：
    | state | allowedActions |
    |---|---|
    | `reserved` / `allocating` | `[]`（内部过渡态，agent 无可调用动作） |
    | `active` | `["status", "dispose"]` |
    | `disposing` | `["dispose"]`（重放 pendingAction） |
    | `preserved` | `["release"]` |
    | `cleanup-debt` | `["release"]` |
    | `released` | `[]`（终态） |
  - 所有 `MANAGED_WORKSPACE_STATE` / `MANAGED_WORKSPACE_CLEANUP_DEBT` 错误的 `detail` 追加 `{ state, allowedActions, nextAction }`，message 追加 `state=<state>; allowed actions: <list>; next: <一句话下一步>`
  - `tool.ts` 的 `SUBAGENT_WORKSPACE_DESCRIPTION` 使用 `MANAGED_WORKSPACE_STATES` 生成状态词表，不再出现 ledger 中不存在的状态名

**验收标准：**
1. `MANAGED_WORKSPACE_STATES` 深度等于 `["reserved","allocating","active","disposing","preserved","released","cleanup-debt"]`
2. 生产代码与工具文案中不再出现把 `awaiting-disposition`、`integrated`、`discarded` 当作 workspace record state 的表述（它们分别是 disposition 语义、`integrationReceipt` 字段存在性、`dispose(discard)` 动作，不是 ledger state）
3. `preserved` 状态调用 `status` 时，错误 `detail.state === "preserved"`、`detail.allowedActions` 深度等于 `["release"]`、message 含 `next:` 指引
4. `active` 状态调用 `release` 时，错误 `detail.allowedActions` 深度等于 `["status","dispose"]`
5. `allowedActionsFor` 对全部 7 个状态都有定义，对未知输入抛错而非返回空数组（fail closed）
6. `npm run typecheck` PASS

- [ ] **步骤 1：盘点当前状态词表的全部使用点**

运行：

```bash
grep -rn "awaiting-disposition\|\"integrated\"\|'integrated'\|\"discarded\"\|'discarded'" \
  --include=*.ts packages/pi-subagents-enhanced/src packages/pi-subagents-enhanced/extensions \
  packages/pi-subagents-enhanced/child-extensions
grep -rn "MANAGED_WORKSPACE_STATE\|MANAGED_WORKSPACE_CLEANUP_DEBT" \
  --include=*.ts packages/pi-subagents-enhanced/src
```

把两份清单记入任务报告，逐个标注该处指的是 ledger state 还是 disposition/receipt 语义。**只有确属 ledger state 混用的才改**；若某处 `integrated` 指的是 `integrationReceipt` 字段存在性，保留原样并在代码中加中文注释澄清。

- [ ] **步骤 2：编写失败测试**

创建 `test/managed-workspace-state-vocabulary.test.mjs`：

```js
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const repoRoot = dirname(new URL(import.meta.url).pathname);
const wsRoot = join(repoRoot, "..", "packages", "pi-subagents-enhanced", "src", "workspace");
const { MANAGED_WORKSPACE_STATES, allowedActionsFor } = await jiti.import(join(wsRoot, "ledger.ts"));
const service = await jiti.import(join(wsRoot, "service.ts"));

test("状态词表是单一权威来源且内容固定", () => {
  assert.deepEqual([...MANAGED_WORKSPACE_STATES], [
    "reserved", "allocating", "active", "disposing", "preserved", "released", "cleanup-debt",
  ]);
});

test("allowedActionsFor 覆盖全部状态且 fail closed", () => {
  const expected = {
    reserved: [], allocating: [], active: ["status", "dispose"], disposing: ["dispose"],
    preserved: ["release"], "cleanup-debt": ["release"], released: [],
  };
  for (const state of MANAGED_WORKSPACE_STATES) {
    assert.deepEqual([...allowedActionsFor(state)], expected[state], `state=${state}`);
  }
  assert.throws(() => allowedActionsFor("awaiting-disposition"), /not a managed workspace state/);
  assert.throws(() => allowedActionsFor(undefined), /not a managed workspace state/);
});

test("service 导出的错误构造把 state/allowedActions/nextAction 放进 detail", () => {
  assert.equal(typeof service.managedWorkspaceStateFailure, "function");
  const error = service.managedWorkspaceStateFailure("preserved", "workspace status is unavailable in preserved");
  assert.equal(error.code, "MANAGED_WORKSPACE_STATE");
  assert.deepEqual(error.detail.state, "preserved");
  assert.deepEqual([...error.detail.allowedActions], ["release"]);
  assert.equal(typeof error.detail.nextAction, "string");
  assert.ok(error.detail.nextAction.length > 0);
  assert.match(error.message, /state=preserved/);
  assert.match(error.message, /allowed actions: release/);
  assert.match(error.message, /next: /);
});

test("工具描述与生产源码不再把非 ledger 状态当作 workspace state", () => {
  const files = readdirSync(wsRoot).filter((f) => f.endsWith(".ts")).map((f) => join(wsRoot, f));
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const label of ["awaiting-disposition", "integrated", "discarded"]) {
      // 只禁止把它们当作 state 值使用；允许出现在解释性中文注释中
      const asState = new RegExp(`state\\s*===?\\s*["'\`]${label}["'\`]|state:\\s*["'\`]${label}["'\`]`, "g");
      if (asState.test(text)) offenders.push(`${file.split("/").pop()}: ${label} 被当作 state 使用`);
    }
  }
  assert.deepEqual(offenders, []);
  const tool = readFileSync(join(wsRoot, "tool.ts"), "utf8");
  assert.match(tool, /MANAGED_WORKSPACE_STATES/, "tool 描述应由权威词表生成，而非硬编码");
});
```

- [ ] **步骤 3：运行确认 RED**

运行：`node --test test/managed-workspace-state-vocabulary.test.mjs`

预期：FAIL，`MANAGED_WORKSPACE_STATES` 与 `allowedActionsFor` 均未导出（import 得到 `undefined`），`managedWorkspaceStateFailure` 亦不存在。

- [ ] **步骤 4：最小实现——ledger 导出权威词表**

把 `ledger.ts:31` 的

```ts
const STATES = new Set(["reserved", "allocating", "active", "disposing", "preserved", "released", "cleanup-debt"]);
```

替换为

```ts
// workspace record 的权威状态词表。awaiting-disposition / integrated / discarded
// 不是 ledger state：它们分别表示 disposition 语义、integrationReceipt 是否存在、
// 以及 dispose(discard) 这个动作。对外文案与错误 details 一律引用本常量。
export const MANAGED_WORKSPACE_STATES = [
  "reserved", "allocating", "active", "disposing", "preserved", "released", "cleanup-debt",
] as const;
export type ManagedWorkspaceState = typeof MANAGED_WORKSPACE_STATES[number];
const STATES = new Set<string>(MANAGED_WORKSPACE_STATES);

export function allowedActionsFor(state: ManagedWorkspaceState | string): readonly string[] {
  switch (state) {
    case "reserved":
    case "allocating":
    case "released":
      return [];
    case "active":
      return ["status", "dispose"];
    case "disposing":
      return ["dispose"];
    case "preserved":
    case "cleanup-debt":
      return ["release"];
    default:
      throw new Error(`${String(state)} is not a managed workspace state`);
  }
}
```

- [ ] **步骤 5：最小实现——service 统一错误构造**

在 `service.ts` 的 `failure(...)` 辅助函数附近新增并导出：

```ts
const STATE_NEXT_ACTION: Record<string, string> = {
  reserved: "内部过渡态，稍后重试 status；若长期停留说明 allocation 未完成。",
  allocating: "内部过渡态，稍后重试 status；若长期停留说明 allocation 未完成。",
  active: "先调用 status 取得 action_token，再用 dispose 选择 integrate/discard/preserve。",
  disposing: "重放同一 dispose 调用以完成 pendingAction。",
  preserved: "调用 release 回收；preserved 状态下 status 与 dispose 均不可用。",
  "cleanup-debt": "调用 release 重试回收；若 Git 回收持续失败，需要人工经 admin 面处理，agent 无 force 能力。",
  released: "终态，无可调用动作；同一 workspace 不能再次 allocate。",
};

export function managedWorkspaceStateFailure(state: string, message: string) {
  const allowedActions = [...allowedActionsFor(state as ManagedWorkspaceState)];
  const nextAction = STATE_NEXT_ACTION[state] ?? "状态未知，请人工检查 ledger 记录。";
  return failure("MANAGED_WORKSPACE_STATE",
    `${message}; state=${state}; allowed actions: ${allowedActions.join(", ") || "(none)"}; next: ${nextAction}`,
    Object.freeze({ state, allowedActions: Object.freeze(allowedActions), nextAction }));
}
```

然后把 `service.ts` 中所有 `MANAGED_WORKSPACE_STATE` 抛出点改为调用 `managedWorkspaceStateFailure(state, <原 message>)`，**保持原 message 主体文本不变**（既有测试对其有断言），只追加 `; state=... ; allowed actions: ... ; next: ...` 后缀。至少包含：
- `:385-387` status 门禁（`workspace status is unavailable in ${state}`）
- `:586-588` release 前置（`only a preserved or cleanup-debt workspace can be released`）
- `:187` 的 `MANAGED_WORKSPACE_CLEANUP_DEBT`（`workspace allocation requires manual recovery`）——该 code 保留不变，但同样追加 `state` / `allowedActions` / `nextAction` 到 detail

`failure()` 辅助函数若当前不支持第三个 `detail` 参数，先扩展它（`function failure(code, message, detail?)`），并确保 `detail` 会被 `tool.ts:87-88` 透传。

- [ ] **步骤 6：最小实现——tool 描述引用权威词表**

把 `tool.ts:26` 的

```ts
export const SUBAGENT_WORKSPACE_DESCRIPTION = "Manage only standalone subagent workspaces owned by the current session. Use status before dispose; use release only after preserve.";
```

替换为

```ts
import { MANAGED_WORKSPACE_STATES, allowedActionsFor } from "./ledger.ts";

export const SUBAGENT_WORKSPACE_DESCRIPTION =
  "Manage only standalone subagent workspaces owned by the current session. " +
  "Use status before dispose; use release only after preserve. " +
  `Workspace states: ${MANAGED_WORKSPACE_STATES.join(" | ")}. ` +
  `Agent-callable actions per state: ${MANAGED_WORKSPACE_STATES
    .map((state) => `${state}=[${allowedActionsFor(state).join(",") || "none"}]`)
    .join("; ")}. ` +
  "There is no agent-callable force-release or reconcile action; cleanup-debt that keeps failing needs human admin intervention.";
```

注意 `tool.ts` 现有 import 语句位置，把新 import 合并进既有 import 区块，不要产生重复 import。

- [ ] **步骤 7：运行确认 GREEN**

运行：`node --test test/managed-workspace-state-vocabulary.test.mjs`

预期：PASS，4 个测试全绿。

- [ ] **步骤 8：运行本任务相关回归**

运行：`npm run test:subagent-workspace && node --test test/managed-workspace-action-token.concurrent.mjs test/managed-workspace-administration.test.mjs test/managed-workspace-lifecycle-contract.test.mjs test/managed-workspace-v1-replay.test.mjs test/package-orphan-export-guard.test.mjs && npm run typecheck`

预期：全部 PASS。若既有测试断言了旧的 message 全文（不含新后缀），把断言改为 `assert.match(..., /原主体文本/)` 形式，**不得删除断言**；该修改属本任务 WritePaths 内的 `test/managed-workspace-contract.test.mjs`，其余测试文件若也需同步，先在任务报告中列出并按同一原则最小修改。

---

### Task 7：无 managed workspace 的 run 不再记为 proof debt

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `test/subagent-proof-binding-classification.test.mjs`

**Resources：** `root-broker`（最多 1 个并发）

**Files：**
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 的 `broker.recordTerminalProof` 赋值段（按符号定位：搜索 `broker.recordTerminalProof = async (run, proof)`）
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts` 的 `TerminalProofDeliveryOutcome` 联合类型与 `deliveryOutcome` 函数（按符号定位）
- Test：`test/subagent-proof-binding-classification.test.mjs`

**接口契约：**
- Consumes：`client.listOwned({runId})`、`createManagedWorkspaceLedger({stateRoot}).listScoped({owner})`、`proofOutbox.recordDebt/enqueue`、`client.recordTerminalProof`
- Produces：
  - `TerminalProofDeliveryOutcome` 新增第四种状态 `{ state: "not-applicable"; reason: string }`
  - `root-broker-server.ts` 的 `deliveryOutcome` **新增 `export`**（这是本任务为可测性做的唯一生产 API 变更；仅模块内具名导出，**不加入 package `exports` 映射**，因此不影响发行面，也不触发 T0 的孤儿守卫——守卫是文件级判定，该文件已被 `subagent-runtime.ts:27` 生产 import）
  - `deliveryOutcome` 显式识别 `"not-applicable"` 并原样透传，**不得**落入末尾 fail-closed 的 `debt` 分支
  - 新增导出 `classifyTerminalProofBinding(deps)`，其三态判定按下表，**未知与非法一律 fail closed 为 debt**：

| `listOwned` 结果 | ledger 结果 | 判定 | 动作 |
|---|---|---|---|
| 合法数组，恰好 1 个非空 `workspaceId` | — | `bound` | 走既有 `enqueue` + `client.recordTerminalProof` |
| 合法数组，长度 0 | — | `none` | 返回 `not-applicable`，**不写 debt** |
| 合法数组，长度 > 1 | — | `unknown` | `recordDebt` + 返回 `debt` |
| 非数组 / 元素缺 `workspaceId` 或为空串 | — | `unknown` | `recordDebt` + 返回 `debt` |
| 抛错 | 合法数组，恰好 1 条 | `bound` | 投递 |
| 抛错 | 合法数组，长度 0 | `none` | 返回 `not-applicable` |
| 抛错 | 合法数组，长度 > 1 | `unknown` | `recordDebt` + `debt` |
| 抛错 | 抛错 / 非数组 / 元素非法 | `unknown` | `recordDebt` + `debt` |

  - `TerminalProofBindingDeps.buildTerminalProof` 为**必填**字段，无默认实现。理由：原实现的 `terminalProof` 字段集是 workspace ledger v2 的身份契约（源码注释「The workspace ledger v2 requires exactly this proof identity」），任何默认兜底都会成为字段漂移的温床。

**验收标准：**
1. `worktree:false` 的普通 run（`listOwned` 返回 `[]`）产生终态证明时返回 `state === "not-applicable"`，`recordDebt` **零调用**，`enqueue` 零调用
2. `listOwned` 返回 `[{workspaceId:"w-1"}]` 时：`enqueue` 调用 1 次、`client.recordTerminalProof` 调用 1 次、返回 `state === "delivered"` 且带 receipt
3. **投递路径传给 `enqueue` 与 `recordTerminalProof` 的 proof 对象，其 `Object.keys(...).sort()` 必须深度等于改动前的字段集** `["asyncDir","conflict","processInstance","proofId","rootSessionId","runId","state"]`；`enqueue` 的入参额外含 `ownerScope` 与 `workspaceId`（与改动前一致，`workspaceId` 在 `enqueue` 层展开而**不在** proof 内），`recordTerminalProof` 的入参为 `{workspaceId, ownerScope, proof}`
4. `processInstance` 取值逻辑不变：`proof.runnerProcessInstanceId` 为非空字符串时取之，否则 `String(run.pid)`
5. 非法/未知结果一律 debt：`listOwned` 返回 `null`、`"w-1"`、`[{}]`、`[{workspaceId:""}]`、`[{workspaceId:"w-1"},{workspaceId:"w-2"}]` 五种输入全部得到 `state === "debt"` 且 `recordDebt` 调用 1 次，reason 为 `trusted run binding is unavailable`
6. `listOwned` 抛错且 ledger 也抛错 → `debt`；`listOwned` 抛错且 ledger 返回 `[]` → `not-applicable`；`listOwned` 抛错且 ledger 返回 2 条 → `debt`
7. `deliveryOutcome({state:"not-applicable",reason:"x"})` 原样返回；`reason` 为空白时填默认文案；`deliveryOutcome({state:"bogus"})` 与 `deliveryOutcome(undefined)` 仍 fail closed 为 `debt`
8. `git diff --unified=0` 证明本任务在两个文件上的 hunk 与 lifecycle 批次既有 hunk 不相交（见步骤 1）
9. `npm run typecheck` PASS

**背景事实（执行者必读）：** 现场实测 4 个仓库分区共 492 条 debt，全部 reason 为 `trusted run binding is unavailable`，receipts 恒为 0；其中 `~/mega-aone-service`(127)、`~/pi-config`(99)、`~/miross-employees`(101) 三个分区 **worktrees=0、records=0**，即从未创建过任何 managed workspace。抽样 3 个 debt runId 的 `status.json` 均为 `cwd = /Users/leshi.zhy/new-api-account-pool`（仓库根，非 worktree 路径）且无任何 `workspace*`/`worktree*` 字段。165 条 debt 对应 165 个互不相同的 runId（一 run 一条，非重试）。结论：`worktree:false` 是默认路径，该路径上每个 run 都会永久留下一条无法结算的债务记录。

**证据使用边界（审阅意见 B/§4 要求）：** 上述 492 条 live 数据只能作为**问题动机**，不得作为任何断言的验收依据。本任务的全部验收都由 stub 与临时 ledger fixture 驱动，禁止读取或断言 `var/workspaces/` 下的真实内容。

- [ ] **步骤 1：机械验证 hunk 不重叠（前置门禁，不通过则停止）**

lifecycle 批次在这两个文件上的既有 hunk（新文件行号，已由 `git diff --unified=0` 实测）：

```
extensions/subagent-runtime.ts      : 21, 28, 327-345, 376-381, 451
src/subagent-dispatch/root-broker-server.ts : 11-12, 114-117, 198-199, 224-228, 257-260,
                                              280-284, 304-306, 414-428, 443-509, 657,
                                              687-699, 708, 1201, 1233-1245, 1364-1365, 1380-1381
```

本任务的编辑区：`root-broker-server.ts` 的 `TerminalProofDeliveryOutcome`（约 33-36）与 `deliveryOutcome`（约 159-164）；`subagent-runtime.ts` 的 `broker.recordTerminalProof` 赋值段（约 109-150）。**三者均不落在上述任何 hunk 区间内。**

执行前后各跑一次并对比：

```bash
git diff --unified=0 -- packages/pi-subagents-enhanced/extensions/subagent-runtime.ts \
                         packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts \
  | grep "^@@" > /tmp/t7-hunks-after.txt
cat /tmp/t7-hunks-after.txt
```

判定规则：新增的 hunk 头必须全部落在本任务声明的编辑区内；上述批次既有 hunk 的行号集合必须**逐条仍然存在且区间不变**。若任一批次 hunk 消失或区间变化，说明本任务的编辑波及了批次改动，**立即停止并用 `contact_supervisor`（`reason: "need_decision"`）报告**，不得试图人工"尽量避开"后继续。

- [ ] **步骤 2：记录改动前的 proof 字段集（作为断言基准）**

只读运行，把输出粘进任务报告：

```bash
sed -n '/broker.recordTerminalProof = async/,/^    };/p' \
  packages/pi-subagents-enhanced/extensions/subagent-runtime.ts
```

确认 `terminalProof` 的字面字段为 `state, conflict, runId, rootSessionId, asyncDir, processInstance, proofId`（7 个），且 `enqueue` 的入参是 `{ ...terminalProof, workspaceId, ownerScope }`，`client.recordTerminalProof` 的入参是 `{ workspaceId, ownerScope, proof: terminalProof }`。步骤 3 的断言以此为准。

- [ ] **步骤 3：编写失败测试**

创建 `test/subagent-proof-binding-classification.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const brokerServer = await jiti.import(
  "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts",
);
const runtime = await jiti.import(
  "../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts",
);
const { deliveryOutcome } = brokerServer;
const { classifyTerminalProofBinding } = runtime;

// 改动前的 proof 字段集，来自 extensions/subagent-runtime.ts 的原实现。
// workspaceId 不在其中——它在 enqueue 层展开。
const PROOF_KEYS = ["asyncDir", "conflict", "processInstance", "proofId", "rootSessionId", "runId", "state"];

function makeDeps({ listOwned, ledger, buildTerminalProof }) {
  const calls = { recordDebt: [], enqueue: [], recordTerminalProof: [] };
  return {
    calls,
    deps: {
      client: {
        listOwned,
        recordTerminalProof: async (arg) => { calls.recordTerminalProof.push(arg); return { receiptId: "r-1" }; },
      },
      proofOutbox: {
        recordDebt: async (arg) => { calls.recordDebt.push(arg); },
        enqueue: async (arg) => { calls.enqueue.push(arg); },
      },
      readLedger: ledger,
      run: { runId: "run-1", pid: 4242, asyncDir: "/tmp/async/run-1" },
      proof: { state: "observed", conflict: false, runnerProcessInstanceId: "" },
      proofId: "p".repeat(64),
      proofOwnerScope: { kind: "standalone-subagent", rootSessionId: "root-1" },
      rootSessionId: "root-1",
      buildTerminalProof: buildTerminalProof ?? ((workspaceId) => ({
        state: "observed",
        conflict: false,
        runId: "run-1",
        rootSessionId: "root-1",
        asyncDir: "/tmp/async/run-1",
        processInstance: "4242",
        proofId: "p".repeat(64),
        workspaceId,
      })),
    },
  };
}

test("deliveryOutcome 显式透传 not-applicable，不降级为 debt", () => {
  assert.equal(typeof deliveryOutcome, "function", "deliveryOutcome 必须已导出");
  assert.deepEqual(
    deliveryOutcome({ state: "not-applicable", reason: "run owns no managed workspace" }),
    { state: "not-applicable", reason: "run owns no managed workspace" },
  );
  const blank = deliveryOutcome({ state: "not-applicable", reason: "   " });
  assert.equal(blank.state, "not-applicable");
  assert.ok(blank.reason.trim().length > 0);
});

test("deliveryOutcome 对未知状态仍 fail closed 为 debt", () => {
  assert.equal(deliveryOutcome({ state: "bogus" }).state, "debt");
  assert.equal(deliveryOutcome(undefined).state, "debt");
  assert.equal(deliveryOutcome({ state: "delivered", receipt: { a: 1 } }).state, "delivered");
});

test("listOwned 返回空数组 → not-applicable，不写 debt", async () => {
  const { calls, deps } = makeDeps({ listOwned: async () => [], ledger: () => [] });
  const out = await classifyTerminalProofBinding(deps);
  assert.equal(out.state, "not-applicable");
  assert.deepEqual(calls.recordDebt, []);
  assert.deepEqual(calls.enqueue, []);
  assert.deepEqual(calls.recordTerminalProof, []);
});

test("恰好一个绑定 → 投递，且 proof 字段集与改动前完全一致", async () => {
  const { calls, deps } = makeDeps({ listOwned: async () => [{ workspaceId: "w-1" }], ledger: () => [] });
  const out = await classifyTerminalProofBinding(deps);
  assert.equal(out.state, "delivered");
  assert.deepEqual(out.receipt, { receiptId: "r-1" });
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.recordTerminalProof.length, 1);
  assert.deepEqual(calls.recordDebt, []);

  // proof 本体不得被塞入 workspaceId；enqueue 入参才在外层展开它
  const recorded = calls.recordTerminalProof[0];
  assert.deepEqual(Object.keys(recorded.proof).sort(), PROOF_KEYS);
  assert.equal("workspaceId" in recorded.proof, false, "proof 内不得出现 workspaceId");
  assert.equal(recorded.workspaceId, "w-1");
  assert.deepEqual(recorded.ownerScope, { kind: "standalone-subagent", rootSessionId: "root-1" });

  const enqueued = calls.enqueue[0];
  assert.deepEqual(Object.keys(enqueued).sort(), [...PROOF_KEYS, "ownerScope", "workspaceId"].sort());
  assert.equal(enqueued.workspaceId, "w-1");
});

test("processInstance 优先取 runnerProcessInstanceId，否则 String(run.pid)", async () => {
  const { calls: c1, deps: d1 } = makeDeps({ listOwned: async () => [{ workspaceId: "w-1" }], ledger: () => [] });
  d1.proof = { state: "observed", conflict: false, runnerProcessInstanceId: "incarnation-9" };
  await classifyTerminalProofBinding(d1);
  assert.equal(c1.recordTerminalProof[0].proof.processInstance, "incarnation-9");

  const { calls: c2, deps: d2 } = makeDeps({ listOwned: async () => [{ workspaceId: "w-1" }], ledger: () => [] });
  await classifyTerminalProofBinding(d2);
  assert.equal(c2.recordTerminalProof[0].proof.processInstance, "4242");
});

const ILLEGAL = [
  ["null", async () => null],
  ["字符串", async () => "w-1"],
  ["元素缺 workspaceId", async () => [{}]],
  ["workspaceId 为空串", async () => [{ workspaceId: "" }]],
  ["多条匹配", async () => [{ workspaceId: "w-1" }, { workspaceId: "w-2" }]],
];

test("非法或歧义的 listOwned 结果一律 fail closed 为 debt", async () => {
  for (const [label, listOwned] of ILLEGAL) {
    const { calls, deps } = makeDeps({ listOwned, ledger: () => [] });
    const out = await classifyTerminalProofBinding(deps);
    assert.equal(out.state, "debt", `输入=${label}`);
    assert.equal(calls.recordDebt.length, 1, `输入=${label}`);
    assert.equal(calls.recordDebt[0].reason, "trusted run binding is unavailable");
    assert.deepEqual(calls.enqueue, [], `输入=${label} 不得投递`);
  }
});

test("listOwned 抛错时按 ledger 结果分类，ledger 非法则 fail closed", async () => {
  const boom = async () => { throw new Error("coordinator unavailable"); };

  const empty = makeDeps({ listOwned: boom, ledger: () => [] });
  assert.equal((await classifyTerminalProofBinding(empty.deps)).state, "not-applicable");
  assert.deepEqual(empty.calls.recordDebt, []);

  const one = makeDeps({ listOwned: boom, ledger: () => [{ workspaceId: "w-9", run: { runId: "run-1" } }] });
  assert.equal((await classifyTerminalProofBinding(one.deps)).state, "delivered");

  const two = makeDeps({ listOwned: boom, ledger: () => [{ workspaceId: "w-1" }, { workspaceId: "w-2" }] });
  assert.equal((await classifyTerminalProofBinding(two.deps)).state, "debt");
  assert.equal(two.calls.recordDebt.length, 1);

  const throws = makeDeps({ listOwned: boom, ledger: () => { throw new Error("ledger unreadable"); } });
  assert.equal((await classifyTerminalProofBinding(throws.deps)).state, "debt");

  const illegal = makeDeps({ listOwned: boom, ledger: () => "not-an-array" });
  assert.equal((await classifyTerminalProofBinding(illegal.deps)).state, "debt");
});

test("投递失败时返回 pending 而非 debt（既有语义不变）", async () => {
  const { calls, deps } = makeDeps({ listOwned: async () => [{ workspaceId: "w-1" }], ledger: () => [] });
  deps.client.recordTerminalProof = async () => { throw new Error("coordinator refused"); };
  const out = await classifyTerminalProofBinding(deps);
  assert.equal(out.state, "pending");
  assert.equal(out.reason, "coordinator refused");
  assert.equal(calls.enqueue.length, 1, "durability-first：enqueue 必须先于 coordinator 调用");
  assert.deepEqual(calls.recordDebt, []);
});

test("buildTerminalProof 是必填依赖，缺失时立即抛错而非使用默认形状", async () => {
  const { deps } = makeDeps({ listOwned: async () => [{ workspaceId: "w-1" }], ledger: () => [] });
  delete deps.buildTerminalProof;
  await assert.rejects(classifyTerminalProofBinding(deps), /buildTerminalProof/);
});
```

- [ ] **步骤 4：运行确认 RED**

运行：`node --test test/subagent-proof-binding-classification.test.mjs`

预期：FAIL，且必须是**断言级**失败：
- `deliveryOutcome` 的两个测试因 `typeof deliveryOutcome === "undefined"` 的断言失败（不是 `TypeError: deliveryOutcome is not a function`）——若出现 TypeError，说明步骤 3 的 `assert.equal(typeof ..., "function")` 前置断言没生效，先修测试
- `classifyTerminalProofBinding` 相关测试因该导出尚不存在而失败

这是本任务新增两个导出的预期 RED 形态；除这两处外不得有其他 import 级失败。

- [ ] **步骤 5：最小实现——扩展 outcome 联合类型并导出 deliveryOutcome**

在 `root-broker-server.ts` 中，把 `TerminalProofDeliveryOutcome` 改为：

```ts
export type TerminalProofDeliveryOutcome =
  | { state: "delivered"; receipt: unknown }
  | { state: "pending"; reason: string }
  | { state: "not-applicable"; reason: string }
  | { state: "debt"; reason: string };
```

把 `function deliveryOutcome(...)` 改为 `export function deliveryOutcome(...)`，并在 `debt` 分支**之前**插入：

```ts
  // run 本来就没有 managed workspace（worktree:false 默认路径）不是债务。
  // 必须显式识别，否则会被末尾的 fail-closed 分支重新降级成 debt，
  // 使 classifyTerminalProofBinding 的分类完全失效。
  if (value?.state === "not-applicable") {
    return {
      state: "not-applicable",
      reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : "run owns no managed workspace",
    };
  }
```

`deliveryOutcome` 的其余分支与末尾 fail-closed 返回**保持原样**。该导出仅供测试与同 package 内消费，**不得**加入 `package.json` 的 `exports` 映射。

- [ ] **步骤 6：最小实现——分类函数（fail closed）**

在 `extensions/subagent-runtime.ts` 中新增具名导出，位置放在文件顶部 import 区块之后、`export default function subagentRuntime` 之前（**不得插入步骤 1 列出的任何批次 hunk 区间内**）：

```ts
export type TerminalProofBindingDeps = {
  client: {
    listOwned(input: { runId: string }): Promise<unknown>;
    recordTerminalProof(input: any): Promise<any>;
  };
  proofOutbox: { recordDebt(input: any): Promise<any>; enqueue(input: any): Promise<any> };
  readLedger(): unknown;
  run: { runId: string; pid?: number; asyncDir?: string };
  proof: any;
  proofId: string;
  proofOwnerScope: any;
  rootSessionId?: string;
  // 必填：proof 字段集是 workspace ledger v2 的身份契约，不允许有默认兜底形状
  buildTerminalProof(workspaceId: string): any;
};

type BindingResolution =
  | { kind: "bound"; workspaceId: string }
  | { kind: "none" }
  | { kind: "unknown" };

// 只有「查询成功且结构合法」才可能得到 bound/none；
// 非数组、元素非法、多条匹配一律 unknown，由调用方 fail closed 记为 debt。
function resolveBinding(entries: unknown): BindingResolution {
  if (!Array.isArray(entries)) return { kind: "unknown" };
  const ids: unknown[] = entries.map((entry) =>
    entry && typeof entry === "object" ? (entry as { workspaceId?: unknown }).workspaceId : undefined);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) return { kind: "unknown" };
  if (ids.length === 1) return { kind: "bound", workspaceId: ids[0] as string };
  if (ids.length === 0) return { kind: "none" };
  return { kind: "unknown" };
}

export async function classifyTerminalProofBinding(deps: TerminalProofBindingDeps) {
  const { client, proofOutbox, run, proofId, proofOwnerScope } = deps;
  if (typeof deps.buildTerminalProof !== "function") {
    throw new Error("classifyTerminalProofBinding requires deps.buildTerminalProof");
  }

  let resolution: BindingResolution;
  try {
    resolution = resolveBinding(await client.listOwned({ runId: run.runId }));
  } catch {
    // 传输失败不等于「无绑定」：ledger 仍是 workspace/run 配对的权威来源。
    // ledger 也失败或结构非法时判为 unknown，绝不推断成 none。
    try {
      resolution = resolveBinding(deps.readLedger());
    } catch {
      resolution = { kind: "unknown" };
    }
  }

  if (resolution.kind === "none") {
    // worktree:false 是默认派发路径，这类 run 合法地不拥有 workspace。
    // 记为 debt 会让每个普通派发都留下永久无法结算的债务记录。
    return { state: "not-applicable" as const, reason: "run owns no managed workspace" };
  }
  if (resolution.kind === "unknown") {
    const reason = "trusted run binding is unavailable";
    await proofOutbox.recordDebt({ proofId, runId: run.runId, reason });
    return { state: "debt" as const, reason };
  }

  const workspaceId = resolution.workspaceId;
  const terminalProof = deps.buildTerminalProof(workspaceId);
  // durability-first：crash 发生在 coordinator 回复之前时不得丢失已接受的终态
  await proofOutbox.enqueue({ ...terminalProof, workspaceId, ownerScope: proofOwnerScope });
  try {
    const receipt = await client.recordTerminalProof({ workspaceId, ownerScope: proofOwnerScope, proof: terminalProof });
    return { state: "delivered" as const, receipt };
  } catch (error) {
    return { state: "pending" as const, reason: error instanceof Error && error.message ? error.message : String(error) };
  }
}
```

注意 `resolveBinding` 对 ledger 记录同样适用：ledger 元素必须有非空 `workspaceId` 字段，否则 `unknown`。调用方 `readLedger()` 负责先按 `record.run?.runId === run.runId` 过滤。

- [ ] **步骤 7：把 `broker.recordTerminalProof` 改为委派**

按符号定位 `broker.recordTerminalProof = async (run, proof)`，把函数体替换为：

```ts
    broker.recordTerminalProof = async (run, proof): Promise<TerminalProofDeliveryOutcome> => {
      const proofId = rootBrokerTerminalProofId(proof);
      return classifyTerminalProofBinding({
        client,
        proofOutbox,
        run,
        proof,
        proofId,
        proofOwnerScope,
        rootSessionId: broker.rootSessionId,
        readLedger: () => createManagedWorkspaceLedger({ stateRoot: metadata.canonicalStateRoot })
          .listScoped({ owner: proofOwnerScope })
          .filter((record: any) => record.run?.runId === run.runId),
        // workspace ledger v2 要求完全一致的 proof 身份；字段不得增删，
        // workspaceId 只在 enqueue 层展开，不进入 proof 本体。
        buildTerminalProof: () => ({
          state: "observed",
          conflict: false,
          runId: run.runId,
          rootSessionId: broker.rootSessionId,
          asyncDir: run.asyncDir,
          processInstance: typeof proof.runnerProcessInstanceId === "string" && proof.runnerProcessInstanceId
            ? proof.runnerProcessInstanceId
            : String(run.pid),
          proofId,
        }),
      });
    };
```

同时删除原函数体内的 `ledgerBinding()` 局部函数、`let workspaceId` 声明与其后的 `if (typeof workspaceId !== "string" || !workspaceId)` 分支（语义已由 `classifyTerminalProofBinding` 承担）。原注释「A coordinator transport failure is not an unresolved binding…」移到 `classifyTerminalProofBinding` 的 catch 分支处保留。

**注意 `buildTerminalProof` 的签名接受 `workspaceId` 但本调用点不使用它**——这是有意的：proof 本体不含 `workspaceId`。若 typecheck 因未使用参数报错，改名为 `_workspaceId` 或在实现中省略参数名，**不得**把 `workspaceId` 加进返回对象。

- [ ] **步骤 8：运行确认 GREEN**

运行：`node --test test/subagent-proof-binding-classification.test.mjs`

预期：PASS，9 个测试全绿。

- [ ] **步骤 9：复核 hunk 未波及批次改动**

重跑步骤 1 的命令，逐条比对批次既有 hunk 是否仍存在且区间不变。若不一致，停止并报告。

- [ ] **步骤 10：运行本任务相关回归**

运行：

```bash
node --test test/root-subagent-broker.test.mjs test/root-subagent-broker-protocol.test.mjs \
  test/managed-workspace-terminal-proof.test.mjs test/managed-workspace-terminal-proof-handoff.integration.mjs \
  test/durable-lifecycle.test.mjs test/subagent-runtime-membrane.test.mjs \
  test/package-orphan-export-guard.test.mjs
npm run typecheck
```

预期：全部 PASS。若 `root-broker-server.ts:670-708` 区间的 `terminalProofDelivery` 写入/读取点对 `not-applicable` 有额外语义需求（例如 `:702` 的读取方会把它误判为待恢复），**不要自行扩大改动**：把实际断言失败原文记入任务报告并用 `contact_supervisor` 请求裁决。

- [ ] **步骤 11：记录遗留债务的处置建议（不在本任务执行）**

本任务只阻止**新增**误判债务，不清理既有 492 条。在任务报告中写明：既有 debt 记录的清理需要独立授权与独立任务，且必须先重启相关 host（现场由 pid 85087 维护，运行的是 lifecycle 批次完成前 28 小时的代码），否则旧代码会继续写入。**本任务不得触碰 `var/workspaces/` 下任何文件。**

---

### Task 8：Git 失败原因分类透传（不再只回 "failed"）

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`
- `test/managed-workspace-git-diagnostics.test.mjs`
- `test/managed-workspace-contract.test.mjs`（仅当步骤 9 发现其断言匹配旧的 `MANAGED_WORKSPACE_GIT` 全文时才需修改；与 T6 共享，受 `managed-workspace-contract-test` 资源锁约束）

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/git-worktree.ts` 的 `ManagedWorkspaceError` 类、`failure()`、`git`/`gitRaw` 两个 runner，以及 `git worktree remove` 的调用点（按符号定位：搜索 `["worktree", "remove"`）
- Test：`test/managed-workspace-git-diagnostics.test.mjs`

**接口契约：**
- Consumes：`ManagedWorkspaceError(code, message, cause)` 现有构造；`execFileSync` 抛出的 `cause`（含 `stderr`、`status`）；`tool.ts:87-88` 的 detail 透传
- Produces：
  - `ManagedWorkspaceError` 新增**正式类字段** `detail?: GitFailureDetail`，构造函数新增可选第四参 `detail`（不是动态挂载，见审阅意见 H5）
  - 新增导出类型与函数：
    ```ts
    export type GitFailureCategory =
      | "locked" | "sequencer-in-progress" | "path-missing"
      | "unmerged-entries" | "submodule-dirty"
      | "dirty-worktree" | "untracked-files" | "ignored-runtime-artifacts"
      | "unknown";
    export type GitFailureDetail = {
      readonly category: GitFailureCategory;      // 主因，取 categories[0]
      readonly categories: readonly GitFailureCategory[];  // 全部命中，按优先级排序
      readonly gitStderr: string;                 // bounded + 脱敏
      readonly porcelain?: string;                // bounded + 脱敏；仅失败路径补采时有值
      readonly gitStatus?: number;
      readonly args: readonly string[];           // 已脱敏
    };
    export function redactGitText(raw: string, extraRoots?: readonly string[]): string;
    export function classifyGitFailure(input: {
      args: readonly string[];
      cause: unknown;
      porcelain?: string;
      submodulePaths?: readonly string[];
      extraRedactRoots?: readonly string[];
    }): GitFailureDetail;
    ```
  - `MANAGED_WORKSPACE_GIT` 的 message 形如
    `git <已脱敏 args> failed; category=<主因>; all=[<全部命中>]; git said: <bounded 脱敏 stderr>`，
    并在补采到 porcelain 时追加 `; worktree state: <bounded 脱敏 porcelain>`
  - **分类粒度以可区分性为上限**：`git worktree remove` 对不干净工作树只输出一句合并文案 `contains modified or untracked files`，单看 stderr **无法**区分 modified 与 untracked，因此 dirty / untracked / ignored / submodule 四类必须来自补采的 porcelain，不得从 stderr 猜测

**验收标准：**
1. `classifyGitFailure` 对步骤 2 列出的全部输入返回期望的 `category` 与 `categories`
2. 未提供 porcelain 时，`contains modified or untracked files` 只归为 `dirty-worktree`（**不得**猜成 `untracked-files`），因为 stderr 本身不区分
3. 提供 porcelain 时能正确区分 ` M <file>` → `dirty-worktree`、`?? <file>` → `untracked-files`、`!! <file>` → `ignored-runtime-artifacts`、` M <submodulePath>` → `submodule-dirty`、`UU/AA/...` → `unmerged-entries`
4. 多重命中时 `categories` 按固定优先级返回全部，`category === categories[0]`；现场真实组合（` M sub2api` + `?? docs/reports/x.md`）返回 `["submodule-dirty","untracked-files"]`
5. 脱敏：`message` 与 `detail` 中均不出现 `/Users/<name>`、`/home/<name>`、`/private/var/folders/...`、`/var/folders/...` 前缀的绝对路径，不出现 `managed-workspace-{owner,action,lease}.v1:<值>`；**`args` 同样脱敏**（审阅意见 H4：`git worktree remove <绝对路径>` 的 args 本身就是泄漏面）
6. stderr 与 porcelain 均截断到 512 字节以内，截断时带 `…[truncated]` 标记
7. `category === "unknown"` 时**仍然透传** bounded stderr（这是本次调查的核心教训：`unknown` 不等于「不给出 git 的原始输出」）
8. Git 命令成功路径的行为与返回值逐位不变
9. `npm run typecheck` PASS

**背景事实（执行者必读）：** 现场 5 次 `git worktree remove` 失败，错误文本一律为 `MANAGED_WORKSPACE_GIT: git worktree remove <path> failed`，无任何原因。事后只读取证：`c161c5e9` 与 `5c1844c9` 为 ` M sub2api`（submodule gitlink 变更），`3b8d0a57` tracked 干净但 `git status --ignored --untracked-files=all` 显示 `!! .pi/subagents/artifacts/*_meta.json`、`*_output.md`（**runtime 自产产物**），`6686ea46` 至今真因未证实——因为 stderr 在 `git-worktree.ts:44-49` 被丢弃，而仓库铁律又禁止手工 `git worktree remove` 去复现。**信息丢失在此不是体验问题，它销毁了唯一的诊断证据。**

- [ ] **步骤 1：确认错误类与 detail 透传链**

运行：

```bash
sed -n '20,60p' packages/pi-subagents-enhanced/src/workspace/git-worktree.ts
grep -n "detail" packages/pi-subagents-enhanced/src/workspace/tool.ts | head
grep -n '\["worktree", "remove"' packages/pi-subagents-enhanced/src/workspace/git-worktree.ts
```

确认三件事并记入任务报告：
1. `ManagedWorkspaceError` 的当前字段与构造签名（审阅已核实为 `code: string; cause?: unknown; constructor(code, message, cause?)`）
2. `tool.ts:87-88` 透传的是 error 的哪个字段名（本任务以该字段名为准命名 `detail`；若实际字段名不同，改用实际名并同步本任务全部代码与测试）
3. `git worktree remove` 的调用点行号与其外层是否有 try/catch

- [ ] **步骤 2：编写失败测试**

创建 `test/managed-workspace-git-diagnostics.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { classifyGitFailure, redactGitText } = await jiti.import(
  "../packages/pi-subagents-enhanced/src/workspace/git-worktree.ts",
);

function causeWith(stderr, status = 128) {
  const error = new Error("git failed");
  error.stderr = stderr;
  error.status = status;
  return error;
}
const REMOVE = ["worktree", "remove", "/Users/someone/pi-config/var/workspaces/repositories/aa/worktrees/wt-1"];

// 只有 stderr 时：remove 把 modified 与 untracked 合并成一句，不得猜测细分
test("仅凭 stderr 时，contains modified or untracked files 归为 dirty-worktree", () => {
  const d = classifyGitFailure({
    args: REMOVE,
    cause: causeWith("fatal: '/tmp/wt-1' contains modified or untracked files, use --force to delete it\n"),
  });
  assert.equal(d.category, "dirty-worktree");
  assert.deepEqual([...d.categories], ["dirty-worktree"]);
  assert.equal(d.porcelain, undefined);
});

// stderr 能确定的结构性原因优先于内容类原因
const STDERR_CASES = [
  ["fatal: Unable to create '/tmp/x/.git/index.lock': File exists.\n", "locked"],
  ["fatal: '/tmp/wt-1' is already locked\n", "locked"],
  ["fatal: '/tmp/wt-1' does not exist\n", "path-missing"],
  ["fatal: could not read '.git/worktrees/x/HEAD': No such file or directory\n", "path-missing"],
  ["error: interactive rebase is ongoing\n", "sequencer-in-progress"],
  ["fatal: cannot rebase: you have unstaged changes\nrebase-merge directory exists\n", "sequencer-in-progress"],
];
test("stderr 可确定的结构性原因优先归类", () => {
  for (const [stderr, expected] of STDERR_CASES) {
    const d = classifyGitFailure({ args: REMOVE, cause: causeWith(stderr) });
    assert.equal(d.category, expected, `stderr=${JSON.stringify(stderr)} → 期望 ${expected}，实际 ${d.category}`);
  }
});

// porcelain 才能区分内容类原因
const PORCELAIN_CASES = [
  [" M src/a.ts\n", [], "dirty-worktree"],
  ["?? docs/new.md\n", [], "untracked-files"],
  ["!! .pi/subagents/artifacts/x_meta.json\n", [], "ignored-runtime-artifacts"],
  [" M sub2api\n", ["sub2api"], "submodule-dirty"],
  ["UU src/conflict.ts\n", [], "unmerged-entries"],
  ["AA src/both-added.ts\n", [], "unmerged-entries"],
];
test("porcelain 提供时正确区分内容类原因", () => {
  for (const [porcelain, submodulePaths, expected] of PORCELAIN_CASES) {
    const d = classifyGitFailure({
      args: REMOVE,
      cause: causeWith("fatal: '/tmp/wt-1' contains modified or untracked files, use --force to delete it\n"),
      porcelain,
      submodulePaths,
    });
    assert.equal(d.category, expected, `porcelain=${JSON.stringify(porcelain)} → 期望 ${expected}，实际 ${d.category}`);
    assert.ok(d.porcelain && d.porcelain.length > 0, "porcelain 应被透传");
  }
});

test("多重命中按优先级返回全部，category 是 categories[0]（复现现场真实组合）", () => {
  const d = classifyGitFailure({
    args: REMOVE,
    cause: causeWith("fatal: '/tmp/wt-1' contains modified or untracked files, use --force to delete it\n"),
    porcelain: " M sub2api\n?? docs/reports/2026-09-20-v0.2.7-qoder-rebuild-log.md\n",
    submodulePaths: ["sub2api"],
  });
  assert.deepEqual([...d.categories], ["submodule-dirty", "untracked-files"]);
  assert.equal(d.category, "submodule-dirty");
});

test("submodule 路径未知时， M <path> 退化为 dirty-worktree，不冒充 submodule 结论", () => {
  const d = classifyGitFailure({
    args: REMOVE,
    cause: causeWith("fatal: contains modified or untracked files\n"),
    porcelain: " M sub2api\n",
    submodulePaths: [],
  });
  assert.equal(d.category, "dirty-worktree");
});

test("ignored 与其他阻断原因共存时，ignored 排在后面", () => {
  const d = classifyGitFailure({
    args: REMOVE,
    cause: causeWith("fatal: contains modified or untracked files\n"),
    porcelain: "!! .pi/subagents/artifacts/x_meta.json\n M src/a.ts\n",
  });
  assert.deepEqual([...d.categories], ["dirty-worktree", "ignored-runtime-artifacts"]);
});

test("unknown 仍透传 bounded stderr，不丢弃证据", () => {
  const d = classifyGitFailure({ args: REMOVE, cause: causeWith("fatal: something entirely new\n") });
  assert.equal(d.category, "unknown");
  assert.deepEqual([...d.categories], ["unknown"]);
  assert.ok(d.gitStderr.includes("something entirely new"), `实际=${JSON.stringify(d.gitStderr)}`);
});

test("cause 缺失或非 Error 时 fail safe 为 unknown 且 stderr 有占位说明", () => {
  for (const cause of [undefined, "plain string", {}, new Error("no stderr")]) {
    const d = classifyGitFailure({ args: REMOVE, cause });
    assert.equal(d.category, "unknown");
    assert.ok(d.gitStderr.length > 0);
  }
});

test("args 与 stderr 均脱敏：主目录、临时目录、token", () => {
  const stderr = [
    "fatal: '/Users/someone/secret/repo/wt' contains modified files",
    "managed-workspace-owner.v1:" + "a".repeat(64),
    "managed-workspace-action.v1:" + "b".repeat(64),
    "tmp dir /private/var/folders/27/6bnn/T/x",
  ].join("\n");
  const d = classifyGitFailure({ args: REMOVE, cause: causeWith(stderr) });
  const blob = JSON.stringify(d);
  assert.equal(/\/Users\/[A-Za-z0-9._-]+/.test(blob), false, "不得出现 /Users/<name>");
  assert.equal(/\/home\/[A-Za-z0-9._-]+/.test(blob), false, "不得出现 /home/<name>");
  assert.equal(/\/(private\/)?var\/folders\/[A-Za-z0-9._-]+/.test(blob), false, "不得出现 var/folders 临时目录");
  assert.equal(/managed-workspace-(owner|action|lease)\.v1:[A-Za-z0-9]{16,}/.test(blob), false, "不得出现 token 值");
  assert.match(blob, /managed-workspace-(owner|action)\.v1:\[redacted\]/);
  assert.equal(d.args.some((a) => a.includes("/Users/someone")), false, "args 必须同样脱敏");
});

test("redactGitText 支持调用方追加敏感根路径", () => {
  const out = redactGitText("fatal: '/opt/state/repositories/aa/worktrees/wt' is dirty", ["/opt/state"]);
  assert.equal(out.includes("/opt/state"), false);
  assert.match(out, /<redacted-root>/);
});

test("stderr 与 porcelain 均截断到 512 字节以内并带标记", () => {
  const d = classifyGitFailure({
    args: REMOVE,
    cause: causeWith("x".repeat(5000)),
    porcelain: "y".repeat(5000),
  });
  assert.ok(Buffer.byteLength(d.gitStderr, "utf8") <= 512, `stderr ${Buffer.byteLength(d.gitStderr, "utf8")} 字节`);
  assert.ok(Buffer.byteLength(d.porcelain ?? "", "utf8") <= 512, `porcelain ${Buffer.byteLength(d.porcelain ?? "", "utf8")} 字节`);
  assert.match(d.gitStderr, /truncated/);
  assert.match(d.porcelain ?? "", /truncated/);
});

test("脱敏不得切断多字节字符产生乱码", () => {
  const out = redactGitText("错误信息".repeat(400));
  assert.equal(out.includes("\uFFFD"), false, "不得残留替换字符");
  assert.ok(Buffer.byteLength(out, "utf8") <= 512);
});
```

- [ ] **步骤 3：运行确认 RED**

运行：`node --test test/managed-workspace-git-diagnostics.test.mjs`

预期：FAIL，`classifyGitFailure` 与 `redactGitText` 均未导出（import 得到 `undefined`，调用抛 `TypeError`）。这是本任务新增导出的预期 RED 形态；除此之外不得有其他 import 级失败。

- [ ] **步骤 4：最小实现——扩展错误类（正式字段，非动态挂载）**

把 `ManagedWorkspaceError` 改为（保留既有字段与前三参语义）：

```ts
class ManagedWorkspaceError extends Error {
  code: string;
  cause?: unknown;
  detail?: GitFailureDetail;

  constructor(code: string, message: string, cause?: unknown, detail?: GitFailureDetail) {
    super(message);
    this.name = "ManagedWorkspaceError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (detail !== undefined) this.detail = detail;
  }
}

function failure(code: string, message: string, cause?: unknown, detail?: GitFailureDetail): ManagedWorkspaceError {
  return new ManagedWorkspaceError(code, message, cause, detail);
}
```

若步骤 1 发现 `tool.ts` 透传的字段名不是 `detail`，则把本任务全部 `detail` 改名为该实际字段名（类型与测试同步）。

- [ ] **步骤 5：最小实现——脱敏与分类**

在 `failure()` 之后新增：

```ts
const GIT_TEXT_MAX_BYTES = 512;
const TOKEN_PATTERN = /managed-workspace-(?:owner|action|lease)\.v1:[A-Za-z0-9._:-]+/g;
const HOME_PATTERN = /\/(?:Users|home)\/[^/\s'"]+/g;
const TMPDIR_PATTERN = /\/(?:private\/)?var\/folders\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?/g;

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  const budget = maxBytes - "…[truncated]".length;
  let end = budget;
  // 回退到 UTF-8 字符边界，避免切断多字节字符产生 U+FFFD
  while (end > 0 && (bytes[end]! & 0xC0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…[truncated]`;
}

export function redactGitText(raw: string, extraRoots: readonly string[] = []): string {
  let text = raw.replace(TOKEN_PATTERN, (match) => `${match.split(":")[0]}:[redacted]`);
  for (const root of extraRoots) {
    if (typeof root === "string" && root.length > 1) text = text.split(root).join("<redacted-root>");
  }
  text = text.replace(TMPDIR_PATTERN, "<tmp>");
  text = text.replace(HOME_PATTERN, "~");
  return truncateUtf8(text.trim(), GIT_TEXT_MAX_BYTES);
}

// 分类优先级：结构性原因（git 自己在 stderr 明说）优先于内容类原因；
// 内容类原因之间按「越具体越靠前」排序。
const STDERR_RULES: ReadonlyArray<readonly [RegExp, GitFailureCategory]> = [
  [/Unable to create '[^']*index\.lock': File exists/i, "locked"],
  [/is already locked/i, "locked"],
  [/interactive rebase is ongoing|rebase-merge|rebase-apply|cherry-pick is in progress/i, "sequencer-in-progress"],
  [/does not exist|No such file or directory/i, "path-missing"],
];

const UNMERGED_XY = new Set(["AA", "AU", "UA", "UU", "DU", "UD", "DD"]);

function classifyPorcelain(porcelain: string, submodulePaths: readonly string[]): GitFailureCategory[] {
  const hits = new Set<GitFailureCategory>();
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const marker = line.slice(0, 2);
    const entryPath = line.slice(3).trim().replace(/^"|"$/g, "");
    if (UNMERGED_XY.has(marker)) { hits.add("unmerged-entries"); continue; }
    if (marker.startsWith("!!")) { hits.add("ignored-runtime-artifacts"); continue; }
    if (marker.startsWith("??")) { hits.add("untracked-files"); continue; }
    const isSubmodule = submodulePaths.some((sub) => entryPath === sub || entryPath.startsWith(`${sub}/`));
    if (isSubmodule) { hits.add("submodule-dirty"); continue; }
    if (marker.includes("M") || marker.includes("A") || marker.includes("D") || marker.includes("R")) {
      hits.add("dirty-worktree");
    }
  }
  const order: GitFailureCategory[] = [
    "unmerged-entries", "submodule-dirty", "dirty-worktree", "untracked-files", "ignored-runtime-artifacts",
  ];
  return order.filter((category) => hits.has(category));
}

export function classifyGitFailure(input: {
  args: readonly string[];
  cause: unknown;
  porcelain?: string;
  submodulePaths?: readonly string[];
  extraRedactRoots?: readonly string[];
}): GitFailureDetail {
  const { args, cause, porcelain, submodulePaths = [], extraRedactRoots = [] } = input;
  const rawStderr = typeof (cause as { stderr?: unknown })?.stderr === "string"
    ? (cause as { stderr: string }).stderr
    : typeof (cause as { message?: unknown })?.message === "string"
      ? (cause as { message: string }).message
      : "";
  const gitStderr = rawStderr.trim() ? redactGitText(rawStderr, extraRedactRoots) : "(git produced no stderr)";
  const gitStatus = typeof (cause as { status?: unknown })?.status === "number"
    ? (cause as { status: number }).status : undefined;

  const categories: GitFailureCategory[] = [];
  for (const [pattern, category] of STDERR_RULES) {
    if (pattern.test(rawStderr)) { categories.push(category); break; }
  }
  // 只有 stderr 说「modified or untracked」这类合并文案、且没有结构性原因时，
  // 内容类细分必须来自 porcelain；没有 porcelain 就只给 dirty-worktree，不猜 untracked。
  const hasPorcelain = typeof porcelain === "string" && porcelain.trim().length > 0;
  if (hasPorcelain) categories.push(...classifyPorcelain(porcelain!, submodulePaths));
  else if (categories.length === 0 && /modified or untracked|contains modified|Directory not empty/i.test(rawStderr)) {
    categories.push("dirty-worktree");
  }
  if (categories.length === 0) categories.push("unknown");

  const detail: GitFailureDetail = Object.freeze({
    category: categories[0]!,
    categories: Object.freeze([...categories]),
    gitStderr,
    ...(hasPorcelain ? { porcelain: redactGitText(porcelain!, extraRedactRoots) } : {}),
    ...(gitStatus === undefined ? {} : { gitStatus }),
    args: Object.freeze(args.map((arg) => redactGitText(arg, extraRedactRoots))),
  });
  return detail;
}
```

- [ ] **步骤 6：最小实现——接入两个 runner**

```ts
function gitFailure(args: readonly string[], cause: unknown, detail?: GitFailureDetail): ManagedWorkspaceError {
  const resolved = detail ?? classifyGitFailure({ args, cause });
  const parts = [
    `git ${resolved.args.join(" ")} failed`,
    `category=${resolved.category}`,
    `all=[${resolved.categories.join(",")}]`,
    `git said: ${resolved.gitStderr}`,
  ];
  if (resolved.porcelain) parts.push(`worktree state: ${resolved.porcelain}`);
  return failure("MANAGED_WORKSPACE_GIT", parts.join("; "), cause, resolved);
}

const git: GitRunner = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw gitFailure(args, cause);
  }
};

const gitRaw: GitRunner = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    throw gitFailure(args, cause);
  }
};
```

- [ ] **步骤 7：在 remove 失败路径补采 porcelain（只读，仅失败时执行）**

按步骤 1 定位的 `["worktree", "remove"` 调用点，把它包一层：失败时补跑两条**只读**命令再分类。

```ts
function collectWorktreeDiagnostics(cwd: string, worktreePath: string): { porcelain?: string; submodulePaths: string[] } {
  let submodulePaths: string[] = [];
  try {
    const raw = execFileSync("git", ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    submodulePaths = raw.split("\n").map((line) => line.split(/\s+/)[1]).filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch { /* 无 .gitmodules 或读取失败：按无 submodule 处理 */ }

  let porcelain: string | undefined;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain", "--ignored=matching", "--untracked-files=all"],
      { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch { /* 补采失败时退化为仅 stderr 分类，不得让诊断掩盖原始错误 */ }
  return { porcelain, submodulePaths };
}
```

在 remove 的 catch 中调用它并把结果传给 `classifyGitFailure`，再交给 `gitFailure`。**补采命令必须是只读的**（`git config --get-regexp`、`git status`），禁止 `--force`、`prune`、`repair`、`clean`、`reset`。补采本身失败不得吞掉原始 `cause`。

- [ ] **步骤 8：运行确认 GREEN**

运行：`node --test test/managed-workspace-git-diagnostics.test.mjs`

预期：PASS，12 个测试全绿。

- [ ] **步骤 9：验证 release 路径确实带上了分类**

运行：

```bash
node --test test/managed-workspace-service.integration.mjs \
  test/managed-workspace-git-apply.integration.mjs \
  test/managed-workspace-git-publish.integration.mjs
grep -rn "git worktree remove .* failed\|MANAGED_WORKSPACE_GIT" test/ | grep -v managed-workspace-git-diagnostics | head
```

若既有断言匹配旧的 `git worktree remove <path> failed` 全文，需改为 `assert.match(message, /^MANAGED_WORKSPACE_GIT: git .* failed; category=/)` 并**追加**对 `category` 与 `detail.categories` 的断言，不得删除原断言语义。

区分两类文件：
- `test/managed-workspace-contract.test.mjs` **在本任务 WritePaths 内**，可直接按上述原则修改；但它与 T6 共享，必须持有 `managed-workspace-contract-test` 资源锁才能写入，且只改与 `MANAGED_WORKSPACE_GIT` 文案相关的断言，**不得触碰 T6 负责的状态词表类断言**。
- `test/managed-workspace-service.integration.mjs`、`test/managed-workspace-git-apply.integration.mjs`、`test/managed-workspace-git-publish.integration.mjs` **不在本任务 WritePaths 内**：若它们有断言需同步，把清单（文件:行号 + 旧断言原文 + 建议新断言）写入任务报告并用 `contact_supervisor`（`reason: "need_decision"`）请求扩大 WritePaths，不得自行修改。

- [ ] **步骤 10：运行本任务相关回归**

运行：`npm run test:subagent-workspace && node --test test/managed-workspace-git-diagnostics.test.mjs test/package-orphan-export-guard.test.mjs && npm run typecheck`

预期：全部 PASS。

---

### Task 9：放开 `bash` 声明式 cwd 的工作区限制（方案 A）

**Deps：** `none`

**WritePaths：**
- `src/bash-cwd/policy.ts`
- `src/bash-cwd/extension.ts`
- `pi/extensions/bash-cwd.ts`
- `test/bash-cwd-policy.test.mjs`
- `test/bash-cwd-extension.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`src/bash-cwd/policy.ts:1-34`（整体重写校验语义）
- Modify：`src/bash-cwd/extension.ts:3`（`cwdDescription`）
- Modify：`test/bash-cwd-policy.test.mjs:42+`（反转 "fails closed for paths outside the workspace" 用例）
- Modify：`test/bash-cwd-extension.test.mjs`

**接口契约：**
- Consumes：`validateDeclaredBashCwd({ cwd, workspaceRoot })` 现有签名
- Produces：
  - `validateDeclaredBashCwd` 保留签名与返回类型（`Promise<string>`，返回 canonical 绝对路径），但**移除工作区范围限制**
  - 保留的校验：`cwd` 与 `workspaceRoot` 均为非空字符串；`resolve` 后 `realpath` 成功；`stat` 结果是目录
  - 保留的错误文案：非目录 → `bash cwd 必须是目录`；不存在/无法解析 → `bash cwd 必须是存在的目录`（注意：原文案是「必须是工作区内存在的目录」，去掉「工作区内」以免继续误导）
  - 新增导出 `isWithinWorkspace(parent: string, child: string): boolean`（把原私有 `isWithin` 提为导出），供需要范围判定的调用方自行使用；`validateDeclaredBashCwd` 不再调用它
  - `cwdDescription` 改为准确描述：不再声称「必须在工作区内」

**验收标准：**
1. `validateDeclaredBashCwd({ cwd: "/tmp/<存在的目录>", workspaceRoot: "<repo>" })` 成功返回该目录的 realpath，**不抛错**
2. `cwd` 指向不存在的相对路径时仍抛错，message 含「必须是存在的目录」，且**不含**「工作区内」
3. `cwd` 指向文件（非目录）时仍抛 `bash cwd 必须是目录`
4. `cwd` 或 `workspaceRoot` 为空字符串/非字符串时仍抛错
5. 相对 `cwd` 仍按 `workspaceRoot` 解析（既有行为不变）
6. symlink 仍被 `realpath` 规范化（既有行为不变）
7. `isWithinWorkspace` 导出且行为与原 `isWithin` 一致
8. `extension.ts` 的 `cwdDescription` 不再含「必须在工作区内」；`promptGuidelines` 同步
9. `npm run typecheck` PASS

**决策依据（用户已裁决，执行者不得重新论证）：** 该限制不构成任何 containment 边界——`extension.ts:31` 的 `if (cwd === undefined) return baseDefinition.execute(...)` 意味着不传 `cwd` 参数时完全不做校验，`bash({command:"cd /anywhere && …"})` 可无阻碍访问任意路径。它只对唯一的声明式写法收税，却零安全收益。git 历史证实其意图是新增便利参数（`5fe4b9d feat(bash): 支持声明式 cwd 并保留 compact TUI`），不是 containment。现场实测：377 次拒绝 / 163 个 session 文件 / 2026-08-17 → 09-22 / 至少 6 个项目，是本次调查发现量级最大的 agent 面拒绝来源；而同一轮调查中主 agent 的 143 次 bash 调用有 0 次使用 `cwd` 参数，全部以 `cd` 绕过，从未被拦。

- [ ] **步骤 1：编写失败测试（先反转既有用例）**

在 `test/bash-cwd-policy.test.mjs` 中，把 `:42` 起的 `test("validateDeclaredBashCwd fails closed for paths outside the workspace", ...)` 整体替换为：

```js
test("validateDeclaredBashCwd 接受工作区外的存在目录（限制已放开）", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "bash-cwd-outside-"));
    try {
      assert.equal(await validateDeclaredBashCwd({ cwd: outside, workspaceRoot }), await realpath(outside));
      // 工作区外的相对路径同样按 workspaceRoot 解析后判定存在性，不存在则抛错
      await assert.rejects(
        validateDeclaredBashCwd({ cwd: "../definitely-missing-dir", workspaceRoot }),
        /必须是存在的目录/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("validateDeclaredBashCwd 保留存在性与目录性校验，且文案不再提工作区", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = join(workspaceRoot, "file.txt");
    await writeFile(file, "not a directory");

    await assert.rejects(
      validateDeclaredBashCwd({ cwd: "missing", workspaceRoot }),
      (error) => {
        assert.match(error.message, /必须是存在的目录/);
        assert.equal(error.message.includes("工作区内"), false, "文案不得继续声称有工作区限制");
        return true;
      },
    );
    await assert.rejects(validateDeclaredBashCwd({ cwd: file, workspaceRoot }), /必须是目录/);
    await assert.rejects(validateDeclaredBashCwd({ cwd: "", workspaceRoot }), /必须是存在的目录/);
    await assert.rejects(validateDeclaredBashCwd({ cwd: join(workspaceRoot, "x"), workspaceRoot: "" }), /必须是存在的目录/);
  });
});

test("isWithinWorkspace 作为独立工具函数导出且行为不变", async () => {
  const { isWithinWorkspace } = await import("../src/bash-cwd/policy.ts");
  assert.equal(isWithinWorkspace("/a/b", "/a/b/c"), true);
  assert.equal(isWithinWorkspace("/a/b", "/a/b"), true);
  assert.equal(isWithinWorkspace("/a/b", "/a/x"), false);
  assert.equal(isWithinWorkspace("/a/b", "/etc"), false);
});
```

同时更新 `:26-40` 的既有 `rejects missing paths and files` 用例中的正则：把 `/cwd|目录|存在/i` 收紧为 `/必须是存在的目录/`，把 `/cwd|目录/i` 收紧为 `/必须是目录/`，使断言精确匹配新文案。

在 `test/bash-cwd-extension.test.mjs` 中，把任何断言「工作区外 cwd 被拒」的用例反转为「工作区外 cwd 被接受」，并新增：

```js
test("cwdDescription 不再声称工作区限制", async () => {
  const src = readFileSync(join(repoRoot, "src/bash-cwd/extension.ts"), "utf8");
  assert.equal(src.includes("必须在工作区内"), false);
  assert.match(src, /可选；命令在此目录执行/);
});
```

（该文件已有的 import 与 helper 结构按其现状复用；若缺少 `readFileSync`/`repoRoot`，在文件顶部补上。）

- [ ] **步骤 2：运行确认 RED**

运行：`node --test test/bash-cwd-policy.test.mjs test/bash-cwd-extension.test.mjs`

预期：FAIL。新增的「接受工作区外目录」用例因 `policy.ts:31` 的 `isWithin` 检查抛 `bash cwd 必须位于工作区内` 而失败；`isWithinWorkspace` 未导出导致 import 得到 `undefined`；文案断言因仍含「工作区内」而失败。

- [ ] **步骤 3：最小实现——重写 policy**

把 `src/bash-cwd/policy.ts` 整体替换为：

```ts
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

// 范围判定作为独立工具函数导出，供真正需要 containment 的调用方自行使用。
// validateDeclaredBashCwd 不再调用它：该限制不构成任何边界——不传 cwd 参数时
// 完全不做校验，`cd /anywhere && ...` 亦可无阻碍访问任意路径，
// 因此它只对声明式写法收税而无安全收益（用户已裁决移除）。
export function isWithinWorkspace(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function validateDeclaredBashCwd({ cwd, workspaceRoot }) {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("bash cwd 必须是存在的目录");
  }

  const resolvedCwd = resolve(workspaceRoot, cwd);
  let canonicalCwd;
  try {
    canonicalCwd = await realpath(resolvedCwd);
  } catch {
    throw new Error(`bash cwd 必须是存在的目录：${resolvedCwd} 无法解析`);
  }

  let metadata;
  try {
    metadata = await stat(canonicalCwd);
  } catch {
    throw new Error(`bash cwd 必须是存在的目录：${canonicalCwd} 无法 stat`);
  }
  if (!metadata.isDirectory()) throw new Error(`bash cwd 必须是目录：${canonicalCwd} 不是目录`);

  return canonicalCwd;
}
```

注意：`workspaceRoot` 仍是**相对路径解析基准**，这个语义保留不变；只是不再作为范围上界。`realpath(workspaceRoot)` 调用被移除（不再需要比较），但 `resolve(workspaceRoot, cwd)` 仍要求 `workspaceRoot` 非空——该校验保留。

- [ ] **步骤 4：最小实现——更新描述文本**

把 `src/bash-cwd/extension.ts:3` 的

```ts
const cwdDescription = "可选；命令在此目录执行；必须在工作区内";
```

改为

```ts
const cwdDescription = "可选；命令在此目录执行，相对路径按工作区根解析；必须是已存在的目录";
```

`:29` 的 `promptGuidelines: [...baseGuidelines, cwdDescription]` 无需改动（它引用同一常量）。检查 `pi/extensions/bash-cwd.ts` 是否另有硬编码文案，若有一并同步。

- [ ] **步骤 5：运行确认 GREEN**

运行：`node --test test/bash-cwd-policy.test.mjs test/bash-cwd-extension.test.mjs`

预期：PASS。

- [ ] **步骤 6：全仓扇描旧文案（不只扇生产目录）**

审阅意见 H3：只扇 `src/ pi/ packages/` 会漏掉测试、文档与其他扩展副本里的旧文案断言，留下与新契约冲突的隐藏 RED。先全仓扇描并记录命中清单：

```bash
grep -rn "必须位于工作区内\|必须在工作区内\|工作区内存在的目录" . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=var --exclude-dir=.build
```

对每一处命中逐个判定并处理：
- **生产代码**（`src/`、`pi/`、`packages/`）：必须清零。已知仅 `src/bash-cwd/policy.ts:31` 与 `src/bash-cwd/extension.ts:3` 两处。
- **测试**（`test/`）：断言旧文案的必须同步到新文案（属本任务 WritePaths）。
- **文档**（`docs/`、`README.md`、`skill-overrides/`）：若描述该限制，必须同步；若不在本任务 WritePaths 内，列入任务报告并用 `contact_supervisor` 请示，**不得静默略过也不得自行修改**。

本步骤完成的标准：上述扇描在生产代码与测试中**零命中**，文档命中均有明确处置结论。

同时把「`pi/extensions/bash-cwd.ts` 仅接线 `createBashCwdExtension`、无硬编码 cwd 描述文案」这一核对结果记入任务报告（审阅已初步确认，仍需执行者自行复核）。

- [ ] **步骤 7：运行本任务相关回归**

运行：`node --test test/bash-cwd-policy.test.mjs test/bash-cwd-extension.test.mjs test/package-orphan-export-guard.test.mjs && npm run typecheck && npm run typecheck:subagents-enhanced`

预期：全部 PASS。

- [ ] **步骤 8：记录跨仓库调查任务的正确表达方式（文档，不改代码）**

在任务报告中写明：放开限制后，跨仓库只读调查任务可以直接用 `bash({cwd: "<外部路径>", command: "..."})`，不再需要退化为在 `command` 里写 `cd`。这不改变任何安全边界（边界本来就由 `security-gates.ts` 等承担），只是消除了对声明式写法的单边惩罚。

---

### Task 10：init-pi / external-review 测试期望与 `c35c596` 的删除决策对齐

**Deps：** `none`

**WritePaths：**
- `test/init-pi.test.mjs`
- `test/external-review-config-home.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`test/init-pi.test.mjs:66-69`（复制 4 个 `skill-overrides/external-llm-review/` 文件的 `copyFile` 调用）及该文件中其他引用同目录的位置
- Modify：`test/external-review-config-home.test.mjs`（同类引用）

**接口契约：**
- Consumes：commit `c35c596`（`refactor(skill): 移除 external-llm-review 覆盖目录`）的实际删除范围；`docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md:33,42` 中登记的意图
- Produces：两个测试文件不再引用已删除路径；`init-pi.sh` 的可复现安装契约仍被完整验证（**不得因删除引用而削弱其他断言**）

**验收标准：**
1. `node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs` PASS
2. `grep -rn "external-llm-review" test/` 零命中，或仅存在于**明确断言该目录不应存在**的用例中
3. `init-pi.sh` 的其他可复现性断言（不读 OpenCode 凭据、幂等安装、Pi 版本固定）全部保留
4. 不修改 `init-pi.sh`、不修改 `skill-overrides/`、不恢复已删除目录

- [ ] **步骤 1：确认 `c35c596` 的删除意图已在仓库登记**

运行：

```bash
git show --stat c35c596 | head -25
sed -n '25,50p' docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md
grep -rn "external-llm-review" test/ init-pi.sh scripts/ 2>/dev/null
```

判定规则：
- 若 `c35c596` 的 commit message 或上述 bug 文档附录明确记载「移除该覆盖目录」是有意决策 → 按「更新测试期望以匹配删除」执行步骤 2。
- 若两处都找不到明确意图记载 → **停止**，用 `contact_supervisor`（`reason: "need_decision"`）询问用户 `c35c596` 是有意移除还是误删，保持存活等待回复。不得自行选择「恢复目录」，因为那会修改 `skill-overrides/`（超出本任务 WritePaths）并推翻一个已存在的 commit 决策。

- [ ] **步骤 2：确认当前 RED 形态**

运行：`node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs`

预期：FAIL，`test/init-pi.test.mjs:66` 抛 `ENOENT`（`skill-overrides/external-llm-review/reviewer.py` 不存在）。记录完整错误输出作为 RED 证据。**这是 HEAD 既有失败**（`git archive HEAD` 导出复跑同样失败），不是 lifecycle 批次回归。

- [ ] **步骤 3：最小修复——移除对已删目录的引用（先列保留断言清单）**

审阅意见 M4：「不弱化其它 init-pi 断言」不能只写原则。**先产出保留清单再动手**：

```bash
node --test --test-reporter=tap test/init-pi.test.mjs 2>/dev/null | grep -E "^(ok|not ok)" \
  || grep -nE "^test\(|assert\." test/init-pi.test.mjs | head -60
```

把 `test/init-pi.test.mjs` 与 `test/external-review-config-home.test.mjs` 中**全部断言逐条列出**（文件:行号 + 断言意图），标注每条为 `保留` / `因 c35c596 删除而失效` / `改为反向断言`。该清单写入任务报告，作为步骤 4 GREEN 后的比对基准：`保留` 类断言的数量在修改前后必须相等。

然后执行修改：在 `test/init-pi.test.mjs` 中删除 `:66-69` 这 4 行 `copyFile`（`reviewer.py`、`_config.py`、`_provider.py`、`tests/test_reviewer.py`），并检查该 fixture 后续是否有断言依赖这些被复制的文件（例如断言安装后目标目录含 `reviewer.py`）。若有，一并删除**该特定断言**，但保留同一测试中的其他断言。

在 `test/external-review-config-home.test.mjs` 中做同样处理（审阅已核实其 `:15,25` 也引用了已删目录）。

若某条断言的语义是「external-llm-review 覆盖目录会被安装到 config home」，则改写为反向断言：

```js
// c35c596 已移除 external-llm-review 覆盖目录；安装后不应出现该目录。
assert.equal(existsSync(join(configHome, "skills", "external-llm-review")), false,
  "external-llm-review 覆盖目录已于 c35c596 移除，安装产物中不应出现");
```

- [ ] **步骤 4：运行确认 GREEN**

运行：`node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs`

预期：PASS。

- [ ] **步骤 5：在 HEAD 导出上交叉验证归因**

运行：

```bash
rm -rf /tmp/t10-head-export && mkdir -p /tmp/t10-head-export
git archive HEAD | tar -x -C /tmp/t10-head-export
ln -s "$PWD/node_modules" /tmp/t10-head-export/node_modules
cd /tmp/t10-head-export && node --test test/init-pi.test.mjs 2>&1 | tail -5
```

预期：HEAD 导出**同样失败**且失败点相同，证明这是 HEAD 既有缺陷而非工作树引入。把该输出记入任务报告，然后 `cd` 回仓库根目录。

- [ ] **步骤 6：运行本任务相关回归**

运行：`node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs test/package-orphan-export-guard.test.mjs`

预期：PASS。

---

### Task 11：compat `:244` 归因（只归因，不改生产代码）

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-22-compat-local-package-source-supervisor-target-resolves.md`

**Resources：** `none`

**Files：**
- Create：`docs/bugs/2026-09-22-compat-local-package-source-supervisor-target-resolves.md`
- 只读：`test/pi-subagents-compat.test.mjs:184-260`、`src/subagent-dispatch/supervisor-adapter.ts`、`src/subagent-dispatch/runtime-membrane.ts`、`src/subagent-dispatch/extension.ts`

**接口契约：**
- Consumes：主 agent 已完成的复现证据（见下「背景事实」）
- Produces：一份符合仓库 bug 文档格式的中文归因记录，含按「缺陷数据来源分类门禁」做出的三分类判定、首个偏离点、完整生成调用链，以及**明确标注为待裁决**的修复方向

**验收标准：**
1. 文档包含：现象、复现命令与实测输出、首个偏离点（精确到 `文件:行号`）、完整调用链、三分法分类结论与证据、修复方向候选（不选定）、影响面
2. 三分法分类必须给出证据覆盖：实际入口、权威身份、事件/资源顺序、与 production 事实的差异
3. **不修改任何生产代码或测试**——本任务只产出归因文档
4. 文档明确记录 HEAD 与工作树双向复现结果，以及 `env -i` 环境无关性证据

**背景事实（主 agent 已实测，执行者需自行复核后引用）：**
- `node --test test/pi-subagents-compat.test.mjs` 在工作树上 **3/3 失败**，`exit=1`
- 失败用例：`test/pi-subagents-compat.test.mjs:184` 起的 `"loads exactly one enhanced runtime and footer from a local package source"`，断言点在 `:244:5`
- 错误：`AssertionError [ERR_ASSERTION]: Missing expected rejection.`，`operator: 'rejects'`，`actual: undefined`
- 断言内容：`await assert.rejects(supervisor.execute("compat-status", { action: "status" }, signal, undefined, undefined), (error) => error?.code === "SUPERVISOR_TARGET_UNAVAILABLE")` —— 期望 reject，实际 **resolve**
- `git archive HEAD` 导出到临时目录（符号链接 `node_modules`）后 **3/3 同样失败**，同一用例同一断言 → HEAD 既有，非 lifecycle 批次回归
- `env -i PATH="$PATH" HOME="$HOME" node --test test/pi-subagents-compat.test.mjs` 仍失败 → 与环境变量泄漏无关
- `src/subagent-dispatch/supervisor-adapter.ts` 工作树无 diff（mtime 09-09 19:34）；`test/pi-subagents-compat.test.mjs` mtime 09-13 14:08，无未提交修改
- 该测试在 `:187-189` 主动 `delete process.env[...]` 清理 5 个 marker（`PI_SUBAGENT_CHILD`、`PI_SUBAGENT_FANOUT_CHILD`、`PI_SUBAGENT_PARENT_SESSION`、`PI_ROOT_SUBAGENT_BROKER_ENABLED`、`PI_CODING_WORKSPACE_DIR`），但不清理 `PI_SESSION_OWNER_REGISTRY` / `PI_SESSION_OWNER_ID`；实测清理与否结果相同

- [ ] **步骤 1：独立复核复现（不得直接引用主 agent 的数字）**

运行以下四组，把**实际输出**记入文档：

```bash
cd /Users/leshi.zhy/pi-config
for i in 1 2 3; do node --test test/pi-subagents-compat.test.mjs >/tmp/t11-ws-$i.log 2>&1; echo "workspace run$i exit=$?"; done
grep -c "Missing expected rejection" /tmp/t11-ws-1.log

rm -rf /tmp/t11-head && mkdir -p /tmp/t11-head
git archive HEAD | tar -x -C /tmp/t11-head
ln -s "$PWD/node_modules" /tmp/t11-head/node_modules
mkdir -p /tmp/t11-head/packages/pi-subagents-enhanced
[ -d packages/pi-subagents-enhanced/node_modules ] && ln -s "$PWD/packages/pi-subagents-enhanced/node_modules" /tmp/t11-head/packages/pi-subagents-enhanced/node_modules
cd /tmp/t11-head && for i in 1 2 3; do node --test test/pi-subagents-compat.test.mjs >/tmp/t11-head-$i.log 2>&1; echo "HEAD run$i exit=$?"; done
cd /Users/leshi.zhy/pi-config
env -i PATH="$PATH" HOME="$HOME" node --test test/pi-subagents-compat.test.mjs >/tmp/t11-envi.log 2>&1; echo "env -i exit=$?"
```

若你的复现结果与上述背景事实**不一致**（例如在你手上 PASS），立即用 `contact_supervisor`（`reason: "need_decision"`）报告双方环境与输出差异，不要自行选一方为准。

**环境不可验证的处理（审阅意见 H6）：** 本任务的部分步骤依赖本机 package 安装布局（`packages/pi-subagents-enhanced/node_modules` 是否存在、`jiti` 能否解析 `.ts`、`git archive` 导出后符号链接是否生效）。执行前先做前置检查：

```bash
ls -d packages/pi-subagents-enhanced/node_modules >/dev/null 2>&1 && echo "pkg node_modules: OK" || echo "pkg node_modules: MISSING"
node -e "import('jiti').then(()=>console.log('jiti: OK')).catch(()=>console.log('jiti: MISSING'))"
```

若任一前置缺失，或 HEAD 导出因链接/解析问题**根本无法运行**，则把该项记为 `环境不可验证`，写明缺失的前置与实测错误原文，**不得**把「跑不起来」归因于被测问题本身，也不得据此判定 R5 不成立。工作树上的三轮复现是本任务的最低证据要求；只有它也无法完成时才允许以 `环境不可验证` 收尾并请示。

- [ ] **步骤 2：定位首个偏离点**

只读追踪 `supervisor.execute(...)` 的实际路径：

```bash
grep -rn "SUPERVISOR_TARGET_UNAVAILABLE" packages/pi-subagents-enhanced/src packages/pi-subagents-enhanced/extensions
grep -n "subagent_supervisor" packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts | head -20
sed -n '1,80p' packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts
grep -n "bindExtensions" packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts | head
```

回答并在文档中写明：
- `SUPERVISOR_TARGET_UNAVAILABLE` 的抛出条件是什么（精确到行）？
- 测试在 `:220` 调用 `result.session.bindExtensions({ mode: "rpc", ... })` 后，`subagent_supervisor` 工具的 target 绑定链路经过了哪些函数？
- 实际 resolve 的返回值是什么？用一个**临时**的 `/tmp/t11-probe.mjs` 脚本复现该调用并打印结果，脚本只放 `/tmp/`，不进仓库。
- 首个偏离点：是「target 被绑定到了某个真实/默认对象」，还是「execute 在 target 缺失时返回空结果而非抛错」？

- [ ] **步骤 3：按三分法门禁分类**

依据仓库 `AGENTS.md` 的「缺陷数据来源分类门禁」，在文档中给出判定并**逐条覆盖要求的证据维度**：
1. 数据来源：该 resolve 结果能否由合法 public/typed 入口、权威 Host/Store 与正常事件顺序产生？
2. 首个偏离点与完整生成调用链
3. 与 production 事实的差异：是「预期 production 数据未被正确处理」（→ 生产缺陷）、还是「测试制造的非预期数据」（→ 只修测试/fixture）、还是「来源尚未证实」（→ fail closed）

若证据不足以判定 production 可达性，**必须**判为 (3) 并在文档中写明需要补充的 provenance 证据，禁止预防性兼容、禁止为求闭环而猜测。

- [ ] **步骤 4：写归因文档（含可机械校验的结构清单）**

审阅意见 H6：本任务的交付物是文档，但「文档」不等于不可验收。文档必须含下列**全部**小节且每节非空，缺任一项即视为未完成：

```
状态 / 分类 / 影响面（三个元数据字段）
现象 · 复现（工作树 / HEAD 导出 / env -i 三小节，各附实际命令与输出摘录）
首个偏离点（含 文件:行号） · 完整调用链
三分法分类与证据（数据来源 / 权威身份与事件顺序 / 与 production 事实的差异）
修复方向候选（≥ 2 个，均标注待裁决） · 未解决的疑问
```

写完后用命令自检结构（该命令同时就是本任务的可执行验收）：

```bash
F=docs/bugs/2026-09-22-compat-local-package-source-supervisor-target-resolves.md
for h in "## 现象" "## 复现" "### 工作树" "### HEAD 干净导出" "### 环境无关性" \
         "## 首个偏离点" "## 完整调用链" "## 三分法分类与证据" "## 修复方向候选" "## 未解决的疑问"; do
  grep -qF "$h" "$F" && echo "OK   $h" || echo "MISS $h"
done
```

预期：全部 `OK`。任一 `MISS` 即未完成，不得交付。

文档骨架：

创建 `docs/bugs/2026-09-22-compat-local-package-source-supervisor-target-resolves.md`，结构：

```markdown
# compat "local package source" 用例期望 supervisor target 不可用却 resolve

**状态：** 已归因，修复方向待裁决
**分类：** <(1) 生产缺陷 / (2) 测试制造 / (3) 来源未证实>
**影响面：** <HEAD 既有；是否影响发行包；是否影响 live 行为>

## 现象
## 复现
### 工作树
### HEAD 干净导出
### 环境无关性
## 首个偏离点
## 完整调用链
## 三分法分类与证据
### 数据来源
### 权威身份与事件顺序
### 与 production 事实的差异
## 修复方向候选（不选定，待裁决）
## 未解决的疑问
```

- [ ] **步骤 5：确认未产生任何代码改动**

运行：`git status --short test/pi-subagents-compat.test.mjs packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`

预期：三者均无输出（未被修改）。新增文件只应是 `docs/bugs/2026-09-22-compat-local-package-source-supervisor-target-resolves.md`。

---

### Task 12：测试时序 flake 修正（测试自传的过短 deadline）

**Deps：** `none`

**WritePaths：**
- `test/root-subagent-broker.test.mjs`
- `test/durable-lifecycle.test.mjs`

**Resources：** `full-test-suite`（步骤 4 需独占全量跑，避免并发负载干扰判定）

**Files：**
- Modify：`test/root-subagent-broker.test.mjs:429`（`timeoutMs: 500`）、`:394` 附近同族调用
- Modify：`test/durable-lifecycle.test.mjs:58`（`staleLockMs: 1`）、`:65` 附近

**接口契约：**
- Consumes：`createRootBrokerClient({ rootSessionId, callerRunId, timeoutMs })` 的现有签名；`DurableStorage({ root, staleLockMs })` 的现有签名
- Produces：两个测试文件的时序敏感参数改为对负载不敏感的取值，**不修改任何 production deadline 或默认值**

**验收标准：**
1. `test/root-subagent-broker.test.mjs` 单独跑 3 次全绿
2. `test/durable-lifecycle.test.mjs` 单独跑 3 次全绿
3. 全量 `npm test` 连跑 2 次，两个文件均不再出现 `BROKER_TIMEOUT`
4. `grep -n "timeoutMs: 500" test/root-subagent-broker.test.mjs` 零命中；`grep -n "staleLockMs: 1," test/durable-lifecycle.test.mjs` 零命中
5. **production 代码零改动**：`git status --short packages/ src/ pi/` 中不出现本任务产生的新改动

**关键约束（执行者不得违反）：** 不得通过放大 production 的默认 deadline 来掩盖问题。`timeoutMs: 500` 是**测试自己传入**的参数（`root-subagent-broker.test.mjs:429`），不是 production 默认值——因此正确修法是提高测试传入值或消除对真实 socket 往返的时序依赖，而非改 `root-broker-client.ts`。

- [ ] **步骤 1：确认 flake 的真实机制**

运行：

```bash
sed -n '390,400p;425,435p' test/root-subagent-broker.test.mjs
sed -n '52,70p' test/durable-lifecycle.test.mjs
grep -n "timeoutMs" packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts | head
```

确认：`timeoutMs: 500` 由测试传入 → `root-broker-client.ts:169` 用它作为 RPC deadline → 全量并发负载下 500ms 内未完成往返即抛 `BROKER_TIMEOUT`。同时确认 `staleLockMs: 1` 使「陈旧锁」判定窗口只有 1ms，在负载下无法可靠区分 stale 与 live。

- [ ] **步骤 2：先确认当前基线（RED 等价物）**

单独跑 3 次确认稳定通过（这是基线）：

```bash
for i in 1 2 3; do node --test test/root-subagent-broker.test.mjs >/tmp/t12-solo-$i.log 2>&1; echo "solo run$i exit=$?"; done
```

再跑一次全量以尝试复现 flake（**可能不复现，属预期**；实测复现率约 1/2 次全量跑）：

```bash
npm test >/tmp/t12-full-before.log 2>&1; echo "full exit=$?"; grep -c "BROKER_TIMEOUT" /tmp/t12-full-before.log
```

把两次结果都记入任务报告。若全量跑未复现 flake，**不得据此跳过修复**——机制已由步骤 1 的代码事实证明，修复依据是机制而非偶发复现。

- [ ] **步骤 3：最小修复**

`test/root-subagent-broker.test.mjs:429`：把 `timeoutMs: 500` 改为 `timeoutMs: 5000`，并在该行上方加中文注释：

```js
  // 500ms 在全量并发负载下不足以完成一次真实 socket 往返，会偶发 BROKER_TIMEOUT。
  // 这里提高的是测试传入值，不是 production 默认 deadline；不得改用放大 production
  // 默认值的方式掩盖时序问题。
  client = createRootBrokerClient({ rootSessionId, callerRunId: runId, timeoutMs: 5000 });
```

同文件 `:394` 附近若有同族的短 `timeoutMs`，按同一原则处理。**例外**：若某个用例的断言目标本身就是「deadline 超时会抛 `BROKER_TIMEOUT`」，则该用例必须保留短 deadline，但需改为不依赖真实 socket 往返（用 stub/假 transport 触发超时），并在注释中说明。逐个判定，不得一刀切。

`test/durable-lifecycle.test.mjs:58`：把 `staleLockMs: 1` 改为 `staleLockMs: 50`，并在上方加中文注释说明 1ms 窗口在负载下无法可靠区分 stale 与 live lock。`:65` 附近若有依赖该窗口的 `sleep`/时序断言，同步调整使其与新窗口自洽（例如原本 `await sleep(5)` 就足以越过 1ms 窗口，改为越过 50ms 窗口所需的等待）。

- [ ] **步骤 4：运行确认 GREEN（独占全量）**

运行：

```bash
for i in 1 2 3; do node --test test/root-subagent-broker.test.mjs >/tmp/t12-solo-after-$i.log 2>&1; echo "solo after run$i exit=$?"; done
for i in 1 2 3; do node --test test/durable-lifecycle.test.mjs >/tmp/t12-dl-after-$i.log 2>&1; echo "durable after run$i exit=$?"; done
npm test >/tmp/t12-full-after-1.log 2>&1; echo "full#1 exit=$?"; grep -c "BROKER_TIMEOUT" /tmp/t12-full-after-1.log
npm test >/tmp/t12-full-after-2.log 2>&1; echo "full#2 exit=$?"; grep -c "BROKER_TIMEOUT" /tmp/t12-full-after-2.log
```

预期：6 次单独跑全部 `exit=0`；2 次全量跑 `BROKER_TIMEOUT` 计数均为 0。

- [ ] **步骤 5：确认 production 零改动**

运行：`git status --short packages/ src/ pi/`

预期：输出中不含本任务新增的改动（本任务只改两个 `test/*.mjs`）。若出现 production 文件改动，说明步骤 3 越界，必须回退该改动。

---

### Task 13：探索——coding/generic 分支可发现性方案（只产出决策，不实现）

**Deps：** `T2`（理由：必须在 `workflow` 已删除后的字段面上探索，否则方案会包含即将消失的字段与其条件约束）

**WritePaths：**
- `docs/research/2026-09-22-dispatch-branch-discoverability.md`

**Resources：** `none`（只读源码，不写代码）

**Files：**
- Create：`docs/research/2026-09-22-dispatch-branch-discoverability.md`
- 只读：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:40-160`（schema 与 union 约束注释）、execute-time 路由段（原 `:1306-1316`，T2 后行号会漂移，需重新定位）、`src/contracts/dispatch-ir.ts`、`src/contracts/generic-prompt.ts`

**接口契约：**
- Consumes：T2 完成后的 `dispatch-ir.v1` 顶层字段集合（12 个：`version, taskId, title, agent, model, risk, objective, requirements, context, boundaries, acceptance, execution`）；T1 完成后的 canonical 单一实现
- Produces：一份决策文档，含 ≥3 个候选方案的对比、推荐方案、以及推荐方案的**精确接口契约**（schema 结构、description 文本生成方式、错误 details 形状），使后续实现计划可以直接依赖该产物而不需要延续本任务的上下文

**验收标准：**
1. 文档明确复述约束：`extension.ts:44-48` 的注释指出某些严格 OpenAI-compatible provider 遇到根级 `oneOf`/`anyOf` union 会生成空 arguments，因此根节点必须保持单一 object。任何方案都必须在此约束下成立，或给出该约束已失效的证据
2. 至少评估这三个方向并给出取舍：(a) 保持单 object 但生成 branch-specific description（按 `version`/`action` 的存在性动态描述字段归属）；(b) 在 description 中嵌入完整的 coding/generic/control 字段矩阵表；(c) 错误回执侧补偿——`INVALID_CONTRACT` 一次性返回该分支的完整字段模板与必填清单
3. 每个方向都给出：模型可见性提升程度、provider 兼容风险、实现改动面（精确到文件）、对既有 52 个会话 312 次 `INVALID_CONTRACT` 与 327 次 `INVALID_PATH` 的预期削减
4. 给出推荐方案及其精确接口契约（含 schema 片段与 description 文本示例）
5. **不含任何生产代码改动**

- [ ] **步骤 1：确认 provider 兼容约束是否仍然成立**

读 schema 段的注释原文，并在 `docs/bugs/` 中查找对应记录：

```bash
sed -n '40,50p' packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
ls docs/bugs/ | grep -iE "union|schema|glm|empty"
sed -n '1,60p' docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md 2>/dev/null
```

在文档中写明：该约束的原始证据是什么、涉及哪些 provider/model、当前 `enabledModels` 中是否仍包含受影响的 model（`enabledModels` 的**模型名**可以读取，但不得读取或输出任何凭据字段）。**若约束已因 provider 升级而失效，使用根级 union 的方案重新变为可行**，这会显著改变推荐结论，必须明确判定。

- [ ] **步骤 2：盘点 T2 之后的实际字段面**

运行：

```bash
sed -n '49,160p' packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
grep -n "TOP_LEVEL_KEYS" -A 16 packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts | head -20
grep -n "INVALID_CODING_ROUTER\|INVALID_GENERIC_DISPATCH" packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
```

产出一张表：每个顶层字段 × {JSON Schema 是否声明 / Schema 是否声明必填 / coding 分支实际是否必填 / generic 分支是否合法 / control 分支是否合法 / 是否存在条件约束}。这张表是 T2 之后字段面的权威快照，也是后续实现的输入。

已知需纳入表中的 generic-only 字段（coding 分支会按 unknown field 拒绝）：`task`、`cwd`、`output`、`outputMode`、`outputSchema`、`artifacts`、`progress`、`worktree`、`skill`、`reads`；以及 control 字段：`action`、`id`、`runId`、`dir`、`index`、`message`、`taskId`（注意 `taskId` 在 coding 与 control 两处语义不同，需分别记录）。

- [ ] **步骤 3：评估候选方向并写文档（输出契约硬要求）**

审阅意见 H7：探索任务最容易退化为主观建议文档。以下每一项都是**硬性交付要求**，缺任一项视为未完成：

1. **必须覆盖的输入样本**（至少这 8 类，每类给出实际路由结果）：完整合法 coding、缺 `version` 但含 `taskId`、缺 `version` 但含 `boundaries`、缺 `version` 且只有 `agent/title/task`（合法 generic）、generic 混入 coding-exclusive 字段（如 `outputMode`）、coding 混入 generic 字段、带 `action` 的 control 调用、`action` 与 `version` 同时存在。
2. **每个样本必须给出当前实际行为**（返回哪个错误码、或成功走哪个分支），而不是推测行为；必须附带可复现的获取方式（命令或测试名）。
3. **至少 2 个候选方案**（含§4.4 的条件方案则至少 3 个），每个都给出完整接口契约而不只是方向描述。
4. **比较维度必须含**：provider 兼容风险、误判率（合法输入被拒 / 非法输入被接受）、错误码变化面、测试改造成本、对现有 62 个会话 312 次 `INVALID_CONTRACT` 与 327 次 `INVALID_PATH` 的预期削减。
5. **结论必须是明确的待裁决项**：写出「推荐方案 X，理由是……，需用户确认的点是……」，不得以「建议进一步调研」结尾。

创建 `docs/research/2026-09-22-dispatch-branch-discoverability.md`，结构：

```markdown
# dispatch 分支可发现性方案探索

## 1. 问题陈述与量化
## 2. 硬约束：根级 union 的 provider 兼容性
### 2.1 原始证据
### 2.2 当前是否仍成立
## 3. T2 之后的字段面快照
## 4. 候选方案
### 4.1 方案 A：branch-specific description 动态生成
### 4.2 方案 B：description 内嵌完整字段矩阵
### 4.3 方案 C：错误回执侧补偿（完整模板 + 必填清单）
### 4.4 方案 A'（仅当 §2.2 判定约束已失效）：根级 oneOf 判别式
## 5. 对比矩阵
## 6. 推荐方案与理由
## 7. 推荐方案的精确接口契约
### 7.1 schema 结构
### 7.2 description 文本生成方式
### 7.3 错误 details 形状
## 8. 预期效果与验证方式
## 9. 未解决的问题
```

§5 的对比矩阵必须含这些列：`模型可见性提升 | provider 兼容风险 | 改动面（文件级） | 对 312 次 INVALID_CONTRACT 的预期削减 | 对 327 次 INVALID_PATH 的预期削减 | 是否可与 T1/T3 的错误文案改造叠加`。

§8 必须给出可执行的验证方式：如何证明改动后模型的一次派发成功率提升（例如用固定的一组真实派发参数样本做离线 schema 校验对照，或在受控会话中统计拒绝率），不得只写「预期改善」。

- [ ] **步骤 4：确认未产生代码改动**

运行：`git status --short packages/ src/ pi/ test/`

预期：无本任务产生的改动。新增文件只应是 `docs/research/2026-09-22-dispatch-branch-discoverability.md`。

---

### Task 14：全量回归验收终点

**Deps：** `T1`、`T2`、`T3`、`T4`、`T5`、`T6`、`T7`、`T8`、`T9`、`T10`、`T11`、`T12`（理由：验收终点需要全部代码任务的产物；**不依赖 T13**，因为 T13 只产出决策文档不改代码）

**WritePaths：**
- `docs/plans/2026-09-22-subagent-runtime-confirmed-gaps.md`（仅回写本计划的复选框与验收记录）

**Resources：** `full-test-suite`（独占）

**Files：**
- Modify：`docs/plans/2026-09-22-subagent-runtime-confirmed-gaps.md`

**接口契约：**
- Consumes：T1–T12 的全部产物
- Produces：一份可复核的验收记录，写入本计划文末「验收记录」小节

**验收标准：**
1. `npm run typecheck` PASS（含 `typecheck:root` 与 `typecheck:subagents-enhanced`）
2. `npm test` PASS，且**连续 2 次**均 PASS（T12 的 flake 修复需以此验证）
3. `npm run verify:subagents-enhanced` PASS
4. `npm run test:subagent-workspace` PASS
5. `npm run test:delegation-workspace-harness` PASS
6. `test/package-orphan-export-guard.test.mjs` PASS 且 `ALLOWLIST` 只剩 lifecycle 批次的 3 条（`lifecycle-policy.ts`、`lifecycle-identity.ts`、`supervisor-replay.ts`），T1 的两条已移除
7. `diff skill-overrides/subagent-dispatch/SKILL.md /Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md` 为空
8. `grep -rn "必须位于工作区内" src/ pi/ packages/ --include=*.ts` 零命中
9. `grep -rn "subagent-dispatch/ir\|subagent-dispatch/prompt" --include=*.ts --include=*.mjs packages/ src/ pi/ test/ scripts/` 零命中
10. `grep -rn "workflow" packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts` 零命中
11. live 现场未被触碰：`var/workspaces/repositories/85369acc…/worktrees/` 仍为 5 个目录，queue item 仍为 `state=queued`、`admissionGeneration=0`
12. `npm run test:subagents` 的结果如实记录：若因 `PI_REAL_BIN` 未设置而 fail，记录为 `环境受限未验证`（属延后项 R3），**不得**通过设置该变量或跳过测试来制造 PASS

- [ ] **步骤 1：静态检查与守卫**

运行：

```bash
npm run typecheck
node --test test/package-orphan-export-guard.test.mjs
diff skill-overrides/subagent-dispatch/SKILL.md /Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md && echo "SKILL IDENTICAL"
echo "--- 以下三项均应零命中 ---"
grep -rn "必须位于工作区内" src/ pi/ packages/ --include=*.ts
grep -rn "subagent-dispatch/ir\|subagent-dispatch/prompt" --include=*.ts --include=*.mjs packages/ src/ pi/ test/ scripts/
grep -rn "workflow" packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts
```

预期：typecheck PASS；守卫 PASS 且 allowlist 剩 3 条；输出 `SKILL IDENTICAL`；三个 grep 均零命中。

- [ ] **步骤 2：全量测试连跑两次**

运行：

```bash
npm test >/tmp/t14-full-1.log 2>&1; echo "full#1 exit=$?"; tail -12 /tmp/t14-full-1.log
npm test >/tmp/t14-full-2.log 2>&1; echo "full#2 exit=$?"; tail -12 /tmp/t14-full-2.log
grep -c "BROKER_TIMEOUT" /tmp/t14-full-1.log /tmp/t14-full-2.log
```

预期：`BROKER_TIMEOUT` 计数均为 0。**已知例外**：`test/pi-subagents-compat.test.mjs`（T11 只归因不修，**预期仍 FAIL**）。若全量因该用例而非零退出，如实记录为「T11 归因项，修复待裁决」，不得为了让全量绿而修改该测试或生产代码。除此之外应两次均 `exit=0`。

- [ ] **步骤 3：workspace 与 delegation 专项套件**

运行：

```bash
npm run test:subagent-workspace
npm run test:delegation-workspace-harness
npm run verify:subagents-enhanced
```

预期：全部 PASS。

- [ ] **步骤 4：真实 Pi lane 如实记录**

运行：`npm run test:subagents 2>&1 | tail -8`

预期：因 `PI_REAL_BIN` 未设置而 fail。记录实际输出，标注为 `环境受限未验证（延后项 R3，需用户确认 PI_REAL_BIN 路径）`。**不得**自行导出该变量后重跑并把它记为通过——那会让「真实环境 lane 从未验证」这一体制性缺口继续被掩盖。

- [ ] **步骤 5：确认 live 现场未被触碰**

运行：

```bash
R=/Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0
echo "worktree 目录数=$(ls $R/worktrees | wc -l | tr -d ' ')  (期望 5)"
echo "record 数=$(ls $R/records | wc -l | tr -d ' ')  (期望 5)"
python3 -c "
import json
d=json.load(open('$R/integration-queue/0ed45c9b-ec5f-4579-b509-e0bb944a436b.json'))
print('queue item state =', d['state'], ' admissionGeneration =', d['admissionGeneration'], ' (期望 queued / 0)')"
git status --short var/workspaces/ ; echo "var/workspaces git 改动计数=$(git status --short var/workspaces/ | wc -l | tr -d ' ')"
```

预期：worktree 目录数 5、record 数 5、queue item 仍为 `queued` / `admissionGeneration=0`。`var/` 被 `.gitignore` 的 `/var/` 覆盖，故 git 改动计数为 0 属预期，**以前三项为准**。若任一数字变化，说明本计划某个任务违规触碰了 live 现场，必须立即停止并报告。

- [ ] **步骤 6：回写验收记录**

在本计划文末新增「## 验收记录」小节，逐项记录步骤 1–5 的实际命令输出摘要（通过/失败/环境受限），并列出：
- 已兑现的缺口编号（B1、B5、H1、H3、H4、H8、H9、H10、M2、M4、R4、R7）
- 只归因未修复的编号（R5）
- 只产出决策未实现的编号（B2 → T13）
- 仍延后的编号与原因

---

## 延后项与原因

| 编号 | 延后原因 |
|---|---|
| **B2** schema 根级分支重构 | T13 只探索不实现。根级 union 受 provider 兼容约束（`extension.ts:44-48`），方案需先裁决；且 `extension.ts` 是 lifecycle 批次在途改动的热点文件 |
| **B3** queue 从未 claim | 代码事实可信（`integration-queue.ts` 未被批次触碰、无新增 `claimNext` 调用方），但**验证被阻塞**：live 现场由 pid 85087 维护，该进程启动于 2026-09-20 16:32:58，运行的是 lifecycle 批次完成（09-21 20:55）之前 28 小时的代码，修复效果无法在重启前验证。已确证 coordinator 存活并持有 socket（`lsof -p 85087` fd 20/22 指向 `/tmp/pi-workspace-coordinator-501/57e63c….sock`），故断点在 claim 循环而非进程存活，需独立调查 |
| **B4** cleanup-debt 无 agent 出口 | 需先裁决 D4（新增 `recover` action 的授权模型与审计形状）；且 `subagent_worktree` 的 action union 变更会与既有文档声称的 `recover/retry/discard/release` 权限矩阵（merge-queue 计划 `:942-947`）冲突，需先对齐 |
| **H2** runtime 自产 artifacts 绊倒回收 | 真因未证实：`3b8d0a57` 的 `!! .pi/subagents/artifacts/*` 是高置信候选，但 `removeUntrackedRuntimeMetadata` 与 Git remove 的时序无法从快照还原。需先由 T8 的分类透传取得真实 stderr |
| **H5** reminder 覆盖不全 | `completion-reminder.ts:25-45` 的触发条件事实可信，但修复形状依赖 B3/B4 的语义裁决（debt 与 queued 状态的通知归属） |
| **H6** 无 queue inspect agent 面 | 依赖 B3；且需与 `docs/bugs/2026-09-13-auto-integration-inspect-information-leak.md` 的字段裁剪决策对齐，避免重新引入 path/branch/head 泄漏 |
| **H7** paused run 无 cancel 路径 | 抛点在 pinned upstream（`pi-subagents@0.62.0/src/extension/rpc.ts:668-680`），修复需经 `src/compat/pi-subagents-0.62.ts` 或新增 control-plane 能力；而 control-plane（`supervisor-control-plane.ts`）是 lifecycle 批次新增、**从未在运行时验证过**（本会话加载的 runtime 早于该文件的创建时间） |
| **M1** submodule 全链路无适配 | 需先裁决 D5（递归支持 vs 显式拒绝）。属 greenfield 工作（从无任何条款声称 submodule 全链路适配已完成），涉及 worktree add / admission / rebase / publish 全链路，工作量与风险都比本计划任一任务大一个量级 |
| **M3** version heuristic 不完整 | T2 步骤 6 已做等量替换（`workflow` → `boundaries`）保持检测强度不降；完整化（任一 coding-exclusive 字段混入即 fail closed）留待 B2 方案裁决后一并处理 |
| **M5** RPC 无操作级 retry / 无幂等身份 | 与 lifecycle 批次新增的 control-plane receipt 幂等机制部分同域（G 组判定「同域不同操作面」：receipt 覆盖 reply/steer，不覆盖 spawn）。需先确认 control-plane 的运行时行为再设计 spawn 幂等 |
| **M6** 隔离覆盖率 5/64 | 属产品决策而非缺陷：是否强制 coding child 使用 worktree、`worktree=false` 是否应纳入 queue 与 completion gate，需用户裁决 |
| **M7** 长时诊断任务无增量落盘约束 | 证据全部来自旧基线的 spawn/resume 路径（3 次上游流中断：C 组 1 次、E 组 2 次）。lifecycle 批次新增的 `recovery-resume-orchestrator.ts` 是否改善中断恢复，本会话无法证明（未加载该代码）。**已在本计划执行过程中以派发协议形式临时缓解**（要求 subagent 先落盘骨架、逐节 edit），落地为 runtime/skill 约束需待新基线验证 |
| **R1** control-plane 并发双投递窗口 | 代码级事实已确认（`supervisor-control-plane.ts` 的 `resolveSupervisorControl` 无 in-flight 锁，`receipts.get(key)` 早于 pending 检查），但**并发场景未复现**，属理论窗口；且 `supervisor-control-plane.ts` 是 lifecycle 批次的 untracked 新文件，编辑它会直接混淆案发现场。归 lifecycle 收尾批次 |
| **R2** steer 幂等检查先于 pending 检查 | 同 R1（同文件同测试面）。G 组已给出方案①的评估（P3-T6 合同原文 `lifecycle-overall.md:274` 本就写 pending-first；既有断言改动≈0），**待用户裁决**后归 lifecycle 收尾批次 |
| **R3** `PI_REAL_BIN` 未设置 | 环境决策项。已探明 `/opt/homebrew/bin/pi` 为 0.85.1、`colima` 0.10.3 daemon 运行中；需用户确认用哪条路径补跑真实 lane。**这是 B3 与整个「真实环境验收长期缺位」体制性缺口的直接前置** |
| **R6** `reviewer.md` 用户预存编辑致测试失败 | 用户决策项，不得替用户回滚。已确证：`git diff` 显示新增 `codex-pool/gpt-6-astra` 为首选 model + 指令文案修改；HEAD 干净导出上该测试 2/2 通过 |

## 体制性缺口（超出本计划范围，需单独立项）

三项独立证据指向同一根因——**验收只检查文档层自洽，从不检查与真实产物的一致性**：

1. `docs/plans/2026-09-12-pi-0851-repository-merge-queue.md` 的 **Task 9 步骤 8（真实五 Subagent 验收）从未勾选**，而 Task 10/11 的合同级验收已勾选为通过；live 现场 queue 完成率 0/1、proof settle 0/5
2. `.pi/handoff/context-handoff.md:223,244` 引用的验收 commit `d98c4c41`、`5a6f8f8f` **在仓库中不存在**（`git cat-file -t` 均报 `Not a valid object name`），且 `.pi/handoff/` 本身 untracked；`docs/plans/2026-09-20-subagent-lifecycle-overall.md` 的实现步骤复选框 **0/51**（9 个已勾项全部是执行前计划自检），而残留文档声称「P0–P6 已全部完成并验收」
3. lifecycle 批次 9 个新模块中 **3 个零生产 importer**（`lifecycle-policy.ts`、`lifecycle-identity.ts`、`supervisor-replay.ts`），`recoverOrphanRun` 导出无生产调用方；而 `supervisor-replay.ts` 正是 P3-T5「completion replay 与 user-visible exactly-once」的交付物

T0 的孤儿模块守卫只覆盖第 3 类的**文件级**形态。完整门禁还需：验收证据必须 tracked、引用的 commit 必须存在、计划复选框必须回写、声称的能力必须有穿过 production 入口的测试。这四条需要独立计划，且依赖 R3（真实环境 lane 可用）才能真正生效。

---

## 计划自检

**1. 规格覆盖**

| 输入缺口 | 覆盖任务 |
|---|---|
| B1 孤儿 IR + 假绿测试 | T0（守卫）、T1（删双孤儿 + minItems + 错误模板） |
| B5 proof debt 误判（本次调查新增） | T7 |
| H1 git stderr 丢弃 | T8 |
| H3 `workflow` 零语义（用户裁决删除） | T2 |
| H4 skill 尾随 `/` 错误文法 | T3 |
| H8 `MODEL_NOT_AVAILABLE` 无候选 | T4 |
| H9 preflight 冒充 RPC 失败 | T5 |
| H10 `bash cwd` 限制不可行动且可绕过（用户裁决方案 A） | T9 |
| M2 `INVALID_PATH` 泛化消息 | T3 |
| M4 ledger 状态词表混用 | T6 |
| B2 schema 分支漂移 | T13（探索）+ T1 步骤 4（错误模板，部分缓解）；完整重构延后 |
| R4 init-pi 测试期望漂移 | T10 |
| R5 compat `:244` | T11（只归因） |
| R7 测试时序 flake | T12 |
| B3/B4/H2/H5/H6/H7/M1/M3/M5/M6/M7/R1/R2/R3/R6 | 「延后项与原因」逐条说明 |

**2. 占位扫描**：全文无 `TBD`、`TODO`、「以后实现」、「添加适当错误处理」、「类似 Task N」；每个含代码的步骤都给出可复制的完整代码或精确的替换指令（原文 → 新文）；每个任务都定义了其引用的函数/常量（`ALLOWLIST`、`FIELD_SHAPE_HINTS`、`suggestBareModelId`、`MANAGED_WORKSPACE_STATES`、`ManagedWorkspaceState`、`allowedActionsFor`、`managedWorkspaceStateFailure`、`STATE_NEXT_ACTION`、`classifyGitFailure`、`redactGitStderr`、`gitFailure`、`GIT_FAILURE_RULES`、`isWithinWorkspace`、`classifyTerminalProofBinding`、`TerminalProofBindingDeps`、`ModelSelectionErrorDetails`）。

**3. 类型一致性**：
- T1 定义的 `FIELD_SHAPE_HINTS` 键格式为 `${location}.${key}`，与 `validateObject` 中 `fail()` 的第三参 keypath 一致；T2 步骤 4 删除其中的 `"$.workflow"` 条目
- T2 删除 `workflow` 后，T1 创建的 `test/subagent-dispatch-readonly-writepaths.test.mjs` 的 `contract()` helper 含 `workflow` 键会 RED —— 已在 T2 步骤 9 显式列为衔接点
- T3 的 `PATH_EXAMPLE` 常量被四类错误文案复用，与测试断言 `/src\/\*\*|src\/a\.ts/` 一致
- T4 的 `ModelSelectionErrorDetails.suggestion` 为可选字段，测试用 `"suggestion" in error.details` 断言其缺席，与实现的条件展开语法一致
- T6 的 `allowedActionsFor` 返回 `readonly string[]`，测试用 `[...allowedActionsFor(state)]` 展开后 `deepEqual`，与 `Object.freeze` 无冲突；`managedWorkspaceStateFailure` 依赖 `failure()` 支持第三参 `detail`，与 T8 步骤 5 对 `git-worktree.ts` 内 `failure()` 的扩展是**两个不同文件中的同名局部函数**，互不影响，各自任务内独立处理
- T7 的 `TerminalProofDeliveryOutcome` 新增 `not-applicable` 成员后，`deliveryOutcome` 必须显式识别（步骤 1 已标为关键陷阱），否则被末尾 fail-closed 分支降级回 `debt`
- T8 的 `failure()` 第四参 `detail` 字段名必须与 `tool.ts:87-88` 实际透传的字段名一致，已在步骤 1 要求先确认
- T9 保留 `validateDeclaredBashCwd` 的签名与返回类型，`extension.ts:33` 的调用点无需改动

**4. DAG 审核**：
- 每条边都有具体产物理由：`T0→T1`（allowlist 机制与守卫信号）、`T1→T2`（孤儿 renderer 已删，`workflow` 只剩一处落点）、`T1→T3`（孤儿 ir 已删，`normalizeRepoRelativePath` 只剩一份）、`T2→T13`（字段面收窄后探索才有意义）、`T1..T12→T14`（验收终点需要全部代码产物）
- 已删除的伪边：`T2→T5`（T5 只读 `extension.ts` 的 catch 区，不消费 T2 产物；二者仅竞争 `extension-ts` 资源锁，属资源竞争而非依赖）、`T13→T14`（T13 不改代码，不可能影响回归）、`T4`–`T12` 之间的全部潜在边（各自独立可验收）
- 资源竞争已单列于 Resources 表：`dispatch-ir`（T1/T2/T3）、`extension-ts`（T2/T5）、`skill-md`（T2/T3）、`root-broker`（T7）、`full-test-suite`（T12 步骤 4、T14）
- WritePaths 重叠检查：
  - T1 与 T2/T3 共享 `src/contracts/dispatch-ir.ts` → 由 `dispatch-ir` 资源锁串行化，且 DAG 已用 `T1→T2`、`T1→T3` 表达真实顺序
  - T2 与 T3 共享两处 `SKILL.md` → 由 `skill-md` 锁串行化；T3 步骤 4 明确要求「不要覆盖 T2 在同文件其他位置的改动」
  - T1 与 T2 共享 3 个测试文件（`subagent-dispatch-ir.test.mjs`、`subagent-dispatch-validation-errors.test.mjs`、`subagent-dispatch-readonly-writepaths.test.mjs`）→ 已由 `T1→T2` 边串行化
  - T2 与 T3 共享 `test/subagent-dispatch-skill.test.mjs` → 已由 `skill-md` 锁与 `T1→{T2,T3}` 顺序覆盖；执行器仍须串行调度 T2 与 T3
  - **T6 与 T8 共享 `test/managed-workspace-contract.test.mjs`** → 二者无真实依赖，故不加 DAG 边，在此显式登记为写入热点，由执行器串行调度
  - 其余任务的 WritePaths 两两不相交
- 关键路径 `T0 → T1 → T2 → T13` 上每个任务都有独立可验收产物；Wave 1 的九个任务（T0、T4、T6、T7、T8、T9、T10、T11、T12）与关键路径完全解耦，可立即并行开工
- 无「提交」步骤：全计划不含任何版本控制提交动作，符合「不得默认创建 commit」约束

---

## 修订记录（v2 · 执行前审阅后）

本节记录 2026-09-22 执行前 reviewer 审阅（review 档 `gpt-6-astra`，generic shape、无 worktree）提出的 8 个 Blocker、7 个 High、5 个 Medium 的处置结论。审阅同时确认：计划引用的 30+ 处源码 `文件:行号` 与 12 处测试文件行号**全部相符**，5 个孤儿模块**全部真实存在**，package exports 为 4 项（`./dispatch-ir`、`./generic-prompt`、`./workspace`、`./workspace/admin`），用户三项裁决（删除 `workflow`、bash cwd 方案 A、保留案发现场）均已正确落实。

审阅总体结论为「当前不建议直接开工」，理由是 T4/T7/T8 的预期 RED/GREEN 流程会失真，且 T7 有引入 terminal proof 语义回归的风险。下列修订全部完成后该结论解除。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| B1 | Blocker | T7 抽取函数的默认 `buildTerminalProof` 会改变 proof 字段集（塞入 `workspaceId`、丢失 `rootSessionId`/`processInstance`），违反 workspace ledger v2 的身份契约 | `buildTerminalProof` 改为**必填**依赖、删除默认分支；新增 `Object.keys(proof).sort()` 精确断言与 `processInstance` 取值断言；步骤 2 要求先记录改动前字段集作为基准 |
| B2 | Blocker | T7 测试 import 的 `deliveryOutcome` 在 `root-broker-server.ts:159` **未导出**，RED 会是 `TypeError` 而非断言失败，违反计划自身的精确 RED 要求 | 采用审阅建议方案 1：为其新增 `export`，并在接口契约中明确这是本任务唯一的生产 API 变更、**不加入 package `exports`**、不触发 T0 文件级孤儿守卫；测试增加 `assert.equal(typeof deliveryOutcome, "function")` 前置断言 |
| B3 | Blocker | T7 分类逻辑在 `listOwned` 返回非数组 / 元素缺 `workspaceId` 时会 fall through 到 `not-applicable`，属 **fail open**，违反仓库门禁「unknown 一律 fail closed」 | 引入 `BindingResolution = bound \| none \| unknown` 三态与 `resolveBinding()`：非数组、元素非法、多条匹配一律 `unknown` → debt；只有「查询成功且合法空结果」才是 `none`。测试新增 5 种非法输入用例与 ledger 非法用例 |
| B4 | Blocker | T8 规则表把 `is a working tree only` 归 `path-missing`，测试却期望 `locked`，确定性 GREEN 失败；且该 git 消息是**编造的**，非真实输出 | 删除该虚构消息；改为两阶段分类——stderr 只判结构性原因（locked / sequencer / path-missing），内容类细分（dirty / untracked / ignored / submodule / unmerged）必须来自失败时补采的 `git status --porcelain --ignored=matching --untracked-files=all`。分类粒度以**可区分性为上限**：`git worktree remove` 把 modified 与 untracked 合并成一句，故无 porcelain 时只归 `dirty-worktree`，不猜 untracked |
| B5 | Blocker | T4 新测试断言 `resolvedModel`，而 `resolveModelSelection` 实际返回 `{ model, source, warnings? }`；导致「第 5 个测试应 PASS」不成立，RED 被误判为实现问题 | 全部改为 `.model`，并补 `.source` 断言（`qualified` / `agent-candidates` / `global-catalog` / `default` 四值）；步骤 3 明确该测试在 RED 阶段就应 PASS |
| B6 | Blocker | T4 `suggestBareModelId` 的 `availableFullIds: readonly ReadonlySet<string>` 签名不合法（`readonly` 修饰 Set 类型无 `.has`） | 改为 `ReadonlySet<string>` |
| B7 | Blocker | T0 的 `isReferenced` 用 basename 兜底（`./prompt.ts`），同名文件会误判「已被引用」从而漏检真实孤儿；且 allowlist 预填会让 GREEN 失去证明力 | 改为解析 import 说明符为绝对路径后精确比对（`resolvesTo`），删除 basename 兜底；步骤 2 升级为**硬门禁**：必须在 allowlist 为空时先跑出真实发现清单并原文入报告，禁止先填后跑；并规定「清单少于已知 5 项即判定算法仍漏检，必须先修算法」 |
| B8 | Blocker | T7 触碰 `root-broker-server.ts` 却未给出批次 hunk 范围与机械验证方式，「尽量避开」不可执行 | 步骤 1 改为**前置门禁**：列出两个文件的全部批次 hunk 实测行号区间，声明本任务编辑区，并给出 `git diff --unified=0` 前后对比命令与判定规则；任一批次 hunk 消失或区间变化即停止请示。主 agent 已实测确认 T7（新 33-36、159-164）、T2（新 ~65、919-921）、T5（新 1383-1384）编辑区均不与批次 hunk 相交 |
| H1 | High | Resources 表未登记 T6/T8 共享的 `test/managed-workspace-contract.test.mjs`，Wave 1 并行会产生写入竞争；「自检里提了」不能替代执行器可消费的锁语义 | Resources 表新增 `managed-workspace-contract-test` 写锁（T6、T8，上限 1）；`full-test-suite` 补登 T12 步骤 4；并注明资源锁是硬约束而非提醒 |
| H2 | High | T2/T3 的 WritePaths 含仓库外绝对路径 `/Users/leshi.zhy/.agents/skills/...`，破坏可移植性；步骤还允许覆盖仓库外文件 | 两处 WritePaths 条目移除并替换为说明性注释；全局约束新增「仓库外文件的处理规则」：仓库副本是唯一生产交付物，已安装副本同步为条件化环境步骤（先 `[ -f ]` 判定，不存在则记 `skip` 且不阻塞），相关测试断言必须写成条件式 |
| H3 | High | T9 步骤 6 只扫 `src/ pi/ packages/`，会漏掉测试/文档/其他扩展副本中的旧文案断言 | 改为全仓扫描（排除 `node_modules`/`.git`/`var`/`.build`），并对生产/测试/文档三类命中分别规定处置；文档类不在 WritePaths 内时须请示，不得静默略过或自行修改 |
| H4 | High | T8 脱敏只替换用户名（留下 `~/secret/repo/wt`），且 `gitFailure` 把 `args.join(" ")` 原样放进 message —— `git worktree remove <绝对路径>` 的 args 本身就是泄漏面 | 统一 `redactGitText(raw, extraRoots)`：token → `[redacted]`、调用方追加根路径 → `<redacted-root>`、`/var/folders` 与 `/private/var/folders` → `<tmp>`、`/Users|/home/<name>` → `~`，并做 UTF-8 边界安全截断；`detail.args` 逐元素脱敏；测试对整个 `JSON.stringify(detail)` 做泄漏断言 |
| H5 | High | T8 用 `as ManagedWorkspaceError & { detail?: unknown }` 动态挂载 detail，类接口仍无该字段，调用方无法类型安全读取 | 给 `ManagedWorkspaceError` 增加正式字段 `detail?: GitFailureDetail` 与构造函数第四参；`detail` 用明确的 `GitFailureDetail` 类型而非 `unknown`；步骤 1 要求先确认 `tool.ts` 实际透传的字段名并以其为准 |
| H6 | High | T11 声称「无代码任务」但步骤依赖本机 package 布局与运行时环境，且交付物无可测试契约 | 新增环境前置检查命令（pkg node_modules / jiti 可解析）；规定前置缺失或 HEAD 导出无法运行时记为 `环境不可验证` 并附实测错误原文，**不得**把「跑不起来」归因于被测问题；步骤 4 增加文档结构自检命令（10 个必备小节逐个 grep，全 `OK` 才算完成），使文档交付物具备机械可验收性 |
| H7 | High | T13 只有决策文档、无输出契约，易退化为主观建议，不符「每个任务都有独立可测试交付物」 | 步骤 3 升级为硬性交付要求：≥8 类输入样本（含合法/缺 version/混入对方分支字段/control/冲突五类）且每类附**当前实际路由结果**与可复现获取方式；≥2 个候选方案且各含完整接口契约；5 项固定比较维度；结论必须是明确的待裁决项，禁止以「建议进一步调研」收尾 |
| M1 | Medium | 行号会随 T1/T2/T3 的删插立即漂移，不能作为执行定位唯一依据 | 全局约束新增「行号与符号定位规则」：一律按符号/代码片段定位，行号仅供首次跳转；内容与描述不符时以符号搜索为准并记录实际行号；禁止因行号对不上而跳过改动点 |
| M2 | Medium | T1/T2/T3 共享多个测试文件，只靠执行者记忆不可靠 | 已由 `dispatch-ir` / `skill-md` 资源锁与 `T1→T2`、`T1→T3` DAG 边覆盖；Resources 表补注「资源锁是执行器必须消费的硬约束」 |
| M3 | Medium | T9 关于「调用点无需改动」的判断需补测试 | 审阅确认该判断正确（`resolve(workspaceRoot, cwd)` 对绝对 cwd 取绝对值本身；移除 `realpath(workspaceRoot)` 只取消范围比较，不改变相对路径基准）；T9 步骤 1 已保留 symlink 与相对路径行为的既有用例，并要求反转而非删除范围用例 |
| M4 | Medium | T10「不弱化其它断言」只有原则、无清单 | 步骤 3 前置要求：先逐条列出两个测试文件的全部断言（文件:行号 + 意图），标注 `保留` / `因 c35c596 失效` / `改为反向断言`，写入报告作为 GREEN 后的比对基准；`保留` 类断言数量修改前后必须相等 |
| M5 | Medium | R6 的「禁止修改 `reviewer.md`」需要执行前机械门禁，工具链自动格式化或同步步骤可能误触 | 全局约束新增「受保护路径机械门禁」：每个任务开工前与 T14 之前各跑一次 `git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`，前两者的 ` M` 状态须与开工前完全一致，后两者须无输出；命中即停止 |

### 主 agent 自纠（审阅之外）

- **T8 分类粒度承诺过度**：v1 的 `GIT_FAILURE_RULES` 试图从 `git worktree remove` 的 stderr 区分 `dirty-worktree` / `untracked-files` / `submodule-gitlink-modified`，但 git 实际只输出一句合并文案 `contains modified or untracked files`，且 porcelain 格式（` M sub2api`）根本不会出现在 remove 的 stderr 里 —— 这三个 category 有两条是**死代码**。v2 改为失败时补采 porcelain 再分类，并把 category 收敛到实际可区分的集合，新增 `categories[]` 返回全部命中（现场真实组合 ` M sub2api` + `?? docs/...` 会返回 `["submodule-dirty","untracked-files"]`）。
- **v1 曾把 R5 判为「不成立」的风险**：本轮调查中一个 subagent 报告 R5 无法复现并建议降级，主 agent 用 6 次直接运行（工作树 ×3、`git archive HEAD` 导出 ×3）加 `env -i` 环境无关性实验证伪了该结论。T11 因此被设计为**只归因不修复**，并要求执行者独立复核、不得直接引用主 agent 的数字，且在复现结果不一致时请示而非自行选边。
