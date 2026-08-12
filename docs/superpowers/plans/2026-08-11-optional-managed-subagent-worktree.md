# Subagent 可选受管 Worktree 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `test-driven-development` 逐任务实施；Steps 使用 checkbox（`- [ ]`）跟踪。执行编排遵循项目 `subagent-dispatch` / Goal Engine 门禁。

**Goal:** 为项目自有 `subagent` 工具增加由主 Agent 显式选择的可选受管 worktree；默认不创建，启用后只能经项目 owner-CAS 生命周期创建和处置。

**Architecture:** Generic 调用使用顶层 `worktree?: boolean`，`dispatch-ir.v1` 使用 `execution.worktree?: boolean`；缺省与 false 保持旧 hash，只有 true 进入合同。运行层绝不把 true 转发给 `pi-subagents`，而是先创建项目受管 worktree，再把等价子目录作为 child cwd，并继续向上游传 `worktree:false`。Workspace 采用私有 durable ledger；主 Agent 先查询可信进程终止证明和 Git 快照，取得一次性 action token，再显式 integrate、preserve 或 discard。

**Tech Stack:** TypeScript、Node.js ESM、Pi Extension API、Root Broker process-terminal proof、项目 `worktree-lifecycle` owner registry、Goal workspace Git 验证原语、`node:test`、临时 Git 仓库。

## Global Constraints

- `docs/bugs/bug-subagent-dispatch-cannot-request-managed-worktree.md` 已在计划阶段建立；任何生产任务仍必须先写自己的 RED 并观察目标失败。
- `worktree` 缺失或 false 时必须保持现有 cwd、RPC payload、contract hash 与性能行为；不得创建 lease、branch 或目录。
- true 只能调用项目 managed lifecycle API；禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`。
- 上游 workflow root 和 leaf 始终固定 `worktree:false`；不得使用 `pi-subagents` 自有 worktree 生命周期。
- 来源必须是 attached HEAD 且除 `.state/**`、`.pi-subagents/**` 外干净；脏来源 fail closed，不能遗漏未提交内容。
- 没有官方 `processTerminal.state === "observed"` 证明时，不得 integrate/discard；普通完成通知和 RPC status 都不是释放授权。
- integrate 仅允许结构化 coding dispatch，并必须复验 clean commit、base 后代关系和 `writePaths`；Generic 只能 preserve/discard。
- discard 仅释放 clean、无 sequencer、无活跃进程的 worktree；routine release 不删除 branch、不使用 `--force`。
- 无人选择 disposition 时保持 `active/awaiting-disposition`；不得按 TTL、临时路径或 clean 状态自动释放。
- owner token 仅存 mode `0600` 的私有 ledger，不返回模型；模型只获得 workspace ID、状态和一次性 action token。
- 不触碰当前已有 `pi/settings.json`、`.state/worktree-lifecycle/`、Goal Engine 测试与 handoff 等无关改动；真实测试只操作 temporary arena。
- 本计划实施期间不提交、不暂存。

## 稳定公开合同

```ts
// Generic
{ agent: string, title: string, task: string, worktree?: boolean, ... }

// Coding dispatch-ir.v1
execution: { cwd?: string, timeoutMs: number, worktree?: boolean }

// Local control actions on the same subagent tool
{ action: "workspace_status", workspace_id: string }
{
  action: "workspace_disposition",
  workspace_id: string,
  disposition: "integrate" | "preserve" | "discard",
  strategy?: "cherry-pick" | "merge",
  action_token: string
}
```

`workspace_status` 返回：

```ts
{
  workspace_id: string,
  run_id: string,
  kind: "coding" | "generic",
  process_terminal: "observed" | "pending" | "unknown",
  workspace_state: "active" | "preserved" | "reclaimable" | "cleanup-debt" | "released",
  allowed_dispositions: Array<"integrate" | "preserve" | "discard">,
  action_token: string
}
```

Token 绑定 workspace owner、runId、官方终止证明哈希、workspace HEAD/status、origin HEAD/ref/status 与允许动作；快照变化或消费一次后失效。

## 文件职责

| 文件 | 职责 |
|---|---|
| `scripts/lib/subagent-dispatch/ir.ts` | 校验 `execution.worktree`，保持默认 false 的旧 hash |
| `scripts/lib/goal-engine/dispatch-ir.mjs` | 保持另一份 dispatch-ir.v1 编译器语义一致 |
| `scripts/lib/subagent-dispatch/root-broker-server.ts` | 为所有项目门面 leaf 保存官方进程终止证明；Generic 不获得 Executor grant |
| `scripts/lib/subagent-dispatch/workspace-ledger.mjs` | owner sidecar、run 绑定、快照 token 与 CAS |
| `scripts/lib/subagent-dispatch/workspace.mjs` | 分配、检查、集成、保留、释放受管 workspace |
| `scripts/lib/subagent-dispatch/extension.ts` | schema、隔离 cwd、workspace status/disposition 接线 |
| `skill-overrides/subagent-dispatch/SKILL.md` | 教主 Agent 选择 worktree 和完成后显式处置 |

## DAG

```text
Task 0 合同冻结
  ├──> Task 1 IR/schema 兼容 ──────────────┐
  ├──> Task 2 通用终止证明 ───────────────┤
  ├──> Task 3 分配与 Durable Ledger ──────┼──> Task 5 Facade 接线与控制动作
  └──> Task 4 检查与集成原语 ─────────────┘          ├──> Task 6 真实 Host 集成 ─┐
                                                     └──> Task 7 Skill/文档 ─────┼──> Task 8 零增长终验
```

依赖边理由：

- `T0 -> T1/T2/T3/T4`：四个并行任务只消费已冻结的字段、proof、ledger 和 disposition 合同。
- `T1/T2/T3/T4 -> T5`：Facade 必须同时具备规范化 schema、可信终止证明、owner ledger 和安全 Git 原语。
- `T5 -> T6/T7`：真实集成和 Skill 只基于最终公开 ABI。
- `T6/T7 -> T8`：终验需要可执行闭环与最终人机合同。

## 并行调度组（Wave）

- **Wave 0:** Task 0
- **Wave 1:** Task 1、Task 2、Task 3、Task 4 并行；WritePaths 不重叠。
- **Wave 2:** Task 5
- **Wave 3:** Task 6、Task 7 并行。
- **Wave 4:** Task 8

Wave 不是派发屏障；只按依赖边触发。临时 Git 仓库属于资源约束，不添加 DAG 依赖。

---

### Task 0: 冻结参数、证明与处置合同

**Deps:** none

**WritePaths:**
- `docs/bugs/bug-subagent-dispatch-cannot-request-managed-worktree.md`
- `docs/superpowers/plans/2026-08-11-optional-managed-subagent-worktree.md`

**Workflow:** docs-only

- [ ] **Step 1: 补充根因和安全边界**

在 bug 文档明确：直接透传上游 true 会绕过 owner registry；RPC completion/status 不是进程退出证明；Generic 无 `writePaths`，不能安全 integrate。

- [ ] **Step 2: 固定模型可见 ABI**

逐字采用本计划“稳定公开合同”的两个参数位置和两个 control action；后续任务不得自行改名。

- [ ] **Step 3: 固定私有 ledger schema**

记录精确字段：

```ts
{
  schemaVersion: "subagent-workspace-ledger.v1",
  workspaceId: string,
  kind: "coding" | "generic",
  rootSessionId: string,
  toolCallId: string,
  contractHash: string | null,
  runId: string | null,
  asyncDir: string | null,
  originRoot: string,
  originRef: string,
  originHeadAtAllocation: string,
  requestedCwd: string,
  workspacePath: string,
  dispatchCwd: string,
  branchRef: string,
  baseCommit: string,
  ownerToken: string,
  writePaths: string[] | null,
  state: "allocating" | "active" | "preserved" | "reclaimable" | "cleanup-debt" | "released",
  actionChallenge: null | { tokenHash: string, snapshotHash: string, allowed: string[], used: boolean },
  createdAt: string,
  updatedAt: string
}
```

- [ ] **Step 4: 文档检查**

Run:

```bash
git diff --check -- \
  docs/bugs/bug-subagent-dispatch-cannot-request-managed-worktree.md \
  docs/superpowers/plans/2026-08-11-optional-managed-subagent-worktree.md
```

Expected: PASS。

### Task 1: IR 与 Tool Schema 兼容性基础

**Deps:** Task 0

依赖理由：消费 T0 的参数位置和“false 不进 hash”合同。

**WritePaths:**
- `scripts/lib/subagent-dispatch/ir.ts`
- `scripts/lib/subagent-dispatch/prompt.ts`
- `scripts/lib/goal-engine/dispatch-ir.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/goal-engine-dispatch.test.mjs`

**Workflow:** tdd

**Produces:** `ir.execution.worktree?: true`；缺省/false 省略，true 参与 canonical hash。

- [ ] **Step 1: 写 RED**

```js
const absent = compileCodingDispatchIR(contract(), { cwd: "/repo" });
const explicitFalse = compileCodingDispatchIR(contract({ execution: { timeoutMs: 900000, worktree: false } }), { cwd: "/repo" });
const enabled = compileCodingDispatchIR(contract({ execution: { timeoutMs: 900000, worktree: true } }), { cwd: "/repo" });
assert.equal(absent.hash, explicitFalse.hash);
assert.equal(enabled.execution.worktree, true);
assert.notEqual(enabled.hash, absent.hash);
assert.match(renderCodingDispatchPrompt(enabled), /Managed worktree: `true`/);
```

两份 IR 编译器都要拒绝非 boolean 和错误层级字段。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-dispatch-ir.test.mjs test/goal-engine-dispatch.test.mjs
```

Expected: FAIL 于 unknown `execution.worktree`。

- [ ] **Step 3: 最小实现**

`normalizeExecution()` 允许 boolean，并只在 true 时返回 `{ worktree: true }`。Goal Engine 默认仍不生成该字段。Prompt Identity 增加真实布尔值；不得改变其他 section 顺序。

- [ ] **Step 4: 运行 GREEN**

Run 同 Step 2，Expected: PASS，历史 false hash fixture 不变。

### Task 2: Root Broker 通用官方终止证明

**Deps:** Task 0

依赖理由：消费 T0 的 proof 状态和 snapshot 绑定字段。

**WritePaths:**
- `scripts/lib/subagent-dispatch/root-broker-server.ts`
- `scripts/lib/subagent-dispatch/root-broker-registry.ts`
- `scripts/lib/subagent-dispatch/workflow-spawn.ts`
- `test/root-subagent-broker.test.mjs`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/subagent-workflow-spawn.test.mjs`

**Workflow:** tdd

**Produces:**

```ts
registerFacadeRun({ runId, asyncDir, sessionId, pid, agent, kind }): void
inspectFacadeTerminalProof(runId): {
  runId: string,
  state: "observed" | "pending" | "unknown",
  proofHash: string | null,
  proof: object | null,
  conflict: boolean
} | null
```

- [ ] **Step 1: 写 RED**

通过真实 `subagent:async-started` fixture 绑定一个 Generic leaf，随后发官方 `subagent:process-terminal`。断言 Broker 保存 observed proof，但不写 Executor grant；冲突 proof 标记 conflict；错误 run/session/pid/asyncDir 拒绝。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/root-subagent-broker.test.mjs test/root-subagent-broker-protocol.test.mjs test/subagent-workflow-spawn.test.mjs
```

Expected: FAIL，Broker 当前仅跟踪 executor/spark。

- [ ] **Step 3: 最小实现**

`createWorkflowChildStartCollector()` 内部 binding 增加经过校验的 `pid/sessionId/agent`，模型可见 handle 仍只暴露原字段。Broker 将“终止证明跟踪”与“Executor grant”拆开：所有门面 leaf 可登记 proof，只有 executor/spark 进入 `ensureExecutorOwner()`。

- [ ] **Step 4: 运行 GREEN**

Run 同 Step 2，Expected: PASS；现有 Executor shutdown/drain 语义不变。

### Task 3: 受管分配与 Durable Ledger

**Deps:** Task 0

依赖理由：消费 T0 的 ledger exact shape、owner kind 和 action challenge 合同。

**WritePaths:**
- `scripts/lib/subagent-dispatch/workspace-ledger.mjs`
- `test/subagent-workspace-ledger.test.mjs`

**Workflow:** tdd

**Produces:**

```ts
allocateWorkspaceIntent(input): WorkspaceLease
activateWorkspace(lease, managedReceipt): WorkspaceLease
bindWorkspaceRun({ workspaceId, runId, asyncDir }): WorkspaceLease
loadWorkspace({ originRoot, workspaceId }): WorkspaceLease
issueWorkspaceAction({ workspaceId, snapshotHash, allowed }): { actionToken: string }
consumeWorkspaceAction({ workspaceId, actionToken, snapshotHash, disposition }): WorkspaceLease
markWorkspaceState({ workspaceId, state, error? }): WorkspaceLease
```

- [ ] **Step 1: 写 RED**

覆盖 exact schema、目录 `0700`、文件 `0600`、原子写、旧 owner/token、重复 ID、spawn 前后 crash、reload 后恢复、action token 单次消费和快照变化失效。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-workspace-ledger.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小实现**

Ledger 固定在 `<origin>/.state/subagent-dispatch/workspaces/<workspaceId>.json`。只存 token hash 到 actionChallenge；明文 action token 仅返回调用者一次。任何 CAS/shape/mode/identity 不一致 fail closed。

- [ ] **Step 4: 运行 GREEN**

Run 同 Step 2，Expected: PASS。

### Task 4: Workspace 检查、集成与受控释放原语

**Deps:** Task 0

依赖理由：消费 T0 的 disposition 语义；不依赖 Facade。

**WritePaths:**
- `scripts/lib/subagent-dispatch/workspace.mjs`
- `scripts/lib/goal-engine/workspace.mjs`
- `test/subagent-dispatch-workspace.test.mjs`
- `test/goal-engine-workspace.test.mjs`
- `test/worktree-lifecycle-managed.test.mjs`

**Workflow:** tdd

**Produces:**

```ts
createSubagentWorkspace(lease): WorkspaceHandle
inspectSubagentWorkspace(lease): WorkspaceInspection
snapshotSubagentWorkspace({ lease, terminalProof }): WorkspaceSnapshot
integrateSubagentWorkspace({ lease, snapshot, strategy }): WorkspaceDisposition
preserveSubagentWorkspace({ lease, snapshot, reason }): WorkspaceDisposition
discardSubagentWorkspace({ lease, snapshot }): WorkspaceDisposition
```

- [ ] **Step 1: 写创建/脏来源 RED**

使用 temporary arena 真实 Git 仓库。断言 clean attached HEAD 可创建 owner `{ kind: "typed-subagent-workspace", id }`，子目录 cwd 映射正确；普通 staged/unstaged/untracked、detached HEAD、嵌套 Goal worktree、路径/branch/common-dir 漂移全部拒绝；`.state/**`、`.pi-subagents/**` 运行态可忽略。

- [ ] **Step 2: 写 disposition RED**

- coding clean commit + writePaths 内变更可 cherry-pick/merge；成功后 mark reclaimable 并无 force release。
- 越界 path、Generic integrate、dirty、sequencer、active process、origin dirty/advance/conflict、proof conflict 均拒绝并保留。
- discard 不集成，只允许 clean workspace；release 后 branch 仍存在。
- preserve 可容纳 dirty，保留 path/registration/branch。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test test/subagent-dispatch-workspace.test.mjs test/goal-engine-workspace.test.mjs test/worktree-lifecycle-managed.test.mjs
```

Expected: FAIL，subagent workspace 原语不存在。

- [ ] **Step 4: 最小实现**

复用并按需抽取 Goal 的身份、commit、writePaths、origin preflight 与 sequencer recovery；Goal 公开行为保持不变。所有 worktree 变更只调用 managed APIs，禁止复制 raw lifecycle 命令。

- [ ] **Step 5: 运行 GREEN**

Run 同 Step 3，Expected: PASS。

### Task 5: Facade Schema、隔离 cwd 与控制动作接线

**Deps:** Task 1, Task 2, Task 3, Task 4

依赖理由：必须同时消费 IR、proof、ledger 和 workspace 原语，缺一不可验收。

**WritePaths:**
- `scripts/lib/subagent-dispatch/extension.ts`
- `pi/extensions/subagent-runtime.ts`
- `test/subagent-runtime-membrane.test.mjs`
- `test/pi-subagents-compat.test.mjs`

**Workflow:** tdd

- [ ] **Step 1: 写 schema/default RED**

断言 Generic 顶层和 coding execution 暴露 boolean；省略/false 的现有 RPC 深比较不变且没有 ledger/worktree 调用。新增两个 strict action schema，未知字段拒绝。

- [ ] **Step 2: 写 true 路由 RED**

断言：分配发生在 spawn 前；coding 的 child prompt 与 `prepareCodingSpawn()` 使用隔离 cwd；上游 root/leaf 仍精确 `worktree:false`；spawn result 只返回无 owner token 的 workspace ID/handle；Goal 已提供 workspace 时拒绝嵌套分配；spawn/correlation 失败保留已登记资源并报告 workspace ID。

- [ ] **Step 3: 写 status/disposition RED**

`workspace_status` 从 Broker 读取官方 proof，双重检查 ledger 与 Git 后发一次性 token。`workspace_disposition` 使用 token；pending/unknown/conflict proof 只允许 preserve；observed Generic 允许 preserve/discard；observed coding 且 writePaths 合法才允许 integrate。

- [ ] **Step 4: 运行 RED**

Run:

```bash
node --test test/subagent-runtime-membrane.test.mjs test/pi-subagents-compat.test.mjs
```

Expected: FAIL 于 schema/路由/action 缺失。

- [ ] **Step 5: 最小实现**

false 路径不得触发 Git probe。true 路径先分配 workspace，再生成 runtime IR（只替换 cwd，保留原 contractHash），materialize child runtime 后 spawn，并补 durable run binding。两个本地 action 不转发上游 RPC。

- [ ] **Step 6: 运行 GREEN**

Run 同 Step 4，并追加：

```bash
node --test test/subagent-dispatch-ir.test.mjs test/subagent-workflow-spawn.test.mjs test/subagent-title-registry.test.mjs test/subagent-compact-rendering.test.mjs
```

Expected: PASS；内部 workflow 成功通知过滤保持有效。

### Task 6: 真实 Host 闭环集成

**Deps:** Task 5

依赖理由：验收最终 Facade ABI 和所有安全依赖。

**WritePaths:**
- `test/subagent-managed-worktree.integration.mjs`
- `test/pi-subagents-project-workflow.integration.mjs`

**Workflow:** tdd

**Resources:** 每个测试独立 temporary arena Git 仓库；不得操作当前仓库 worktree。

- [ ] **Step 1: 写真实 coding 闭环 RED**

派发 `execution.worktree:true`，确认 child cwd 是 managed path；模拟 clean commit 和官方 process-terminal；status 发 token；integrate 后 origin 出现变更、worktree/私有 ledger 释放、branch 保留。

- [ ] **Step 2: 写 Generic/失败闭环 RED**

Generic integrate 被拒；preserve 保留 dirty；observed + clean 的 discard 释放但不合回；unknown proof、dirty source、spawn crash、reload、action token 重放均不释放。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test test/subagent-managed-worktree.integration.mjs test/pi-subagents-project-workflow.integration.mjs
```

Expected: FAIL 于尚未满足的 Host 闭环。

- [ ] **Step 4: 只修集成缺口并运行 GREEN**

Run 同 Step 3，Expected: PASS；测试前后当前仓库 `git worktree list --porcelain` 不变。

### Task 7: Skill 与用户可见文档

**Deps:** Task 5

依赖理由：Skill 必须引用最终稳定 action 名和参数层级。

**WritePaths:**
- `skill-overrides/subagent-dispatch/SKILL.md`
- `test/subagent-dispatch-skill.test.mjs`
- `docs/bugs/bug-subagent-dispatch-cannot-request-managed-worktree.md`

**Workflow:** tdd

- [ ] **Step 1: 写 Skill RED**

要求 skill 说明：默认 false；仅并发写或明确隔离时 true；Generic 顶层、coding execution；不得把 completion 当终止证明；完成后先 status 再 disposition；Generic 禁止 integrate；继续禁止 raw lifecycle/force/branch cleanup。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-dispatch-skill.test.mjs
```

Expected: FAIL，新合同尚未写入。

- [ ] **Step 3: 最小文案与 GREEN**

更新 coding/generic 示例各展示一次 true，同时保持 skill 的紧凑字数门禁。Run 同 Step 2，Expected: PASS。Bug 文档补全每个任务的 RED/GREEN 证据和当前脏 checkout 限制。

### Task 8: 全量回归与资源零增长终验

**Deps:** Task 6, Task 7

依赖理由：需要真实闭环与最终 Skill 均已完成。

**WritePaths:** none

**Workflow:** existing-tests

- [ ] **Step 1: 连续两轮回归**

```bash
node --test \
  test/subagent-dispatch-ir.test.mjs \
  test/goal-engine-dispatch.test.mjs \
  test/root-subagent-broker.test.mjs \
  test/root-subagent-broker-protocol.test.mjs \
  test/subagent-workflow-spawn.test.mjs \
  test/subagent-workspace-ledger.test.mjs \
  test/subagent-dispatch-workspace.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/subagent-managed-worktree.integration.mjs \
  test/pi-subagents-project-workflow.integration.mjs \
  test/subagent-dispatch-skill.test.mjs \
  test/worktree-lifecycle-managed.test.mjs \
  test/goal-engine-workspace.test.mjs \
  test/pi-subagents-compat.test.mjs
```

Expected: 两轮全部 PASS，无新增 warning/error。

- [ ] **Step 2: Fresh SDK 双 reload**

创建独立 SDK session，连续两次 `session.reload()`；确认最终 schema、workspace actions、内部 workflow 成功通知过滤和 Root Broker proof provider 均存在，extension/runtime errors 为空。

- [ ] **Step 3: 资源零净增长**

前后比较当前仓库只读 inventory：

```bash
git worktree list --porcelain
node scripts/worktree-lifecycle.mjs audit --json
node scripts/doctor.mjs
git diff --check
```

Expected: worktree、manifest、branch、fixture process 均零净增长；现有历史 `.state/worktree-lifecycle/` 不被清理或改写。

## 自审结果

- **规格覆盖**：默认 false、主 Agent 显式选择、Generic/Coding 参数位置、项目受管创建、可信终止证明、owner ledger、writePaths、三类 disposition 和真实 Host 闭环均已覆盖。
- **占位符检查**：无实现占位；公开字段、私有 schema、函数签名、命令和失败边界已明确。
- **类型一致性**：统一使用 `workspace_status`、`workspace_disposition`、`workspace_id`、`action_token`；Generic 顶层 worktree，Coding 仅 execution.worktree。
- **关键路径**：T0 → 并行 T1/T2/T3/T4 → T5 → 并行 T6/T7 → T8；依赖均绑定实际产物。
- **残余约束**：当前 checkout 有普通未提交改动，真实 `worktree:true` 会按设计返回 `WORKTREE_SOURCE_DIRTY`；实施和验收只能使用临时干净仓库，直到当前改动被另行处置。

## 执行结果（2026-08-11）

Task 0–8 已执行。最终两轮回归各 **268/268**；真实 Pi 0.84.1 Host worktree 闭环通过；Fresh SDK 连续两次 `session.reload()` 后 schema、workspace actions、通知渲染器与 Root Broker proof provider 均存在，extension error 为 0。当前仓库 worktree、branch、lifecycle manifest 哈希与基线一致，未新增 staged 文件，也未清理既有历史状态。
