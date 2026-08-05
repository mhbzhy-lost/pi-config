# Plan Runner 剥离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 `main` 完整移除 Plan Runner 产品、入口与专属 caller/revival runtime，同时保留 Goal Engine、typed subagent、Root Executor ownership、Supervisor 和用户本地配置，并安全推送远端。

**Architecture:** 先把远端四个分叉提交纳入当前 `main`，再以测试固定通用 runtime 边界：Root Broker 只保留 Root 直接拥有 Executor 的授权、订阅、终止与清理，不再承载 Plan caller、revival、follow-up 或 Plan Supervisor 路由。随后删除 Plan 领域、配置、Skill、测试和现行文档，最后做 Goal Engine/typed subagent/Doctor 回归、独立复审与非强制推送。

**Tech Stack:** TypeScript/ESM、Node.js `node:test`、Pi Extensions、Git、npm scripts。

## Global Constraints

- 实施任何逻辑变更前必须加载 `test-driven-development` skill，严格执行 tests-only RED → 最小 GREEN；本计划文档本身为纯文档豁免。
- 用户选择 Inline Execution；各 Task 在当前 `main` 顺序执行，每个 RED/GREEN 边界独立提交并在继续前验收。
- 不调用 TokenRec 的任何 `goal_*` tool，不修改 `/Users/mhbzhy/tokenrec/.state/**`，不处置其 attempt-1 orphan workspace。
- 保留 `archive/plan-runner-before-removal-20260805 → 61ab540b4c454916af60c744893e20f1767dfc03`，并最终推送该存档分支。
- 保留 `fix/plan-supervisor-bound-wake → 02c4151c4a46156862c3fcc009d70234bbdc95b9`，不得移动、删除或合入 production。
- 不重跑已消费的 one-shot Plan Harness `ee45d7e`。
- 除用户明确授权的 `pi/settings.json` 单文件 stash 外，不使用其他 `stash`、`reset`、`restore`、`clean` 或 force push。
- `/Users/mhbzhy/pi-config/pi/settings.json` 已保存为 stash commit `183567f037a61b5fdcf78e93d27a9c8ebb2f0002`；用户内容 SHA-256 为 `7b9c3ace7929e9c3a3e13dfb024188f55a619089f002fa754083971e60559adf`，最终 apply 复原但不得提交。
- `/Users/mhbzhy/pi-config/skill-overrides/aliyun-beijing-server/` 是 Local Skill，必须通过 `.git/info/exclude` 的 `/skill-overrides/aliyun-beijing-server/` 本地规则忽略；不得 add、删除、改名或覆盖。
- removal 分支不得改变 `61ab540:pi/settings.json` 的已提交 blob；远端 `pi/settings.json` 分叉只建立历史祖先关系，不覆盖本地或用户版本。
- Goal Engine 必须继续精确暴露七个 typed tools：`goal_init`、`goal_status`、`goal_dispatch`、`goal_settle`、`goal_accept`、`goal_amend`、`goal_integrate`。
- 保留 `pi/extensions/subagent-runtime.ts`、`pi/child-extensions/root-session-owner.ts`、`scripts/lib/subagent-dispatch/**` 的通用部分，以及 `pi-subagents@0.37.2`、`typebox@1.1.38`。
- 删除 Plan Runner 专属 `root-owned-subagent.ts`；普通 Executor 继续使用 `.pi-subagents/root-session-owner-entry.mjs`，禁止把 `.pi-subagents/` 或 `/var/` 整体删除或取消 ignore。
- 外部 reviewer timeout/provider 不可用不算批准；同一累计 diff 最多两轮 review。
- 全量测试允许记录可复现的既有非本次失败，但所有新增/修改定向测试、Goal Engine 310 项冻结回归、Skill 28 项发现回归和 Doctor 必须通过。
- 所有 commit message 遵循 `type(scope): 中文祈使句`，不得包含 AI 签名。

---

### Task 1: 建立 Inline 基线并纳入远端历史

**Files:**
- Modify on conflict only: `pi/AGENTS.md`
- Modify on conflict only: `test/global-rules.test.mjs`
- Modify on conflict only: `test/migration-contract.test.mjs`
- Preserve exactly: `pi/settings.json`
- Add: `docs/superpowers/plans/2026-08-05-plan-runner-removal.md`

**Interfaces:**
- Consumes: `main=61ab540`、`origin/main=29f8a15`、存档分支已存在。
- Produces: 一个包含 `origin/main` 历史、保留本地 Goal Engine 候选且 `pi/settings.json` 已提交 blob 不被远端旧配置覆盖的 `main` HEAD。

- [x] **Step 1: 固定主工作树证据**

在 `/Users/mhbzhy/pi-config` cwd 运行：

```bash
git status --short --branch
git rev-parse HEAD origin/main archive/plan-runner-before-removal-20260805 fix/plan-supervisor-bound-wake
git rev-parse 183567f037a61b5fdcf78e93d27a9c8ebb2f0002^{commit}
```

Expected: 主工作树仅显示本计划文档；settings 已 stash，Local Skill 已由 `.git/info/exclude` 隐藏；所有 ref 与 Global Constraints 一致。

- [x] **Step 2: 提交计划文档**

```bash
git add docs/superpowers/plans/2026-08-05-plan-runner-removal.md
git commit -m "docs(plan-runner): 记录退役实施计划"
```

Expected: commit 仅包含本计划。

- [x] **Step 3: 把远端四个分叉提交合入 main，但保留本地已提交 settings blob**

```bash
git fetch origin main
git merge --no-commit origin/main
```

若发生冲突：

1. 用 `git show 61ab540:pi/settings.json > pi/settings.json` 保留本地已提交 settings blob；用户版本仍由固定 stash commit 保护。
2. `pi/AGENTS.md` 保留本地核心约束并吸收远端不冲突的精简文案；Plan Runner 选项在 Task 3 删除。
3. `test/global-rules.test.mjs` 与 `test/migration-contract.test.mjs` 只保留与最终配置一致的断言，不得通过改写 `pi/settings.json` 让远端测试通过。
4. 解决完所有冲突后运行：

```bash
git diff --check
test "$(git hash-object pi/settings.json)" = "$(git rev-parse 61ab540:pi/settings.json)"
node --test test/global-rules.test.mjs test/migration-contract.test.mjs
git add pi/AGENTS.md pi/settings.json test/global-rules.test.mjs test/migration-contract.test.mjs
git commit -m "chore(main): 合并远端配置历史"
```

Expected: merge commit 同时包含当前 `main` 与 `origin/main`；settings blob 等于 `61ab540`。

- [x] **Step 4: 核对 merge 后边界**

```bash
git merge-base --is-ancestor origin/main HEAD
git merge-base --is-ancestor 61ab540 HEAD
test "$(git hash-object pi/settings.json)" = "$(git rev-parse 61ab540:pi/settings.json)"
git status --short
```

Expected: 两个 ancestry 检查成功；`main` clean；用户 settings 仍在固定 stash commit 中。

---

### Task 2: 从共享 Root Broker 中移除 Plan caller/revival 协议

**Deps:** Task 1

**Files:**
- Create: `test/plan-runner-removal.test.mjs`
- Modify: `pi/extensions/subagent-runtime.ts`
- Delete: `pi/child-extensions/root-owned-subagent.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-protocol.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-client.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-server.ts`
- Preserve: `scripts/lib/subagent-dispatch/root-broker-registry.ts`
- Preserve: `scripts/lib/subagent-dispatch/supervisor-adapter.ts`
- Preserve: `pi/child-extensions/root-session-owner.ts`
- Modify: `test/root-subagent-broker-protocol.test.mjs`
- Modify: `test/root-subagent-broker.test.mjs`
- Modify: `test/subagent-runtime-root-upstream.test.mjs`
- Modify: `test/subagent-supervisor-adapter.test.mjs`
- Delete: `test/root-broker-caller-followup-client.integration.mjs`
- Delete: `test/root-broker-caller-followup-protocol.test.mjs`
- Delete: `test/root-broker-caller-followup-server.test.mjs`
- Delete: `test/root-broker-push-fifo.test.mjs`
- Delete: `test/root-broker-revival-cleanup.test.mjs`
- Delete: `test/root-broker-revival.test.mjs`
- Delete: `test/root-broker-subscribe-flush.test.mjs`

**Interfaces:**
- Consumes: upstream typed subagent RPC 的 `ping`、`stop`、`dispose`，以及 `subagent:async-started`、`subagent:process-terminal` 事件。
- Produces: `BrokerGrant.role: "executor"`；wire methods 仅保留 Root-owned Executor 实际需要的 `ping` 与 `subscribe`；`createRootBrokerUpstream({rpc})` 不再提供 recovery/resume/Plan Supervisor closure。
- Produces: `RootBrokerServer.start(): Promise<void>`、`RootBrokerServer.close(): Promise<void>`、direct Executor grant/ownership/terminal-cleanup 行为继续可用。

- [x] **Step 1: 加载 TDD skill 并建立 tests-only RED**

在当前 `main` 先加载 `test-driven-development`，然后创建静态退役契约：

```js
// test/plan-runner-removal.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const absent = async (relative) => {
  await assert.rejects(access(new URL(`../${relative}`, import.meta.url)), { code: "ENOENT" });
};

const source = async (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("shared subagent runtime contains no Plan caller or revival production surface", async () => {
  await absent("pi/child-extensions/root-owned-subagent.ts");
  for (const relative of [
    "pi/extensions/subagent-runtime.ts",
    "scripts/lib/subagent-dispatch/root-broker-protocol.ts",
    "scripts/lib/subagent-dispatch/root-broker-client.ts",
    "scripts/lib/subagent-dispatch/root-broker-server.ts",
  ]) {
    const text = await source(relative);
    assert.doesNotMatch(text, /plan-runner|preparePlanRunnerRecovery|caller\.followup|logicalCaller|reviv/i, relative);
  }
});
```

同时在 `test/root-subagent-broker-protocol.test.mjs` 先增加：

```js
test("broker grants only direct executors and exposes no caller control protocol", () => {
  assert.deepEqual([...BROKER_METHODS], ["ping", "subscribe"]);
  assert.throws(() => parseBrokerGrant({
    schemaVersion: "pi-root-subagent-broker-grant.v1",
    rootSessionId: "root", runId: "run", callerToken: "a".repeat(64), role: "plan-runner",
  }), /role/);
});
```

- [x] **Step 2: 运行 RED 并确认失败原因精确**

```bash
node --test test/plan-runner-removal.test.mjs test/root-subagent-broker-protocol.test.mjs
```

Expected: FAIL 仅因旧文件仍存在、旧符号仍存在、method/role 仍包含 Plan caller；不得是 import 或语法错误。

- [x] **Step 3: 提交 tests-only RED**

```bash
git add test/plan-runner-removal.test.mjs test/root-subagent-broker-protocol.test.mjs
git commit -m "test(runtime): 固定 Plan caller 退役边界"
```

- [x] **Step 4: 最小化 Root Broker production surface**

实施以下精确边界：

```ts
// root-broker-protocol.ts
const METHODS = Object.freeze(["ping", "subscribe"] as const);
const GRANT_ROLES = Object.freeze(["executor"] as const);
```

- 删除 `caller.followup` 解析、Plan caller grant、spawn ledger caller API、logical alias、generation revival、wake/follow-up、Plan-owned Supervisor queue/reply、recovery diagnostics。
- 保留严格 frame envelope、request/response identity、socket/grant 权限、`processTerminal` 解析、`root.closing`/`subscription.ready` push。
- `root-broker-client.ts` 只返回 `ping`、`subscribe`、`dispose`；删除 `spawn`、`lookupSpawn`、caller control、Supervisor caller methods。
- `root-broker-server.ts` 保留 direct Executor `agent-started` 授权、exact ownership、birth identity、official terminal proof、Root close、graceful stop、verified force cleanup、grant/socket cleanup debt；Principal/OwnedRun role 收窄为 `"executor"`。
- `pi/extensions/subagent-runtime.ts` 的 upstream 收窄为冻结的 `ping`、`stop`、`dispose` 代理；删除 `preparePlanRunnerRecovery`、`readAsyncRecoveryDescriptor`、`writePrivateAtomicJson`、`MAX_RECOVERY_DESCRIPTOR_BYTES`、`SAFE_RUN_ID` 与 Plan diagnostic sink。
- 删除 `pi/child-extensions/root-owned-subagent.ts`；保留并继续为 Executor materialize `root-session-owner-entry.mjs`。
- Root 的 `subagent_supervisor` 继续由 `installHeadlessTypedSubagentRuntime`/`supervisor-adapter.ts` 提供，不再创建 `plan_executor_supervisor`。

`createRootBrokerUpstream` 的目标形态：

```ts
export function createRootBrokerUpstream({ rpc }: { rpc: any }) {
  return Object.freeze({
    ping: (...args: any[]) => rpc.ping(...args),
    stop: (...args: any[]) => rpc.stop(...args),
    dispose: (...args: any[]) => rpc.dispose(...args),
  });
}
```

- [x] **Step 5: 收窄测试而不删除通用安全覆盖**

`test/root-subagent-broker.test.mjs` 必须保留或重写为以下行为测试：

1. exact root/token/request frame validation；
2. direct async Executor grant 幂等与 grant-ready retry；
3. malformed/foreign started event 在 capture/write 前 fail closed；
4. exact ownership 与 birth identity conflict；
5. Executor principal 只能 `ping`/`subscribe`；
6. Root EOF 让 `root-session-owner.ts` 单次 SIGTERM；
7. Root close 先发 `root.closing`，再 stop Executor，等待 official terminal；
8. unknown terminal/stop failure/grant unlink failure 保留可重试 cleanup debt；
9. verified force cleanup 仍要求 exact birth identity、official proof 与 post-proof death check；
10. registry start/bind/close/unbind 保持原子边界。

`test/subagent-supervisor-adapter.test.mjs` 保留 native/project `subagent_supervisor` membrane 与 mailbox 测试，删除所有 `installRootOwnedSubagent`、`plan_executor_supervisor`、Plan Attention 测试。

- [x] **Step 6: 运行 GREEN**

```bash
node --test \
  test/plan-runner-removal.test.mjs \
  test/root-subagent-broker-protocol.test.mjs \
  test/root-subagent-broker.test.mjs \
  test/subagent-runtime-root-upstream.test.mjs \
  test/subagent-supervisor-adapter.test.mjs \
  test/subagent-runtime-root-broker-startup.integration.mjs \
  test/child-runtime-entry.test.mjs \
  test/process-birth-identity.test.mjs
```

Expected: 全部 PASS；无 Plan caller/revival 测试被保留为 production requirement。

- [x] **Step 7: 提交 GREEN**

```bash
git add -A pi/extensions/subagent-runtime.ts pi/child-extensions scripts/lib/subagent-dispatch test
git commit -m "refactor(runtime): 移除 Plan caller 恢复协议"
```

---

### Task 3: 通用化依赖安装、Doctor 与规则配置

**Deps:** Task 2

**Files:**
- Rename: `scripts/setup-plan-runtime-deps.mjs` → `scripts/setup-subagent-runtime-deps.mjs`
- Modify: `package.json`
- Modify: `init-pi.sh`
- Modify: `scripts/doctor.mjs`
- Modify: `skill-overrides/skills.list`
- Modify: `pi/AGENTS.md`
- Modify: `README.md`
- Modify: `test/package-scripts.test.mjs`
- Modify: `test/init-pi.test.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/skill-list.test.mjs`
- Modify: `test/global-rules.test.mjs`
- Modify: `test/migration-contract.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`
- Modify: `test/plan-runner-removal.test.mjs`

**Interfaces:**
- Consumes: `pi-subagents@0.37.2` 与 `typebox@1.1.38` 固定版本。
- Produces: package script `setup:subagent-runtime`；exports `buildSubagentRuntimeInstallCommand(piNpmDir)` 与 `installSubagentRuntimeDependencies(options)`。
- Produces: Doctor 继续检查 executor/spark、subagent runtime、Root Broker components、Goal exact-seven ABI，不再要求 Plan profiles/extensions/skill。

- [x] **Step 1: 写 tests-only RED**

先加载 `test-driven-development`，再把混合测试改成以下新契约：

```js
assert.equal(pkg.scripts["setup:plan-runtime"], undefined);
assert.equal(pkg.scripts["setup:subagent-runtime"], "node scripts/setup-subagent-runtime-deps.mjs");
assert.equal(pkg.scripts["test:plan"], undefined);
assert.equal(pkg.scripts["test:plan-harness"], undefined);
assert.doesNotMatch(await readFile(new URL("../skill-overrides/skills.list", import.meta.url), "utf8"), /^plan-runner-dispatch$/m);
```

`test/init-pi.test.mjs` 必须预期：

```js
assert.match(source, /npm run setup:subagent-runtime/);
assert.doesNotMatch(source, /setup:plan-runtime/);
```

`test/doctor.test.mjs` 的成功 fixture 不创建 Plan agent/extension/skill，并继续断言 Root Broker、Goal ABI、依赖版本缺失会报错。

- [x] **Step 2: 运行 RED**

```bash
node --test \
  test/package-scripts.test.mjs \
  test/init-pi.test.mjs \
  test/doctor.test.mjs \
  test/skill-list.test.mjs \
  test/global-rules.test.mjs \
  test/migration-contract.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/plan-runner-removal.test.mjs
```

Expected: FAIL 仅因旧 script/Doctor/rules surface 仍存在。

- [x] **Step 3: 提交 tests-only RED**

```bash
git add test/package-scripts.test.mjs test/init-pi.test.mjs test/doctor.test.mjs test/skill-list.test.mjs test/global-rules.test.mjs test/migration-contract.test.mjs test/pi-subagents-compat.test.mjs test/plan-runner-removal.test.mjs
git commit -m "test(config): 固定 Plan Runner 配置退役契约"
```

- [x] **Step 4: 重命名通用依赖安装入口**

目标 exports：

```js
export function buildSubagentRuntimeInstallCommand(piNpmDir) {
  return {
    command: "npm",
    args: ["install", "--prefix", piNpmDir, "--save-exact", "pi-subagents@0.37.2", "typebox@1.1.38"],
  };
}

export async function installSubagentRuntimeDependencies({
  piNpmDir = resolve(import.meta.dirname, "../pi/npm"),
  env = process.env,
  run = execFile,
} = {}) {
  await run("npm", ["uninstall", "--prefix", piNpmDir, "@juicesharp/rpiv-todo"], { env });
  const { command, args } = buildSubagentRuntimeInstallCommand(piNpmDir);
  await run(command, args, { env });
  return { piNpmDir };
}
```

CLI 输出改为 `Subagent runtime dependencies installed in ...`；`init-pi.sh` 调用 `npm run setup:subagent-runtime`。

- [x] **Step 5: 删除配置公开面并保留 Goal/subagent 门禁**

- `package.json` 删除 `test:plan`、`test:plan-harness`、`setup:plan-runtime`，增加 `setup:subagent-runtime`。
- `skills.list` 删除 `plan-runner-dispatch`，保留 `subagent-dispatch` 与 `using-goal-engine`。
- `pi/AGENTS.md` 删除第 3 项 Plan Runner Dispatch，把 Goal Engine 重新编号为第 3 项；删除 `/plan-run` 指导。
- `README.md` 删除 Plan Runner 命令、架构与入口说明，保留 Goal Engine、typed subagent、Root Broker/Supervisor 的现行说明。
- `scripts/doctor.mjs` 删除 `plan-runner-dispatch`、`plan-runner`/`plan-reviewer` profile、Plan extensions、`scripts/lib/plan/**` 检查；保留 executor/spark、Root components、Goal exact-seven ABI、runtime dependency probe。
- `test/migration-contract.test.mjs` 不再断言 Plan profile/state；仍覆盖 executor owner extension、Goal Engine 与 `.pi-subagents` ignore。

- [x] **Step 6: 运行 GREEN 和安装 dry contract**

```bash
node --test \
  test/package-scripts.test.mjs \
  test/init-pi.test.mjs \
  test/doctor.test.mjs \
  test/skill-list.test.mjs \
  test/global-rules.test.mjs \
  test/migration-contract.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/plan-runner-removal.test.mjs
npm run doctor
```

Expected: 全部 PASS；Doctor 不依赖任何 Plan 文件。

- [x] **Step 7: 提交 GREEN**

```bash
git add -A package.json init-pi.sh scripts/setup-subagent-runtime-deps.mjs scripts/setup-plan-runtime-deps.mjs scripts/doctor.mjs skill-overrides/skills.list pi/AGENTS.md README.md test
git commit -m "refactor(config): 通用化子代理运行时配置"
```

---

### Task 4: 删除 Plan Runner 领域、测试、Skill、状态与现行文档

**Deps:** Task 3

**Files:**
- Delete: `pi/agents/plan-runner.md`
- Delete: `pi/agents/plan-reviewer.md`
- Delete: `pi/extensions/plan-launcher.ts`
- Delete: `pi/child-extensions/plan-runner.ts`
- Delete: `pi/child-extensions/plan-capsule.ts`
- Delete: `scripts/lib/plan/**`
- Delete: `skill-overrides/plan-runner-dispatch/**`
- Delete: `.state/goal-contract/goals/plan-runner-pi-subagents-parallel-harness/**`
- Delete: `.state/goal-contract/goals/plan-ir-v3-complete-capsule-contract/**`
- Modify: `.state/goal-contract/registry.json`
- Delete: `test/plan-*.test.mjs`
- Delete: `test/plan-*.integration.mjs`
- Delete: `test/fixtures/plan-harness/**`
- Delete: `test/support/flat-plan-attention-driver.mjs`
- Delete: `test/support/flat-plan-run-quiescence.mjs`
- Delete: `test/support/plan-e2e-process-cleanup.mjs`
- Modify: `test/fixtures/deterministic-provider-state.mjs`
- Modify: `test/fixtures/deterministic-provider.mjs`
- Modify: `test/deterministic-provider.test.mjs`
- Delete: `docs/architecture/plan-ir-v3.md`
- Delete: `docs/architecture/plan-runner-flat-runtime.md`
- Delete: `docs/audits/2026-07-29-plan-runner-architecture-audit.md`
- Delete: `docs/knowledge/plan-runner-pi-subagents-harness.md`
- Delete: `docs/pi-plan-execution-capsule.md`
- Delete: `docs/summaries/2026-08-02-plan-runner-acceptance-handoff.md`
- Delete: `docs/superpowers/plans/2025-07-21-rewrite-playwright-plan-runner-dispatch-skills.md`
- Delete: `docs/superpowers/plans/2026-07-15-pi-plan-execution-capsule.md`
- Delete: `docs/superpowers/plans/2026-07-16-parent-owned-plan-runner-lifecycle.md`
- Delete: `docs/superpowers/plans/2026-07-21-plan-runner-supervisor-compat.md`
- Delete: `docs/superpowers/plans/2026-07-23-plan-runner-self-built-runtime.md`
- Delete: `docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md`
- Delete: `docs/superpowers/plans/2026-07-29-plan-ir-v3-complete-capsule-contract.md`
- Delete: `docs/superpowers/plans/2026-07-29-plan-runner-flat-rpc-remove-thin-host.md`
- Delete: `docs/superpowers/plans/2026-08-02-plan-runner-production-convergence.md`
- Delete: `docs/bugs/bug-plan-*.md`
- Delete: `docs/bugs/bug-flat-plan-*.md`
- Preserve: `docs/bugs/bug-goal-*.md`
- Preserve: `docs/summaries/*goal-engine*`
- Preserve: `docs/superpowers/plans/2026-07-24-goal-engine.md`
- Preserve: `docs/superpowers/plans/2026-08-05-plan-runner-removal.md`

**Interfaces:**
- Consumes: Task 2/3 已无 production import 或配置引用。
- Produces: production tree 无 Plan extension/profile/Skill/domain；Goal Contract registry 仅保留非 Plan goal `footer-native-child-conversation`，且 `active_goal_ids` 不再引用被删 goal。

- [x] **Step 1: 扩展 tests-only RED 为完整 production-surface 断言**

在 `test/plan-runner-removal.test.mjs` 增加：

```js
test("Plan Runner production entries and domains are absent", async () => {
  for (const relative of [
    "pi/agents/plan-runner.md",
    "pi/agents/plan-reviewer.md",
    "pi/extensions/plan-launcher.ts",
    "pi/child-extensions/plan-runner.ts",
    "pi/child-extensions/plan-capsule.ts",
    "scripts/lib/plan",
    "skill-overrides/plan-runner-dispatch",
    ".state/goal-contract/goals/plan-runner-pi-subagents-parallel-harness",
    ".state/goal-contract/goals/plan-ir-v3-complete-capsule-contract",
  ]) await absent(relative);
});
```

再增加 registry 断言：

```js
const registry = JSON.parse(await source(".state/goal-contract/registry.json"));
assert.deepEqual(registry.active_goal_ids, []);
assert.deepEqual(Object.keys(registry.goals), ["footer-native-child-conversation"]);
```

- [x] **Step 2: 运行 RED 并提交 tests-only commit**

```bash
node --test test/plan-runner-removal.test.mjs
# Expected: FAIL，因为专属目录与 registry 条目仍存在
git add test/plan-runner-removal.test.mjs
git commit -m "test(plan-runner): 固定产品表面删除契约"
```

- [x] **Step 3: 删除 production、Skill、Plan state 与专属测试**

```bash
git rm -r \
  pi/agents/plan-runner.md \
  pi/agents/plan-reviewer.md \
  pi/extensions/plan-launcher.ts \
  pi/child-extensions/plan-runner.ts \
  pi/child-extensions/plan-capsule.ts \
  scripts/lib/plan \
  skill-overrides/plan-runner-dispatch \
  .state/goal-contract/goals/plan-runner-pi-subagents-parallel-harness \
  .state/goal-contract/goals/plan-ir-v3-complete-capsule-contract \
  test/fixtures/plan-harness \
  test/support/flat-plan-attention-driver.mjs \
  test/support/flat-plan-run-quiescence.mjs \
  test/support/plan-e2e-process-cleanup.mjs
git ls-files 'test/plan-*.test.mjs' 'test/plan-*.integration.mjs' -z | xargs -0 git rm
```

编辑 `.state/goal-contract/registry.json`：

```json
{
  "schema_version": "goal_contract.registry.v1",
  "state_root": ".state/goal-contract",
  "active_goal_ids": [],
  "goals": {
    "footer-native-child-conversation": {
      "goal_id": "footer-native-child-conversation",
      "contract_dir": ".state/goal-contract/goals/footer-native-child-conversation",
      "recovery": ".state/goal-contract/goals/footer-native-child-conversation/recovery.md",
      "state": ".state/goal-contract/goals/footer-native-child-conversation/state.json",
      "feature_list": ".state/goal-contract/goals/footer-native-child-conversation/feature-list.json",
      "evidence": ".state/goal-contract/goals/footer-native-child-conversation/evidence.jsonl",
      "status": "completed"
    }
  }
}
```

- [x] **Step 4: 把 deterministic provider 收窄为通用 subagent fixture**

删除 `test/deterministic-provider.test.mjs` 与 `test/fixtures/deterministic-provider-state.mjs` 中所有 `plan_*`、Plan Attention、amendment、runner bootstrap 分支；保留：

- typed Executor dispatch contract；
- `contact_supervisor` 等待决策；
- 通用 subagent async started/completed；
- `test/pi-subagents-runtime.integration.mjs` 与 `test/subagent-runtime-root-broker-startup.integration.mjs` 所需的 deterministic response。

目标导出不含 `decideDeterministicAmendmentTurn` 或 Plan bootstrap state；`test/fixtures/deterministic-provider.mjs` 只导入通用 decision 函数。

- [x] **Step 5: 删除现行 Plan 文档，保留 Goal/shared runtime 历史**

按 Files 清单执行 `git rm`。对 `docs/bugs/bug-plan-*.md`、`docs/bugs/bug-flat-plan-*.md` 使用 tracked glob 删除；不要删除 `bug-goal-*`，也不要根据正文中的单次历史提及批删 shared Root Broker/Goal 文档。

```bash
git rm docs/architecture/plan-ir-v3.md docs/architecture/plan-runner-flat-runtime.md \
  docs/audits/2026-07-29-plan-runner-architecture-audit.md \
  docs/knowledge/plan-runner-pi-subagents-harness.md docs/pi-plan-execution-capsule.md \
  docs/summaries/2026-08-02-plan-runner-acceptance-handoff.md
git ls-files 'docs/bugs/bug-plan-*.md' 'docs/bugs/bug-flat-plan-*.md' -z | xargs -0 git rm
git rm \
  docs/superpowers/plans/2025-07-21-rewrite-playwright-plan-runner-dispatch-skills.md \
  docs/superpowers/plans/2026-07-15-pi-plan-execution-capsule.md \
  docs/superpowers/plans/2026-07-16-parent-owned-plan-runner-lifecycle.md \
  docs/superpowers/plans/2026-07-21-plan-runner-supervisor-compat.md \
  docs/superpowers/plans/2026-07-23-plan-runner-self-built-runtime.md \
  docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md \
  docs/superpowers/plans/2026-07-29-plan-ir-v3-complete-capsule-contract.md \
  docs/superpowers/plans/2026-07-29-plan-runner-flat-rpc-remove-thin-host.md \
  docs/superpowers/plans/2026-08-02-plan-runner-production-convergence.md
```

- [x] **Step 6: 运行 GREEN、import 扫描和 Goal Contract audit**

```bash
node --test test/plan-runner-removal.test.mjs test/deterministic-provider.test.mjs
npm run doctor
! git grep -n -E 'scripts/lib/plan|lib/plan' -- pi scripts package.json init-pi.sh skill-overrides
! git grep -n -E 'plan_run|plan_attention_reply|plan_executor_supervisor|setup:plan-runtime' -- pi scripts package.json init-pi.sh skill-overrides README.md
```

Expected: tests/Doctor PASS；两项 production scan 无输出。

- [x] **Step 7: 提交 GREEN**

```bash
git add -A
git commit -m "refactor(plan-runner): 删除退役产品与专属资产"
```

---

### Task 5: 冻结回归、残留审计与独立复审

**Deps:** Task 4

**Files:**
- Create: `docs/summaries/2026-08-05-plan-runner-removal-verification.md`
- Modify only if a new defect is found: corresponding `docs/bugs/bug-<摘要>.md`、tests、minimal implementation files

**Interfaces:**
- Consumes: Task 2–4 cumulative diff。
- Produces: 可审计的测试结果、允许残留说明、两轮以内独立 review 结论和 production-ready/Not Ready 判定。

- [x] **Step 1: 核对 production surface 与 archive refs**

```bash
git status --short
git merge-base --is-ancestor origin/main HEAD
test "$(git rev-parse archive/plan-runner-before-removal-20260805)" = 61ab540b4c454916af60c744893e20f1767dfc03
test "$(git rev-parse fix/plan-supervisor-bound-wake)" = 02c4151c4a46156862c3fcc009d70234bbdc95b9
! git grep -n -E 'scripts/lib/plan|lib/plan|plan_executor_supervisor|preparePlanRunnerRecovery|caller\.followup|setup:plan-runtime' -- pi scripts package.json init-pi.sh skill-overrides README.md
```

Expected: clean；refs 未移动；production scan 无输出。

- [x] **Step 2: 运行 Goal Engine 冻结与 Skill 回归**

```bash
node --test \
  test/goal-engine-audit.test.mjs \
  test/goal-engine-dispatch.test.mjs \
  test/goal-engine-events.test.mjs \
  test/goal-engine-extension.test.mjs \
  test/goal-engine-graph.test.mjs \
  test/goal-engine-runtime.integration.mjs \
  test/goal-engine-store-concurrency.test.mjs \
  test/goal-engine-workspace.test.mjs
node --test test/using-goal-engine-skill.test.mjs test/skill-list.test.mjs test/skill-whitelist-extension.test.mjs
npm run doctor
```

Expected: Goal Engine 310/310、Skill/discovery 28/28、Doctor OK；若远端合并改变测试数，摘要必须给出精确新总数且零失败。

- [x] **Step 3: 运行通用 subagent/Root Broker 回归**

```bash
node --test \
  test/subagent-*.test.mjs \
  test/root-subagent-broker*.test.mjs \
  test/root-broker-*.test.mjs \
  test/process-birth-identity.test.mjs \
  test/child-runtime-entry.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/pi-subagents-runtime.integration.mjs \
  test/subagent-runtime-root-broker-startup.integration.mjs
```

Expected: 全部保留测试 PASS；命令 glob 不应匹配已删除的 Plan-only tests。

- [x] **Step 4: 运行全仓回归并做基线归因**

```bash
npm test
npm run test:integration
npm run test:subagents
```

Expected: 不新增失败。任何失败必须记录 test name、是否在 `61ab540` 可复现、与 removal diff 的关联；不得把既有失败写成 GREEN。

- [x] **Step 5: 独立 review，最多两轮**

review 必须检查：

1. Plan production/import/tool/Skill surface 是否清零；
2. Root Broker 的 direct Executor ownership、close、terminal proof、cleanup debt 是否仍 fail-closed；
3. Goal Engine exact-seven ABI 与 dispatch 是否未受影响；
4. `pi/settings.json`/aliyun 用户内容是否完全未进入 diff；
5. 远端四个提交是否已成为 ancestry；
6. 删除测试是否只对应删除的产品，而非掩盖通用 runtime 缺陷。

若发现 bug，必须先创建中文六要素 `docs/bugs/bug-<摘要>.md`，再按 tests-only RED → minimal GREEN 修复；之后只允许第二轮 cumulative review。

- [x] **Step 6: 写中文验证摘要并提交**

摘要必须列出：archive/ref、删除边界、保留边界、定向测试、全仓结果与基线失败、review 结论、用户文件 hash、是否 production-ready。

```bash
git add docs/summaries/2026-08-05-plan-runner-removal-verification.md
git commit -m "docs(plan-runner): 记录退役验证结论"
git status --short
```

Expected: `main` clean。

---

### Task 6: 保护性部署到本地 main 并推送远端

**Deps:** Task 5

**Files:**
- No source edits
- Preserve exactly: `/Users/mhbzhy/pi-config/pi/settings.json`
- Preserve exactly: `/Users/mhbzhy/pi-config/skill-overrides/aliyun-beijing-server/**`

**Interfaces:**
- Consumes: clean、review-approved、包含 `origin/main` ancestry 的 `main` HEAD。
- Produces: 远端 archive 分支与 `origin/main` 更新；用户 settings 从固定 stash 复原，Local Skill 继续本地 exclude。

- [x] **Step 1: 固定部署前用户证据**

```bash
git status --short
git merge-base --is-ancestor origin/main HEAD
test "$(git show 183567f037a61b5fdcf78e93d27a9c8ebb2f0002:pi/settings.json | sha256sum | awk '{print $1}')" = 7b9c3ace7929e9c3a3e13dfb024188f55a619089f002fa754083971e60559adf
find skill-overrides/aliyun-beijing-server -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/aliyun-beijing-before.sha256
git status --short --branch
```

Expected: `main` clean、包含 origin tip；固定 stash 与 Local Skill 证据有效。

- [x] **Step 2: 先推送不可变 archive ref**

主 agent 在主工作树 cwd 运行：

```bash
git push origin archive/plan-runner-before-removal-20260805:archive/plan-runner-before-removal-20260805
```

Expected: 远端 archive 指向 `61ab540`；禁止 `--force`。

- [x] **Step 3: 推送前复验用户内容与关键门禁**

```bash
find skill-overrides/aliyun-beijing-server -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/aliyun-beijing-after.sha256
cmp /tmp/aliyun-beijing-before.sha256 /tmp/aliyun-beijing-after.sha256
git status --short --branch
npm run doctor
node --test test/plan-runner-removal.test.mjs
```

Expected: Local Skill 内容逐字节一致；Doctor/removal contract PASS；settings 仍安全保存在固定 stash commit。

- [x] **Step 4: 复原本地 settings 并验证**

```bash
git stash apply 183567f037a61b5fdcf78e93d27a9c8ebb2f0002
test "$(sha256sum pi/settings.json | awk '{print $1}')" = 7b9c3ace7929e9c3a3e13dfb024188f55a619089f002fa754083971e60559adf
git status --short --branch
```

Expected: 只显示 `M pi/settings.json`；stash 记录暂不 drop，保留恢复证据。

- [x] **Step 5: 非强制推送 main 并核对远端**

```bash
git push origin main
git fetch origin main
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
test "$(git rev-parse origin/archive/plan-runner-before-removal-20260805)" = 61ab540b4c454916af60c744893e20f1767dfc03
```

Expected: 两个远端 ref 精确；无 force push；本地主工作树仍只显示原有用户修改。

## Self-Review

- Spec coverage: archive、Plan production 删除、shared Broker 解耦、依赖安装改名、Doctor/Skill/规则、Goal/typed subagent 保留、远端分叉、用户配置保护、review、部署与 push 均有对应 Task。
- Placeholder scan: 无 `TBD`、`TODO`、`implement later`；动态 glob 仅用于明确命名空间的 tracked 删除，且有保留边界。
- Type consistency: `setup:subagent-runtime`、`buildSubagentRuntimeInstallCommand`、`installSubagentRuntimeDependencies`、`BrokerGrant.role="executor"` 与 Tasks 3–5 一致。
- 安全边界: 不调用 TokenRec Goal tools；不编辑 Goal Engine state；不覆盖主工作树 settings；不清理共享 runtime namespace；不 force push。
