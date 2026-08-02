# Plan Runner 生产收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 每个逻辑变更先加载 `test-driven-development`；需要提交时加载 `git-commit-convention`。本计划可由普通 Subagent-Driven 或 Inline Execution 执行，但禁止使用 Plan Runner 或 Goal Engine 作为执行机制。

**Goal:** 修通真实生产 profile 的 Plan Runner/Executor 跨仓启动链，建立可复现运行时，并在新冻结 HEAD 上完成一次不可重跑的真实 Harness 验收。

**Architecture:** 配置仓拥有的 child Extension 不再以业务仓 cwd-relative 路径直接加载；启动方先在目标 worktree 的 `.pi-subagents/` 私有命名空间原子生成薄入口，入口通过可信绝对 `file:` URL 导入配置仓模块。Plan Launcher 负责 Plan Runner 入口，typed coding dispatch 负责 Executor owner 入口；真实 Harness 改为验证这条生产装配链。运行时依赖由受版本控制的 npm lock 重建，最终证据绑定冻结 HEAD、精确 Node/Pi/package 版本和 runtime tree hash。

**Tech Stack:** Node.js 26.5.0、Pi 0.83.0、TypeScript/ESM、`pi-subagents@0.37.2`、`typebox@1.1.38`、Node test runner、Git worktree、npm lockfile。

## Global Constraints

- 不得调用 `plan_run`、`plan_attention_reply` 或任何 `goal_*` 工具执行本计划；真实 Harness 内部对 Plan tools 的调用仅属于被测行为。
- `f7615444e7a86956c3b9647389c32678c6ee9ba3` 已经运行过 Harness，永不重跑；当前受保护输入已变化，旧证据不得复用。
- 现有 dirty worktree 必须原样保护。Task 1–3 可在独立 worktree 执行；开始 Task 4 前，Basic Memory 修复与 Todo 退役必须由其各自 owner 独立提交或明确处置，不得把它们混入 Plan Runner commit。
- 不得修改 `pi/npm/node_modules/**` 源码，不得复制 broker 源码到业务仓，不得创建 symlink，不得移除 Root ownership guard。
- `.pi-subagents/` 入口必须是普通文件，目录/文件不得经过 symlink；目录权限 `0700`，入口权限 `0600`。
- 生产入口只允许导入配置仓内的 `pi/child-extensions/plan-runner.ts` 或 `pi/child-extensions/root-session-owner.ts`，入口冲突时 fail closed，不覆盖未知内容。
- 所有逻辑任务严格执行 RED → GREEN → REFACTOR；本计划引用的既有 bug 文档为：`docs/bugs/bug-plan-runner-missing-runtime-wrapper.md`、`docs/bugs/bug-executor-owner-extension-cwd-breaks-cross-repo-dispatch.md`。
- Node 固定为 `v26.5.0`；Pi 固定为 `0.83.0`；`pi-subagents` 固定为 `0.37.2`；TypeBox 固定为 `1.1.38`。
- 新真实 Harness 只能在新冻结 HEAD、累计门禁全绿、独立复审 `0 Critical / 0 Important` 后运行一次；GREEN 或 RED 后都不得在同一 HEAD 重跑。
- 不考虑不存在的 `crash-analyzer-usage`；Doctor 读取当前真实 allowlist，不伪造 Skill，不注入隔离配置目录。

---

### Task 1: 安全生成跨仓 child runtime 入口

**Files:**
- Create: `scripts/lib/subagent-dispatch/child-runtime-entry.ts`
- Create: `test/child-runtime-entry.test.mjs`

**Interfaces:**
- Produces: `materializeChildRuntimeEntry({ cwd, fileName, targetUrl }): Promise<ChildRuntimeEntryReceipt>`
- Produces: `removeChildRuntimeEntry(receipt): Promise<void>`
- `ChildRuntimeEntryReceipt` 精确包含 `{ cwd, directoryPath, entryPath, targetUrl, sourceSha256, created }`。

- [ ] **Step 1: 写幂等生成与权限 RED**

```js
const receipt = await materializeChildRuntimeEntry({
  cwd: businessRepo,
  fileName: "plan-runner-entry.mjs",
  targetUrl: pathToFileURL(trustedTarget),
});
assert.equal((await stat(receipt.directoryPath)).mode & 0o777, 0o700);
assert.equal((await stat(receipt.entryPath)).mode & 0o777, 0o600);
assert.equal(await readFile(receipt.entryPath, "utf8"),
  `export { default } from ${JSON.stringify(pathToFileURL(trustedTarget).href)};\n`);
assert.equal((await materializeChildRuntimeEntry({
  cwd: businessRepo,
  fileName: "plan-runner-entry.mjs",
  targetUrl: pathToFileURL(trustedTarget),
})).created, false);
```

- [ ] **Step 2: 运行 RED 并确认失败原因**

Run:

```bash
node --test test/child-runtime-entry.test.mjs
```

Expected: FAIL，模块或 `materializeChildRuntimeEntry` 尚不存在；不得因 fixture 路径错误失败。

- [ ] **Step 3: 写 symlink、冲突内容和清理边界 RED**

```js
await symlink(outside, join(businessRepo, ".pi-subagents"));
await assert.rejects(
  materializeChildRuntimeEntry({ cwd: businessRepo, fileName: "executor-owner-entry.mjs", targetUrl }),
  /symlink|runtime namespace/i,
);

await writeFile(entryPath, "export default function malicious() {}\n", { mode: 0o600 });
await assert.rejects(
  materializeChildRuntimeEntry({ cwd: businessRepo, fileName: "executor-owner-entry.mjs", targetUrl }),
  /conflict/i,
);

await removeChildRuntimeEntry(receipt);
await assert.rejects(access(receipt.entryPath));
assert.equal(await readFile(join(receipt.directoryPath, "foreign.log"), "utf8"), "keep\n");
```

Expected: 当前实现不存在，测试保持 RED。

- [ ] **Step 4: 实现最小安全入口生成器**

实现必须采用以下入口字节，不生成 symlink：

```ts
const source = `export { default } from ${JSON.stringify(targetUrl.href)};\n`;
```

核心校验顺序：

```ts
const resolvedCwd = await realpath(cwd);
if (!ENTRY_NAME.test(fileName)) throw new Error("Invalid child runtime entry name");
if (targetUrl.protocol !== "file:") throw new Error("Child runtime target must be a file URL");
const target = await realpath(fileURLToPath(targetUrl));
if (!(await stat(target)).isFile()) throw new Error("Child runtime target must be a regular file");
```

实现要求：

1. `lstat(.pi-subagents)` 拒绝 symlink 和非目录。
2. 新目录使用 `mkdir(..., { mode: 0o700 })` 并 `chmod(0o700)`。
3. 临时文件使用 `flag: "wx"`、`0600`；通过原子 hard-link 或等价 no-clobber 操作发布。
4. 目标已存在时只接受普通文件、字节完全一致和 `0600`，返回 `created:false`。
5. `removeChildRuntimeEntry()` 只删除 receipt 对应且 hash 未变化的入口；目录非空时保留其他 runtime artifact。

- [ ] **Step 5: 运行 GREEN 与回归**

Run:

```bash
node --test test/child-runtime-entry.test.mjs
node --test test/subagent-dispatch-extension.test.ts test/plan-launcher-extension.test.mjs
```

Expected: 全部 PASS，无 warning、cancelled 或 skipped failure。

- [ ] **Step 6: 提交 Task 1**

```bash
git add scripts/lib/subagent-dispatch/child-runtime-entry.ts test/child-runtime-entry.test.mjs
git commit -m "fix(runtime): 增加可信子进程入口生成器"
```

---

### Task 2: 让 Launcher 生成真实 Plan Runner 入口

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`
- Modify: `docs/bugs/bug-plan-runner-missing-runtime-wrapper.md`

**Interfaces:**
- Consumes: `materializeChildRuntimeEntry()`、`removeChildRuntimeEntry()`。
- Produces: `launchPlan()` 在调用 `broker.upstream.spawn()` 前保证 `${worktree}/.pi-subagents/plan-runner-entry.mjs` 已存在且指向可信配置入口。
- 新增可注入测试边界：`options.materializePlanRunnerEntry` 与 `options.removePlanRunnerEntry`。

- [ ] **Step 1: 写 spawn 前入口存在的 RED**

```js
const worktree = join(root, "var", "plan-worktrees", "plan-one");
const runtimeEntry = join(worktree, ".pi-subagents", "plan-runner-entry.mjs");
const rootBroker = broker(calls);
rootBroker.upstream.spawn = async (input) => {
  assert.equal(input.cwd, worktree);
  assert.match(await readFile(runtimeEntry, "utf8"),
    /pi\/child-extensions\/plan-runner\.ts/);
  return { details: { runId: "runner-1", asyncDir: "/async/runner-1" } };
};
```

测试必须创建真实临时 worktree 目录；当前 Launcher 直接 spawn，预期以 `ENOENT` 失败。

- [ ] **Step 2: 运行 RED**

```bash
node --test --test-name-pattern='materializes.*Plan Runner entry' test/plan-launcher-extension.test.mjs
```

Expected: FAIL，`plan-runner-entry.mjs` 不存在。

- [ ] **Step 3: 实现 spawn 前 materialize 与失败补偿**

在 workspace 创建后、spawn 前执行：

```js
entryReceipt = await materializePlanRunnerEntry({
  cwd: worktree,
  fileName: "plan-runner-entry.mjs",
  targetUrl: new URL("../../../pi/child-extensions/plan-runner.ts", import.meta.url),
});
```

失败路径顺序固定为：

```text
stop 已绑定 Runner → 删除仍由 receipt 拥有的入口 → rollback worktree
```

若 stop、入口清理或 rollback 任一失败，抛出包含全部原因的 `AggregateError`，不得掩盖首个 launch error。

- [ ] **Step 4: 写补偿和冲突 RED/GREEN**

覆盖：

1. 入口冲突时不调用 spawn。
2. spawn reply 缺字段时先 stop，再清入口，再 rollback。
3. grant 失败时同样补偿。
4. 清理发现入口已被改写时保留现场并报告，不删除未知内容。

Run:

```bash
node --test test/plan-launcher-extension.test.mjs
```

Expected: 全部 PASS，既有调用顺序断言同步包含入口生命周期。

- [ ] **Step 5: 更新 bug 文档事实**

把 `docs/bugs/bug-plan-runner-missing-runtime-wrapper.md` 中“Launcher 已生成 wrapper”的旧描述改为：旧实现只注册 `plan_run`，本 Task 才补齐真实入口生成、冲突门禁和补偿证据。不得修改历史复现事实。

- [ ] **Step 6: 提交 Task 2**

```bash
git add scripts/lib/plan/plan-launcher-extension.mjs test/plan-launcher-extension.test.mjs docs/bugs/bug-plan-runner-missing-runtime-wrapper.md
git commit -m "fix(plan): 生成可信 Runner 启动入口"
```

---

### Task 3: 让 typed Executor 跨业务仓加载 owner guard

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/subagent-dispatch/extension.ts`
- Modify: `pi/child-extensions/root-owned-subagent.ts`
- Modify: `pi/extensions/subagent-runtime.ts`
- Modify: `pi/agents/executor.md`
- Modify: `test/subagent-dispatch-extension.test.ts`
- Modify: `test/migration-contract.test.mjs`
- Modify: `test/subagent-supervisor-adapter.test.mjs`

**Interfaces:**
- Consumes: `materializeChildRuntimeEntry()`。
- Produces: `prepareCodingSpawn(ir): Promise<void>` 注入点；生产 Root runtime 与 Plan Runner root-owned adapter 都传入真实 materializer。
- Executor profile 固定使用 `.pi-subagents/root-session-owner-entry.mjs`。

- [ ] **Step 1: 写 typed dispatch 顺序 RED**

```js
const order = [];
createTypedSubagentExtension(pi, {
  rpc: {
    async ping() { order.push("ping"); return validPing; },
    async spawn() { order.push("spawn"); return validBinding; },
  },
  async prepareCodingSpawn(ir) {
    order.push(`prepare:${ir.agent}:${ir.execution.cwd}`);
  },
});
await tool.execute("call-1", executorContract, undefined, undefined, { cwd: origin });
assert.deepEqual(order, ["ping", `prepare:executor:${businessRepo}`, "spawn"]);
```

同时断言 prepare 失败时 `spawn` 调用数为 0；generic agent 和 control action 不调用 prepare。

- [ ] **Step 2: 运行 RED**

```bash
node --test test/subagent-dispatch-extension.test.ts
```

Expected: FAIL，`prepareCodingSpawn` 尚未被调用。

- [ ] **Step 3: 接入最小 prepare 边界**

修改 `executeCoding()`：通过 `rpc.ping()` 后、解析 durable spawn identity 和 `rpc.spawn()` 前执行：

```ts
await prepareCodingSpawn(ir);
```

`createTypedSubagentExtension()` 默认 prepare 为 async no-op，避免测试 double 写真实 `/repo`；两个生产安装点显式传入：

```ts
async function prepareExecutorSpawn(ir) {
  if (ir.agent !== "executor") return;
  await materializeChildRuntimeEntry({
    cwd: ir.execution.cwd,
    fileName: "root-session-owner-entry.mjs",
    targetUrl: new URL("../../../pi/child-extensions/root-session-owner.ts", import.meta.url),
  });
}
```

`root-owned-subagent.ts` 使用从自身模块解析的可信 owner URL，不能从业务输入接收 target URL。

- [ ] **Step 4: 修改 production profile 与契约测试**

`pi/agents/executor.md` 精确改为：

```yaml
subagentOnlyExtensions: .pi-subagents/root-session-owner-entry.mjs
```

`test/migration-contract.test.mjs` 不再对业务仓相对路径执行 `access(join(repoRoot, value))`，改为断言 profile 值与 materializer 固定文件名一致。Doctor 继续禁止 `extensions:`，不放宽 tool ceiling。

- [ ] **Step 5: 运行 GREEN**

```bash
node --test \
  test/subagent-dispatch-extension.test.ts \
  test/subagent-supervisor-adapter.test.mjs \
  test/migration-contract.test.mjs \
  test/subagent-runtime-membrane.test.mjs
```

Expected: 全部 PASS；Executor 不加载 `fanout-child`，不获得 `subagent`。

- [ ] **Step 6: 提交 Task 3**

```bash
git add scripts/lib/subagent-dispatch/extension.ts pi/child-extensions/root-owned-subagent.ts pi/extensions/subagent-runtime.ts pi/agents/executor.md test/subagent-dispatch-extension.test.ts test/migration-contract.test.mjs test/subagent-supervisor-adapter.test.mjs
git commit -m "fix(subagent): 修通跨仓 Executor 所有权入口"
```

---

### Task 4: 用 lockfile 重建可复现 Plan runtime

**Files:**
- Create: `.node-version`
- Create: `pi/runtime-deps/package.json`
- Create: `pi/runtime-deps/package-lock.json`
- Modify: `scripts/setup-plan-runtime-deps.mjs`
- Modify: `init-pi.sh`
- Modify: `scripts/doctor.mjs`
- Modify: `test/init-pi.test.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`
- Create: `test/plan-runtime-lock.test.mjs`

**Interfaces:**
- Produces: 受版本控制的 npm dependency graph，顶层只含 `pi-subagents@0.37.2` 与 `typebox@1.1.38`。
- Produces: `installPlanRuntimeDependencies({ piNpmDir, manifestDir, env, run, copy })` 使用 `npm ci` 从 tracked lock 重建 `pi/npm`，自然清除已退役 Todo 包；`copy` 默认是 `node:fs/promises.copyFile`。
- Produces: Doctor 校验 Node `v26.5.0`、tracked lock 与 installed lock 一致。

- [ ] **Step 1: 先收敛当前 dirty 依赖迁移**

执行前置检查：

```bash
git status --short -- \
  scripts/setup-plan-runtime-deps.mjs init-pi.sh \
  test/init-pi.test.mjs test/pi-subagents-compat.test.mjs \
  pi/settings.json
```

Expected: Todo 退役变更已经独立提交并可在当前分支追溯；若仍 dirty，停止本 Task，不覆盖现场。

- [ ] **Step 2: 写 lock 驱动安装 RED**

```js
assert.deepEqual(buildPlanRuntimeInstallCommand("/repo/pi/npm", "/repo/pi/runtime-deps"), {
  command: "npm",
  args: ["ci", "--prefix", "/repo/pi/npm", "--omit=dev", "--ignore-scripts"],
});
assert.deepEqual(calls.map(([command, args]) => [command, args]), [
  ["copyFile", ["/repo/pi/runtime-deps/package.json", "/repo/pi/npm/package.json"]],
  ["copyFile", ["/repo/pi/runtime-deps/package-lock.json", "/repo/pi/npm/package-lock.json"]],
  ["npm", ["ci", "--prefix", "/repo/pi/npm", "--omit=dev", "--ignore-scripts"]],
]);
```

测试还要断言 tracked lock 中不存在 `@juicesharp/rpiv-todo`。

- [ ] **Step 3: 运行 RED**

```bash
node --test test/plan-runtime-lock.test.mjs test/pi-subagents-compat.test.mjs
```

Expected: FAIL，当前实现仍执行 uninstall/install，且 tracked lock 不存在。

- [ ] **Step 4: 生成并提交可信 lock**

`pi/runtime-deps/package.json` 精确内容：

```json
{
  "name": "pi-plan-runtime-deps",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "pi-subagents": "0.37.2",
    "typebox": "1.1.38"
  }
}
```

用官方 registry 生成 lock：

```bash
NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
  npm install --package-lock-only --ignore-scripts \
  --prefix pi/runtime-deps
```

审查 `package-lock.json` 的顶层依赖、resolved registry 和 integrity；不得把当前 `pi/npm/node_modules` 自 hash 当作 lock 来源。

- [ ] **Step 5: 实现 `npm ci` 安装与精确 Node 门禁**

`init-pi.sh` 增加：

```bash
NODE_VERSION="26.5.0"
if [[ "$(node --version)" != "v$NODE_VERSION" ]]; then
  printf 'Node.js %s is required; found %s\n' "$NODE_VERSION" "$(node --version)" >&2
  exit 1
fi
```

`installPlanRuntimeDependencies()` 先原子复制 tracked package/lock，再调用 `npm ci`。Doctor 比较 tracked lock 和 `pi/npm/package-lock.json` 的 SHA-256，并继续校验精确 package 版本。

- [ ] **Step 6: 运行 GREEN 和真实重建**

```bash
node --test \
  test/plan-runtime-lock.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/init-pi.test.mjs \
  test/doctor.test.mjs
NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm run setup:plan-runtime
npm run doctor
node -p "require('./pi/npm/node_modules/pi-subagents/package.json').version"
node -p "require('./pi/npm/node_modules/typebox/package.json').version"
```

Expected: 测试全绿，版本分别为 `0.37.2` 和 `1.1.38`，Todo 包不存在。

- [ ] **Step 7: 提交 Task 4**

```bash
git add .node-version pi/runtime-deps/package.json pi/runtime-deps/package-lock.json scripts/setup-plan-runtime-deps.mjs init-pi.sh scripts/doctor.mjs test/init-pi.test.mjs test/doctor.test.mjs test/pi-subagents-compat.test.mjs test/plan-runtime-lock.test.mjs
git commit -m "build(runtime): 锁定 Plan 执行依赖图"
```

---

### Task 5: 把真实 Harness 切到生产入口装配

**Deps:** Task 2, Task 3, Task 4

**Files:**
- Create: `test/subagent-cross-repo-owner.integration.mjs`
- Modify: `test/plan-flat-runtime-harness.integration.mjs`
- Modify: `test/plan-amendment-harness.integration.mjs`
- Modify: `test/package-scripts.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `test:subagents` 覆盖真实外部业务仓 typed Executor owner wrapper。
- Produces: 两个 Plan Harness 不再把 `root-session-owner.ts` 或 `plan-runner.ts` 的绝对路径直接写入 agent profile。

- [ ] **Step 1: 写外部业务仓 Executor RED**

fixture 必须创建一个不含以下路径的临时 Git 仓：

```text
pi/child-extensions/
scripts/lib/subagent-dispatch/
```

从该 cwd 启动真实 Root Pi，使用 deterministic provider 调用 typed `subagent` 的完整 `dispatch-ir.v1`。断言：

```js
assert.equal(await exists(join(repo, ".pi-subagents", "root-session-owner-entry.mjs")), true);
assert.equal(childStarted, true);
assert.equal(ownerSubscribed, true);
assert.equal(childTools.includes("subagent"), false);
assert.equal(childArgv.includes("fanout-child.ts"), false);
assert.equal(childTerminal.state, "observed");
```

还要覆盖 delayed grant、`root.closing`、socket EOF、正常 shutdown 幂等 dispose。

- [ ] **Step 2: 运行外部业务仓 RED**

```bash
PI_REAL_BIN="$(command -v pi)" \
  node --test test/subagent-cross-repo-owner.integration.mjs
```

Expected: 修复前因 cwd-relative owner extension 缺失而 FAIL；Task 3 后应进入 GREEN。

- [ ] **Step 3: 修改 Plan Harness profile**

Plan Runner fixture profile 的 child-only extensions 使用：

```js
subagentOnlyExtensions: `${provider},.pi-subagents/plan-runner-entry.mjs`
```

Executor fixture profile使用：

```js
subagentOnlyExtensions: `${provider},${executorExtension},.pi-subagents/root-session-owner-entry.mjs`
```

禁止继续注入 `rootOwner` 或 production `plan-runner.ts` 的绝对路径。Harness 在 spawn 后读取两个薄入口，断言其目标是配置仓真实模块、文件为普通文件且权限正确。

- [ ] **Step 4: 更新 package scripts**

`test:subagents` 精确包含普通 compatibility lane 与新 cross-repo owner lane；`test:plan-harness` 仍只包含两个 one-shot Plan Harness，避免把日常兼容测试混入一次性证据身份。

- [ ] **Step 5: 运行非 one-shot GREEN**

```bash
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
node --test \
  test/plan-launcher-extension.test.mjs \
  test/subagent-dispatch-extension.test.ts \
  test/migration-contract.test.mjs \
  test/package-scripts.test.mjs
```

Expected: 全部 PASS。此步骤禁止运行 `npm run test:plan-harness`。

- [ ] **Step 6: 提交 Task 5**

```bash
git add test/subagent-cross-repo-owner.integration.mjs test/plan-flat-runtime-harness.integration.mjs test/plan-amendment-harness.integration.mjs test/package-scripts.test.mjs package.json
git commit -m "test(plan): 覆盖生产跨仓启动装配"
```

---

### Task 6: 累计门禁、独立复审与新冻结 HEAD

**Deps:** Task 5

**Files:**
- Create: `docs/summaries/2026-08-02-plan-runner-production-candidate.md`
- Modify: `docs/summaries/2026-08-02-plan-runner-acceptance-handoff.md`

**Interfaces:**
- Produces: 新冻结 HEAD、受保护输入清单、精确环境指纹、累计门禁结果和独立复审 verdict。
- 后续 Task 7 只消费该冻结 HEAD，不再修改代码或 Harness oracle。

- [ ] **Step 1: 确认冻结输入干净**

```bash
set -euo pipefail
git diff --cached --quiet
for path in \
  package.json scripts/setup-plan-runtime-deps.mjs scripts/lib/plan scripts/lib/subagent-dispatch \
  scripts/probes/pi-subagents-compat.mjs pi/extensions/subagent-runtime.ts pi/extensions/plan-launcher.ts \
  pi/child-extensions test/fixtures/deterministic-provider.mjs test/fixtures/deterministic-provider-state.mjs \
  test/fixtures/plan-harness test/support/flat-plan-attention-driver.mjs \
  test/support/flat-plan-run-quiescence.mjs test/support/plan-e2e-process-cleanup.mjs \
  test/plan-flat-runtime-harness.integration.mjs test/plan-amendment-harness.integration.mjs; do
  git diff --quiet HEAD -- "$path"
done
```

Expected: 所有受保护输入与 HEAD 一致；无关 unstaged/untracked 用户文件允许保留。

- [ ] **Step 2: 串行运行累计门禁**

```bash
node --test test/root-subagent-broker.test.mjs

find test -type f -name '*.test.mjs' \
  ! -name 'root-subagent-broker.test.mjs' \
  ! -name 'doctor.test.mjs' \
  ! -name 'skill-whitelist-extension.test.mjs' \
  -print | sort | xargs -n 40 node --test

PI_REAL_BIN="$(command -v pi)" \
  node --test test/subagent-runtime-root-broker-startup.integration.mjs

PI_REAL_BIN="$(command -v pi)" npm run test:subagents

node --test \
  test/migration-contract.test.mjs \
  test/package-scripts.test.mjs \
  test/plan-runtime-migration.test.mjs

npm run doctor
node --test test/doctor.test.mjs test/skill-whitelist-extension.test.mjs
```

Expected: 全部 exit `0`，无 failed、cancelled 或 skipped failure；测试总数允许因新增覆盖增加。固定 socket suite 不与其他命令并行。

- [ ] **Step 3: 执行独立代码与安全复审**

加载 `external-llm-review`，复审范围为 `f761544..HEAD` 中 Plan runtime 受保护输入和本计划新增代码。审查必须明确回答：

1. wrapper 是否保持配置仓模块身份并拒绝 symlink/冲突。
2. Executor grant、Root EOF、normal shutdown 是否保持 fail closed。
3. Plan Harness 是否真正经过 production profile 路径。
4. lockfile 是否足以从可信 registry 重建 runtime。
5. Todo 测试删除是否由明确退役合同替代，而非静默减覆盖。

Expected: `0 Critical / 0 Important`；任何有效 finding 先写新的六要素 bug 文档并重新走 TDD，不得进入 Task 7。

- [ ] **Step 4: 记录冻结候选**

```bash
frozen="$(git rev-parse HEAD)"
node_version="$(node --version)"
pi_version="$(pi --version)"
runtime_sha="$(
  (cd pi/npm/node_modules && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256) \
  | awk '{print $1}'
)"
printf '%s\n' "$frozen" "$node_version" "$pi_version" "$runtime_sha"
```

在 `docs/summaries/2026-08-02-plan-runner-production-candidate.md` 记录完整 SHA、命令结果、review verdict、tracked lock SHA 和 runtime tree SHA。更新旧 handoff：标记 `f761544` 为历史基线，删除“仅剩 crash analyzer”的当前结论，但保留历史证据说明。

- [ ] **Step 5: 提交冻结说明并重新确认 HEAD**

```bash
git add docs/summaries/2026-08-02-plan-runner-production-candidate.md docs/summaries/2026-08-02-plan-runner-acceptance-handoff.md
git commit -m "docs(plan): 冻结生产候选验收基线"
git rev-parse HEAD
git diff --cached --quiet
```

该 docs commit 若不修改受保护输入，可作为 Harness frozen HEAD；Task 7 记录该完整 SHA。

---

### Task 7: 在冻结 HEAD 上只运行一次真实 Harness 并归档

**Deps:** Task 6

**Files:**
- Create at runtime: `.pi-subagents/artifacts/verification/task-plan-${short_sha}-*`
- Modify: `docs/summaries/2026-08-02-plan-runner-production-candidate.md` only after preserving frozen-code identity

**Interfaces:**
- Consumes: Task 6 frozen HEAD 和 runtime SHA。
- Produces: 与该 HEAD 一一对应的 Harness stdout/stderr/hash、pre/post fixture/socket/process 集合和最终验收结论。

- [ ] **Step 1: 执行不可重跑 preflight**

```bash
set -euo pipefail
frozen="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short=7 HEAD)"
artifact_root=".pi-subagents/artifacts/verification"
stdout="$artifact_root/task-plan-${short_sha}-plan-harness.stdout.log"
stderr="$artifact_root/task-plan-${short_sha}-plan-harness.stderr.log"
hashes="$artifact_root/task-plan-${short_sha}-plan-harness.sha256"
pre_fixtures="$artifact_root/task-plan-${short_sha}-pre-fixtures.txt"
post_fixtures="$artifact_root/task-plan-${short_sha}-post-fixtures.txt"
pre_sockets="$artifact_root/task-plan-${short_sha}-pre-sockets.txt"
post_sockets="$artifact_root/task-plan-${short_sha}-post-sockets.txt"
processes="$artifact_root/task-plan-${short_sha}-processes.txt"
harness_tmp="$(node -p "require('node:os').tmpdir()")"
socket_root="/tmp/pi-root-subagent-$(id -u)"
mkdir -p "$artifact_root"

test -z "$(find "$artifact_root" -maxdepth 1 -type f -name "task-plan-${short_sha}-*" -print)"
git diff --cached --quiet
test "$(node --version)" = "v26.5.0"
test "$(pi --version)" = "0.83.0"
test "$(node -p "require('./pi/npm/node_modules/pi-subagents/package.json').version")" = "0.37.2"
test "$(node -p "require('./pi/npm/node_modules/typebox/package.json').version")" = "1.1.38"
cmp pi/runtime-deps/package-lock.json pi/npm/package-lock.json

harness_inputs=(
  package.json scripts/setup-plan-runtime-deps.mjs scripts/lib/plan scripts/lib/subagent-dispatch
  scripts/probes/pi-subagents-compat.mjs pi/extensions/subagent-runtime.ts pi/extensions/plan-launcher.ts
  pi/child-extensions test/fixtures/deterministic-provider.mjs
  test/fixtures/deterministic-provider-state.mjs test/fixtures/plan-harness
  test/support/flat-plan-attention-driver.mjs test/support/flat-plan-run-quiescence.mjs
  test/support/plan-e2e-process-cleanup.mjs test/plan-flat-runtime-harness.integration.mjs
  test/plan-amendment-harness.integration.mjs
)
git diff --check HEAD -- "${harness_inputs[@]}"
git diff --quiet HEAD -- "${harness_inputs[@]}"
test -z "$(git ls-files --others --exclude-standard -- "${harness_inputs[@]}")"
test "$(git rev-parse HEAD)" = "$frozen"

harness_processes() {
  ps -axo comm=,command= \
    | awk '$1 ~ /^(node|pi)$/ && $0 ~ /pi-plan-flat-(runtime|amendment)|plan-flat-runtime-harness|plan-amendment-harness/ { print }'
}
test -z "$(harness_processes)"
find "$harness_tmp" -maxdepth 1 -type d \
  \( -name 'pi-plan-flat-amendment-*' -o -name 'pi-plan-flat-runtime-*' \) \
  -print | LC_ALL=C sort >"$pre_fixtures"
if test -d "$socket_root"; then
  find "$socket_root" -maxdepth 1 -type s -print | LC_ALL=C sort >"$pre_sockets"
else
  : >"$pre_sockets"
fi
```

Expected: frozen HEAD 未变化、受保护输入 clean、目标 artifact 路径全新、无活跃 Harness 进程，fixture/socket pre 集合已保存。

- [ ] **Step 2: 只运行一次 Harness 并捕获 post 状态**

```bash
set +e
PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness >"$stdout" 2>"$stderr"
harness_status=$?
set -e

find "$harness_tmp" -maxdepth 1 -type d \
  \( -name 'pi-plan-flat-amendment-*' -o -name 'pi-plan-flat-runtime-*' \) \
  -print | LC_ALL=C sort >"$post_fixtures"
if test -d "$socket_root"; then
  find "$socket_root" -maxdepth 1 -type s -print | LC_ALL=C sort >"$post_sockets"
else
  : >"$post_sockets"
fi
shasum -a 256 "$stdout" "$stderr" >"$hashes"
harness_processes >"$processes"
printf 'frozen_head=%s\nharness_exit=%s\n' "$frozen" "$harness_status"
```

无论 exit `0` 或非零，上述归档完成后该 HEAD 已被消费，禁止重跑。

- [ ] **Step 3: 验证 GREEN 条件**

```bash
test "$harness_status" -eq 0
test ! -s "$stderr"
test ! -s "$processes"
test "$(git rev-parse HEAD)" = "$frozen"
rg -q 'same Root flat amendment crash Harness revives the canonical Plan Runner' "$stdout"
rg -q 'flat Root runtime Harness reaches two validated Plan Runner happy paths' "$stdout"
rg -q 'pass 2' "$stdout"
rg -q 'fail 0' "$stdout"
cmp "$pre_fixtures" "$post_fixtures"
cmp "$pre_sockets" "$post_sockets"
test -z "$(harness_processes)"
```

同时从 stdout 中检查两个 Harness 均证明 production wrapper 被生成、Executor owner 已订阅、全部 Plan 达到 `validated`、所有 official terminal proof 合法、PID 为 `ESRCH`。

- [ ] **Step 4: 归档 GREEN 或 RED**

GREEN 时创建：

```bash
green="$artifact_root/task-plan-${short_sha}-plan-harness-green.md"
cat >"$green" <<EOF
# Plan Runner Harness GREEN

- Frozen HEAD: \`$frozen\`
- Unique run: true
- Harness exit: \`$harness_status\`
- Stdout: \`$stdout\`
- Stderr: \`$stderr\`
- Hashes: \`$hashes\`
- Fixture sets equal: true
- Socket sets equal: true
- Residual processes: none
EOF
```

RED 时创建 `$artifact_root/task-plan-${short_sha}-plan-harness-failure.md`，记录相同身份、exit、hash、pre/post 差异和 `$processes`；只对 `comm -13 "$pre_fixtures" "$post_fixtures"` 得出的本次新增 fixture 使用 `test/support/plan-e2e-process-cleanup.mjs` 做 identity-safe cleanup，保留失败现场。建立新 bug 文档和新 HEAD，不能在本 Task 重试。

- [ ] **Step 5: 写最终结论**

只有 GREEN 才在生产候选文档追加：

```text
Plan Runner 可投入单机、单 Root、受监督的实际使用；跨仓生产 profile、恢复、Attention、并行 Executor 和关闭链已由当前 frozen HEAD 证据覆盖。
```

同时写明 validated baseline 为 `$frozen`，当前 docs descendant 不等于 Harness 实际运行 HEAD。不得宣称多机、多 Root 共享 handle 或无人值守生产可用。

- [ ] **Step 6: 提交纯文档关闭记录**

```bash
git add docs/summaries/2026-08-02-plan-runner-production-candidate.md
git commit -m "docs(plan): 记录生产 Harness 验收证据"
```

该提交不得包含 Harness 输入或 ignored artifact；证据文件继续由路径和 SHA-256 引用。
