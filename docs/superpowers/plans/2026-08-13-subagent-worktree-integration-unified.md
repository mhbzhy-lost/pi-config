# Subagent 受管 Worktree 集成/释放统一修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 每个产生逻辑变更的任务先加载 `test-driven-development`，亲眼观察目标测试 RED 后再写实现。Steps 使用 checkbox（`- [ ]`）跟踪。

**Goal:** 让并行 `execution.worktree:true` 的 coding 子代理在各自 worktree 完成后，能经 typed `workspace_disposition` 合回主干并释放，不再被迫手动 `git merge` + 手动清理。

**Architecture:** 修复共享原语而非 fork 路径：writePath 目录语义在 `goal-engine/workspace.mjs` 一处修正；subagent 的 integrate 删除手写 origin 冻结门禁，复用 goal engine `disposing` 阶段已有的 `inspectOriginIntegrationBaseline({ allowForwardAdvance: true })`；被拒原因、一次性 action token、`release` 处置全部提升到模型可见的工具文本。

**Tech Stack:** Node.js ESM、Pi Extension API、`node:test`（`test/*.test.mjs` / `test/*.integration.mjs`）、临时 Git 仓库 fixture。

## Global Constraints

- 所有逻辑变更先 RED 后 GREEN；纯文档/单行改动可豁免但须声明理由。
- 只改本计划声明的 WritePaths；禁止改 goal engine 顺序 `integrating` 阶段的 `allowForwardAdvance=false` 不变量。
- 禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`；释放仍走 owner-CAS + 无 `--force`。
- 保持向后兼容：裸文件路径（如 `src/a.py`）仍按精确文件匹配；只有 `/**` 或结尾 `/` 视为目录前缀。
- 当前 pi-config 有未提交改动（spark 移除等），executor 以 `worktree:false` 在本仓内联工作，只动各自 WritePaths，不提交、不暂存。
- 回归基线：`node --test test/goal-engine-workspace.integration.mjs test/subagent-dispatch-workspace.integration.mjs test/subagent-workspace-controller.integration.mjs test/subagent-workspace-ledger.integration.mjs test/subagent-runtime-membrane.test.mjs` 全部 PASS，无新增 warning。

---

## Task 1: 共享 writePath 目录语义 + 可操作错误

**Deps:** none

**WritePaths:**
- `scripts/lib/goal-engine/workspace.mjs`
- `test/goal-engine-workspace.integration.mjs`

**Interfaces:**
- Consumes: 现有 `assertWorkspaceChangesWithinPaths(inspection, writePaths)`（已导出）；内部 `describeWritePath`/`matchesWritePath` 不导出，仅经该函数观察行为。
- Produces:
  - `assertWorkspaceChangesWithinPaths({ changedFiles: ["src/a.py"] }, ["src/"])` 不抛错（结尾 `/` 视为目录前缀）。
  - `assertWorkspaceChangesWithinPaths({ changedFiles: ["src/a.py"] }, ["src"])` 抛错，且 Error.message 必须包含：越界文件、writePaths、以及提示 `use "dir/**" or "dir/" for a directory`。
  - 裸文件路径（如 `src/a.py`）仍按精确文件匹配（不变）。

- [ ] **Step 1: 写 RED**

在 `test/goal-engine-workspace.integration.mjs` 追加（复用既有 `import * as workspace` 与 `assertWorkspaceChangesWithinPaths` 引用方式）：

```js
test("writePath ending with slash is a directory prefix", () => {
  assert.doesNotThrow(() =>
    workspace.assertWorkspaceChangesWithinPaths({ changedFiles: ["src/a.py"] }, ["src/"]),
  );
});

test("bare writePath mismatch error hints directory syntax", () => {
  assert.throws(
    () => workspace.assertWorkspaceChangesWithinPaths({ changedFiles: ["src/a.py"] }, ["src"]),
    /use "dir\/\*\*" or "dir\/" for a directory/,
  );
});
```

- [ ] **Step 2: 运行 RED 观察失败**

Run: `node --test test/goal-engine-workspace.integration.mjs`
Expected: FAIL —— `src/` 触发 "empty segment" 拒绝；裸 `src` 越界错误不含提示语。

- [ ] **Step 3: 最小实现**

`describeWritePath` 增加 `if (writePath.endsWith("/"))` 分支，归一为 `{ type: "dir", prefix: writePath.replace(/\/+$/, "") + "/", raw }`（与 `/**` 分支共用校验）。`assertWorkspaceChangesWithinPaths` 的 throw 信息末尾追加提示语。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2。Expected: PASS；既有 `/**` 与裸文件用例（line 248-314 一带）不变。

- [ ] **Step 5: 不提交**

仅修改工作树，不 `git commit`、不暂存（当前 pi-config 有未提交改动，提交由主 agent 统一处理）。

---

## Task 2: integrate 资格重做（前进容忍 + 被拒原因）与 preserved 释放原语

**Deps:** Task 1

**WritePaths:**
- `scripts/lib/subagent-dispatch/workspace-controller.mjs`
- `scripts/lib/subagent-dispatch/workspace.mjs`
- `test/subagent-workspace-controller.integration.mjs`
- `test/subagent-dispatch-workspace.integration.mjs`

**Interfaces:**
- Consumes: Task 1 的 `describeWritePath`/`assertWorkspaceChangesWithinPaths` 行为；`goal-engine/workspace.mjs` 的 `inspectOriginIntegrationBaseline`、`integrateExecutorWorkspace`、`isExecutorWorkspaceIntegrated`；`workspace-ledger.mjs` 的 `recoverPrivateWorkspaceLease`、`publicWorkspace`。
- Produces:
  - `statusManagedSubagentWorkspace({ originRoot, workspaceId, terminalProof })` 返回 `result(record, { allowedDispositions, actionToken, integrateBlockedReasons })`，其中 `integrateBlockedReasons: string[]` 逐条给出 integrate 被拒原因（`origin-advanced` / `writePaths-out-of-scope` / `workspace-dirty` / `no-commits` / `origin-dirty` / `origin-ref-drift` / `terminal-unobserved` 等）。
  - `integrateSubagentWorkspace` 删除 `state.originHead !== lease.originHeadAtAllocation` 硬失败，改调 `inspectOriginIntegrationBaseline(goalLease(lease), { originRef, originHeadBefore: lease.originHeadAtAllocation, allowForwardAdvance: true })` 得到 baseline，再 `integrateExecutorWorkspace(goalLease(lease), { strategy, executorHead, originRef, originHeadBefore: baseline.currentHead })`。
  - `releasePreservedSubagentWorkspace({ originRoot, workspaceId })`：state 为 `preserved` 时 `markDisposition(reclaimable)` + `releaseManagedWorktree`，并把 ledger 终态置为 `released`（复用 `recoverPrivateWorkspaceLease` 的 ownerToken 做 CAS）。

- [ ] **Step 1: 写 RED（被拒原因 + 前进容忍）**

`test/subagent-workspace-controller.integration.mjs` 追加：

```js
test("status surfaces integrate blocked reason when origin advanced", () => {
  // 分配 workspace 后，在 origin 上制造一个干净前进 commit
  // status 断言 result.integrateBlockedReasons 含 "origin-advanced"，且 allowedDispositions 无 integrate
});

test("integrate tolerates clean forward origin advance", () => {
  // origin 前进一个无关 commit 后，dispose(integrate) 仍成功，origin 含 executor 提交且无冲突
});
```

- [ ] **Step 2: 运行 RED 观察失败**

Run: `node --test test/subagent-workspace-controller.integration.mjs test/subagent-dispatch-workspace.integration.mjs`
Expected: FAIL —— 现状 `originHead !== originHeadAtAllocation` 直接不 offer/抛 `WORKTREE_ORIGIN_DRIFT`。

- [ ] **Step 3: 最小实现**

按 Interfaces 改造 `statusManagedSubagentWorkspace`（把 integrate 资格判定重构为逐条件收集 reasons，而非 `try/catch{}` 吞掉）、`integrateSubagentWorkspace`（前进容忍）、新增 `releasePreservedSubagentWorkspace` 并导出。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2。Expected: PASS；`preserve`/`discard`/`reclaimable`/`released` 现有行为不变。

- [ ] **Step 5: 不提交**

仅修改工作树，不 `git commit`、不暂存（提交由主 agent 统一处理）。

---

## Task 3: 续作 run 重绑 terminal proof

**Deps:** none

**WritePaths:**
- `scripts/lib/subagent-dispatch/workspace-ledger.mjs`
- `test/subagent-workspace-ledger.integration.mjs`

**Interfaces:**
- Consumes: 现有 `bindWorkspaceRun({ lease, runId, asyncDir })`、`recoverPrivateWorkspaceLease`。
- Produces: `bindWorkspaceRun` 在 `state === "active"` 且旧 `runId` 非空时，允许用新 `runId`/`asyncDir` 覆盖绑定（旧 run 的 terminal proof 已被 observed 是调用方前提）；其余状态仍拒绝，避免静默重绑活跃运行。

- [ ] **Step 1: 写 RED**

`test/subagent-workspace-ledger.integration.mjs` 追加：

```js
test("rebinds run for an active workspace with a prior bound run", () => {
  // 先 bind runA，再 bind runB；断言 record.runId === runB 且 asyncDir 更新
});

test("rejects rebind when no prior run is bound or state is not active", () => {
  // 未绑定直接 bind 仍成功一次；state=preserved 时重绑抛 WORKSPACE_LEDGER_STATE
});
```

- [ ] **Step 2: 运行 RED 观察失败**

Run: `node --test test/subagent-workspace-ledger.integration.mjs`
Expected: FAIL —— 现状 `record.runId !== null` 直接拒绝二次绑定。

- [ ] **Step 3: 最小实现**

把 `bindWorkspaceRun` 的守卫从 `record.runId !== null` 改为「`state !== "active"` 或 `asyncDir` 非法才拒绝」，允许覆盖已绑定的旧 run。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: 不提交**

仅修改工作树，不 `git commit`、不暂存（提交由主 agent 统一处理）。

---

## Task 4: extension 接线（action offer 文本 + release 处置 + 续作 bind）

**Deps:** Task 2, Task 3

**WritePaths:**
- `scripts/lib/subagent-dispatch/extension.ts`
- `test/subagent-runtime-membrane.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `integrateBlockedReasons` 与 `releasePreservedSubagentWorkspace`；Task 3 的重绑 `bindWorkspaceRun`；现有 `executeWorkspaceAction`、`workspacePublic`、`WORKSPACE_DISPOSITION_SCHEMA`。
- Produces:
  - `workspace_status` 的 `content[0].text` 直接包含 `action_token`、`allowed_dispositions`、`integrate_blocked_reasons`（不再只依赖 `details`）。
  - `WORKSPACE_DISPOSITION_SCHEMA.disposition` 增加 `"release"`；`executeWorkspaceAction` 对 `release` 调用 `controller.releaseManagedSubagentWorkspace({ originRoot, workspaceId })`（`release` 不需要 `action_token`，但需要 origin 归属校验）。
  - 续作 spawn 仍复用 `onBinding` 里调 `controller.bindManagedSubagentWorkspaceRun`；重绑语义由 Task 3 的 ledger 层支持。

- [ ] **Step 1: 写 RED**

`test/subagent-runtime-membrane.test.mjs` 追加：

```js
test("workspace_status text exposes action token and blocked reasons", async () => {
  // facade 返回含 allowedDispositions/integrateBlockedReasons 的 status
  // 断言 result.content[0].text 包含 action_token 与 integrate_blocked_reasons
});

test("workspace_disposition release is accepted and releases preserved workspace", async () => {
  // 构造 preserved workspace，调用 disposition=release，断言不再抛 schema 错误且 controller.release 被调
});
```

- [ ] **Step 2: 运行 RED 观察失败**

Run: `node --test test/subagent-runtime-membrane.test.mjs`
Expected: FAIL —— schema 拒绝 `release`，`content[0].text` 只含 `Workspace <id>: <state>`。

- [ ] **Step 3: 最小实现**

`executeWorkspaceAction` 的 `workspace_status` 分支把 `workspacePublic` 的公开字段拼进 `content[0].text`；`workspace_disposition` 增加 `release` 分支；`WORKSPACE_DISPOSITION_SCHEMA` 增加 `"release"`；`TYPED_SUBAGENT_DESCRIPTION` 增加一句 release 说明。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2，并追加 `node --test test/subagent-workspace-controller.integration.mjs test/subagent-workspace-ledger.integration.mjs`。Expected: PASS。

- [ ] **Step 5: 不提交**

仅修改工作树，不 `git commit`、不暂存（提交由主 agent 统一处理）。

---

## Task 5: SKILL 与文档

**Deps:** Task 4

**WritePaths:**
- `skill-overrides/subagent-dispatch/SKILL.md`
- `docs/bugs/2026-08-13-subagent-managed-worktree-integration-lifecycle.md`

**Interfaces:** 无代码接口；产出面向主 agent 的合同文案。

- [ ] **Step 1: 更新 SKILL**

在 `skill-overrides/subagent-dispatch/SKILL.md` 增加：目录型 `writePaths` 必须写 `path/**`（或 `path/`）；`workspace_status` 会返回 `action_token`/`allowed_dispositions`/`integrate_blocked_reasons`；`workspace_disposition` 支持 `integrate | preserve | discard | release`；`release` 用于释放 `preserved` worktree。

- [ ] **Step 2: 补 bug 文档证据**

在 bug 文档补各任务 RED/GREEN 结果与最终基线命令输出。

- [ ] **Step 3: 校验**

Run: `git diff --check -- skill-overrides/subagent-dispatch/SKILL.md docs/bugs/2026-08-13-subagent-managed-worktree-integration-lifecycle.md`
Expected: PASS。

---

## Task 6: 端到端集成验收

**Deps:** Task 2, Task 3, Task 4

**WritePaths:**
- `test/subagent-managed-worktree.integration.mjs`

**Interfaces:**
- Consumes: Task 2/3/4 的完整 typed 流程。

- [ ] **Step 1: 写并行 worktree 顺序集成 RED**

用临时干净 Git 仓库：分配两个 `execution.worktree:true` workspace（同一 base），各自提交互不重叠文件；先 `integrate` 第一个（origin 前进），再 `integrate` 第二个（验证前进容忍）；随后对两者 `release`；断言 origin 含两批提交、`git worktree list` 无残留、ledger 全 `released`。

- [ ] **Step 2: 运行 RED 观察失败**

Run: `node --test test/subagent-managed-worktree.integration.mjs`
Expected: FAIL 于第二个 integrate 的 `WORKTREE_ORIGIN_DRIFT` / release 不可用。

- [ ] **Step 3: 运行 GREEN（复用前序实现）**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 4: 全量回归**

```bash
node --test test/goal-engine-workspace.integration.mjs test/subagent-dispatch-workspace.integration.mjs test/subagent-workspace-controller.integration.mjs test/subagent-workspace-ledger.integration.mjs test/subagent-runtime-membrane.test.mjs test/subagent-managed-worktree.integration.mjs
```

Expected: 全部 PASS，无新增 warning。

---

## DAG 依赖图

```text
Task 1 (writePath 语义) ──────┐
                              ├──> Task 2 (integrate 资格 + release 原语) ──┐
Task 3 (续作重绑) ────────────┴───────────────────────────────────────────┼──> Task 4 (extension 接线) ──> Task 5 (SKILL/文档)
                                                                           │              │
                                                                           └──> Task 6 (端到端验收) <──┘
```

- `T1 -> T2`：T2 的 `assertWorkspaceChangesWithinPaths` 被拒原因依赖 T1 的可操作错误。
- `T3 -> T4`：T4 的续作 bind 接线依赖 T3 的重绑语义。
- `T2 -> T4`：T4 的 `release`/`integrateBlockedReasons` 依赖 T2 产出。
- `T2,T3,T4 -> T6`：端到端需要完整 typed 流程。
- `T4 -> T5`：SKILL 引用最终 disposition 名与可见字段。

## 并行调度组（Wave）

- **Wave 0:** Task 1、Task 3（并行，WritePaths 无重叠）
- **Wave 1:** Task 2（依赖 Task 1）
- **Wave 2:** Task 4（依赖 Task 2、Task 3）
- **Wave 3:** Task 5（依赖 Task 4）、Task 6（依赖 Task 2、Task 3、Task 4）并行

Wave 不是派发屏障；按依赖边触发，前驱完成即可派发。设备/端口无资源竞争，不加 DAG 依赖。

## 收尾待办（用户已确认）

计划全部跑完后，做一次干净提交拆分：`git reset` 回 `fc94d95`，把 `4916acd` 拆成纯 `refactor`（重命名 + spark 移除 + SKILL，不含 Task 1/3 的测试改动）与本次 bugfix 的独立提交（Task 1–6 源码 + 测试一起，每个提交自洽且绿）。当前 `4916acd` 因测试改动已提交而源码未提交，中间态测试会红，需修复。

## 自审结果

- **规格覆盖**：6 条根因分别落到 Task 1（②）、Task 2（①③⑥ 原语）、Task 3（④）、Task 4（⑤⑥ 接线）、Task 5（文档）、Task 6（闭环）。
- **占位符检查**：无 TBD；RED 用行为断言表述，具体 fixture 由 executor 按既有测试文件模式构造。
- **类型一致**：`integrateBlockedReasons`、`release`、`bindWorkspaceRun` 命名在各任务一致。
- **无 fork**：writePath 语义只改共享 `goal-engine/workspace.mjs`；integrate 复用 `inspectOriginIntegrationBaseline`，不新建路径；goal engine `integrating` 阶段 `allowForwardAdvance=false` 保持。
