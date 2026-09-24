# 计划 A：派发合同与门禁

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。
>
> 本计划是 `docs/plans/2026-09-23-subagent-runtime-remediation-roadmap.md`（总纲）三份计划中的第一份。**开工前必须先读总纲 §1（四项用户裁决）、§2（执行顺序）、§3（缺陷登记）、§7（全局约束）**；本计划不重复总纲内容，但总纲的约束对本计划全部生效。

**目标：** 消除派发合同面上已确证的 7 项缺口（B1、B5-孤儿、H3、H4、H8、H9、M2），建立孤儿模块机械门禁（T0）与执行宿主兼容性前置检查（T-ENV），并为 schema 分支可发现性产出可裁决的探索结论（T13）。

**架构：** 全部改动集中在 canonical 合同层 `src/contracts/dispatch-ir.ts`、派发扩展 `src/subagent-dispatch/extension.ts`、模型路由 `src/subagent-dispatch/model-selection.ts`、执行合同 `src/subagent-dispatch/execution-contract.ts`、两份 profile 与仓库内 SKILL 副本。核心动作是**删除两个孤儿模块以确立 canonical 单一入口**（`src/subagent-dispatch/ir.ts`、`src/subagent-dispatch/prompt.ts`），使后续合同改动只有一处落点；随后在该单一入口上删除零语义的 `workflow` 字段、把路径文法错误改为分类可行动文案、把模型失败改为返回候选清单、把本地 preflight 拒绝从 `SUBAGENT_RPC_FAILED` 中分离出来。

**技术栈：** Node.js `>=22.19.0`、TypeScript、`node:test`、`jiti`（测试内加载 `.ts`）、`pi-subagents@0.62.0`（固定）。

## 全局约束

**总纲 §7 的全部约束对本计划生效**，包括：案发现场不得清理、批次 hunk 内容指纹保持、验收一律用临时 fixture、严格 TDD 与新增导出的 RED 例外规则、三分法归因门禁、不新增 production `.mjs`、中文文档、不提交 `enabledModels`/`models.json`、WritePaths 独占、compat 深层 import 边界、按符号而非行号定位、**每个任务步骤 0 的受保护路径机械门禁**、仓库外 SKILL 副本的条件化处理。

本计划额外约束：

- 本计划**不修改** `src/workspace/**`、`extensions/subagent-runtime.ts`、`src/subagent-dispatch/root-broker-server.ts`（这些属计划 B）。若某步骤发现必须修改，停止并报告。
- 本计划**不修改** `pi/agents/reviewer.md`（用户预存编辑，R6 决策项）。T2 只改 `delegate.md` 与 `executor.md`。
- 本计划**不新增** TDD 机械门禁（总纲 §1 裁决 ③）。T2 的 TDD 信号迁移只改 profile 正文与 SKILL 文案，不在 `dispatch-ir.ts` 中新增任何校验规则。
- 提交仅在用户明确授权时执行；本计划不含提交步骤。

## DAG

```text
T-ENV (宿主兼容性探针) ──> T0 (孤儿模块守卫) ──> T1 (只读派发合同) ──┬──> T2 (删除 workflow) ──> T13 (分支可发现性探索)
                                                                    └──> T3 (path 文法 + SKILL 修正)
T4 (模型候选清单)  ─────────────────────────────────────────────────────────────────────┐
T5 (preflight 错误码) ──────────────────────────────────────────────────────────────────┼──> A-ACC (计划 A 验收)
                                                                                        │
                              （T2、T3、T13 亦汇入 A-ACC）───────────────────────────────┘
```

**依赖理由：**

- `T-ENV → T0`：T-ENV 判定执行宿主的 control-plane 是否可用。若不可用，本计划全部「遇到 X 用 `contact_supervisor` 请示」的停止条件都失效，必须先把停止条件改写为「写入任务报告并停止」的降级形态再开工。这是可执行性前置，不是代码依赖。
- `T0 → T1`：T0 建立孤儿守卫与 allowlist 机制；T1 删除两个孤儿后必须同步清空对应 allowlist 条目，守卫转绿是 T1 的机械验收信号。T0 未完成时 T1 无法证明孤儿已彻底消除。
- `T1 → T2`：T1 删除孤儿 `prompt.ts` 后，`workflow` 的渲染点只剩 canonical 一处，T2 只需改一个 renderer。顺序颠倒会导致 T2 同时改孤儿与 canonical 两处。
- `T1 → T3`：同理，T1 删除孤儿 `ir.ts` 后 `normalizeRepoRelativePath` 只剩一份实现。
- `T2 → T13`：T13 探索字段分支可发现性，必须在 `workflow` 已删除后的 12 字段面上进行。
- `T4`、`T5` 无依赖：各自只碰独立文件（`model-selection.ts` / `execution-contract.ts`），在其余任务未完成时仍能独立验收。
- `A-ACC` 依赖 T0–T5、T13 全部产物；**T13 只产出决策文档不改代码**，故 A-ACC 的代码回归部分不等 T13，但 A-ACC 的交付完整性检查需要 T13 的文档存在。

## Resources（资源竞争，非 DAG 依赖）

| 资源 | 竞争任务 | 并发上限 |
|---|---|---|
| `dispatch-ir`（`src/contracts/dispatch-ir.ts` 写锁） | T1、T2、T3 | 1 |
| `extension-ts`（`src/subagent-dispatch/extension.ts` 写锁） | T2、T5 | 1 |
| `skill-md`（`skill-overrides/subagent-dispatch/SKILL.md` 写锁） | T2、T3 | 1 |
| `execution-contract-test`（`test/subagent-execution-contract.test.mjs` 写锁） | T5 | 1 |
| `plan-a-acceptance`（全量 typecheck + 定向套件独占） | A-ACC | 1 |

资源锁是执行器必须消费的硬约束。两个任务声明同一资源时不得并行，即使它们之间没有 DAG 依赖边。

## Waves

- **Wave 1：** T-ENV（单独，必须先完成并记录结论）
- **Wave 2：** T0
- **Wave 3：** T1、T4（T1 持 `dispatch-ir` 锁；T4 无锁无依赖，可与 T1 并行）
- **Wave 4：** T2、T3、T5（T2 持 `dispatch-ir`+`extension-ts`+`skill-md`，T3 持 `dispatch-ir`+`skill-md`，T5 持 `extension-ts`+`execution-contract-test` → **三者两两冲突，必须完全串行**；建议顺序 T2 → T3 → T5）
- **Wave 5：** T13（等 T2）
- **Wave 6：** A-ACC

**关键路径：** `T-ENV → T0 → T1 → T2 → T13 → A-ACC`。T4 与 T5 不在关键路径上。

注意 Wave 4 的表述：**不是「三项可并行」**。v2 曾把共享文件的任务写进同一个可并行 Wave（MD-6），本计划明确它们必须串行。

---

### Task T-ENV：执行宿主兼容性探针

**Deps：** `none`

**WritePaths：**
- `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md`（仅回写本任务的探针结论）

**Resources：** `none`

**Files：**
- Modify：`docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md`（文末「## T-ENV 探针结论」小节）
- 只读：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`、`extensions/subagent-runtime.ts`、`src/subagent-dispatch/authority-store.ts`

**接口契约：**
- Consumes：总纲 §1 裁决 ④ 与 §2 执行顺序
- Produces：一份**宿主能力判定**，取值 `full`（control-plane 可用，停止条件按原样执行）或 `degraded`（control-plane 不可用，所有停止条件降级为「写入任务报告并停止」）；后续全部任务据此执行

**验收标准：**
1. 探针结论已写入本计划文末，含实测命令与原始输出
2. 明确判定 `full` 或 `degraded`，并列出受影响的任务编号（T5、T7、T8、T10、T11 的停止条件依赖 `contact_supervisor`；本计划内为 T5）
3. 若判定为 `degraded`，给出降级后的停止条件文本，供后续任务直接引用
4. 探针本身**不修改任何文件、不派发任何 subagent、不触碰 live 现场**

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期：`pi/agents/reviewer.md` 与 `pi/settings.json` 的 ` M` 状态与开工前一致；`pi/models.json` 与 `var/workspaces/` 无输出。命中即停止并报告。

- [ ] **步骤 1：确认宿主是否已加载 lifecycle 批次的 AuthorityStore**

运行：

```bash
grep -n "AuthorityStore\|authorityStore" packages/pi-subagents-enhanced/extensions/subagent-runtime.ts | head
ls -la packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts
ps -o pid,lstart,command -p "$PPID" 2>/dev/null || echo "无法取得父进程信息"
```

记录：`authority-store.ts` 是否存在（应存在，lifecycle 批次新增）；`subagent-runtime.ts` 是否已注入 `authorityStore`（应已注入）；当前宿主进程的启动时间。

判定依据：若宿主进程启动时间**早于** `subagent-runtime.ts` 的 mtime，则该宿主加载的是注入前的代码，`broker.readOwnerReceipt` 不可用 → `owner` 为 `undefined` → steer/resume intent 缺 `ownerGeneration` → `SUPERVISOR_INTENT_INVALID`。

- [ ] **步骤 2：实测 control-plane 可用性**

由主 agent（非本任务的执行 subagent）执行一次最小 control-plane 探针：对一个已知 live 的 async child 发送 `subagent({action:"steer", id:"<runId>", message:"probe"})`，记录返回。

- 返回 `Steering delivered ...` → 判定 `full`
- 返回 `SUPERVISOR_INTENT_INVALID` 或 `SUPERVISOR_STALE_OWNER` → 判定 `degraded`
- 无 live child 可探测 → 记录 `未验证`，按 `degraded` 保守处理

**已知的历史实测结果（2026-09-22/23，供对照）：** 在 09-21 19:58 启动的 pi-config 宿主上，`steer` 的两种形式（带 `index: 0` 与不带）均返回 `SUPERVISOR_INTENT_INVALID: Supervisor control request blocked.`。若总纲 §2 步骤 3 的重启已完成，本步骤应转为 `full`。

- [ ] **步骤 3：写入探针结论**

在本计划文末新增：

```markdown
## T-ENV 探针结论

- 执行时间：<ISO 时间>
- 宿主进程启动时间：<...>；`subagent-runtime.ts` mtime：<...>
- AuthorityStore 注入状态：<已注入 / 未注入>
- control-plane 探针命令与原始输出：<粘贴>
- **判定：`full` / `degraded`**
- 受影响任务：<编号列表>
- 降级后的停止条件文本（仅 `degraded` 时填写）：
  > 遇到需要请示的阻塞点时，不得静默继续，也不得依赖 `contact_supervisor`。
  > 立即把阻塞点、已取得的证据、以及待裁决的问题写入任务报告的「阻塞与未决问题」章节，
  > 然后正常结束本任务（不伪造 GREEN、不放宽断言、不扩大 WritePaths）。
```

- [ ] **步骤 4：确认未产生任何副作用**

运行：`git status --short` 并与开工前对比。预期：只有本计划文档自身被修改。

---

### Task 0：孤儿模块守卫（接线门禁）

**Deps：** `T-ENV`（理由：消费 T-ENV 的宿主能力判定，确定本任务停止条件用原始形态还是降级形态）

**WritePaths：**
- `test/package-orphan-export-guard.test.mjs`

**Resources：** `none`

**Files：**
- Create：`test/package-orphan-export-guard.test.mjs`

**接口契约：**
- Consumes：`packages/pi-subagents-enhanced/package.json` 的 `exports` 映射（作为合法终端消费入口白名单）
- Produces：
  - `ALLOWLIST` 常量（`Map<相对 pkgRoot 的模块路径, 中文豁免理由>`），T1 通过删除文件并移除对应条目来兑现
  - 孤儿模块发现清单（步骤 2 的 RED 输出），作为 T1 与 T13 的输入
  - `isReferenced()` 的判定规则：**只接受能解析到目标模块真实绝对路径的相对 import**，不使用 basename 兜底

**验收标准：**
1. 守卫测试 GREEN，且 `ALLOWLIST` 每个条目都有非空中文理由
2. 步骤 2 的 RED 输出（空 allowlist 时的完整孤儿清单）已原文记入任务报告
3. allowlist 腐化守卫（条目指向已不存在的文件）在负向自检中确实 RED
4. 检测算法对同名 basename 的不同模块**不误判**（步骤 5 的负向自检覆盖）
5. `npm run typecheck` 不受影响（本任务只新增测试文件）

**背景（一句）：** 本仓库已确证 5 次同构缺陷——能力落在生产不 import 的模块里、测试对着该模块跑并全绿、随后被报告为已交付。实例见总纲 §5 与 `docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/00-INTEGRATED-runtime-gap-report.md`。

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期同 T-ENV 步骤 0。

- [ ] **步骤 1：创建守卫测试（`ALLOWLIST` 留空）**

创建 `test/package-orphan-export-guard.test.mjs`：

```js
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

// 两个测试职责分离：测试一「发现」报告当前全部孤儿（allowlist 仅暂存已确认归属的项）；
// 测试二「腐化守卫」确保 allowlist 条目对应文件被删后同步移除。两者不得合并。
const repoRoot = dirname(new URL(import.meta.url).pathname);
const pkgRoot = join(repoRoot, "packages", "pi-subagents-enhanced");
const pkgSrc = join(pkgRoot, "src");

const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const exportTargets = new Set(Object.values(pkgJson.exports ?? {}).map((p) => p.replace(/^\.\//, "")));

// 显式豁免表：每项必须写明中文理由与归属批次。
// 硬约束：步骤 2 必须在 ALLOWLIST 为空的状态下先跑出真实孤儿清单并原文入报告，
// 之后才允许填充本表。先填后跑 = 假绿（本仓库已因此丢过一次 minItems 修复）。
const ALLOWLIST = new Map([]);

// 只有这些目录下的 .ts 算生产消费方；test/ 一律不算
const PRODUCTION_ROOTS = [
  join(pkgRoot, "src"), join(pkgRoot, "extensions"), join(pkgRoot, "child-extensions"), join(pkgRoot, "scripts"),
  join(repoRoot, "src"), join(repoRoot, "pi", "extensions"), join(repoRoot, "scripts"),
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
// basename 匹配（如 "./prompt.ts"）会在不同目录存在同名文件时误报「已被引用」，
// 使守卫漏检真实孤儿。
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

function findOrphans(allowlist) {
  const modules = walkTs(pkgSrc);
  const consumers = PRODUCTION_ROOTS.flatMap(walkTs);
  const texts = new Map(consumers.map((f) => [f, readFileSync(f, "utf8")]));
  const orphans = [];
  for (const file of modules) {
    const rel = relative(pkgRoot, file).split(sep).join("/");
    if (exportTargets.has(rel) || allowlist.has(rel)) continue;
    if (!isReferenced(file, consumers, texts)) orphans.push(rel);
  }
  return orphans;
}

test("src 下每个模块都有非测试的生产消费方（孤儿模块守卫）", () => {
  const orphans = findOrphans(ALLOWLIST);
  assert.deepEqual(
    orphans, [],
    `发现孤儿模块（无非测试 importer、不在 package exports、不在 allowlist）：\n  ${orphans.join("\n  ")}\n` +
    `处理方式三选一：接线到生产入口 / 删除该模块 / 加入 ALLOWLIST 并写明中文理由与归属批次。`,
  );
});

test("ALLOWLIST 不含已失效条目（防止豁免表腐化）", () => {
  const stale = [...ALLOWLIST.keys()].filter((rel) => !existsSync(join(pkgRoot, rel)));
  assert.deepEqual(stale, [], `ALLOWLIST 含已不存在的模块，请移除条目：${stale.join(", ")}`);
});

test("ALLOWLIST 每个条目都有非空中文理由", () => {
  const empty = [...ALLOWLIST.entries()].filter(([, reason]) => typeof reason !== "string" || reason.trim().length === 0);
  assert.deepEqual(empty.map(([rel]) => rel), [], "ALLOWLIST 条目缺少理由");
});

test("检测算法不被同名 basename 误导（负向自检，在临时副本上进行）", () => {
  // MD-1：不得临时修改仓库内的 ALLOWLIST 再恢复（中断会污染工作区）。
  // 改为把整个 package 复制到临时目录，在副本上构造同名文件后调用同一算法。
  const sandbox = mkdtempSync(join(tmpdir(), "orphan-guard-neg-"));
  const trap = () => rmSync(sandbox, { recursive: true, force: true });
  try {
    cpSync(pkgSrc, join(sandbox, "src"), { recursive: true });
    // 在两个不同目录构造同名 prompt.ts：一个被引用、一个不被引用
    writeFileSync(join(sandbox, "src", "contracts", "prompt.ts"), "export const A = 1;\n");
    writeFileSync(join(sandbox, "src", "subagent-dispatch", "prompt.ts"), "export const B = 2;\n");
    writeFileSync(join(sandbox, "src", "contracts", "consumer.ts"), 'import { A } from "./prompt.ts";\nexport default A;\n');
    const consumers = walkTs(join(sandbox, "src"));
    const texts = new Map(consumers.map((f) => [f, readFileSync(f, "utf8")]));
    const referenced = join(sandbox, "src", "contracts", "prompt.ts");
    const orphan = join(sandbox, "src", "subagent-dispatch", "prompt.ts");
    assert.equal(isReferenced(referenced, consumers, texts), true, "被真实 import 的同名模块应判为已引用");
    assert.equal(isReferenced(orphan, consumers, texts), false, "仅 basename 相同的模块不得判为已引用");
  } finally {
    trap();
  }
});
```

- [ ] **步骤 2：运行确认 RED，并原文记录孤儿清单（硬门禁，不得跳过）**

运行：`node --test test/package-orphan-export-guard.test.mjs`

预期：FAIL，第一个测试的断言消息列出全部孤儿模块；第四个测试（负向自检）应 PASS。

**把 RED 输出的孤儿清单原文粘进任务报告。** 已知至少应包含这 5 项：

```
src/subagent-dispatch/ir.ts
src/subagent-dispatch/prompt.ts
src/subagent-dispatch/lifecycle-policy.ts
src/subagent-dispatch/lifecycle-identity.ts
src/subagent-dispatch/supervisor-replay.ts
```

判定规则：
- 清单**多于** 5 项 → 逐个人工核对归属后再决定处置，不得直接塞进 allowlist。
- 清单**少于** 5 项 → 说明 `isReferenced` 仍有漏检（多行 import、动态 import、re-export 等），**必须先修算法再继续**，不得当成「没有孤儿」。

- [ ] **步骤 3：按归属填充 allowlist，使守卫 GREEN**

只有两类条目允许进入 allowlist，且理由必须写明归属批次：

```js
const ALLOWLIST = new Map([
  ["src/subagent-dispatch/ir.ts", "T1 将删除：与 canonical src/contracts/dispatch-ir.ts 重复的孤儿实现，其 minItems:0 修复（commit b332005）从未进入生产路径"],
  ["src/subagent-dispatch/prompt.ts", "T1 将删除：与 canonical renderCodingDispatchPrompt 重复的孤儿 renderer"],
  ["src/subagent-dispatch/lifecycle-policy.ts", "lifecycle 批次 P1-T2 交付的纯契约模块，计划原文即声明该阶段不接入 timer/storage/broker；接线归属 lifecycle 收尾批次，不在计划 A/B/C 范围"],
  ["src/subagent-dispatch/lifecycle-identity.ts", "同上：lifecycle 批次 P1-T2 纯契约模块，待收尾批次接线"],
  ["src/subagent-dispatch/supervisor-replay.ts", "lifecycle 批次 P3-T5 交付物，当前零生产 importer；接线归属 lifecycle 收尾批次，不在计划 A/B/C 范围"],
]);
```

步骤 2 清单中的其他条目按同一格式补入并写明归属；无法判定归属的条目**不得**加入 allowlist，改为在任务报告中列为 `证据不足` 并保留 RED。

- [ ] **步骤 4：运行确认 GREEN**

运行：`node --test test/package-orphan-export-guard.test.mjs`

预期：PASS，4 个测试全绿。

- [ ] **步骤 5：验证守卫能抓到回归（负向自检，在临时副本上进行，不触碰仓库文件）**

步骤 1 的第四个测试已覆盖「同名 basename 不误判」。本步骤补充验证「allowlist 腐化守卫有效」：

```bash
SANDBOX=$(mkdtemp /tmp/orphan-guard-stale-XXXXXX)
cp test/package-orphan-export-guard.test.mjs "$SANDBOX/probe.test.mjs"
# 在副本中注入一条指向不存在文件的 allowlist 条目
python3 - "$SANDBOX/probe.test.mjs" <<'PY'
import sys,re
p=sys.argv[1]; t=open(p).read()
t=t.replace('const ALLOWLIST = new Map([', 'const ALLOWLIST = new Map([\n  ["src/subagent-dispatch/does-not-exist.ts", "负向自检"],',1)
open(p,"w").write(t)
PY
node --test "$SANDBOX/probe.test.mjs" 2>&1 | grep -E "ALLOWLIST 含已不存在|not ok" | head -3
rm -rf "$SANDBOX"
```

预期：输出含 `not ok` 与 `ALLOWLIST 含已不存在的模块`。**全程只修改 `/tmp` 下的副本，仓库内的测试文件不得被改动**（MD-1）。

- [ ] **步骤 6：运行本任务回归**

运行：`node --test test/package-orphan-export-guard.test.mjs test/pi-subagents-enhanced-package.test.mjs && npm run typecheck`

预期：全部 PASS。

---

### Task 1：只读派发合同（删双孤儿 + `writePaths` 可为空 + `boundaries` 错误模板化）

**Deps：** `T0`（理由：消费 T0 的 `ALLOWLIST` 机制与孤儿发现清单；T1 通过删除文件并移除对应条目来兑现，守卫转绿是本任务的机械验收信号）

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

**Files：**
- Modify：`src/contracts/dispatch-ir.ts` 的 `validateObject`（按符号定位）与 `normalizeBoundaries`（按符号定位，当前 `minItems: 1`）
- Delete：`src/subagent-dispatch/ir.ts`、`src/subagent-dispatch/prompt.ts`
- Modify：5 个测试文件的 import 指向 canonical
- Create：`test/subagent-dispatch-readonly-writepaths.test.mjs`

**接口契约：**
- Consumes：T0 的 `ALLOWLIST` 与孤儿发现清单
- Produces：
  - `compileCodingDispatchIR`（package export `./dispatch-ir`）接受 `boundaries.writePaths: []`，语义为「显式只读派发」
  - 新增常量 `FIELD_SHAPE_HINTS`（键为 `${location}.${key}`，与 `fail()` 的 keypath 同格式）；`validateObject` 的 **unknown field 与 missing field 两个分支都**在 message 追加 `; full shape: <完整对象模板>`
  - canonical 单一入口：仓库内不再存在第二份 `compileCodingDispatchIR` / `renderCodingDispatchPrompt`

**验收标准：**
1. `compileCodingDispatchIR` 对 `writePaths: []` 成功返回，`ir.boundaries.writePaths` 深度等于 `[]`
2. 省略 `boundaries` 时抛 `CodingDispatchContractError`，`code === "INVALID_CONTRACT"`，message 含 `writePaths`、`excludedWork`、`forbiddenActions` 与 `full shape:`
3. 传入 coding 非法的 `outputMode` 时，message 含 `contains unknown field outputMode` **且**含 `full shape:`（unknown 分支也要有 hint）
4. 两个孤儿文件不存在；T0 守卫 GREEN 且 `ALLOWLIST` 不再含这两条
5. 全仓 grep `subagent-dispatch/ir` 与 `subagent-dispatch/prompt` 零命中
6. **`test/subagent-dispatch-validation-errors.test.mjs` 中原有的「空 writePaths 是显式只读派发」测试被保留**，只把 import 改指 canonical（BL-1：不得以「新测试已覆盖」为由删除既有回归保护）
7. `npm run typecheck` PASS

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期同 T-ENV 步骤 0。

- [ ] **步骤 1：编写失败测试**

创建 `test/subagent-dispatch-readonly-writepaths.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
// 必须穿过 package public export 指向的 canonical 实现；
// 不得 import src/subagent-dispatch/ir.ts（孤儿，历史上导致假绿）
const { compileCodingDispatchIR, CodingDispatchContractError } =
  await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");

// 注意：本 helper 不含 workflow 键。T2 会删除该字段；若 T1 先执行而 T2 未执行，
// canonical 仍要求 workflow 必填，则本 helper 需临时带上 workflow，并在 T2 步骤 9 移除。
// 为避免中间态反复改动，本 helper 直接按 T2 之后的目标形态书写，
// 因此 T1 的 RED 会同时包含「workflow 缺失」这一项 —— 属预期，见步骤 2。
function contract(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "readonly-probe",
    title: "只读派发合同探针",
    agent: "executor",
    risk: "low",
    objective: "验证 writePaths 可为空的只读派发。",
    requirements: ["只读检查并报告实际观测。"],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: [], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["报告实际观测。"] },
    execution: { timeoutMs: 1000 },
    ...overrides,
  };
}

test("canonical 合同接受空 writePaths 作为显式只读派发", () => {
  const ir = compileCodingDispatchIR(contract({ workflow: { mode: "docs-only", reason: "只读探针" } }), { cwd: "/repo" });
  assert.deepEqual(ir.boundaries.writePaths, []);
});

test("空 writePaths 参与 hash，且与非空 writePaths 的 hash 不同", () => {
  const readOnly = compileCodingDispatchIR(contract({ workflow: { mode: "docs-only", reason: "只读探针" } }), { cwd: "/repo" });
  const writing = compileCodingDispatchIR(
    contract({ workflow: { mode: "docs-only", reason: "只读探针" }, boundaries: { writePaths: ["docs/a.md"], excludedWork: [], forbiddenActions: [] } }),
    { cwd: "/repo" },
  );
  assert.equal(typeof readOnly.hash, "string");
  assert.match(readOnly.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(readOnly.hash, writing.hash);
});

test("缺失 boundaries 的错误给出完整对象模板", () => {
  const input = contract({ workflow: { mode: "docs-only", reason: "只读探针" } });
  delete input.boundaries;
  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/repo" }),
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

test("unknown field 分支同样给出模板（覆盖现场 outputMode 场景）", () => {
  assert.throws(
    () => compileCodingDispatchIR(contract({ workflow: { mode: "tdd" }, outputMode: "inline" }), { cwd: "/repo" }),
    (error) => {
      assert.equal(error.code, "INVALID_CONTRACT");
      assert.match(error.message, /contains unknown field outputMode/);
      return true;
    },
  );
});

test("缺失 context 与 acceptance 时同样给出模板", () => {
  for (const field of ["context", "acceptance"]) {
    const input = contract({ workflow: { mode: "docs-only", reason: "只读探针" } });
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

预期 FAIL，且失败原因必须是下列**断言级**失败：
- 测试 1、2 因 `INVALID_CONTRACT: boundaries.writePaths must contain at least 1 item(s)` 失败（canonical 当前 `minItems: 1`）
- 测试 3、5 因 message 不含 `full shape:` 失败
- 测试 4 因 unknown field 分支当前不带 hint，断言 `contains unknown field outputMode` 会通过但后续无 hint 可断言——若该测试意外 PASS，说明它只断言了 message 主体，请补上 `assert.match(error.message, /full shape:/)` 使其在 RED 阶段确实失败

不得出现 import 级失败。

- [ ] **步骤 3：最小实现——canonical 允许空 writePaths**

在 `src/contracts/dispatch-ir.ts` 的 `normalizeBoundaries` 中把 `minItems: 1` 改为 `minItems: 0`，并加中文注释：

```js
function normalizeBoundaries(value) {
  const boundaries = validateObject(value, "boundaries", ["writePaths", "excludedWork", "forbiddenActions"]);
  return {
    // 空数组是显式只读声明：纯运行/观测/文档类派发不再被迫编造写入路径。
    // 该语义此前只存在于孤儿 src/subagent-dispatch/ir.ts（commit b332005 改的是孤儿那份），
    // 从未进入生产路径，导致 14 次 docs-only 派发全部在编造 writePaths。
    writePaths: normalizeStringArray(boundaries.writePaths, "boundaries.writePaths", { minItems: 0, item: normalizeRepoRelativePath }),
    excludedWork: normalizeStringArray(boundaries.excludedWork, "boundaries.excludedWork"),
    forbiddenActions: normalizeStringArray(boundaries.forbiddenActions, "boundaries.forbiddenActions"),
  };
}
```

- [ ] **步骤 4：最小实现——两个分支都加错误模板**

在 `validateObject` 之前新增常量，并改造 `validateObject` 的**两个** `fail()` 分支：

```js
// 键为 `${location}.${key}`，与 fail() 的 keypath 完全一致；值为可直接复制的完整对象模板。
// unknown field 与 missing field 两个分支都要查这张表：现场既有 missing boundaries（15 次），
// 也有 unknown outputMode（1 次），只覆盖一个分支会漏掉另一类。
const FIELD_SHAPE_HINTS = {
  "$.boundaries": '{"writePaths":["src/a.ts" or "src/**"],"excludedWork":[],"forbiddenActions":[]} (writePaths may be [] for read-only dispatch)',
  "$.context": '{"knownFacts":[],"decisions":[],"relevantFiles":[]}',
  "$.acceptance": '{"criteria":["observable acceptance statement"]}',
  "$.workflow": '{"mode":"tdd"} or {"mode":"existing-tests"|"docs-only","reason":"non-empty"}',
  "$.execution": '{"cwd":"<optional absolute path>","worktree":<optional boolean>}',
};

function shapeHint(location, key) {
  const hint = FIELD_SHAPE_HINTS[`${location}.${key}`];
  return hint ? `; full shape: ${hint}` : "";
}

function validateObject(value, location, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) failTypeMismatch(location, "object", value);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("INVALID_CONTRACT", `${location} contains unknown field ${key}${shapeHint(location, key)}`, `${location}.${key}`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      fail("INVALID_CONTRACT", `${location} is missing required field ${key}${shapeHint(location, key)}`, `${location}.${key}`);
    }
  }
  return value;
}
```

注：`shapeHint(location, key)` 对 unknown field 会查到该 location 下**同名字段**的模板；`outputMode` 不在 `FIELD_SHAPE_HINTS` 中，故 unknown 分支对它返回空串。为使验收标准 3 成立，需为 generic-only 字段补一条统一提示：

```js
const CODING_REJECTED_GENERIC_FIELDS = new Set([
  "task", "cwd", "output", "outputMode", "outputSchema", "artifacts", "progress", "worktree", "skill", "reads",
]);
```

并在 unknown 分支中：

```js
    if (!allowed.has(key)) {
      const genericNote = CODING_REJECTED_GENERIC_FIELDS.has(key)
        ? ` (${key} is a generic-dispatch field and is rejected by dispatch-ir.v1; coding uses execution.worktree instead of worktree)`
        : "";
      fail("INVALID_CONTRACT", `${location} contains unknown field ${key}${genericNote}${shapeHint(location, key)}`, `${location}.${key}`);
    }
```

- [ ] **步骤 5：运行确认 GREEN**

运行：`node --test test/subagent-dispatch-readonly-writepaths.test.mjs`

预期：PASS，5 个测试全绿。

- [ ] **步骤 6：删除两个孤儿模块**

```bash
rm packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts
rm packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts
```

- [ ] **步骤 7：把 5 个测试文件的 import 改指 canonical，并保留既有测试（BL-1）**

逐个修改：

- `test/subagent-dispatch-validation-errors.test.mjs`
  - `:7` 的 `jiti.import(".../src/subagent-dispatch/ir.ts")` 改为 `".../src/contracts/dispatch-ir.ts"`
  - `:21` fixture 中 `writePaths: ["packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts"]` 改为仍存在的文件，例如 `writePaths: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"]`
  - **`:89-93` 的 `"coding contract with empty writePaths is an explicit read-only dispatch"` 测试必须保留**，只随 import 迁移到 canonical。BL-1 的结论：迁移即可继续验证「canonical 入口接受空 writePaths」，删除会减少回归保护而非消除重复。保留后它与本任务新建的 `test/subagent-dispatch-readonly-writepaths.test.mjs` 形成双入口覆盖（一个是既有 validation-errors 套件、一个是专项套件），二者断言侧重不同，不构成冗余。
- `test/subagent-dispatch-ir.test.mjs`
  - `:7` 主 import 改为 `.../src/contracts/dispatch-ir.ts`
  - `:8` 的 `compileRuntimeCodingDispatchIR` 别名与主 import 重复，删除该别名并把用法统一到单一 import
  - `:9` 的 `renderCodingDispatchPrompt` 同样改从 canonical 导入
- `test/subagent-dispatch-ir-coercion.test.mjs:4`：改为 `.../src/contracts/dispatch-ir.ts`
- `test/pi-subagents-runtime.integration.mjs:10`：改为 `.../src/contracts/dispatch-ir.ts`
- `test/subagent-runtime-resource-isolation.test.mjs:106-107`：从 fixture 路径列表移除两个已删文件的路径项

- [ ] **步骤 8：移除 T0 allowlist 中已兑现的两条**

编辑 `test/package-orphan-export-guard.test.mjs`，删除 `ALLOWLIST` 中 `src/subagent-dispatch/ir.ts` 与 `src/subagent-dispatch/prompt.ts` 两个条目。lifecycle 批次的三条保留（其接线不属计划 A/B/C 范围）。

- [ ] **步骤 9：运行确认 GREEN（含孤儿守卫）**

运行：

```bash
node --test test/package-orphan-export-guard.test.mjs \
  test/subagent-dispatch-readonly-writepaths.test.mjs \
  test/subagent-dispatch-validation-errors.test.mjs \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-ir-coercion.test.mjs
```

预期：PASS。孤儿守卫 GREEN 即证明两个模块已彻底删除且 allowlist 已同步。

- [ ] **步骤 10：验证孤儿引用已清零**

运行：`grep -rn "subagent-dispatch/ir\|subagent-dispatch/prompt" --include=*.ts --include=*.mjs packages/ src/ pi/ test/ scripts/`

预期：**零命中**。

- [ ] **步骤 11：检查发行清单与 package 配置未受影响**

运行：

```bash
grep -n "ir.ts\|prompt.ts" packages/pi-subagents-enhanced/package.json
node --test test/pi-subagents-enhanced-package.test.mjs
npm run verify:subagents-enhanced
```

预期：`package.json` 中零命中（两个孤儿不在 `files`/`exports` 中）；两项验证 PASS。若 `verify:package` 因发行清单变化而 FAIL，把实际输出记入报告并停止请示，**不得自行修改 `package.json`**（超出本任务 WritePaths）。

- [ ] **步骤 12：运行本任务回归**

运行：

```bash
node --test test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs \
  test/subagent-execution-contract.test.mjs test/subagent-dispatch-schema-coercion.test.mjs \
  test/subagent-dispatch-schema-security.test.mjs test/subagent-dispatch-skill.test.mjs \
  test/subagent-runtime-resource-isolation.test.mjs
npm run typecheck
```

预期：全部 PASS。

---

### Task 2：删除 `workflow` 字段、迁移 TDD 信号、并锁定 contractHash 影响

**Deps：** `T1`（理由：T1 已删除孤儿 `prompt.ts`，`workflow` 的渲染点收敛为 canonical 一处）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `pi/agents/delegate.md`
- `pi/agents/executor.md`
- `test/subagent-dispatch-workflow-removed.test.mjs`
- `test/subagent-dispatch-contract-hash-compat.test.mjs`
- `test/subagent-dispatch-readonly-writepaths.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-validation-errors.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`
- `test/subagent-dispatch-schema-coercion.test.mjs`
- `test/subagent-dispatch-schema-security.test.mjs`
<!-- 已安装副本 /Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md 不列入 WritePaths：它在仓库外、不受 git 管理、在其他环境不存在。按总纲 §7「仓库外文件的处理规则」作为条件化环境步骤同步，不存在则记录 skip 且不阻塞本任务。 -->

**Resources：** `dispatch-ir`、`extension-ts`、`skill-md`（各最多 1 个并发）

**Files：**
- Modify：`src/contracts/dispatch-ir.ts` 的 `WORKFLOW_MODES`、`TOP_LEVEL_KEYS`、`COERCIBLE_FIELDS`、`normalizeWorkflow`、`compileCodingDispatchIR` 的 canonical 装配、`FIELD_SHAPE_HINTS`（T1 新增）、prompt 渲染段（均按符号定位）
- Modify：`src/subagent-dispatch/extension.ts` 的 schema `workflow` 属性、version 启发式（按符号定位）
- Modify：`skill-overrides/subagent-dispatch/SKILL.md`
- Modify：`pi/agents/delegate.md`、`pi/agents/executor.md`
- Create：`test/subagent-dispatch-workflow-removed.test.mjs`、`test/subagent-dispatch-contract-hash-compat.test.mjs`

**接口契约：**
- Consumes：T1 的 canonical 单一入口与 `FIELD_SHAPE_HINTS`
- Produces：
  - `dispatch-ir.v1` 顶层字段集合为 12 项：`version, taskId, title, agent, model, risk, objective, requirements, context, boundaries, acceptance, execution`；必填集合为其中除 `model` 外全部（`REQUIRED_TOP_LEVEL_KEYS` 由 `TOP_LEVEL_KEYS.filter(k => k !== "model")` 派生，删除 `workflow` 会**同时**减少必填项，这是预期行为）
  - 传入 `workflow` 时抛 `INVALID_CONTRACT`，message 含 `contains unknown field workflow`
  - `renderCodingDispatchPrompt(ir)` 不含 `## Workflow` 段、不含 `Mode:`、不含 `Exemption reason:`；`## Required Report` 第 3 项 `RED/GREEN or exemption evidence` **保持不变**
  - **contractHash 兼容契约（BL-2 / 总纲 §1 裁决 ②）**：`hashCanonical` 的输入集合随字段删除而改变，因此同一逻辑请求的 `contractHash` 在变更前后不同。既有 durable record 的 `requestHash` 是对**已存储的 request 对象**重算的，该对象内的 `contractHash` 字符串不变，故 record 仍自洽可加载。本任务必须以测试锁定这一性质。

**验收标准：**
1. 不含 `workflow` 的完整输入编译成功，`"workflow" in ir === false`
2. 传入 `workflow`（三种 mode 各一次）抛 `INVALID_CONTRACT` 且 message 含 `unknown field workflow`
3. `renderCodingDispatchPrompt(ir)` 不含 `## Workflow`、`Mode:`、`Exemption reason:`、`Follow the selected workflow`；仍含 `RED/GREEN or exemption evidence`
4. `grep -rn "workflow" src/contracts/dispatch-ir.ts` 零命中（MD-2：含 `FIELD_SHAPE_HINTS["$.workflow"]` 已删除）
5. `extension.ts` 的 schema `properties` 不含 `workflow` 键；`codingWorkflowSpawnParams` 与 `genericWorkflowSpawnParams` **保持原样未被修改**（二者是 spawn 编排概念，与 IR 的 `workflow` 字段同名但无关）
6. **`test/subagent-dispatch-contract-hash-compat.test.mjs` PASS**：按旧 schema（含 `workflow`）算出的 `contractHash` 所构成的 workspace request fixture，在变更后仍能通过 `createManagedWorkspaceRequestV2` 校验、`requestHash` 仍自洽、不抛错
7. `pi/agents/delegate.md` 与 `executor.md` 的原有语义**逐段保留**（HI-2），只新增/修改 TDD 相关表述
8. 仓库内 SKILL 副本不再出现 `workflow.mode` / `workflow.reason` 指引；已安装副本存在时与之逐字一致，不存在时记录 skip
9. `npm run typecheck` PASS

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期同 T-ENV 步骤 0。**本任务会修改 `pi/agents/delegate.md` 与 `executor.md`，但绝不得修改 `reviewer.md`**（用户预存编辑，R6 决策项）。开工前先记录 `git diff --stat -- pi/agents/` 作为基线，收工时对比确认只有 delegate/executor 变化。

- [ ] **步骤 1：盘点全部消费点**

运行：

```bash
grep -rn "ir\.workflow\|workflow\.mode\|workflow\.reason\|normalizeWorkflow\|WORKFLOW_MODES" \
  --include=*.ts packages/pi-subagents-enhanced/src packages/pi-subagents-enhanced/extensions \
  packages/pi-subagents-enhanced/child-extensions pi/extensions src
grep -n '"workflow"' packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
grep -n "workflow" packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts
sed -n '/^export function splitDispatchEnvelope/,/^}/p' packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts
```

把命中清单记入任务报告。**已知必须改的**：`dispatch-ir.ts` 的 `WORKFLOW_MODES`、`TOP_LEVEL_KEYS` 中的 `"workflow"`、`COERCIBLE_FIELDS` 中的 `"workflow"`、`normalizeWorkflow` 整个函数、canonical 装配中的 `workflow:` 行、`FIELD_SHAPE_HINTS["$.workflow"]`、prompt 渲染的三处；`extension.ts` 的 schema `workflow` 属性与 version 启发式。

**已知必须保留的**：`extension.ts` 的 `codingWorkflowSpawnParams`、`genericWorkflowSpawnParams` 及其 `workflowKey` 参数。

**已确证的事实（不必再猜）**：`splitDispatchEnvelope` **不引用** `ir.workflow`（二审已实读确认），因此本任务不需改动它；但它把整个 IR 作为 `contractHash` 的输入来源，故 hash 会变——这由步骤 8 的兼容测试覆盖。

若盘点发现清单之外的生产消费点，逐个判定后再改，不得为求 GREEN 而保留 `workflow` 字段。

- [ ] **步骤 2：验证 `boundaries` 是 coding-exclusive（HI-3，先验证再替换）**

T2 步骤 6 要把 version 启发式的特征字段从 `workflow` 换成 `boundaries`。该替换只有在 `boundaries` 确为 coding-exclusive 时才等价。运行：

```bash
grep -n "boundaries" packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts
grep -n "boundaries" packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
sed -n '/for (const key of \["model", "output"/,+3p' packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
```

**已确证的事实（2026-09-23 实读）**：
- `generic-prompt.ts` **零引用** `boundaries`
- `extension.ts` 中 `boundaries` 只出现在 schema 的 coding 字段区与 `standaloneWorkspacePolicy(kind, kind === "coding" ? input.boundaries.writePaths : [])`——即只在 `kind === "coding"` 时被读取
- generic child 的字段复制清单是 `["model","output","outputMode","outputSchema","skill","reads","progress","acceptance"]`，**不含 `boundaries`**

结论：`boundaries` 属 coding-exclusive，替换成立。把上述三条证据原文记入任务报告。**若你的实读结果与此不符，停止并报告，不要继续替换。**

- [ ] **步骤 3：编写失败测试（workflow 移除）**

创建 `test/subagent-dispatch-workflow-removed.test.mjs`：

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { compileCodingDispatchIR, renderCodingDispatchPrompt, CodingDispatchContractError } =
  await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");
const repoRoot = dirname(new URL(import.meta.url).pathname);
const overrideSkill = join(repoRoot, "..", "skill-overrides", "subagent-dispatch", "SKILL.md");
const installedSkill = "/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md";

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

test("顶层必填集合随 workflow 删除而减为 11 项（model 之外）", () => {
  // 逐个删除任一必填字段都应报 missing；workflow 不再在必填集合中
  const required = ["version", "taskId", "title", "agent", "risk", "objective",
                    "requirements", "context", "boundaries", "acceptance", "execution"];
  for (const field of required) {
    const input = contract();
    delete input[field];
    assert.throws(
      () => compileCodingDispatchIR(input, { cwd: "/repo" }),
      (e) => e.code === "INVALID_CONTRACT" && e.message.includes(`is missing required field ${field}`),
      `${field} 应仍为必填`,
    );
  }
});

test("传入 workflow 抛 INVALID_CONTRACT 且指出是未知字段", () => {
  for (const workflow of [{ mode: "tdd" }, { mode: "docs-only", reason: "只读" }, { mode: "existing-tests", reason: "既有覆盖" }]) {
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

test("渲染的 child prompt 不再含 Workflow 段，但保留 RED/GREEN 证据要求", () => {
  const prompt = renderCodingDispatchPrompt(compileCodingDispatchIR(contract(), { cwd: "/repo" }));
  for (const banned of ["## Workflow", "Mode:", "Exemption reason:", "Follow the selected workflow"]) {
    assert.equal(prompt.includes(banned), false, `prompt 不应包含 ${JSON.stringify(banned)}`);
  }
  assert.match(prompt, /RED\/GREEN or exemption evidence/);
  assert.match(prompt, /## Execution Discipline/);
});

test("canonical 合同源码不再出现 workflow 标识符（MD-2）", () => {
  const src = readFileSync(join(repoRoot, "..", "packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"), "utf8");
  assert.equal(/workflow/i.test(src), false, "dispatch-ir.ts 应完全不含 workflow，包括 FIELD_SHAPE_HINTS 条目");
});

test("仓库内 SKILL 副本不再指引 workflow.mode/reason，且已含迁移后的 TDD 表述", () => {
  const override = readFileSync(overrideSkill, "utf8");
  assert.equal(/workflow\.mode|workflow\.reason/.test(override), false);
  assert.match(override, /test-driven-development\/SKILL\.md/);
  assert.match(override, /writePaths[^\n]*为空|只读派发/);
});

test("已安装 SKILL 副本存在时与仓库副本逐字一致，不存在时 skip（HI-1）", (t) => {
  if (!existsSync(installedSkill)) {
    t.skip("已安装副本不存在于本环境");
    return;
  }
  assert.equal(readFileSync(installedSkill, "utf8"), readFileSync(overrideSkill, "utf8"),
    "仓库副本与已安装副本必须逐字一致");
});
```

- [ ] **步骤 4：运行确认 RED**

运行：`node --test test/subagent-dispatch-workflow-removed.test.mjs`

预期 FAIL，且为断言级失败：测试 1 因 `workflow` 仍是必填而抛 `is missing required field workflow`；测试 3 因 `workflow` 当前合法而不抛；测试 4/5/6 因 prompt、源码、SKILL 仍含 workflow 而失败；测试 2 因 `workflow` 仍在必填集合而失败。测试 7 在已安装副本不存在时应 skip 而非 fail。

- [ ] **步骤 5：最小实现——canonical 合同移除 workflow**

在 `src/contracts/dispatch-ir.ts`：
1. 删除 `const WORKFLOW_MODES = new Set(["tdd", "existing-tests", "docs-only"]);`
2. 从 `TOP_LEVEL_KEYS` 数组删除 `"workflow",` 一行（`REQUIRED_TOP_LEVEL_KEYS` 由其派生，自动同步）
3. `COERCIBLE_FIELDS` 改为 `["requirements", "context", "boundaries", "acceptance", "execution"]`
4. 整体删除 `normalizeWorkflow` 函数
5. 从 `compileCodingDispatchIR` 的 canonical 装配中删除 `workflow: normalizeWorkflow(source.workflow),` 一行
6. 从 T1 新增的 `FIELD_SHAPE_HINTS` 中删除 `"$.workflow"` 条目

- [ ] **步骤 6：最小实现——prompt renderer 移除 Workflow 段**

在 `src/contracts/dispatch-ir.ts`：
1. 删除 prompt 文本数组中的 `` `Workflow mode: ${ir.workflow.mode}`, `` 与 `...(ir.workflow.reason === undefined ? [] : [`Workflow reason: ${ir.workflow.reason}`]),` 两行
2. 删除 `const workflowReason = ...` 整行
3. 把 `"", "## Workflow", \`- Mode: ...\`${workflowReason}, "- Follow the selected workflow exactly and preserve its evidence.",` 替换为：

```js
    "", "## Execution Discipline",
    "- Production code changes follow TDD: observe an exact RED first, then the minimal GREEN.",
    "- Read-only or docs-only dispatch (empty declared write scope) is exempt from RED/GREEN and must instead cite observed evidence: command output, file paths and line numbers.",
```

4. `## Required Report` 第 3 项 `RED/GREEN or exemption evidence` **保持不变**

- [ ] **步骤 7：最小实现——extension schema 与 version 启发式**

在 `src/subagent-dispatch/extension.ts`：
1. 删除 schema `properties` 中的 `workflow: runtimeValidated({...})` 整个属性（含其 `mode` enum 与 `reason` 定义）
2. version 启发式（按符号定位 `INVALID_CODING_ROUTER`）把 `workflow` 等量替换为 `boundaries`（依据见步骤 2 的实证）：

```ts
    if (Object.hasOwn(input, "taskId") || Object.hasOwn(input, "objective") || Object.hasOwn(input, "boundaries")) {
      return failure("INVALID_CODING_ROUTER", "input resembles a coding contract but is missing version: \"dispatch-ir.v1\"; coding dispatch routes on the version field");
    }
```

本步骤只做等量替换，不扩展启发式覆盖面（M3 属延后项）。
3. **不得修改** `codingWorkflowSpawnParams`、`genericWorkflowSpawnParams` 及其 `workflowKey` 参数
4. 本步骤的 diff hunk 必须与 lifecycle 批次既有 hunk 不重叠。批次在 `extension.ts` 的 hunk 为：`16, 129-131, 1017-1025, 1033-1054, 1058-1086, 1237, 1274, 1369, 1403-1404, 1413, 1417-1419, 1501`（新文件行号）。schema 的 `workflow` 属性约在 `64-71`、启发式约在 `919-921`，均不在其中。用总纲 §7 的**内容指纹**方式验证，不得用绝对行号（BL-4）：

```bash
git diff -- packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts > /tmp/t2-ext-after.patch
# 与开工前保存的 /tmp/t2-ext-before.patch 比对：批次既有增删文本必须逐条仍存在
```

开工前先执行 `git diff -- packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts > /tmp/t2-ext-before.patch` 保存基线。

- [ ] **步骤 8：编写 contractHash 兼容测试（BL-2 / 裁决 ②）**

创建 `test/subagent-dispatch-contract-hash-compat.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createManagedWorkspaceRequestV2 } = await jiti.import(
  "../packages/pi-subagents-enhanced/src/workspace/contract.ts",
);

// 按旧 schema（含 workflow）计算出的 contractHash。这是一个固定的 64 位十六进制字符串，
// 代表变更前已持久化的 workspace request 所携带的身份。
const LEGACY_CONTRACT_HASH = "a".repeat(64);

function legacyRequest(overrides = {}) {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    owner: { kind: "standalone-subagent", rootSessionId: "root-legacy" },
    originRoot: "/tmp",
    requestedCwd: "/tmp",
    originRef: "refs/heads/main",
    baseCommit: "b".repeat(40),
    contractHash: LEGACY_CONTRACT_HASH,
    policy: { writePaths: [] },
    ...overrides,
  };
}

test("变更前列出的既有 request 在变更后仍能通过 v2 校验（不抛错）", () => {
  // 关键性质：contractHash 对 request 而言只是一个 SHA-256 字符串，
  // 校验的是格式而非可复算性，因此旧 hash 不会被新 schema 拒绝。
  const request = createManagedWorkspaceRequestV2(legacyRequest());
  assert.equal(request.contractHash, LEGACY_CONTRACT_HASH);
});

test("contractHash 非 SHA-256 时仍按既有规则拒绝（校验未被放宽）", () => {
  assert.throws(() => createManagedWorkspaceRequestV2(legacyRequest({ contractHash: "not-a-hash" })));
  assert.throws(() => createManagedWorkspaceRequestV2(legacyRequest({ contractHash: "a".repeat(63) })));
});

test("新编译的 IR hash 是 64 位十六进制，且与旧 hash 不同（预期行为，登记为残余风险）", async () => {
  const { compileCodingDispatchIR } = await jiti.import(
    "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts",
  );
  const ir = compileCodingDispatchIR({
    version: "dispatch-ir.v1",
    taskId: "hash-compat",
    title: "contractHash 兼容探针",
    agent: "executor",
    risk: "low",
    objective: "验证删除 workflow 后 hash 仍为合法 SHA-256。",
    requirements: ["只读验证。"],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: [], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["hash 格式合法。"] },
    execution: { timeoutMs: 1000 },
  }, { cwd: "/repo" });
  assert.match(ir.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(ir.hash, LEGACY_CONTRACT_HASH);
  // 残余风险登记：不支持跨变更点的 contractHash 比较；
  // 任何横跨该变更的在途工作流必须重新派发。
});
```

注：`legacyRequest()` 的字段名与 `originRoot`/`requestedCwd` 的合法性要求以 `src/workspace/contract.ts` 的 `REQUEST_V2_KEYS` 与 `digest()` 实现为准。**步骤 8 的第一个动作是读该文件确认字段名与路径校验规则**；若 fixture 需要真实存在的目录，改用 `mkdtemp` 创建临时目录，不得使用 `/tmp` 字面量敷衍。若 `createManagedWorkspaceRequestV2` 的校验会拒绝不存在的路径，本测试必须在临时目录上进行——这属 fixture 修正，不得放宽断言。

- [ ] **步骤 9：迁移 TDD 信号到 profile（HI-2：逐段保留原文，只改 TDD 表述）**

`pi/agents/delegate.md` 的 `systemPromptMode: replace` 意味着**正文即完整 system prompt**，删除任何一段都是删除运行时安全语义。原文三段为：

```
① 你是主力执行代理，承接复杂实现、跨模块 TDD 开发与源码级归因诊断。先完整阅读任务引用的诊断报告原文（若有）与相关实现，生产变更按 TDD 执行：先观察精确 RED，再最小实现到 GREEN。只修改允许的路径，遵守禁止事项与停止条件，保持最小 diff。
② 证据优先于推断：结论必须引用现场文件、代码路径或测试输出，不得以转述或记忆替代。运行聚焦验证并如实报告结果，未验证的行为不得声明完成。
③ 决策阻塞、前提与证据矛盾、或需要超出声明写路径时，使用 `contact_supervisor`，`reason: "need_decision"`，并保持存活等待回复。不得委派其他 subagent。
```

**只允许修改 ① 中的 TDD 分句，② 与 ③ 必须逐字保留**，并在 ① 之后新增一段只读豁免说明。修改后的正文：

```markdown
你是主力执行代理，承接复杂实现、跨模块 TDD 开发与源码级归因诊断。先完整阅读任务引用的诊断报告原文（若有）与相关实现。生产代码变更一律按 TDD 执行，无例外、无需声明模式：先观察精确 RED（具体断言失败，不是 module not found、不是 typecheck 失败），再写最小实现到 GREEN。只修改允许的路径，遵守禁止事项与停止条件，保持最小 diff。

任务不再提供 `workflow` 之类的模式开关，也不接受以「本次是文档任务」为由跳过 TDD。是否豁免只由一个事实决定：本次是否修改生产代码或配置。修改即 TDD。若任务的 declared write scope 为空（`boundaries.writePaths` 为空数组，即纯只读/观测/文档派发），则不要求 RED/GREEN，但必须在报告中给出实际观测证据（命令输出、文件路径、行号）。

证据优先于推断：结论必须引用现场文件、代码路径或测试输出，不得以转述或记忆替代。运行聚焦验证并如实报告结果，未验证的行为不得声明完成。

决策阻塞、前提与证据矛盾、或需要超出声明写路径时，使用 `contact_supervisor`，`reason: "need_decision"`，并保持存活等待回复。不得委派其他 subagent。
```

`pi/agents/executor.md` 原文两段为：

```
① 根据收到的任务目标、约束和验收要求完成编码。先阅读相关代码与测试，生产变更按 TDD 执行。只修改允许的路径，遵守禁止事项，保持最小 diff。运行要求的验证并报告结果。
② 决策阻塞时使用 `contact_supervisor`，`reason: "need_decision"`。不得委派其他 subagent。
```

修改后（同样只改 ① 的 TDD 分句、② 逐字保留）：

```markdown
根据收到的任务目标、约束和验收要求完成编码。先阅读相关代码与测试。生产代码变更一律按 TDD 执行：先观察精确 RED，再写最小实现到 GREEN。declared write scope 为空（`boundaries.writePaths` 为空数组）的只读任务豁免 RED/GREEN，但必须给出实际观测证据。只修改允许的路径，遵守禁止事项，保持最小 diff。运行要求的验证并报告结果。

决策阻塞时使用 `contact_supervisor`，`reason: "need_decision"`。不得委派其他 subagent。
```

两个文件的 frontmatter（`name`/`description`/`models`/`thinking`/`tools`/`systemPromptMode`/`inheritProjectContext`）**保持原样不动**。

- [ ] **步骤 10：验证 profile 语义未被削减**

运行：

```bash
for f in pi/agents/delegate.md pi/agents/executor.md; do
  echo "── $f"
  for needle in "contact_supervisor" "need_decision" "不得委派其他 subagent" "证据优先于推断" "未验证的行为不得声明完成"; do
    grep -qF "$needle" "$f" && echo "  OK   $needle" || echo "  MISS $needle"
  done
done
```

预期：`delegate.md` 五项全 `OK`；`executor.md` 的 `contact_supervisor`、`need_decision`、`不得委派其他 subagent` 三项 `OK`（`证据优先于推断` 与 `未验证的行为不得声明完成` 原本只存在于 `delegate.md`，不要求 executor 有）。任一 `MISS` 即为 HI-2 复现，必须补回。

- [ ] **步骤 11：更新仓库内 SKILL 副本**

对 `skill-overrides/subagent-dispatch/SKILL.md`：
1. 删除「Coding」节中关于 `workflow` 的全部指引，包括 `` `tdd` 禁止 `workflow.reason`；`existing-tests`/`docs-only` 必须提供 reason `` 这句，以及示例对象里的 `workflow: { mode: "existing-tests", reason: "..." },`
2. 把「派发适合性与探索型工作流」节中的
   > workflow tdd 的派发必须包含 /Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md 路径

   改为
   > 所有 coding 派发都必须在 `requirements` 中包含 `/Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md` 路径并要求执行者先 read（child 环境不继承 skills）。仅当 `boundaries.writePaths` 为空数组（显式只读派发）时可豁免该条，但 `requirements` 必须改为要求给出实际观测证据。
3. 在「Coding」节新增：

```markdown
### TDD 与只读豁免

`dispatch-ir.v1` 不含 `workflow` 字段；传入会得到 `INVALID_CONTRACT: $ contains unknown field workflow`。TDD 不是可选模式而是默认纪律，由 profile system prompt 与 `requirements` 中的 TDD skill 路径共同承载：

- `boundaries.writePaths` 非空 → 生产代码变更，必须 TDD，`requirements` 首条写 TDD skill 绝对路径
- `boundaries.writePaths` 为空数组 → 显式只读派发，豁免 RED/GREEN，`requirements` 改为要求给出命令输出/文件路径/行号级观测证据

不要为了「声明这是文档任务」而填写任何模式字段；只读语义完全由 `writePaths` 是否为空表达。

**约束力说明（残余风险）：** 删除 `workflow` 后 TDD 纪律不再有结构化信号可供门禁消费，完全依赖 profile system prompt 与自然语言 `requirements`。这是用户裁决接受的取舍；是否应在 child 产出侧（Required Report 的 RED/GREEN 证据、或事后核查 child 是否真的 read 了 skill 文件）补机械强制，由 T13 探索后另行裁决。
```

4. 更新示例对象：删除 `workflow` 键。**不动路径文法那句**（属 T3）。

- [ ] **步骤 12：条件化同步已安装副本（HI-1）**

```bash
INSTALLED="/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md"
REPO="skill-overrides/subagent-dispatch/SKILL.md"
if [ -f "$INSTALLED" ]; then
  cp "$REPO" "$INSTALLED"
  diff "$REPO" "$INSTALLED" && echo "SYNCED: 两份逐字一致"
else
  echo "skip: 已安装副本不存在于本环境（$INSTALLED）"
fi
```

同步方向固定为「仓库副本 → 已安装副本」。已安装副本不在 git 管理内，覆盖不产生仓库变更。**该文件不在本任务 WritePaths 内**，本步骤是总纲 §7 允许的条件化环境步骤。

- [ ] **步骤 13：同步既有测试**

- `test/subagent-dispatch-readonly-writepaths.test.mjs`（T1 创建）：其 `contract()` 调用处传入了 `workflow: { mode: "docs-only", reason: ... }`，**必须全部删除该键**（共 5 处：测试 1、2 的两个调用、测试 3、测试 5 的 helper 调用；测试 4 传的是 `{ mode: "tdd" }`，改为传一个真正的 unknown field 如 `outputMode: "inline"` 以保持该测试的意图）。这是 T1→T2 的显式衔接点。
- `test/subagent-dispatch-ir.test.mjs`：删除全部针对 `workflow` 的用例（含锁定 mode↔reason 条件的断言），新增一条断言 `workflow` 被当作未知字段拒绝
- `test/subagent-dispatch-validation-errors.test.mjs`：`contract()` helper 若含 `workflow` 键则删除；涉及 `workflow.reason` 的错误文案断言一并删除。**T1 步骤 7 保留下来的「空 writePaths」测试必须继续存在并通过**
- `test/subagent-dispatch-schema-coercion.test.mjs` / `schema-security.test.mjs`：删除 `workflow` 相关的 coercion/security 用例；若存在「`workflow` 字符串化 JSON 可被 coerce」的用例，改为断言 `workflow` 现在是未知字段
- `test/subagent-dispatch-skill.test.mjs`：更新对 SKILL.md 文本的断言以匹配步骤 11 的新文本；凡读取已安装副本的断言一律改为 `existsSync` 条件式（HI-1）

- [ ] **步骤 14：运行确认 GREEN**

运行：

```bash
node --test test/subagent-dispatch-workflow-removed.test.mjs \
  test/subagent-dispatch-contract-hash-compat.test.mjs \
  test/subagent-dispatch-readonly-writepaths.test.mjs \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-validation-errors.test.mjs \
  test/subagent-dispatch-schema-coercion.test.mjs \
  test/subagent-dispatch-schema-security.test.mjs \
  test/subagent-dispatch-skill.test.mjs \
  test/package-orphan-export-guard.test.mjs
```

预期：PASS。

- [ ] **步骤 15：最终残留扫描（MD-2）**

运行：

```bash
echo "--- dispatch-ir.ts 内 workflow 残留（应零命中）---"
grep -rn "workflow" packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts
echo "--- schema 内 workflow 残留（应零命中）---"
grep -n '"workflow"\|workflow:' packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
echo "--- 文档内 workflow.mode/reason 残留（应零命中）---"
grep -rn "workflow\.mode\|workflow\.reason" skill-overrides/ pi/AGENTS.md pi/AGENTS_APPEND.md \
  packages/pi-subagents-enhanced/README.md packages/pi-subagents-enhanced/AGENTS.md AGENTS.md 2>/dev/null
echo "--- 允许保留的 workflow（spawn 编排概念，非 IR 字段）---"
grep -n "codingWorkflowSpawnParams\|genericWorkflowSpawnParams\|workflowKey" \
  packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
```

预期：前三项零命中；第四项仍有命中（这些是必须保留的 spawn 编排概念）。若前三项有命中，逐个清除；若命中的是**其他文档**（如 `docs/` 下的历史计划或 bug 文档），属历史记录，**不改**，但在任务报告中列出。

- [ ] **步骤 16：运行本任务回归**

运行：

```bash
node --test test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs \
  test/subagent-execution-contract.test.mjs test/subagent-dispatch-extension.test.ts \
  test/subagent-dispatch-shared-execution.integration.mjs
npm run typecheck
npm run verify:subagents-enhanced
git diff --stat -- pi/agents/
```

预期：全部 PASS；`git diff --stat -- pi/agents/` 只显示 `delegate.md` 与 `executor.md`，**不得出现 `reviewer.md`**。

---

### Task 3：`writePaths` 文法分类错误 + 修正 SKILL 的错误文法

**Deps：** `T1`（理由：T1 已删除孤儿 `ir.ts`，`normalizeRepoRelativePath` 只剩 canonical 一份实现）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `test/subagent-dispatch-writepaths-grammar.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`

**Resources：** `dispatch-ir`、`skill-md`（各最多 1 个并发）

**Files：**
- Modify：`src/contracts/dispatch-ir.ts` 的 `normalizeRepoRelativePath`（按符号定位）
- Modify：`skill-overrides/subagent-dispatch/SKILL.md` 中「目录范围 `writePaths` 必须以 `/**` 或 `/` 结尾（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。」这一整句（**按完整句子锚点定位，不用行号**——T2 已改过同文件其他位置）
- Create：`test/subagent-dispatch-writepaths-grammar.test.mjs`

**接口契约：**
- Consumes：T1 的 canonical 单一实现；T2 完成后的 SKILL 文本
- Produces：`normalizeRepoRelativePath` 对五类非法输入分别抛出可区分的 `INVALID_PATH` message，每条含**实际收到的值**（`JSON.stringify`）与**合法写法示例**；新增导出常量 `PATH_EXAMPLE`。**合法文法保持不变**（不放宽、不收紧），仅改错误文案与分支顺序。

**验收标准：**
1. 合法文法完全不变：`README.md`、`src/index.ts`、`.github/workflows/ci.yml`、`src/**`、`packages/a/src/**`、` src/index.ts `（前后空白）、`src`（按精确路径）、`[]`（T1 引入的只读声明）全部通过
2. 五类非法输入各自命中专属文案（见步骤 2 的 CASES 表）
3. **`"/**"` 命中 `must not be "/**"` 专属文案**（HI-4：v2 的实现会让它先落入绝对路径分支，导致该文案永不可达而测试断言失败；本任务通过前置分支修正）
4. 每条错误 message 含 `JSON.stringify` 后的实际输入值与合法示例
5. SKILL 副本不再声称目录范围可以尾随 `/`；改为完整句子锚点替换，并在测试中以**全文关键句断言**验证（MD-5：资源锁只防并发写入，不防语义覆盖，故不用行号而用完整句子）
6. `npm run typecheck` PASS

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期同 T-ENV 步骤 0。

- [ ] **步骤 1：编写失败测试**

创建 `test/subagent-dispatch-writepaths-grammar.test.mjs`：

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { compileCodingDispatchIR } = await jiti.import(
  "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts",
);
const repoRoot = dirname(new URL(import.meta.url).pathname);
const overrideSkill = join(repoRoot, "..", "skill-overrides", "subagent-dispatch", "SKILL.md");
const installedSkill = "/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md";

// 不含 workflow：本任务在 T2 之后执行
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
  assert.deepEqual(withWritePaths(["src"]).boundaries.writePaths, ["src"]);   // 裸名按精确路径，不展开
  assert.deepEqual(withWritePaths([]).boundaries.writePaths, []);            // T1 的只读声明
});

// 五类非法输入 → 五条专属文案。HI-4："/**" 必须有专属分支，否则会先落入绝对路径分支。
const CASES = [
  { input: "/**", re: /must not be "\/\*\*"/, note: "递归范围缺目录前缀，专属文案" },
  { input: "/Users/me/repo/src/a.ts", re: /must be repo-relative/, note: "绝对路径" },
  { input: "C:/repo/a.ts", re: /must be repo-relative/, note: "Windows 盘符" },
  { input: "\\\\server\\share\\a.ts", re: /must be repo-relative/, note: "UNC" },
  { input: "src\\a.ts", re: /POSIX '\/' separators/, note: "反斜杠" },
  { input: "src\u0000a.ts", re: /must not contain NUL/, note: "NUL 单独成类" },
  { input: "src/", re: /must not end with '\/'/, note: "尾随斜杠（SKILL 曾错误声称合法）" },
  { input: "docs/plans/", re: /must not end with '\/'/, note: "尾随斜杠" },
  { input: "src/*", re: /unsupported glob character "\*"/, note: "单星" },
  { input: "src/**/*.ts", re: /unsupported glob character/, note: "/** 之后仍有内容" },
  { input: "src/**/a.ts", re: /unsupported glob character/, note: "中间 glob" },
  { input: "a/**/**", re: /unsupported glob character/, note: "双重递归后缀" },
  { input: "src/**x", re: /unsupported glob character/, note: "递归后缀粘连" },
  { input: "src/file?.ts", re: /unsupported glob character "\?"/, note: "问号" },
  { input: "src/[ab].ts", re: /unsupported glob character "\["/, note: "字符类" },
  { input: "./src/a.ts", re: /unsafe path segment "\."/, note: "点段" },
  { input: "src/../a.ts", re: /unsafe path segment "\.\."/, note: "点点段" },
  { input: "src//a.ts", re: /unsafe path segment ""/, note: "空段" },
  { input: "src//**", re: /must not end with '\/'|unsafe path segment/, note: "空段或尾随斜杠二者其一" },
];

test("非法输入命中专属分类文案，且回显实际值与合法示例", () => {
  for (const { input, re, note } of CASES) {
    assert.throws(
      () => withWritePaths([input]),
      (error) => {
        assert.equal(error.code, "INVALID_PATH", `${note}: code`);
        assert.match(error.message, re, `${note}: 分类文案，实际=${error.message}`);
        assert.ok(error.message.includes(JSON.stringify(input).slice(1, -1)) || error.message.includes("NUL"),
          `${note}: message 应回显实际值，实际=${error.message}`);
        assert.match(error.message, /src\/\*\*|src\/a\.ts/, `${note}: 应给出合法写法示例`);
        assert.match(error.message, /boundaries\.writePaths\[0\]/, `${note}: keypath 应指向具体下标`);
        return true;
      },
      `input=${JSON.stringify(input)} (${note})`,
    );
  }
});

test("keypath 指向出错的具体下标", () => {
  assert.throws(
    () => withWritePaths(["src/ok.ts", "/abs/bad.ts"]),
    (error) => error.message.includes("boundaries.writePaths[1]"),
  );
});

test("context.relevantFiles 复用同一文法，keypath 正确且示例仍适用", () => {
  assert.throws(
    () => compileCodingDispatchIR({
      version: "dispatch-ir.v1", taskId: "rf-probe", title: "relevantFiles 文法", agent: "executor",
      risk: "low", objective: "验证 relevantFiles 复用同一路径文法。", requirements: ["只读验证。"],
      context: { knownFacts: [], decisions: [], relevantFiles: ["/abs/path.ts"] },
      boundaries: { writePaths: [], excludedWork: [], forbiddenActions: [] },
      acceptance: { criteria: ["文法一致。"] }, execution: { timeoutMs: 1000 },
    }, { cwd: "/repo" }),
    (error) => {
      assert.equal(error.code, "INVALID_PATH");
      assert.match(error.message, /context\.relevantFiles\[0\]/);
      assert.match(error.message, /must be repo-relative/);
      return true;
    },
  );
});

test("SKILL 副本不再声称目录范围可以尾随斜杠（完整句子锚点，MD-5）", () => {
  const override = readFileSync(overrideSkill, "utf8");
  // 旧的错误句子必须整体消失
  assert.equal(override.includes("目录范围 `writePaths` 必须以 `/**` 或 `/` 结尾（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。"), false,
    "错误的文法句子必须已整体移除");
  // 新的正确句子必须整体存在
  const expected = "`writePaths` 的文法只有一种：仓库相对 POSIX 路径，写作精确路径（`src/a.ts`）或末尾带 `/**` 的递归目录范围（`src/**`）。唯一支持的目录范围写法是末尾 `/**`；尾随 `/` 会被拒绝（`src/` 非法，必须写 `src/**`），末尾 `/**` 之外的任何 `* ? [ ]` 均非法，`.`/`..`/空段非法，绝对路径、Windows 盘符、UNC、反斜杠与 NUL 均非法。裸路径（如 `src`）按精确条目匹配，不展开为目录范围。`writePaths` 可以是空数组，表示显式只读派发。";
  assert.ok(override.includes(expected), "新的完整文法句子必须存在（逐字比对，不用行号）");
});

test("已安装 SKILL 副本存在时与仓库副本逐字一致，不存在时 skip（HI-1）", (t) => {
  if (!existsSync(installedSkill)) { t.skip("已安装副本不存在于本环境"); return; }
  assert.equal(readFileSync(installedSkill, "utf8"), readFileSync(overrideSkill, "utf8"));
});
```

- [ ] **步骤 2：运行确认 RED**

运行：`node --test test/subagent-dispatch-writepaths-grammar.test.mjs`

预期 FAIL，且为断言级失败：`"/**"` 用例当前得到 `must be a repo-relative POSIX path` 而非专属文案；NUL 用例当前与反斜杠共用一条文案；尾随斜杠用例得到泛化的 `contains an unsupported path pattern`；SKILL 断言因旧句仍在而失败。

- [ ] **步骤 3：最小实现——分支顺序修正 + 分类文案（HI-4）**

把 `src/contracts/dispatch-ir.ts` 的 `normalizeRepoRelativePath` 整体替换为：

```js
// 合法文法（唯一规格，不放宽不收紧）：
//   PATH      := EXACT | RECURSIVE
//   RECURSIVE := EXACT "/**"
//   EXACT     := SEGMENT ("/" SEGMENT)*
//   SEGMENT   := 非空，且不等于 "." 或 ".."
// 禁止：前导 "/"、Windows 盘符与 UNC、任何反斜杠与 NUL、尾随 "/"、
//       末尾 "/**" 之外的任何 * ? [ ]、空段与 "."/".." 段。
//
// 分支顺序有讲究（HI-4）："/**" 必须在「前导 /」判定之前单独处理，
// 否则它会落入绝对路径分支，使「递归范围缺目录前缀」这条更有用的文案永不可达。
export const PATH_EXAMPLE = 'e.g. "src/a.ts" or "src/**"';

function normalizeRepoRelativePath(value, location) {
  const normalized = normalizeString(value, location);
  const echoed = JSON.stringify(normalized);

  // 1. 递归范围缺目录前缀：最有用的一条，必须最先判
  if (normalized === "/**") {
    fail("INVALID_PATH", `${location} must not be "/**": a recursive scope needs a directory prefix; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  // 2. NUL 单独成类（不与反斜杠合并，便于定位注入类问题）
  if (normalized.includes("\0")) {
    fail("INVALID_PATH", `${location} must not contain NUL; got a value with an embedded \\0. ${PATH_EXAMPLE}`, location);
  }
  // 3. 反斜杠（含 Windows 盘符与 UNC 的斜杠形态）
  if (normalized.includes("\\")) {
    fail("INVALID_PATH", `${location} must use POSIX '/' separators and must not contain backslashes; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  // 4. 绝对路径与 Windows 盘符
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(normalized);
  if (normalized.startsWith("/") || windowsAbsolute || normalized.startsWith("\\\\")) {
    fail("INVALID_PATH", `${location} must be repo-relative: no leading '/' and no Windows drive/UNC prefix; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }

  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;

  // 5. 尾随 "/"：SKILL 曾错误声称这是合法的目录范围写法
  if (base.endsWith("/")) {
    fail("INVALID_PATH", `${location} must not end with '/'; the only supported directory scope is a single trailing '/**'; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  // 6. 末尾 "/**" 之外的任何 glob 字符
  const glob = base.match(/[*?[\]]/);
  if (glob) {
    fail("INVALID_PATH", `${location} contains unsupported glob character ${JSON.stringify(glob[0])}; globs are only allowed as one trailing '/**'; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  // 7. 不安全段
  const segments = base.split("/");
  const unsafe = segments.find((segment) => !segment || segment === "." || segment === "..");
  if (unsafe !== undefined) {
    fail("INVALID_PATH", `${location} contains an unsafe path segment ${JSON.stringify(unsafe)}; empty, '.' and '..' segments are forbidden; got ${echoed}. ${PATH_EXAMPLE}`, location);
  }
  return recursive ? `${segments.join("/")}/**` : segments.join("/");
}
```

注意 `!base`（空 base）的情形已被分支 1（`"/**"`）与分支 5（`base.endsWith("/")` 对空串为 false，但 `"".split("/")` 得到 `[""]` → 分支 7 的空段判定）共同覆盖，无需单独分支。步骤 1 的 CASES 表已包含 `/**`、`src//**` 等边界用于验证这一点。

- [ ] **步骤 4：修正 SKILL 副本（完整句子锚点替换）**

在 `skill-overrides/subagent-dispatch/SKILL.md` 中，把这一整句

```
目录范围 `writePaths` 必须以 `/**` 或 `/` 结尾（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。
```

替换为（**必须与步骤 1 测试中的 `expected` 常量逐字一致**）

```
`writePaths` 的文法只有一种：仓库相对 POSIX 路径，写作精确路径（`src/a.ts`）或末尾带 `/**` 的递归目录范围（`src/**`）。唯一支持的目录范围写法是末尾 `/**`；尾随 `/` 会被拒绝（`src/` 非法，必须写 `src/**`），末尾 `/**` 之外的任何 `* ? [ ]` 均非法，`.`/`..`/空段非法，绝对路径、Windows 盘符、UNC、反斜杠与 NUL 均非法。裸路径（如 `src`）按精确条目匹配，不展开为目录范围。`writePaths` 可以是空数组，表示显式只读派发。
```

该句位于讲 worktree 的那一段末尾；T2 改的是同文件的 `workflow` 相关句与示例对象，**位置不同**。用完整句子做锚点替换，不要用行号，也不要用短片段（MD-5）。替换后立即用 `diff` 确认 T2 的改动仍在：

```bash
grep -c "workflow" skill-overrides/subagent-dispatch/SKILL.md    # 期望 0（T2 已清除）
grep -c "TDD 与只读豁免" skill-overrides/subagent-dispatch/SKILL.md   # 期望 1（T2 新增的段落仍在）
```

- [ ] **步骤 5：条件化同步已安装副本（HI-1）**

```bash
INSTALLED="/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md"
REPO="skill-overrides/subagent-dispatch/SKILL.md"
if [ -f "$INSTALLED" ]; then cp "$REPO" "$INSTALLED"; diff "$REPO" "$INSTALLED" && echo "SYNCED"; else echo "skip: 已安装副本不存在于本环境"; fi
```

- [ ] **步骤 6：运行确认 GREEN**

运行：`node --test test/subagent-dispatch-writepaths-grammar.test.mjs`

预期：PASS，6 个测试全绿。

- [ ] **步骤 7：同步既有 path 用例**

`test/subagent-dispatch-ir.test.mjs` 中覆盖 escape/glob 拒绝的既有用例，其断言可能匹配旧的泛化文案。逐个更新为新分类文案的断言；**不得删除用例，也不得放宽为只断言 `code === "INVALID_PATH"`**，必须保留对分类文案的断言。`test/subagent-dispatch-skill.test.mjs` 若断言 SKILL 文本，同步更新为条件式（已安装副本用 `existsSync` 判定）。

- [ ] **步骤 8：运行本任务回归**

运行：

```bash
node --test test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-readonly-writepaths.test.mjs \
  test/subagent-dispatch-workflow-removed.test.mjs test/subagent-dispatch-contract-hash-compat.test.mjs \
  test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs \
  test/subagent-dispatch-skill.test.mjs test/package-orphan-export-guard.test.mjs
npm run typecheck
```

预期：全部 PASS。

---

### Task 4：`MODEL_NOT_AVAILABLE` 返回候选清单与建议

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`
- `test/subagent-model-candidates.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`src/subagent-dispatch/model-selection.ts` 的 `ModelSelectionError` 类与 `resolveModelSelection` 内全部 `throw` 语句（按符号定位）
- Create：`test/subagent-model-candidates.test.mjs`

**接口契约：**
- Consumes：`resolveModelSelection()` 现有签名与其真实返回形状 **`{ model?, source, warnings? }`**（`source` 取值 `default` / `qualified` / `agent-candidates` / `global-catalog`；**没有 `resolvedModel` 顶层字段**，它只是 global-catalog 分支的局部变量并写进 `warnings[]` 元素）
- Produces：
  - `ModelSelectionError` 新增只读属性 `details: ModelSelectionErrorDetails`，形状固定为
    ```ts
    { code: "MODEL_NOT_AVAILABLE"; requestedModel: string; requestedKind: "qualified" | "bare";
      agent: string; declaredCandidates: readonly string[]; availableCandidates: readonly string[];
      suggestion?: string }
    ```
  - message 追加：声明候选清单（存在时）、available 清单（存在时）、`Did you mean "<x>"?`（`suggestion` 存在时）、以及一句裸名匹配规则说明
  - **匹配算法语义完全不变**：qualified 精确匹配 full-ID；bare 在 profile 声明 `models` 时按声明顺序匹配 id 段且 miss 后不查全局；bare 未声明时查全局并产生 `MODEL_MATCH_USED_GLOBAL_CATALOG` 警告。**不引入 alias、substring、模糊或大小写不敏感匹配。**

**验收标准：**
1. 请求 bare `astra`、profile 声明含 `codex-pool/gpt-6-astra` 且该 full-ID 当前 available 时：抛错，`details.requestedKind === "bare"`、`details.suggestion === "gpt-6-astra"`、message 含 `Did you mean "gpt-6-astra"?`
2. `blockedProviders` 中的 provider 不出现在任何候选清单中；屏蔽导致 `suggestion` 无可用命中时**省略该字段**而非给出不可用建议
3. qualified 请求失败时 `requestedKind === "qualified"`、**无 `suggestion`**、message 含 `Available models:`
4. `suggestion` 只在恰好一个声明候选满足「id 段大小写不敏感地以 requested 结尾，且紧邻前一字符是 `-` 或 `.`」时给出
5. 成功路径四种 `source` 与全局目录警告行为逐位不变
6. `npm run typecheck` PASS

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期同 T-ENV 步骤 0。

- [ ] **步骤 1：盘点全部抛出点与真实返回形状**

运行：

```bash
grep -n "ModelSelectionError\|return {" packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts
sed -n '54,101p' packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts
```

记录全部 `throw new ModelSelectionError(...)` 的行号与所在分支（qualified miss / bare-with-profile miss / bare-global miss），并确认返回形状是 `{ model, source }` 而非 `{ resolvedModel }`（BL-5 的教训）。

- [ ] **步骤 2：编写失败测试**

创建 `test/subagent-model-candidates.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { resolveModelSelection, ModelSelectionError } = await jiti.import(
  "../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts",
);

const available = [
  { provider: "codex-pool", id: "gpt-6-astra" },
  { provider: "codex-pool", id: "gpt-5.6-sol" },
  { provider: "qoder-pool", id: "GLM-5.3-0.6x" },
  { provider: "zai-coding-cn", id: "glm-5.3" },
];
const reviewerModels = ["codex-pool/gpt-6-astra", "openai-codex/gpt-6-astra", "codex-pool/gpt-5.6-sol",
                        "qoder-pool/GLM-5.3-0.6x", "zai-coding-cn/glm-5.3"];

test("bare 昵称失败时给出声明候选与唯一建议", () => {
  assert.throws(
    () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available }),
    (error) => {
      assert.ok(error instanceof ModelSelectionError);
      assert.equal(error.code, "MODEL_NOT_AVAILABLE");
      assert.equal(error.details.requestedKind, "bare");
      assert.equal(error.details.agent, "reviewer");
      assert.equal(error.details.requestedModel, "astra");
      assert.deepEqual([...error.details.declaredCandidates], reviewerModels);
      assert.deepEqual([...error.details.availableCandidates],
        ["codex-pool/gpt-5.6-sol", "codex-pool/gpt-6-astra", "qoder-pool/GLM-5.3-0.6x", "zai-coding-cn/glm-5.3"]);
      assert.equal(error.details.suggestion, "gpt-6-astra");
      assert.match(error.message, /Did you mean "gpt-6-astra"\?/);
      assert.match(error.message, /Available declared IDs:/);
      assert.match(error.message, /exactly match the full id segment after/);
      return true;
    },
  );
});

test("blocked provider 不出现在任何候选清单中，且不给不可用建议", () => {
  assert.throws(
    () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: reviewerModels, availableModels: available, blockedProviders: ["codex-pool"] }),
    (error) => {
      assert.equal([...error.details.declaredCandidates].some((c) => c.startsWith("codex-pool/")), false);
      assert.equal([...error.details.availableCandidates].some((c) => c.startsWith("codex-pool/")), false);
      assert.equal("suggestion" in error.details, false, "gpt-6-astra 被屏蔽后不得建议它");
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
  const ambiguous = [{ provider: "p1", id: "x-astra" }, { provider: "p2", id: "y-astra" }];
  assert.throws(
    () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: ["p1/x-astra", "p2/y-astra"], availableModels: ambiguous }),
    (error) => {
      assert.equal("suggestion" in error.details, false);
      assert.deepEqual([...error.details.declaredCandidates], ["p1/x-astra", "p2/y-astra"]);
      return true;
    },
  );
});

test("后缀边界：只有 '-' 或 '.' 分隔才算命中，避免意外后缀", () => {
  const models = [{ provider: "p", id: "megastra" }];
  assert.throws(
    () => resolveModelSelection({ requestedModel: "astra", agentName: "reviewer", agentModels: ["p/megastra"], availableModels: models }),
    (error) => {
      assert.equal("suggestion" in error.details, false, "megastra 以 astra 结尾但前一字符是 'g'，不得建议");
      return true;
    },
  );
});

test("成功路径与全局目录警告行为不变（真实返回字段是 model/source）", () => {
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

预期 FAIL：前 5 个测试因 `error.details` 为 `undefined` 而断言失败；**第 6 个测试（成功路径）在本步骤就应 PASS**——它断言的是既有 API，不依赖本任务新增字段。若第 6 个也 FAIL，说明 fixture 与真实返回结构不符，先读 `resolveModelSelection` 校正 fixture，**不得修改断言去迎合实现**。

- [ ] **步骤 4：最小实现——扩展错误类型**

把 `ModelSelectionError` 替换为：

```ts
export type ModelSelectionErrorDetails = {
  code: "MODEL_NOT_AVAILABLE";
  requestedModel: string;
  requestedKind: "qualified" | "bare";
  agent: string;
  declaredCandidates: readonly string[];
  availableCandidates: readonly string[];
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
      declaredCandidates: Object.freeze(declared),
      availableCandidates: Object.freeze(availableIds),
      ...(candidates.suggestion ? { suggestion: candidates.suggestion } : {}),
    }) as ModelSelectionErrorDetails;
  }
}
```

- [ ] **步骤 5：最小实现——建议推导（B6：签名用 `ReadonlySet<string>`）**

```ts
// 只在恰好一个候选命中时给建议：id 段大小写不敏感地以 requested 结尾，
// 且紧邻的前一个字符是 '-' 或 '.'（避免 "astra" 命中 "megastra" 这类意外后缀）。
// 绝不引入 substring / 模糊 / 编辑距离匹配。
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

按步骤 1 记录的抛出点逐个改造。**匹配算法的控制流不得改动，只替换 `throw` 语句的实参。** 每个抛出点都必须构造该分支实际可见的候选集合，不得传空数组充数。

bare + profile 声明分支示例：

```ts
const declared = (agentModels ?? []).filter((full) => !blocked.has(candidateProvider(full)?.toLowerCase() ?? ""));
const availableIds = allowedModels.map(fullModelId);
throw new ModelSelectionError(requestedModel, agentName, {
  declaredCandidates: declared,
  availableCandidates: availableIds,
  suggestion: suggestBareModelId(requestedModel, declared, new Set(availableIds)),
});
```

qualified 分支与 bare-global 分支按同样形状传入其实际可见集合，且 qualified 分支**不传 `suggestion`**。

- [ ] **步骤 7：运行确认 GREEN**

运行：`node --test test/subagent-model-candidates.test.mjs`

预期：PASS，6 个测试全绿。

- [ ] **步骤 8：运行本任务回归**

运行：`node --test test/subagent-model-selection.test.mjs test/subagent-model-selection.integration.mjs test/package-orphan-export-guard.test.mjs && npm run typecheck`

预期：全部 PASS。`test/subagent-model-selection.test.mjs` 锁定了精确匹配语义（bare 不查全局、qualified 精确匹配）；若它 RED，说明步骤 6 改动了控制流，必须回退到只改 `throw` 实参。

---

### Task 5：本地 preflight 拒绝使用独立错误码，不再冒充 RPC 失败

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts`
- `test/subagent-execution-contract.test.mjs`

**Resources：** `extension-ts`（最多 1 个并发；本任务默认**只读** `extension.ts` 以确认 catch 行为，仅在步骤 5 判定必须修改时才实际写入并持有该锁）、`execution-contract-test`（最多 1 个并发）

**Files：**
- Modify：`src/subagent-dispatch/execution-contract.ts` 的 `fail()` 与 state-root 拒绝分支（按符号定位）
- Modify：`test/subagent-execution-contract.test.mjs`（**在该既有文件内新增用例，复用其已有的 grant/authorization 构造器**）

**接口契约：**
- Consumes：`createAuthorizedDispatch(input, hostGrant)` 现有签名；`HostExecutionGrant` 的**真实六字段契约**（`GRANT_KEYS = ["rootSessionId","allowedProfiles","originRoot","cwdRoot","isolation","authorization"]`，`normalizeGrant` 要求键数恰好为 6、`originRoot`/`cwdRoot` 为真实存在的 canonical 路径、`contains(originRoot, cwdRoot)`、`authorization.binding.sessionId === rootSessionId`）
- Produces：
  - `execution-contract.ts` 的 `fail(message, code?, keypath?)` 抛出的 Error 带 `code`、`keypath`、`detail` 属性
  - state-root cwd 拒绝抛出 `code === "INVALID_EXECUTION_CWD"`、`detail === { code, keypath: "cwd" }`
  - 该错误对象**不含** `operation` 属性（否则 `extension.ts` 的 `isRpcFailure = code === "SUBAGENT_RPC_FAILED" || typeof error?.operation === "string"` 会重新判为 RPC 失败）

**验收标准：**
1. 传入落在 managed state root 内的 `cwd` 时，`createAuthorizedDispatch` reject，`error.code === "INVALID_EXECUTION_CWD"`，message 含实际 cwd 与 state root 且给出下一步指引
2. 该错误对象不含 `operation` 属性；`error.detail.keypath === "cwd"`
3. 既有 `fail()` 调用点的 message 文本**逐字不变**（只增加可选参数）
4. 新增用例**复用既有测试文件的 grant 构造器**，不自造 fixture（BL-3）
5. `npm run typecheck` PASS

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期同 T-ENV 步骤 0。

- [ ] **步骤 1：读取 `fail()`、全部调用点与既有测试的 grant 构造器**

运行：

```bash
grep -n "^function fail\|fail(" packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts
grep -n "state-root\|managed state root\|managedStateRoot" packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts
grep -n "grant\|authorization\|createAuthorizedDispatch\|mkdtemp" test/subagent-execution-contract.test.mjs | head -40
sed -n '1,60p' test/subagent-execution-contract.test.mjs
```

**BL-3 的教训：** 不要自己造 `grant` fixture。`test/subagent-execution-contract.test.mjs` 已经在测 `createAuthorizedDispatch`，必然有可通过 `normalizeGrant` 全部校验的构造方式（含真实临时目录、`rootSessionId` 与 `authorization.binding.sessionId` 相等）。记录该构造器的名称与用法，步骤 2 直接复用。若该文件没有可复用的构造器，停止并报告——不要凭空编造六字段 grant。

- [ ] **步骤 2：在既有测试文件中新增失败用例**

在 `test/subagent-execution-contract.test.mjs` 末尾追加（**`buildGrant` / `makeTempRoot` 等名称替换为步骤 1 实读到的真实构造器**）：

```js
test("cwd 落在 managed state root 内时报 INVALID_EXECUTION_CWD，而非 SUBAGENT_RPC_FAILED", async () => {
  // 复用本文件既有的 grant 构造方式，确保先通过 normalizeGrant 的全部校验
  // （键数恰好 6、originRoot/cwdRoot 真实存在、cwdRoot 在 originRoot 内、
  //   authorization.binding.sessionId === rootSessionId），
  // 否则测试会在 grant 校验处失败，根本到不了 state-root 分支（BL-3）。
  const { root, grant } = await makeGrantFixture();          // ← 替换为真实构造器
  const stateRoot = join(root, "workspaces");
  const inside = join(stateRoot, "repositories", "aa", "worktrees", "wt-1");
  await mkdir(inside, { recursive: true });

  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  process.env.PI_CODING_WORKSPACE_DIR = stateRoot;
  try {
    await assert.rejects(
      createAuthorizedDispatch({ agent: grant.allowedProfiles[0], cwd: inside }, grant),
      (error) => {
        assert.equal(error.code, "INVALID_EXECUTION_CWD", `实际 code=${error.code}`);
        assert.notEqual(error.code, "SUBAGENT_RPC_FAILED");
        assert.equal("operation" in error, false, "不得携带 operation，否则会被兜底逻辑判为 RPC 失败");
        assert.match(error.message, /managed state root/);
        assert.ok(error.message.includes(inside), "message 应回显实际 cwd");
        assert.match(error.message, /repository origin|execution\.worktree/, "message 应给出下一步");
        assert.equal(error.detail?.code, "INVALID_EXECUTION_CWD");
        assert.equal(error.detail?.keypath, "cwd");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
  }
});

test("既有 fail() 调用点的 message 文本未被改变", async () => {
  const { root, grant } = await makeGrantFixture();
  const previous = process.env.PI_CODING_WORKSPACE_DIR;
  process.env.PI_CODING_WORKSPACE_DIR = join(root, "workspaces");
  try {
    await assert.rejects(
      createAuthorizedDispatch({ agent: "definitely-not-an-allowed-profile", cwd: grant.cwdRoot }, grant),
      (error) => {
        assert.equal(error.message, "Dispatch execution contract is invalid: dispatch request agent is not an allowed profile");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_WORKSPACE_DIR;
    else process.env.PI_CODING_WORKSPACE_DIR = previous;
  }
});
```

注意第二条测试断言的是 `fail()` 的**完整 message**，含 `Dispatch execution contract is invalid: ` 前缀（`fail` 的实现是 `throw new Error(\`Dispatch execution contract is invalid: ${message}\`)`）。步骤 1 实读后若前缀不同，以实读为准修正断言。

- [ ] **步骤 3：运行确认 RED**

运行：`node --test test/subagent-execution-contract.test.mjs`

预期：既有全部用例 PASS；新增第一条因 `error.code` 为 `undefined` 而断言失败（`实际 code=undefined`）；新增第二条应 PASS。若第一条的失败原因是 grant 校验错误而非 state-root 分支，说明 fixture 仍不可用，回到步骤 1。

- [ ] **步骤 4：最小实现**

在 `execution-contract.ts` 中把 `fail` 改为（保持既有单参调用的 message 逐字不变）：

```ts
function fail(message: string, code?: string, keypath?: string): never {
  const error = new Error(`Dispatch execution contract is invalid: ${message}`) as
    Error & { code?: string; keypath?: string; detail?: unknown };
  if (code !== undefined) {
    error.code = code;
    error.detail = Object.freeze({ code, ...(keypath ? { keypath } : {}) });
  }
  if (keypath !== undefined) error.keypath = keypath;
  throw error;
}
```

把 state-root 拒绝分支改为：

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

**不要**给该 error 设置 `operation` 属性。

- [ ] **步骤 5：确认 extension 兜底逻辑无需修改**

只读 `src/subagent-dispatch/extension.ts` 的兜底 catch（按符号定位 `SUBAGENT_RPC_FAILED`），确认：
- `const code = error?.code ?? (...)` → 取到 `"INVALID_EXECUTION_CWD"`
- `const isRpcFailure = code === "SUBAGENT_RPC_FAILED" || typeof error?.operation === "string"` → 两者皆 false
- `details = isRpcFailure ? createSubagentRpcFailureDetails({...}) : error?.detail` → 走 `error.detail`，即 `{ code, keypath }`
- 确认返回给模型的 details **不为 `undefined`**（否则模型看到的信息反而比现在更少）

若四条全部成立，本任务**不修改 `extension.ts`**，可释放 `extension-ts` 资源锁。若任一条不成立，在该 catch 中做最小修正，并确认 diff hunk 与 lifecycle 批次既有 hunk（`16, 129-131, 1017-1025, 1033-1054, 1058-1086, 1237, 1274, 1369, 1403-1404, 1413, 1417-1419, 1501`）以内容指纹方式比对不重叠。

- [ ] **步骤 6：运行确认 GREEN**

运行：`node --test test/subagent-execution-contract.test.mjs`

预期：PASS，含两条新增用例。

- [ ] **步骤 7：运行本任务回归**

运行：

```bash
node --test test/subagent-execution-contract.test.mjs test/subagent-dispatch-shared-execution.integration.mjs \
  test/subagent-dispatch-rpc.test.mjs test/subagent-dispatch-workflow-removed.test.mjs \
  test/subagent-dispatch-readonly-writepaths.test.mjs test/package-orphan-export-guard.test.mjs
npm run typecheck
```

预期：全部 PASS。若既有用例因 message 文本变化而 RED，说明步骤 4 误改了既有调用点，回退到只改 state-root 一处。

---

### Task 13：探索——coding/generic 分支可发现性方案（只产出决策，不实现）

**Deps：** `T2`（理由：必须在 `workflow` 已删除后的 12 字段面上探索）

**WritePaths：**
- `docs/research/2026-09-23-dispatch-branch-discoverability.md`
- `scripts/probes/dispatch-branch-probe.ts`

**Resources：** `none`

**Files：**
- Create：`docs/research/2026-09-23-dispatch-branch-discoverability.md`
- Create：`scripts/probes/dispatch-branch-probe.ts`（**无副作用的离线探针**，HI-14）
- 只读：`src/subagent-dispatch/extension.ts`、`src/contracts/dispatch-ir.ts`、`src/contracts/generic-prompt.ts`

**接口契约：**
- Consumes：T2 完成后的 12 字段面；T1 的 canonical 单一实现
- Produces：
  - `scripts/probes/dispatch-branch-probe.ts`：接受一组固定输入样本，对每个样本输出**实际路由结果**（走 coding / generic / control 哪条分支、返回哪个错误码），不派发任何 subagent、不触碰文件系统与网络
  - 决策文档，含 ≥3 个候选方案对比、推荐方案及其精确接口契约

**验收标准：**
1. 探针可运行且无副作用：`node scripts/probes/dispatch-branch-probe.ts` 输出 8 类样本的实际路由结果，运行前后 `git status --short` 无变化
2. 文档明确复述 provider 兼容约束（`extension.ts` 中「某些严格 OpenAI-compatible provider 遇根级 union 会生成空 arguments」的注释）并判定其当前是否仍成立
3. 8 类输入样本每类都附**探针实测的实际路由结果**，不得填写静态推断值；无法取得实测结果的样本必须标注 `环境不可验证` 并说明原因，**不得推测**
4. ≥2 个候选方案（若约束已失效则含根级 union 方案共 ≥3 个），每个都给出完整接口契约而非方向描述
5. 比较维度含：provider 兼容风险、误判率（合法输入被拒 / 非法输入被接受）、错误码变化面、测试改造成本、对 312 次 `INVALID_CONTRACT` 与 327 次 `INVALID_PATH` 的预期削减
6. **额外必答（总纲 §1 裁决 ③）**：TDD 纪律是否应被机械强制、若应强制则在哪一层（派发合同 / child 产出侧的 RED-GREEN 证据 / 事后核查 child 是否 read 了 skill 文件），并给出推荐与理由
7. 结论是明确的待裁决项，不得以「建议进一步调研」收尾
8. **不含任何生产代码改动**（探针在 `scripts/probes/` 下，属诊断 CLI，按仓库约束可直接由 Node 执行的 `.ts`）

- [ ] **步骤 0：受保护路径门禁**

运行：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/`

预期同 T-ENV 步骤 0。

- [ ] **步骤 1：确认 provider 兼容约束是否仍成立**

```bash
grep -n -B2 -A6 "union\|oneOf\|anyOf" packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts | head -40
ls docs/bugs/ | grep -iE "union|schema|glm|empty"
sed -n '1,60p' docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md 2>/dev/null
```

在文档中写明：约束的原始证据、涉及哪些 provider/model、当前 `enabledModels` 中是否仍含受影响模型（**只读模型名，不得读取或输出任何凭据字段**）。若约束已因 provider 升级失效，根级 union 方案重新可行，这会显著改变推荐结论。

- [ ] **步骤 2：编写离线探针（HI-14：实测路由结果，不靠静态阅读）**

创建 `scripts/probes/dispatch-branch-probe.ts`。要求：
- 只 import 纯函数（`compileCodingDispatchIR`、generic 合同的校验入口、以及 `extension.ts` 中可独立调用的路由判定逻辑）
- **不注册工具、不启动 host、不派发 subagent、不读写文件（除 stdout）、不发网络请求**
- 对固定的 8 类样本逐个输出：`样本名 | 输入摘要 | 实际分支 | 实际错误码或成功 | 备注`

必须覆盖的 8 类样本：

| # | 样本 | 期望探明的问题 |
|---|---|---|
| 1 | 完整合法 coding（12 字段齐全） | 基线：走 coding 分支并编译成功 |
| 2 | 缺 `version` 但含 `taskId` | `INVALID_CODING_ROUTER` 自诊断是否触发 |
| 3 | 缺 `version` 但含 `boundaries` | T2 步骤 7 的等量替换是否生效 |
| 4 | 缺 `version` 且只有 `agent/title/task` | 合法 generic，不得误报 |
| 5 | generic 混入 coding-exclusive 字段（如 `risk`） | 是否 fail closed（M3 的现状） |
| 6 | coding 混入 generic 字段（如 `outputMode`） | 错误文案是否含 T1 的 generic 提示 |
| 7 | 带 `action` 的 control 调用 | 是否优先走 control 分支 |
| 8 | `action` 与 `version` 同时存在 | 优先级与是否产生歧义 |

若某类的路由判定逻辑内联在 `execute()` 闭包中、无法在不启动 host 的前提下调用，则该样本标注 `环境不可验证：路由逻辑不可离线调用`，并在文档中把「路由判定逻辑不可离线测试」本身列为一条可发现性缺口。**不得填写推测结果。**

- [ ] **步骤 3：运行探针并记录实际结果**

运行：

```bash
node scripts/probes/dispatch-branch-probe.ts | tee /tmp/t13-probe-output.txt
git status --short
```

预期：输出 8 行（或含 `环境不可验证` 标注）；`git status --short` 与运行前一致（探针无副作用）。把输出原文粘入文档。

- [ ] **步骤 4：盘点 T2 之后的实际字段面**

```bash
sed -n '/^export const TYPED_SUBAGENT_PARAMETERS/,/^});/p' packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
grep -n "TOP_LEVEL_KEYS" -A 16 packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts | head -20
```

产出一张表：每个顶层字段 × {JSON Schema 是否声明 / Schema 是否声明必填 / coding 分支实际是否必填 / generic 分支是否合法 / control 分支是否合法 / 是否存在条件约束}。已知需纳入的 generic-only 字段：`task`、`cwd`、`output`、`outputMode`、`outputSchema`、`artifacts`、`progress`、`worktree`、`skill`、`reads`；control 字段：`action`、`id`、`runId`、`dir`、`index`、`message`、`taskId`（注意 `taskId` 在 coding 与 control 两处语义不同，须分别记录）。

- [ ] **步骤 5：写决策文档**

创建 `docs/research/2026-09-23-dispatch-branch-discoverability.md`，结构：

```markdown
# dispatch 分支可发现性方案探索

## 1. 问题陈述与量化
## 2. 硬约束：根级 union 的 provider 兼容性
### 2.1 原始证据
### 2.2 当前是否仍成立
## 3. T2 之后的字段面快照
## 4. 离线探针实测结果（8 类样本）
## 5. 候选方案
### 5.1 方案 A：branch-specific description 动态生成
### 5.2 方案 B：description 内嵌完整字段矩阵
### 5.3 方案 C：错误回执侧补偿（完整模板 + 必填清单）
### 5.4 方案 A'（仅当 §2.2 判定约束已失效）：根级 oneOf 判别式
## 6. 对比矩阵
## 7. 推荐方案与理由
## 8. 推荐方案的精确接口契约
### 8.1 schema 结构
### 8.2 description 文本生成方式
### 8.3 错误 details 形状
## 9. TDD 纪律是否应机械强制、在哪一层强制（总纲 §1 裁决 ③ 的必答项）
## 10. 预期效果与验证方式
## 11. 未解决的问题
```

§6 对比矩阵必须含：`模型可见性提升 | provider 兼容风险 | 改动面（文件级）| 误判率变化 | 对 312 次 INVALID_CONTRACT 的预期削减 | 对 327 次 INVALID_PATH 的预期削减 | 是否可与 T1/T3 的错误文案改造叠加`。

§9 必须评估三个层次并给出推荐：① 派发合同层（非空 `writePaths` ⇒ `requirements` 必含 TDD skill 路径）——总纲已说明其两条反对理由（加重拒绝率、字符串匹配可被无意义满足），若仍推荐它必须正面回应这两条；② child 产出侧（Required Report 的 `RED/GREEN or exemption evidence` 是否应被机械校验）；③ 事后核查（child 是否真的 read 了 TDD skill 文件）。

§10 必须给出可执行的验证方式（例如用探针的 8 类样本做改动前后的路由结果差分、或在受控会话中统计拒绝率），不得只写「预期改善」。

- [ ] **步骤 6：确认未产生生产代码改动**

运行：`git status --short packages/ src/ pi/ test/`

预期：无本任务产生的改动。新增文件只应是 `docs/research/2026-09-23-dispatch-branch-discoverability.md` 与 `scripts/probes/dispatch-branch-probe.ts`。

---

### Task A-ACC：计划 A 验收

**Deps：** `T0`、`T1`、`T2`、`T3`、`T4`、`T5`、`T13`（理由：验收终点需要全部产物；T13 只产出文档与探针，其代码回归影响为零，但交付完整性检查需要它存在）

**WritePaths：**
- `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md`（仅回写复选框与验收记录）

**Resources：** `plan-a-acceptance`（独占）

**验收标准：**
1. `npm run typecheck` PASS
2. 计划 A 的定向套件连续 2 次 PASS
3. `npm run verify:subagents-enhanced` PASS
4. T0 守卫 PASS 且 `ALLOWLIST` 只剩 lifecycle 批次的 3 条
5. 全部残留扫描零命中（见步骤 2）
6. live 现场未被触碰（见步骤 5）
7. 机械自检全部通过（见步骤 6）
8. `npm run test:subagents` 的结果如实记录；若因 `PI_REAL_BIN` 未设置而 fail，记为 `环境受限未验证（延后项 R3）`，**不得**通过设置该变量或跳过测试来制造 PASS

- [ ] **步骤 1：typecheck 与守卫**

```bash
npm run typecheck
node --test test/package-orphan-export-guard.test.mjs
python3 -c "
import re
t=open('test/package-orphan-export-guard.test.mjs').read()
m=re.search(r'const ALLOWLIST = new Map\(\[(.*?)\]\);', t, re.S)
print('ALLOWLIST 条目:', re.findall(r'\"(src/[^\"]+)\"', m.group(1)) if m else '解析失败')"
```

预期：typecheck PASS；守卫 PASS；ALLOWLIST 恰好 3 条（`lifecycle-policy.ts`、`lifecycle-identity.ts`、`supervisor-replay.ts`）。

- [ ] **步骤 2：残留扫描**

```bash
echo "--- 以下六项均应零命中 ---"
grep -rn "workflow" packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts
grep -rn "subagent-dispatch/ir\|subagent-dispatch/prompt" --include=*.ts --include=*.mjs packages/ src/ pi/ test/ scripts/
grep -rn "workflow\.mode\|workflow\.reason" skill-overrides/ pi/AGENTS.md pi/AGENTS_APPEND.md packages/pi-subagents-enhanced/README.md packages/pi-subagents-enhanced/AGENTS.md AGENTS.md 2>/dev/null
grep -rn "必须以 \`/\*\*\` 或 \`/\` 结尾" skill-overrides/
grep -rn "readonly ReadonlySet" packages/pi-subagents-enhanced/src/
echo "--- 以下应仍有命中（必须保留的 spawn 编排概念）---"
grep -cn "codingWorkflowSpawnParams\|genericWorkflowSpawnParams" packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts
echo "--- profile 语义保全（HI-2）---"
for f in pi/agents/delegate.md pi/agents/executor.md; do echo "  $f:"; for n in "contact_supervisor" "need_decision" "不得委派其他 subagent"; do grep -qF "$n" "$f" && echo "    OK   $n" || echo "    MISS $n"; done; done
for n in "证据优先于推断" "未验证的行为不得声明完成"; do grep -qF "$n" pi/agents/delegate.md && echo "    OK   $n (delegate)" || echo "    MISS $n (delegate)"; done
echo "--- reviewer.md 未被修改（R6）---"
git diff --stat -- pi/agents/reviewer.md
```

预期：前五项零命中；第六项有命中；profile 语义全部 `OK`；`git diff --stat -- pi/agents/reviewer.md` **无输出**（该文件保持用户预存编辑状态，本计划未追加任何改动）。

- [ ] **步骤 3：定向套件连跑两次**

```bash
SUITE="test/package-orphan-export-guard.test.mjs test/subagent-dispatch-readonly-writepaths.test.mjs test/subagent-dispatch-validation-errors.test.mjs test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-ir-coercion.test.mjs test/subagent-dispatch-workflow-removed.test.mjs test/subagent-dispatch-contract-hash-compat.test.mjs test/subagent-dispatch-writepaths-grammar.test.mjs test/subagent-model-candidates.test.mjs test/subagent-model-selection.test.mjs test/subagent-execution-contract.test.mjs test/subagent-dispatch-schema-coercion.test.mjs test/subagent-dispatch-schema-security.test.mjs test/subagent-dispatch-skill.test.mjs test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs test/pi-subagents-enhanced-package.test.mjs"
node --test $SUITE >/tmp/acc-a-1.log 2>&1; echo "run#1 exit=$?"; tail -8 /tmp/acc-a-1.log
node --test $SUITE >/tmp/acc-a-2.log 2>&1; echo "run#2 exit=$?"; tail -8 /tmp/acc-a-2.log
npm run verify:subagents-enhanced
```

预期：两次 `exit=0`；`verify:subagents-enhanced` PASS。

- [ ] **步骤 4：真实 Pi lane 如实记录**

运行：`npm run test:subagents 2>&1 | tail -8`

预期：因 `PI_REAL_BIN` 未设置而 fail。记录实际输出并标注 `环境受限未验证（延后项 R3，需用户确认 PI_REAL_BIN 路径）`。**不得**自行导出该变量后重跑并记为通过——那会让「真实环境 lane 从未验证」这一体制性缺口继续被掩盖（总纲 §5 第 1 条）。

- [ ] **步骤 5：确认 live 现场未被触碰**

```bash
R=/Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0
echo "worktree 目录数=$(ls $R/worktrees | wc -l | tr -d ' ')  (期望 5)"
echo "record 数=$(ls $R/records | wc -l | tr -d ' ')  (期望 5)"
python3 -c "
import json
d=json.load(open('$R/integration-queue/0ed45c9b-ec5f-4579-b509-e0bb944a436b.json'))
print('queue item state =', d['state'], ' admissionGeneration =', d['admissionGeneration'], ' (期望 queued / 0)')"
SNAP=var/snapshots/2026-09-23-pre-remediation
[ -d "$SNAP" ] && diff -rq "$SNAP/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0/records" "$R/records" && echo "records 与快照一致" || echo "records 与快照有差异或快照不存在"
```

预期：worktree 5、record 5、queue 仍 `queued`/`admissionGeneration=0`、records 与总纲 §2 步骤 2 的快照一致。任一不符即说明有任务违规触碰 live 现场，立即停止并报告。

注：若总纲 §2 步骤 3 的重启已执行，queue/record 状态**可能**已被新代码改变——此时以重启后记录的基线（总纲 §2 步骤 4）为对照，而非本步骤写死的期望值。

- [ ] **步骤 6：机械自检（取代自评章节）**

运行总纲 §6 的检查脚本，`PLAN=docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md`：

```bash
PLAN=docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md
echo "── 任务数 / 步骤数 ──"; grep -c '^### Task' "$PLAN"; grep -c '^- \[ \] \*\*步骤' "$PLAN"
echo "── 占位词扫描（应零命中；排除本检查脚本自身的命令行）──"; grep -nE 'TBD|TODO|以后实现|类似 Task|待补充|填充细节' "$PLAN" | grep -v 'grep -nE' || echo "  无"
echo "── 条件式表述清单（逐条人工判定；排除本检查脚本自身的命令行）──"; grep -nE '以.*实际.*为准|若存在则|附近若有|按需|视情况' "$PLAN" | grep -v 'grep -nE' || echo "  无"
echo "── 每任务是否都有步骤 0 门禁（HI-16）──"
python3 - "$PLAN" <<'PY'
import re,sys
t=open(sys.argv[1]).read()
for tk in [x for x in re.split(r'\n(?=### Task )',t) if x.startswith('### Task')]:
    name=re.match(r'### Task ([\w-]+)',tk).group(1)
    has0='步骤 0：受保护路径门禁' in tk
    hasres='**Resources：**' in tk and re.search(r'\*\*Resources：\*\*\s*`?none',tk) is None
    print(f"  T{name:<6} 步骤0门禁={'OK' if has0 else 'MISS'}  Resources声明={'有' if hasres else 'none'}")
PY
echo "── WritePaths 重叠是否被「资源锁」或「DAG 边」覆盖 ──"
python3 - "$PLAN" <<'PY'
import re,sys,collections,itertools
t=open(sys.argv[1]).read()
tasks=[x for x in re.split(r'\n(?=### Task )',t) if x.startswith('### Task')]
tid=lambda tk:(lambda i: 'T'+i if i.isdigit() else i)(re.match(r'### Task ([\w-]+)',tk).group(1))  # 标题可能是 '0'、'T-ENV'、'A-ACC'；仅纯数字补 T 前缀，否则原样，才能与 Deps 引用对齐

owners=collections.defaultdict(list); res=collections.defaultdict(set); deps={}
for tk in tasks:
    i=tid(tk)
    seg=tk[:tk.find('**Files')] if '**Files' in tk else tk[:2500]
    wp=re.search(r'\*\*WritePaths：\*\*(.*?)\n\n',seg,re.S)
    if wp:
        for p in re.findall(r'^- `([^`]+)`',wp.group(1),re.M): owners[p].append(i)
    r=re.search(r'\*\*Resources：\*\*(.*)',tk)
    if r:
        for lock in re.findall(r'`([a-z0-9-]+)`',r.group(1)): res[i].add(lock)
    d=re.search(r'\*\*Deps：\*\*(.*)',tk)
    deps[i]=set(re.findall(r'`(T[\w-]+)`',d.group(1))) if d else set()

# 传递闭包：src 先于 dst 当且仅当 dst 可沿 Deps 反向到达 src
def precedes(src,dst,seen=None):
    seen=seen if seen is not None else set()
    for d in deps.get(dst,()):
        if d==src: return True
        if d in seen: continue
        seen.add(d)
        if precedes(src,d,seen): return True
    return False

bad=[]
for p,o in sorted(owners.items()):
    if len(o)<2: continue
    pairs=list(itertools.combinations(o,2))
    locked=all(bool(set(res[a])&set(res[b])) for a,b in pairs)
    serial=all(precedes(a,b) or precedes(b,a) for a,b in pairs)
    how=[]
    if locked: how.append('资源锁 '+str(sorted(set.intersection(*[res[x] for x in o]))))
    if serial: how.append('DAG 边串行化')
    ok=locked or serial
    print(f"  {'OK ' if ok else '缺 '} {p}")
    print(f"      <- {o}   覆盖方式={', '.join(how) or '无'}")
    if not ok: bad.append(p)
print()
print('结论:', '全部共享文件均被资源锁或 DAG 边覆盖' if not bad else f'No-Go，缺覆盖: {bad}')
PY
```

判定规则（**No-Go 条件**）：
- 占位词扫描有命中 → No-Go
- 任一任务缺「步骤 0：受保护路径门禁」→ No-Go（HI-16 的机械化落地）
- 共享文件存在但**既无共同资源锁、也未被 DAG 边串行化** → No-Go（两者其一即可；`writing-plans` skill 明确资源竞争只针对可并行的任务，已被依赖边串行化的共享文件不需额外加锁）
- 条件式表述的每一条命中都必须在验收记录中写明「合法运行时分支」或「已改为确定动作」的判定结论

- [ ] **步骤 7：回写验收记录**

在本计划文末新增「## 验收记录」小节，逐项记录步骤 1–6 的实际命令输出摘要（通过/失败/环境受限），并列出：
- 已兑现的缺口编号：B1、H3、H4、H8、H9、M2、M4（M4 属计划 B，此处只确认计划 A 未引入冲突）
- 只产出决策未实现的编号：B2 → T13
- 仍延后的编号与原因（引用总纲 §4）
- 步骤 6 中每条条件式表述的判定结论

---

## T-ENV 探针结论

（由 T-ENV 步骤 3 填写）

> **文档恢复记录：** 本文原正文曾被 A-ACC 验收回写错误覆盖；已从主 session 的成功 `write` 与后续成功 heredoc 记录确定性重建。以下验收记录保留该次实际输出；恢复动作未修改源码、测试或 live 现场。

## 验收记录

- 执行时间：2026-09-24（UTC，A-ACC）。本节点为纯文档/验收记录任务豁免 TDD：不修改 production behavior、源码、测试或 Skill；TDD skill 已读取，豁免理由与证据为本节仅写回验收记录且所有验证均为只读命令。
- 受保护路径门禁：`git status --short -- pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/` 输出仅为既有 ` M pi/agents/reviewer.md`、` M pi/settings.json`；`pi/models.json` 与 `var/workspaces/` 无输出。收工复核相同；未执行提交、staging、stash、reset、clean、checkout 或 live mutation。

### A0-A6 产物处置

- A0：`node --test test/package-orphan-export-guard.test.mjs` 通过，4/4；负向同名 basename 检查也通过。当前守卫 ALLOWLIST 实际为 5 条：`durable-run-registry.ts`、`lifecycle-identity.ts`、`lifecycle-policy.ts`、`supervisor-replay.ts`、`workspace/coordinator-process.ts`。因此“仅剩 lifecycle 3 条”的旧预期与当前证据不一致，未擅自删除任何 allowlist 条目，列为残余风险。
- A1：canonical dispatch-ir、空 `writePaths`、shape hint 与双孤儿删除由定向套件覆盖并通过；全仓孤儿深层引用残留扫描无命中。
- A2/A3 合并一致性审计：`dispatch-ir.ts` 实读确认 `normalizeBoundaries` 使用 `minItems: 0`；路径实现同时保留 `/\*\*` 分类、`/\*\*` 根拒绝、NUL、反斜杠、尾随 `/`、非法 glob、空段/`.`/`..` 与分类文案。A2 contract-hash 专测保留旧 workflow record 加载断言；A3 grammar 专测保留空数组、递归 glob 和错误分类断言。`SKILL.md` 实读确认同时保留 TDD skill 路径/dispatch 语义、`writePaths` 空数组只读语义及完整单句文法（尾随 `/**`、禁止尾随 `/`、glob/NUL 等）。`test/subagent-dispatch-contract-hash-compat.test.mjs` 与 grammar/skiIl 测试均未被删断言，定向套件 109/109 通过。
- A4：模型候选相关测试纳入定向套件并通过。
- A5：execution contract 测试纳入定向套件并通过。
- A6/T13：分支 probe 与探索文档已存在；文档记载 8 类实际结果、根级 union provider 风险、推荐方案及未决项，且明确 A-ENV degraded、未连接 live host。

### 命令与结果

1. `npm run typecheck`：通过（root 与 `pi-subagents-enhanced` typecheck 均 exit 0）。
2. 计划 A 定向套件（17 个测试文件）：连续两次通过，均 `tests 109, pass 109, fail 0`。
3. `npm run verify:subagents-enhanced`：通过，package verify exit 0（importEdges 121，tarball fileCount 2257）。
4. `npm run test:subagents`：exit 1，真实 Pi lane 环境受限未验证（`PI_REAL_BIN` 未设置，实际失败表现为 `spawn` 的 file argument 为 undefined）；未设置环境变量伪造通过，记录为延后项 R3。
5. 残留扫描：`dispatch-ir.ts` 无 `workflow`；深层 `subagent-dispatch/ir|prompt`、`workflow.mode|workflow.reason`、旧路径尾随文案、`readonly ReadonlySet` 均无命中；extension 保留 spawn 编排概念 4 个命中；delegate/executor 的 `contact_supervisor`、`need_decision`、不得委派语义均保留。
6. 机械门禁实际执行：计划任务数 9、步骤数 82，占位词扫描 PASS，所有任务均有步骤 0。原计划附带的共享覆盖脚本输出了 No-Go（其传递依赖闭包实现存在条件判断缺陷，且其任务 ID 归一化无法覆盖 `T-ENV`/`A-ACC`；不是共享文件实际无 DAG 覆盖的证据）。随后按 DAG 依赖与资源表复核：`dispatch-ir`、`skill-md` 共享项均有共同资源锁；计划文档的 T-ENV→A-ACC 为传递依赖，守卫测试由 T0→T1 串行覆盖。故语义审计无未覆盖共享 WritePath，但原机械脚本结果保留为工具缺陷风险，未篡改脚本或宣称其原输出 PASS。
7. 条件式表述判定：计划中的“若 PI_REAL_BIN 缺失”已按实际缺失归类环境受限；SKILL 外部副本按存在性规则仅作条件检查；live queue/records 检查未执行写操作且不连接 live host，真实 Pi lane 仍来源未证实。

### 缺口与残余风险

- 已兑现/确认：B1、H3、H4、H8、H9、M2；M4（计划 B）仅确认 A 未引入冲突。
- 只产出探索：B2 → T13/A6，仍待后续用户裁决与实现。
- 环境受限：真实 Pi lane/PI_REAL_BIN；A-ENV 已判定 degraded，未验证 live supervisor transport，不调用 `contact_supervisor`。
- 机械门禁工具风险：原共享覆盖脚本因自身闭包条件与 ID 解析问题输出 No-Go；已完成只读语义复核，建议后续修正门禁脚本后再重跑，但本节点不越界修改脚本。
- ALLOWLIST 与计划文字不一致：实际 5 条而非预期 3 条，额外两条未擅自清理，需生命周期批次确认归属。

### 验收结论

A-ACC 的确定性代码与文档证据通过；真实 Pi lane 为环境受限未验证；A 阶段不应将环境项伪造为 PASS。计划 A 记录已写回，除本验收小节外无其他计划内容修改。
