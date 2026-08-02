# Goal Contract Extension 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 goal-contract 从 prompt-level skill 升级为 Pi Extension typed tool，通过 schema 硬约束和 tool_result 注入实现长任务（24h+、数十次 compaction）的状态持久化、强制恢复、防漂移和防退化。

**Architecture:** 状态管理核心（纯函数，无 Pi 依赖）+ Extension 层（tool 注册 + tool_result hook）+ AGENTS.md 协议规则（compact 后触发）+ 事后审计脚本。状态持久化到 `.state/goal-contract/`，复用现有目录结构。

**Tech Stack:** Node.js ESM (.mjs)、node:test、Pi ExtensionAPI（registerTool / on("tool_result")）

## Global Constraints

- 状态目录：`.state/goal-contract/`（registry.json + goals/<id>/）
- 测试命令：`node --test test/goal-contract-*.test.mjs`
- 代码风格：ESM、无 TypeScript 编译（Extension 入口 .ts 薄壳，逻辑在 scripts/lib/*.mjs）
- 不引入新依赖
- evidence 不接受纯命令字符串，必须是 artifact 引用（diff/file/test_output）
- next_action 拒绝模糊词（continue/proceed/next step/TBD），minLength 20
- goal 完成时所有 DoD 必须有对应 evidence，否则 tool 报错

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `scripts/lib/goal-contract-state.mjs` | 状态管理核心：init/status/checkpoint/block 的纯逻辑，读写 .state/goal-contract/ |
| `scripts/lib/goal-contract-extension.mjs` | Extension 逻辑：注册 4 个 tool + tool_result checkpoint 提醒 hook |
| `pi/extensions/goal-contract.ts` | 薄壳入口，调用 extension.mjs |
| `test/goal-contract-state.test.mjs` | 状态管理核心测试 |
| `test/goal-contract-extension.test.mjs` | Extension 层测试（tool 注册、schema 拒绝、hook 注入） |
| `scripts/goal-audit.mjs` | 事后审计脚本：分析 evidence.jsonl 和 state 历史 |
| `AGENTS.md` | 追加 3 行长任务协议规则 |

---

### Task 1: 状态管理核心 — init 和 status

**Deps:** 无

**Files:**
- Create: `scripts/lib/goal-contract-state.mjs`
- Test: `test/goal-contract-state.test.mjs`

**Interfaces:**
- Produces: `initGoal(params, stateRoot)`, `getStatus(goalId, stateRoot)` — Task 2 的 extension 层直接调用

- [ ] **Step 1: 写 initGoal 失败测试**

```javascript
// test/goal-contract-state.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initGoal, getStatus } from "../scripts/lib/goal-contract-state.mjs";

function tmpStateRoot() {
  return mkdtempSync(join(tmpdir(), "gc-test-"));
}

test("initGoal creates registry and goal directory", () => {
  const root = tmpStateRoot();
  const result = initGoal({
    objective: "Implement auth module",
    scope: ["src/auth/"],
    nonGoals: ["UI changes"],
    dod: ["All auth tests pass", "No hardcoded secrets"],
    slices: [
      { id: "slice-001", description: "Token validation logic" },
      { id: "slice-002", description: "Session management" },
    ],
  }, root);

  assert.equal(result.goalId, "implement-auth-module");
  assert.ok(existsSync(join(root, "registry.json")));
  assert.ok(existsSync(join(root, "goals/implement-auth-module/state.json")));

  const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
  assert.deepEqual(registry.active_goal_ids, ["implement-auth-module"]);
});

test("initGoal rejects missing objective", () => {
  const root = tmpStateRoot();
  assert.throws(() => initGoal({ objective: "", slices: [] }, root), /objective/i);
});

test("initGoal rejects empty slices", () => {
  const root = tmpStateRoot();
  assert.throws(
    () => initGoal({ objective: "Do stuff", slices: [] }, root),
    /at least one slice/i,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 initGoal**

```javascript
// scripts/lib/goal-contract-state.mjs
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const GOAL_ID_RE = /[^a-zA-Z0-9._-]+/g;

export function slugify(raw) {
  const slug = raw.replace(GOAL_ID_RE, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (!slug) throw new Error("objective must produce a non-empty goal id");
  return slug;
}

export function initGoal(params, stateRoot) {
  const { objective, scope = [], nonGoals = [], dod = [], slices = [] } = params;
  if (!objective || !objective.trim()) throw new Error("objective is required");
  if (!slices.length) throw new Error("at least one slice is required");

  const goalId = slugify(objective);
  const goalDir = join(stateRoot, "goals", goalId);
  mkdirSync(goalDir, { recursive: true });

  const now = new Date().toISOString();
  const state = {
    schema_version: "goal_contract.v2",
    goal_id: goalId,
    objective,
    scope,
    non_goals: nonGoals,
    dod,
    slices: slices.map((s, i) => ({
      id: s.id || `slice-${String(i + 1).padStart(3, "0")}`,
      description: s.description,
      status: "pending",
      evidence: [],
    })),
    status: "active",
    current_slice: slices[0]?.id || "slice-001",
    next_action: params.nextAction || `Execute ${slices[0]?.id}: ${slices[0]?.description}`,
    blocked_reason: null,
    created_at: now,
    updated_at: now,
    checkpoint_count: 0,
  };

  writeFileSync(join(goalDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  writeFileSync(join(goalDir, "evidence.jsonl"), "");

  // registry
  const registryPath = join(stateRoot, "registry.json");
  let registry = { schema_version: "goal_contract.registry.v2", active_goal_ids: [], goals: {} };
  if (existsSync(registryPath)) {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  }
  registry.active_goal_ids = [...new Set([...registry.active_goal_ids, goalId])];
  registry.goals[goalId] = { goal_id: goalId, status: "active", dir: `goals/${goalId}` };
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

  return { goalId, stateRoot, goalDir };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: 3 tests PASS

- [ ] **Step 5: 写 getStatus 测试**

```javascript
// 追加到 test/goal-contract-state.test.mjs
test("getStatus returns recovery context for active goal", () => {
  const root = tmpStateRoot();
  initGoal({
    objective: "Build parser",
    slices: [{ id: "slice-001", description: "Lexer" }],
  }, root);

  const status = getStatus("build-parser", root);
  assert.equal(status.goal_id, "build-parser");
  assert.equal(status.status, "active");
  assert.equal(status.current_slice, "slice-001");
  assert.ok(status.next_action.length >= 20);
  assert.ok(Array.isArray(status.slices));
  assert.ok(Array.isArray(status.dod));
});

test("getStatus returns null when no active goal", () => {
  const root = tmpStateRoot();
  const status = getStatus(null, root);
  assert.equal(status, null);
});

test("getStatus with null goalId returns sole active goal", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "Only goal", slices: [{ id: "s1", description: "work" }] }, root);
  const status = getStatus(null, root);
  assert.equal(status.goal_id, "only-goal");
});

test("getStatus with null goalId throws on multiple active goals", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "Goal A", slices: [{ id: "s1", description: "a" }] }, root);
  initGoal({ objective: "Goal B", slices: [{ id: "s1", description: "b" }] }, root);
  assert.throws(() => getStatus(null, root), /multiple active goals/i);
});
```

- [ ] **Step 6: 实现 getStatus**

```javascript
// 追加到 scripts/lib/goal-contract-state.mjs
export function getStatus(goalId, stateRoot) {
  const registryPath = join(stateRoot, "registry.json");
  if (!existsSync(registryPath)) return null;

  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const activeIds = registry.active_goal_ids || [];
  if (activeIds.length === 0) return null;

  let resolvedId = goalId;
  if (!resolvedId) {
    if (activeIds.length > 1) {
      throw new Error(`Multiple active goals: ${activeIds.join(", ")}. Specify goal_id.`);
    }
    resolvedId = activeIds[0];
  }

  const statePath = join(stateRoot, "goals", resolvedId, "state.json");
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}
```

- [ ] **Step 7: 运行全部测试**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: 7 tests PASS

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/goal-contract-state.mjs test/goal-contract-state.test.mjs
git commit -m "feat(goal-contract): state core — initGoal and getStatus"
```

---

### Task 2: 状态管理核心 — checkpoint 和 block

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/goal-contract-state.mjs`
- Modify: `test/goal-contract-state.test.mjs`

**Interfaces:**
- Consumes: `initGoal`, `getStatus` from Task 1
- Produces: `checkpoint(goalId, params, stateRoot)`, `blockGoal(goalId, params, stateRoot)` — Task 3 的 extension 层调用

- [ ] **Step 1: 写 checkpoint 失败测试**

```javascript
// 追加到 test/goal-contract-state.test.mjs
import { checkpoint, blockGoal } from "../scripts/lib/goal-contract-state.mjs";

test("checkpoint advances slice and records evidence", () => {
  const root = tmpStateRoot();
  initGoal({
    objective: "Build parser",
    dod: ["Lexer works"],
    slices: [
      { id: "slice-001", description: "Lexer" },
      { id: "slice-002", description: "Parser" },
    ],
  }, root);

  const result = checkpoint("build-parser", {
    sliceId: "slice-001",
    status: "completed",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/lexer.ts" },
    evidenceSource: "self_produced",
    nextAction: "Implement slice-002: write recursive descent parser for expressions",
  }, root);

  assert.equal(result.current_slice, "slice-002");
  assert.equal(result.slices[0].status, "completed");
  assert.equal(result.slices[0].evidence.length, 1);
  assert.equal(result.checkpoint_count, 1);
});

test("checkpoint rejects vague nextAction", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "Vague test", slices: [{ id: "s1", description: "x" }] }, root);

  assert.throws(
    () => checkpoint("vague-test", {
      sliceId: "s1",
      status: "in_progress",
      evidence: { type: "file", path: "src/x.ts" },
      evidenceSource: "self_produced",
      nextAction: "continue",
    }, root),
    /next_action must be specific/i,
  );
});

test("checkpoint rejects short nextAction", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "Short test", slices: [{ id: "s1", description: "x" }] }, root);

  assert.throws(
    () => checkpoint("short-test", {
      sliceId: "s1",
      status: "in_progress",
      evidence: { type: "file", path: "a.ts" },
      evidenceSource: "self_produced",
      nextAction: "do next thing",
    }, root),
    /at least 20 characters/i,
  );
});

test("checkpoint rejects completion without evidence", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "No evidence", slices: [{ id: "s1", description: "x" }] }, root);

  assert.throws(
    () => checkpoint("no-evidence", {
      sliceId: "s1",
      status: "completed",
      evidence: null,
      nextAction: "Move on to the next slice implementation details here",
    }, root),
    /evidence is required/i,
  );
});

test("checkpoint rejects plain command string as evidence", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "Cmd evidence", slices: [{ id: "s1", description: "x" }] }, root);

  assert.throws(
    () => checkpoint("cmd-evidence", {
      sliceId: "s1",
      status: "completed",
      evidence: { type: "command", ref: "npm test" },
      evidenceSource: "self_produced",
      nextAction: "Proceed to implement the next component in the system",
    }, root),
    /evidence type must be one of/i,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: FAIL — checkpoint not exported

- [ ] **Step 3: 实现 checkpoint**

```javascript
// 追加到 scripts/lib/goal-contract-state.mjs
const VALID_EVIDENCE_TYPES = ["diff", "file", "test_output", "screenshot", "log", "external_review"];
const VAGUE_PATTERNS = /\b(continue|proceed|next step|next|TBD|todo|keep going|carry on)\b/i;
const MIN_NEXT_ACTION_LEN = 20;

export function validateNextAction(nextAction) {
  if (!nextAction || nextAction.trim().length < MIN_NEXT_ACTION_LEN) {
    throw new Error(`next_action must be at least ${MIN_NEXT_ACTION_LEN} characters and describe a concrete action`);
  }
  if (VAGUE_PATTERNS.test(nextAction)) {
    throw new Error("next_action must be specific — vague words (continue/proceed/next step/TBD) are rejected");
  }
}

export function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("evidence is required to mark a slice completed");
  }
  if (!VALID_EVIDENCE_TYPES.includes(evidence.type)) {
    throw new Error(`evidence type must be one of: ${VALID_EVIDENCE_TYPES.join(", ")}. Got: "${evidence.type}"`);
  }
  if (!evidence.ref && !evidence.path) {
    throw new Error("evidence must include a ref (diff/log) or path (file/test_output/screenshot)");
  }
}

export function checkpoint(goalId, params, stateRoot) {
  const state = getStatus(goalId, stateRoot);
  if (!state) throw new Error(`No active goal: ${goalId}`);

  const { sliceId, status, evidence, evidenceSource = "self_produced", nextAction } = params;

  validateNextAction(nextAction);
  if (status === "completed") validateEvidence(evidence);

  const slice = state.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`Slice not found: ${sliceId}`);

  // update slice
  slice.status = status;
  if (evidence) {
    slice.evidence.push({ ...evidence, source: evidenceSource, ts: new Date().toISOString() });
  }

  // append to evidence.jsonl
  const evidencePath = join(stateRoot, "goals", state.goal_id, "evidence.jsonl");
  const row = JSON.stringify({
    ts: new Date().toISOString(),
    slice: sliceId,
    status,
    evidence,
    evidence_source: evidenceSource,
    next_action: nextAction,
  }) + "\n";
  const { appendFileSync } = await import("node:fs");
  appendFileSync(evidencePath, row);

  // advance current_slice if completed
  if (status === "completed") {
    const idx = state.slices.findIndex((s) => s.id === sliceId);
    const next = state.slices[idx + 1];
    state.current_slice = next ? next.id : null;
  }

  state.next_action = nextAction;
  state.updated_at = new Date().toISOString();
  state.checkpoint_count = (state.checkpoint_count || 0) + 1;

  const statePath = join(stateRoot, "goals", state.goal_id, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  return state;
}
```

注意：`appendFileSync` 需要在文件顶部 import，不用 dynamic import。实现时修正为顶部 `import { appendFileSync } from "node:fs";`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: 12 tests PASS

- [ ] **Step 5: 写 blockGoal 测试**

```javascript
test("blockGoal sets blocked status and reason", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "Block test", slices: [{ id: "s1", description: "x" }] }, root);

  const result = blockGoal("block-test", {
    reason: "CI credentials expired, cannot run integration tests",
    blockerType: "environment_auth",
  }, root);

  assert.equal(result.status, "blocked");
  assert.equal(result.blocked_reason, "CI credentials expired, cannot run integration tests");
  assert.equal(result.blocker_type, "environment_auth");
});

test("blockGoal rejects empty reason", () => {
  const root = tmpStateRoot();
  initGoal({ objective: "Empty block", slices: [{ id: "s1", description: "x" }] }, root);

  assert.throws(
    () => blockGoal("empty-block", { reason: "", blockerType: "toolchain" }, root),
    /reason is required/i,
  );
});
```

- [ ] **Step 6: 实现 blockGoal**

```javascript
// 追加到 scripts/lib/goal-contract-state.mjs
const VALID_BLOCKER_TYPES = [
  "environment_auth", "toolchain", "device_runtime",
  "external_service", "missing_evidence", "scope_conflict", "review_rejected",
];

export function blockGoal(goalId, params, stateRoot) {
  const state = getStatus(goalId, stateRoot);
  if (!state) throw new Error(`No active goal: ${goalId}`);

  const { reason, blockerType } = params;
  if (!reason || !reason.trim()) throw new Error("reason is required to block a goal");
  if (blockerType && !VALID_BLOCKER_TYPES.includes(blockerType)) {
    throw new Error(`blockerType must be one of: ${VALID_BLOCKER_TYPES.join(", ")}`);
  }

  state.status = "blocked";
  state.blocked_reason = reason;
  state.blocker_type = blockerType || null;
  state.updated_at = new Date().toISOString();

  const statePath = join(stateRoot, "goals", state.goal_id, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  return state;
}
```

- [ ] **Step 7: 运行全部测试**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: 14 tests PASS

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/goal-contract-state.mjs test/goal-contract-state.test.mjs
git commit -m "feat(goal-contract): state core — checkpoint and block with validation"
```

---

### Task 3: 状态管理核心 — 完成门禁

**Deps:** Task 2

**Files:**
- Modify: `scripts/lib/goal-contract-state.mjs`
- Modify: `test/goal-contract-state.test.mjs`

**Interfaces:**
- Consumes: `checkpoint`, `getStatus` from Task 1-2
- Produces: `completeGoal(goalId, stateRoot)` — 只有所有 DoD 有 evidence 覆盖时才允许完成

- [ ] **Step 1: 写完成门禁失败测试**

```javascript
// 追加到 test/goal-contract-state.test.mjs
import { completeGoal } from "../scripts/lib/goal-contract-state.mjs";

test("completeGoal succeeds when all slices completed with evidence", () => {
  const root = tmpStateRoot();
  initGoal({
    objective: "Complete test",
    dod: ["Feature works"],
    slices: [{ id: "s1", description: "The feature" }],
  }, root);

  checkpoint("complete-test", {
    sliceId: "s1",
    status: "completed",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "self_produced",
    nextAction: "All slices done, ready to verify goal completion criteria",
  }, root);

  const result = completeGoal("complete-test", root);
  assert.equal(result.status, "completed");
});

test("completeGoal rejects when slice still pending", () => {
  const root = tmpStateRoot();
  initGoal({
    objective: "Incomplete test",
    dod: ["Both done"],
    slices: [
      { id: "s1", description: "First" },
      { id: "s2", description: "Second" },
    ],
  }, root);

  checkpoint("incomplete-test", {
    sliceId: "s1",
    status: "completed",
    evidence: { type: "file", path: "src/a.ts" },
    evidenceSource: "self_produced",
    nextAction: "Implement s2: the second slice with full details here",
  }, root);

  assert.throws(
    () => completeGoal("incomplete-test", root),
    /slices not completed: s2/i,
  );
});

test("completeGoal reports self_produced_only warning", () => {
  const root = tmpStateRoot();
  initGoal({
    objective: "Self only",
    dod: ["Works"],
    slices: [{ id: "s1", description: "x" }],
  }, root);

  checkpoint("self-only", {
    sliceId: "s1",
    status: "completed",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "self_produced",
    nextAction: "Verify completion — all evidence is self-produced only",
  }, root);

  const result = completeGoal("self-only", root);
  assert.equal(result.status, "completed");
  assert.equal(result.completion_verdict, "DONE_WITHOUT_EXTERNAL_VERIFICATION");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: FAIL — completeGoal not exported

- [ ] **Step 3: 实现 completeGoal**

```javascript
// 追加到 scripts/lib/goal-contract-state.mjs
export function completeGoal(goalId, stateRoot) {
  const state = getStatus(goalId, stateRoot);
  if (!state) throw new Error(`No active goal: ${goalId}`);

  const incomplete = state.slices.filter((s) => s.status !== "completed");
  if (incomplete.length > 0) {
    throw new Error(`Cannot complete goal — slices not completed: ${incomplete.map((s) => s.id).join(", ")}`);
  }

  const allEvidence = state.slices.flatMap((s) => s.evidence);
  const hasExternal = allEvidence.some((e) => e.source !== "self_produced");
  state.completion_verdict = hasExternal ? "COMPLETE" : "DONE_WITHOUT_EXTERNAL_VERIFICATION";
  state.status = "completed";
  state.updated_at = new Date().toISOString();

  const statePath = join(stateRoot, "goals", state.goal_id, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  // update registry
  const registryPath = join(stateRoot, "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.active_goal_ids = registry.active_goal_ids.filter((id) => id !== state.goal_id);
  if (registry.goals[state.goal_id]) registry.goals[state.goal_id].status = "completed";
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

  return state;
}
```

- [ ] **Step 4: 运行全部测试**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: 17 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/goal-contract-state.mjs test/goal-contract-state.test.mjs
git commit -m "feat(goal-contract): state core — completion gate with evidence coverage check"
```

---

### Task 4: Extension 层 — tool 注册

**Deps:** Task 3

**Files:**
- Create: `scripts/lib/goal-contract-extension.mjs`
- Create: `pi/extensions/goal-contract.ts`
- Test: `test/goal-contract-extension.test.mjs`

**Interfaces:**
- Consumes: `initGoal`, `getStatus`, `checkpoint`, `blockGoal`, `completeGoal` from Task 1-3
- Produces: 4 个注册到 Pi 的 tool（goal_init / goal_status / goal_checkpoint / goal_block）

- [ ] **Step 1: 写 Extension 注册测试**

```javascript
// test/goal-contract-extension.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalContractExtension } from "../scripts/lib/goal-contract-extension.mjs";

function createMockPi(cwd) {
  const tools = [];
  const hooks = { tool_result: [] };
  return {
    tools,
    hooks,
    cwd,
    registerTool(def) { tools.push(def); },
    on(event, handler) { if (hooks[event]) hooks[event].push(handler); },
  };
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), "gc-ext-"));
}

test("registers four goal tools", () => {
  const pi = createMockPi(tmpCwd());
  createGoalContractExtension(pi);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["goal_block", "goal_checkpoint", "goal_init", "goal_status"]);
});

test("goal_init handler creates goal and returns goalId", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalContractExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  const result = await init.handler({
    objective: "Test goal for extension",
    slices: [{ id: "s1", description: "First slice" }],
  });

  assert.match(result, /test-goal-for-extension/);
});

test("goal_status handler returns JSON state", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalContractExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Status check goal",
    slices: [{ id: "s1", description: "Work" }],
  });

  const status = pi.tools.find((t) => t.name === "goal_status");
  const result = await status.handler({});
  const parsed = JSON.parse(result);
  assert.equal(parsed.goal_id, "status-check-goal");
  assert.equal(parsed.status, "active");
});

test("goal_status returns NO_ACTIVE_GOAL when none exists", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalContractExtension(pi);

  const status = pi.tools.find((t) => t.name === "goal_status");
  const result = await status.handler({});
  assert.equal(result, "NO_ACTIVE_GOAL");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-contract-extension.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 Extension**

```javascript
// scripts/lib/goal-contract-extension.mjs
import { join } from "node:path";
import { initGoal, getStatus, checkpoint, blockGoal, completeGoal } from "./goal-contract-state.mjs";

const STATE_ROOT_REL = ".state/goal-contract";

function stateRoot(cwd) {
  return join(cwd, STATE_ROOT_REL);
}

export function createGoalContractExtension(pi) {
  const cwd = pi.cwd || process.cwd();

  pi.registerTool({
    name: "goal_init",
    description: "创建长任务 goal contract。将目标结构化为 slices，持久化到 .state/goal-contract/。用于 24h+ 跨多次 compaction 的任务。",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "一句话目标描述" },
        scope: { type: "array", items: { type: "string" }, description: "允许的文件/区域" },
        non_goals: { type: "array", items: { type: "string" }, description: "明确不做的事" },
        dod: { type: "array", items: { type: "string" }, description: "Definition of Done 条目" },
        slices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              description: { type: "string" },
            },
            required: ["description"],
          },
          description: "可独立验证的工作切片",
        },
        next_action: { type: "string", description: "第一个具体动作（≥20字符）" },
      },
      required: ["objective", "slices"],
    },
    async handler(params) {
      const result = initGoal({
        objective: params.objective,
        scope: params.scope || [],
        nonGoals: params.non_goals || [],
        dod: params.dod || [],
        slices: params.slices,
        nextAction: params.next_action,
      }, stateRoot(cwd));
      return JSON.stringify({ status: "created", goalId: result.goalId, next_action: `Execute ${params.slices[0]?.id || "slice-001"}` });
    },
  });

  pi.registerTool({
    name: "goal_status",
    description: "获取当前活跃 goal 的完整恢复上下文：当前 slice、next_action、已完成证据、blockers。compact 后必须首先调用此 tool。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "指定 goal（多个活跃 goal 时必填）" },
      },
      required: [],
    },
    async handler(params) {
      try {
        const state = getStatus(params.goal_id || null, stateRoot(cwd));
        if (!state) return "NO_ACTIVE_GOAL";
        return JSON.stringify(state, null, 2);
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  });

  pi.registerTool({
    name: "goal_checkpoint",
    description: "记录一个 slice 的进展。更新状态、追加 evidence、设置 next_action。每完成一个 slice 必须调用。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        slice_id: { type: "string", description: "当前 slice id" },
        status: { type: "string", enum: ["in_progress", "completed", "blocked"] },
        evidence: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["diff", "file", "test_output", "screenshot", "log", "external_review"] },
            ref: { type: "string", description: "diff/log 引用（如 git diff HEAD~1）" },
            path: { type: "string", description: "文件/报告路径" },
          },
          required: ["type"],
        },
        evidence_source: { type: "string", enum: ["self_produced", "pre_existing", "external"] },
        next_action: { type: "string", description: "下一个具体动作（≥20字符，禁止模糊词）" },
      },
      required: ["slice_id", "status", "next_action"],
    },
    async handler(params) {
      try {
        const state = checkpoint(params.goal_id || null, {
          sliceId: params.slice_id,
          status: params.status,
          evidence: params.evidence || null,
          evidenceSource: params.evidence_source || "self_produced",
          nextAction: params.next_action,
        }, stateRoot(cwd));
        return JSON.stringify({ ok: true, current_slice: state.current_slice, checkpoint_count: state.checkpoint_count });
      } catch (err) {
        throw new Error(err.message);
      }
    },
  });

  pi.registerTool({
    name: "goal_block",
    description: "标记当前 goal 为阻塞状态，记录原因和阻塞类型。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        reason: { type: "string", description: "阻塞原因（必填）" },
        blocker_type: {
          type: "string",
          enum: ["environment_auth", "toolchain", "device_runtime", "external_service", "missing_evidence", "scope_conflict", "review_rejected"],
        },
      },
      required: ["reason"],
    },
    async handler(params) {
      try {
        const state = blockGoal(params.goal_id || null, {
          reason: params.reason,
          blockerType: params.blocker_type,
        }, stateRoot(cwd));
        return JSON.stringify({ ok: true, status: state.status, blocked_reason: state.blocked_reason });
      } catch (err) {
        throw new Error(err.message);
      }
    },
  });
}
```

- [ ] **Step 4: 创建薄壳入口**

```typescript
// pi/extensions/goal-contract.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoalContractExtension } from "../../scripts/lib/goal-contract-extension.mjs";

export default function goalContract(pi: ExtensionAPI) {
  createGoalContractExtension(pi);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/goal-contract-extension.test.mjs`
Expected: 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/goal-contract-extension.mjs pi/extensions/goal-contract.ts test/goal-contract-extension.test.mjs
git commit -m "feat(goal-contract): extension layer — register 4 typed tools"
```

---

### Task 5: Extension 层 — checkpoint 提醒 hook

**Deps:** Task 4

**Files:**
- Modify: `scripts/lib/goal-contract-extension.mjs`
- Modify: `test/goal-contract-extension.test.mjs`

**Interfaces:**
- Consumes: `getStatus` from state core
- Produces: `tool_result` hook，当活跃 goal 存在且连续 N 轮未 checkpoint 时追加提醒

- [ ] **Step 1: 写 hook 测试**

```javascript
// 追加到 test/goal-contract-extension.test.mjs
test("tool_result hook appends reminder when checkpoint overdue", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalContractExtension(pi);

  // create a goal
  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Hook test goal",
    slices: [{ id: "s1", description: "Work" }],
  });

  // simulate 6 tool_result events without checkpoint
  const hook = pi.hooks.tool_result[0];
  let lastResult;
  for (let i = 0; i < 6; i++) {
    lastResult = hook({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  }

  // 6th call should have reminder appended
  const text = lastResult?.content?.[0]?.text || "";
  assert.match(text, /goal_checkpoint/);
});

test("tool_result hook does not append when no active goal", () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalContractExtension(pi);

  const hook = pi.hooks.tool_result[0];
  const result = hook({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  assert.equal(result, undefined);
});

test("tool_result hook resets counter after checkpoint", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalContractExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Reset test goal",
    slices: [{ id: "s1", description: "Work" }, { id: "s2", description: "More" }],
  });

  const hook = pi.hooks.tool_result[0];
  // 3 calls
  for (let i = 0; i < 3; i++) {
    hook({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  }

  // checkpoint resets
  const cp = pi.tools.find((t) => t.name === "goal_checkpoint");
  await cp.handler({
    slice_id: "s1",
    status: "completed",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidence_source: "self_produced",
    next_action: "Implement s2: the second slice with full implementation details",
  });

  // next 3 calls should NOT have reminder
  let result;
  for (let i = 0; i < 3; i++) {
    result = hook({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  }
  const text = result?.content?.[0]?.text || "ok";
  assert.ok(!text.includes("goal_checkpoint"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-contract-extension.test.mjs`
Expected: FAIL — no tool_result hook registered

- [ ] **Step 3: 实现 hook**

```javascript
// 追加到 createGoalContractExtension 函数内部，在 4 个 registerTool 之后：
const CHECKPOINT_REMINDER_THRESHOLD = 5;
let turnsSinceCheckpoint = 0;

// 包装 checkpoint handler 以重置计数器
const originalCheckpointHandler = pi.tools.find((t) => t.name === "goal_checkpoint").handler;
pi.tools.find((t) => t.name === "goal_checkpoint").handler = async (params) => {
  const result = await originalCheckpointHandler(params);
  turnsSinceCheckpoint = 0;
  return result;
};

pi.on("tool_result", (event, ctx) => {
  if (event.isError) return undefined;
  if (event.toolName === "goal_checkpoint" || event.toolName === "goal_status") return undefined;

  let state;
  try {
    state = getStatus(null, stateRoot(ctx?.cwd || cwd));
  } catch {
    return undefined;
  }
  if (!state || state.status !== "active") return undefined;

  turnsSinceCheckpoint++;
  if (turnsSinceCheckpoint < CHECKPOINT_REMINDER_THRESHOLD) return undefined;

  const reminder = `\n\n⚠️ [goal-contract] 活跃 goal "${state.goal_id}" 已 ${turnsSinceCheckpoint} 轮未 checkpoint。当前 slice: ${state.current_slice}。请调用 goal_checkpoint 更新状态后再继续。`;
  const content = (event.content || []).map((part, i) => {
    if (i === 0 && part?.type === "text") return { ...part, text: part.text + reminder };
    return part;
  });
  return { content, details: event.details, isError: false };
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-contract-extension.test.mjs`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/goal-contract-extension.mjs test/goal-contract-extension.test.mjs
git commit -m "feat(goal-contract): tool_result hook — checkpoint overdue reminder"
```

---

### Task 6: AGENTS.md 协议规则

**Deps:** Task 4

**Files:**
- Modify: `AGENTS.md`（仓库根目录）

**Interfaces:**
- Consumes: goal_status / goal_checkpoint tool 已注册（Task 4）
- Produces: compact 后 agent 被触发调用 goal_status 的规则

- [ ] **Step 1: 在 AGENTS.md 的 `## 核心约束` 末尾追加**

```markdown
## 长任务协议（Goal Contract）

若 `goal_status` 返回非 `NO_ACTIVE_GOAL`：

1. 每轮开始先调用 `goal_status`，以其返回值为唯一任务上下文
2. 只执行 `next_action` 描述的动作，不从对话记忆推断任务状态
3. 每完成一个 slice 必须调用 `goal_checkpoint` 后再继续下一个
4. 遇到无法推进的阻塞必须调用 `goal_block`，不得静默跳过

禁止：compact 后从压缩摘要推断当前进度而不调用 goal_status。
```

- [ ] **Step 2: 验证 AGENTS.md 格式正确**

Run: `head -80 AGENTS.md`
Expected: 新增内容在核心约束区块内，格式一致

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "feat(goal-contract): AGENTS.md long-task protocol rules"
```

---

### Task 7: 事后审计脚本

**Deps:** Task 3

**Files:**
- Create: `scripts/goal-audit.mjs`
- Test: `test/goal-contract-state.test.mjs`（追加审计相关测试）

**Interfaces:**
- Consumes: `.state/goal-contract/goals/<id>/state.json` + `evidence.jsonl`
- Produces: 审计报告（stdout JSON），包含退化信号检测

- [ ] **Step 1: 写审计逻辑测试**

```javascript
// 追加到 test/goal-contract-state.test.mjs
import { auditGoal } from "../scripts/lib/goal-contract-state.mjs";

test("auditGoal reports healthy metrics", () => {
  const root = tmpStateRoot();
  initGoal({
    objective: "Audit healthy",
    dod: ["Done"],
    slices: [{ id: "s1", description: "Work" }],
  }, root);

  checkpoint("audit-healthy", {
    sliceId: "s1",
    status: "completed",
    evidence: { type: "diff", ref: "git diff HEAD~1" },
    evidenceSource: "pre_existing",
    nextAction: "Verify all slices completed and run final validation pass",
  }, root);

  const report = auditGoal("audit-healthy", root);
  assert.equal(report.total_checkpoints, 1);
  assert.equal(report.vague_next_actions, 0);
  assert.equal(report.empty_evidence_count, 0);
  assert.ok(report.verdict !== "DEGRADED");
});

test("auditGoal detects vague next_action pattern", () => {
  const root = tmpStateRoot();
  initGoal({
    objective: "Audit vague",
    slices: [
      { id: "s1", description: "A" },
      { id: "s2", description: "B" },
      { id: "s3", description: "C" },
    ],
  }, root);

  // manually write evidence.jsonl with vague patterns to simulate history
  const { writeFileSync } = await import("node:fs");
  const evidencePath = join(root, "goals/audit-vague/evidence.jsonl");
  const rows = [
    { ts: "2025-01-01T00:00:00Z", slice: "s1", status: "completed", next_action: "continue working on the implementation" },
    { ts: "2025-01-01T01:00:00Z", slice: "s2", status: "completed", next_action: "proceed to next step in the plan" },
    { ts: "2025-01-01T02:00:00Z", slice: "s3", status: "completed", next_action: "keep going with remaining work items" },
  ];
  writeFileSync(evidencePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const report = auditGoal("audit-vague", root);
  assert.ok(report.vague_next_actions >= 2);
  assert.ok(report.signals.includes("VAGUE_NEXT_ACTION_PATTERN"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: FAIL — auditGoal not exported

- [ ] **Step 3: 实现 auditGoal**

```javascript
// 追加到 scripts/lib/goal-contract-state.mjs
export function auditGoal(goalId, stateRoot) {
  const state = getStatus(goalId, stateRoot);
  if (!state) throw new Error(`No goal found: ${goalId}`);

  const evidencePath = join(stateRoot, "goals", state.goal_id, "evidence.jsonl");
  let rows = [];
  if (existsSync(evidencePath)) {
    const content = readFileSync(evidencePath, "utf8").trim();
    if (content) rows = content.split("\n").map((line) => JSON.parse(line));
  }

  const signals = [];

  // vague next_action detection
  const vagueCount = rows.filter((r) => r.next_action && VAGUE_PATTERNS.test(r.next_action)).length;
  if (vagueCount >= 2) signals.push("VAGUE_NEXT_ACTION_PATTERN");

  // empty evidence on completed slices
  const emptyEvidence = state.slices.filter(
    (s) => s.status === "completed" && s.evidence.length === 0,
  ).length;
  if (emptyEvidence > 0) signals.push("COMPLETED_WITHOUT_EVIDENCE");

  // all self_produced
  const allEvidence = state.slices.flatMap((s) => s.evidence);
  const hasExternal = allEvidence.some((e) => e.source !== "self_produced");
  if (allEvidence.length > 0 && !hasExternal) signals.push("ALL_SELF_PRODUCED_EVIDENCE");

  // never blocked in long task
  if (state.checkpoint_count > 10 && !state.blocked_reason && state.status !== "blocked") {
    signals.push("NEVER_BLOCKED_SUSPICIOUS");
  }

  const verdict = signals.length >= 2 ? "DEGRADED" : signals.length === 1 ? "AT_RISK" : "HEALTHY";

  return {
    goal_id: state.goal_id,
    status: state.status,
    total_checkpoints: state.checkpoint_count || rows.length,
    total_slices: state.slices.length,
    completed_slices: state.slices.filter((s) => s.status === "completed").length,
    vague_next_actions: vagueCount,
    empty_evidence_count: emptyEvidence,
    has_external_evidence: hasExternal,
    signals,
    verdict,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/goal-contract-state.test.mjs`
Expected: 19 tests PASS

- [ ] **Step 5: 创建 CLI 入口**

```javascript
// scripts/goal-audit.mjs
#!/usr/bin/env node
import { auditGoal } from "./lib/goal-contract-state.mjs";
import { join } from "node:path";

const goalId = process.argv[2] || null;
const stateRoot = join(process.cwd(), ".state/goal-contract");

try {
  const report = auditGoal(goalId, stateRoot);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "DEGRADED" ? 1 : 0);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/goal-contract-state.mjs scripts/goal-audit.mjs test/goal-contract-state.test.mjs
git commit -m "feat(goal-contract): audit script with degradation signal detection"
```

---

### Task 8: 清理旧 skill

**Deps:** Task 6

**Files:**
- Modify: `skill-overrides/goal-contract/SKILL.md`

**Interfaces:**
- Consumes: 新 Extension 已就位（Task 4-6）
- Produces: skill 降级为 init 参考文档，移除 runtime 职责

- [ ] **Step 1: 精简 SKILL.md**

将 SKILL.md 的 frontmatter description 改为：

```yaml
description: Reference for writing effective goal objectives and slice decomposition. Runtime enforcement is handled by the goal-contract Pi Extension (goal_init/goal_status/goal_checkpoint/goal_block tools). Do not load this skill for execution-time state management.
```

删除以下 sections（已由 Extension 接管）：
- Core Rules 中的 2-9（Claim Thresholds、Confidence Labels、Limits、Practice Evidence Lanes、Architectural Red Lines、Drift Detectors、Slice Ordering Gate、Compaction Recovery Guard、Amendment Policy）
- Modes 中的 checkpoint / resume / amend
- Workflow 中的 5-7（Activate the Runtime、Checkpoint Each Loop、Drift Audit）
- Completion Rules
- Output Status

保留：
- When to Use（改为"初始化长任务时参考"）
- Workflow 1-3（Intake、Create Contract、Decompose into Slices）
- 模板引用（作为 init 时的参考格式）

- [ ] **Step 2: 验证 skill 文件语法正确**

Run: `head -20 skill-overrides/goal-contract/SKILL.md`
Expected: frontmatter 完整，description 已更新

- [ ] **Step 3: Commit**

```bash
git add skill-overrides/goal-contract/SKILL.md
git commit -m "refactor(goal-contract): slim skill to init reference, runtime moved to extension"
```

---

### Task 9: 集成验证

**Deps:** Task 5, Task 6, Task 7, Task 8

**Files:** 无新文件

- [ ] **Step 1: 运行全部 goal-contract 测试**

Run: `node --test test/goal-contract-state.test.mjs test/goal-contract-extension.test.mjs`
Expected: 全部 PASS

- [ ] **Step 2: 运行仓库全量测试确认无回归**

Run: `npm test`
Expected: 无新增失败

- [ ] **Step 3: 手动冒烟 — 模拟 init → checkpoint → status 流程**

```bash
cd /tmp && mkdir gc-smoke && cd gc-smoke && git init
node "$HOME/pi-config/scripts/lib/goal-contract-state.mjs" 2>/dev/null || true
# 通过 node -e 调用
node -e "
import { initGoal, getStatus, checkpoint } from 'file://$HOME/pi-config/scripts/lib/goal-contract-state.mjs';
const root = '.state/goal-contract';
initGoal({ objective: 'Smoke test', slices: [{ id: 's1', description: 'Verify tools work end to end' }] }, root);
console.log(getStatus(null, root).goal_id);
checkpoint('smoke-test', { sliceId: 's1', status: 'completed', evidence: { type: 'diff', ref: 'git diff' }, evidenceSource: 'self_produced', nextAction: 'Verify the smoke test completed successfully and report' }, root);
console.log(getStatus('smoke-test', root).status);
"
```

Expected: 输出 `smoke-test` 和 slice 状态变更

- [ ] **Step 4: 最终 Commit（如有修复）**

```bash
git add -A
git commit -m "fix(goal-contract): integration fixes from smoke test"
```
