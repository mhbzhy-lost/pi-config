# Goal Engine Workspace 与 Git 安全修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 rename 越权、错误目标分支集成和误中止用户 Git 操作三类 P0/P1 安全缺口。

**Architecture:** Workspace 检查改用 Git 的 NUL 分隔 name-status plumbing，同时把 rename/copy 的源、目标两侧都纳入授权集合。Git 集成在任何副作用前绑定 immutable origin ref、HEAD 和 sequencer 身份；Extension 将 origin ref 写入 disposition started 事件，恢复只能回到同一 ref，且不得清理不属于本次 Goal 操作的用户 sequencer。

**Tech Stack:** Node.js ESM、同步 `git` plumbing、`node:test`、Goal Engine v2 event projection、Git linked worktree。

## Global Constraints

- 实现基线固定为干净分支 `agent/goal-engine-hardening` 的累计提交 `f264253bf15499197698a253ced9e1f5eb3af1b6`；禁止在脏 `main` 上开发或合并。
- 每个 Task 使用独立 worktree；累计 coordinator 只接收通过 RED→GREEN、diff 审查和目标测试的提交。
- 每个 bug 必须先创建中文 `docs/bugs/bug-*.md`，包含现象、影响、稳定复现、根因、本次处置、防复发六部分，再写失败测试。
- 所有实现严格执行 TDD；RED 必须因本 Task 描述的缺口失败，不能因 fixture、Git 用户配置或路径错误失败。
- Git 命令使用参数数组，不拼接 shell；机器判断使用 `symbolic-ref`、`rev-parse`、`diff --name-status -z` 等 plumbing，不解析面向人的装饰输出。
- v1/v2 历史事件仍须可重放；新增字段对历史 started 事件按显式 legacy 分支处理，不静默猜测目标 ref。
- 不处理多进程 event store、amendment、accept completion、evidence 语义或跨仓 Executor；这些属于配套计划 `2026-08-04-goal-engine-event-recovery-safety.md` 和既有 Plan Runner convergence 计划。

---

### Task 1: rename/copy 两侧 writePaths 授权

**Files:**
- Create: `docs/bugs/bug-goal-engine-writepaths-rename-source-bypass.md`
- Modify: `scripts/lib/goal-engine/workspace.mjs`
- Test: `test/goal-engine-workspace.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Consumes: `inspectExecutorWorkspace(lease)`、`assertWorkspaceChangesWithinPaths(inspection, writePaths)`。
- Produces: `inspectExecutorWorkspace(lease).changedFiles: string[]`；数组包含 add/modify/delete 的路径，以及 rename/copy 的源路径和目标路径，去重后按字典序排列。

- [ ] **Step 1: 先记录根因文档**

创建 `docs/bugs/bug-goal-engine-writepaths-rename-source-bypass.md`，精确记录：

```markdown
# Goal Engine rename 可绕过 writePaths 源路径授权

## 现象
`forbidden/secret.txt -> allowed/secret.txt` 后 changedFiles 只有目标路径，`allowed/**` 被错误放行。

## 影响
Executor 可读取并搬运未授权路径中的内容，把越权来源包装成允许路径后集成。

## 稳定复现
在 base 提交 forbidden/secret.txt；Executor worktree 执行 git mv 到 allowed/secret.txt 并提交；检查仅允许 allowed/**。

## 根因
`git diff --name-only` 对 rename 只提供一个展示路径，丢失 name-status 中的源路径身份。

## 本次处置
使用 `git diff --name-status -z --find-renames --find-copies`，rename/copy 同时返回源和目标路径。

## 防复发
单元测试和 Extension 端到端测试均要求两侧授权；普通 add/modify/delete 行为保持不变。
```

- [ ] **Step 2: 写 Workspace RED**

在 `test/goal-engine-workspace.test.mjs` 增加真实 Git rename 测试；期望值不得由被测 parser 生成：

```js
test("writePaths requires both sides of rename and copy to be owned", () => {
  const origin = initRepo();
  mkdirSync(join(origin, "forbidden"), { recursive: true });
  writeFileSync(join(origin, "forbidden/secret.txt"), "secret\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "test: add rename source");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "rename-gate", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });

  mkdirSync(join(lease.path, "allowed"), { recursive: true });
  git(lease.path, "mv", "forbidden/secret.txt", "allowed/secret.txt");
  git(lease.path, "commit", "-m", "test: move secret");

  const inspection = inspectExecutorWorkspace(lease);
  assert.deepEqual(inspection.changedFiles, ["allowed/secret.txt", "forbidden/secret.txt"]);
  assert.throws(() => workspace.assertWorkspaceChangesWithinPaths(inspection, ["allowed/**"]), /forbidden\/secret\.txt/);
  assert.doesNotThrow(() => workspace.assertWorkspaceChangesWithinPaths(inspection, ["allowed/**", "forbidden/**"]));
});
```

另加 copy 用例：从 `forbidden/source.txt` 复制到 `allowed/copy.txt`，以足够高相似度内容触发 `--find-copies`，断言两侧都在 `changedFiles`。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test --test-name-pattern='rename|copy' test/goal-engine-workspace.test.mjs
```

Expected: rename 用例失败，实际 `changedFiles` 缺少 `forbidden/secret.txt`；不能接受 parser error 或 Git fixture error。

- [ ] **Step 4: 实现 NUL-safe name-status parser**

在 `workspace.mjs` 增加私有函数：

```js
function parseChangedPaths(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      if (index + 1 >= tokens.length) throw new Error("Invalid git rename/copy status output");
      paths.push(tokens[index++], tokens[index++]);
    } else {
      if (index >= tokens.length) throw new Error("Invalid git name-status output");
      paths.push(tokens[index++]);
    }
  }
  return [...new Set(paths)].sort();
}
```

将 changed path 命令改为：

```js
const changedOutput = headCommit === lease.baseCommit
  ? ""
  : gitRaw(lease.path, "diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", `${lease.baseCommit}..${headCommit}`);
const changedFiles = changedOutput ? parseChangedPaths(changedOutput) : [];
```

`gitRaw` 必须保留 NUL，不能调用会改变内容语义的 `.trim()`；现有 `git()` 保持给文本 plumbing 使用。

- [ ] **Step 5: 写 Extension 端到端 RED/GREEN**

在 `test/goal-engine-extension.test.mjs` 按真实 `goal_init → goal_dispatch → git mv/commit → goal_settle → goal_integrate` 流程增加一例：Task 只允许 `allowed/**`，源文件位于 base 的 `forbidden/**`；`goal_integrate` 必须拒绝，origin HEAD、workspace、branch 和 lease 均保持不变。

- [ ] **Step 6: 运行 GREEN 与回归**

Run:

```bash
node --test test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs
```

Expected: 全部 PASS；现有普通 add/modify/delete、NUL、absolute path 和 `src/**` 用例不回归。

- [ ] **Step 7: 提交 Task 1**

```bash
git add docs/bugs/bug-goal-engine-writepaths-rename-source-bypass.md scripts/lib/goal-engine/workspace.mjs test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs
git commit -m "fix(goal-engine): 封堵重命名路径越权"
```

---

### Task 2: 绑定 origin ref 并保护用户 Git 操作

**Deps:** Task 1

**Files:**
- Create: `docs/bugs/bug-goal-engine-integrates-wrong-origin-branch.md`
- Create: `docs/bugs/bug-goal-engine-aborts-user-git-operation.md`
- Modify: `scripts/lib/goal-engine/workspace.mjs`
- Modify: `scripts/lib/goal-engine/events.mjs`
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Test: `test/goal-engine-workspace.test.mjs`
- Test: `test/goal-engine-events.test.mjs`
- Test: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `inspection.changedFiles` 和既有三阶段 disposition。
- Produces: lease 字段 `originRef: string`；新 started event 字段 `originRef: string`；`integrateExecutorWorkspace(lease, { strategy, executorHead, originRef, originHeadBefore })` 在副作用前验证目标身份。

- [ ] **Step 1: 记录两个独立根因**

`bug-goal-engine-integrates-wrong-origin-branch.md` 记录：started 后切换 origin branch，同一 patch 被集成到另一个 branch；根因是事件只绑定 commit、不绑定 ref。

`bug-goal-engine-aborts-user-git-operation.md` 记录：origin 已有用户 cherry-pick/merge conflict 时，Goal 的 Git 命令失败后无条件执行 `--abort`，清除了用户 sequencer；根因是没有 preflight，也没有 sequencer ownership。

两份文档都必须包含六部分，并列出已复现 oracle：错误分支两个 HEAD、`CHERRY_PICK_HEAD`/`MERGE_HEAD`、`git status --porcelain` 在调用前后应完全一致。

- [ ] **Step 2: 写错误分支 RED**

在 Workspace 测试中：

```js
test("integration rejects a different checked-out origin ref before side effects", () => {
  const origin = initRepo();
  git(origin, "branch", "other");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "branch-fence", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "feature.ts"), "export const value = 1;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "test: executor result");
  const mainBefore = git(origin, "rev-parse", "main");
  const otherBefore = git(origin, "rev-parse", "other");
  git(origin, "switch", "other");

  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "cherry-pick" }), /origin ref|branch|target/i);
  assert.equal(git(origin, "rev-parse", "main"), mainBefore);
  assert.equal(git(origin, "rev-parse", "other"), otherBefore);
});
```

- [ ] **Step 3: 写用户 sequencer RED**

分别制造真实 cherry-pick conflict 和 merge conflict；调用 `integrateExecutorWorkspace` 前保存：

```js
const before = {
  head: git(origin, "rev-parse", "HEAD"),
  status: git(origin, "status", "--porcelain=v1"),
  cherryPickHead: gitOptional(origin, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"),
  mergeHead: gitOptional(origin, "rev-parse", "-q", "--verify", "MERGE_HEAD"),
};
```

调用必须在 Goal Git 副作用前拒绝，之后四项与 `before` 精确相等。当前实现会清理 conflict，因此 RED。

- [ ] **Step 4: 运行 RED**

```bash
node --test --test-name-pattern='origin ref|user cherry|user merge' test/goal-engine-workspace.test.mjs
```

Expected: 错误分支被改写，或用户 sequencer 被清理，从而断言失败。

- [ ] **Step 5: 在 lease 中绑定 origin ref**

`allocateExecutorWorkspace()` 在任何 worktree 副作用前读取：

```js
const originRef = git(originRoot, "symbolic-ref", "--quiet", "HEAD");
```

本轮合同只支持附着在本地 branch 的 origin；detached HEAD 必须 fail closed。把 `originRef` 写入 lease，`loadExecutorWorkspaceLease()` 将它列入必需身份字段，Extension 的 projection/lease 校验也必须比较它。

- [ ] **Step 6: 将 ref 写入 started event 并单向恢复**

新 `task.workspace_disposition_started` 必须携带 `originRef`。Reducer 为保持历史 v2 replay，把该字段作为兼容可选字段：存在时必须是非空字符串并保存到 workspace，不存在时只保留 legacy 标记。Extension 是新事件的唯一生产入口，必须始终写入该字段；恢复遇到 `phase=disposing` 且无 `originRef` 时必须 fail closed，返回明确的 legacy/manual recovery 错误，不能猜测当前 branch。

Extension 在 active 阶段创建 started event 前要求：

```js
assert.equal(currentOriginRef(cwd), lease.originRef);
```

恢复 disposing/applied 阶段则使用 projection 中的 `workspace.originRef`，不得从当前 HEAD 重新推导目标。

- [ ] **Step 7: 增加 Git preflight 和 owner-aware abort**

在执行 cherry-pick/merge 前验证：

- 当前 symbolic ref 等于 expected `originRef`；
- 首次执行时 HEAD 等于 `originHeadBefore`；
- `git status --porcelain=v1` 为空；
- `CHERRY_PICK_HEAD`、`MERGE_HEAD`、`REVERT_HEAD` 均不存在；
- `.git/rebase-merge`、`.git/rebase-apply` 不存在。

只有本次命令在 preflight clean 后创建了对应 sequencer，catch 才能 abort；命令在 sequencer 创建前失败时不得 abort。恢复已有 Goal sequencer时，只有 marker commit 与 persisted `executorHead` 或其 `${baseCommit}..${executorHead}` commit 集合匹配，且 ref/HEAD 与 started 身份匹配，才允许 Goal 执行 abort/retry；否则保留现场并拒绝。

- [ ] **Step 8: 写 Extension 恢复 RED/GREEN**

注入 started append 后抛错，在第一次调用已完成 Git 集成但 applied 未写入时切换到 `other` branch；重试 `goal_integrate` 必须拒绝，且 other HEAD 不变。切回 persisted `originRef` 后重试必须幂等完成 applied/disposed，不重复 cherry-pick。

再增加历史 started 无 `originRef` 的 replay 测试：`loadProjection` 成功，但 `goal_integrate` 返回 legacy/manual recovery 错误且无 Git 副作用。

- [ ] **Step 9: 运行 GREEN 与完整 Goal Engine 回归**

```bash
node --test \
  test/goal-engine-workspace.test.mjs \
  test/goal-engine-events.test.mjs \
  test/goal-engine-extension.test.mjs \
  test/goal-engine-runtime.integration.mjs
```

Expected: 全部 PASS；失败路径前后 origin HEAD、ref、status、sequencer 精确相等。

- [ ] **Step 10: 提交 Task 2**

```bash
git add docs/bugs/bug-goal-engine-integrates-wrong-origin-branch.md docs/bugs/bug-goal-engine-aborts-user-git-operation.md scripts/lib/goal-engine/workspace.mjs scripts/lib/goal-engine/events.mjs scripts/lib/goal-engine/extension.mjs test/goal-engine-workspace.test.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs
git commit -m "fix(goal-engine): 绑定集成目标并保护用户操作"
```

---

### Task 3: Workspace/Git 独立安全审查

**Deps:** Task 2

**Files:**
- Create: `reports/goal-engine-workspace-git-review.md`

**Interfaces:**
- Consumes: Task 1–2 的累计 diff、RED/GREEN 输出和真实 Git fixture。
- Produces: 中文审查报告，结论只能是 `APPROVED` 或 `CHANGES_REQUIRED`，列出 Critical/Important/Minor findings。

- [ ] **Step 1: 运行静态与定向门禁**

```bash
git diff --check f264253..HEAD
node --test test/goal-engine-workspace.test.mjs test/goal-engine-events.test.mjs test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
```

- [ ] **Step 2: 重跑四个黑盒探针**

必须重新证明：rename source 被拒绝、错误 origin ref 不移动、用户 cherry-pick conflict 不被 abort、用户 merge conflict 不被 abort。报告记录每个探针的调用前/后 HEAD、ref、status 和 sequencer hash。

- [ ] **Step 3: 执行独立 reviewer**

Reviewer 只读取累计 diff和测试输出，重点检查：NUL parser、copy detection、detached HEAD、legacy started、sequencer ownership、恢复幂等性。存在 Critical/Important 时不得提交 APPROVED。

- [ ] **Step 4: 写报告并提交**

```bash
git add reports/goal-engine-workspace-git-review.md
git commit -m "docs(goal-engine): 记录工作区安全审查"
```
