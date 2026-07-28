# Plan Runner Pi-Subagents 并行 Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Plan Runner 改造成以 `pi-subagents@0.37.0` RPC 为 Executor 后端的确定性并行 Harness，为每个 Attempt 分配独占 worktree，支持路径与资源授权、逐级通信、结果验证、串行集成和保守恢复，并只保留负责独立 Plan Runner 生命周期的薄 Host Runtime。

**Architecture:** 薄 Host Runtime只启动、监管和停止一个不带`PI_SUBAGENT_CHILD`的Standalone Plan Runner；该进程加载官方完整`pi-subagents`extension，通过公开RPC派发Executor，并使用官方wait、session、Supervisor、interrupt和stop生命周期。Plan event log、Frozen IR、Gate和`validatedHead`继续作为编排事实源；Executor不能派发子代理，Harness按唯一Attempt workspace绑定运行事实，验证提交和文件所有权后，由唯一Integration Queue串行合入Plan accumulator worktree。Executor到Plan Runner使用native Supervisor，Plan Runner到Root Parent使用durable typed Plan Control/Attention channel。

**Tech Stack:** Pi 0.82.0/0.82.1 Extension API、`pi-subagents@0.37.0` stable RPC v1、`typebox@1.1.38`、Node.js 22 ESM、Git worktree、Node内置test runner。

---

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v1",
  "verification": [
    "node --test test/subagents-rpc-client.test.mjs test/plan-execution-backend.test.mjs test/plan-host-runtime.test.mjs",
    "node --test test/plan-document.test.mjs test/plan-ir.test.mjs test/plan-events.test.mjs test/plan-projection.test.mjs",
    "node --test test/plan-attempt-workspace.test.mjs test/plan-resource-locks.test.mjs test/plan-coordinator.test.mjs",
    "node --test test/plan-attempt-validator.test.mjs test/plan-integration-queue.test.mjs",
    "node --test test/plan-attention.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs",
    "node --test test/plan-launcher-extension.test.mjs test/plan-runtime-migration.test.mjs",
    "PI_REAL_BIN=\"$(command -v pi)\" node --test test/pi-subagents-runtime.integration.mjs",
    "PI_REAL_BIN=\"$(command -v pi)\" node --test test/plan-parallel-harness.integration.mjs",
    "npm test",
    "npm run doctor",
    "git diff --check"
  ],
  "requiredGates": [
    "deterministic",
    "plan-audit",
    "external-review",
    "final-completeness"
  ]
}
```

## 冻结边界

1. Plan Harness 是唯一编排控制面；`pi-subagents` 不决定 DAG、资源、worktree、验证、集成顺序或 Gate。
2. Standalone Plan Agent只能调用Plan tools、`subagent_wait`和`subagent_supervisor`；`subagent`始终不在active tools中，Plan Capsule的`tool_call` hook持续阻断任何绕过调用。Plan Runner不是fanout child，不设置`PI_SUBAGENT_CHILD`或`PI_SUBAGENT_FANOUT_CHILD`。
3. 不生成或执行 Agent 编写的 workflow script；动态变化使用 typed Plan IR 和 amendment event。
4. 一个 Attempt 对应一个独占 branch、worktree、owner token、base commit 和一个 `pi-subagents` async run。
5. `worktree:false` 固定传给 `pi-subagents`；Harness 传入已分配的精确 `cwd`。
6. 同一 frontier 的 Attempt 从同一个 accumulator HEAD 创建；结果只能由 Integration Queue 串行合入。
7. RPC、stdout、status projection 和 dashboard 都不是 Plan 事实源；Plan event log 是领域状态权威，`pi-subagents` lifecycle artifacts 是运行事实权威，Git 是文件结果权威。
8. `subagent:async-started` 和 spawn reply 都可提供 binding；二者不一致、一个 workspace 匹配多个 run、或 spawn 后无可验证事实时 fail closed。
9. `waiting-attention` 是非终态；普通 `progress_update` 不阻塞，`need_decision` 和 `interview_request` 阻塞对应 Attempt。
10. Executor只能通过`contact_supervisor`向直接Supervisor，也就是Standalone Plan Runner发请求；Plan Runner将需要用户判断的请求写入durable AttentionRequest，再由薄Host向Root Parent暴露typed Plan Control，禁止Executor直接穿透。
11. 验证只接受 Attempt base 到 result commit 的 Git diff；越出 `allowedPaths`、修改 `.git`、产生 merge commit、工作区不干净或缺少提交均拒绝。
12. 集成冲突不自动 rebase、不让模型直接处理 accumulator；保留 Attempt worktree并进入可恢复 blocker。
13. `validatedHead` 只在所有 Task 已集成且四类 Gate 对同一 clean HEAD 通过后产生。
14. 不修改`pi/npm/node_modules/pi-subagents`，不deep import上游内部模块，不清除或伪造`PI_SUBAGENT_CHILD`；只使用正式extension、stable RPC和公开工具。
15. `pi-subagents@0.37.0`和`typebox@1.1.38`必须作为顶层精确安装依赖；Doctor从`pi-subagents`解析路径验证`typebox/compile`，升级后必须重复真实async门禁。
16. 当前仓库已有未提交改动；实施采用当前checkout内单writer串行修改，先将既有`spawnPiAgent`半成品视为迁移输入并用RED测试固定目标，不reset、checkout、覆盖或并行写同一checkout。Harness具备per-attempt隔离后，只有Harness管理的Executor才可并行。

## 文件结构

| 路径 | 职责 |
|---|---|
| `scripts/lib/plan/execution-backend.mjs` | Plan 与执行 Runtime 之间的窄接口、capability 校验和运行事实归一化 |
| `scripts/lib/plan/pi-subagents-execution-backend.mjs` | stable RPC v1、async-started/complete事件和artifact reader的公开adapter |
| `scripts/lib/plan/plan-host-runtime.mjs` | 薄Host：启动、监管、恢复和停止Standalone Plan Runner，不派发Executor |
| `scripts/lib/plan/attempt-workspace.mjs` | per-attempt branch/worktree lease、owner token、保留和回收 |
| `scripts/lib/plan/resource-locks.mjs` | 文件所有权冲突和显式 resource claim 的确定性授权 |
| `scripts/lib/plan/attempt-validator.mjs` | result commit、allowed paths、cleanliness、base ancestry 和验证证据 |
| `scripts/lib/plan/integration-queue.mjs` | 单 writer、确定性 cherry-pick、冲突保留和 accumulator HEAD推进 |
| `scripts/lib/plan/attention.mjs` | AttentionRequest schema、状态迁移、reply fencing和逐级转发约束 |
| `scripts/lib/plan/plan-events.mjs` | workspace/resource/dispatch/attention/integration领域事件 reducer |
| `scripts/lib/plan/plan-projection.mjs` | 从 event log 和运行 artifacts 生成只读状态 |
| `scripts/lib/plan/coordinator.mjs` | frontier、资源授权、Attempt创建、运行结算和 Integration Queue推进 |
| `scripts/lib/plan/plan-runner-dependencies.mjs` | Plan tools 到 Harness服务的装配 |
| `scripts/lib/plan/plan-capsule-extension.mjs` | Standalone Plan Session tools、wait/supervisor门禁、事件持久化和completion guard |
| `scripts/lib/plan/plan-launcher-extension.mjs` | 通过薄Host启动、观察和控制Standalone Plan Runner |
| `scripts/lib/subagents-rpc-client.mjs` | versioned RPC client、caller request ID、错误码和 listener 生命周期 |
| `pi/child-extensions/plan-runner.ts` | Standalone Plan Runner专用extension入口；名称保留兼容，但进程不是subagent child |
| `pi/agents/plan-runner.md` | Plan Runner唯一可见工具和向上通信规则 |
| `test/plan-parallel-harness.integration.mjs` | 真实 Pi、真实 Git worktree、并行、恢复、Supervisor和集成故障矩阵 |

### Task 1: 建立 Standalone Runtime与依赖兼容性门禁

**Files:**
- Create: `scripts/setup-plan-runtime-deps.mjs`
- Modify: `test/pi-subagents-runtime.integration.mjs`
- Modify: `test/fixtures/deterministic-provider.mjs`
- Create: `test/fixtures/deterministic-provider-state.mjs`
- Create: `test/deterministic-provider.test.mjs`
- Modify: `scripts/probes/pi-subagents-compat.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`
- Modify: `test/package-scripts.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写精确依赖与Standalone capability的失败测试**

在`test/pi-subagents-compat.test.mjs`固定通过报告：

```javascript
const report = {
  piVersion: "0.82.1",
  version: "0.37.0",
  typeboxVersion: "1.1.38",
  typeboxCompileResolvable: true,
  rpcVersion: 1,
  methods: ["ping", "spawn", "status", "interrupt", "stop"],
  events: ["subagent:async-started", "subagent:async-complete"],
  standaloneRootService: true,
  standaloneNoChildEnv: true,
  standaloneSessionRebased: true,
  exactCwd: true,
  worktreeDisabled: true,
  waitWakesOnCompletion: true,
  rpcStatusFindsActiveRun: true,
  statusArtifactObservesSupervisorBlock: true,
  supervisorRoundTrip: true,
  executorFanoutBlocked: true,
  nestedEventFiles: 0,
};
assert.deepEqual(evaluatePlanHarnessCompatibility(report), { ok: true, failures: [] });
```

分别修改每个版本或boolean，并把`nestedEventFiles`改为1，断言返回精确failure。Pi只接受已实测的`0.82.0`和`0.82.1`；未来patch版本默认拒绝。另测试Standalone环境构造器移除继承的`PI_SUBAGENT_PARENT_SESSION`，但检测到`PI_SUBAGENT_CHILD`或`PI_SUBAGENT_FANOUT_CHILD`时fail closed。运行：

```bash
node --test test/pi-subagents-compat.test.mjs
```

Expected: FAIL，提示`evaluatePlanHarnessCompatibility`未导出或缺少新字段判定。

- [ ] **Step 2: 实现纯capability判定器**

在`scripts/probes/pi-subagents-compat.mjs`增加：

```javascript
export const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1"];

export function evaluatePlanHarnessCompatibility(report) {
  const failures = [];
  if (!SUPPORTED_PI_VERSIONS.includes(report.piVersion)) failures.push(`unsupported Pi version: ${report.piVersion}`);
  if (report.version !== "0.37.0") failures.push(`unexpected pi-subagents version: ${report.version}`);
  if (report.typeboxVersion !== "1.1.38") failures.push(`unexpected typebox version: ${report.typeboxVersion}`);
  if (report.typeboxCompileResolvable !== true) failures.push("typebox/compile is not resolvable from pi-subagents");
  if (report.rpcVersion !== 1) failures.push(`unexpected RPC version: ${report.rpcVersion}`);
  for (const method of ["ping", "spawn", "status", "interrupt", "stop"]) {
    if (!report.methods?.includes(method)) failures.push(`missing RPC method: ${method}`);
  }
  for (const event of ["subagent:async-started", "subagent:async-complete"]) {
    if (!report.events?.includes(event)) failures.push(`missing lifecycle event: ${event}`);
  }
  for (const [field, message] of [
    ["standaloneRootService", "Standalone Plan Runner did not load the root service"],
    ["standaloneNoChildEnv", "Standalone Plan Runner inherited child mode"],
    ["standaloneSessionRebased", "Standalone Plan Runner retained the inherited parent session route"],
    ["exactCwd", "Executor did not use the authorized cwd"],
    ["worktreeDisabled", "pi-subagents created an unauthorized worktree"],
    ["waitWakesOnCompletion", "wait did not wake on completion"],
    ["rpcStatusFindsActiveRun", "RPC status did not find the active Executor"],
    ["statusArtifactObservesSupervisorBlock", "Status artifact did not observe the Supervisor block"],
    ["supervisorRoundTrip", "Supervisor request/reply failed"],
    ["executorFanoutBlocked", "Executor can dispatch nested subagents"],
  ]) {
    if (report[field] !== true) failures.push(message);
  }
  if (report.nestedEventFiles !== 0) failures.push(`unexpected nested event files: ${report.nestedEventFiles}`);
  return { ok: failures.length === 0, failures };
}
```

运行前一步命令。Expected: PASS。

- [ ] **Step 3: 固化可重复的顶层依赖安装命令**

`test/package-scripts.test.mjs`断言存在`setup:plan-runtime`。`scripts/setup-plan-runtime-deps.mjs`只执行以下参数，不修改`node_modules/pi-subagents/package.json`：

```javascript
const args = [
  "install", "--prefix", piNpmDir, "--save-exact",
  "pi-subagents@0.37.0", "typebox@1.1.38",
];
await execFile("npm", args, { env: process.env });
```

`package.json`增加：

```json
"setup:plan-runtime": "node scripts/setup-plan-runtime-deps.mjs",
"test:subagents": "node --test test/pi-subagents-runtime.integration.mjs"
```

先运行`node --test test/package-scripts.test.mjs`确认RED，再实现并运行到PASS。测试只校验命令构造，不执行真实安装。

- [ ] **Step 4: 扩展真实Standalone Runtime probe**

在`test/pi-subagents-runtime.integration.mjs`去掉Pi 0.80.6、`pi-subagents 0.34.0`和已下架`Qwen3.7-Max-DogFooding`硬编码。使用`PI_REAL_BIN`启动独立Pi进程：移除继承的`PI_SUBAGENT_PARENT_SESSION`，由新进程建立自己的session identity；若存在`PI_SUBAGENT_CHILD`或`PI_SUBAGENT_FANOUT_CHILD`则拒绝启动，不清除后冒充root。加载官方完整`pi-subagents`extension与`test/fixtures/deterministic-provider.mjs`，固定`--provider fake --model fake/deterministic`。控制面门禁不得依赖外部Provider、凭据或会下架的模型。通过stable RPC完成spawn并确认active run；由于0.37.0的status RPC details尚未typed化，通过返回的`asyncDir/status.json`验证`currentTool=contact_supervisor`：

```javascript
const run = await rpc.spawn({
  agent: "executor-probe",
  task: "Call contact_supervisor once, await reply, then print COMPAT_OK.",
  cwd: attemptWorktree,
  context: "fresh",
  worktree: false,
  async: true,
});
assert.equal(run.cwd, attemptWorktree);
assert.equal(await rpcStatusFinds(run.runId), "running");
assert.equal(await readStatusArtifact(run).currentTool, "contact_supervisor");
assert.equal(await countNestedEventFiles(run), 0);
await replyThroughNativeSupervisor(run);
assert.equal(await waitForState(run, "complete"), "complete");
assert.equal(await readOutput(run), "COMPAT_OK");
```

父侧先给native Supervisor 500ms扫描窗口，再使用正式`subagent_supervisor pending/reply`回复Executor的`contact_supervisor`，最后用正式`subagent_wait`收敛terminal。不能声称Supervisor request会立即唤醒正在阻塞的wait；0.37.0不存在该语义。扩展`deterministic-provider.mjs`，按prompt和tool result确定性地产生一次`contact_supervisor`tool call及最终`COMPAT_OK`，不能访问网络。Executor profile不暴露`subagent`，tool hook再次拒绝该tool。允许root async创建一个route元数据文件，但Executor阻塞期间nested event文件必须为0。probe从实际`pi-subagents`目录执行`require.resolve("typebox/compile", { paths: [piSubagentsDir] })`，输出不包含prompt、session内容或凭据。

- [ ] **Step 5: 运行真实硬门禁并提交**

```bash
node --test test/pi-subagents-compat.test.mjs test/package-scripts.test.mjs
PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs
```

Expected: PASS，并证明当前Pi属于显式支持集合`0.82.0/0.82.1`、`pi-subagents=0.37.0`、`typebox=1.1.38`、RPC v1可定位active run、Standalone session已重建、Supervisor往返成功且`nestedEvents=0`。任一断言失败时停止计划，不进入Task 2，也不恢复自建Executor Runtime。

```bash
git add scripts/setup-plan-runtime-deps.mjs scripts/probes/pi-subagents-compat.mjs test/fixtures/deterministic-provider.mjs test/pi-subagents-compat.test.mjs test/pi-subagents-runtime.integration.mjs test/package-scripts.test.mjs package.json
git commit -m "test(plan): 增加独立运行时兼容门禁"
```

### Task 2: 定义 pi-plan.v2 Typed IR、路径所有权与资源声明

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/plan/plan-document.mjs`
- Modify: `scripts/lib/plan/ir/compile.mjs`
- Modify: `scripts/lib/plan/ir/frontier.mjs`
- Modify: `test/plan-document.test.mjs`
- Modify: `test/plan-ir.test.mjs`

- [ ] **Step 1: 写 v2 Plan解析失败测试**

测试以下合法 Task：

```markdown
### Task X: Build runner

**Files:**
- Create: `scripts/lib/runner/**`
- Modify: `test/runner.test.mjs`

**Resources:**
- `xcode`: `exclusive`
- `provider:tbctx7`: `shared`
```

Execution Contract 使用：

```json
{
  "schemaVersion": "pi-plan.v2",
  "verification": ["npm test"],
  "requiredGates": ["deterministic", "plan-audit", "external-review", "final-completeness"],
  "resourceCapacities": {"xcode": 1, "provider:tbctx7": 4}
}
```

断言 parser产出：

```javascript
assert.deepEqual(plan.tasks[0].allowedPaths, ["scripts/lib/runner/**", "test/runner.test.mjs"]);
assert.deepEqual(plan.tasks[0].resources, [
  { id: "provider:tbctx7", mode: "shared" },
  { id: "xcode", mode: "exclusive" },
]);
assert.equal(plan.resourceCapacities.xcode, 1);
```

同时拒绝绝对路径、`..`、`.git/**`、空 glob、未知 mode、容量小于 1、重复 resource和 Files重叠但无显式依赖的并行 root。运行：

```bash
node --test test/plan-document.test.mjs test/plan-ir.test.mjs
```

Expected: FAIL，当前 parser不支持 `pi-plan.v2`。

- [ ] **Step 2: 实现 v1兼容和 v2 canonical hash**

保持 `pi-plan.v1` 原 canonical结构和 hash不变；仅 v2加入：

```javascript
{
  version: "plan-ir.v2",
  resourceCapacities,
  nodes: [{ id, title, deps, allowedPaths, resources, agent }],
  edges: [{ from, to }],
  hash,
  nodeFingerprints,
}
```

路径只允许 repo-relative POSIX路径；`/**` 只允许出现在末尾。resources按 `id` 排序后进入 canonical JSON。`nodeFingerprint` 对 `{id,deps,allowedPaths,resources,agent}` 计算 SHA-256。

- [ ] **Step 3: 实现静态所有权冲突检查**

在 `compile.mjs` 导出：

```javascript
export function pathsOverlap(left, right) {
  const prefix = (value) => value.endsWith("/**") ? value.slice(0, -3).replace(/\/$/, "") : null;
  if (left === right) return true;
  const lp = prefix(left);
  const rp = prefix(right);
  if (lp !== null && (right === lp || right.startsWith(`${lp}/`))) return true;
  if (rp !== null && (left === rp || left.startsWith(`${rp}/`))) return true;
  return lp !== null && rp !== null && (lp.startsWith(`${rp}/`) || rp.startsWith(`${lp}/`));
}
```

若两个可同时进入同一 frontier的节点路径重叠，compiler拒绝并要求添加依赖；有依赖关系的节点允许重叠。

- [ ] **Step 4: 运行测试并提交**

```bash
node --test test/plan-document.test.mjs test/plan-ir.test.mjs
```

Expected: PASS，原 v1 fixture hash保持不变。

```bash
git add scripts/lib/plan/plan-document.mjs scripts/lib/plan/ir test/plan-document.test.mjs test/plan-ir.test.mjs
git commit -m "feat(plan): 增加并行计划类型契约"
```

### Task 3: 扩展 Plan事件、Attempt与Attention状态机

**Deps:** Task 2

**Files:**
- Modify: `scripts/lib/plan/plan-events.mjs`
- Modify: `scripts/lib/plan/plan-projection.mjs`
- Create: `scripts/lib/plan/attention.mjs`
- Modify: `test/plan-events.test.mjs`
- Modify: `test/plan-projection.test.mjs`
- Create: `test/plan-attention.test.mjs`

- [ ] **Step 1: 写事件迁移失败测试**

覆盖以下新事件：

```text
attempt.workspace-allocated
attempt.dispatch-requested
attempt.bound
attempt.attention-requested
attempt.attention-escalated
attempt.attention-resolved
attempt.settled
attempt.validated
integration.requested
integration.finished
attempt.workspace-released
```

`attempt.dispatch-requested` data固定为：

```javascript
{
  attemptId,
  taskId,
  dispatchId,
  baseCommit,
  workspace: { path, branch, ownerToken },
  tool: { agent, task, cwd, context: "fresh", async: true, clarify: false, worktree: false },
  toolHash,
}
```

断言 `need_decision` 后 Attempt为 `waiting-attention`，`progress_update` 保持 `active`；旧 projection version、错误 requestId、错误 runId或已 settle Attempt上的 reply被拒绝。

- [ ] **Step 2: 实现 AttentionRequest schema**

在 `attention.mjs` 导出：

```javascript
export const ATTENTION_KINDS = new Set(["need_decision", "interview_request", "progress_update"]);

export function createAttentionRequest(input) {
  if (!ATTENTION_KINDS.has(input.kind)) throw new Error(`invalid attention kind: ${input.kind}`);
  const blocking = input.kind !== "progress_update";
  return Object.freeze({
    requestId: input.requestId,
    planId: input.planId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    runId: input.runId,
    kind: input.kind,
    blocking,
    message: input.message,
    projectionVersion: input.projectionVersion,
    createdAt: input.createdAt,
  });
}
```

单条 message限制64 KiB，同一 Attempt最多一个未解决 blocking request。

- [ ] **Step 3: 实现 reducer和只读 projection**

Attempt状态固定为：

```text
workspace-allocated -> dispatch-requested -> active
active -> waiting-attention -> active
active -> succeeded|failed|interrupted|cancelled
succeeded -> validated -> integrated
```

`plan-projection.mjs` 输出每个 Attempt的 `dispatchId/baseCommit/workspace/runId/attention/status/resultCommit`，但不复制 transcript或message全文；状态投影只保存 attention message SHA-256和证据引用。

- [ ] **Step 4: 运行测试并提交**

```bash
node --test test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-attention.test.mjs
```

Expected: PASS。

```bash
git add scripts/lib/plan/plan-events.mjs scripts/lib/plan/plan-projection.mjs scripts/lib/plan/attention.mjs test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-attention.test.mjs
git commit -m "feat(plan): 增加尝试与关注请求状态机"
```

### Task 4: 实现 per-attempt Workspace Lease

**Deps:** Task 3

**Files:**
- Create: `scripts/lib/plan/attempt-workspace.mjs`
- Create: `test/plan-attempt-workspace.test.mjs`
- Modify: `scripts/lib/plan/workspace.mjs`
- Modify: `test/plan-workspace.test.mjs`

- [ ] **Step 1: 写真实临时 Git仓 RED测试**

测试从 accumulator HEAD并行创建两个 lease：

```javascript
const lease = await allocateAttemptWorkspace({
  originRoot,
  stateRoot,
  planId: "plan-1",
  taskId: "task-2",
  attemptId: "attempt-plan-1-task-2-1",
  baseCommit,
});
assert.equal(lease.baseCommit, baseCommit);
assert.match(lease.branch, /^pi-plan-attempt\/plan-1\/task-2\/1$/);
assert.equal(await git(lease.path, "rev-parse", "HEAD"), baseCommit);
```

覆盖 branch已存在、路径逃逸、错误 owner token释放、active run释放、dirty worktree释放、重复释放、失败现场保留和 cleanup重试。

- [ ] **Step 2: 实现分配和所有权文件**

公开接口固定为：

```javascript
export async function allocateAttemptWorkspace(input) {}
export async function inspectAttemptWorkspace(lease) {}
export async function releaseAttemptWorkspace(lease, { ownerToken, disposition }) {}
```

路径固定为：

```text
var/plan-worktrees/<planId>/attempts/<attemptId>
```

使用 argv Git调用：

```text
git worktree add -b <branch> <path> <baseCommit>
```

lease写入 `var/plan-runs/<planId>/attempts/<attemptId>/workspace.json`，权限 `0600`，原子 rename；内容含 plan/task/attempt/base/path/branch/ownerToken/createdAt。

- [ ] **Step 3: 实现保留和清理语义**

只允许以下 disposition：

```text
integrated-cleanup
cancelled-cleanup
failed-preserve
conflict-preserve
attention-preserve
```

`*-preserve` 不删除 worktree；cleanup前要求对应 Plan event已进入允许状态，并执行 `git worktree remove` 后删除 branch。禁止 `--force`，清理失败写 evidence并保留 lease。

- [ ] **Step 4: 运行测试并提交**

```bash
node --test test/plan-attempt-workspace.test.mjs test/plan-workspace.test.mjs
```

Expected: PASS。

```bash
git add scripts/lib/plan/attempt-workspace.mjs scripts/lib/plan/workspace.mjs test/plan-attempt-workspace.test.mjs test/plan-workspace.test.mjs
git commit -m "feat(plan): 增加独占尝试工作区"
```

### Task 5: 实现路径与资源锁授权

**Deps:** Task 2, Task 4

**Files:**
- Create: `scripts/lib/plan/resource-locks.mjs`
- Create: `test/plan-resource-locks.test.mjs`
- Modify: `scripts/lib/plan/ir/frontier.mjs`
- Modify: `test/plan-ir.test.mjs`

- [ ] **Step 1: 写确定性授权失败测试**

输入 runnable frontier：

```javascript
const nodes = [
  { id: "task-a", allowedPaths: ["src/a/**"], resources: [{ id: "xcode", mode: "exclusive" }] },
  { id: "task-b", allowedPaths: ["src/b/**"], resources: [{ id: "xcode", mode: "exclusive" }] },
  { id: "task-c", allowedPaths: ["docs/**"], resources: [] },
];
assert.deepEqual(selectAuthorizedFrontier(nodes, { capacities: { xcode: 1 }, claims: [] }).map((n) => n.id), ["task-a", "task-c"]);
```

覆盖 shared容量、exclusive排他、路径重叠、已有 active claim、未知 resource、输入顺序变化和释放后下一节点可授权。

- [ ] **Step 2: 实现 ResourceClaimSet**

```javascript
export function createResourceClaimSet({ capacities }) {
  const claims = new Map();
  return {
    canAcquire(node) {},
    acquire(node, attemptId) {},
    release(attemptId) {},
    snapshot() { return [...claims.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)); },
  };
}
```

排序键固定为 Plan文档顺序，其次 task ID。exclusive占满资源；shared每个 claim占1个容量；路径所有权始终视为 exclusive。

- [ ] **Step 3: 将锁选择接入 frontier**

`runnableFrontier()` 仍只判断 DAG；新增 `authorizedFrontier(ir, projection)` 对 runnable集合应用 active claims和路径冲突。没有可授权节点但存在 active Attempt时返回空数组，不抛 `no runnable tasks`；没有 active Attempt且剩余节点永久不可授权时返回结构化 deadlock。

- [ ] **Step 4: 运行测试并提交**

```bash
node --test test/plan-resource-locks.test.mjs test/plan-ir.test.mjs
```

Expected: PASS。

```bash
git add scripts/lib/plan/resource-locks.mjs scripts/lib/plan/ir/frontier.mjs test/plan-resource-locks.test.mjs test/plan-ir.test.mjs
git commit -m "feat(plan): 增加并行资源授权"
```

### Task 6: 实现公开RPC PiSubagentsExecutionBackend

**Deps:** Task 1, Task 3, Task 4

**Files:**
- Create: `scripts/lib/plan/execution-backend.mjs`
- Create: `scripts/lib/plan/pi-subagents-execution-backend.mjs`
- Create: `test/plan-execution-backend.test.mjs`
- Modify: `scripts/lib/subagents-rpc-client.mjs`
- Modify: `test/subagents-rpc-client.test.mjs`
- Modify: `scripts/lib/plan/runtime-artifacts.mjs`
- Modify: `test/plan-runtime-artifacts.test.mjs`

- [ ] **Step 1: 写窄接口和 RPC envelope RED测试**

固定接口：

```javascript
const backend = createPiSubagentsExecutionBackend({ events, readArtifacts });
await backend.ping();
await backend.spawn({
  dispatchId,
  attemptId,
  agent: "executor",
  task: "Execute approved task",
  cwd: attemptWorkspace,
  output: resultPath,
  timeoutMs: 900_000,
});
await backend.status({ runId, asyncDir });
await backend.interrupt({ runId, asyncDir });
await backend.stop({ runId, asyncDir });
backend.dispose();
```

断言 spawn发出的 RPC参数精确包含：

```javascript
{
  agent: "executor",
  task: "Execute approved task",
  cwd: attemptWorkspace,
  context: "fresh",
  worktree: false,
  async: true,
  clarify: false,
  output: resultPath,
  outputMode: "file-only",
  acceptance: false,
  artifacts: true,
  timeoutMs: 900000,
}
```

- [ ] **Step 2: 增加 caller requestId和错误码**

`createSubagentsRpcClient.call()` 接受 `{requestId}`；request ID必须匹配 `^[A-Za-z0-9._-]{1,160}$`。错误 reply抛出：

```javascript
export class SubagentsRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SubagentsRpcError";
    this.code = code;
  }
}
```

`spawn(params, {requestId: dispatchId})` 不声称幂等；重复调用同一 dispatchId由 Plan事件状态机阻止。

- [ ] **Step 3: 绑定 lifecycle facts**

Backend监听：

```text
subagent:async-started
subagent:async-complete
```

只接受 `event.cwd === authorizedAttempt.workspace.path` 且 sessionId等于当前 Plan Session。归一化为：

```javascript
{
  type: "execution.started|execution.completed",
  dispatchId,
  attemptId,
  runId: event.id,
  asyncDir: event.asyncDir,
  cwd: event.cwd,
  state,
  observedAt,
}
```

`dispatchId/attemptId` 从 backend内存中的 pending map按唯一 cwd取得；匹配0个或多个时返回 protocol violation，不猜测。

- [ ] **Step 4: 在Standalone Plan Runner装配公开服务**

`plan-capsule-extension.mjs`只从当前Pi event bus创建stable RPC client，不导入`pi-subagents/src/**`：

```javascript
const rpc = createSubagentsRpcClient(pi.events);
const backend = createPiSubagentsExecutionBackend({
  rpc,
  events: pi.events,
  readArtifacts,
});
const capabilities = await backend.assertCapabilities({
  rpcVersion: 1,
  methods: ["ping", "spawn", "status", "interrupt", "stop"],
});
assert.equal(typeof capabilities.sessionId, "string");
```

Standalone进程启动时必须断言`PI_SUBAGENT_CHILD`和`PI_SUBAGENT_FANOUT_CHILD`均不存在，且官方extension已注册`subagent_wait`和`subagent_supervisor`。Plan Agent active tools移除`subagent`；`tool_call` hook对任何`subagent`调用返回block。Executor使用独立profile，active tools只包含Task授权工具与`contact_supervisor`，不包含`subagent`。capability或版本漂移时拒绝打开Plan。

- [ ] **Step 5: 实现 artifact权威读取**

`runtime-artifacts.mjs` 必须从已绑定 `asyncDir/status.json`读取 `runId/sessionId/state/cwd/pid/startedAt/endedAt/results/sessionFile/outputFile`；status RPC只用于触发上游 reconcile，不解析格式化 text。artifact的 cwd、runId或sessionId与 binding不一致时拒绝。

- [ ] **Step 6: 运行测试并提交**

```bash
node --test test/subagents-rpc-client.test.mjs test/plan-execution-backend.test.mjs test/plan-runtime-artifacts.test.mjs
```

Expected: PASS；Standalone Plan Runner不处于child mode，active tools不含`subagent`，但公开RPC、正式`subagent_wait`和Supervisor parent channel均可用。

```bash
git add scripts/lib/subagents-rpc-client.mjs scripts/lib/plan/execution-backend.mjs scripts/lib/plan/pi-subagents-execution-backend.mjs scripts/lib/plan/runtime-artifacts.mjs test/subagents-rpc-client.test.mjs test/plan-execution-backend.test.mjs test/plan-runtime-artifacts.test.mjs
git commit -m "feat(plan): 接入公开子代理执行后端"
```

### Task 7: 重构 Coordinator为 Harness授权与派发

**Deps:** Task 3, Task 4, Task 5, Task 6

**Files:**
- Modify: `scripts/lib/plan/coordinator.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `test/plan-coordinator.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`

- [ ] **Step 1: 写并行派发 RED测试**

构造三个 root Task，其中两个可并行、一个与 `xcode`冲突。调用一次：

```javascript
const result = await deps.continuePlan({ expectedProjectionVersion: 4 }, { ctx });
assert.deepEqual(result.dispatched.map((x) => x.taskId), ["task-1", "task-3"]);
assert.notEqual(result.dispatched[0].cwd, result.dispatched[1].cwd);
assert.equal(result.state, "waiting-executors");
```

断言 Plan Agent没有机会修改 task/cwd/worktree/acceptance；Backend收到的参数来自 IR和Workspace Lease。

- [ ] **Step 2: 实现 authorize-dispatch-bind顺序**

单个 Attempt固定顺序：

```text
allocate workspace
append attempt.workspace-allocated
acquire resources
append attempt.dispatch-requested
backend.spawn
append attempt.bound from started fact or spawn reply
```

`dispatchId` 固定为 `${attemptId}.dispatch.1`。RPC返回前若 started event已绑定，spawn reply必须与既有 runId/asyncDir一致；不一致时 append `plan.blocked`，保留 workspace和run。

- [ ] **Step 3: 删除模型中转派发**

删除 `authorizeNestedSubagent()`、`sameTool()`、`toolMismatchHint()` 和 `plan_continue` 返回的 `tool`。`continuePlan()` 只返回结构化状态：

```javascript
{
  state: "waiting-executors|waiting-resources|ready-to-integrate|ready-to-verify|blocked",
  dispatched: [{ taskId, attemptId, dispatchId, runId, asyncDir, cwd }],
  projectionVersion,
}
```

`plan-capsule-extension` 继续阻止任何直接 `subagent` tool调用。

- [ ] **Step 4: 实现保守 dispatch恢复**

恢复规则：

```text
bound + artifact running       -> active
bound + artifact terminal      -> settle
requested + matching started fact -> bind
requested + no fact            -> dispatch_uncertain，停止自动派发并保留 workspace
多个 matching fact             -> protocol_violation，停止计划
```

禁止对 `dispatch-requested` 自动重试 spawn。人工恢复只能通过未来显式 reconcile命令绑定一个已验证 run或取消该 Attempt。

- [ ] **Step 5: 运行测试并提交**

```bash
node --test test/plan-coordinator.test.mjs test/plan-runner-dependencies.test.mjs
```

Expected: PASS，包括 task-2先于task-1完成仍精确结算对应 Attempt。

```bash
git add scripts/lib/plan/coordinator.mjs scripts/lib/plan/plan-runner-dependencies.mjs test/plan-coordinator.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "refactor(plan): 由控制面直接派发尝试"
```

### Task 8: 接入正式wait与两级Attention控制

**Deps:** Task 3, Task 6, Task 7

**Files:**
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `pi/agents/plan-runner.md`
- Modify: `pi/child-extensions/plan-runner.ts`
- Modify: `test/plan-capsule-extension.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`
- Modify: `test/plan-attention.test.mjs`

- [ ] **Step 1: 写 active wait和Attention RED测试**

断言Standalone Plan Runner运行时active工具集合精确为：

```javascript
[
  "plan_open", "plan_status", "plan_continue", "plan_verify", "plan_block",
  "subagent_wait", "subagent_supervisor",
  "read", "grep", "bash",
]
```

`subagent`和`contact_supervisor`始终不可见、不可调用。projection含active Attempt时，`agent_settled`发送follow-up执行有界控制循环，不发送新的`plan_continue`：先调用`subagent_supervisor({action:"pending"})`；无请求时调用`subagent_wait({all:false,timeoutMs:1000})`；wait返回或超时后再次检查pending。terminal completion由wait收敛，native request由Supervisor pending/reply处理。禁止假设native request会立即打断正在阻塞的wait。

- [ ] **Step 2: 持久化 native supervisor消息**

`message_end` 识别 `customType === "subagent_supervisor_request"`，验证 details中的 `requestId/runId/reason/agent/childIndex` 与 active binding匹配，然后 append `attempt.attention-requested`。message正文保存到 `var/plan-runs/<planId>/attention/<requestId>.md`，状态事件只保存 path和 SHA-256。

- [ ] **Step 3: 给native reply和durable escalation增加fencing**

`tool_call`与Plan Control规则：

```text
subagent_supervisor reply: requestId必须绑定当前未解决Executor请求
attention.escalated: 原子写Plan event、Markdown body path和SHA-256
Root reply: 必须携带requestId和expectedProjectionVersion写入durable command inbox
stale或重复reply: 返回conflict，不恢复Attempt
```

Root reply成功消费后append`attempt.attention-resolved`，再由`subagent_supervisor`回复原Executor session。如果答案改变Plan scope、allowed paths、resources或依赖，不恢复旧Attempt；写amendment并把旧Attempt标为cancelled。native channel只负责Executor与Plan Runner实时传输，Plan event和command inbox负责Root往返恢复。

- [ ] **Step 4: 固定 Plan Runner prompt**

`pi/agents/plan-runner.md`明确：

```text
active Attempt存在时执行有界控制循环：先查subagent_supervisor pending；无请求时调用subagent_wait({all:false,timeoutMs:1000})，返回或超时后再查pending；
不能假设native Supervisor request会立即唤醒正在阻塞的wait，也不能无等待地忙轮询；
计划内已有答案可直接用subagent_supervisor回复；
Scope、Contract、外部副作用和用户偏好必须持久化AttentionRequest并等待Root control reply；
正常完成不创建AttentionRequest；
不得调用subagent或contact_supervisor。
```

`plan-runner.ts`装配`PiSubagentsExecutionBackend`和durable Plan Control consumer，不装配自建`spawnPiAgent`，也不deep import`pi-subagents`内部模块。

- [ ] **Step 5: 运行测试并提交**

```bash
node --test test/plan-attention.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
```

Expected: PASS；两个并发Executor请求按requestId分别回复，Root control reply经过projection version fencing且重启后可恢复，不串线。

```bash
git add scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/plan-runner-dependencies.mjs pi/agents/plan-runner.md pi/child-extensions/plan-runner.ts test/plan-attention.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "feat(plan): 增加执行请求逐级通信"
```

### Task 9: 验证 Attempt提交、路径所有权与证据

**Deps:** Task 2, Task 4, Task 7

**Files:**
- Create: `scripts/lib/plan/attempt-validator.mjs`
- Create: `test/plan-attempt-validator.test.mjs`
- Modify: `scripts/lib/plan/gates.mjs`
- Modify: `test/plan-gates.test.mjs`

- [ ] **Step 1: 写 Git结果验证 RED测试**

覆盖：无commit、HEAD等于base、非base后代、merge commit、dirty worktree、untracked文件、修改越界、symlink逃逸、`.git`修改、验证命令失败和合法单commit。

合法结果：

```javascript
assert.deepEqual(await validateAttemptResult({ lease, allowedPaths, verification }), {
  accepted: true,
  attemptId: lease.attemptId,
  baseCommit: lease.baseCommit,
  resultCommit,
  changedPaths: ["src/a.mjs", "test/a.test.mjs"],
  diffSha256,
  evidence: [{ kind: "command", command: "node --test test/a.test.mjs", exitCode: 0, stdoutPath, stderrPath }],
});
```

- [ ] **Step 2: 实现 Git和路径检查**

只调用：

```text
git rev-parse HEAD
git merge-base --is-ancestor <base> <head>
git rev-list --parents <base>..<head>
git status --porcelain=v1 -z
git diff --name-status -z <base>..<head>
git diff --binary <base>..<head>
```

要求恰好一个非merge commit。changed path规范化后必须匹配exact path或末尾 `/**` prefix；rename的source和destination都必须授权。

- [ ] **Step 3: 运行Task级verification**

v2 Task可从 Execution Contract的 `taskVerification[taskId]`读取命令ID；命令ID映射到受控 command registry，不接受Task正文中的任意 shell字符串。首版 registry只允许仓库 `package.json` scripts和顶层 contract已有 verification命令。

- [ ] **Step 4: 运行测试并提交**

```bash
node --test test/plan-attempt-validator.test.mjs test/plan-gates.test.mjs
```

Expected: PASS。

```bash
git add scripts/lib/plan/attempt-validator.mjs scripts/lib/plan/gates.mjs test/plan-attempt-validator.test.mjs test/plan-gates.test.mjs
git commit -m "feat(plan): 增加尝试结果验证"
```

### Task 10: 实现单Writer Integration Queue

**Deps:** Task 5, Task 9

**Files:**
- Create: `scripts/lib/plan/integration-queue.mjs`
- Create: `test/plan-integration-queue.test.mjs`
- Modify: `scripts/lib/plan/coordinator.mjs`
- Modify: `test/plan-coordinator.test.mjs`

- [ ] **Step 1: 写串行集成 RED测试**

从相同 base创建两个不重叠 Attempt commit，按 Plan文档顺序入队，即使 task-2先完成也断言：

```javascript
assert.deepEqual(integrationEvents.map((event) => event.data.taskId), ["task-1", "task-2"]);
assert.equal(await git(accumulator, "rev-list", "--count", `${baseCommit}..HEAD`), "2");
```

覆盖 stale accumulator HEAD、cherry-pick冲突、重复 enqueue、重复 integrate、Plan取消、验证结果hash不匹配和cleanup失败。

- [ ] **Step 2: 实现 queue和owner token**

公开接口：

```javascript
const queue = createIntegrationQueue({ accumulator, integrationOwnerToken, git });
queue.enqueue(validatedAttempt);
await queue.drain({ expectedHead });
```

只有 Plan Runner装配时生成的 `integrationOwnerToken` 可 drain。队列排序为 IR node order；依赖未 integrated的Attempt不能入队。

- [ ] **Step 3: 实现原子集成状态迁移**

每项顺序：

```text
append integration.requested(expectedHead,resultCommit,diffSha256)
git cherry-pick resultCommit
read new HEAD
append integration.finished(previousHead,newHead)
release resource claims
release attempt workspace with integrated-cleanup
```

cherry-pick失败时执行 `git cherry-pick --abort`，确认 accumulator回到 expectedHead，append `plan.blocked(reason=integration_conflict)`，保留 Attempt workspace。

- [ ] **Step 4: 接入 Coordinator**

active Attempt settle后先 validate；通过则 append `attempt.validated`并 enqueue。Coordinator每轮先 drain已有 integration queue，再计算下一 frontier，保证下游Task从最新 accumulator HEAD创建。

- [ ] **Step 5: 运行测试并提交**

```bash
node --test test/plan-integration-queue.test.mjs test/plan-coordinator.test.mjs
```

Expected: PASS。

```bash
git add scripts/lib/plan/integration-queue.mjs scripts/lib/plan/coordinator.mjs test/plan-integration-queue.test.mjs test/plan-coordinator.test.mjs
git commit -m "feat(plan): 增加串行结果集成"
```

### Task 11: 迁移到Standalone Plan Runner与薄Host Runtime

**Deps:** Task 6, Task 8, Task 10

**Files:**
- Create: `scripts/lib/plan/plan-host-runtime.mjs`
- Create: `test/plan-host-runtime.test.mjs`
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`
- Modify: `scripts/lib/plan/parent-lifecycle.mjs`
- Modify: `test/parent-lifecycle.test.mjs`
- Modify: `pi/agents/plan-runner.md`

- [ ] **Step 1: 写薄Host职责与v3 handle的RED测试**

Parent handle固定为：

```javascript
{
  schemaVersion: "pi-plan-handle.v3",
  planId,
  planHash,
  hostRunId,
  pid,
  runDir,
  sessionFile,
  statusPath,
  worktree,
  startedAt,
}
```

`plan-host-runtime`只允许`spawnPlanRunner/status/interrupt/stop/reconcile`，不存在`spawnExecutor`。启动参数固定加载Plan Runner agent、Plan Capsule extension和正常package extensions；启动前若`PI_SUBAGENT_CHILD`或`PI_SUBAGENT_FANOUT_CHILD`存在则fail closed，不通过清除环境变量绕过边界。RED测试还断言Host不能接收Attempt task、agent或Executor cwd。

- [ ] **Step 2: 实现独立进程启动、恢复和停止**

`spawnPlanRunner()`使用当前`spawnPiAgent`中经过测试的进程监管逻辑，但收窄输入：

```javascript
await host.spawnPlanRunner({
  planId,
  planPath,
  planHash,
  cwd: planWorktree,
  extension: planRunnerExtension,
  agent: "plan-runner",
});
```

Host写v3 handle并监听进程退出；`plan-status`读取Plan derived status与Host process artifact，不能把PID存活推导为领域成功；`plan-cancel`先写durable Plan cancel command，再stop进程并读取Host artifact确认终态。旧v1/v2 handle只返回明确迁移错误，禁止自动接管旧PID或旧pi-subagents child run。

- [ ] **Step 3: 实现Root Parent Attention bridge**

薄Host观察Plan derived projection中的新`waiting-attention`，向Root Parent发送一次typed消息：

```javascript
{
  customType: "pi-plan-attention-v1",
  details: { planId, requestId, expectedProjectionVersion, bodyPath, bodySha256 },
}
```

Host只转发引用，不复制prompt或凭据。Root Parent通过现有Plan Control API写入`attention.reply`command；Plan Runner消费command、append领域事件并用native`subagent_supervisor`回复Executor。Host重启后从Plan event log重新发现未解决请求，用`planId/requestId/projectionVersion`去重。

- [ ] **Step 4: 保证Standalone Plan Runner存活**

真实启动后，Standalone Plan Runner在active Attempt期间执行“Supervisor pending -> 有界正式wait -> Supervisor pending”的控制循环；Root Parent离开当前对话不终止Host进程。Plan达到`validated/blocked/cancelled`后退出；`waiting-attention`时保持进程和session可接收durable reply。Host崩溃不改变Plan领域状态，恢复时只attach已验证的v3 handle，不自动重复spawn不确定运行。

- [ ] **Step 5: 运行测试并提交**

```bash
node --test test/plan-host-runtime.test.mjs test/plan-launcher-extension.test.mjs test/parent-lifecycle.test.mjs
```

Expected: PASS；Host只管理一个Standalone Plan Runner，Plan Runner通过官方RPC管理Executor，Root reply可在Host重启后恢复。

```bash
git add scripts/lib/plan/plan-host-runtime.mjs scripts/lib/plan/plan-launcher-extension.mjs scripts/lib/plan/parent-lifecycle.mjs pi/agents/plan-runner.md test/plan-host-runtime.test.mjs test/plan-launcher-extension.test.mjs test/parent-lifecycle.test.mjs
git commit -m "refactor(plan): 引入独立计划运行器宿主"
```

### Task 12: 建立 Synthetic Repo故障与恢复矩阵

**Deps:** Task 8, Task 10, Task 11

**Files:**
- Create: `test/plan-parallel-harness.integration.mjs`
- Create: `test/fixtures/plan-harness/executor-extension.ts`
- Create: `test/fixtures/plan-harness/reviewer-extension.ts`
- Create: `test/fixtures/plan-harness/plans/parallel-success.md`
- Create: `test/fixtures/plan-harness/plans/resource-serialized.md`
- Create: `test/fixtures/plan-harness/plans/integration-conflict.md`
- Create: `test/fixtures/plan-harness/plans/attention-roundtrip.md`
- Modify: `test/fixtures/deterministic-provider.mjs`
- Modify: `test/package-scripts.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写无交集并行和资源串行场景**

`parallel-success.md`含两个root Task写不同路径，断言运行时间重叠、cwd不同、base相同、两个commit按文档顺序集成并最终validated。`resource-serialized.md`两个root都声明`xcode:exclusive`，断言第二个只在第一个释放claim后spawn。全部Agent运行加载`test/fixtures/deterministic-provider.mjs`并固定`fake/deterministic`，故障矩阵不得依赖外部Provider或模型可用性。

- [ ] **Step 2: 写安全拒绝场景**

覆盖：路径越界、symlink逃逸、dirty result、缺commit、merge commit、Task验证失败、RPC started/reply不一致、一个workspace匹配多个run、stale base、patch hash篡改和cherry-pick冲突。每个场景断言 accumulator未被污染、Attempt workspace保留、Plan不是validated。

- [ ] **Step 3: 写Supervisor和生命周期场景**

真实Executor分别发`progress_update`、`need_decision`、`interview_request`；验证progress不阻塞，后两者使Attempt进入`waiting-attention`。Plan Runner可直接回答计划内问题；scope问题写入durable AttentionRequest，由薄Host通知Root Parent，Root control reply再恢复原Executor session。两个并发request按requestId和projection version分别回复，Host或Plan Runner重启后不重复通知、不串线。

- [ ] **Step 4: 写崩溃恢复场景**

覆盖：薄Host在Plan Runner启动前退出、Standalone Plan Runner启动后handle落盘前退出、Executor started event后Plan Runner退出、spawn reply后bound前退出、Executor terminal后settle前退出、integration.requested后cherry-pick前退出、cherry-pick后integration.finished前退出、cleanup中断。恢复必须从Plan events、Host v3 handle、pi-subagents lifecycle artifacts和Git HEAD判定唯一下一动作；无法证明唯一性的Plan Runner或Executor dispatch窗口进入`dispatch_uncertain`，不得重复spawn。

- [ ] **Step 5: 注册并运行真实集成命令**

在 `package.json` 增加：

```json
"test:plan-harness": "node --test test/plan-parallel-harness.integration.mjs"
```

运行：

```bash
PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness
```

Expected: PASS，并输出每个scenario名称、Plan终态和validatedHead，不输出transcript或secret。

- [ ] **Step 6: 提交故障矩阵**

```bash
git add test/plan-parallel-harness.integration.mjs test/fixtures/plan-harness test/fixtures/deterministic-provider.mjs test/package-scripts.test.mjs package.json
git commit -m "test(plan): 增加并行执行故障矩阵"
```

### Task 13: 删除自建Executor Runtime并冻结Host边界

**Deps:** Task 11, Task 12

**Files:**
- Delete: `scripts/lib/runtime/spawn.mjs`
- Delete: `scripts/lib/runtime/monitor.mjs`
- Delete: `scripts/lib/runtime/control.mjs`
- Delete: `scripts/lib/runtime/stream.mjs`
- Delete: `scripts/lib/runtime/index.mjs`
- Delete: `test/plan-runtime-spawn.test.mjs`
- Delete: `test/plan-runtime-monitor.test.mjs`
- Delete: `test/plan-runtime-control.test.mjs`
- Create: `test/plan-runtime-migration.test.mjs`
- Modify: `scripts/lib/plan/plan-host-runtime.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `scripts/lib/plan/tui/plan-widget.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`

- [ ] **Step 1: 写Host/Executor边界RED测试**

断言五个通用自建Runtime文件和三个旧测试均不存在；Executor生产路径中不出现：

```text
spawnPiAgent
createMonitor
stopAgent
interruptAgent
child_process.spawn
PI_SUBAGENT_DEPTH手工注入
PI_SUBAGENT_CHILD清除或伪造
```

同时断言`plan-runner-dependencies.mjs`只依赖`createPiSubagentsExecutionBackend`派发Executor；全仓唯一允许直接创建Plan Runner进程的模块是`plan-host-runtime.mjs`，且其公开API不接受Task、Executor agent或Attempt cwd。

- [ ] **Step 2: 将Widget改为artifact projection**

`plan-widget.mjs`只读取Plan`status.json`、Host v3 handle摘要和已绑定pi-subagents artifact摘要；不tail stdout、不解析模型文本、不把PID存活推断为领域状态。展示`plan-host/task/attempt/run/state/attention/integration`，所有领域内容来自typed projection。

- [ ] **Step 3: 收敛薄Host并删除通用Runtime**

把Standalone Plan Runner所需的最小spawn、signal和process artifact逻辑内聚到`plan-host-runtime.mjs`，不保留可复用于Executor的通用spawn API。删除表中八个旧文件并清除imports和fixtures。保留`runtime-artifacts.mjs`，因为它读取的是官方pi-subagents Executor生命周期事实。

- [ ] **Step 4: 运行迁移测试并提交**

```bash
node --test test/plan-runtime-migration.test.mjs test/plan-host-runtime.test.mjs test/plan-launcher-extension.test.mjs
```

Expected: PASS；只有薄Host能启动Standalone Plan Runner，所有Executor生命周期均由官方`pi-subagents`处理。

```bash
git add -A scripts/lib/runtime test/plan-runtime-spawn.test.mjs test/plan-runtime-monitor.test.mjs test/plan-runtime-control.test.mjs scripts/lib/plan/plan-host-runtime.mjs scripts/lib/plan/plan-runner-dependencies.mjs scripts/lib/plan/tui/plan-widget.mjs test/plan-runtime-migration.test.mjs test/plan-launcher-extension.test.mjs
git commit -m "refactor(plan): 删除自建执行器运行时"
```

### Task 14: 更新文档、Doctor和最终验收

**Deps:** Task 12, Task 13

**Files:**
- Modify: `docs/pi-plan-execution-capsule.md`
- Modify: `docs/superpowers/plans/2026-07-23-plan-runner-self-built-runtime.md`
- Create: `docs/knowledge/plan-runner-pi-subagents-harness.md`
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: 标记旧计划被替代**

在旧自建Runtime计划标题下增加：

```markdown
> **状态：已被替代。** 后续执行以 `docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md` 为准；IR工作和薄Host进程监管保留，通用自建Executor Runtime方向废止。
```

不改写旧计划历史内容。

- [ ] **Step 2: 写运行、恢复和边界文档**

`docs/knowledge/plan-runner-pi-subagents-harness.md`必须说明：Standalone Plan Runner与薄Host边界、三类事实源、per-attempt worktree、resource claims、正式wait、Supervisor加durable Control两跳、dispatch uncertain、Integration Queue、失败现场保留、显式merge-back和旧v1/v2 handle不自动接管。

- [ ] **Step 3: 扩展Doctor**

Doctor检查：Pi版本属于已实测集合0.82.0/0.82.1、`pi-subagents@0.37.0`、`typebox@1.1.38`、从pi-subagents路径可解析`typebox/compile`、RPC v1 methods、Standalone Plan Runner拒绝child/fanout环境并重建自己的session identity、Plan Agent无`subagent`但有`subagent_wait/subagent_supervisor`、Executor生产路径不引用通用自建Runtime、薄Host API不能派发Executor、Plan状态目录被Git忽略。错误消息包含具体缺口；RPC status格式化文本只用于确认run/state，typed activity读取官方status artifact。

- [ ] **Step 4: 运行完整自动验收**

```bash
npm test
npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:integration
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
PI_REAL_BIN="$(command -v pi)" npm run test:plan
PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness
git diff --check
```

Expected: 全部PASS；`git diff --check`无输出。

- [ ] **Step 5: 执行独立审查**

审查必须重点检查：Agent是否仍可直接派发、两个writer是否可能共享cwd、资源锁是否可绕过、dispatch uncertain是否会重试spawn、旧reply是否可跨projection生效、integration是否存在多writer，以及任一Gate是否能对stale HEAD通过。Critical或Important finding不为0时保持Plan未完成。

- [ ] **Step 6: 检查工作区和提交文档**

```bash
git status --short --branch
git diff --check
```

Expected: 预存脏文件保持原样；本计划新增变化只落在各Task声明路径。没有session、transcript、token、`var/plan-runs`、`var/plan-worktrees`或`.env`进入Git。执行者逐项对照Task 1开始前记录的`git status --porcelain=v1`基线，不以“工作区必须clean”作为验收条件。

```bash
git add docs/pi-plan-execution-capsule.md docs/superpowers/plans/2026-07-23-plan-runner-self-built-runtime.md docs/knowledge/plan-runner-pi-subagents-harness.md scripts/doctor.mjs test/doctor.test.mjs README.md
git commit -m "docs(plan): 固化并行执行运行手册"
```

## Terminal Gate

只有以下条件全部满足，迁移才可声明完成：

- `pi-subagents@0.37.0`与`typebox@1.1.38`真实兼容门禁通过，包括公开RPC、正式wait、native Supervisor、精确cwd、Standalone session重建和`nestedEvents=0`。
- Standalone Plan Runner不带child/fanout环境；Plan Agent无法调用`subagent`，所有Executor spawn均由Plan Capsule通过typed RPC执行。
- 薄Host只能启动、监管和停止Standalone Plan Runner，不能派发Executor或修改Plan领域状态。
- 每个active Attempt拥有不同cwd、branch、owner token和base commit。
- 路径冲突、resource conflict和capacity均在spawn前阻止。
- started fact、spawn reply、artifact binding和Plan event一致；不确定dispatch不会自动重试。
- Executor向Plan Runner发起AttentionRequest可保持原Session存活；Plan Runner经durable Plan Control与Root Parent完成第二跳并按requestId/projection version回复。
- 每个result commit通过ancestry、single-commit、cleanliness、allowed paths和Task验证。
- 只有Integration Queue能写accumulator，且按确定顺序推进HEAD。
- Host退出、Standalone Plan Runner退出、Parent切换对话、Plan Runner恢复、Executor崩溃和cleanup失败均通过故障矩阵。
- 通用自建Executor Runtime生产代码和测试已删除；薄Host边界测试通过。
- 四类Gate全部绑定同一clean HEAD，`validatedHead === headCommit`。
- 完整自动测试、Doctor、真实集成和独立审查全部通过。

## What This Plan Cannot Prove Before Execution

- `pi-subagents@0.37.0`后续版本是否移除显式TypeBox需求；任何升级都必须重新执行Task 1，不能依据上游CHANGELOG直接放行。
- 真实模型在长时间`subagent_wait`期间是否会受到Provider或宿主进程的额外超时；真实集成测试必须覆盖超过旧60秒阈值的任务。
- RPC spawn之后、`subagent:async-started`之前的极小崩溃窗口无法由当前上游协议证明唯一run；本计划明确进入`dispatch_uncertain`，不声称exactly-once自动恢复。
- 当前checkout内`plan-runner-dependencies.mjs`已有一版并行`spawnPiAgent`半成品；Task 6和Task 13以新RED测试迁移该代码，不回退其他用户改动，也不把它作为可接受基线。

## 自审结果

- 需求覆盖：typed tool控制、公开RPC backend、Standalone Plan Runner、薄Host、per-attempt worktree、资源锁、Attention两跳、验证、集成、恢复和Executor Runtime删除均有对应Task。
- 依赖顺序：Standalone兼容门禁先于协议和backend；workspace与锁先于并行派发；验证先于集成；薄Host迁移和真实故障矩阵先于删除通用Executor Runtime。
- 状态边界：Plan event、pi-subagents artifact和Git结果三类事实没有相互替代。
- 安全边界：不执行Agent生成的编排脚本，不暴露自由`subagent`，不使用`worktree:true`，不自动rebase或merge-back。
- 恢复边界：已绑定Plan Runner和Executor run可恢复；未绑定且无法证明唯一性的dispatch明确fail closed。
- 提交边界：每个commit只包含一个逻辑切片，message符合中文Conventional Commits；实际执行时仍需遵守用户对commit的授权。
