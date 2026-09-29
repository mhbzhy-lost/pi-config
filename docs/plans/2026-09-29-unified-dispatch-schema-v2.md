# 统一 Dispatch Schema v2 实现计划（修订版）

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 将 coding/generic 两套分叉的 dispatch schema 统一为"generic + writePaths + acceptance = coding"的超集模型；subagent-dispatch skill 迁入 `pi/AGENTS_APPEND.md` 并退役。

**架构：** 单一公共输入 schema。有 `writePaths` 即 coding dispatch，无即 generic。`version`/`taskId`/`risk`/`context`/`boundaries`/`execution` 等旧字段删除。统一合同编译器替代 `dispatch-ir.ts` + `generic-prompt.ts`。字段名统一用 `task`（不用 `objective`）。

**技术栈：** TypeScript、`node:test`、pi-subagents-enhanced package。

## 全局约束

- 严格 TDD：先断言级 RED，再最小 GREEN。
- 只修改声明 WritePaths；不触碰 protected paths/live state。
- 不修改上游 `pi-subagents@0.62.0` 的任何文件。
- 不修改 `ordered-models-runtime-patch.ts`。
- `taskId` 由 runtime 生成：`dispatch-{contractHash前8位}`，contractHash 输入**不含** taskId（消除循环）。
- `timeoutMs` 由 Host 注入（`STALL_NOTIFY_AFTER_MS = 30 * 60_000`），模型提供则拒绝。
- `writePaths` 不允许空数组；允许宽泛目录（`src/**`）。
- 字段名统一用 `task`（不用 `objective`）。
- 旧 `version: "dispatch-ir.v1"` 输入返回 `DEPRECATED_SCHEMA` 错误，附带迁移指引。
- 已持久化的 Goal contract/recovery artifact 不属于 public input，不做 schema 迁移；仅处理新 dispatch 输入。
- `package.json` 的 `./generic-prompt` 导出随文件删除同步移除。

## 最终字段表

### Generic dispatch（2 必填 + 2 可选）

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `agent` | ✅ | string | agent profile |
| `task` | ✅ | string | 任务描述 |
| `title` | | string | 显示标题 |
| `model` | | string | 模型选择 |

### Coding dispatch（4 必填 + 4 可选 = generic 超集）

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `agent` | ✅ | string | 同 generic |
| `task` | ✅ | string | 同 generic |
| `writePaths` | ✅ | string[] (minItems:1) | 允许写入路径 |
| `acceptance.criteria` | ✅ | string[] (minItems:1) | 验收标准 |
| `title` | | string | 同 generic |
| `model` | | string | 同 generic |
| `worktree` | | boolean | 隔离 workspace |
| `cwd` | | string | worktree 基准目录 |

### 路由判定

```ts
isCodingDispatch(input) = isPlainObject(input) && Object.hasOwn(input, "writePaths")
```

| 输入 writePaths | 路由 | 结果 |
|---|---|---|
| 未提供（无此 key） | generic | 正常 |
| `["src/**"]` | coding | 正常 |
| `[]` | coding | 报错 `INVALID_CONTRACT`（minItems:1） |
| `null` / 非 array / 非 string 元素 | coding | 报错 `INVALID_CONTRACT` |
| 字符串化 JSON `"[\"src\"]"` | coding | coercion 后正常 |

**coding 专属字段保护**：`acceptance`/`worktree`/`cwd` 在无 `writePaths` 时出现 → 报错 `CODING_FIELD_WITHOUT_WRITE_PATHS`。

### 删除的字段

| 字段 | 去向 |
|---|---|
| `version` | 删除；旧值触发 DEPRECATED_SCHEMA |
| `taskId` | runtime 生成 `dispatch-{hash前8位}` |
| `risk` | 删除 |
| `requirements` | 合并进 task |
| `context`（整对象） | 合并进 task |
| `boundaries`（整对象） | writePaths 提升；其余合并进 task |
| `execution`（整对象） | worktree/cwd 提升顶层；timeoutMs Host 注入 |
| `thinkingLevel` | 移到 spawn 参数，不进合同 hash |

## 接口层次

```
公共输入 (model-visible)
  ↓ compileDispatchIR
编译 IR (runtime internal)
  ↓ renderDispatchPrompt / spawnWorkflowLeaf
child prompt + spawn params (pi-subagents upstream)
```

### 编译 IR 类型

```ts
type GenericDispatchIR = {
  kind: "generic";
  agent: string;
  task: string;
  title: string;         // 缺省从 task 前 50 字符截取
  model?: string;
  taskId: string;        // runtime 生成
  contractHash: string;  // 不含 taskId
};

type CodingDispatchIR = GenericDispatchIR & {
  kind: "coding";
  writePaths: string[];
  acceptance: { criteria: string[] };
  worktree: true;
  cwd: string;           // 缺省 ctx.cwd
  timeoutMs: number;     // Host 注入
};

type DispatchIR = GenericDispatchIR | CodingDispatchIR;
```

### contractHash 计算

```ts
contractHash = sha256(canonical({
  agent, task, title, model,
  // coding 额外：
  writePaths, acceptance, worktree, cwd
}))
// taskId 和 timeoutMs 不进入 hash 输入
taskId = "dispatch-" + contractHash.slice(0, 8)
```

## 文件结构

| 文件 | 变更 | 职责 |
|---|---|---|
| `src/contracts/dispatch-ir.ts` | **重写** | 统一 v2 编译器（替代旧 v1 + generic-prompt） |
| `src/contracts/generic-prompt.ts` | **删除** | 合并进 dispatch-ir.ts |
| `src/subagent-dispatch/extension.ts` | **大改** | 统一路由 + spawn |
| `src/subagent-dispatch/execution.ts` | **适配** | 消费新 IR 字段 |
| `src/subagent-dispatch/workflow-spawn.ts` | 小改 | 参数适配 |
| `extensions/subagent-runtime.ts` | 小改 | 适配 |
| `package.json` | 小改 | 删 `./generic-prompt` 导出 |
| `scripts/verify-package.ts` | 小改 | 文件清单更新 |
| `skill-overrides/subagent-dispatch/` | **删除** | 退役 |
| `pi/AGENTS_APPEND.md` | **追加** | 接收核心约束 |
| `test/` ~35 个文件 | **迁移** | 旧 schema → 新 schema |

## DAG

```text
T1 (v2 编译器) ──> T3 (extension 统一) ──> T5 (测试迁移) ──> T6 (E2E)
T2 (AGENTS_APPEND) ──> T4 (Skill 退役) ──> T5
```

## Waves

- Wave 1：T1、T2（并行）
- Wave 2：T3、T4（T3 等 T1；T4 等 T2）
- Wave 3：T5（等全部）
- Wave 4：T6（等 T5）

**关键路径：** T1 → T3 → T5 → T6。

---

### Task T1：重写统一 v2 合同编译器

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-ir-coercion.test.mjs`

**Resources：** `dispatch-ir`

**接口契约：**
- Consumes：`normalizeRepoRelativePath` 路径文法（保留原实现）。
- Produces：
  - `compileDispatchIR(input, options?)` → `DispatchIR`
  - `isCodingDispatch(input)` → boolean
  - `renderDispatchPrompt(ir)` → string
  - `DEPRECATED_SCHEMA` 错误类型

**行为规格：**

```ts
const ALLOWED_PUBLIC_KEYS = [
  "agent", "task", "title", "model",
  "writePaths", "acceptance", "worktree", "cwd",
];

// 公共入口：模型提供的 input
export function compileDispatchIR(input, options = {}) {
  // 1. 检测旧 schema
  if (Object.hasOwn(input, "version")) {
    throw deprecatedSchemaError(input.version);
  }
  // 2. 验证 agent 非空
  // 3. 验证 task 非空
  // 4. title 缺省从 task 前 50 字符
  // 5. 路由
  const coding = isCodingDispatch(input);
  // 6. coding 路径：
  //    - writePaths: 路径数组 minItems:1，用 normalizeRepoRelativePath
  //    - acceptance.criteria: 非空字符串数组
  //    - worktree: 可选 boolean（默认 false → 不进 IR）
  //    - cwd: 可选 string（默认 options.cwd）
  //    - timeoutMs: 从 options 注入（模型提供 → 拒绝）
  // 7. generic 路径：
  //    - 出现 acceptance/worktree/cwd → CODING_FIELD_WITHOUT_WRITE_PATHS
  // 8. contractHash = sha256(canonical(agent, task, title, model, [writePaths, acceptance, worktree, cwd]))
  // 9. taskId = "dispatch-" + contractHash.slice(0, 8)
  // 10. 返回 frozen DispatchIR
}

export function isCodingDispatch(input) {
  return isPlainObject(input) && Object.hasOwn(input, "writePaths");
}

export function renderDispatchPrompt(ir) {
  // 统一 prompt（5 sections）：
  // # Dispatch Contract
  // ## Identity
  // ## Task
  // ## Write Scope       (仅 coding)
  // ## Acceptance Criteria (仅 coding)
  // ## Escalation
}
```

**DEPRECATED_SCHEMA 错误格式：**

```ts
{
  code: "DEPRECATED_SCHEMA",
  message: "This input uses dispatch-ir.v1. Migration: remove version/taskId/risk; merge requirements+context into task; move boundaries.writePaths to writePaths; move acceptance to acceptance; move execution.worktree/cwd to top-level; do not provide timeoutMs.",
  keypath: "version",
}
```

**验收标准：**

- [ ] RED：新测试覆盖 generic 编译、coding 编译、路由判定、writePaths 空数组报错、coding 专属字段无 writePaths 报错、旧 v1 DEPRECATED_SCHEMA、taskId 自动生成、hash 稳定、模型提供 timeoutMs 拒绝
- [ ] GREEN：通过
- [ ] coercion：stringified JSON 可转换

---

### Task T2：AGENTS_APPEND.md 接收核心约束

**Deps：** `none`

**WritePaths：**
- `pi/AGENTS_APPEND.md`

**行为规格：**

从 SKILL.md 迁移以下内容（中文，遵循当前文件风格）：

```markdown
## Subagent Dispatch 运行时约束

### 派发
- coding（修改仓库文件）必须提供 `writePaths` 和 `acceptance.criteria`。
- generic（纯文本/调研）只需 `agent` 和 `task`。
- 并发写入同一仓库的子任务应使用 `worktree: true` 隔离。
- 用户明确禁止 worktree 时不得使用。

### 生命周期
- dispatch 后不 sleep/poll；完成通知自动到达。
- `status` 仅限用户要求、干预或诊断。
- `interrupt` 后用 `resume` 恢复；stopped 不可恢复。

### Workspace 处置
- `worktree: true` 返回 `workspace_id`。
- 完成后：`subagent_worktree({action:"status"})` → integrate/discard 完成处置，或 preserve 暂留后 release。
- 不使用 raw git worktree 命令。

### 安全边界
- 不输出 token/credential/authorization 内容。
- TUI 只渲染精简投影，不改写 raw payload。
- completion/status 不等于 terminal proof。

### Reviewer 批准
- 每次实际派发 reviewer 前必须取得用户明确批准。
```

**验收标准：**
- [ ] `git diff --check` 通过
- [ ] 不与 tool description 重复字段说明
- [ ] 不含 token/凭据

---

### Task T3：Extension 统一路由与 spawn

**Deps：** `T1`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts`（删除）
- `packages/pi-subagents-enhanced/package.json`
- `packages/pi-subagents-enhanced/scripts/verify-package.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `test/subagent-runtime-membrane.test.mjs`

**Resources：** `extension-ts`

**行为规格：**

1. **路由**：`execute()` 检查 `isCodingDispatch(input)` 分支。
2. **executeCoding**：消费新 `CodingDispatchIR`，顶层字段。
3. **executeGeneric**：消费新 `GenericDispatchIR`，顶层字段。
4. **TYPED_SUBAGENT_PARAMETERS** 更新：删除旧字段，新字段扁平。
5. **TYPED_SUBAGENT_DESCRIPTION** 更新：统一描述。
6. **execution.ts**：`createGenericDispatchAdapter` 改为消费新 IR 的 `task` 字段。
7. **workflow-spawn.ts**：参数适配。
8. **generic-prompt.ts 删除**：功能合并进 dispatch-ir.ts。
9. **package.json**：删 `./generic-prompt` 导出。
10. **verify-package.ts**：文件清单更新。
11. **subagent-runtime.ts**：适配。

**验收标准：**
- [ ] RED/GREEN
- [ ] generic `{agent, task}` 正常 spawn
- [ ] coding `{agent, task, writePaths, acceptance}` 正常 spawn
- [ ] coding `worktree: true` 分配 workspace
- [ ] 旧 v1 输入得到 DEPRECATED_SCHEMA
- [ ] `npm run typecheck:subagents-enhanced` 通过
- [ ] `npm --prefix packages/pi-subagents-enhanced run verify:package` 通过

---

### Task T4：Skill 退役

**Deps：** `T2`（理由：先有去处再删除）

**WritePaths：**
- `skill-overrides/subagent-dispatch/`（整目录删除）
- `test/subagent-dispatch-skill.test.mjs`（删除或重写）

**行为规格：**

1. 删除 `skill-overrides/subagent-dispatch/` 目录（SKILL.md + model-tiers.yaml）。
2. 删除或重写 `test/subagent-dispatch-skill.test.mjs`。
3. 搜索所有 skill discovery 引用（`skill-overrides/` 目录扫描、`skills.list`、sync 脚本）确保不会残留或重新生成。
4. 检查 `.pi/handoff/`、`docs/skill-tests/` 中的引用并更新。

**验收标准：**
- [ ] 目录不存在
- [ ] 无残留 import/reference
- [ ] skill discovery 不再返回 subagent-dispatch
- [ ] typecheck 通过

---

### Task T5：全部测试迁移

**Deps：** `T1`、`T2`、`T3`、`T4`

**WritePaths：**
- `test/` 下全部引用旧 schema 的文件（扫描驱动）

**Resources：** `full-test-suite`

**迁移方法：扫描驱动**

```bash
# 先扫描受影响文件
rg -l 'dispatch-ir\.v1|compileCodingDispatchIR|renderCodingDispatchPrompt|compileGenericPrompt|generic-prompt|"version":\s*"dispatch' \
  packages/ src/ scripts/ test/ pi/ --type ts --type mjs
```

**迁移规则（机械可执行）：**

| 旧字段 | 新字段 | 操作 |
|---|---|---|
| `version: "dispatch-ir.v1"` | （删除） | 直接删 |
| `taskId: "..."` | （删除） | 直接删 |
| `risk: "..."` | （删除） | 直接删 |
| `objective: "..."` | `task: "..."` | 重命名 |
| `requirements: [...]` | （合并） | 内容追加到 task 末尾 |
| `context: {knownFacts, decisions, relevantFiles}` | （合并） | 内容追加到 task |
| `boundaries: {writePaths, excludedWork, forbiddenActions}` | `writePaths: [...]` | writePaths 提升；excludedWork/forbiddenActions 合并到 task |
| `execution: {worktree, cwd}` | `worktree`, `cwd` | 提升顶层 |
| `execution: {timeoutMs}` | （删除） | Host 注入 |
| generic 的 `task: "..."` | `task: "..."` | 不变 |

**验收标准：**

- [ ] 扫描结果中旧 schema 引用为零（专门的 deprecated-input 测试除外）
- [ ] 全部受影响测试通过
- [ ] typecheck 通过
- [ ] `git diff --check` 通过

---

### Task T6：真实 E2E 回归

**Deps：** `T5`

**WritePaths：** `none`

**Resources：** `pi-real-lane`

**验收标准：**

- [ ] `PI_REAL_BIN=/opt/homebrew/bin/pi node --test --test-name-pattern='project typed worktree commit' test/pi-subagents-project-workflow.integration.mjs` PASS
- [ ] 真实模型 coding dispatch：`{agent, task, writePaths, acceptance}` 正确路由并 spawn
- [ ] 真实模型 generic dispatch：`{agent, task}` 正确路由
- [ ] 旧 v1 输入得到 DEPRECATED_SCHEMA

---

## 计划自检

1. **规格覆盖**：编译器（T1）、AGENTS_APPEND（T2）、extension（T3）、skill（T4）、测试（T5）、E2E（T6）。✅
2. **占位扫描**：无。✅
3. **taskId/hash 无循环**：contractHash 输入不含 taskId；taskId 从 hash 派生。✅
4. **writePaths 空数组**：`minItems: 1` 报错。✅
5. **task 字段统一**：全用 `task`，不用 `objective`。✅
6. **generic-prompt.ts 删除**：连同 package.json 导出和 execution.ts 适配。✅
7. **扫描驱动迁移**：T5 用 rg 扫描确定受影响文件，不靠人工列举。✅
8. **DAG**：T1/T2 并行 → T3/T4 并行 → T5 → T6。✅
