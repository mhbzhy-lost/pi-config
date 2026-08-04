# Goal Engine 历史派发事故恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-dispatch` to implement this plan task-by-task in isolated worktrees. 每个逻辑变更 Task 必须先加载 `test-driven-development`，严格完成 RED→GREEN；Task 6 修改 Skill 时还必须加载 `writing-skills`。

**Goal:** 阻止历史 Goal 绕过派发门禁，要求 succeeded workspace 具备可集成 commit，并在不编辑事件文件、不手工清理 worktree 的前提下识别和处置孤儿 Executor workspace，最终恢复 TokenRec task1 canary。

**Architecture:** 将安全责任分成四层：dispatch handler 在分配前复验真实仓库与完整 task contract；派生 IR 和 settle handler 共同保证 clean committed result；workspace inventory 将 projection 与可推导 lease/worktree/branch 做只读一致性检查；新 v2 recovery event 让现有 `goal_integrate(discard|preserve)` 可审计地接管孤儿资源。历史 v1/v2 JSONL 仍可只读 replay，新 mutation 和资源副作用继续 fail-closed。

**Tech Stack:** Node.js ESM、`node:test`、真实临时 Git repository/worktree、Pi `ToolDefinition.execute` Host harness、Goal Engine v2 JSONL reducer/store、Markdown Skill。

## Global Constraints

- 保持 Goal Engine typed tools **exact seven**，不得新增写入 CLI、额外 tool 或自定义 ABI。
- 新 mutation 默认 strict；`{ replay: true }` 仅用于已持久化 JSONL，纯 v1 和门禁前 v2 必须继续可读。
- 任何失败门禁必须在 message 中包含稳定 code、observed、remediation、`stateChanged=false` 与可执行 `requiredNextAction`；失败必须保持 events、projection、registry 和 workspace 资源零副作用。
- 不直接编辑 `events.jsonl`、`projection.json`、`registry.json`，不手工删除 Goal worktree/lease/branch，不以 re-init 代替恢复。
- Executor acceptance commands 必须在 Executor worktree 中运行；禁止硬编码 origin absolute `cd`。
- 所有实现 Task 使用独立 worktree；主 agent 仅接收通过 RED→GREEN、diff 审查和验收命令的累计 patch。
- TokenRec 的 `/Users/mhbzhy/tokenrec/.state/goal-engine/**` 在 Task 1–6 中只读；Task 7 只允许真实 typed tools 修改状态。
- 已固定事故证据 `refs/recovery/goal-engine/tokenrec-20260805-state-v5 → f955e35ea43d3c91e045ef57724f84208bc698a5`；不得删除或移动该 ref。
- 绝对禁止运行已消费的一次性 Plan Harness：`npm run test:plan-harness`、`test/plan-flat-runtime-harness.integration.mjs`、`test/plan-amendment-harness.integration.mjs`。
- 不 stash/reset/clean 或覆盖 `pi/settings.json`、`skill-overrides/aliyun-beijing-server/` 等用户工作树内容。

---

### Task 1: 历史 Goal dispatch 前置安全门禁

**Files:**
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Test: `test/goal-engine-extension.test.mjs`
- Test: `test/goal-engine-runtime.integration.mjs`

**Interfaces:**
- Consumes: `validateTaskDefinitions(taskIds, taskDefs, { cwd, realpathCwd })`、`assertPendingTaskContractsCompile(projection, cwd)`、现有 Git preflight。
- Produces: `assertRepositoryPreflight(cwd, { operation })`；`validateProjectionForDispatch(projection, cwd)`；稳定错误 `STATE_TRACKED`、`STATE_NOT_IGNORED`、`INVALID_TASK_CONTRACT`。

- [ ] **Step 1: 写历史绝对 command 的失败测试**

在 `test/goal-engine-extension.test.mjs` 使用现有 historical-v2 fixture：`goal_status` 仍成功，但 `goal_dispatch` 必须在分配 workspace 前拒绝。

```js
await assert.rejects(
  () => invoke(pi, "goal_dispatch", { task_id: "t1" }),
  (error) => error.code === "INVALID_TASK_CONTRACT"
    && /stateChanged=false/.test(error.message)
    && /goal_amend/.test(error.message),
);
assert.equal(readGoalEvents(cwd, goalId).length, 1);
assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
  ...workspaceState(cwd, goalId, "t1"),
  workspaceExists: false,
  leaseExists: false,
  branchExists: false,
});
```

- [ ] **Step 2: 写 tracked state 与安全历史 Goal 的边界测试**

构造真实 Git fixture：将 `.state/goal-engine/**` 提交到 index 后，历史 task 即使命令为 `true`，dispatch 也必须返回 `STATE_TRACKED` 且零副作用；取消跟踪并配置 ignore 后，同一安全历史 Goal 可正常 dispatch。增加真实 Pi Host `ToolDefinition.execute` 用例，证明错误来自当前 Host schema/handler，而不是内部函数调用。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test --test-name-pattern='historical.*dispatch|tracked state.*dispatch' test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
```

Expected: FAIL；当前版本会创建 workspace，或只返回原始 `Executor workspace already exists`/放行绝对 command。

- [ ] **Step 4: 提取共享 repository preflight 并在 dispatch 使用**

最小实现保持 init 文案兼容，同时让 dispatch 在任何资源分配前执行：

```js
function assertRepositoryPreflight(cwd, { operation }) {
  // physical repo top-level、valid attached HEAD、STATE_ROOT_REL untracked+ignored
  // remediation 中使用 operation，例如 retry goal_dispatch。
}

function validateProjectionForDispatch(projection, cwd) {
  validateTaskDefinitions(
    [...projection.tasks.keys()],
    taskDefsFromProjection(projection),
    { cwd, realpathCwd: realpathSync(cwd) },
  );
  assertPendingTaskContractsCompile(projection, cwd);
}
```

`goal_dispatch` 顺序固定为：resolve/load → runnable/workspace projection gate → `assertRepositoryPreflight` → `validateProjectionForDispatch` → orphan gate（Task 4 接入）→ `gitHead`/allocate。把 validator 异常包装为 `INVALID_TASK_CONTRACT`，`requiredNextAction` 指向一次完整 `goal_amend`，不要把 replay compatibility 改回 strict。

- [ ] **Step 5: 运行 GREEN 与邻近回归**

Run:

```bash
node --test test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
node --test test/goal-engine-events.test.mjs test/goal-engine-dispatch.test.mjs
```

Expected: 全部 PASS；历史 status replay 测试继续通过。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/goal-engine/extension.mjs test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
git commit -m "fix(goal-engine): 阻断不安全历史派发"
```

---

### Task 2: 允许安全修订 pending task 的 workflow

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Modify: `scripts/lib/goal-engine/events.mjs`
- Test: `test/goal-engine-events.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`
- Test: `test/goal-engine-runtime.integration.mjs`

**Interfaces:**
- Consumes: v2 `goal.amended.updateTasks`、`assertTaskUpdatable()`、完整 candidate validation。
- Produces: `update_tasks.<taskId>.workflow?: "tdd" | "existing-tests" | "docs-only"`；历史 replay 不变。

- [ ] **Step 1: 写 schema、reducer 和冻结边界 RED 测试**

```js
const amended = await invoke(pi, "goal_amend", {
  reason: "把历史骨架任务改为先测试后实现",
  update_tasks: { t1: { workflow: "tdd" } },
});
assert.equal(JSON.parse(amended).tasks.t1.workflow, "tdd");
```

同时证明 active workspace、succeeded/accepted task 不能改 workflow；非法值在真实 Host schema 层拒绝；纯 v1/v2 replay 不被重写。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test --test-name-pattern='workflow.*amend|amend.*workflow' test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
```

Expected: FAIL；当前 schema 不暴露 workflow，reducer 也忽略它。

- [ ] **Step 3: 实现最小 workflow update**

在 `goal_amend.update_tasks.additionalProperties.properties` 增加 enum，并在 reducer candidate 上应用：

```js
if (updates.workflow !== undefined) task.workflow = updates.workflow;
```

不得放宽 `assertTaskUpdatable`；应用后仍由 `validateTaskDefinitions()` 和 `assertPendingTaskContractsCompile()` 验证完整 candidate。

- [ ] **Step 4: 运行 GREEN**

Run:

```bash
node --test test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/goal-engine/extension.mjs scripts/lib/goal-engine/events.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
git commit -m "feat(goal-engine): 支持修订任务工作流"
```

---

### Task 3: Executor clean commit 协议与 settle 门禁

**Deps:** Task 2

**Files:**
- Modify: `scripts/lib/goal-engine/dispatch.mjs`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Test: `test/goal-engine-dispatch.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Consumes: `compileTaskContract()`、`resolveLease()`、`inspectExecutorWorkspace()`、`assertWorkspaceChangesWithinPaths()`。
- Produces: IR mandatory requirement `Before reporting completed, create at least one clean commit...`；settle errors `EXECUTOR_COMMIT_REQUIRED`、`EXECUTOR_WORKSPACE_DIRTY`、`EXECUTOR_WRITE_PATH_VIOLATION`。

- [ ] **Step 1: 写 IR RED 测试**

```js
assert.ok(contract.input.requirements.includes(
  "Before reporting completed, create at least one clean commit containing only approved writePaths; if no commit is warranted, return NEEDS_CONTEXT instead of completed.",
));
```

验证新增 mandatory requirement 计入共享 32-item/4096-byte contract 预算，超限 Goal 在 init/amend/dispatch 一致拒绝。

- [ ] **Step 2: 写 succeeded settle RED matrix**

覆盖：无 commit、staged/unstaged 文件、越界 commit、clean 授权 commit、仅 `.pi-subagents/**` runtime artifact。前三种必须拒绝且 events/projection/registry 字节不变；clean commit 成功；`failed`/`blocked` settle 仍可保留现场。

```js
await assert.rejects(
  () => invoke(pi, "goal_settle", succeededParams),
  (error) => error.code === "EXECUTOR_COMMIT_REQUIRED"
    && /stateChanged=false/.test(error.message),
);
assert.deepEqual(snapshotState(cwd, goalId), before);
```

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test --test-name-pattern='commit requirement|settle.*commit|settle.*dirty|settle.*writePaths' test/goal-engine-dispatch.test.mjs test/goal-engine-extension.test.mjs
```

Expected: FAIL；当前 contract 无 commit 要求，settle 会持久化 succeeded。

- [ ] **Step 4: 实现 contract 与 settle preflight**

`goal_settle` 仅对 `outcome === "succeeded"` 在 `makeEvent/appendEvent` 前执行：

```js
const lease = resolveLease(task, goalId, params.task_id, cwd, root);
const inspection = inspectExecutorWorkspace(lease);
if (!inspection.hasCommits) throw mutationError("EXECUTOR_COMMIT_REQUIRED", ...);
if (!inspection.clean) throw mutationError("EXECUTOR_WORKSPACE_DIRTY", ...);
try { assertWorkspaceChangesWithinPaths(inspection, task.writePaths); }
catch (cause) { throw mutationError("EXECUTOR_WRITE_PATH_VIOLATION", cause.message, ...); }
```

错误 remediation 必须明确“让同一 Executor worktree commit/clean 后重试 `goal_settle`”，不得建议 raw Git 操作 origin 或伪造 evidence。

- [ ] **Step 5: 更新旧 no-op 测试并运行 GREEN**

将“settle succeeded 后 integrate 才拒绝 no-op”的旧断言改为 settle 即拒绝；随后使用 `goal_settle(failed)` + `goal_integrate(discard)` 验证仍可释放。

Run:

```bash
node --test test/goal-engine-dispatch.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-workspace.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/goal-engine/dispatch.mjs scripts/lib/goal-engine/extension.mjs test/goal-engine-dispatch.test.mjs test/goal-engine-extension.test.mjs
git commit -m "fix(goal-engine): 要求提交后再结算成功"
```

---

### Task 4: Projection 与 workspace orphan 只读一致性检查

**Deps:** Task 3

**Files:**
- Modify: `scripts/lib/goal-engine/workspace.mjs`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Modify: `scripts/lib/goal-engine/graph.mjs`
- Test: `test/goal-engine-workspace.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`
- Test: `test/goal-engine-graph.test.mjs`

**Interfaces:**
- Produces: `inspectOrphanedExecutorWorkspace({ goalId, taskId, attempt, originRoot, stateRoot }) -> { kind: "none" | "verified" | "unverified", ... }`。
- Produces: status blocking code `ORPHANED_EXECUTOR_WORKSPACE` 或 `ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED`；verified orphan 的 human decision 仅允许 `goal_integrate(discard|preserve)`。

- [ ] **Step 1: 写真实 Git rollback fixture**

先用 typed handler 正常 dispatch，保存只含 `goal.created` 的 fixture bytes，再在测试隔离目录回写 fixture 以模拟外部事件回退但保留 lease/worktree/branch。此处直接写 fixture 只允许在临时测试仓库，不得用于 TokenRec。

- [ ] **Step 2: 写 status/dispatch RED 测试**

`goal_status` 必须：

```js
assert.deepEqual(status.runnable, []);
assert.equal(status.tasks.t1.requiredNextAction, null);
assert.deepEqual(status.tasks.t1.blockingReason, {
  code: "ORPHANED_EXECUTOR_WORKSPACE",
  requiresHumanDecision: true,
  choices: [
    { tool: "goal_integrate", params: { task_id: "t1", action: "discard" } },
    { tool: "goal_integrate", params: { task_id: "t1", action: "preserve" } },
  ],
});
```

`goal_dispatch` 必须返回同一稳定 code 且不创建 attempt 2。若只有 path/branch 而无有效 lease，status 必须标记 identity unverified，且不提供 destructive machine action。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test --test-name-pattern='orphan|event rollback' test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-graph.test.mjs
```

Expected: FAIL；当前 status 把 task 标为 runnable，dispatch 只报 raw `already exists`。

- [ ] **Step 4: 实现派生路径、exact identity 与 status overlay**

只检查 `attempt = task.attempts + 1` 的可推导 path/lease/branch，不做任意目录扫描。verified 要求 lease 的 goal/task/attempt、real origin/state roots、path、branch、baseCommit、originRef 全匹配，且真实 Git worktree branch/HEAD 可读取；任何部分资源或 mismatch 返回 unverified，绝不自动删除。

`goal_status` 在 projection response 上叠加 blocking decision，不修改 projection；需要人类选择时 `requiredNextAction` 必须为 `null`，两个完整可执行选项放在 `blockingReason.choices`，禁止伪造唯一机器决策。`goal_dispatch` 在 allocate 前复用同一 inventory。status 读取错误应进入结构化 blockingReason，而不是吞成普通 runnable。

- [ ] **Step 5: 运行 GREEN 和 restart matrix**

Run:

```bash
node --test test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-graph.test.mjs
```

Expected: 全部 PASS；正常 pending/dispatched/restarted workspace machine action 不变。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/goal-engine/workspace.mjs scripts/lib/goal-engine/extension.mjs scripts/lib/goal-engine/graph.mjs test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-graph.test.mjs
git commit -m "feat(goal-engine): 识别孤儿执行工作区"
```

---

### Task 5: 用现有 goal_integrate typed action 恢复孤儿 workspace

**Deps:** Task 4

**Files:**
- Modify: `scripts/lib/goal-engine/events.mjs`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Modify: `scripts/lib/goal-engine/workspace.mjs`
- Test: `test/goal-engine-events.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`
- Test: `test/goal-engine-workspace.test.mjs`

**Interfaces:**
- Produces: strict v2 event `task.workspace_orphan_recovered`，data 为 `{ taskId, attempt, workspace, executorHead, reason }`。
- Produces: strict v2 event `task.workspace_preservation_released`，data 为 `{ taskId, attempt, executorHead, released }`。
- Produces: `goal_integrate(discard|preserve)` 对 verified orphan 的接管；`goal_integrate(integrate)` 对 orphan 永远拒绝；preserved workspace 可由后续显式 `goal_integrate(discard)` 释放。

- [ ] **Step 1: 写 reducer RED 测试**

合法 recovery event 只能用于 active Goal 中 pending、无未释放 projection workspace 的下一 attempt；应用后 task 保持 pending、`attempts += 1`、`lastSettledOutcome = "failed"`，并得到 `phase="active"` workspace。覆盖 attempt、path、branch、baseCommit、originRef、executorHead、重复 recovery、terminal lifecycle 和 v1 schema mismatch。

```js
assert.equal(recoveredTask.status, "pending");
assert.equal(recoveredTask.lastSettledOutcome, "failed");
assert.equal(recoveredTask.workspace.phase, "active");
assert.equal(recoveredTask.workspace.recovery, "orphaned");
```

- [ ] **Step 2: 写 typed recovery RED matrix**

覆盖：

1. verified orphan + `discard`：先持久 recovery event，再走 started→applied→disposed，最后 workspace/lease/branch 均不存在，task 可 attempt 2 dispatch。
2. verified orphan + `preserve`：资源和 lease 保留，`released=false`，task 不 runnable；status 指向等待人类后续显式 discard，而不是错误建议当前 reducer 会拒绝的 amend。
3. disposed preserved + `discard`：先清理并验证 workspace/lease/branch 已释放，再追加 `task.workspace_preservation_released(released=true)`；append durable-then-throw 可幂等恢复，task 随后可 amend/redispatch。
4. orphan + `integrate`：`ORPHANED_WORKSPACE_NOT_SETTLED`、零状态副作用。
5. lease tamper、origin ref mismatch、unverified partial resources：fail-closed、零副作用。
6. origin HEAD 在同一 ref 上从 lease base 前进：discard/preserve 可用，但不得 integrate。
7. recovery event durable-then-throw：reload/status 后重试 disposition，不重复 recovery event。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test --test-name-pattern='orphan.*recover|orphan.*discard|orphan.*preserve' test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-workspace.test.mjs
```

Expected: FAIL；当前事件类型不存在，goal_integrate 要求 projection workspace。

- [ ] **Step 4: 实现 recovery event 与 goal_integrate 接管**

当 `task.workspace` 缺失且 inventory verified 时：

```js
if (action === "integrate") throw mutationError("ORPHANED_WORKSPACE_NOT_SETTLED", ...);
projection = appendEventFn(root, makeEvent("task.workspace_orphan_recovered", {
  taskId,
  attempt: orphan.lease.attempt,
  workspace: snapshotFromLease(orphan.lease),
  executorHead: orphan.inspection.headCommit,
  reason: "projection missing workspace while exact lease resources remain",
}, goalId), projection.version);
```

append 成功后重新从 projection 解析 exact lease，再复用既有 disposition 三阶段。不得跳过 `workspaceDispositionStarted/Applied/Disposed`，不得先删除资源再持久 recovery fact。对已 disposed+preserved 的 workspace，第二次显式 discard 必须先完成并验证资源清理，再记录 `task.workspace_preservation_released`；该新事件保留原 `disposition="preserved"` 历史事实，只增加 `preservedResourcesReleased=true`，`workspaceReleasedForRetry()` 和 `taskActionState()` 据此允许 amend/redispatch。更新 `goal_integrate` description，明确 orphan 只能 preserve/discard，仍保持 220 字符以内和 exact-seven ABI。

- [ ] **Step 5: 运行 GREEN、事件差分与压力重试**

Run:

```bash
node --test test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-workspace.test.mjs
for i in 1 2 3; do node --test --test-name-pattern='orphan.*durable|orphan.*discard' test/goal-engine-extension.test.mjs || exit 1; done
```

Expected: 全部 PASS；每次 fixture 的 mutation oracle 精确匹配事件数量和资源 disposition。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/goal-engine/events.mjs scripts/lib/goal-engine/extension.mjs scripts/lib/goal-engine/workspace.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-workspace.test.mjs
git commit -m "feat(goal-engine): 可审计处置孤儿工作区"
```

---

### Task 6: Skill 指导、完整验证与独立审查

**Deps:** Task 5

**Files:**
- Modify: `skill-overrides/using-goal-engine/SKILL.md`
- Modify: `test/using-goal-engine-skill.test.mjs`
- Modify: `scripts/doctor.mjs`（仅当现有 exact contract 需要同步；不得增加 tool）
- Create: `docs/summaries/2026-08-05-goal-engine-legacy-dispatch-recovery-verification.md`

**Interfaces:**
- Consumes: Task 1–5 的错误码和 machine actions。
- Produces: agent 指导：绝不把 `.state` 加入 commit，不对 `.state` 执行 reset/restore，不手工清 lease/worktree；orphan 只能按 status 的 human decision preserve/discard。

- [ ] **Step 1: 加载 writing-skills 并写 Skill RED 契约**

测试必须先断言当前 Skill 缺少以下明确文本语义：

```js
assert.match(skill, /不(?:提交|commit).*\.state/);
assert.match(skill, /不.*(?:reset|restore).*\.state/);
assert.match(skill, /ORPHANED_EXECUTOR_WORKSPACE/);
assert.match(skill, /goal_integrate.*(?:discard|preserve)/);
```

使用 fresh agent pressure scenario：给出 `Origin must be clean` 和 `Executor workspace already exists`，期望 agent 停止并调用 status，而不是 raw Git 修复。

- [ ] **Step 2: 运行 RED，再写最小 Skill 文案**

Run:

```bash
node --test test/using-goal-engine-skill.test.mjs
```

Expected: 新断言 FAIL。随后只增加与生产行为一致的禁止项和 orphan recovery 顺序，不发明参数或额外工具。

- [ ] **Step 3: 运行 Skill GREEN 和真实 Pi discovery**

Run:

```bash
node --test test/using-goal-engine-skill.test.mjs test/skill-list.test.mjs test/skill-whitelist-extension.test.mjs
npm run doctor
```

Expected: 全部 PASS；真实 Pi loader 仍发现 Skill。

- [ ] **Step 4: 运行冻结候选目标回归**

Run:

```bash
node --test test/goal-engine-audit.test.mjs test/goal-engine-dispatch.test.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-graph.test.mjs test/goal-engine-runtime.integration.mjs test/goal-engine-store-concurrency.test.mjs test/goal-engine-workspace.test.mjs
npm run doctor
git diff --check
```

Expected: 全部 PASS。再运行 `npm test`，对已知六项基线失败逐项比对；不得把既有失败写成 GREEN，也不得运行禁用的一次性 Harness。

- [ ] **Step 5: 独立 review**

加载 `external-llm-review`，审查 cumulative diff，重点检查：legacy dispatch 零副作用、settle commit gate、orphan identity、record-before-side-effect、preserve/discard 重试、v1/v2 replay。Reviewer timeout 不算批准；所有 Critical/Important 必须闭合后重新跑目标回归。

- [ ] **Step 6: 写中文验证摘要并提交**

摘要记录各测试命令、pass/fail 数、已知基线失败、review artifact、exact-seven ABI、禁止 Harness 未运行。

```bash
git add skill-overrides/using-goal-engine/SKILL.md test/using-goal-engine-skill.test.mjs scripts/doctor.mjs docs/summaries/2026-08-05-goal-engine-legacy-dispatch-recovery-verification.md
git commit -m "docs(goal-engine): 补充孤儿工作区恢复指导"
```

---

### Task 7: 部署并恢复 TokenRec task1 canary

**Deps:** Task 6

**Files:**
- Create: `docs/summaries/2026-08-05-tokenrec-goal-engine-incident-recovery.md`
- External Git refs only: `/Users/mhbzhy/tokenrec/.git/refs/recovery/goal-engine/**`
- External typed state mutation only: `/Users/mhbzhy/tokenrec/.state/goal-engine/**`
- External product changes through Goal lifecycle only: `/Users/mhbzhy/tokenrec/{Package.swift,.gitignore,Sources/TokenRec/**,Tests/TokenRecTests/**}`

**Interfaces:**
- Consumes: deployed exact-seven ToolDefinitions；Task 5 orphan recovery；Task 2 workflow amendment。
- Produces: TokenRec orphan attempt 1 被审计 discard、task1 contract 安全修订、attempt 2 完成完整 typed lifecycle。

- [ ] **Step 1: 请求主分支部署授权并冲突感知集成**

确认 `pi-config` cumulative candidate 的目标测试、Doctor、review 均通过；再次请求用户授权后，才把候选合入实际 `main`。不得 stash/reset/clean，不覆盖 `pi/settings.json` 或 `skill-overrides/aliyun-beijing-server/`。部署后执行 `/reload`，并用真实 Pi Host 当前 `ToolDefinition` 验证 exact seven。

- [ ] **Step 2: 在任何 destructive action 前固定 Executor commit**

再次请求用户明确授权，然后执行：

```bash
ROOT=/Users/mhbzhy/tokenrec
OID=8907c529315ca6180624e30ecd5653961878816d
REF=refs/recovery/goal-engine/tokenrec-20260805-task1-executor
ZERO=0000000000000000000000000000000000000000
/usr/bin/env -C "$ROOT" git update-ref -m 'pin orphan task1 executor result' "$REF" "$OID" "$ZERO"
/usr/bin/env -C "$ROOT" git rev-parse refs/recovery/goal-engine/tokenrec-20260805-state-v5
/usr/bin/env -C "$ROOT" git rev-parse "$REF"
/usr/bin/env -C "$ROOT" git status --short
```

Expected: 两个 recovery refs 分别解析到 `f955e35...` 和 `8907c529...`；TokenRec 工作区仍干净。

- [ ] **Step 3: 由 status 驱动 typed orphan discard**

通过真实 Pi typed tool 调用 `goal_status`；期望 task1 不在 runnable，blocking code 为 `ORPHANED_EXECUTOR_WORKSPACE`。将 status 和三个资源路径展示给用户确认，再调用：

```text
goal_integrate(goal_id="tokenrec-macos-token-pi-pi-subagents-.app", task_id="task1-skeleton", action="discard")
```

禁止用 shell 调用内部 handler。随后重新 `goal_status`，并只读验证 attempt-1 worktree、lease、branch 已释放；事件日志新增 orphan recovery + 三阶段 disposition，原始 `goal.created` 保留。

- [ ] **Step 4: 一次 goal_amend 修正完整历史 contract**

由于 handler 校验完整 candidate，必须在一次 typed mutation 中修正全部绝对 commands，并把 task1 改为 TDD：

```json
{
  "goal_id": "tokenrec-macos-token-pi-pi-subagents-.app",
  "reason": "修复历史 acceptance 绝对路径，并把骨架任务改为可验证的 TDD 工作流",
  "update_tasks": {
    "task1-skeleton": {
      "description": "SPM 项目骨架（TDD）：先写 AppSkeletonTests，再实现 Package.swift、MenuBarExtra 空壳、ContentView 和 AppDelegate accessory 模式",
      "writePaths": [
        "Package.swift",
        ".gitignore",
        "Sources/TokenRec/TokenRecApp.swift",
        "Sources/TokenRec/ContentView.swift",
        "Tests/TokenRecTests/AppSkeletonTests.swift"
      ],
      "acceptance": {
        "criteria": [
          "swift test --filter AppSkeletonTests 通过",
          "swift build 成功产出 .build/debug/TokenRec",
          "启动后进程存活"
        ],
        "commands": [
          "swift test --filter AppSkeletonTests",
          "swift build",
          "set -eu; .build/debug/TokenRec & pid=$!; trap 'kill $pid 2>/dev/null || true' EXIT; sleep 3; kill -0 $pid"
        ]
      },
      "workflow": "tdd"
    },
    "task2-parser": {
      "acceptance": {
        "criteria": [
          "swift test --filter UsageParserTests 9 个用例全绿",
          "真实数据兼容：指定 session 与 subagent transcript 冒烟解析非空"
        ],
        "commands": ["swift test --filter UsageParserTests"]
      }
    },
    "task3-aggregator": {
      "acceptance": {
        "criteria": ["swift test --filter UsageAggregatorTests 5 个用例全绿"],
        "commands": ["swift test --filter UsageAggregatorTests"]
      }
    },
    "task4-scanner": {
      "acceptance": {
        "criteria": [
          "swift test --filter SessionScannerTests 6 个用例全绿",
          "swift test 全部通过（20 个用例）"
        ],
        "commands": ["swift test --filter SessionScannerTests", "swift test"]
      }
    },
    "task5-ui": {
      "acceptance": {
        "criteria": [
          "swift build 成功",
          "swift test 20 个用例全绿",
          ".build/debug/TokenRec 启动后进程存活"
        ],
        "commands": [
          "swift build && swift test",
          "set -eu; .build/debug/TokenRec & pid=$!; trap 'kill $pid 2>/dev/null || true' EXIT; sleep 4; kill -0 $pid"
        ]
      }
    },
    "task6-packaging": {
      "acceptance": {
        "criteria": [
          "scripts/build-app.sh 执行成功产出 dist/TokenRec.app",
          "$HOME/Applications/TokenRec.app 存在",
          "README.md 含构建安装说明"
        ],
        "commands": [
          "chmod +x scripts/build-app.sh && ./scripts/build-app.sh",
          "test -d dist/TokenRec.app && test -d \"$HOME/Applications/TokenRec.app\" && echo OK"
        ]
      }
    }
  }
}
```

mutation 后重新 `goal_status`；期望 task1 runnable、attempts=1、历史 discarded workspace released=true，所有 command 均无 origin absolute `cd`。

- [ ] **Step 5: 重派 attempt 2 并完成 task1 typed lifecycle**

严格执行：

```text
status → goal_dispatch(task1-skeleton) → 原样派发 dispatch-ir.v1
→ Executor 在 attempt-2 worktree 中 RED→GREEN、运行三条 acceptance、形成 clean commit
→ status → goal_settle(succeeded, real artifact) → status
→ goal_integrate(integrate, cherry-pick) → status
→ 当前 TokenRec workspace 运行 swift test --filter AppSkeletonTests && swift build
→ goal_accept(task1-skeleton) → status
```

settle 前只读核对 artifact、session、worktree HEAD、changed files 和 clean status；wrapper 的 failed/completed 文案都不是状态权威。任何 error 立即停止并保留现场，不运行 raw Git 恢复。

- [ ] **Step 6: 记录恢复证据**

在中文摘要中记录：部署 commit、两个 recovery refs、discard 事件类型与版本、attempt-2 executor commit、acceptance 输出、integrated origin HEAD、最终 status、TokenRec 主工作区 status。不得复制思维链、凭据或未脱敏 session 内容。

```bash
git add docs/summaries/2026-08-05-tokenrec-goal-engine-incident-recovery.md
git commit -m "docs(goal-engine): 记录 TokenRec 事故恢复"
```

---

## Self-Review

- **Spec coverage**：Task 1 覆盖 legacy dispatch/STATE_TRACKED/absolute command；Task 2 让历史 workflow 可安全修订；Task 3 覆盖 commit/settle；Task 4–5 覆盖 orphan detect + typed disposition；Task 6 覆盖 Skill、全回归与 review；Task 7 覆盖证据固定、部署和真实 canary。
- **占位检查**：未留下待补内容；每个 mutation、错误码、测试命令和 live amendment payload 均已给出。
- **Type consistency**：orphan inventory 只返回 none/verified/unverified；recovery event 字段与 goal_integrate 使用一致；typed tools 始终 exact seven。
- **安全复核**：Task 7 的 main 部署、executor ref 固定和 destructive discard 均设独立人工确认；没有直接状态文件写入或手工 worktree 清理。
