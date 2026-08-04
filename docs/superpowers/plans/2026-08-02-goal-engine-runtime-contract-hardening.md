# Goal Engine 运行时合同加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 Goal Engine 七个 typed tools 在当前 Pi 中的真实可调用性，并把 workspace 集成、处置、恢复和下一步动作下沉到可重放状态机。

**Architecture:** 保留现有 JSONL 事件源、独立 worktree 和 dispatch-ir.v1 边界；新增兼容旧日志的 v2 事件、三阶段 workspace disposition 协议和纯 projection 动作推导。所有 Git 副作用先持久化意图、再执行、再记录应用结果、最后清理并记录终态，使进程在任一边界退出后都能通过普通测试和显式工具重试恢复。

**Tech Stack:** Node.js ESM、node:test、Pi ExtensionAPI、TypeBox 兼容 JSON schema、Git worktree/cherry-pick/merge

## Global Constraints

- 完善期间禁止把任何 Goal Engine 工具用于当前会话或任务编排：`goal_init`、`goal_status`、`goal_dispatch`、`goal_settle`、`goal_accept`、`goal_amend`、`goal_integrate`。
- 完善期间禁止调用任何 Plan Runner 工具：`plan_run`、`plan_attention_reply` 及 `/plan-run` 生命周期入口。
- 允许 `node --test` 在临时目录内直接执行 ToolDefinition 以复现和验收 ABI/状态机；这类隔离测试不得读取或推进当前仓库的真实 Goal 状态。
- 其余验证只能使用普通文件工具、`node --test`、`npm run doctor`、Git 命令和用户明确选择后的普通 subagent/inline 执行。
- 不得手工编辑 `.state/goal-engine/**` 制造通过状态；测试必须在临时目录生成真实事件和 worktree。
- 所有逻辑变更严格执行 RED → GREEN → REFACTOR；每个 RED 必须先观察到预期失败。
- 先维护 `docs/bugs/bug-goal-engine-tools-use-obsolete-handler-api.md`，不得绕过 bug-first 门禁。
- 读取兼容 `goal-engine.event.v1` 历史日志；当前代码只写 `goal-engine.event.v2`。
- `goal_accept` 只接受当前 attempt 已完成 `integrated + released` disposition 的 succeeded task。
- `goal_status` 的 task actions 只能由 projection 推导，不能依赖进程内 `activeLeases` 或磁盘探测。
- 与 `scripts/lib/plan/**`、`scripts/lib/goal-contract/**` 和 `scripts/lib/subagent-dispatch/**` 保持零代码依赖。
- 不修改当前工作区中既有的 Todo、Plan Runner、Settings、Subagent Runtime 及 `test/helpers/pi-host.mjs` 未提交成果。
- 不引入新 npm 依赖，不改变公开的七个 Goal Engine 工具名称。
- 本计划不修复跨仓 executor Extension 路径、不编写 coordinator Skill、不执行最终生产 Harness；三者在本阶段稳定后分别建独立计划。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `docs/bugs/bug-goal-engine-tools-use-obsolete-handler-api.md` | 记录当前 Pi ABI 故障的六要素根因分析 |
| `scripts/lib/goal-engine/extension.mjs` | 注册标准 Pi `execute` 工具；编排 dispatch、settle、disposition、accept |
| `scripts/lib/goal-engine/events.mjs` | v1/v2 事件兼容、workspace 三阶段 projection、accept/DAG 硬门禁 |
| `scripts/lib/goal-engine/graph.mjs` | runnable frontier、每 task 的 allowed/required actions 推导 |
| `scripts/lib/goal-engine/store.mjs` | 继续从 JSONL 重放并序列化新增 projection 字段 |
| `scripts/lib/goal-engine/workspace.mjs` | worktree 变更边界、Git 已应用检测、资源清理状态检查 |
| `scripts/lib/goal-engine/audit.mjs` | 识别 legacy acceptance、未完成 disposition 和残留资源信号 |
| `test/goal-engine-runtime.integration.mjs` | 使用真实 Pi host 加载 Extension 并调用 ToolDefinition.execute |
| `test/goal-engine-extension.test.mjs` | 七工具 ABI、三阶段 disposition、恢复和非法时序集成测试 |
| `test/goal-engine-events.test.mjs` | v2 状态机与 v1 历史重放测试 |
| `test/goal-engine-graph.test.mjs` | allowedActions/requiredNextAction 和 DAG frontier 测试 |
| `test/goal-engine-workspace.test.mjs` | changedFiles、writePaths、patch-equivalence 和资源状态测试 |
| `test/goal-engine-audit.test.mjs` | 新审计信号和历史兼容测试 |
| `scripts/doctor.mjs` | 检查 Goal Engine 注册定义具备 execute ABI |
| `test/doctor.test.mjs` | Doctor 对缺失 execute 的回归测试 |

---

### Task 1: 恢复当前 Pi ToolDefinition ABI

**Files:**
- Existing: `docs/bugs/bug-goal-engine-tools-use-obsolete-handler-api.md`
- Modify: `scripts/lib/goal-engine/extension.mjs:16-455`
- Modify: `test/goal-engine-extension.test.mjs:1-284`
- Create: `test/goal-engine-runtime.integration.mjs`

**Interfaces:**
- Produces: `registerGoalTool(pi, definition)`，只向 Pi 注册 `execute(toolCallId, params, signal, onUpdate, ctx)`，并把真实 `ctx` 传给领域 handler。
- Produces: `executionScope(ctx)`，只从非空绝对 `ctx.cwd` 推导 `{ cwd, root }`，禁止回退到 `pi.cwd` 或 `process.cwd()`。
- Produces: `toolResult(value)`，返回 `{ content: [{ type: "text", text }], details: { value } }`。
- Preserves: 七个工具的参数 schema、工具名称、领域 handler 抛错语义和文本/JSON 内容。

- [ ] **Step 1: 写七工具 ABI RED**

在 `test/goal-engine-extension.test.mjs` 将注册测试改为同时断言：

```javascript
for (const definition of pi.tools) {
  assert.equal(typeof definition.execute, "function", `${definition.name} must expose execute`);
  assert.equal(Object.hasOwn(definition, "handler"), false, `${definition.name} must not expose handler`);
}
```

并增加统一调用器，后续测试不得再直接调用 `.handler`：

```javascript
async function invoke(pi, name, params = {}) {
  const definition = pi.tools.find((tool) => tool.name === name);
  assert.ok(definition, `missing tool: ${name}`);
  const result = await definition.execute(
    `test-${name}`,
    params,
    new AbortController().signal,
    undefined,
    { cwd: pi.cwd },
  );
  assert.deepEqual(result.content.map((part) => part.type), ["text"]);
  return { result, text: result.content[0].text };
}
```

- [ ] **Step 2: 运行 ABI RED 并确认因 execute 缺失失败**

Run:

```bash
node --test --test-name-pattern='registers seven goal engine tools' test/goal-engine-extension.test.mjs
```

Expected: FAIL，错误包含 `goal_init must expose execute`，而不是测试语法或 fixture 错误。

- [ ] **Step 3: 写真实 Pi host RED**

创建 `test/goal-engine-runtime.integration.mjs`，直接使用全局安装的 Pi host，不依赖当前未提交的 `test/helpers/pi-host.mjs`：

```javascript
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works/pi-coding-agent");
const piModule = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const { createAgentSession, DefaultResourceLoader, SessionManager } = piModule;

test("real Pi host executes goal_status through ToolDefinition.execute", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "goal-engine-host-"));
  let result;
  try {
    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir,
      additionalExtensionPaths: [join(repoRoot, "pi/extensions/goal-engine.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    result = await createAgentSession({
      cwd: repoRoot,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(repoRoot),
    });
    const errors = [];
    await result.session.bindExtensions({
      mode: "rpc",
      shutdownHandler() {},
      onError(error) { errors.push(error); },
    });
    const status = result.session.getToolDefinition("goal_status");
    const output = await status.execute(
      "goal-status-real-host",
      {},
      new AbortController().signal,
      undefined,
      undefined,
    );
    assert.equal(output.content[0].text, "NO_ACTIVE_GOAL");
    assert.deepEqual(errors, []);
  } finally {
    if (result) {
      await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      result.session.dispose();
    }
    await rm(agentDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: 运行真实 host RED 并确认同一 ABI 故障**

Run:

```bash
node --test test/goal-engine-runtime.integration.mjs
```

Expected: FAIL，调用处报告 `definition.execute is not a function` 或 status definition 缺少 execute。

- [ ] **Step 5: 实现最小注册适配层**

在 `scripts/lib/goal-engine/extension.mjs` 增加：

```javascript
function toolResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    details: { value },
  };
}

function registerGoalTool(pi, definition) {
  const { handler, ...publicDefinition } = definition;
  if (typeof handler !== "function") throw new Error(`Goal tool ${definition.name} is missing its domain handler`);
  pi.registerTool({
    ...publicDefinition,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await handler(params, ctx));
    },
  });
}
```

仅将七处 `pi.registerTool({ ... })` 改成 `registerGoalTool(pi, { ... })`；内部领域函数改为 `handler(params, ctx)`，每次调用通过 `executionScope(ctx)` 获取当前项目 cwd/root。Extension factory 和 `tool_result` hook 均不得读取 `pi.cwd` 或 `process.cwd()`。

评审补充 RED：真实 Host 测试必须创建不同的 `processCwd` 与 `projectCwd`，隔离调用 `goal_init` 后只允许 `projectCwd/.state/goal-engine/registry.json` 存在；`processCwd` 和当前仓库不得产生 Goal 状态。该 RED 修复记录见 `docs/bugs/bug-goal-engine-extension-uses-process-cwd.md`。

- [ ] **Step 6: 将 Extension 测试调用迁移到 execute**

把现有：

```javascript
const init = pi.tools.find((t) => t.name === "goal_init");
const result = JSON.parse(await init.handler(params));
```

统一改为：

```javascript
const { text } = await invoke(pi, "goal_init", params);
const result = JSON.parse(text);
```

对预期异常使用：

```javascript
await assert.rejects(() => invoke(pi, "goal_settle", invalidParams), /specific/i);
```

- [ ] **Step 7: 运行 GREEN 和完整 Goal Engine 回归**

Run:

```bash
node --test test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
node --test test/goal-engine-*.test.mjs
```

Expected: 两条命令全部 PASS；真实 host 输出不含 Extension error。

- [ ] **Step 8: 提交 ABI 修复**

```bash
git add docs/bugs/bug-goal-engine-tools-use-obsolete-handler-api.md \
  scripts/lib/goal-engine/extension.mjs \
  test/goal-engine-extension.test.mjs \
  test/goal-engine-runtime.integration.mjs
git commit -m "fix(goal-engine): 修复工具执行接口"
```

---

### Task 2: 增加 v2 workspace disposition 事件模型

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/goal-engine/events.mjs:1-265`
- Modify: `scripts/lib/goal-engine/store.mjs:42-71`
- Modify: `test/goal-engine-events.test.mjs:1-282`

**Interfaces:**
- Reads: `goal-engine.event.v1` 和 `goal-engine.event.v2`。
- Writes: 后续 Extension 事件统一使用 `goal-engine.event.v2`。
- Produces task field:

```javascript
workspace: {
  attempt,
  path,
  branch,
  baseCommit,
  phase,                 // active | disposing | applied | disposed
  requestedAction,       // null | integrate | discard | preserve
  disposition,           // null | integrated | discarded | preserved
  strategy,
  executorHead,
  originHeadBefore,
  originHead,
  released,
}
```

- Produces events: `task.workspace_disposition_started`、`task.workspace_disposition_applied`、`task.workspace_disposed`。

- [ ] **Step 1: 写 v2 dispatch workspace RED**

在 `test/goal-engine-events.test.mjs` 增加 v2 helper，并要求 dispatch 持久化 workspace 身份：

```javascript
function makeV2Event(type, data, goalId = "test-goal") {
  return {
    schemaVersion: "goal-engine.event.v2",
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

// goal.created 后
p = applyEvent(p, makeV2Event("task.dispatched", {
  taskId: "t1",
  contractHash: "hash-1",
  workspace: {
    attempt: 1,
    path: "/repo/.state/goal-engine/worktrees/test-goal-t1-1",
    branch: "ge/test-goal/t1/1",
    baseCommit: "a".repeat(40),
  },
}));
assert.equal(p.tasks.get("t1").workspace.phase, "active");
assert.equal(p.tasks.get("t1").workspace.attempt, 1);
```

- [ ] **Step 2: 写三阶段 disposition RED**

按顺序应用：

```javascript
p = applyEvent(p, makeV2Event("task.workspace_disposition_started", {
  taskId: "t1", attempt: 1, action: "integrate", strategy: "cherry-pick",
  executorHead: "b".repeat(40), originHeadBefore: "a".repeat(40),
}));
assert.equal(p.tasks.get("t1").workspace.phase, "disposing");

p = applyEvent(p, makeV2Event("task.workspace_disposition_applied", {
  taskId: "t1", attempt: 1, action: "integrated",
  strategy: "cherry-pick", executorHead: "b".repeat(40), originHead: "c".repeat(40),
}));
assert.equal(p.tasks.get("t1").workspace.phase, "applied");

p = applyEvent(p, makeV2Event("task.workspace_disposed", {
  taskId: "t1", attempt: 1, action: "integrated", released: true,
}));
assert.equal(p.tasks.get("t1").workspace.phase, "disposed");
assert.equal(p.tasks.get("t1").workspace.disposition, "integrated");
```

另写 RED：attempt 不匹配、action 在三阶段间改变、重复 terminal dispose 均必须抛错。

- [ ] **Step 3: 写 accept guard 和 v1 重放 RED**

新增两个独立测试：

```javascript
test("v2 task.accepted rejects succeeded task without integrated released disposition", () => {
  // created -> dispatched -> settled(succeeded)
  assert.throws(
    () => applyEvent(p, makeV2Event("task.accepted", { taskId: "t1", workspaceAttempt: 1 })),
    /integrated|released/i,
  );
});

test("v1 accepted history replays as legacy unverified acceptance", () => {
  // 全部使用 v1 created/dispatched/settled/accepted/completed
  assert.equal(p.tasks.get("t1").status, "accepted");
  assert.equal(p.tasks.get("t1").acceptanceVerification, "legacy_unverified");
});
```

- [ ] **Step 4: 运行事件 RED**

Run:

```bash
node --test --test-name-pattern='v2|disposition|legacy unverified' test/goal-engine-events.test.mjs
```

Expected: FAIL，原因是 v2 schema 或新事件尚不受支持。

- [ ] **Step 5: 实现双版本 envelope 和 workspace projection**

将常量改为：

```javascript
const WRITABLE_SCHEMA_VERSION = "goal-engine.event.v2";
const READABLE_SCHEMA_VERSIONS = new Set(["goal-engine.event.v1", WRITABLE_SCHEMA_VERSION]);
```

`validateEnvelope` 接受可读版本；`goalCreated` 初始化：

```javascript
workspace: null,
acceptanceVerification: null,
```

`taskDispatched` 对 v2 要求 `data.workspace`，并初始化 `phase: "active"`。`copyProjection` 必须复制 `workspace`：

```javascript
workspace: v.workspace ? { ...v.workspace } : null,
```

- [ ] **Step 6: 实现三阶段事件和 accept 门禁**

在 switch 中传入完整 event：

```javascript
case "task.workspace_disposition_started": workspaceDispositionStarted(next, event.data); break;
case "task.workspace_disposition_applied": workspaceDispositionApplied(next, event.data); break;
case "task.workspace_disposed": workspaceDisposed(next, event.data); break;
case "task.accepted": taskAccepted(next, event); break;
```

`taskAccepted` 规则：

```javascript
if (event.schemaVersion === "goal-engine.event.v1") {
  task.status = "accepted";
  task.acceptanceVerification = "legacy_unverified";
  return;
}
if (task.workspace?.phase !== "disposed" ||
    task.workspace.disposition !== "integrated" ||
    task.workspace.released !== true ||
    task.workspace.attempt !== event.data.workspaceAttempt) {
  throw new Error(`task workspace is not integrated and released: ${taskId}`);
}
task.status = "accepted";
task.acceptanceVerification = "integrated";
```

`discarded` 终态把 succeeded task 重置为 pending；`preserved` 保持当前 task status，但永远不能 accept。

- [ ] **Step 7: 使用事件时间保证重放确定性**

将 evidence 时间戳从：

```javascript
ts: new Date().toISOString()
```

改为从完整 event 传入：

```javascript
ts: event.occurredAt
```

增加测试：同一事件流重放两次，evidence 数组深度相等。

- [ ] **Step 8: 序列化新增字段并运行 GREEN**

`store.mjs` 继续通过 `Object.fromEntries(p.tasks)` 序列化 task；增加 store round-trip 断言，确认 workspace 和 `acceptanceVerification` 出现在 `projection.json` 且从 JSONL 重建一致。

Run:

```bash
node --test test/goal-engine-events.test.mjs
```

Expected: PASS。

- [ ] **Step 9: 提交事件模型**

```bash
git add scripts/lib/goal-engine/events.mjs scripts/lib/goal-engine/store.mjs test/goal-engine-events.test.mjs
git commit -m "feat(goal-engine): 持久化工作区处置状态"
```

---

### Task 3: 增加 Git 应用恢复与 writePaths 边界检查

**Deps:** Task 2

**Files:**
- Modify: `scripts/lib/goal-engine/workspace.mjs:1-185`
- Modify: `test/goal-engine-workspace.test.mjs:1-136`

**Interfaces:**
- Produces: `inspectExecutorWorkspace(lease).changedFiles: string[]`。
- Produces: `assertWorkspaceChangesWithinPaths(inspection, writePaths)`。
- Produces: `isExecutorWorkspaceIntegrated(lease, { strategy, executorHead })`。
- Produces: `inspectExecutorWorkspaceResources(lease)`，返回 `{ workspaceExists, branchExists, leaseExists }`。
- Extends: `integrateExecutorWorkspace` 返回 `executorHead`、`originHeadBefore`、`newHead`、`strategy`。

- [ ] **Step 1: 写 committed changedFiles RED**

增加测试：executor commit 同时修改 `src/allowed.ts` 和 `README.md`，断言：

```javascript
const inspection = inspectExecutorWorkspace(lease);
assert.deepEqual(inspection.changedFiles.sort(), ["README.md", "src/allowed.ts"]);
assert.throws(
  () => assertWorkspaceChangesWithinPaths(inspection, ["src/**"]),
  /README\.md.*writePaths/i,
);
```

另断言精确文件 `src/allowed.ts` 和目录授权 `src/**` 均允许对应文件。

- [ ] **Step 2: 写 Git 已应用检测 RED**

对 cherry-pick：先集成但保留可检查 commit，断言 `isExecutorWorkspaceIntegrated(...) === true`；未集成时为 false。对 merge：断言 executor head 成为 origin HEAD ancestor 时为 true。

- [ ] **Step 3: 写资源状态 RED**

在 release 前后分别断言：

```javascript
assert.deepEqual(inspectExecutorWorkspaceResources(lease), {
  workspaceExists: true,
  branchExists: true,
  leaseExists: true,
});
// release 后三项均 false
```

preserve 后三项保持 true。

- [ ] **Step 4: 运行 workspace RED**

Run:

```bash
node --test test/goal-engine-workspace.test.mjs
```

Expected: FAIL，至少缺少 `changedFiles` 或新导出函数。

- [ ] **Step 5: 实现 changedFiles 和路径匹配**

`inspectExecutorWorkspace` 使用：

```javascript
const changedOutput = headCommit === lease.baseCommit
  ? ""
  : git(lease.path, "diff", "--name-only", `${lease.baseCommit}..${headCommit}`);
const changedFiles = changedOutput.split("\n").filter(Boolean);
```

路径规则与 `dispatch-ir.mjs` 一致：精确路径只匹配自身，`dir/**` 匹配 `dir/` 下所有后代；拒绝任何越界文件并在错误中列出文件名。

- [ ] **Step 6: 实现 patch-equivalence 恢复检查**

merge 策略使用：

```bash
git merge-base --is-ancestor <executorHead> HEAD
```

cherry-pick 策略使用：

```bash
git cherry HEAD <executorHead> <baseCommit>
```

仅当 executor range 中每行都以 `-` 开头时返回 true；`+` 表示该 patch 尚未进入 origin。

- [ ] **Step 7: 扩展 integration result 和资源检查**

在执行 Git 前记录 `originHeadBefore`，返回：

```javascript
return {
  integrated: true,
  executorHead: inspection.headCommit,
  originHeadBefore,
  newHead,
  strategy,
};
```

`inspectExecutorWorkspaceResources` 同时检查 worktree 路径、lease 文件和 origin branch；不得删除任何资源。

- [ ] **Step 8: 运行 GREEN**

Run:

```bash
node --test test/goal-engine-workspace.test.mjs
```

Expected: PASS。

- [ ] **Step 9: 提交 workspace 加固**

```bash
git add scripts/lib/goal-engine/workspace.mjs test/goal-engine-workspace.test.mjs
git commit -m "feat(goal-engine): 校验并恢复工作区集成"
```

---

### Task 4: 将 goal_integrate 改为可恢复三阶段协议

**Deps:** Task 2, Task 3

**Files:**
- Modify: `scripts/lib/goal-engine/extension.mjs:163-430`
- Modify: `test/goal-engine-extension.test.mjs:90-239`

**Interfaces:**
- Consumes: Task 2 的 workspace phase/events。
- Consumes: Task 3 的变更边界、Git 已应用和资源检查函数。
- Produces: `goal_integrate` 幂等恢复流程：started → applied → disposed。
- Changes: `goal_dispatch` 的 v2 event 携带 workspace snapshot。
- Changes: `goal_accept` 的 v2 event 携带 `workspaceAttempt`。

- [ ] **Step 1: 写未 settle integrate RED**

dispatch 后不 settle，直接执行：

```javascript
await assert.rejects(
  () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
  /succeeded/i,
);
```

并断言 origin HEAD、worktree、branch、lease 均未变化。

- [ ] **Step 2: 写未 integrate accept RED**

将旧的 `goal_settle + goal_accept full cycle` 改为：

```javascript
await invoke(pi, "goal_settle", succeededParams);
await assert.rejects(
  () => invoke(pi, "goal_accept", { task_id: "t1" }),
  /integrated|released/i,
);
```

该 RED 必须在修改生产代码前失败，证明旧 oracle 已被反转。

- [ ] **Step 3: 写 no-commit RED**

settle succeeded 但 worktree 无 commit，调用 integrate 必须抛：

```javascript
await assert.rejects(
  () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
  /No commits to integrate/i,
);
```

并断言不得返回 `action: "integrated"`，workspace 仍可选择 discard。

- [ ] **Step 4: 写正常三阶段 GREEN 目标测试**

创建允许路径内 commit，settle succeeded，integrate 后读取 events JSONL：

```javascript
assert.deepEqual(
  events.slice(-3).map((event) => event.type),
  [
    "task.workspace_disposition_started",
    "task.workspace_disposition_applied",
    "task.workspace_disposed",
  ],
);
assert.equal(status.tasks.t1.workspace.disposition, "integrated");
assert.equal(status.tasks.t1.workspace.released, true);
```

随后 `goal_accept` 才成功。

- [ ] **Step 5: 写 Git 成功/事件失败恢复 RED**

为 Extension factory 增加只用于测试的依赖注入选项：

```javascript
createGoalEngineExtension(pi, {
  appendEvent: failingAppendAfterGit,
});
```

第一次 integrate 让 Git 成功、`task.workspace_disposition_applied` append 失败；断言 lease/worktree 保留。新 Extension 实例重试同一 action，必须通过 patch-equivalence 跳过重复 cherry-pick，补写 applied/disposed，最终只产生一份业务变更。

- [ ] **Step 6: 写 cleanup 成功/终态事件失败恢复 RED**

让 `task.workspace_disposed` 第一次 append 失败；断言 projection 停留 applied、资源已释放。重建 Extension 后重试同一 action，必须从 projection workspace snapshot 验证资源均不存在，再补写 disposed，不要求 lease 文件仍存在。

- [ ] **Step 7: 写 discard/preserve/retry RED**

覆盖：

```text
failed settle -> pending + active workspace
pending active workspace -> dispatch rejected
discard -> disposed(discarded, released=true) -> next dispatch attempt+1
preserve -> disposed(preserved, released=false) -> accept/dispatch 均拒绝
```

preserved attempt 再次调用相同 task 的 `goal_integrate(action=discard)` 必须拒绝改变已完成 disposition；后续改变方向需通过独立 amendment/removal 流程，不得静默覆盖事件。

- [ ] **Step 8: 运行 Extension RED 集合**

Run:

```bash
node --test --test-name-pattern='integrate|accept|commit|discard|preserve|event failure' test/goal-engine-extension.test.mjs
```

Expected: 多项 FAIL，均源于缺少新门禁或恢复事件。

- [ ] **Step 9: 实现 v2 dispatch snapshot**

`makeEvent` 改写 v2；`goal_dispatch` event 包含：

```javascript
workspace: {
  attempt: lease.attempt,
  path: lease.path,
  branch: lease.branch,
  baseCommit: lease.baseCommit,
}
```

在分配 workspace 前机械检查 task 位于 `runnableFrontier(projection)`，并拒绝任何未完成的 workspace phase。

- [ ] **Step 10: 实现 disposition started**

在任何 Git/删除副作用前：

1. 读取并检查 task 当前状态和 action。
2. inspect worktree；integrate 要求 succeeded、有 commit、clean、changedFiles 均在 writePaths。
3. append `task.workspace_disposition_started`，记录 action、attempt、strategy、executorHead、originHeadBefore。

如果 projection 已处于 disposing，只允许使用相同 action/strategy 重试。

- [ ] **Step 11: 实现 applied 阶段及 Git 恢复**

integrate action：

```javascript
const alreadyApplied = isExecutorWorkspaceIntegrated(lease, {
  strategy,
  executorHead: workspace.executorHead,
});
const result = alreadyApplied
  ? { executorHead, originHeadBefore, newHead: currentOriginHead, strategy }
  : integrateExecutorWorkspace(lease, { strategy });
```

成功后 append `task.workspace_disposition_applied`。discard/preserve 不修改 origin Git，直接记录相应 applied disposition。

- [ ] **Step 12: 实现 cleanup 和 disposed 阶段**

- integrate/discard：调用 release；检查三项资源均 false；append disposed，`released: true`。
- preserve：不删除资源；检查三项均 true；append disposed，`released: false`。
- projection 已 applied 且资源已不存在时，直接补写 disposed，不重新要求 lease。

`activeLeases` 仅作缓存；所有恢复决策以 projection 为准。

- [ ] **Step 13: 实现 accept v2 参数**

`goal_accept` 从 projection 读取 current workspace attempt，发出：

```javascript
makeEvent("task.accepted", {
  taskId: params.task_id,
  workspaceAttempt: task.workspace.attempt,
}, goalId)
```

不得在 Extension 层复制 accept 规则；最终硬门禁由 `events.mjs` 执行。

- [ ] **Step 14: 运行 GREEN 和全量 Goal Engine 测试**

Run:

```bash
node --test test/goal-engine-extension.test.mjs
node --test test/goal-engine-*.test.mjs
```

Expected: PASS；旧的跳过 integrate 测试已不存在。

- [ ] **Step 15: 提交 lifecycle 加固**

```bash
git add scripts/lib/goal-engine/extension.mjs test/goal-engine-extension.test.mjs
git commit -m "feat(goal-engine): 强制可恢复集成流程"
```

---

### Task 5: 输出机器可读动作并强化 DAG 门禁

**Deps:** Task 4

**Files:**
- Modify: `scripts/lib/goal-engine/graph.mjs:1-40`
- Modify: `scripts/lib/goal-engine/events.mjs:123-214`
- Modify: `scripts/lib/goal-engine/extension.mjs:41-61,315-368`
- Modify: `test/goal-engine-graph.test.mjs:1-84`
- Modify: `test/goal-engine-events.test.mjs`
- Modify: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Produces: `taskActionState(projection, taskId)`。
- Returns per task: `allowedActions: string[]`、`requiredNextAction: object | null`、`blockingReason: string | null`。
- Hard gate: task 只有依赖全部 accepted 才可接收 `task.dispatched`。
- Hard gate: amendment 结束后的完整 DAG 必须无未知依赖和环。

- [ ] **Step 1: 写 action matrix RED**

在 `test/goal-engine-graph.test.mjs` 建立表驱动测试：

```javascript
const cases = [
  ["runnable pending", pendingProjection(), ["goal_dispatch"], "goal_dispatch"],
  ["dispatched", dispatchedProjection(), ["goal_settle"], "goal_settle"],
  ["succeeded active workspace", succeededProjection(), ["goal_integrate"], "goal_integrate"],
  ["disposition in progress", disposingProjection(), ["goal_integrate"], "goal_integrate"],
  ["integrated and released", integratedProjection(), ["goal_accept"], "goal_accept"],
  ["accepted", acceptedProjection(), [], null],
  ["preserved", preservedProjection(), ["goal_amend"], "goal_amend"],
];
```

每项断言 exact allowed actions 和 required tool。

- [ ] **Step 2: 写 blocked pending 和失败 cleanup RED**

依赖未 accepted 的 pending task：`allowedActions=[]`，`blockingReason` 指明依赖。failed settle 后 workspace active：只允许 `goal_integrate`，required params 固定 `{ action: "discard" }`，不得再次 dispatch。

- [ ] **Step 3: 写事件层非 runnable dispatch RED**

直接对 projection 应用下游 task.dispatched：

```javascript
assert.throws(
  () => applyEvent(p, dispatchDownstreamEvent),
  /dependencies.*accepted|not runnable/i,
);
```

确保不是只在 Extension handler 中拦截。

- [ ] **Step 4: 写 amendment 环和未知依赖 RED**

`goal.amended` 更新 deps 形成 `t1 -> t2 -> t1`，以及依赖不存在 task，均必须由 `applyEvent` 拒绝，旧 projection 不变。

- [ ] **Step 5: 运行 RED**

Run:

```bash
node --test test/goal-engine-graph.test.mjs test/goal-engine-events.test.mjs
```

Expected: FAIL，缺少 `taskActionState` 或事件门禁。

- [ ] **Step 6: 实现纯 projection 动作推导**

`taskActionState` 不读取文件系统或 lease Map，返回示例：

```javascript
{
  allowedActions: ["goal_integrate"],
  requiredNextAction: {
    tool: "goal_integrate",
    params: { action: "integrate" },
    reason: "Task succeeded but its workspace has not been integrated and released",
  },
  blockingReason: null,
}
```

对于选择性动作，`allowedActions` 仍按工具名去重；默认安全动作写入 required params。

- [ ] **Step 7: 在事件层强制依赖和 amendment DAG**

`taskDispatched` 直接检查：

```javascript
const blockedDeps = task.deps.filter((dep) => p.tasks.get(dep)?.status !== "accepted");
if (blockedDeps.length > 0) throw new Error(`task dependencies are not accepted: ${blockedDeps.join(", ")}`);
```

`goalAmended` 在临时 next tasks 完成增删改后调用 `validateDAG`；失败由 `applyEvent` 抛出，store 不 append event。

- [ ] **Step 8: 扩展 statusResponse**

每个 task 增加：

```javascript
workspace: t.workspace,
allowedActions: action.allowedActions,
requiredNextAction: action.requiredNextAction,
blockingReason: action.blockingReason,
```

Goal terminal 时所有 task `allowedActions=[]`。

- [ ] **Step 9: 写 Extension status 恢复测试**

实例 A 推进到 disposing/applied；实例 B 重新加载同一 JSONL。两次 `goal_status` 文本解析后的 task action 必须深度相等，证明结果不依赖 `activeLeases`。

- [ ] **Step 10: 运行 GREEN**

Run:

```bash
node --test test/goal-engine-graph.test.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs
```

Expected: PASS。

- [ ] **Step 11: 提交状态动作和 DAG 门禁**

```bash
git add scripts/lib/goal-engine/graph.mjs scripts/lib/goal-engine/events.mjs \
  scripts/lib/goal-engine/extension.mjs test/goal-engine-graph.test.mjs \
  test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs
git commit -m "feat(goal-engine): 输出可执行状态动作"
```

---

### Task 6: 扩展审计、Doctor 和阶段验收

**Deps:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files:**
- Modify: `scripts/lib/goal-engine/audit.mjs:1-97`
- Modify: `test/goal-engine-audit.test.mjs:1-149`
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Verify: `docs/summaries/2026-08-02-goal-engine-production-hardening-handoff.md`

**Interfaces:**
- Adds audit signals: `LEGACY_UNVERIFIED_ACCEPTANCE`、`INCOMPLETE_WORKSPACE_DISPOSITION`、`UNRELEASED_INTEGRATED_WORKSPACE`。
- Doctor requires every Goal Engine registered tool to expose `execute` and forbids exposed `handler`。
- Does not claim cross-repo executor or unattended production readiness。

- [ ] **Step 1: 写 legacy audit RED**

使用 v1 completed event stream，断言：

```javascript
assert.ok(report.signals.includes("LEGACY_UNVERIFIED_ACCEPTANCE"));
assert.notEqual(report.verdict, "HEALTHY");
```

- [ ] **Step 2: 写 incomplete disposition RED**

创建 active goal，task workspace 分别停在 disposing 和 applied；两者 audit 均包含 `INCOMPLETE_WORKSPACE_DISPOSITION`。若 applied action 是 integrated 但未 released，同时包含 `UNRELEASED_INTEGRATED_WORKSPACE`。

- [ ] **Step 3: 运行 audit RED**

Run:

```bash
node --test test/goal-engine-audit.test.mjs
```

Expected: FAIL，缺少新 signals。

- [ ] **Step 4: 实现 audit signals**

从 projection task 字段计算，不扫描对话文本：

```javascript
const legacyAcceptance = [...projection.tasks.values()]
  .some((task) => task.acceptanceVerification === "legacy_unverified");
const incompleteDisposition = [...projection.tasks.values()]
  .some((task) => ["disposing", "applied"].includes(task.workspace?.phase));
const unreleasedIntegration = [...projection.tasks.values()]
  .some((task) => task.workspace?.disposition === "integrated" && task.workspace?.released !== true);
```

任一安全信号至少使 verdict 为 `AT_RISK`。

- [ ] **Step 5: 写 Doctor ABI RED**

在 `test/doctor.test.mjs` 增加 fixture：向 Goal Engine factory 提供 mock Pi，收集七个定义；任一 tool 缺 execute 或暴露 handler 时，`inspectConfiguration` 返回：

```text
invalid Goal Engine tool ABI: <tool-name>
```

- [ ] **Step 6: 运行 Doctor RED**

Run:

```bash
node --test --test-name-pattern='Goal Engine tool ABI' test/doctor.test.mjs
```

Expected: FAIL，Doctor 尚无该检查。

- [ ] **Step 7: 实现 Doctor ABI 检查**

Doctor 只加载 factory 并检查注册对象，不调用任何 `goal_*` 工具、不创建 `.state/goal-engine/`。检查 exact 七工具集合、`typeof execute === "function"`、无公开 handler。

- [ ] **Step 8: 运行阶段全量门禁**

Run:

```bash
node --test test/goal-engine-*.test.mjs
node --test test/doctor.test.mjs test/skill-whitelist-extension.test.mjs
npm run doctor
```

Expected: 全部 PASS；输出不含 warning/error 指向 Goal Engine。

- [ ] **Step 9: 检查 Git 与资源清洁度**

Run:

```bash
git status --short
git worktree list --porcelain
git branch --list 'ge/*'
find .state/goal-engine -type f -maxdepth 4 2>/dev/null || true
```

Expected:

- 只出现执行前已有的未提交文件和本计划声明的文件。
- 不新增 `ge/*` branch、Goal Engine worktree 或 lease。
- 不手工删除执行前已有资源；任何差异先报告用户。

- [ ] **Step 10: 独立审查本阶段 diff**

审查必须确认：

1. 真实 Pi `execute` 测试不是 mock handler 的别名。
2. v1 历史可读但不能为新完成状态提供可信 integration 证明。
3. accept、dispatch 和 integrate 门禁存在于状态机或纯 projection 规则，不只在工具描述。
4. Git 成功/事件失败和 cleanup 成功/事件失败均有重启恢复测试。
5. writePaths 校验实际 committed files。
6. 没有调用 Plan Runner 或 Goal Engine 工具自证完成。

- [ ] **Step 11: 提交审计与 Doctor 门禁**

```bash
git add scripts/lib/goal-engine/audit.mjs test/goal-engine-audit.test.mjs \
  scripts/doctor.mjs test/doctor.test.mjs
git commit -m "test(goal-engine): 增加生产合同门禁"
```

---

## 后续独立计划

本计划验收后，仍不得宣称 Goal Engine 为无人值守生产候选。按顺序另建：

1. `goal-engine-cross-repo-executor`：修复配置仓 Extension 在业务仓 cwd 的模块身份与 Root ownership 生命周期。
2. `goal-engine-coordinator-skill`：使用 writing-skills 流程编写并压力测试 coordinator Skill，再精简 `pi/AGENTS.md`。
3. `goal-engine-production-harness`：真实跨仓、多 task、失败重试、重启恢复、docs review、外部 evidence 和资源清理。

整个完善周期继续遵守用户约束：不调用 Goal Engine 或 Plan Runner 工具，直到用户在最终 Harness 和独立审查后明确解除限制。
