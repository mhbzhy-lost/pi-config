# Plan Runner Supervisor 兼容 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使 plan-runner 机制与 pi-subagents supervisor 特性兼容：修复 plan 文件缺失/哈希过期的根因，并增加 supervisor override 兜底路径。

**Architecture:** 三层修复：(1) plan_run 启动时将 plan 文件同步到 worktree 确保文件存在；(2) plan_open 支持 supervisor-approved 哈希覆盖作为兜底；(3) plan-runner agent prompt 允许在 supervisor 批准后偏离 bootstrap 参数。

**Tech Stack:** Node.js (ESM), node:test, 现有 plan infrastructure (`scripts/lib/plan/`)

---

## Execution Contract

```json
{"schemaVersion":"pi-plan.v1","verification":["node --test test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs test/parent-lifecycle.test.mjs"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
```

## 文件结构

```
scripts/lib/plan/
├── plan-launcher-extension.mjs   # 修改：launchPlan 中同步 plan 文件到 worktree
├── plan-runner-dependencies.mjs  # 修改：readBinding 支持 supervisorApprovedHash
├── plan-capsule-extension.mjs    # 修改：plan_open 参数增加 approvedHash 字段
pi/agents/
├── plan-runner.md                # 修改：prompt 允许 supervisor-approved 偏离
test/
├── plan-launcher-extension.test.mjs  # 新增测试
├── plan-capsule-extension.test.mjs   # 新增测试
```

---

### Task 1: plan_run 启动时同步 plan 文件到 worktree

**Files:**
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs:210-230`
- Test: `test/plan-launcher-extension.test.mjs`

- [ ] **Step 1: 编写失败测试——plan 文件不在 baseCommit 时 launchPlan 仍成功**

在 `test/plan-launcher-extension.test.mjs` 末尾添加：

```javascript
test("plan-run copies plan file into worktree when absent from baseCommit", async () => {
  const { root, planPath } = await fixture();
  const worktree = join(root, "var", "plan-worktrees", "plan-one");
  const entry = join(root, "pi", "child-extensions", "plan-runner.ts");
  try {
    await mkdir(join(root, "pi", "child-extensions"), { recursive: true });
    await writeFile(entry, "export default function () {}\n");
    let spawnedTask = "";
    const { commands } = setup({
      originRoot: root,
      stateRoot: root,
      readBaseCommit: async () => "a".repeat(40),
      planRunnerEntry: entry,
      createWorkspace: async (input) => {
        // Simulate worktree without the plan file
        await mkdir(join(worktree, "docs", "superpowers", "plans"), { recursive: true });
        return { ...input, workspacePath: worktree };
      },
      createParentLease: (input) => ({
        path: join(root, "var", "plan-runs", input.planId, "control", "parent-lease.json"),
        beat: async () => {},
        start: () => {},
        stop: () => {},
        remove: async () => {},
      }),
      createRpcClient: () => ({
        spawn: async (params) => {
          spawnedTask = params.task;
          // Verify plan file now exists in worktree
          const content = await readFile(join(worktree, "docs", "superpowers", "plans", "2026-01-01-test-plan.md"), "utf8");
          assert.match(content, /pi-plan\.v1/);
          return { details: { runId: "run-1", asyncDir: "/async", results: [{ sessionFile: "/session" }] } };
        },
      }),
      id: () => "plan-one",
    });
    await commands.get("plan-run").handler(planPath, { mode: "tui", hasUI: true, ui: { confirm: async () => true } });
    assert.match(spawnedTask, /planHash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --test-name-pattern="copies plan file" test/plan-launcher-extension.test.mjs`
Expected: FAIL — worktree 中无 plan 文件，spawn 内 readFile 抛 ENOENT

- [ ] **Step 3: 实现 plan 文件同步**

在 `plan-launcher-extension.mjs` 的 `launchPlan` 函数中，`createWorkspace` 之后、`rpc().spawn` 之前，添加：

```javascript
// Ensure plan file exists in worktree (may not be in baseCommit)
const worktreePlanPath = path.join(worktree, planPath);
try {
  await access(worktreePlanPath);
} catch {
  await mkdir(path.dirname(worktreePlanPath), { recursive: true });
  await copyFile(planPath, worktreePlanPath);
}
```

需要在文件顶部增加 `copyFile` 的 import（从 `node:fs/promises`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test --test-name-pattern="copies plan file" test/plan-launcher-extension.test.mjs`
Expected: PASS

- [ ] **Step 5: 运行全量 launcher 测试确认无回归**

Run: `node --test test/plan-launcher-extension.test.mjs`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/plan/plan-launcher-extension.mjs test/plan-launcher-extension.test.mjs
git commit -m "fix(plan): sync plan file into worktree at launch time"
```

---

### Task 2: plan_open 支持 supervisor-approved 哈希覆盖

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs` (plan_open parameters)
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs:readBinding`
- Test: `test/plan-capsule-extension.test.mjs`

- [ ] **Step 1: 编写失败测试——plan_open 接受 approvedHash 覆盖**

在 `test/plan-capsule-extension.test.mjs` 中添加：

```javascript
test("plan_open accepts supervisor-approved hash override when file hash differs", async () => {
  const actualHash = "b".repeat(64);
  const binding = {
    planId: "release-11", planPath: "/plan.md",
    planHash: "a".repeat(64), baseCommit: "base",
    worktree: "/worktree", allowPlanCommits: true,
    approvedHash: actualHash,
  };
  const { tools } = setup({
    validateBinding: async (input) => {
      // readBinding should accept approvedHash as the effective hash
      assert.equal(input.planHash, actualHash);
      return { ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] };
    },
  });
  const result = await execute(tools.get("plan_open"), binding);
  assert.equal(result.isError, false, result.content[0].text);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --test-name-pattern="approved hash override" test/plan-capsule-extension.test.mjs`
Expected: FAIL — `approvedHash` 不在 parameters schema 中，或 validateBinding 收到的 planHash 仍是原值

- [ ] **Step 3: 修改 plan_open parameters schema 和 readBinding**

`plan-capsule-extension.mjs` 中 `plan_open` 的 parameters 增加可选字段：

```javascript
approvedHash: { type: "string", minLength: 64, maxLength: 64 },
```

`plan-runner-dependencies.mjs` 的 `readBinding` 中，在哈希校验前：

```javascript
const effectiveHash = input.approvedHash ?? input.planHash;
// ...
if (plan.sha256 !== effectiveHash) throw new Error("Plan hash does not match approved plan.");
```

同时在 `readBinding` 的字段校验循环中将 `approvedHash` 排除（它是可选的）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test --test-name-pattern="approved hash override" test/plan-capsule-extension.test.mjs`
Expected: PASS

- [ ] **Step 5: 运行全量 capsule 测试确认无回归**

Run: `node --test test/plan-capsule-extension.test.mjs test/plan-capsule-gate-enforcement.test.mjs`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/plan-runner-dependencies.mjs test/plan-capsule-extension.test.mjs
git commit -m "fix(plan): support supervisor-approved hash override in plan_open"
```

---

### Task 3: plan-runner agent prompt 兼容 supervisor 决策

**Deps:** Task 2

**Files:**
- Modify: `pi/agents/plan-runner.md`

- [ ] **Step 1: 更新 plan-runner agent prompt**

将 `pi/agents/plan-runner.md` 的 body 从：

```
Open the approved plan before coordinating it. Use only the Plan tools for lifecycle intent.
```

改为：

```
Open the approved plan before coordinating it. Use only the Plan tools for lifecycle intent.

If plan_open fails due to a missing file or hash mismatch, contact the supervisor for a decision.
When the supervisor approves an alternate hash, retry plan_open with the approvedHash field set to the supervisor-approved value.
```

- [ ] **Step 2: 验证 agent 定义格式合法**

Run: `node -e "const fs=require('fs'); const s=fs.readFileSync('pi/agents/plan-runner.md','utf8'); if(!s.startsWith('---')) throw new Error('bad frontmatter'); console.log('OK')"`
Expected: OK

- [ ] **Step 3: Commit**

```bash
git add pi/agents/plan-runner.md
git commit -m "fix(plan): allow plan-runner to use supervisor-approved hash override"
```

---

### Task 4: readBinding 中 plan 文件路径解析修复

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs:readBinding`
- Test: `test/plan-capsule-extension.test.mjs`

- [ ] **Step 1: 编写失败测试——planPath 相对于 worktree 解析**

```javascript
test("plan_open resolves planPath relative to worktree cwd", async () => {
  const binding = {
    planId: "release-11",
    planPath: "docs/plans/my-plan.md",
    planHash: "a".repeat(64),
    baseCommit: "base",
    worktree: "/worktree",
    allowPlanCommits: true,
  };
  let readPath = "";
  const { tools } = setup({
    validateBinding: async (input, { ctx }) => {
      // readBinding should resolve planPath against ctx.cwd (the worktree)
      readPath = input.planPath;
      return { ...input, originRoot: "/origin", headCommit: "base", tasks: [{ id: "task-1" }] };
    },
  });
  const ctx = context();
  ctx.cwd = "/worktree";
  await execute(tools.get("plan_open"), binding, ctx);
  assert.equal(readPath, "docs/plans/my-plan.md");
});
```

注意：此测试验证 `readBinding` 使用 `ctx.cwd` 解析相对路径。当前实现已经这样做（`readFile(input.planPath)` 在 cwd 为 worktree 时解析正确），此测试为防回归。如果已通过则标记为豁免。

- [ ] **Step 2: 运行测试确认状态**

Run: `node --test --test-name-pattern="resolves planPath relative" test/plan-capsule-extension.test.mjs`
Expected: 如果已通过，声明豁免（已有行为覆盖）；如果失败则实现修复

- [ ] **Step 3: Commit（如有变更）**

```bash
git add scripts/lib/plan/plan-runner-dependencies.mjs test/plan-capsule-extension.test.mjs
git commit -m "test(plan): verify planPath resolves relative to worktree"
```
