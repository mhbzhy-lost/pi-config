# Goal Engine 事件、恢复与审计安全修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 amendment 破坏证明、dispatch/accept 确认丢失、机器动作死路、v1 replay 回归、跨进程事件竞争和 external evidence 假阳性。

**Architecture:** 所有安全不变量落在 event reducer，Extension 只负责把副作用结果转成可幂等重试的命令。Store 用 state-root 级排他 writer lock 把 version check、event append、projection 和 registry 更新组成单写者临界区；机器动作完全由 projection 推导；external evidence 只接受显式 `source=external` 且类型为 `external_review`。

**Tech Stack:** Node.js ESM、同步文件系统、JSONL event sourcing、`node:test`、真实临时 Git 仓库、Pi Extension ToolDefinition ABI。

## Global Constraints

- 实现基线固定为干净分支 `agent/goal-engine-hardening` 的累计提交 `f264253bf15499197698a253ced9e1f5eb3af1b6`；禁止修改、stash、reset 或自动合并脏 `main`。
- 每个 Task 使用独立 worktree；按 `Deps` 构建 DAG，无依赖任务可并行，但修改同一文件的任务必须按依赖顺序集成。
- 每个 bug 在 RED 前先创建中文六要素根因文档；不得把本计划本身当作 bug 文档。
- 严格 TDD：每个生产行为必须先有能在 `f264253` 上稳定失败的测试；测试不得只 grep 源码或只断言 mock 调用。
- 保留 exact seven Goal Engine tools 和真实 Pi `execute(toolCallId, params, signal, onUpdate, ctx)` ABI。
- 保留 v1 纯历史流可重放与 v2 单向升级；不得通过 schema downgrade 绕过 workspace disposition。
- 默认支持单机多 Pi 进程；同一 state root 的 writer 必须串行。网络文件系统和多主机共享目录不在本轮支持范围。
- 跨仓 Executor 入口由既有 `2026-08-02-plan-runner-production-convergence.md` Task 3/5/6 修复；本计划只在 Task 7 消费其冻结提交，不重复修改 owner runtime。

---

### Task 1: 冻结已执行 Task 合同并保护 active workspace

**Files:**
- Create: `docs/bugs/bug-goal-engine-amend-mutates-accepted-or-active-task.md`
- Modify: `scripts/lib/goal-engine/events.mjs`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Test: `test/goal-engine-events.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Consumes: `goal.amended` 的 `addTasks/removeTasks/updateTasks`。
- Produces: reducer 级 `assertTaskAmendable(task, operation)`；remove 只允许未持有资源的 pending task，update 只允许 pending 且无 active/preserved/integrated workspace 的 task。

- [ ] **Step 1: 写根因文档**

创建 `docs/bugs/bug-goal-engine-amend-mutates-accepted-or-active-task.md`，记录两个已复现行为：accepted task 的 acceptance 可改成 `false` 但仍 accepted；active workspace 所属 task 可删除并从 projection 丢失资源身份。根因明确为 `goalAmended()` 仅在 remove 时检查 accepted，update 无状态门禁，remove 无 workspace 门禁。

- [ ] **Step 2: 写 reducer RED matrix**

在 `test/goal-engine-events.test.mjs` 增加表驱动测试：

```js
for (const updates of [
  { description: "changed" },
  { deps: [] },
  { writePaths: ["other.ts"] },
  { acceptance: { criteria: ["changed"], commands: ["false"] } },
]) {
  assert.throws(() => applyEvent(acceptedProjection, v2Event("goal.amended", {
    reason: "Do not rewrite accepted task proof",
    updateTasks: { t1: updates },
  }, goalId)), /accepted|immutable|amend/i);
}
```

另覆盖：

- dispatched + active workspace：remove/update 均拒绝；
- succeeded + active workspace：remove/update 均拒绝；
- blocked + preserved workspace：remove/update 均拒绝；
- failed 后 pending + active workspace：remove/update 均拒绝；
- pending + disposed/discarded/released workspace：允许 update 或 remove；
- pending never-dispatched：允许 update；
- 拒绝后 projection version、task map、acceptance、workspace 精确不变。

- [ ] **Step 3: 运行 RED**

```bash
node --test --test-name-pattern='amend.*accepted|amend.*workspace|amend.*executed' test/goal-engine-events.test.mjs
```

Expected: accepted update 和 active workspace remove 被当前 reducer 接受，断言失败。

- [ ] **Step 4: 在 reducer 实现统一门禁**

规则固定为：

```js
function workspaceReleasedForRetry(task) {
  const value = task.workspace;
  return !value || (value.phase === "disposed" && value.disposition === "discarded" && value.released === true);
}

function assertTaskUpdatable(task, taskId) {
  if (task.status !== "pending") throw new Error(`cannot update non-pending task: ${taskId} (${task.status})`);
  if (!workspaceReleasedForRetry(task)) throw new Error(`cannot update task with unreleased workspace: ${taskId}`);
}

function assertTaskRemovable(task, taskId) {
  if (task.status !== "pending") throw new Error(`cannot remove non-pending task: ${taskId} (${task.status})`);
  if (!workspaceReleasedForRetry(task)) throw new Error(`cannot remove task with unreleased workspace: ${taskId}`);
}
```

先完整验证 remove/update 请求和候选 DAG，再修改 cloned projection；任何失败不得产生部分 amendment。accepted task 无论字段是否与原值相同都拒绝 update/remove，避免调用方用 no-op 探测绕过冻结语义。

- [ ] **Step 5: 增加 Extension 真实工具测试**

通过 `goal_init/dispatch/settle/integrate/accept` 构造 accepted task，再调用 `goal_amend(update_tasks.acceptance)`，断言工具返回 ERROR、events.jsonl 行数不变。另构造 active workspace task，remove 拒绝且 worktree/branch/lease 三类资源仍存在。

- [ ] **Step 6: 运行 GREEN 并提交**

```bash
node --test test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs
git add docs/bugs/bug-goal-engine-amend-mutates-accepted-or-active-task.md scripts/lib/goal-engine/events.mjs scripts/lib/goal-engine/extension.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs
git commit -m "fix(goal-engine): 冻结已执行任务合同"
```

---

### Task 2: 恢复 durable dispatch 的模糊提交结果

**Deps:** Task 1

**Files:**
- Create: `docs/bugs/bug-goal-engine-dispatch-durable-ack-deletes-workspace.md`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Test: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Consumes: `appendEventFn()`、`loadProjectionFn()`、allocated lease、预期 contract hash/workspace identity。
- Produces: 私有 `classifyDispatchAppendFailure(...)`，结果为 `committed | not_committed | ambiguous`；只有 `not_committed` 可执行 failed-cleanup。

- [ ] **Step 1: 写根因文档**

文档精确记录：`task.dispatched` 已写入 JSONL 后 appender 抛错，catch 无条件 release；projection 留下 active workspace 身份但物理 workspace/branch/lease 被删除。根因是把“调用抛错”等同于“事件未提交”。

- [ ] **Step 2: 写 durable-then-throw RED**

复用现有 `createDurableThenThrowAppendEvent("task.dispatched")`：

```js
const first = await invoke(pi, "goal_dispatch", { task_id: "t1" });
assert.equal(JSON.parse(first).status, "dispatched");
const projection = loadProjection(stateRoot, goalId);
assert.equal(projection.tasks.get("t1").status, "dispatched");
assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
  /* workspaceExists/leaseExists/branchExists 均 true */
});
assert.equal(readGoalEvents(cwd, goalId).filter((e) => e.type === "task.dispatched").length, 1);
```

当前实现会抛错并删除资源，因此 RED。

再加两个分类测试：append 在 durable 前失败时 task 仍 pending 且三类资源全删除；append 后 reload 也失败时 workspace 必须保留并抛 `AMBIGUOUS_DISPATCH_COMMIT`，不得删除。

- [ ] **Step 3: 运行 RED**

```bash
node --test --test-name-pattern='dispatch.*durable|ambiguous dispatch|dispatch.*before' test/goal-engine-extension.test.mjs
```

- [ ] **Step 4: 实现三态补偿**

append 抛错后立即从 JSONL 重建 projection，并按以下 literal identity 比较：task status、attempt、contractHash、workspace path/branch/baseCommit。

- 全部等于本次请求：`committed`，保留 lease，注册 active cache，返回正常 dispatched response；
- version 与调用前相同、task 仍 pending、没有本 attempt workspace：`not_committed`，执行 `failed-cleanup` 后重抛原错误；
- 无法加载或出现任何其他 durable 状态：`ambiguous`，保留资源并抛带 goal/task/attempt 的错误。

不能通过“事件类型存在”单点判断 committed，也不能在 ambiguous 分支 best-effort cleanup。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
node --test test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
git add docs/bugs/bug-goal-engine-dispatch-durable-ack-deletes-workspace.md scripts/lib/goal-engine/extension.mjs test/goal-engine-extension.test.mjs
git commit -m "fix(goal-engine): 恢复派发模糊提交结果"
```

---

### Task 3: 修复最终 accept 确认丢失与机器动作死路

**Deps:** Task 2

**Files:**
- Create: `docs/bugs/bug-goal-engine-final-accept-ack-deadlock.md`
- Create: `docs/bugs/bug-goal-engine-terminal-frontier-inconsistent.md`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Modify: `scripts/lib/goal-engine/graph.mjs`
- Test: `test/goal-engine-extension.test.mjs`
- Test: `test/goal-engine-graph.test.mjs`

**Interfaces:**
- Consumes: active projection、`taskActionState()`、`runnableFrontier()`、`goal_accept`。
- Produces: idempotent finalization；所有 `requiredNextAction.params` 均包含 `task_id`；terminal lifecycle 的 frontier 恒为空。

- [ ] **Step 1: 写两份根因文档**

第一份记录 final `task.accepted` 已 durable、`goal.completed` 未写入时重试被 “task is not succeeded” 拒绝，active goal 全 accepted 且无动作。第二份记录 blocked lifecycle 的 pending task 仍出现在 `runnableFrontier`，但 `taskActionState` 已无动作。

- [ ] **Step 2: 写 accept crash-boundary RED**

注入 `task.accepted` durable 后、下一次 append 前失败；首次 `goal_accept` 抛错。重新创建 Extension 后调用同一 `goal_accept({goal_id, task_id})`，必须只追加一个 `goal.completed`，返回原 completion verdict；第三次同参数调用返回相同 terminal 结果且不追加事件。

再覆盖 `goal.completed` durable-then-throw：重试必须读取 terminal projection 并返回成功，不得报 `goal is terminal`。

- [ ] **Step 3: 写机器动作 RED**

在 graph 测试增加：

```js
for (const lifecycle of ["completed", "blocked", "cancelled"]) {
  assert.deepEqual(runnableFrontier(projectionState({ task: taskState({ status: "pending" }) }, { lifecycle })), []);
}
```

对 active/all-accepted crash projection，至少一个 accepted task 必须返回：

```js
{
  allowedActions: ["goal_accept"],
  requiredNextAction: {
    tool: "goal_accept",
    params: { task_id: "t1" },
    reason: /* 非空 */
  },
  blockingReason: null
}
```

所有其他 task action 的 params 也必须含当前 `task_id`；`goal_integrate` 保留 action/strategy。

- [ ] **Step 4: 运行 RED**

```bash
node --test --test-name-pattern='accept.*durable|all accepted|terminal.*runnable|requiredNextAction.*task' test/goal-engine-extension.test.mjs test/goal-engine-graph.test.mjs
```

- [ ] **Step 5: 实现 projection-first accept**

`goal_accept` 先处理三种 projection：

1. lifecycle completed 且显式 goal_id/task_id 匹配：返回 durable completion，不追加；
2. lifecycle active、task accepted、全部 task accepted：跳过 task.accepted，直接补 `goal.completed`；
3. lifecycle active、task succeeded：按原流程 append accepted，再尝试 completed。

每次 append 抛错后 reload；若目标事件已 durable，继续下一阶段或返回成功；若未提交，重抛；身份冲突 fail closed。先在 Extension 内提取私有 `completionVerdictFor(projection)`，首次与恢复都调用它，禁止两条路径重复实现。Task 6 再把该函数迁到共享 evidence 模块并收紧 external 语义。

- [ ] **Step 6: 修正 graph 输出**

`runnableFrontier()` 首行在 `projection.lifecycle !== "active"` 时返回 `[]`。`taskActionState()` 在判断 accepted 无动作前，识别 active/all-accepted crash projection并为按 Map 顺序的第一个 task提供 finalization action；其余 accepted task无动作，避免多个同等 required action。

`actionState()` 接收 taskId 并统一合并 `{ task_id: taskId, ...params }`，测试精确断言可直接传给 tool。

- [ ] **Step 7: 运行 GREEN 并提交**

```bash
node --test test/goal-engine-graph.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
git add docs/bugs/bug-goal-engine-final-accept-ack-deadlock.md docs/bugs/bug-goal-engine-terminal-frontier-inconsistent.md scripts/lib/goal-engine/extension.mjs scripts/lib/goal-engine/graph.mjs test/goal-engine-extension.test.mjs test/goal-engine-graph.test.mjs
git commit -m "fix(goal-engine): 恢复最终验收与机器动作"
```

---

### Task 4: 恢复历史 v1 dispatch replay

**Deps:** Task 1

**Files:**
- Create: `docs/bugs/bug-goal-engine-v1-replay-rejects-historical-dispatch.md`
- Modify: `scripts/lib/goal-engine/events.mjs`
- Test: `test/goal-engine-events.test.mjs`

**Interfaces:**
- Consumes: `taskDispatched(p, data, schemaVersion)`。
- Produces: v1 reducer 仅重放历史语义；v2 新写入继续强制 deps accepted。

- [ ] **Step 1: 写根因文档**

记录旧 v1 reducer 曾允许下游 task 在 dependency accepted 前 dispatch；新 reducer 对所有 schema 调用 `assertDepsAccepted()`，使已持久历史 JSONL 无法 rebuild。强调这不是允许新 v2 越过 DAG。

- [ ] **Step 2: 写历史 fixture RED**

手写固定 eventId/occurredAt 的纯 v1 JSONL 顺序：goal.created(t1,t2 deps t1) → task.dispatched(t2) → task.settled(t2 failed) → task.dispatched(t1)。`loadProjection()` 必须成功并保留版本、attempt 和 status。相同顺序改成 v2 时必须继续拒绝 downstream dispatch。

- [ ] **Step 3: 运行 RED**

```bash
node --test --test-name-pattern='historical v1.*dispatch|v2.*dependency' test/goal-engine-events.test.mjs
```

- [ ] **Step 4: 实现 schema-scoped invariant**

在 `taskDispatched` 中：

```js
if (schemaVersion !== "goal-engine.event.v1") assertDepsAccepted(p, task);
```

v1 分支只影响 replay；Extension 默认仍产生 v2。不得放宽 goal.amended DAG validation 或 v2 schema downgrade 门禁。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
node --test test/goal-engine-events.test.mjs
git add docs/bugs/bug-goal-engine-v1-replay-rejects-historical-dispatch.md scripts/lib/goal-engine/events.mjs test/goal-engine-events.test.mjs
git commit -m "fix(goal-engine): 恢复旧版派发日志重放"
```

---

### Task 5: 串行化跨进程 event store writers

**Files:**
- Create: `docs/bugs/bug-goal-engine-store-concurrent-writers-corrupt-log.md`
- Create: `test/goal-engine-store-concurrency.test.mjs`
- Modify: `scripts/lib/goal-engine/store.mjs`

**Interfaces:**
- Consumes: 同步 `appendEvent(stateRoot, event, expectedVersion)`。
- Produces: state-root 级 `.writer.lock/owner.json`；同一临界区覆盖 replay/version check、JSONL append、projection replace、registry replace。

- [ ] **Step 1: 写根因文档**

记录八个进程可用同一 expectedVersion 全部成功，以及六个 disposition_started 同时落盘导致 replay 报 “already started”。根因是 CAS 只在各进程内检查，固定 `.tmp` 路径还会相互覆盖。

- [ ] **Step 2: 写多进程 RED**

新测试创建已有 goal，fork 6 个 Node worker，各自调用：

```js
appendEvent(stateRoot, checkpointEvent(workerId), expectedVersion);
```

断言恰好一个 worker 成功、其余错误 code 为 `PROJECTION_CONFLICT`；JSONL 只增加一行、projection 可重放、registry 可解析、目录无 `.tmp`/quarantine 残留。当前实现会多成功或出现 rename ENOENT，因此 RED。

另写 stale lock 测试：owner PID 明确不存在时可原子 quarantine 并恢复；owner PID 存活时超时失败且不得删除 lock。

- [ ] **Step 3: 运行 RED**

```bash
node --test test/goal-engine-store-concurrency.test.mjs
```

- [ ] **Step 4: 实现 state-root 单 writer lock**

锁协议固定为：

- `mkdirSync(<stateRoot>/.writer.lock)` 作为原子 acquire；
- owner.json 含 `pid/token/createdAt`，权限 `0600`；目录 `0700`；
- EEXIST 时读取 owner：PID 存活则有界等待，PID 不存在则把整个 lock dir 原子 rename 到唯一 quarantine 后删除；
- release 前重读 token，只删除自己持有的 lock；
- wait 超时抛 `GOAL_ENGINE_STORE_LOCK_TIMEOUT`；
- projection/registry 临时文件使用 `pid + randomUUID` 唯一名，并在 finally 只清理本调用拥有的临时文件。

临界区必须从 `rebuildProjection()` 前开始，到 registry 原子替换后结束。不得只锁 events.jsonl 或只锁单 goal，因为 registry 是跨 goal 共享资源。

- [ ] **Step 5: 增加 mutation oracle**

把锁移到 version check 之后、把 registry 写移到锁外、或把 release 改成无 token 删除时，至少一项并发/owner 测试必须失败。把这些 mutation 对应行为写进测试名称。

- [ ] **Step 6: 运行 GREEN 与 store 回归**

```bash
node --test test/goal-engine-store-concurrency.test.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs
```

- [ ] **Step 7: 提交 Task 5**

```bash
git add docs/bugs/bug-goal-engine-store-concurrent-writers-corrupt-log.md scripts/lib/goal-engine/store.mjs test/goal-engine-store-concurrency.test.mjs
git commit -m "fix(goal-engine): 串行化事件存储写入"
```

---

### Task 6: 收紧 external evidence 与完成 verdict

**Deps:** Task 3

**Files:**
- Create: `docs/bugs/bug-goal-engine-pre-existing-evidence-counts-external.md`
- Create: `scripts/lib/goal-engine/evidence.mjs`
- Modify: `scripts/lib/goal-engine/events.mjs`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Modify: `scripts/lib/goal-engine/audit.mjs`
- Test: `test/goal-engine-events.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`
- Test: `test/goal-engine-audit.test.mjs`

**Interfaces:**
- Consumes: evidence `{ type, source, ref/path }`。
- Produces: `classifyGoalEvidence(projection)` 纯函数；只有 `source === "external" && type === "external_review"` 计为 external verification。

- [ ] **Step 1: 写根因文档**

记录 `source=pre_existing` 因 `source !== self_produced` 被计作 external，进而产生 `COMPLETE` 和 `HEALTHY`。说明 pre-existing 只能证明工件先前存在，不能证明独立 reviewer 身份。

- [ ] **Step 2: 写 evidence RED matrix**

覆盖：

- 只有 self_produced → `DONE_WITHOUT_EXTERNAL_VERIFICATION`，audit 至少 AT_RISK；
- 只有 pre_existing → 同上，且 signal 包含 `PRE_EXISTING_EVIDENCE_WITHOUT_EXTERNAL_REVIEW`；
- self_produced + pre_existing → 仍非 external；
- external source + 普通 file → reducer 拒绝；
- external source + external_review artifact → 可产生 COMPLETE；
- direct event 中未知 evidenceSource → reducer 拒绝，而不是仅依赖 tool schema。

- [ ] **Step 3: 运行 RED**

```bash
node --test --test-name-pattern='pre.existing|external evidence|external_review' test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-audit.test.mjs
```

- [ ] **Step 4: 实现单一 evidence 分类函数**

将 Task 3 的 `completionVerdictFor()` 迁到新建的 `evidence.mjs`，并导出统一分类函数；Extension 和 audit 必须调用同一实现：

```js
export function classifyGoalEvidence(projection) {
  const evidence = [...projection.tasks.values()].flatMap((task) => task.evidence);
  return {
    evidenceCount: evidence.length,
    hasExternalReview: evidence.some((item) => item.source === "external" && item.type === "external_review"),
    hasPreExisting: evidence.some((item) => item.source === "pre_existing"),
    allSelfProduced: evidence.length > 0 && evidence.every((item) => item.source === "self_produced"),
  };
}
```

Reducer 验证 source enum；`external` 必须配 `external_review`，`external_review` 若不是 external source也不得提升 verdict。Audit 的 `has_external_evidence` 精确映射 `hasExternalReview`。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
node --test test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-audit.test.mjs
git add docs/bugs/bug-goal-engine-pre-existing-evidence-counts-external.md scripts/lib/goal-engine/evidence.mjs scripts/lib/goal-engine/events.mjs scripts/lib/goal-engine/extension.mjs scripts/lib/goal-engine/audit.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-audit.test.mjs
git commit -m "fix(goal-engine): 收紧外部证据判定"
```

---

### Task 7: 组合回归、跨仓 Executor 消费验证与独立审查

**Deps:** Task 4, Task 5, Task 6

**Files:**
- Create: `test/goal-engine-cross-repo-executor.integration.mjs`
- Create: `reports/goal-engine-p0-p1-review.md`

**Interfaces:**
- Consumes: 本计划累计提交、Workspace/Git 计划累计提交、Plan Runner convergence 中已验收的真实跨仓 owner-entry 提交。
- Produces: 真实临时业务仓的 `goal_init → goal_dispatch → typed executor → settle → integrate → accept` 证明，以及中文最终审查报告。

- [ ] **Step 1: 建立无冲突组合基线**

从冻结的 Plan Runner convergence coordinator 提交创建新 clean worktree，先 merge Goal Engine hardening 累计分支，再 merge Workspace/Git 和本计划分支。使用 `git merge-tree` 预检；任何文本冲突先报告，禁止在脏 `main` 上解决。

- [ ] **Step 2: 写跨仓真实 RED**

`test/goal-engine-cross-repo-executor.integration.mjs` 必须创建不含配置仓源码的临时 Git 业务仓，通过真实 Pi host 注册 Goal Engine 和 typed subagent；不能直接调用 fake `prepareCodingSpawn`。断言：

- dispatch contract 的 cwd 是 Goal worktree；
- `.pi-subagents/root-session-owner-entry.mjs` 在 spawn 前由可信 materializer 生成；
- Executor 产生唯一允许路径提交；
- settle/integrate/accept 后 origin 包含结果且 Goal completed；
- worktree、lease、executor branch、broker socket 和 child process 全部清理；
- owner entry 的保留/清理由 Plan Runner convergence 的冻结合同决定，测试精确断言该合同，不自行猜测。

在旧组合态上应复现 “Extension path does not exist”；若 Plan Runner convergence 已先修复，则把该 RED 证据引用为其 Task 5/6 的实际 RED，不伪造第二次失败。

- [ ] **Step 3: 运行全部 Goal Engine 门禁**

```bash
node --test \
  test/goal-engine-events.test.mjs \
  test/goal-engine-graph.test.mjs \
  test/goal-engine-workspace.test.mjs \
  test/goal-engine-extension.test.mjs \
  test/goal-engine-audit.test.mjs \
  test/goal-engine-store-concurrency.test.mjs \
  test/goal-engine-runtime.integration.mjs \
  test/goal-engine-cross-repo-executor.integration.mjs
npm run doctor
```

- [ ] **Step 4: 运行冻结 HEAD 全仓测试**

```bash
npm test
```

任何失败都必须按归属分类；Goal Engine、subagent runtime、Git safety 相关失败一律阻止 APPROVED。与本轮无关的失败也不能声称全仓 GREEN，报告必须列出精确名称和证据。

- [ ] **Step 5: 独立 reviewer**

分别审查 event/recovery、store concurrency、workspace/Git 和真实跨仓 Harness。Critical/Important finding 必须新建 bug 文档并回到 RED；reviewer timeout 不计通过。

- [ ] **Step 6: 写最终报告并提交**

`reports/goal-engine-p0-p1-review.md` 逐项给出 P0/P1 的 `FIXED / PARTIAL / OPEN`、测试 artifact、冻结 commit、资源清理和 merge 状态。只有所有 P0/P1 FIXED、目标门禁全绿且 reviewer 无 Critical/Important 才写 `APPROVED`。

```bash
git add test/goal-engine-cross-repo-executor.integration.mjs reports/goal-engine-p0-p1-review.md
git commit -m "test(goal-engine): 验证跨仓生产恢复链路"
```
