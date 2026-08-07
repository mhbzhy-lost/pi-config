# Goal Engine 全局状态根目录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Goal Engine 新产生的结构化状态存入 `PI_CODING_GOAL_DIR`，并按 Pi 进程 canonical cwd 建立严格隔离的全局命名空间，同时安全恢复仍位于 `cwd/.state/goal-engine` 的既有 Goal。

**Architecture:** `PI_CODING_GOAL_DIR` 是全局物理根目录；`state-scope.mjs` 使用 `realpath(cwd)`、可读路径标签和 SHA-256 摘要生成 cwd 命名空间，并用 `identity.json` 二次校验。Goal Engine 在运行时对每次操作选择状态根：既有 active legacy Goal 继续固定在 legacy root，新 Goal 写入 global root；显式 goal ID 可从两处恢复，两个根同时 active 时 fail closed。

**Tech Stack:** Zsh、Node.js ESM、Pi Extension API、`node:test`、Git worktree。

## Global Constraints

- Goal 状态只由 Pi 进程当前 `ExtensionContext.cwd` 决定，不绑定 session ID。
- 默认配置必须是 `export PI_CODING_GOAL_DIR="${PI_CODING_GOAL_DIR:-$_PI_CONFIG_ROOT/var/goals}"`。
- 不把 Goal 文件混入 `PI_CODING_AGENT_SESSION_DIR`。
- 不手工移动、删除或改写当前 `cwd/.state/goal-engine`；active legacy Goal 原地完成。
- 新 namespace 目录必须同时绑定 canonical cwd 的可读标签、SHA-256 摘要和 `identity.json`。
- `PI_CODING_GOAL_DIR` 缺失时保留 legacy 行为，保证非 wrapper Pi 与历史测试不写入用户全局目录。
- 全局根与 legacy 根同时存在 active Goal 时必须 fail closed，不得猜测权威状态。
- 逻辑和配置改动严格执行 RED → GREEN；禁止先写实现。
- 不删除任何历史 worktree、branch、lease 或 recovery ref。

---

## 文件职责

- `scripts/pi-shell.zsh`：为 wrapper 启动的 Pi 注入 `PI_CODING_GOAL_DIR` 默认值并保留用户 override。
- `scripts/lib/goal-engine/state-scope.mjs`：canonical cwd、namespace、identity 和 global/legacy root 选择的纯边界模块。
- `scripts/lib/goal-engine/extension.mjs`：在 typed tool 与 lifecycle hook 入口选择当前操作的权威 state root。
- `test/pi-shell.test.mjs`：验证环境变量默认值和 override。
- `test/goal-engine-state-scope.test.mjs`：验证 namespace 碰撞防护、identity 和 root 决策。
- `test/goal-engine-extension.test.mjs`：验证 legacy active 恢复、新 Goal cutover、双 active 冲突与 worktree 路径。
- `test/goal-engine-runtime.integration.mjs`：通过真实 Pi Host 验证全局状态不会写入仓库 cwd。
- `docs/summaries/2026-08-08-goal-global-state-root-verification.md`：记录迁移边界、测试证据和当前 active bootstrap 的兼容方式。

## DAG

```text
T1 env-config ─────────────────────────────┐
                                           ├──> T4 runtime-verification
T2 state-scope ──> T3 extension-cutover ──┘
```

依赖边说明：

- `T2 → T3`：T3 只依赖 T2 产出的 `resolveGoalStateScope()`、`selectGoalStateRoot()` 和 identity 契约。
- `T1 → T4`：T4 需要 wrapper 已注入 `PI_CODING_GOAL_DIR`，才能验证真实 Pi 启动路径。
- `T3 → T4`：T4 需要扩展已经消费全局 state root 并实现 legacy cutover。
- T1 与 T2 无依赖，可并行；环境变量配置与 resolver API 可独立 RED/GREEN 和验收。

## 并行调度组（Wave）

- **Wave 1**：T1、T2（可并行）
- **Wave 2**：T3（T2 完成后立即开始，不等待 T1）
- **Wave 3**：T4（T1、T3 完成后开始）

---

### Task 1: Wrapper 环境变量配置

**Deps:** none

**WritePaths:**
- `scripts/pi-shell.zsh`
- `test/pi-shell.test.mjs`

**Files:**
- Modify: `scripts/pi-shell.zsh:1-6`
- Modify: `test/pi-shell.test.mjs`

**Interfaces:**
- Consumes: `_PI_CONFIG_ROOT` 和用户进程可选的 `PI_CODING_GOAL_DIR`。
- Produces: 子 Pi 进程环境变量 `PI_CODING_GOAL_DIR`；默认 `${_PI_CONFIG_ROOT}/var/goals`，用户值原样保留。

- [ ] **Step 1: 写默认值 RED**

在 fake Pi 捕获 JSON 中增加 `goals: process.env.PI_CODING_GOAL_DIR`，断言清空该变量后启动 wrapper 得到仓库内 `var/goals`：

```js
assert.equal(invocation.goals, join(repoRoot, "var", "goals"));
```

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/pi-shell.test.mjs
```

Expected: FAIL，`invocation.goals` 为 `undefined`。

- [ ] **Step 3: 写 override RED**

新增用例以 `PI_CODING_GOAL_DIR=/tmp/custom-pi-goals` 启动 wrapper：

```js
assert.equal(invocation.goals, "/tmp/custom-pi-goals");
```

Expected before implementation: FAIL 或捕获值缺失。

- [ ] **Step 4: 最小 GREEN**

在 session dir 配置后增加：

```zsh
export PI_CODING_GOAL_DIR="${PI_CODING_GOAL_DIR:-$_PI_CONFIG_ROOT/var/goals}"
```

不得从 `PI_CODING_AGENT_SESSION_DIR` 推导，避免把 Goal 混入 session 文件目录。

- [ ] **Step 5: 验证 GREEN**

Run:

```bash
node --test test/pi-shell.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 显式提交**

```bash
git add scripts/pi-shell.zsh test/pi-shell.test.mjs
git commit -m "feat(goal-engine): 配置全局状态目录"
```

---

### Task 2: cwd namespace 与状态根选择契约

**Deps:** none

**WritePaths:**
- `scripts/lib/goal-engine/state-scope.mjs`
- `test/goal-engine-state-scope.test.mjs`

**Files:**
- Create: `scripts/lib/goal-engine/state-scope.mjs`
- Create: `test/goal-engine-state-scope.test.mjs`

**Interfaces:**
- Produces:

```js
canonicalGoalCwd(cwd) -> absoluteRealpath
cwdNamespace(canonicalCwd) -> `--<readable>--_<16 hex>`
resolveGoalStateScope({ cwd, env }) -> {
  cwd, namespace, preferredRoot, legacyRoot, identity
}
selectGoalStateRoot(scope, { operation, goalId, listActive, hasGoal }) -> {
  root, storage: "global" | "legacy"
}
ensureGoalStateIdentity(scope) -> void
```

- `operation` 精确为 `"init" | "read" | "mutate"`。
- `identity` 精确包含 `{ schemaVersion: "goal-engine.cwd-identity.v1", canonicalCwd, namespace }`。

- [ ] **Step 1: 写 namespace RED**

覆盖以下真实行为：

```js
assert.notEqual(cwdNamespace("/a/b-c"), cwdNamespace("/a-b/c"));
assert.match(cwdNamespace("/Users/me/repo"), /^--Users-me-repo--_[a-f0-9]{16}$/);
```

并使用真实临时目录与 symlink 证明 `canonicalGoalCwd()` 返回同一 realpath。

- [ ] **Step 2: 运行 namespace RED**

Run:

```bash
node --test test/goal-engine-state-scope.test.mjs
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现纯 namespace GREEN**

使用 `realpathSync()`、`createHash("sha256")`、`resolve()` 和 `join()`；可读标签沿用 Pi session 的首个分隔符裁剪及 `/\\:` 替换规则，摘要负责消除其碰撞。

- [ ] **Step 4: 写 root 决策 RED**

使用注入的 `listActive(root)` 与 `hasGoal(root, goalId)` 覆盖：

```text
env 未配置                         -> legacy
仅 legacy 有 active               -> legacy
仅 global 有 active               -> global
两处均有 active                   -> throw GOAL_STATE_ROOT_CONFLICT
init 且两处均无 active             -> global
显式 goalId 仅存在 legacy          -> legacy
显式 goalId 两处都存在             -> throw GOAL_STATE_IDENTITY_CONFLICT
```

- [ ] **Step 5: 写 identity RED**

断言首次创建使用 mode `0600`，相同 identity 幂等，不同 canonical cwd 或 namespace 时拒绝且不覆盖原文件。`PI_CODING_GOAL_DIR` 非绝对路径时返回稳定错误。

- [ ] **Step 6: 实现 root/identity GREEN**

`ensureGoalStateIdentity()` 只能创建 namespace 目录及 `identity.json`；使用 exclusive create，遇到 `EEXIST` 后读取并精确比较。不得创建 Goal event、projection 或 workspace。

- [ ] **Step 7: 验证 GREEN**

Run:

```bash
node --test test/goal-engine-state-scope.test.mjs
```

Expected: PASS。

- [ ] **Step 8: 显式提交**

```bash
git add scripts/lib/goal-engine/state-scope.mjs test/goal-engine-state-scope.test.mjs
git commit -m "feat(goal-engine): 按工作目录隔离全局状态"
```

---

### Task 3: Extension 全局 cutover 与 legacy active 固定

**Deps:** T2

**WritePaths:**
- `scripts/lib/goal-engine/extension.mjs`
- `test/goal-engine-extension.test.mjs`

**Files:**
- Modify: `scripts/lib/goal-engine/extension.mjs`
- Modify: `test/goal-engine-extension.test.mjs`

**Interfaces:**
- Consumes: T2 的 `resolveGoalStateScope()`、`selectGoalStateRoot()`、`ensureGoalStateIdentity()`。
- Produces: 每个 typed tool 与 lifecycle hook 根据当前 cwd 和目标 goal 解析 `{ cwd, root }`；workspace 的 `stateRoot` 使用已选择 root，`originRoot` 仍为 Git 仓库 cwd。

- [ ] **Step 1: 写新 Goal global RED**

通过 factory 注入临时 `PI_CODING_GOAL_DIR`，调用 `goal_init` 后断言：

```text
<goal-dir>/<cwd-namespace>/identity.json                 exists
<goal-dir>/<cwd-namespace>/registry.json                 exists
<goal-dir>/<cwd-namespace>/goals/<goal-id>/events.jsonl  exists
<cwd>/.state/goal-engine                                 absent
```

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test --test-name-pattern="global state root|legacy state root|state root conflict" test/goal-engine-extension.test.mjs
```

Expected: FAIL，新 Goal 仍写入 cwd。

- [ ] **Step 3: 写 legacy active 恢复 RED**

在 legacy root 构造 active Goal、保持 global root 为空，调用 `goal_status`、`goal_dispatch`，断言事件和 workspace 继续写 legacy root，global root 不产生该 Goal 的副本。

- [ ] **Step 4: 写冲突 RED**

分别在 global 和 legacy root 构造 active Goal，调用无 goal ID 的 `goal_status`，断言返回稳定 `GOAL_STATE_ROOT_CONFLICT`，两侧字节保持不变。

- [ ] **Step 5: 最小 GREEN**

将当前固定实现：

```js
return { cwd: ctx.cwd, root: join(ctx.cwd, ".state/goal-engine") };
```

替换为 scope 解析。要求：

- `goal_init` 在没有 active legacy/global Goal 时选择 global root并先确认 identity。
- explicit `goal_id` 在两个 root 中精确定位。
- 无 `goal_id` 时按唯一 active Goal 定位。
- legacy root 被选中时保留现有 `.state` tracked/ignored 安全检查。
- global root 被选中时不再要求仓库 `.gitignore` 包含 `.state/goal-engine/`，但 Git HEAD、attached ref 和仓库顶层检查保持不变。
- lifecycle hook 同样通过唯一 active/completed-watching Goal选择 root，不扫描其他 cwd namespace。

- [ ] **Step 6: 写 restart/cutover RED**

覆盖同一 cwd 两次创建 Extension：第一次恢复 legacy active；将该 fixture变为 completed 后，新的 `goal_init` 必须写 global root；显式读取旧 goal ID仍走 legacy。

- [ ] **Step 7: 验证专项 GREEN**

Run:

```bash
node --test --test-name-pattern="global state root|legacy state root|state root conflict|state root cutover" test/goal-engine-extension.test.mjs
```

Expected: PASS。

- [ ] **Step 8: 验证 Extension 回归**

Run:

```bash
node --test test/goal-engine-extension.test.mjs test/goal-engine-events.test.mjs test/goal-engine-workspace.test.mjs
```

Expected: PASS；未配置 `PI_CODING_GOAL_DIR` 的既有测试继续使用 legacy root。

- [ ] **Step 9: 显式提交**

```bash
git add scripts/lib/goal-engine/extension.mjs test/goal-engine-extension.test.mjs
git commit -m "feat(goal-engine): 切换全局状态存储"
```

---

### Task 4: 真实 Pi Host 验收与迁移说明

**Deps:** T1, T3

**WritePaths:**
- `test/goal-engine-runtime.integration.mjs`
- `docs/summaries/2026-08-08-goal-global-state-root-verification.md`

**Files:**
- Modify: `test/goal-engine-runtime.integration.mjs`
- Create: `docs/summaries/2026-08-08-goal-global-state-root-verification.md`

**Interfaces:**
- Consumes: wrapper 环境变量和 Extension 全局 state root 行为。
- Produces: 真实 Host 证据；明确 active legacy 原地完成、新 Goal global cutover、cwd namespace 隔离和回滚边界。

- [ ] **Step 1: 写真实 Host RED**

在两个临时 Git repo 使用同一临时 `PI_CODING_GOAL_DIR` 分别启动测试 Host，断言两者写入不同 namespace；每个 repo 中均不存在 `.state/goal-engine`。在同一 cwd 重启 Host 后必须恢复同一 Goal。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test --test-name-pattern="PI_CODING_GOAL_DIR" test/goal-engine-runtime.integration.mjs
```

Expected: FAIL，真实 Host 尚未写 global root。

- [ ] **Step 3: 补齐最小测试适配并验证 GREEN**

只补测试 Host 的环境注入和观测，不新增另一套路径算法。

Run:

```bash
node --test test/goal-engine-runtime.integration.mjs test/pi-shell.test.mjs test/goal-engine-state-scope.test.mjs
```

Expected: PASS。

- [ ] **Step 4: 完整 Goal Engine 回归**

Run:

```bash
node --test test/goal-engine-*.test.mjs test/goal-engine-runtime.integration.mjs test/pi-shell.test.mjs
```

Expected: PASS，且测试退出后临时 global root 可由 fixture 自身释放，不触碰真实历史 worktree。

- [ ] **Step 5: 编写中文验证说明**

文档必须记录：

- 环境变量最终表达式及实际解析路径。
- namespace/identity 示例和碰撞防护。
- active legacy Goal 不搬迁、不复制，完成后新 Goal 才切 global。
- global/legacy 双 active 冲突的 fail-closed 行为。
- 测试命令、通过数量和失败时回滚边界。
- 多 Git 仓库后续仅共享这个全局控制面根，不在外部仓库创建 Goal state。

- [ ] **Step 6: diff 检查并显式提交**

```bash
git diff --check -- test/goal-engine-runtime.integration.mjs docs/summaries/2026-08-08-goal-global-state-root-verification.md
git add test/goal-engine-runtime.integration.mjs docs/summaries/2026-08-08-goal-global-state-root-verification.md
git commit -m "test(goal-engine): 验证全局状态目录"
```

---

## 自检结果

- **需求覆盖**：环境变量、全局 root、cwd 严格命名、identity、防碰撞、legacy active 恢复、新 Goal cutover、真实 Host 均有对应任务。
- **范围控制**：不修改 Root Broker、Goal event schema、task schema、action token 或 session storage。
- **占位符检查**：计划不含 TBD/TODO/“稍后实现”等占位步骤。
- **接口一致性**：T3、T4 使用的 resolver 名称与 T2 产出一致。
- **bootstrap 边界**：当前 `planned-goal` 继续从 legacy root 完成；候选代码 reload 后不得复制或移动它。
