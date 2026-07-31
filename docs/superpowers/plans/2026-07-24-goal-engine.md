# Goal Engine 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一套独立于 plan runner 的长任务执行引擎（Goal Engine），将目标契约（goal-contract）和计划状态机（plan state machine）合并为单一机制。主 agent 作为 coordinator 驱动执行循环，executor 以 subagent 形式派发（使用 dispatch-ir.v1 结构化契约），人类通过正常对话随时介入。通过事件溯源状态机 + typed tool schema 硬约束，保障 24h+ 跨数十次 compaction 的任务可恢复、防漂移、防退化。

**Architecture:** 事件溯源状态机（projection 从事件日志派生）+ Pi Extension typed tools（主 agent 调用）+ dispatch-ir.v1 executor 契约（独立实现，设计借鉴 subagent-dispatch 但不共享代码）+ executor worktree 隔离（每个 executor 在独立 git worktree 中工作，完成后由主 agent 决定是否合回）+ AGENTS.md coordinator 协议（compact 后恢复）+ 事后审计脚本。主 agent 是 coordinator，executor 是一级 subagent。状态持久化到 `.state/goal-engine/`。与 `scripts/lib/plan/` 和 `scripts/lib/subagent-dispatch/` 完全无代码依赖，设计借鉴但独立实现，plan runner 后续迭代不影响本模块。

**Tech Stack:** Node.js ESM (.mjs)、node:test、Pi ExtensionAPI（registerTool / on("tool_result")）、subagent tool + dispatch-ir.v1（已有）

## Global Constraints

- 状态目录：`.state/goal-engine/`（events.jsonl + projection.json）
- 与 `scripts/lib/plan/*` 和 `scripts/lib/subagent-dispatch/*` 零代码依赖（不 import 任何文件）
- dispatch-ir.v1 契约格式兼容 subagent tool 的 schema（设计借鉴，独立实现在 `scripts/lib/goal-engine/dispatch-ir.mjs`）
- 测试命令：`node --test test/goal-engine-*.test.mjs`
- 代码风格：ESM、Extension 入口 .ts 薄壳、逻辑在 `scripts/lib/goal-engine/*.mjs`
- 不引入新依赖
- executor 派发必须通过 dispatch-ir.v1 契约，不接受纯自然语言 task
- evidence 不接受纯命令字符串（type: "command" 被拒绝），必须是 artifact 引用
- next_action 拒绝模糊词（continue/proceed/next step/TBD），minLength 20
- goal 完成时所有 task 必须 accepted，evidence 覆盖 DoD
- 主 agent 是 coordinator，executor 通过已有 `subagent` tool 派发
- 每个 executor 在独立 git worktree 中工作（基于当前 HEAD 创建），完成后由主 agent 通过 `goal_integrate` 决定合回或丢弃
- 人类介入 = 正常对话，无需额外协议
- store 层使用乐观并发控制（expectedVersion），防止 compact 后基于旧状态操作

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `scripts/lib/goal-engine/events.mjs` | 事件定义 + projection 状态机（applyEvent / createProjection） |
| `scripts/lib/goal-engine/graph.mjs` | 任务 DAG：依赖解析、可执行前沿计算 |
| `scripts/lib/goal-engine/store.mjs` | 持久化层：events.jsonl 追加（乐观并发）、projection.json 原子写入、读取恢复 |
| `scripts/lib/goal-engine/dispatch-ir.mjs` | 独立的 dispatch-ir.v1 编译器（设计借鉴 subagent-dispatch，零代码依赖） |
| `scripts/lib/goal-engine/dispatch.mjs` | 从 task 定义编译 dispatch-ir.v1 契约（调用 dispatch-ir.mjs） |
| `scripts/lib/goal-engine/workspace.mjs` | Executor worktree 生命周期：分配、检查、合回（cherry-pick/merge）、释放 |
| `scripts/lib/goal-engine/extension.mjs` | Extension 逻辑：注册 tools + tool_result hook |
| `scripts/lib/goal-engine/audit.mjs` | 审计逻辑：退化信号检测 |
| `pi/extensions/goal-engine.ts` | 薄壳入口 |
| `test/goal-engine-events.test.mjs` | 状态机测试 |
| `test/goal-engine-graph.test.mjs` | DAG 测试 |
| `test/goal-engine-dispatch.test.mjs` | dispatch IR 编译测试 |
| `test/goal-engine-workspace.test.mjs` | worktree 生命周期测试 |
| `test/goal-engine-extension.test.mjs` | Extension 层测试 |
| `test/goal-engine-audit.test.mjs` | 审计测试 |
| `scripts/goal-engine-audit.mjs` | 审计 CLI 入口 |
| `AGENTS.md` | 追加 coordinator 协议规则 |

---

### Task 1: 事件模型 + Projection 状态机

**Files:**
- Create: `scripts/lib/goal-engine/events.mjs`
- Test: `test/goal-engine-events.test.mjs`

**Interfaces:**
- Produces: `createProjection()`, `applyEvent(projection, event)` — Task 2/3/4/5 全部依赖

- [ ] **Step 1: 写 projection 基础测试**

```javascript
// test/goal-engine-events.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";

function makeEvent(type, data, goalId = "test-goal") {
  return {
    schemaVersion: "goal-engine.event.v1",
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

test("createProjection returns empty state", () => {
  const p = createProjection();
  assert.equal(p.goalId, null);
  assert.equal(p.version, 0);
  assert.equal(p.lifecycle, null);
  assert.equal(p.tasks.size, 0);
});

test("goal.created initializes projection", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Build auth module",
    scope: ["src/auth/"],
    nonGoals: ["UI changes"],
    dod: ["All auth tests pass", "No hardcoded secrets"],
    tasks: ["task-001", "task-002"],
    taskDefs: {
      "task-001": {
        description: "Token validation",
        deps: [],
        writePaths: ["src/auth/token.ts"],
        acceptance: { criteria: ["Handles expiry"], commands: ["node --test test/token.test.mjs"] },
        workflow: "tdd",
      },
      "task-002": {
        description: "Session management",
        deps: ["task-001"],
        writePaths: ["src/auth/session.ts"],
        acceptance: { criteria: ["Session persists"], commands: ["node --test test/session.test.mjs"] },
        workflow: "tdd",
      },
    },
  }));

  assert.equal(p.goalId, "test-goal");
  assert.equal(p.lifecycle, "active");
  assert.equal(p.version, 1);
  assert.equal(p.objective, "Build auth module");
  assert.deepEqual(p.dod, ["All auth tests pass", "No hardcoded secrets"]);
  assert.equal(p.tasks.size, 2);
  assert.equal(p.tasks.get("task-001").status, "pending");
  assert.deepEqual(p.tasks.get("task-001").writePaths, ["src/auth/token.ts"]);
  assert.deepEqual(p.tasks.get("task-001").acceptance.commands, ["node --test test/token.test.mjs"]);
  assert.deepEqual(p.tasks.get("task-002").deps, ["task-001"]);
});

test("goal.created must be first event", () => {
  let p = createProjection();
  assert.throws(
    () => applyEvent(p, makeEvent("task.dispatched", { taskId: "x" })),
    /goal\.created must be first/,
  );
});

test("duplicate eventId is rejected", () => {
  let p = createProjection();
  const event = makeEvent("goal.created", {
    objective: "X", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  });
  p = applyEvent(p, event);
  assert.throws(() => applyEvent(p, event), /duplicate eventId/);
});

test("terminal lifecycle rejects further events", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "X", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "abc123" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, evidenceSource: "self_produced", nextAction: "Accept t1 and verify goal completion criteria are satisfied" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));
  p = applyEvent(p, makeEvent("goal.completed", { verdict: "DONE_WITHOUT_EXTERNAL_VERIFICATION" }));
  assert.throws(
    () => applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "x" })),
    /goal is terminal/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-engine-events.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现事件模型**

```javascript
// scripts/lib/goal-engine/events.mjs
const SCHEMA_VERSION = "goal-engine.event.v1";
const TERMINAL_LIFECYCLES = new Set(["completed", "blocked", "cancelled"]);
const VALID_EVIDENCE_TYPES = new Set(["diff", "file", "test_output", "screenshot", "log", "external_review"]);
const VAGUE_PATTERNS = /\b(continue|proceed|next step|next|TBD|todo|keep going|carry on)\b/i;
const MIN_NEXT_ACTION_LEN = 20;

export function createProjection() {
  return {
    goalId: null,
    version: 0,
    lifecycle: null,
    objective: null,
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: new Map(),
    eventIds: new Set(),
    checkpointCount: 0,
    completionVerdict: null,
    blockedReason: null,
    nextAction: null,
    createdAt: null,
    updatedAt: null,
  };
}

export function applyEvent(projection, event) {
  validateEnvelope(event);
  validateGoalIdentity(projection, event);

  if (projection.eventIds.has(event.eventId)) {
    throw new Error(`duplicate eventId: ${event.eventId}`);
  }
  if (TERMINAL_LIFECYCLES.has(projection.lifecycle)) {
    throw new Error(`goal is terminal: ${projection.lifecycle}`);
  }

  const next = copyProjection(projection);
  switch (event.type) {
    case "goal.created": goalCreated(next, event); break;
    case "task.dispatched": taskDispatched(next, event.data); break;
    case "task.settled": taskSettled(next, event.data); break;
    case "task.accepted": taskAccepted(next, event.data); break;
    case "goal.amended": goalAmended(next, event.data); break;
    case "goal.blocked": goalBlocked(next, event.data); break;
    case "goal.completed": goalCompleted(next, event.data); break;
    case "goal.checkpoint": goalCheckpoint(next, event.data); break;
    default: throw new Error(`unsupported event type: ${event.type}`);
  }
  next.version = projection.version + 1;
  next.updatedAt = event.occurredAt;
  next.eventIds.add(event.eventId);
  return next;
}

function validateEnvelope(event) {
  if (!event || event.schemaVersion !== SCHEMA_VERSION) throw new Error("invalid schemaVersion");
  for (const field of ["eventId", "goalId", "occurredAt", "type"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) throw new Error(`invalid ${field}`);
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new Error("invalid data");
}

function validateGoalIdentity(projection, event) {
  if (projection.goalId === null) {
    if (event.type !== "goal.created") throw new Error("goal.created must be first event");
    return;
  }
  if (event.goalId !== projection.goalId) throw new Error("goalId mismatch");
  if (event.type === "goal.created") throw new Error("goal already created");
}

function copyProjection(p) {
  return {
    ...p,
    scope: [...p.scope],
    nonGoals: [...p.nonGoals],
    dod: [...p.dod],
    tasks: new Map([...p.tasks].map(([k, v]) => [k, { ...v, evidence: [...v.evidence], deps: [...v.deps], writePaths: [...(v.writePaths || [])], acceptance: v.acceptance ? { ...v.acceptance, criteria: [...v.acceptance.criteria], commands: [...v.acceptance.commands] } : null }])),
    eventIds: new Set(p.eventIds),
  };
}

function goalCreated(p, event) {
  const { objective, scope, nonGoals, dod, tasks, taskDefs } = event.data;
  if (!objective || typeof objective !== "string") throw new Error("objective is required");
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be non-empty");
  if (!taskDefs || typeof taskDefs !== "object") throw new Error("taskDefs is required");

  p.goalId = event.goalId;
  p.lifecycle = "active";
  p.objective = objective;
  p.scope = scope || [];
  p.nonGoals = nonGoals || [];
  p.dod = dod || [];
  p.createdAt = event.occurredAt;

  for (const taskId of tasks) {
    const def = taskDefs[taskId];
    if (!def) throw new Error(`missing taskDef for ${taskId}`);
    if (!def.description) throw new Error(`taskDef ${taskId} missing description`);
    if (!Array.isArray(def.writePaths) || def.writePaths.length === 0) throw new Error(`taskDef ${taskId} missing writePaths`);
    if (!def.acceptance || !Array.isArray(def.acceptance.criteria) || !Array.isArray(def.acceptance.commands)) {
      throw new Error(`taskDef ${taskId} missing acceptance (criteria + commands)`);
    }
    p.tasks.set(taskId, {
      description: def.description,
      deps: def.deps || [],
      writePaths: def.writePaths,
      acceptance: { criteria: def.acceptance.criteria, commands: def.acceptance.commands },
      workflow: def.workflow || "tdd",
      status: "pending",
      evidence: [],
      attempts: 0,
      lastSettledOutcome: null,
      contractHash: null,
    });
  }
}

function taskDispatched(p, data) {
  requireActive(p);
  const { taskId, contractHash } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "pending") throw new Error(`task is not pending: ${taskId} (${task.status})`);
  if (!contractHash || typeof contractHash !== "string") throw new Error("contractHash is required for dispatch");
  task.status = "dispatched";
  task.attempts++;
  task.contractHash = contractHash;
}

function taskSettled(p, data) {
  requireActive(p);
  const { taskId, outcome, evidence, evidenceSource, nextAction } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "dispatched") throw new Error(`task is not dispatched: ${taskId} (${task.status})`);
  if (!["succeeded", "failed", "blocked"].includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);

  validateNextAction(nextAction);
  if (outcome === "succeeded") validateEvidence(evidence);

  task.lastSettledOutcome = outcome;
  if (outcome === "succeeded") {
    task.status = "succeeded";
    task.evidence.push({ ...evidence, source: evidenceSource || "self_produced", ts: new Date().toISOString() });
  } else if (outcome === "failed") {
    task.status = "pending";
  } else {
    task.status = "blocked";
    task.blockedReason = data.reason || null;
  }
}

function taskAccepted(p, data) {
  requireActive(p);
  const { taskId } = data;
  const task = requireTask(p, taskId);
  if (task.status !== "succeeded") throw new Error(`task is not succeeded: ${taskId} (${task.status})`);
  task.status = "accepted";
}

function goalAmended(p, data) {
  requireActive(p);
  const { addTasks, removeTasks, updateTasks, reason } = data;
  if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
    throw new Error("amendment reason must be at least 10 characters");
  }

  if (removeTasks) {
    for (const taskId of removeTasks) {
      const task = requireTask(p, taskId);
      if (task.status === "accepted") throw new Error(`cannot remove accepted task: ${taskId}`);
      p.tasks.delete(taskId);
    }
  }
  if (addTasks) {
    for (const [taskId, def] of Object.entries(addTasks)) {
      if (p.tasks.has(taskId)) throw new Error(`task already exists: ${taskId}`);
      if (!def.writePaths || !def.acceptance) throw new Error(`added task ${taskId} must have writePaths and acceptance`);
      p.tasks.set(taskId, {
        description: def.description,
        deps: def.deps || [],
        writePaths: def.writePaths,
        acceptance: def.acceptance,
        workflow: def.workflow || "tdd",
        status: "pending",
        evidence: [],
        attempts: 0,
        lastSettledOutcome: null,
        contractHash: null,
      });
    }
  }
  if (updateTasks) {
    for (const [taskId, updates] of Object.entries(updateTasks)) {
      const task = requireTask(p, taskId);
      if (updates.description) task.description = updates.description;
      if (updates.deps) task.deps = updates.deps;
      if (updates.writePaths) task.writePaths = updates.writePaths;
      if (updates.acceptance) task.acceptance = updates.acceptance;
    }
  }
}

function goalBlocked(p, data) {
  requireActive(p);
  const { reason } = data;
  if (!reason || typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  p.lifecycle = "blocked";
  p.blockedReason = reason;
}

function goalCompleted(p, data) {
  requireActive(p);
  const { verdict } = data;
  if (!["COMPLETE", "DONE_WITHOUT_EXTERNAL_VERIFICATION"].includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  for (const [taskId, task] of p.tasks) {
    if (task.status !== "accepted") throw new Error(`task not accepted: ${taskId} (${task.status})`);
  }
  p.lifecycle = "completed";
  p.completionVerdict = verdict;
}

function goalCheckpoint(p, data) {
  requireActive(p);
  const { nextAction } = data;
  validateNextAction(nextAction);
  p.checkpointCount++;
  p.nextAction = nextAction;
}

export function validateNextAction(nextAction) {
  if (!nextAction || typeof nextAction !== "string" || nextAction.trim().length < MIN_NEXT_ACTION_LEN) {
    throw new Error(`next_action must be at least ${MIN_NEXT_ACTION_LEN} characters and describe a concrete action`);
  }
  if (VAGUE_PATTERNS.test(nextAction)) {
    throw new Error("next_action must be specific — vague words (continue/proceed/next step/TBD) are rejected");
  }
}

export function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("evidence is required to settle a task as succeeded");
  }
  if (!VALID_EVIDENCE_TYPES.has(evidence.type)) {
    throw new Error(`evidence type must be one of: ${[...VALID_EVIDENCE_TYPES].join(", ")}. Got: "${evidence.type}"`);
  }
  if (!evidence.ref && !evidence.path) {
    throw new Error("evidence must include a ref (diff/log) or path (file/test_output/screenshot)");
  }
}

function requireActive(p) {
  if (p.lifecycle !== "active") throw new Error(`goal is not active: ${p.lifecycle}`);
}

function requireTask(p, taskId) {
  const task = p.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return task;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-engine-events.test.mjs`
Expected: 5 tests PASS

- [ ] **Step 5: 写 task 生命周期测试**

```javascript
// 追加到 test/goal-engine-events.test.mjs
test("task lifecycle: pending → dispatched → succeeded → accepted", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Lifecycle test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["node --test test/x.test.mjs"] }, workflow: "tdd" } },
  }));

  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "sha256abc" }));
  assert.equal(p.tasks.get("t1").status, "dispatched");
  assert.equal(p.tasks.get("t1").attempts, 1);
  assert.equal(p.tasks.get("t1").contractHash, "sha256abc");

  p = applyEvent(p, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "self_produced",
    nextAction: "Accept t1 and verify all acceptance criteria are met",
  }));
  assert.equal(p.tasks.get("t1").status, "succeeded");
  assert.equal(p.tasks.get("t1").evidence.length, 1);

  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));
  assert.equal(p.tasks.get("t1").status, "accepted");
});

test("task.settled failed resets to pending for retry", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Retry test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "failed", nextAction: "Retry t1 with a different approach to fix the failing test case" }));
  assert.equal(p.tasks.get("t1").status, "pending");
  assert.equal(p.tasks.get("t1").attempts, 1);
  assert.equal(p.tasks.get("t1").lastSettledOutcome, "failed");
});

test("task.settled rejects vague nextAction", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Vague test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  assert.throws(
    () => applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "continue" })),
    /at least 20 characters|specific/i,
  );
});

test("task.settled rejects command-type evidence", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Cmd evidence test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  assert.throws(
    () => applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "command", ref: "npm test" }, nextAction: "Accept the task and verify goal completion criteria are met" })),
    /evidence type must be one of/i,
  );
});

test("goal.completed rejects when tasks not all accepted", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Gate test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1", "t2"],
    taskDefs: {
      t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
      t2: { description: "b", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
    },
  }));
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, nextAction: "Accept t1 and then dispatch t2 for implementation" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  assert.throws(
    () => applyEvent(p, makeEvent("goal.completed", { verdict: "COMPLETE" })),
    /task not accepted: t2/,
  );
});

test("goal.amended adds and removes tasks", () => {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Amend test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1", "t2"],
    taskDefs: {
      t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
      t2: { description: "b", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" },
    },
  }));

  p = applyEvent(p, makeEvent("goal.amended", {
    reason: "User changed direction: t2 no longer needed, adding t3 for new requirement",
    removeTasks: ["t2"],
    addTasks: { t3: { description: "new work", deps: ["t1"], writePaths: ["c.ts"], acceptance: { criteria: ["z"], commands: ["true"] }, workflow: "tdd" } },
  }));

  assert.equal(p.tasks.has("t2"), false);
  assert.equal(p.tasks.has("t3"), true);
  assert.deepEqual(p.tasks.get("t3").deps, ["t1"]);
});
```

- [ ] **Step 6: 运行全部测试**

Run: `node --test test/goal-engine-events.test.mjs`
Expected: 11 tests PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/goal-engine/events.mjs test/goal-engine-events.test.mjs
git commit -m "feat(goal-engine): event-sourced projection state machine"
```

---

### Task 2: 任务 DAG + 调度

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/goal-engine/graph.mjs`
- Test: `test/goal-engine-graph.test.mjs`

**Interfaces:**
- Consumes: projection shape from Task 1（`projection.tasks` Map）
- Produces: `runnableFrontier(projection)`, `validateDAG(tasks)`, `goalProgress(projection)` — Task 4/5 的 extension 调用

- [ ] **Step 1: 写 DAG 测试**

```javascript
// test/goal-engine-graph.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { runnableFrontier, validateDAG, goalProgress } from "../scripts/lib/goal-engine/graph.mjs";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";

function makeEvent(type, data, goalId = "dag-test") {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function taskDef(description, deps = []) {
  return { description, deps, writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" };
}

function buildProjection(taskDefs) {
  const ids = Object.keys(taskDefs);
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "DAG test", scope: [], nonGoals: [], dod: [],
    tasks: ids, taskDefs,
  }));
  return p;
}

test("validateDAG rejects cycle", () => {
  assert.throws(
    () => validateDAG(new Map([
      ["a", { deps: ["b"] }],
      ["b", { deps: ["a"] }],
    ])),
    /cycle/,
  );
});

test("validateDAG rejects missing dep", () => {
  assert.throws(
    () => validateDAG(new Map([["a", { deps: ["nonexistent"] }]])),
    /unknown dep/,
  );
});

test("runnableFrontier returns tasks with all deps accepted", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b", ["t1"]),
    t3: taskDef("c"),
  });

  let frontier = runnableFrontier(p);
  assert.deepEqual(frontier.sort(), ["t1", "t3"]);

  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "x" }, nextAction: "Accept t1 and then dispatch t2 for the next phase" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  frontier = runnableFrontier(p);
  assert.deepEqual(frontier.sort(), ["t2", "t3"]);
});

test("runnableFrontier excludes dispatched/succeeded/blocked tasks", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b"),
  });
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));

  const frontier = runnableFrontier(p);
  assert.deepEqual(frontier, ["t2"]);
});

test("goalProgress returns counts", () => {
  let p = buildProjection({
    t1: taskDef("a"),
    t2: taskDef("b"),
    t3: taskDef("c"),
  });
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", { taskId: "t1", outcome: "succeeded", evidence: { type: "file", path: "x" }, nextAction: "Accept t1 and then move to the next task in queue" }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  const progress = goalProgress(p);
  assert.equal(progress.total, 3);
  assert.equal(progress.accepted, 1);
  assert.equal(progress.pending, 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-engine-graph.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 graph**

```javascript
// scripts/lib/goal-engine/graph.mjs
export function validateDAG(tasks) {
  for (const [taskId, task] of tasks) {
    for (const dep of task.deps) {
      if (!tasks.has(dep)) throw new Error(`unknown dep: ${taskId} depends on ${dep}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) throw new Error(`dependency cycle at ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dep of tasks.get(taskId).deps) visit(dep);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const taskId of tasks.keys()) visit(taskId);
}

export function runnableFrontier(projection) {
  const frontier = [];
  for (const [taskId, task] of projection.tasks) {
    if (task.status !== "pending") continue;
    const depsReady = task.deps.every((dep) => projection.tasks.get(dep)?.status === "accepted");
    if (depsReady) frontier.push(taskId);
  }
  return frontier;
}

export function goalProgress(projection) {
  let accepted = 0, dispatched = 0, succeeded = 0, pending = 0, blocked = 0;
  for (const [, task] of projection.tasks) {
    if (task.status === "accepted") accepted++;
    else if (task.status === "dispatched") dispatched++;
    else if (task.status === "succeeded") succeeded++;
    else if (task.status === "pending") pending++;
    else if (task.status === "blocked") blocked++;
  }
  return { total: projection.tasks.size, accepted, dispatched, succeeded, pending, blocked };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-engine-graph.test.mjs`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/goal-engine/graph.mjs test/goal-engine-graph.test.mjs
git commit -m "feat(goal-engine): task DAG validation and runnable frontier"
```

---

### Task 3: 持久化层（乐观并发）

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/goal-engine/store.mjs`
- Test: `test/goal-engine-events.test.mjs`（追加 store 测试）

**Interfaces:**
- Consumes: `applyEvent`, `createProjection` from Task 1
- Produces: `appendEvent(stateRoot, event, expectedVersion)`, `loadProjection(stateRoot, goalId)`, `listGoals(stateRoot)` — Task 4/5 的 extension 调用

- [ ] **Step 1: 写 store 测试**

```javascript
// 追加到 test/goal-engine-events.test.mjs
import { appendEvent, loadProjection, listGoals } from "../scripts/lib/goal-engine/store.mjs";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "ge-store-"));
}

test("appendEvent writes to events.jsonl and updates projection.json", () => {
  const root = tmpRoot();
  const event = makeEvent("goal.created", {
    objective: "Store test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "store-goal");

  appendEvent(root, event, 0);

  assert.ok(existsSync(join(root, "goals/store-goal/events.jsonl")));
  assert.ok(existsSync(join(root, "goals/store-goal/projection.json")));

  const lines = readFileSync(join(root, "goals/store-goal/events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);

  const proj = JSON.parse(readFileSync(join(root, "goals/store-goal/projection.json"), "utf8"));
  assert.equal(proj.goalId, "store-goal");
  assert.equal(proj.lifecycle, "active");
  assert.equal(proj.version, 1);
});

test("appendEvent rejects stale expectedVersion", () => {
  const root = tmpRoot();
  const e1 = makeEvent("goal.created", {
    objective: "Version test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "ver-goal");

  appendEvent(root, e1, 0);

  const e2 = makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }, "ver-goal");
  assert.throws(
    () => appendEvent(root, e2, 0), // stale: current version is 1
    /projection version conflict/,
  );

  // correct version works
  appendEvent(root, e2, 1);
  const proj = loadProjection(root, "ver-goal");
  assert.equal(proj.version, 2);
});

test("loadProjection rebuilds from events.jsonl", () => {
  const root = tmpRoot();
  const e1 = makeEvent("goal.created", {
    objective: "Load test", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "load-goal");
  const e2 = makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }, "load-goal");

  appendEvent(root, e1, 0);
  appendEvent(root, e2, 1);

  const proj = loadProjection(root, "load-goal");
  assert.equal(proj.version, 2);
  assert.equal(proj.tasks.get("t1").status, "dispatched");
});

test("loadProjection returns null for nonexistent goal", () => {
  const root = tmpRoot();
  assert.equal(loadProjection(root, "nope"), null);
});

test("listGoals returns active goal ids from registry", () => {
  const root = tmpRoot();
  appendEvent(root, makeEvent("goal.created", {
    objective: "List A", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "a", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } },
  }, "goal-a"), 0);
  appendEvent(root, makeEvent("goal.created", {
    objective: "List B", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: { description: "b", deps: [], writePaths: ["b.ts"], acceptance: { criteria: ["y"], commands: ["true"] }, workflow: "tdd" } },
  }, "goal-b"), 0);

  const goals = listGoals(root);
  assert.deepEqual(goals.sort(), ["goal-a", "goal-b"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-engine-events.test.mjs`
Expected: FAIL — store module not found

- [ ] **Step 3: 实现 store**

```javascript
// scripts/lib/goal-engine/store.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvent, createProjection } from "./events.mjs";

export function appendEvent(stateRoot, event, expectedVersion) {
  const goalDir = join(stateRoot, "goals", event.goalId);
  mkdirSync(goalDir, { recursive: true });

  // optimistic concurrency: rebuild current projection and check version
  const current = rebuildProjection(stateRoot, event.goalId);
  if (current.version !== expectedVersion) {
    throw new Error(`projection version conflict: expected ${expectedVersion}, current ${current.version}`);
  }

  // validate event applies cleanly
  applyEvent(current, event);

  // append to events.jsonl
  const eventsPath = join(goalDir, "events.jsonl");
  appendFileSync(eventsPath, JSON.stringify(event) + "\n");

  // rebuild and write projection atomically
  const projection = rebuildProjection(stateRoot, event.goalId);
  writeProjectionAtomic(goalDir, projection);

  // update registry
  updateRegistry(stateRoot, event.goalId, projection.lifecycle);

  return projection;
}

export function loadProjection(stateRoot, goalId) {
  const eventsPath = join(stateRoot, "goals", goalId, "events.jsonl");
  if (!existsSync(eventsPath)) return null;
  return rebuildProjection(stateRoot, goalId);
}

export function listGoals(stateRoot) {
  const registryPath = join(stateRoot, "registry.json");
  if (!existsSync(registryPath)) return [];
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  return registry.active_goal_ids || [];
}

function rebuildProjection(stateRoot, goalId) {
  const eventsPath = join(stateRoot, "goals", goalId, "events.jsonl");
  if (!existsSync(eventsPath)) return createProjection();
  const content = readFileSync(eventsPath, "utf8").trim();
  if (!content) return createProjection();
  let projection = createProjection();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    projection = applyEvent(projection, JSON.parse(line));
  }
  return projection;
}

function writeProjectionAtomic(goalDir, projection) {
  const projPath = join(goalDir, "projection.json");
  const tmpPath = join(goalDir, `.projection-${process.pid}-${Date.now()}.tmp`);
  const serializable = serializeProjection(projection);
  writeFileSync(tmpPath, JSON.stringify(serializable, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, projPath);
}

function serializeProjection(p) {
  return {
    goalId: p.goalId,
    version: p.version,
    lifecycle: p.lifecycle,
    objective: p.objective,
    scope: p.scope,
    nonGoals: p.nonGoals,
    dod: p.dod,
    tasks: Object.fromEntries(p.tasks),
    checkpointCount: p.checkpointCount,
    completionVerdict: p.completionVerdict,
    blockedReason: p.blockedReason,
    nextAction: p.nextAction,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function updateRegistry(stateRoot, goalId, lifecycle) {
  const registryPath = join(stateRoot, "registry.json");
  let registry = { schema_version: "goal-engine.registry.v1", active_goal_ids: [], goals: {} };
  if (existsSync(registryPath)) {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  }
  registry.goals[goalId] = { goal_id: goalId, lifecycle };
  if (lifecycle === "active") {
    if (!registry.active_goal_ids.includes(goalId)) registry.active_goal_ids.push(goalId);
  } else {
    registry.active_goal_ids = registry.active_goal_ids.filter((id) => id !== goalId);
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-engine-events.test.mjs`
Expected: 16 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/goal-engine/store.mjs test/goal-engine-events.test.mjs
git commit -m "feat(goal-engine): persistent store with optimistic concurrency control"
```

---

### Task 4: Dispatch IR 编译（独立实现）

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/goal-engine/dispatch-ir.mjs`（独立的 IR 编译器，设计借鉴 subagent-dispatch/ir.ts 但零代码依赖）
- Create: `scripts/lib/goal-engine/dispatch.mjs`（task → contract 映射）
- Test: `test/goal-engine-dispatch.test.mjs`

**Interfaces:**
- Consumes: projection task shape from Task 1
- Produces: `compileCodingDispatchIR(input, { cwd })` → validated + hashed IR object
- Produces: `compileTaskContract(projection, taskId, cwd)` → dispatch-ir.v1 contract object
- Produces: `renderDispatchPrompt(ir)` → executor 可见的 markdown prompt

- [ ] **Step 1: 写 dispatch IR 编译器测试**

```javascript
// test/goal-engine-dispatch.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { compileCodingDispatchIR, renderDispatchPrompt } from "../scripts/lib/goal-engine/dispatch-ir.mjs";
import { compileTaskContract } from "../scripts/lib/goal-engine/dispatch.mjs";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";

function makeEvent(type, data, goalId = "dispatch-test") {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function validInput(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "test-goal.t1",
    title: "t1: Implement token validation",
    agent: "executor",
    risk: "normal",
    objective: "Implement token validation with expiry handling",
    workflow: { mode: "tdd" },
    requirements: ["Implement token validation", "Handle expired tokens"],
    context: { knownFacts: ["Goal: Build auth"], decisions: ["Non-goal: UI"], relevantFiles: ["src/auth/token.ts"] },
    boundaries: { writePaths: ["src/auth/token.ts"], excludedWork: ["UI changes"], forbiddenActions: ["Do not modify state files"] },
    acceptance: { criteria: ["Handles expired tokens"], commands: ["node --test test/token.test.mjs"] },
    execution: { cwd: "/workspace/project", timeoutMs: 1800000 },
    ...overrides,
  };
}

test("compileCodingDispatchIR validates and hashes", () => {
  const ir = compileCodingDispatchIR(validInput(), { cwd: "/workspace/project" });
  assert.equal(ir.version, "dispatch-ir.v1");
  assert.equal(ir.taskId, "test-goal.t1");
  assert.equal(ir.agent, "executor");
  assert.ok(/^[a-f0-9]{64}$/.test(ir.hash));
});

test("compileCodingDispatchIR rejects unknown fields", () => {
  assert.throws(
    () => compileCodingDispatchIR(validInput({ bogus: true }), { cwd: "/workspace/project" }),
    /unknown field/,
  );
});

test("compileCodingDispatchIR rejects invalid agent", () => {
  assert.throws(
    () => compileCodingDispatchIR(validInput({ agent: "hacker" }), { cwd: "/workspace/project" }),
    /unsupported.*agent/,
  );
});

test("compileCodingDispatchIR rejects empty writePaths", () => {
  const input = validInput();
  input.boundaries.writePaths = [];
  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/workspace/project" }),
    /writePaths/,
  );
});

test("compileCodingDispatchIR rejects path traversal in writePaths", () => {
  const input = validInput();
  input.boundaries.writePaths = ["../../etc/passwd"];
  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/workspace/project" }),
    /repo-relative/,
  );
});

test("renderDispatchPrompt produces structured markdown", () => {
  const ir = compileCodingDispatchIR(validInput(), { cwd: "/workspace/project" });
  const prompt = renderDispatchPrompt(ir);
  assert.match(prompt, /# Coding Dispatch Contract/);
  assert.match(prompt, /token validation/);
  assert.match(prompt, /src\/auth\/token\.ts/);
  assert.match(prompt, /node --test test\/token\.test\.mjs/);
  assert.ok(prompt.length < 64 * 1024);
});

// --- compileTaskContract tests ---

function buildProjection() {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Build auth module",
    scope: ["src/auth/"],
    nonGoals: ["UI changes", "Database migration"],
    dod: ["All auth tests pass", "No hardcoded secrets"],
    tasks: ["t1", "t2"],
    taskDefs: {
      t1: {
        description: "Implement token validation with expiry handling",
        deps: [],
        writePaths: ["src/auth/token.ts", "test/auth/token.test.mjs"],
        acceptance: { criteria: ["Handles expired tokens", "Rejects malformed tokens"], commands: ["node --test test/auth/token.test.mjs"] },
        workflow: "tdd",
      },
      t2: {
        description: "Add session management layer",
        deps: ["t1"],
        writePaths: ["src/auth/session.ts"],
        acceptance: { criteria: ["Session persists across requests"], commands: ["node --test test/auth/session.test.mjs"] },
        workflow: "tdd",
      },
    },
  }));
  return p;
}

test("compileTaskContract produces valid dispatch-ir.v1", () => {
  const p = buildProjection();
  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.equal(contract.version, "dispatch-ir.v1");
  assert.equal(contract.taskId, "dispatch-test.t1");
  assert.equal(contract.agent, "executor");
  assert.equal(contract.risk, "normal");
  assert.match(contract.objective, /token validation/i);
  assert.ok(contract.requirements.length >= 2);
  assert.deepEqual(contract.boundaries.writePaths, ["src/auth/token.ts", "test/auth/token.test.mjs"]);
  assert.deepEqual(contract.acceptance.commands, ["node --test test/auth/token.test.mjs"]);
  assert.equal(contract.workflow.mode, "tdd");
  assert.equal(contract.execution.cwd, "/workspace/project");
  assert.ok(contract.hash);
});

test("compileTaskContract includes goal context as knownFacts", () => {
  const p = buildProjection();
  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.ok(contract.context.knownFacts.some((f) => f.includes("src/auth/")));
  assert.ok(contract.context.decisions.some((d) => d.includes("UI changes")));
});

test("compileTaskContract includes completed task evidence as context", () => {
  let p = buildProjection();
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/auth/token.ts" },
    evidenceSource: "self_produced",
    nextAction: "Accept t1 and dispatch t2 for session management implementation",
  }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  const contract = compileTaskContract(p, "t2", "/workspace/project");
  assert.ok(contract.context.knownFacts.some((f) => f.includes("t1")));
  assert.ok(contract.context.relevantFiles.includes("src/auth/token.ts"));
});

test("compileTaskContract rejects non-pending task", () => {
  let p = buildProjection();
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  assert.throws(
    () => compileTaskContract(p, "t1", "/workspace"),
    /not pending/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-engine-dispatch.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现独立 dispatch IR 编译器**

```javascript
// scripts/lib/goal-engine/dispatch-ir.mjs
// 独立的 dispatch-ir.v1 编译器。设计借鉴 subagent-dispatch/ir.ts 但零代码依赖。
import { createHash } from "node:crypto";
import path from "node:path";

const CONTRACT_VERSION = "dispatch-ir.v1";
const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_BYTES = 4 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const AGENTS = new Set(["executor", "spark"]);
const RISKS = new Set(["low", "normal", "high"]);
const WORKFLOW_MODES = new Set(["tdd", "existing-tests", "docs-only"]);

const TOP_LEVEL_KEYS = [
  "version", "taskId", "title", "agent", "risk", "objective",
  "workflow", "requirements", "context", "boundaries", "acceptance", "execution",
];

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateObject(value, location, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) fail(`${location} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${location} contains unknown field ${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${location} is missing required field ${key}`);
  }
  return value;
}

function normalizeString(value, location, { maxBytes = MAX_STRING_BYTES } = {}) {
  if (typeof value !== "string") fail(`${location} must be a string`);
  const normalized = value.trim();
  if (!normalized) fail(`${location} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) fail(`${location} exceeds ${maxBytes} bytes`);
  return normalized;
}

function normalizeStringArray(value, location, { minItems = 0, item = normalizeString } = {}) {
  if (!Array.isArray(value)) fail(`${location} must be an array`);
  if (value.length > MAX_ARRAY_ITEMS) fail(`${location} must contain at most ${MAX_ARRAY_ITEMS} items`);
  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    const entry = item(value[i], `${location}[${i}]`);
    if (seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
  }
  if (normalized.length < minItems) fail(`${location} must contain at least ${minItems} item(s)`);
  return normalized;
}

function normalizeRepoRelativePath(value, location) {
  const normalized = normalizeString(value, location);
  if (normalized.includes("\0") || normalized.includes("\\") || normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\")) {
    fail(`${location} must be a repo-relative POSIX path`);
  }
  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;
  if (!base || base.endsWith("/") || /[*?\[\]]/.test(base)) fail(`${location} contains an unsupported path pattern`);
  const segments = base.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) fail(`${location} contains an unsafe path segment`);
  return recursive ? `${segments.join("/")}/**` : segments.join("/");
}

function normalizeWorkflow(value) {
  const workflow = validateObject(value, "workflow", ["mode", "reason"], ["mode"]);
  const mode = normalizeString(workflow.mode, "workflow.mode");
  if (!WORKFLOW_MODES.has(mode)) fail(`workflow.mode is not supported: ${mode}`);
  if (mode === "tdd") {
    if (Object.hasOwn(workflow, "reason")) fail("workflow.reason is forbidden when mode is tdd");
    return { mode };
  }
  if (!Object.hasOwn(workflow, "reason")) fail(`workflow.reason is required when mode is ${mode}`);
  return { mode, reason: normalizeString(workflow.reason, "workflow.reason") };
}

function normalizeContext(value) {
  const context = validateObject(value, "context", ["knownFacts", "decisions", "relevantFiles"]);
  return {
    knownFacts: normalizeStringArray(context.knownFacts, "context.knownFacts"),
    decisions: normalizeStringArray(context.decisions, "context.decisions"),
    relevantFiles: normalizeStringArray(context.relevantFiles, "context.relevantFiles", { item: normalizeRepoRelativePath }),
  };
}

function normalizeBoundaries(value) {
  const boundaries = validateObject(value, "boundaries", ["writePaths", "excludedWork", "forbiddenActions"]);
  return {
    writePaths: normalizeStringArray(boundaries.writePaths, "boundaries.writePaths", { minItems: 1, item: normalizeRepoRelativePath }),
    excludedWork: normalizeStringArray(boundaries.excludedWork, "boundaries.excludedWork"),
    forbiddenActions: normalizeStringArray(boundaries.forbiddenActions, "boundaries.forbiddenActions"),
  };
}

function normalizeAcceptance(value) {
  const acceptance = validateObject(value, "acceptance", ["criteria", "commands"]);
  return {
    criteria: normalizeStringArray(acceptance.criteria, "acceptance.criteria", { minItems: 1 }),
    commands: normalizeStringArray(acceptance.commands, "acceptance.commands", { minItems: 1 }),
  };
}

function normalizeExecution(value, baseCwd) {
  const execution = validateObject(value, "execution", ["timeoutMs", "cwd"], ["timeoutMs"]);
  if (!Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs <= 0) fail("execution.timeoutMs must be a positive safe integer");
  const root = normalizeString(baseCwd, "options.cwd");
  if (!path.isAbsolute(root) || root.includes("\0")) fail("options.cwd must be an absolute path");
  const requested = Object.hasOwn(execution, "cwd") ? normalizeString(execution.cwd, "execution.cwd") : root;
  if (requested.includes("\0")) fail("execution.cwd contains NUL");
  return { cwd: path.resolve(root, requested), timeoutMs: execution.timeoutMs };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function compileCodingDispatchIR(input, { cwd } = {}) {
  const source = validateObject(input, "contract", TOP_LEVEL_KEYS);
  const version = normalizeString(source.version, "version");
  if (version !== CONTRACT_VERSION) fail(`unsupported coding dispatch contract version: ${version}`);

  const agent = normalizeString(source.agent, "agent");
  if (!AGENTS.has(agent)) fail(`unsupported coding dispatch agent: ${agent}`);

  const risk = normalizeString(source.risk, "risk");
  if (!RISKS.has(risk)) fail(`unsupported coding dispatch risk: ${risk}`);

  const taskId = normalizeString(source.taskId, "taskId", { maxBytes: 160 });
  if (!TASK_ID_PATTERN.test(taskId)) fail("taskId must match ^[A-Za-z0-9._-]{1,160}$");

  const requirements = normalizeStringArray(source.requirements, "requirements", { minItems: 1 });
  const boundaries = normalizeBoundaries(source.boundaries);

  if (agent === "spark" && (risk !== "low" || boundaries.writePaths.length !== 1 || requirements.length > 8)) {
    fail("spark requires risk=low, exactly one write path, and at most eight requirements");
  }

  const canonical = {
    version,
    taskId,
    title: normalizeString(source.title, "title"),
    agent,
    risk,
    objective: normalizeString(source.objective, "objective"),
    requirements,
    context: normalizeContext(source.context),
    boundaries,
    workflow: normalizeWorkflow(source.workflow),
    acceptance: normalizeAcceptance(source.acceptance),
    execution: normalizeExecution(source.execution, cwd),
  };
  const ir = { ...canonical, hash: hashCanonical(canonical) };
  return deepFreeze(ir);
}

export function renderDispatchPrompt(ir) {
  const ordered = (items) => items.length === 0 ? "_None declared._" : items.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`).join("\n");
  const workflowReason = ir.workflow.reason === undefined ? "" : `\n- Exemption reason: ${JSON.stringify(ir.workflow.reason)}`;
  const prompt = [
    "# Coding Dispatch Contract v1",
    "",
    "## Identity",
    `- Version: \`${ir.version}\``,
    `- Task ID: ${JSON.stringify(ir.taskId)}`,
    `- Title: ${JSON.stringify(ir.title)}`,
    `- Agent: \`${ir.agent}\``,
    `- Risk: \`${ir.risk}\``,
    `- Working directory: ${JSON.stringify(ir.execution.cwd)}`,
    `- Timeout: \`${ir.execution.timeoutMs}ms\``,
    `- Contract SHA-256: \`${ir.hash}\``,
    "",
    "## Objective",
    JSON.stringify(ir.objective),
    "",
    "## Requirements",
    ordered(ir.requirements),
    "",
    "## Authoritative Known Facts",
    ordered(ir.context.knownFacts),
    "",
    "## Decisions Already Made",
    ordered(ir.context.decisions),
    "",
    "## Relevant Files",
    ordered(ir.context.relevantFiles),
    "",
    "## Declared Write Scope",
    ordered(ir.boundaries.writePaths),
    "",
    "Modify only the declared write paths. They are a contract and acceptance boundary, not an OS sandbox. Escalate before changing any other path.",
    "",
    "## Excluded Work",
    ordered(ir.boundaries.excludedWork),
    "",
    "## Forbidden Actions",
    ordered(ir.boundaries.forbiddenActions),
    "",
    "## Workflow",
    `- Mode: \`${ir.workflow.mode}\`${workflowReason}`,
    "- Follow the selected workflow exactly and preserve its evidence.",
    "",
    "## Acceptance Criteria",
    ordered(ir.acceptance.criteria),
    "",
    "## Verification Commands",
    ordered(ir.acceptance.commands),
    "",
    "## Escalation",
    "If required information or an unapproved decision is missing, use `contact_supervisor` when available and return `NEEDS_CONTEXT`. Do not substitute broad exploration for missing context or revisit decisions already recorded above.",
    "",
    "## Required Report",
    "Return a compact final report containing:",
    "1. status (`completed` or `NEEDS_CONTEXT`)",
    "2. files changed",
    "3. RED/GREEN or exemption evidence",
    "4. commands and results",
    "5. residual risks",
  ].join("\n");

  if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) fail("coding dispatch prompt exceeds 64KB");
  return prompt;
}
```

- [ ] **Step 4: 实现 task → contract 映射**

```javascript
// scripts/lib/goal-engine/dispatch.mjs
import { compileCodingDispatchIR } from "./dispatch-ir.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function compileTaskContract(projection, taskId, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const task = projection.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.status !== "pending") throw new Error(`task is not pending: ${taskId} (${task.status})`);

  const knownFacts = [
    `Goal: ${projection.objective}`,
    `Scope: ${projection.scope.join(", ") || "unrestricted"}`,
    ...buildCompletedContext(projection, taskId),
  ];

  const decisions = [
    ...projection.nonGoals.map((ng) => `Non-goal: ${ng}`),
  ];

  const relevantFiles = buildRelevantFiles(projection, taskId);

  const input = {
    version: "dispatch-ir.v1",
    taskId: `${projection.goalId}.${taskId}`,
    title: `${taskId}: ${task.description.slice(0, 80)}`,
    agent: "executor",
    risk: "normal",
    objective: task.description,
    workflow: { mode: task.workflow || "tdd" },
    requirements: [
      task.description,
      ...task.acceptance.criteria,
      ...projection.dod.map((d) => `Goal DoD: ${d}`),
    ],
    context: { knownFacts, decisions, relevantFiles },
    boundaries: {
      writePaths: task.writePaths,
      excludedWork: projection.nonGoals,
      forbiddenActions: ["Do not modify files outside declared writePaths", "Do not amend goal contract or state files"],
    },
    acceptance: {
      criteria: task.acceptance.criteria,
      commands: task.acceptance.commands,
    },
    execution: { cwd, timeoutMs },
  };

  return compileCodingDispatchIR(input, { cwd });
}

function buildCompletedContext(projection, currentTaskId) {
  const facts = [];
  for (const [taskId, task] of projection.tasks) {
    if (taskId === currentTaskId) continue;
    if (task.status === "accepted") {
      facts.push(`Completed task ${taskId}: ${task.description}`);
      for (const ev of task.evidence) {
        if (ev.ref) facts.push(`Evidence for ${taskId}: ${ev.type} @ ${ev.ref}`);
        if (ev.path) facts.push(`Evidence for ${taskId}: ${ev.type} @ ${ev.path}`);
      }
    }
  }
  return facts;
}

function buildRelevantFiles(projection, currentTaskId) {
  const files = [];
  for (const [taskId, task] of projection.tasks) {
    if (taskId === currentTaskId) continue;
    if (task.status === "accepted") files.push(...task.writePaths);
  }
  return [...new Set(files)];
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/goal-engine-dispatch.test.mjs`
Expected: 10 tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/goal-engine/dispatch-ir.mjs scripts/lib/goal-engine/dispatch.mjs test/goal-engine-dispatch.test.mjs
git commit -m "feat(goal-engine): independent dispatch-ir.v1 compiler + task contract mapping"
```

---

### Task 5: Executor Worktree 生命周期

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/goal-engine/workspace.mjs`
- Test: `test/goal-engine-workspace.test.mjs`

**Interfaces:**
- Consumes: goalId + taskId + originRoot（主 worktree 路径）
- Produces: `allocateExecutorWorkspace({ goalId, taskId, originRoot, stateRoot })` → lease（含 worktree path + branch）
- Produces: `inspectExecutorWorkspace(lease)` → { headCommit, dirtyFiles, untrackedFiles, diff }
- Produces: `integrateExecutorWorkspace(lease, { strategy })` → { integrated, newHead }（cherry-pick 或 merge 回主 worktree）
- Produces: `releaseExecutorWorkspace(lease, { disposition })` → 清理 worktree + branch

- [ ] **Step 1: 写 worktree 分配测试**

```javascript
// test/goal-engine-workspace.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateExecutorWorkspace, inspectExecutorWorkspace, integrateExecutorWorkspace, releaseExecutorWorkspace } from "../scripts/lib/goal-engine/workspace.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ge-ws-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

function tmpStateRoot() {
  return mkdtempSync(join(tmpdir(), "ge-ws-state-"));
}

test("allocateExecutorWorkspace creates worktree on new branch", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({
    goalId: "test-goal",
    taskId: "t1",
    attempt: 1,
    originRoot: origin,
    stateRoot,
    baseCommit,
  });

  assert.ok(existsSync(lease.path));
  assert.equal(lease.branch, "ge/test-goal/t1/1");
  assert.equal(lease.baseCommit, baseCommit);
  assert.equal(git(lease.path, "rev-parse", "HEAD"), baseCommit);
  assert.equal(git(lease.path, "branch", "--show-current"), "ge/test-goal/t1/1");
});

test("allocateExecutorWorkspace rejects duplicate allocation", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  assert.throws(
    () => allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit }),
    /already exists/,
  );
});

test("inspectExecutorWorkspace reports diff after executor commits", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  // simulate executor work
  writeFileSync(join(lease.path, "src/new.ts"), "export const x = 1;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: add new.ts");

  const inspection = inspectExecutorWorkspace(lease);
  assert.notEqual(inspection.headCommit, baseCommit);
  assert.ok(inspection.diff.includes("src/new.ts"));
  assert.equal(inspection.dirtyFiles.length, 0);
});

test("integrateExecutorWorkspace cherry-picks executor commit into origin", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  writeFileSync(join(lease.path, "feature.ts"), "export const f = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: add feature");
  const executorHead = git(lease.path, "rev-parse", "HEAD");

  const result = integrateExecutorWorkspace(lease, { strategy: "cherry-pick" });
  assert.equal(result.integrated, true);
  assert.notEqual(git(origin, "rev-parse", "HEAD"), baseCommit);
  assert.ok(existsSync(join(origin, "feature.ts")));
});

test("releaseExecutorWorkspace removes worktree and branch", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  const branch = lease.branch;

  releaseExecutorWorkspace(lease, { disposition: "integrated-cleanup" });
  assert.equal(existsSync(lease.path), false);
  assert.equal(git(origin, "branch", "--list", branch), "");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-engine-workspace.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 workspace 模块**

```javascript
// scripts/lib/goal-engine/workspace.mjs
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function safeId(value, field) {
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("..")) throw new Error(`Invalid ${field}`);
  return value;
}

function workspacePaths(stateRoot, goalId, taskId, attempt) {
  const worktreesRoot = path.resolve(stateRoot, "worktrees");
  const name = `${goalId}-${taskId}-${attempt}`;
  const workspacePath = path.join(worktreesRoot, name);
  const leasePath = path.join(worktreesRoot, `.${name}.lease.json`);
  return { worktreesRoot, workspacePath, leasePath };
}

export function allocateExecutorWorkspace({ goalId, taskId, attempt, originRoot, stateRoot, baseCommit }) {
  safeId(goalId, "goalId");
  safeId(taskId, "taskId");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  if (typeof originRoot !== "string" || typeof stateRoot !== "string") throw new Error("originRoot and stateRoot are required");
  if (typeof baseCommit !== "string" || !baseCommit) throw new Error("baseCommit is required");

  const { worktreesRoot, workspacePath, leasePath } = workspacePaths(stateRoot, goalId, taskId, attempt);
  const branch = `ge/${goalId}/${taskId}/${attempt}`;

  if (existsSync(leasePath) || existsSync(workspacePath)) {
    throw new Error(`Executor workspace already exists: ${goalId}/${taskId}/${attempt}`);
  }

  // verify base commit exists
  git(originRoot, "rev-parse", "--verify", `${baseCommit}^{commit}`);
  // verify branch doesn't exist
  const existingBranch = git(originRoot, "branch", "--list", branch);
  if (existingBranch) throw new Error(`Branch already exists: ${branch}`);

  mkdirSync(worktreesRoot, { recursive: true });
  git(originRoot, "worktree", "add", "-b", branch, workspacePath, baseCommit);

  const lease = {
    goalId,
    taskId,
    attempt,
    originRoot: path.resolve(originRoot),
    stateRoot: path.resolve(stateRoot),
    baseCommit,
    path: workspacePath,
    branch,
    ownerToken: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const tmpPath = `${leasePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(lease, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, leasePath);

  return { ...lease, leasePath };
}

export function inspectExecutorWorkspace(lease) {
  if (!existsSync(lease.path)) throw new Error("Executor workspace is missing");

  const headCommit = git(lease.path, "rev-parse", "HEAD");
  const statusOutput = git(lease.path, "status", "--porcelain=v1", "-uno");
  const dirtyFiles = statusOutput ? statusOutput.split("\n").map((line) => line.slice(3)) : [];
  const untrackedOutput = git(lease.path, "ls-files", "--others", "--exclude-standard");
  const untrackedFiles = untrackedOutput ? untrackedOutput.split("\n").filter(Boolean) : [];

  let diff = "";
  if (headCommit !== lease.baseCommit) {
    diff = git(lease.path, "diff", `${lease.baseCommit}..${headCommit}`);
  }

  return {
    headCommit,
    baseCommit: lease.baseCommit,
    dirtyFiles,
    untrackedFiles,
    diff,
    clean: dirtyFiles.length === 0 && untrackedFiles.length === 0,
    hasCommits: headCommit !== lease.baseCommit,
  };
}

export function integrateExecutorWorkspace(lease, { strategy = "cherry-pick" } = {}) {
  if (!existsSync(lease.path)) throw new Error("Executor workspace is missing");

  const inspection = inspectExecutorWorkspace(lease);
  if (!inspection.hasCommits) throw new Error("No commits to integrate");
  if (!inspection.clean) throw new Error("Workspace must be clean before integration (no uncommitted changes)");

  const origin = lease.originRoot;

  if (strategy === "cherry-pick") {
    // cherry-pick all commits from baseCommit..headCommit
    const logOutput = git(lease.path, "rev-list", "--reverse", `${lease.baseCommit}..${inspection.headCommit}`);
    const commits = logOutput.split("\n").filter(Boolean);
    for (const commit of commits) {
      git(origin, "cherry-pick", commit);
    }
  } else if (strategy === "merge") {
    git(origin, "merge", "--no-ff", lease.branch, "-m", `ge: integrate ${lease.goalId}/${lease.taskId}`);
  } else {
    throw new Error(`Unknown integration strategy: ${strategy}`);
  }

  const newHead = git(origin, "rev-parse", "HEAD");
  return { integrated: true, newHead, strategy };
}

export function releaseExecutorWorkspace(lease, { disposition } = {}) {
  const validDispositions = ["integrated-cleanup", "failed-cleanup", "discarded-cleanup", "preserved"];
  if (!validDispositions.includes(disposition)) throw new Error(`Invalid disposition: ${disposition}`);

  if (disposition === "preserved") {
    return { released: false, preserved: true };
  }

  const origin = lease.originRoot;

  if (existsSync(lease.path)) {
    // ensure clean before removal
    const inspection = inspectExecutorWorkspace(lease);
    if (!inspection.clean && disposition === "integrated-cleanup") {
      throw new Error("Workspace must be clean before integrated-cleanup");
    }
    git(origin, "worktree", "remove", "--force", lease.path);
  }

  // delete branch
  const branchExists = git(origin, "branch", "--list", lease.branch);
  if (branchExists) {
    git(origin, "branch", "-D", lease.branch);
  }

  // remove lease file
  if (lease.leasePath && existsSync(lease.leasePath)) {
    rmSync(lease.leasePath, { force: true });
  }

  return { released: true, preserved: false, disposition };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-engine-workspace.test.mjs`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/goal-engine/workspace.mjs test/goal-engine-workspace.test.mjs
git commit -m "feat(goal-engine): executor worktree lifecycle — allocate, inspect, integrate, release"
```

---

### Task 6: Extension 层 — tool 注册 + hook

**Deps:** Task 2, Task 3, Task 4, Task 5

**Files:**
- Create: `scripts/lib/goal-engine/extension.mjs`
- Create: `pi/extensions/goal-engine.ts`
- Test: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Consumes: events.mjs, graph.mjs, store.mjs, dispatch.mjs, workspace.mjs from Task 1-5
- Produces: 7 个 tool（goal_init / goal_status / goal_dispatch / goal_settle / goal_accept / goal_amend / goal_integrate）+ tool_result hook

- [ ] **Step 1: 写 Extension 测试**

```javascript
// test/goal-engine-extension.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";

function createMockPi(cwd) {
  const tools = [];
  const hooks = { tool_result: [] };
  return {
    tools, hooks, cwd,
    registerTool(def) { tools.push(def); },
    on(event, handler) { if (hooks[event]) hooks[event].push(handler); },
  };
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), "ge-ext-"));
}

test("registers seven goal engine tools", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["goal_accept", "goal_amend", "goal_dispatch", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
});

test("goal_init creates goal and returns runnable frontier", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  const result = JSON.parse(await init.handler({
    objective: "Build the authentication module with token validation",
    dod: ["All auth tests pass"],
    tasks: [
      { id: "t1", description: "Implement token validation logic", deps: [], writePaths: ["src/auth/token.ts"], acceptance: { criteria: ["Handles expiry"], commands: ["node --test test/token.test.mjs"] }, workflow: "tdd" },
      { id: "t2", description: "Add session management layer", deps: ["t1"], writePaths: ["src/auth/session.ts"], acceptance: { criteria: ["Session persists"], commands: ["node --test test/session.test.mjs"] }, workflow: "tdd" },
    ],
  }));

  assert.equal(result.goalId, "build-the-authentication-module-with-token-validation");
  assert.equal(result.lifecycle, "active");
  assert.deepEqual(result.runnable, ["t1"]);
});

test("goal_status returns full recovery context", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Status recovery test goal",
    tasks: [{ id: "t1", description: "First task work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const status = pi.tools.find((t) => t.name === "goal_status");
  const result = JSON.parse(await status.handler({}));
  assert.equal(result.goalId, "status-recovery-test-goal");
  assert.equal(result.lifecycle, "active");
  assert.ok(result.objective);
  assert.ok(Array.isArray(result.runnable));
  assert.ok(result.progress);
  assert.ok(result.tasks.t1);
});

test("goal_status returns NO_ACTIVE_GOAL when none", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const status = pi.tools.find((t) => t.name === "goal_status");
  assert.equal(await status.handler({}), "NO_ACTIVE_GOAL");
});

test("goal_dispatch allocates worktree and returns dispatch-ir.v1 contract", async () => {
  const cwd = tmpCwd();
  // init git repo so worktree allocation works
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init"); git("config", "user.email", "t@t.com"); git("config", "user.name", "T");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(cwd, "README.md"), "x\n");
  git("add", "."); git("commit", "-m", "init");

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Dispatch IR test goal",
    tasks: [{ id: "t1", description: "Implement the widget parser module", deps: [], writePaths: ["src/parser.ts"], acceptance: { criteria: ["Parses valid input"], commands: ["node --test test/parser.test.mjs"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const result = JSON.parse(await dispatch.handler({ task_id: "t1" }));

  assert.equal(result.status, "dispatched");
  assert.ok(result.contract);
  assert.equal(result.contract.version, "dispatch-ir.v1");
  assert.equal(result.contract.agent, "executor");
  assert.ok(result.contract.hash);
  assert.deepEqual(result.contract.boundaries.writePaths, ["src/parser.ts"]);
  assert.deepEqual(result.contract.acceptance.commands, ["node --test test/parser.test.mjs"]);
  // worktree allocated: execution.cwd points to worktree, not origin
  assert.ok(result.workspace);
  assert.ok(result.workspace.path.includes("worktrees"));
  assert.ok(result.workspace.branch.startsWith("ge/"));
  assert.notEqual(result.contract.execution.cwd, cwd);
  assert.equal(result.contract.execution.cwd, result.workspace.path);
});

test("goal_settle + goal_accept full cycle", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Full cycle test goal",
    tasks: [{ id: "t1", description: "The only task in this goal", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await dispatch.handler({ task_id: "t1" });

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  const settleResult = JSON.parse(await settle.handler({
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/x.ts" },
    evidence_source: "self_produced",
    next_action: "Accept t1 and verify all acceptance criteria are satisfied for completion",
  }));
  assert.equal(settleResult.status, "succeeded");

  const accept = pi.tools.find((t) => t.name === "goal_accept");
  const acceptResult = JSON.parse(await accept.handler({ task_id: "t1" }));
  assert.equal(acceptResult.status, "accepted");
  assert.equal(acceptResult.goal_complete, true);
  assert.equal(acceptResult.completion_verdict, "DONE_WITHOUT_EXTERNAL_VERIFICATION");
});

test("goal_settle rejects vague next_action", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Vague action test goal",
    tasks: [{ id: "t1", description: "work item", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await dispatch.handler({ task_id: "t1" });

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await assert.rejects(
    () => settle.handler({ task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, next_action: "continue" }),
    /at least 20 characters|specific/i,
  );
});

test("tool_result hook appends reminder when checkpoint overdue", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Hook test goal for reminder",
    tasks: [{ id: "t1", description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const hook = pi.hooks.tool_result[0];
  let lastResult;
  for (let i = 0; i < 6; i++) {
    lastResult = hook({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  }

  const text = lastResult?.content?.[0]?.text || "";
  assert.match(text, /goal-engine/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-engine-extension.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 Extension**

```javascript
// scripts/lib/goal-engine/extension.mjs
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { validateDAG, runnableFrontier, goalProgress } from "./graph.mjs";
import { appendEvent, loadProjection, listGoals } from "./store.mjs";
import { compileTaskContract } from "./dispatch.mjs";
import { allocateExecutorWorkspace, inspectExecutorWorkspace, integrateExecutorWorkspace, releaseExecutorWorkspace } from "./workspace.mjs";

const STATE_ROOT_REL = ".state/goal-engine";
const GOAL_ID_RE = /[^a-zA-Z0-9._-]+/g;
const CHECKPOINT_REMINDER_THRESHOLD = 5;

function stateRoot(cwd) {
  return join(cwd, STATE_ROOT_REL);
}

function slugify(raw) {
  const slug = raw.replace(GOAL_ID_RE, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 80);
  if (!slug) throw new Error("objective must produce a non-empty goal id");
  return slug;
}

function makeEvent(type, data, goalId) {
  return {
    schemaVersion: "goal-engine.event.v1",
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

function resolveGoal(goalId, root) {
  if (goalId) return goalId;
  const active = listGoals(root);
  if (active.length === 0) return null;
  if (active.length > 1) throw new Error(`Multiple active goals: ${active.join(", ")}. Specify goal_id.`);
  return active[0];
}

function statusResponse(projection) {
  const progress = goalProgress(projection);
  const runnable = runnableFrontier(projection);
  return JSON.stringify({
    goalId: projection.goalId,
    lifecycle: projection.lifecycle,
    objective: projection.objective,
    scope: projection.scope,
    nonGoals: projection.nonGoals,
    dod: projection.dod,
    progress,
    runnable,
    nextAction: projection.nextAction,
    checkpointCount: projection.checkpointCount,
    tasks: Object.fromEntries([...projection.tasks].map(([id, t]) => [id, {
      description: t.description, status: t.status, deps: t.deps,
      writePaths: t.writePaths, acceptance: t.acceptance,
      evidence_count: t.evidence.length, attempts: t.attempts,
      contractHash: t.contractHash,
    }])),
  }, null, 2);
}

export function createGoalEngineExtension(pi) {
  const cwd = pi.cwd || process.cwd();
  const root = stateRoot(cwd);
  let turnsSinceSettle = 0;
  const activeLeases = new Map(); // taskId → workspace lease

  pi.registerTool({
    name: "goal_init",
    description: "创建长任务 goal。将目标结构化为 task DAG（含 writePaths、acceptance、workflow），持久化到 .state/goal-engine/。用于 24h+ 跨多次 compaction 的任务。主 agent 作为 coordinator 驱动执行。",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "一句话目标" },
        scope: { type: "array", items: { type: "string" } },
        non_goals: { type: "array", items: { type: "string" } },
        dod: { type: "array", items: { type: "string" }, description: "Definition of Done 条目" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              description: { type: "string" },
              deps: { type: "array", items: { type: "string" } },
              writePaths: { type: "array", items: { type: "string" }, description: "允许写入的路径" },
              acceptance: {
                type: "object",
                properties: {
                  criteria: { type: "array", items: { type: "string" } },
                  commands: { type: "array", items: { type: "string" }, description: "验证命令" },
                },
                required: ["criteria", "commands"],
              },
              workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] },
            },
            required: ["id", "description", "writePaths", "acceptance"],
          },
          description: "任务 DAG（含依赖、写入范围、验收标准）",
        },
      },
      required: ["objective", "tasks"],
    },
    async handler(params) {
      const goalId = slugify(params.objective);
      const taskDefs = {};
      const taskIds = [];
      for (const t of params.tasks) {
        taskIds.push(t.id);
        taskDefs[t.id] = {
          description: t.description,
          deps: t.deps || [],
          writePaths: t.writePaths,
          acceptance: t.acceptance,
          workflow: t.workflow || "tdd",
        };
      }
      validateDAG(new Map(Object.entries(taskDefs).map(([k, v]) => [k, { deps: v.deps }])));

      const event = makeEvent("goal.created", {
        objective: params.objective,
        scope: params.scope || [],
        nonGoals: params.non_goals || [],
        dod: params.dod || [],
        tasks: taskIds,
        taskDefs,
      }, goalId);
      appendEvent(root, event, 0);

      const projection = loadProjection(root, goalId);
      return JSON.stringify({
        goalId,
        lifecycle: "active",
        runnable: runnableFrontier(projection),
        total_tasks: taskIds.length,
      });
    },
  });

  pi.registerTool({
    name: "goal_status",
    description: "获取当前活跃 goal 的完整恢复上下文。compact 后必须首先调用。返回：objective、task 状态、可执行前沿、next_action、进度、每个 task 的 writePaths 和 acceptance。",
    parameters: {
      type: "object",
      properties: { goal_id: { type: "string" } },
      required: [],
    },
    async handler(params) {
      try {
        const goalId = resolveGoal(params.goal_id, root);
        if (!goalId) return "NO_ACTIVE_GOAL";
        const projection = loadProjection(root, goalId);
        if (!projection) return "NO_ACTIVE_GOAL";
        return statusResponse(projection);
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  });

  pi.registerTool({
    name: "goal_dispatch",
    description: "为 task 分配独立 git worktree，编译 dispatch-ir.v1 契约（execution.cwd 指向 worktree），标记为 dispatched。返回的 contract 直接传给 subagent tool 派发 executor。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
        timeout_ms: { type: "integer", description: "executor 超时（默认 30min）" },
      },
      required: ["task_id"],
    },
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      const projection = loadProjection(root, goalId);
      const task = projection.tasks.get(params.task_id);
      if (!task) throw new Error(`unknown task: ${params.task_id}`);

      // allocate executor worktree
      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const lease = allocateExecutorWorkspace({
        goalId,
        taskId: params.task_id,
        attempt: task.attempts + 1,
        originRoot: cwd,
        stateRoot: root,
        baseCommit,
      });

      // compile IR with execution.cwd pointing to worktree
      const contract = compileTaskContract(projection, params.task_id, lease.path, {
        timeoutMs: params.timeout_ms || 30 * 60 * 1000,
      });

      const event = makeEvent("task.dispatched", { taskId: params.task_id, contractHash: contract.hash }, goalId);
      appendEvent(root, event, projection.version);

      // store lease for later integrate/release
      activeLeases.set(params.task_id, lease);

      return JSON.stringify({
        status: "dispatched",
        task_id: params.task_id,
        contract,
        workspace: { path: lease.path, branch: lease.branch, baseCommit: lease.baseCommit },
      });
    },
  });

  pi.registerTool({
    name: "goal_settle",
    description: "记录 executor 执行结果。succeeded 必须附带 evidence（artifact 引用，非命令字符串）。failed 将 task 重置为 pending（可重试）。同时记录 checkpoint。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
        outcome: { type: "string", enum: ["succeeded", "failed", "blocked"] },
        evidence: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["diff", "file", "test_output", "screenshot", "log", "external_review"] },
            ref: { type: "string", description: "diff/log 引用" },
            path: { type: "string", description: "文件/报告路径" },
          },
          required: ["type"],
        },
        evidence_source: { type: "string", enum: ["self_produced", "pre_existing", "external"] },
        next_action: { type: "string", description: "下一步具体动作（≥20字符，禁止模糊词）" },
        reason: { type: "string", description: "blocked 时的原因" },
      },
      required: ["task_id", "outcome", "next_action"],
    },
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjection(root, goalId);

      const settleEvent = makeEvent("task.settled", {
        taskId: params.task_id,
        outcome: params.outcome,
        evidence: params.evidence || null,
        evidenceSource: params.evidence_source || "self_produced",
        nextAction: params.next_action,
        reason: params.reason || null,
      }, goalId);
      projection = appendEvent(root, settleEvent, projection.version);

      const cpEvent = makeEvent("goal.checkpoint", { nextAction: params.next_action }, goalId);
      projection = appendEvent(root, cpEvent, projection.version);

      turnsSinceSettle = 0;

      return JSON.stringify({
        status: params.outcome,
        task_id: params.task_id,
        runnable: runnableFrontier(projection),
        progress: goalProgress(projection),
      });
    },
  });

  pi.registerTool({
    name: "goal_accept",
    description: "验收一个 succeeded 的 task。如果所有 task 都 accepted，自动触发 goal 完成并返回 completion_verdict。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["task_id"],
    },
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjection(root, goalId);

      const acceptEvent = makeEvent("task.accepted", { taskId: params.task_id }, goalId);
      projection = appendEvent(root, acceptEvent, projection.version);

      const progress = goalProgress(projection);
      const allAccepted = progress.accepted === progress.total;

      let completionVerdict = null;
      if (allAccepted) {
        const allEvidence = [...projection.tasks.values()].flatMap((t) => t.evidence);
        const hasExternal = allEvidence.some((e) => e.source !== "self_produced");
        completionVerdict = hasExternal ? "COMPLETE" : "DONE_WITHOUT_EXTERNAL_VERIFICATION";

        const completeEvent = makeEvent("goal.completed", { verdict: completionVerdict }, goalId);
        projection = appendEvent(root, completeEvent, projection.version);
      }

      return JSON.stringify({
        status: "accepted",
        task_id: params.task_id,
        goal_complete: allAccepted,
        ...(completionVerdict ? { completion_verdict: completionVerdict } : {}),
        progress: goalProgress(projection),
      });
    },
  });

  pi.registerTool({
    name: "goal_amend",
    description: "修改 goal 的 task DAG（增删改 task）。需要 reason（≥10字符）。不能删除已 accepted 的 task。用于人类介入调整方向。新增 task 必须含 writePaths 和 acceptance。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        reason: { type: "string", description: "修改原因（≥10字符）" },
        add_tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" }, description: { type: "string" },
              deps: { type: "array", items: { type: "string" } },
              writePaths: { type: "array", items: { type: "string" } },
              acceptance: { type: "object", properties: { criteria: { type: "array", items: { type: "string" } }, commands: { type: "array", items: { type: "string" } } }, required: ["criteria", "commands"] },
              workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] },
            },
            required: ["id", "description", "writePaths", "acceptance"],
          },
        },
        remove_tasks: { type: "array", items: { type: "string" } },
        update_tasks: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { description: { type: "string" }, deps: { type: "array", items: { type: "string" } }, writePaths: { type: "array", items: { type: "string" } }, acceptance: { type: "object" } },
          },
        },
      },
      required: ["reason"],
    },
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      const projection = loadProjection(root, goalId);

      const addTasks = {};
      if (params.add_tasks) {
        for (const t of params.add_tasks) {
          addTasks[t.id] = { description: t.description, deps: t.deps || [], writePaths: t.writePaths, acceptance: t.acceptance, workflow: t.workflow || "tdd" };
        }
      }

      const event = makeEvent("goal.amended", {
        reason: params.reason,
        addTasks: Object.keys(addTasks).length > 0 ? addTasks : undefined,
        removeTasks: params.remove_tasks || undefined,
        updateTasks: params.update_tasks || undefined,
      }, goalId);
      const updated = appendEvent(root, event, projection.version);
      return statusResponse(updated);
    },
  });

  pi.registerTool({
    name: "goal_integrate",
    description: "将 executor worktree 的成果合回主 worktree（cherry-pick 或 merge），或丢弃。在 goal_accept 之前调用。合回后自动释放 worktree。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
        action: { type: "string", enum: ["integrate", "discard", "preserve"], description: "integrate=合回主 worktree, discard=丢弃并清理, preserve=保留 worktree 不合回" },
        strategy: { type: "string", enum: ["cherry-pick", "merge"], description: "合回策略（默认 cherry-pick）" },
      },
      required: ["task_id", "action"],
    },
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");

      const lease = activeLeases.get(params.task_id);
      if (!lease) throw new Error(`No active workspace lease for task: ${params.task_id}. Was it dispatched?`);

      if (params.action === "preserve") {
        releaseExecutorWorkspace(lease, { disposition: "preserved" });
        activeLeases.delete(params.task_id);
        return JSON.stringify({ action: "preserved", path: lease.path, branch: lease.branch });
      }

      if (params.action === "discard") {
        releaseExecutorWorkspace(lease, { disposition: "discarded-cleanup" });
        activeLeases.delete(params.task_id);
        return JSON.stringify({ action: "discarded", released: true });
      }

      // action === "integrate"
      const inspection = inspectExecutorWorkspace(lease);
      if (!inspection.hasCommits) {
        releaseExecutorWorkspace(lease, { disposition: "integrated-cleanup" });
        activeLeases.delete(params.task_id);
        return JSON.stringify({ action: "integrated", note: "no commits to integrate", released: true });
      }

      const result = integrateExecutorWorkspace(lease, { strategy: params.strategy || "cherry-pick" });
      releaseExecutorWorkspace(lease, { disposition: "integrated-cleanup" });
      activeLeases.delete(params.task_id);

      return JSON.stringify({
        action: "integrated",
        strategy: result.strategy,
        newHead: result.newHead,
        released: true,
      });
    },
  });

  // --- tool_result hook: checkpoint reminder ---
  const settleTool = pi.tools.find((t) => t.name === "goal_settle");
  const originalSettle = settleTool.handler;
  settleTool.handler = async (params) => {
    const result = await originalSettle(params);
    turnsSinceSettle = 0;
    return result;
  };

  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return undefined;
    if (["goal_settle", "goal_status", "goal_init", "goal_dispatch", "goal_accept", "goal_amend", "goal_integrate"].includes(event.toolName)) return undefined;

    let activeGoals;
    try { activeGoals = listGoals(root); } catch { return undefined; }
    if (activeGoals.length === 0) return undefined;

    turnsSinceSettle++;
    if (turnsSinceSettle < CHECKPOINT_REMINDER_THRESHOLD) return undefined;

    let projection;
    try { projection = loadProjection(root, activeGoals[0]); } catch { return undefined; }
    if (!projection || projection.lifecycle !== "active") return undefined;

    const reminder = `\n\n⚠️ [goal-engine] 活跃 goal "${projection.goalId}" 已 ${turnsSinceSettle} 轮未 settle。当前 runnable: [${runnableFrontier(projection).join(", ")}]。请推进任务或调用 goal_settle 更新状态。`;
    const content = (event.content || []).map((part, i) => {
      if (i === 0 && part?.type === "text") return { ...part, text: part.text + reminder };
      return part;
    });
    return { content, details: event.details, isError: false };
  });
}
```

- [ ] **Step 4: 创建薄壳入口**

```typescript
// pi/extensions/goal-engine.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoalEngineExtension } from "../../scripts/lib/goal-engine/extension.mjs";

export default function goalEngine(pi: ExtensionAPI) {
  createGoalEngineExtension(pi);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/goal-engine-extension.test.mjs`
Expected: 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/goal-engine/extension.mjs pi/extensions/goal-engine.ts test/goal-engine-extension.test.mjs
git commit -m "feat(goal-engine): extension — 7 typed tools + dispatch-ir.v1 + worktree + checkpoint hook"
```

---

### Task 7: AGENTS.md Coordinator 协议

**Deps:** Task 6

**Files:**
- Modify: `AGENTS.md`（仓库根目录）

**Interfaces:**
- Consumes: goal_status / goal_dispatch / goal_settle / goal_accept tool 已注册
- Produces: compact 后主 agent 被触发进入 coordinator 循环的规则

- [ ] **Step 1: 在 AGENTS.md 的 `## 核心约束` 末尾追加**

```markdown
## Goal Engine 长任务协议

若 `goal_status` 返回非 `NO_ACTIVE_GOAL`，主 agent 进入 coordinator 模式：

1. 每轮开始先调用 `goal_status`，以其返回值为唯一任务上下文
2. 从 `runnable` 列表中选择 task，调用 `goal_dispatch` 获取 dispatch-ir.v1 contract + executor worktree
3. 将 contract 直接传给 `subagent` tool 派发 executor（executor 在独立 worktree 中工作）
4. executor 完成后，调用 `goal_settle` 记录结果和 evidence
5. 审查 executor 成果，调用 `goal_integrate`（integrate/discard/preserve）决定是否合回主 worktree
6. 验收通过则调用 `goal_accept`；全部 accepted 则 goal 自动完成
7. 人类随时可以插话修改方向（通过 `goal_amend` 或直接对话）

禁止：
- compact 后从压缩摘要推断进度而不调用 goal_status
- 跳过 goal_dispatch 直接派 executor（必须通过 dispatch-ir.v1 契约 + 独立 worktree）
- settle 时不填 next_action 或填写模糊词
- 用纯命令字符串（如 "npm test"）作为 evidence
- 未调用 goal_integrate 就直接 goal_accept（必须先决定 worktree 成果处置）
```

- [ ] **Step 2: 验证格式**

Run: `grep -A 20 "Goal Engine" AGENTS.md`
Expected: 内容完整，格式一致

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "feat(goal-engine): AGENTS.md coordinator protocol"
```

---

### Task 8: 审计脚本

**Deps:** Task 3

**Files:**
- Create: `scripts/lib/goal-engine/audit.mjs`
- Create: `scripts/goal-engine-audit.mjs`
- Test: `test/goal-engine-audit.test.mjs`

**Interfaces:**
- Consumes: store.mjs（loadProjection）、events.jsonl
- Produces: `auditGoal(goalId, stateRoot)` → 退化信号报告

- [ ] **Step 1: 写审计测试**

```javascript
// test/goal-engine-audit.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditGoal } from "../scripts/lib/goal-engine/audit.mjs";
import { appendEvent } from "../scripts/lib/goal-engine/store.mjs";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "ge-audit-"));
}

function makeEvent(type, data, goalId) {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function taskDef(description, deps = []) {
  return { description, deps, writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" };
}

test("auditGoal reports healthy for well-maintained goal", () => {
  const root = tmpRoot();
  appendEvent(root, makeEvent("goal.created", {
    objective: "Healthy goal", scope: [], nonGoals: [], dod: ["Done"],
    tasks: ["t1"], taskDefs: { t1: taskDef("work") },
  }, "healthy"), 0);
  appendEvent(root, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }, "healthy"), 1);
  appendEvent(root, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "pre_existing", nextAction: "Accept t1 and verify goal completion criteria",
  }, "healthy"), 2);
  appendEvent(root, makeEvent("goal.checkpoint", { nextAction: "Accept t1 and verify goal completion criteria" }, "healthy"), 3);
  appendEvent(root, makeEvent("task.accepted", { taskId: "t1" }, "healthy"), 4);
  appendEvent(root, makeEvent("goal.completed", { verdict: "COMPLETE" }, "healthy"), 5);

  const report = auditGoal("healthy", root);
  assert.equal(report.verdict, "HEALTHY");
  assert.equal(report.signals.length, 0);
});

test("auditGoal detects high retry rate", () => {
  const root = tmpRoot();
  appendEvent(root, makeEvent("goal.created", {
    objective: "Retry goal", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: taskDef("work") },
  }, "retry"), 0);

  let version = 1;
  for (let i = 0; i < 3; i++) {
    appendEvent(root, makeEvent("task.dispatched", { taskId: "t1", contractHash: `h${i}` }, "retry"), version++);
    appendEvent(root, makeEvent("task.settled", { taskId: "t1", outcome: "failed", nextAction: `Retry t1 attempt ${i + 2} with different approach to fix the issue` }, "retry"), version++);
    appendEvent(root, makeEvent("goal.checkpoint", { nextAction: `Retry t1 attempt ${i + 2} with different approach to fix the issue` }, "retry"), version++);
  }

  const report = auditGoal("retry", root);
  assert.ok(report.signals.includes("HIGH_RETRY_RATE"));
});

test("auditGoal detects all self-produced evidence", () => {
  const root = tmpRoot();
  appendEvent(root, makeEvent("goal.created", {
    objective: "Self evidence goal", scope: [], nonGoals: [], dod: [],
    tasks: ["t1"], taskDefs: { t1: taskDef("work") },
  }, "self-ev"), 0);
  appendEvent(root, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }, "self-ev"), 1);
  appendEvent(root, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded",
    evidence: { type: "file", path: "src/x.ts" },
    evidenceSource: "self_produced", nextAction: "Accept t1 and check completion criteria for goal",
  }, "self-ev"), 2);
  appendEvent(root, makeEvent("goal.checkpoint", { nextAction: "Accept t1 and check completion criteria for goal" }, "self-ev"), 3);
  appendEvent(root, makeEvent("task.accepted", { taskId: "t1" }, "self-ev"), 4);
  appendEvent(root, makeEvent("goal.completed", { verdict: "DONE_WITHOUT_EXTERNAL_VERIFICATION" }, "self-ev"), 5);

  const report = auditGoal("self-ev", root);
  assert.ok(report.signals.includes("ALL_SELF_PRODUCED_EVIDENCE"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-engine-audit.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现审计**

```javascript
// scripts/lib/goal-engine/audit.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjection } from "./store.mjs";

export function auditGoal(goalId, stateRoot) {
  const projection = loadProjection(stateRoot, goalId);
  if (!projection) throw new Error(`No goal found: ${goalId}`);

  const eventsPath = join(stateRoot, "goals", goalId, "events.jsonl");
  let events = [];
  if (existsSync(eventsPath)) {
    const content = readFileSync(eventsPath, "utf8").trim();
    if (content) events = content.split("\n").map((line) => JSON.parse(line));
  }

  const signals = [];

  // high retry rate
  const failedSettles = events.filter((e) => e.type === "task.settled" && e.data.outcome === "failed");
  if (failedSettles.length >= 3) signals.push("HIGH_RETRY_RATE");

  // all self-produced evidence
  const allEvidence = [...projection.tasks.values()].flatMap((t) => t.evidence);
  const hasExternal = allEvidence.some((e) => e.source !== "self_produced");
  if (allEvidence.length > 0 && !hasExternal) signals.push("ALL_SELF_PRODUCED_EVIDENCE");

  // long gaps between checkpoints
  const checkpoints = events.filter((e) => e.type === "goal.checkpoint");
  if (checkpoints.length >= 2) {
    for (let i = 1; i < checkpoints.length; i++) {
      const gap = new Date(checkpoints[i].occurredAt) - new Date(checkpoints[i - 1].occurredAt);
      if (gap > 2 * 60 * 60 * 1000) {
        signals.push("LONG_CHECKPOINT_GAP");
        break;
      }
    }
  }

  // never blocked in long task
  const totalEvents = events.length;
  const hasBlock = events.some((e) => e.type === "task.settled" && e.data.outcome === "blocked") || projection.blockedReason;
  if (totalEvents > 20 && !hasBlock) signals.push("NEVER_BLOCKED_SUSPICIOUS");

  const verdict = signals.length >= 2 ? "DEGRADED" : signals.length === 1 ? "AT_RISK" : "HEALTHY";

  return {
    goal_id: goalId,
    lifecycle: projection.lifecycle,
    total_events: totalEvents,
    checkpoint_count: projection.checkpointCount,
    progress: {
      total: projection.tasks.size,
      accepted: [...projection.tasks.values()].filter((t) => t.status === "accepted").length,
    },
    failed_attempts: failedSettles.length,
    has_external_evidence: hasExternal,
    signals,
    verdict,
  };
}
```

- [ ] **Step 4: 创建 CLI 入口**

```javascript
// scripts/goal-engine-audit.mjs
#!/usr/bin/env node
import { auditGoal } from "./lib/goal-engine/audit.mjs";
import { join } from "node:path";

const goalId = process.argv[2];
const stateRoot = join(process.cwd(), ".state/goal-engine");

if (!goalId) {
  console.error("Usage: node scripts/goal-engine-audit.mjs <goal-id>");
  process.exit(2);
}

try {
  const report = auditGoal(goalId, stateRoot);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "DEGRADED" ? 1 : 0);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/goal-engine-audit.test.mjs`
Expected: 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/goal-engine/audit.mjs scripts/goal-engine-audit.mjs test/goal-engine-audit.test.mjs
git commit -m "feat(goal-engine): audit script with degradation signal detection"
```

---

### Task 9: 集成验证 + 旧 skill 处置

**Deps:** Task 7, Task 8

**Files:**
- Modify: `skill-overrides/goal-contract/SKILL.md`（降级为参考文档）

- [ ] **Step 1: 运行全部 goal-engine 测试**

Run: `node --test test/goal-engine-events.test.mjs test/goal-engine-graph.test.mjs test/goal-engine-dispatch.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-audit.test.mjs`
Expected: 全部 PASS

- [ ] **Step 2: 运行仓库全量测试确认无回归**

Run: `npm test`
Expected: 无新增失败

- [ ] **Step 3: 降级旧 goal-contract skill**

修改 `skill-overrides/goal-contract/SKILL.md` frontmatter：

```yaml
description: "DEPRECATED: Runtime enforcement moved to goal-engine Pi Extension. This skill remains as reference for writing effective goal objectives and slice decomposition. Do not load for execution-time state management — use goal_init/goal_status/goal_dispatch/goal_settle/goal_accept tools instead."
```

在文件顶部 `# Goal Contract` 标题后追加：

```markdown
> **⚠️ DEPRECATED** — 运行时保障已迁移至 `goal-engine` Pi Extension（typed tools + 事件溯源状态机 + dispatch-ir.v1 契约）。
> 本 skill 仅保留作为目标分解和契约撰写的参考文档。执行期状态管理请使用
> `goal_init` / `goal_status` / `goal_dispatch` / `goal_settle` / `goal_accept` / `goal_amend` tools。
```

- [ ] **Step 4: 冒烟测试 — 完整 coordinator 循环**

```bash
cd /tmp && rm -rf ge-smoke && mkdir ge-smoke && cd ge-smoke && git init && echo "test" > README.md && git add . && git commit -m "init"

node -e "
import { createGoalEngineExtension } from '/Users/leshi.zhy/pi-config/scripts/lib/goal-engine/extension.mjs';
const tools = [];
const hooks = { tool_result: [] };
const pi = { cwd: process.cwd(), tools, hooks, registerTool(d) { tools.push(d); }, on(e, h) { if (hooks[e]) hooks[e].push(h); } };
createGoalEngineExtension(pi);

const call = async (name, params) => JSON.parse(await tools.find(t => t.name === name).handler(params));

// init
const init = await call('goal_init', {
  objective: 'Smoke test the goal engine end to end',
  dod: ['All tasks accepted'],
  tasks: [
    { id: 't1', description: 'Create hello.ts with greet function', deps: [], writePaths: ['src/hello.ts', 'test/hello.test.mjs'], acceptance: { criteria: ['greet returns greeting'], commands: ['node --test test/hello.test.mjs'] }, workflow: 'tdd' },
    { id: 't2', description: 'Add farewell function to hello module', deps: ['t1'], writePaths: ['src/hello.ts', 'test/hello.test.mjs'], acceptance: { criteria: ['farewell returns goodbye'], commands: ['node --test test/hello.test.mjs'] }, workflow: 'tdd' },
  ],
});
console.log('init:', init.goalId, 'runnable:', init.runnable);

// dispatch t1 → get IR contract
const disp = await call('goal_dispatch', { task_id: 't1' });
console.log('dispatch:', disp.status, 'contract.version:', disp.contract.version, 'hash:', disp.contract.hash.slice(0, 12) + '...');

// settle t1
const settle = await call('goal_settle', {
  task_id: 't1', outcome: 'succeeded',
  evidence: { type: 'test_output', path: 'test-results/hello.test.json' },
  evidence_source: 'self_produced',
  next_action: 'Accept t1 then dispatch t2 to add farewell function to hello module',
});
console.log('settle:', settle.status, 'runnable:', settle.runnable);

// accept t1
const accept1 = await call('goal_accept', { task_id: 't1' });
console.log('accept t1:', accept1.status, 'goal_complete:', accept1.goal_complete);

// dispatch + settle + accept t2
const disp2 = await call('goal_dispatch', { task_id: 't2' });
console.log('dispatch t2:', disp2.status, 'contract.taskId:', disp2.contract.taskId);
await call('goal_settle', {
  task_id: 't2', outcome: 'succeeded',
  evidence: { type: 'diff', ref: 'git diff HEAD~1 -- src/hello.ts' },
  evidence_source: 'self_produced',
  next_action: 'Accept t2 and verify all tasks are done for goal completion',
});
const accept2 = await call('goal_accept', { task_id: 't2' });
console.log('accept t2:', accept2.status, 'goal_complete:', accept2.goal_complete, 'verdict:', accept2.completion_verdict);

// status after completion
const status = await call('goal_status', {});
console.log('final status:', status);
"
```

Expected output:
```
init: smoke-test-the-goal-engine-end-to-end runnable: [ 't1' ]
dispatch: dispatched contract.version: dispatch-ir.v1 hash: <sha256>...
settle: succeeded runnable: [ 't2' ]
accept t1: accepted goal_complete: false
dispatch t2: dispatched contract.taskId: smoke-test-the-goal-engine-end-to-end.t2
accept t2: accepted goal_complete: true verdict: DONE_WITHOUT_EXTERNAL_VERIFICATION
final status: NO_ACTIVE_GOAL
```

- [ ] **Step 5: Commit**

```bash
git add skill-overrides/goal-contract/SKILL.md
git commit -m "refactor(goal-contract): deprecate skill, runtime moved to goal-engine extension"
```
