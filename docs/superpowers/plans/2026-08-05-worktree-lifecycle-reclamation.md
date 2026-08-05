# Worktree 生命周期与回收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 每个逻辑变更 Task 先加载 `test-driven-development`，严格执行 RED→GREEN；涉及 Agent 派发时加载 `subagent-dispatch`。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 为所有 Agent 管理的 Git worktree 建立持久归属、终态回收、失败债务审计和测试 teardown，并安全处置当前 93 个历史 linked worktree。

**Architecture:** 以一个通用 worktree lifecycle 层统一记录 allocation intent、owner token、资源 identity 和 disposition，但不接管 Git 分支内容决策。Goal Engine 保留 exact-seven typed tools和自己的事件权威，只把 worktree 资源创建/释放接入通用 ownership 记录；typed subagent、Root Broker 和 Supervisor 继续只管理进程与消息。正常完成路径同步回收，crash/dirty/preserve/unmanaged 只报告 cleanup debt，绝不依赖 TTL 自动删除。

**Tech Stack:** Node.js ESM、`node:test`、Git linked worktree/plumbing、原子 JSON manifest、现有 Goal Engine v2 事件状态机、Pi Doctor 与 shell-policy。

## Global Constraints

- 不直接编辑 `.state/goal-engine/**`、Goal events/projection/registry；Goal mutation 继续只通过七个 typed tools。
- Goal Engine 工具集必须精确保持七个，不新增 `goal_cleanup` 或其它 model-facing tool。
- routine cleanup 禁止 `git worktree remove --force`；只有已有 typed `discard` 且经过 identity/cleanliness fence 的 Goal 路径保留显式丢弃语义。
- worktree removal 与 branch/ref 删除解耦；本计划默认保留 branch，branch GC 不以 `git cherry` patch-equivalent 单独授权。
- `preserve`、archive、recovery refs、dirty worktree、Git sequencer、活跃 owner、TokenRec 外部仓资源永不被 TTL 自动删除。
- 当前 `pi/settings.json` 用户版本不得进入提交；`skill-overrides/aliyun-beijing-server/` 不得修改或跟踪。
- 先修复未来泄漏，再执行一次性历史清理；清理前后都产出 machine-readable inventory。
- Bug 根因文档已建立：
  - `docs/bugs/bug-agent-worktrees-lack-durable-ownership-and-reclamation.md`
  - `docs/bugs/bug-goal-engine-tests-leak-temporary-worktree-fixtures.md`
  - `docs/bugs/bug-goal-engine-allocation-can-leak-worktree-before-lease.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `scripts/lib/worktree-lifecycle/inventory.mjs` | 解析 Git worktree、status、sequencer、owner/lease，输出只读分类事实 |
| `scripts/lib/worktree-lifecycle/registry.mjs` | 原子持久化 allocation intent、owner token、state transition 和 cleanup debt |
| `scripts/lib/worktree-lifecycle/managed-worktree.mjs` | 受控 create/adopt/release/preserve；routine release 永不删 branch |
| `scripts/worktree-lifecycle.mjs` | `audit/create/adopt/release/preserve` CLI；默认 `audit`/dry-run |
| `scripts/lib/goal-engine/workspace.mjs` | Goal Engine 分配与释放接入 lifecycle intent，保留现有 lease envelope |
| `scripts/lib/goal-engine/extension.mjs` | 在七工具既有 dispatch/disposition 边界提交 owner transition |
| `scripts/doctor.mjs` | 报告 unmanaged、cleanup-debt、dirty、sequencer 和 test fixture backlog |
| `scripts/lib/shell-policy.mjs` | 阻止 Agent 通过 raw mutating `git worktree` 绕过 owner registry |
| `test/helpers/temporary-arena.mjs` | 文件级登记并 teardown 临时 Git repo/state/worktree fixture |
| `test/worktree-lifecycle-*.test.mjs` | inventory、registry、CLI、并发、crash 和安全门禁回归 |
| `docs/audits/2026-08-05-worktree-lifecycle-audit.md` | 一次性历史 inventory 与处置分组 |

---

### Task 1: 只读 Inventory 与稳定分类

**Files:**
- Create: `scripts/lib/worktree-lifecycle/inventory.mjs`
- Create: `scripts/worktree-lifecycle.mjs`
- Create: `test/worktree-lifecycle-inventory.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseWorktreePorcelain(text) -> WorktreeRegistration[]`
- Produces: `inventoryRepositoryWorktrees({ originRoot, activeProcessCwds? }) -> WorktreeFact[]`
- Produces: `classifyWorktreeFact(fact) -> { state, reasons, automaticAction }`
- `state` 精确为 `main | active | reclaimable | preserved | dirty | sequencer | cleanup-debt | unmanaged | missing`。
- `automaticAction` 只能是 `none | report | release-worktree-only`；branch 删除不在该接口中。

- [ ] **Step 1: 写 parser 与分类 RED**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseWorktreePorcelain, classifyWorktreeFact } from "../scripts/lib/worktree-lifecycle/inventory.mjs";

test("dirty、sequencer 和 unmanaged worktree 永不自动释放", () => {
  const [registration] = parseWorktreePorcelain(
    "worktree /tmp/w\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/topic\n\n",
  );
  for (const fact of [
    { registration, clean: false, operation: null, owner: null },
    { registration, clean: true, operation: "merge", owner: null },
    { registration, clean: true, operation: null, owner: null },
  ]) {
    assert.equal(classifyWorktreeFact(fact).automaticAction, "none");
  }
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test test/worktree-lifecycle-inventory.test.mjs`
Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现 NUL-safe parser 与只读 probe**

实现必须使用 `git worktree list --porcelain -z`、`git status --porcelain=v1 -z` 和 `git rev-parse`，不得解析面向人的 `git branch` 装饰。sequencer 同时检查 `MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`rebase-merge`、`rebase-apply`、`sequencer/`。任何 probe 失败返回 `state=cleanup-debt` 或 `unmanaged`，不得把错误当成“不存在”。

- [ ] **Step 4: 增加真实临时仓库矩阵**

覆盖 clean、dirty、untracked、linked path 缺失、locked、未完成 merge、active cwd、无 owner manifest。断言 CLI 默认只打印 JSON/表格，不产生 Git 或文件副作用。

- [ ] **Step 5: 运行 GREEN 并提交**

Run: `node --test test/worktree-lifecycle-inventory.test.mjs && npm run worktree:audit -- --json >/tmp/worktree-audit.json`
Expected: PASS；audit 命令退出 0 或稳定 attention code，仓库状态不变。

```bash
git add package.json scripts/lib/worktree-lifecycle/inventory.mjs scripts/worktree-lifecycle.mjs test/worktree-lifecycle-inventory.test.mjs
git commit -m "feat(worktree): 增加只读生命周期审计"
```

---

### Task 2: 持久 Owner Registry 与受控 Worktree API

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/worktree-lifecycle/registry.mjs`
- Create: `scripts/lib/worktree-lifecycle/managed-worktree.mjs`
- Modify: `scripts/worktree-lifecycle.mjs`
- Create: `test/worktree-lifecycle-registry.test.mjs`
- Create: `test/worktree-lifecycle-managed.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `beginAllocation({ originRoot, id, path, branch, baseCommit, owner }) -> { ownerToken, manifestPath }`
- Produces: `activateAllocation({ originRoot, id, ownerToken, headCommit })`
- Produces: `markDisposition({ originRoot, id, ownerToken, disposition })`
- Produces: `createManagedWorktree({ originRoot, id, branch, baseCommit, owner })`
- Produces: `releaseManagedWorktree({ originRoot, id, ownerToken })`
- Produces: `preserveManagedWorktree({ originRoot, id, ownerToken, reason })`
- Manifest state 精确为 `allocating | active | reclaimable | preserved | cleanup-debt | released`。
- `package.json` 精确提供 `"worktree": "node scripts/worktree-lifecycle.mjs"` 与 `"worktree:audit": "node scripts/worktree-lifecycle.mjs audit"`。

Owner manifest 必须包含：`schemaVersion`、`id`、`ownerKind`、`ownerId`、`ownerToken`、`originRoot`、`gitCommonDir`、`path`、`branchRef`、`baseCommit`、`headCommit`、`state`、`createdAt`、`updatedAt`、`disposition`、`lastError`。路径固定为 `.state/worktree-lifecycle/leases/<id>.json`，mode `0600`。

- [ ] **Step 1: 写 allocation intent 与 stale receipt RED**

```js
test("旧 owner receipt 不能释放 replacement owner 的 worktree", () => {
  const first = createManagedWorktree(fixture.options("task-1"));
  preserveManagedWorktree({ ...fixture.identity(first), reason: "handoff" });
  const replacement = fixture.replaceOwner(first);
  assert.throws(
    () => releaseManagedWorktree({ ...fixture.identity(first), ownerToken: first.ownerToken }),
    /owner token|receipt/i,
  );
  assert.equal(existsSync(replacement.path), true);
});
```

同时写并发 RED：两个进程对同一 `id` begin，只有一个成功；writer lock receipt 不能释放 replacement lock。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/worktree-lifecycle-registry.test.mjs test/worktree-lifecycle-managed.test.mjs`
Expected: FAIL，registry/managed 模块不存在。

- [ ] **Step 3: 实现原子 manifest 和 CAS**

使用同目录 temporary file + `renameSync` 持久化；writer lock 使用 owner token、PID birth identity 和 stale recovery guard。每次 mutation 同时验证 canonical `originRoot`、`gitCommonDir`、path、branch ref 和前一 state。未知/损坏 manifest fail closed。

- [ ] **Step 4: 实现受控 create/release/preserve**

`create` 顺序必须是 durable `allocating` intent → `git worktree add` → identity reinspection → `active`。`release` 只接受 owner-authorized、clean、无 sequencer 的 `reclaimable` worktree，并执行不带 `--force` 的 `git worktree remove <path>`；结束后复验 path 和 Git registration 消失，将 manifest 标记 `released`。**不得删除 branch。**

- [ ] **Step 5: 覆盖 crash matrix**

对 intent write、worktree add、identity inspect、activate write、worktree remove、released write 每个边界注入“未执行 / 已执行后抛错”。断言重试幂等；无法证明完成时保留资源并写 `cleanup-debt`，不产生 phantom released。

- [ ] **Step 6: 运行 GREEN 并提交**

Run: `node --test test/worktree-lifecycle-registry.test.mjs test/worktree-lifecycle-managed.test.mjs`
Expected: PASS。

```bash
git add package.json scripts/lib/worktree-lifecycle scripts/worktree-lifecycle.mjs test/worktree-lifecycle-registry.test.mjs test/worktree-lifecycle-managed.test.mjs
git commit -m "feat(worktree): 建立持久归属与受控回收"
```

---

### Task 3: 修复 Goal Engine 分配前崩溃窗口

**Deps:** Task 2

**Files:**
- Modify: `scripts/lib/goal-engine/workspace.mjs`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Modify: `test/goal-engine-workspace.test.mjs`
- Modify: `test/goal-engine-extension.test.mjs`
- Test: `test/worktree-lifecycle-managed.test.mjs`

**Interfaces:**
- Consumes: Task 2 `beginAllocation/activateAllocation/markDisposition`。
- Preserves: `allocateExecutorWorkspace(...)` 返回值和现有 Goal lease JSON exact envelope。
- Preserves: exact-seven typed tool ABI。

- [ ] **Step 1: 写 lease write/rename failure RED**

在真实临时 Git repo 中注入 `writeLeaseFn` 和 `renameLeaseFn` 失败，断言：

```js
assert.equal(result.projection.tasks.get("t1").attempts, 0);
assert.equal(inventory.owner.state, "cleanup-debt");
assert.equal(inventory.owner.ownerKind, "goal-engine");
assert.equal(inventory.automaticAction, "none");
```

重试必须复用 exact allocation intent，不得创建 attempt-2 或第二 branch。

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-name-pattern='allocation intent|lease write|lease rename' test/goal-engine-workspace.test.mjs`
Expected: FAIL；当前 `git worktree add` 后没有 durable intent。

- [ ] **Step 3: 最小实现 Goal adapter**

在 `git worktree add` 前 begin；现有 lease rename 成功并复验 Git common-dir/branch/HEAD 后 activate。合同编译或 event append 未提交时，先走已有 `failed-cleanup`，再提交 lifecycle `released`；若补偿失败，保留原错为 cause 并标记 cleanup debt。

- [ ] **Step 4: 将 disposition 绑定到 owner state**

`integrate/discard` 的 `task.workspace_disposed(released=true)` 只有在 Git path、registration、Goal lease 和 lifecycle owner 都已释放后才能追加。`preserve` 对应 owner `preserved`；后续 typed discard 复验 owner token 后释放。

- [ ] **Step 5: 运行 Goal Engine 冻结回归**

Run: `node --test test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-events.test.mjs test/goal-engine-graph.test.mjs`
Expected: 全部通过，工具列表仍精确七个。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/goal-engine/workspace.mjs scripts/lib/goal-engine/extension.mjs test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs test/worktree-lifecycle-managed.test.mjs
git commit -m "fix(goal-engine): 持久化 worktree 分配意图"
```

---

### Task 4: Cleanup Debt 可见性与幂等重试

**Deps:** Task 1, Task 2, Task 3

**Files:**
- Modify: `scripts/lib/worktree-lifecycle/inventory.mjs`
- Modify: `scripts/worktree-lifecycle.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Create: `test/worktree-lifecycle-recovery.test.mjs`

**Interfaces:**
- Produces: `reconcileManagedWorktrees({ originRoot, apply }) -> ReconciliationReport`
- `apply=false` 永远只读。
- `apply=true` 只重试 manifest 已 durable 授权为 `reclaimable`/released-debt 的 clean worktree；active/preserved/dirty/sequencer/unmanaged 永不删除。

- [ ] **Step 1: 写 Doctor 与 recovery RED**

构造以下资源 bitmap：`000`、`001`、`010`、`011`、`100`、`101`、`110`、`111`（path/registration/manifest）。Doctor 必须逐项报告稳定 code；apply 只能修复 owner identity 完整且 disposition 已授权的组合。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/worktree-lifecycle-recovery.test.mjs test/doctor.test.mjs`
Expected: FAIL，Doctor 尚不知道 cleanup debt。

- [ ] **Step 3: 实现报告与安全重试**

稳定 codes：`WORKTREE_UNMANAGED`、`WORKTREE_DIRTY`、`WORKTREE_SEQUENCER_ACTIVE`、`WORKTREE_OWNER_ACTIVE`、`WORKTREE_CLEANUP_DEBT`、`WORKTREE_PRESERVED`、`WORKTREE_IDENTITY_MISMATCH`。TTL 只改变 warning 严重度，不改变删除授权。

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `node --test test/worktree-lifecycle-recovery.test.mjs test/doctor.test.mjs && npm run doctor`
Expected: PASS；当前历史 worktree 以 warning/debt 报告，不被修改。

```bash
git add scripts/lib/worktree-lifecycle/inventory.mjs scripts/worktree-lifecycle.mjs scripts/doctor.mjs test/worktree-lifecycle-recovery.test.mjs test/doctor.test.mjs
git commit -m "feat(worktree): 报告并重试回收债务"
```

---

### Task 5: 修复 Goal Engine 测试 Fixture 泄漏

**Files:**
- Create: `test/helpers/temporary-arena.mjs`
- Modify: `test/goal-engine-workspace.test.mjs`
- Modify: `test/goal-engine-extension.test.mjs`
- Modify: `test/goal-engine-runtime.integration.mjs`
- Create: `test/temporary-arena.test.mjs`

**Interfaces:**
- Produces: `createTemporaryArena(t, prefix) -> { root, mkdir(name), track(path), dispose() }`
- `dispose()` 幂等，按 child-before-parent 顺序删除，仅允许 canonical OS tmpdir 后代。

- [ ] **Step 1: 写 teardown RED**

```js
test("temporary arena dispose 幂等释放全部根目录", async (t) => {
  const arena = createTemporaryArena(t, "arena-red-");
  writeFileSync(join(arena.root, "evidence.txt"), "fixture\n");
  await arena.dispose();
  await arena.dispose();
  assert.equal(existsSync(arena.root), false);
});
```

同时为两个 Goal 测试文件增加 suite 前后前缀差集断言；不要以“OS 以后会清理”为期望。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/temporary-arena.test.mjs test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs`
Expected: 业务断言通过，但泄漏断言失败。

- [ ] **Step 3: 接入文件级 `after()` 清理**

所有 `mkdtempSync(join(tmpdir(), "ge-ws-"))`、`ge-ws-state-`、`ge-ext-` 和 integration host/project 目录都通过 arena 创建。测试刻意破坏 worktree metadata 时，teardown 仍只删除该 arena 自有 canonical roots，不调用主仓 prune。

- [ ] **Step 4: 连续运行两轮验证零增长**

Run: `node --test test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs && node --test test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs`
Expected: 两轮全部通过，受管前缀数量回到运行前基线。

- [ ] **Step 5: 提交**

```bash
git add test/helpers/temporary-arena.mjs test/temporary-arena.test.mjs test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
git commit -m "fix(test): 回收 Goal Engine 临时 worktree"
```

---

### Task 6: 阻止 Agent 绕过受控 Worktree 入口

**Deps:** Task 2

**Files:**
- Modify: `scripts/lib/shell-policy.mjs`
- Modify: `test/shell-policy.test.mjs`
- Modify: `skill-overrides/subagent-dispatch/SKILL.md`
- Modify: `skill-overrides/using-goal-engine/SKILL.md`
- Modify: `pi/AGENTS.md`
- Test: `test/subagent-dispatch-skill.test.mjs`
- Test: `test/using-goal-engine-skill.test.mjs`

**Interfaces:**
- Shell policy 继续允许 `git worktree list --porcelain` 等只读命令。
- Agent 发起的 `git worktree add/remove/prune/move/repair/lock/unlock` 返回 `WORKTREE_LIFECYCLE_BYPASS`。
- 允许 `node scripts/worktree-lifecycle.mjs audit|create|adopt|release|preserve`；内部 `execFile` 不经过 bash gate。

- [ ] **Step 1: 写 bypass RED**

覆盖 plain Git、`command git`、`env git`、shell wrapper、换行/管道、`--git-dir`/`--work-tree` 变体；只读 list 继续允许。

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-name-pattern='worktree lifecycle' test/shell-policy.test.mjs`
Expected: raw add/remove 当前未被统一拦截。

- [ ] **Step 3: 实现最小 gate**

只识别 mutating worktree subcommand，不阻断 `list`。错误文案指向 `npm run worktree -- ...` 或 Goal Engine typed tools，不建议 raw cleanup。

- [ ] **Step 4: 更新 Skill 与 AGENTS**

明确：typed subagent、pi-subagents、Root Broker 不创建 worktree；需要隔离时选择 Goal Engine 或 managed lifecycle CLI。任务完成必须提交 disposition；不得把 `/private/tmp` 当成自动回收保证。修改 Skill 时加载 `writing-skills` 并执行其验证流程。

- [ ] **Step 5: 运行 GREEN 并提交**

Run: `node --test test/shell-policy.test.mjs test/subagent-dispatch-skill.test.mjs test/using-goal-engine-skill.test.mjs`
Expected: PASS。

```bash
git add scripts/lib/shell-policy.mjs test/shell-policy.test.mjs skill-overrides/subagent-dispatch/SKILL.md skill-overrides/using-goal-engine/SKILL.md pi/AGENTS.md test/subagent-dispatch-skill.test.mjs test/using-goal-engine-skill.test.mjs
git commit -m "fix(worktree): 阻止 Agent 绕过生命周期管理"
```

---

### Task 7: 一次性历史 Worktree 迁移与回收

**Deps:** Task 1, Task 2, Task 4, Task 6

**Files:**
- Modify: `docs/audits/2026-08-05-worktree-lifecycle-audit.md`
- Create: `docs/summaries/2026-08-05-worktree-reclamation-verification.md`
- Runtime-only: `.state/worktree-lifecycle/migrations/pi-config-20260805.json`（ignored，不提交）

**Interfaces:**
- Consumes: audit JSON 的 exact path/branch/HEAD/status/operation snapshot。
- Produces: 每项 `preserved | released-worktree-only | blocked-dirty | blocked-sequencer | blocked-owner` disposition。
- 不删除任何 branch、archive 或 recovery ref。

- [ ] **Step 1: 再生成快照并与审计清单做 CAS 对比**

Run: `npm run worktree:audit -- --json > /tmp/pi-config-worktrees-before.json`
Expected: 数量和 identity 可解释；任何新增 owner、dirty、HEAD drift、sequencer 或进程 cwd 立即将该项移出回收集合。

- [ ] **Step 2: 由用户批准 77 个普通 clean worktree 的 worktree-only 回收**

批准前不执行。批准后逐项 `adopt` 为 migration owner，再调用 managed `release`；每项必须使用无 `--force` remove，并保留 branch。失败停止该项，记录 cleanup debt，不影响后续独立项。

- [ ] **Step 3: 处理 8 个仅生成 symlink 的 worktree**

只有同时满足“status 唯一条目为 `?? pi/npm`、对象是 symlink、target 精确等于 `/Users/mhbzhy/pi-config/pi/npm`、无 active cwd/sequencer”才可请求单独批准。批准后移除该 symlink，再按 managed clean release；否则归入 dirty blocked。

- [ ] **Step 4: 保留 9 个受保护/脏/sequencer 项**

必须保留：主工作树、`fix/plan-supervisor-bound-wake` worktree、六个实质脏 worktree、未完成 merge candidate。为脏项输出 changed paths 和 branch/HEAD，不执行 stash、commit、abort、reset、restore 或 force removal；后续逐项由人决定 archive/preserve/discard。

- [ ] **Step 5: 单独批准历史测试临时目录清理**

先确认没有活跃测试进程，按 canonical tmpdir、受管前缀和 minimum age 生成清单。默认只处理 `ge-ws-*`/`ge-ext-*`，不跟随 symlink，不跨 filesystem root。应用前再次要求用户批准；清理后重跑两轮 fixture leak 回归。

- [ ] **Step 6: 验证并提交报告**

Run: `git worktree list --porcelain && npm run worktree:audit -- --json > /tmp/pi-config-worktrees-after.json && npm run doctor`
Expected: released 项不再登记；所有保留项 identity 不变；branch/ref 数量未因 worktree 回收减少；TokenRec 不受影响。

```bash
git add docs/audits/2026-08-05-worktree-lifecycle-audit.md docs/summaries/2026-08-05-worktree-reclamation-verification.md
git commit -m "docs(worktree): 记录历史资源回收验证"
```

---

### Task 8: 全量验证与外部复审

**Deps:** Task 3, Task 4, Task 5, Task 6, Task 7

**Files:**
- Modify: `docs/summaries/2026-08-05-worktree-reclamation-verification.md`

**Interfaces:**
- Produces: exact-seven ABI、Goal lifecycle、worktree lifecycle、Doctor、真实 Pi/subagent 和资源基数的最终证据。

- [ ] **Step 1: 运行聚焦回归**

```bash
node --test \
  test/worktree-lifecycle-*.test.mjs \
  test/goal-engine-workspace.test.mjs \
  test/goal-engine-extension.test.mjs \
  test/goal-engine-events.test.mjs \
  test/goal-engine-graph.test.mjs \
  test/shell-policy.test.mjs \
  test/doctor.test.mjs
```

Expected: 全部通过。

- [ ] **Step 2: 运行全仓与真实集成**

```bash
npm test
npm run doctor
PI_REAL_BIN=/opt/homebrew/bin/pi npm run test:integration
PI_REAL_BIN=/opt/homebrew/bin/pi npm run test:subagents
```

Expected: 除非另有 bug-first 归因，不接受新增失败；真实 Pi 与 pi-subagents 均通过。

- [ ] **Step 3: 运行两轮独立复审**

按 `external-llm-review` Skill 审查累计 diff；同一累计 diff 最多两轮。Critical/Important 必须 bug-first、RED→GREEN；provider timeout 不算批准。

- [ ] **Step 4: 最终资源证明**

比较 before/after inventory、temp fixture 基数、branch/ref、archive/recovery refs、当前 `pi/settings.json` 哈希和外部 TokenRec originRoot。确认没有跨仓删除、没有 branch 隐式删除、没有 Goal typed ABI 扩张。

- [ ] **Step 5: 提交最终报告**

```bash
git add docs/summaries/2026-08-05-worktree-reclamation-verification.md
git commit -m "docs(worktree): 完成生命周期回收验收"
```

---

## 自审结果

- 需求覆盖：当前 94 个 worktree 分类、所有现行创建者、正常回收、crash recovery、dirty/preserve/sequencer 安全边界、测试 fixture 泄漏和一次性历史清理均有对应 Task。
- 占位扫描：计划不存在未完成占位标记；一次性 destructive action 明确依赖用户批准，不是实现缺口。
- 类型一致性：Task 2 定义的 manifest state、owner token 和 create/release 接口被 Task 3、4、7 原样使用；Goal Engine exact-seven 保持不变。
