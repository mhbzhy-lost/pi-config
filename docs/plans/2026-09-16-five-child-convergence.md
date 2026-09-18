# 五 Child 并发阻塞收敛实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [x]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 消除五 child `--roots 2 --subagents 5 --require-conflicts 4` 真实验收暴露的两个 P0 阻塞，使该验收稳定 exit 0 + acceptance receipt，并收敛到 T13 最终回归。

**架构：** 维持 child-owned integration（child 负责 rebase/解冲突/publish，coordinator 提供 durable FIFO queue + trusted binding + proof/release 门禁）。本轮先撤回未证明的生命周期实验恢复单 child 稳定基线，再以 TDD 实现 coordinator 侧的 trusted binding cache 与 admission-flight 去重以消除同步 Git 阻塞，并以一次只读探索确定 FIFO follower 续轮机制的可证明契约。续轮机制的实现、五 child 验收与 T13 列为本计划之后的 follow-up 计划，因其依赖探索决策产物。

**技术栈：** Node 22 原生 TypeScript type-stripping、`node:test`、jiti、`pi-subagents@0.62.0`（只读）、Pi 0.85.1（只读）、真实 git worktree。

> **状态（2026-09-18 簿记）：** T1–T5 全部完成；本计划的 blocker 探索结论促成了 follow-up 计划 `2026-09-16-durable-fifo-resumed-child.md`（已完整实现并通过真实验收：single `1/1/0` 与 five `2/5/4` 均 ACCEPTED）。

## 全局约束

- `pi-subagents@0.62.0` 不升级、不修改 upstream；runner 的 final-drain 语义视为不可变。
- 不修改、不提交 `pi/models.json`、`pi/settings.json`（per-machine）；不访问凭据。
- TDD：production 行为先 RED 后 GREEN；T13 前不运行全量 `npm test`。
- 不自动 commit；仅当用户明确授权时才按 `git-commit-convention` 提交。
- workspace ledger V2-only，不恢复 v1 读兼容。
- 不以模型文本/TUI 文案为权威状态；queue completed/receipt/proof/release 必须来自 trusted coordinator/ledger。
- 真实 acceptance 失败保留临时 repo/workspace/queue/诊断现场，不 force cleanup。
- 不使用 `git reset --hard`、`git clean -f`、覆盖性 checkout/restore/stash。
- child-owned integration：冲突由 child 解决；root/coordinator 不得代替 child publish 或解冲突。
- 不得伪造 watchdog/`agent_end`/`willRetry`；不得仅延长 final-drain 或 acceptance timeout 掩盖同步阻塞。
- macOS `/var` → `/private/var` canonical path，身份哈希一律基于 realpath。
- 凭据泄露不得自动轮换；记录影响并在任务结束时报告处理建议。

## DAG

```text
T1 (撤回实验, 恢复稳定基线) ──> T2 (trusted binding cache) ──> T5 (聚焦回归 + 单 child 复核)
T3 (admission-flight 去重)  ──────────────────────────────> T5
T4 (续轮可行性探索)         ──> (follow-up 计划: 续轮实现)
```

- T1 与 T3 互不依赖、WritePaths 不相交，可并行；T4 只写决策文档，可与三者并行。
- T2 依赖 T1：T2 step5 接入 `extensions/subagent-runtime.ts` 的 `broker.coordinatorRequest`，与 T1 step5 撤回同一函数；T2 step1–4 的 resolver/单测虽可独立产出，但接入步骤必须串行在 T1 之后，避免同函数冲突。
- T5 等待 T2 与 T3 完成（T2 已含 T1）。
- T4 只产出决策与契约，不阻塞 T5。
- 续轮实现、五 child 验收、T13 是 follow-up 计划，依赖 T4 决策产物，不在本计划内。

## Waves

- Wave 1：T1、T3、T4（T1 与 T3 WritePaths 不相交；T4 只写决策文档）
- Wave 1.5：T2（等待 T1：step5 接入与 T1 step5 同函数，串行避免冲突）
- Wave 2：T5（等待 T2+T3）

**关键路径：** T1 → T2 → T5；T3 与 T4 不在关键路径（T4 阻塞 follow-up）。

---

### Task 1：撤回生命周期实验与临时打点，恢复单 child 稳定基线

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`
- `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`
- `test/subagent-auto-integration-lifecycle.integration.mjs`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`
- Modify：`packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`（仅撤回 `coordinator-timing` stderr 块）
- Modify：`packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`（仅撤回 `git-inspection-timing` stderr 块）
- Modify：`test/subagent-auto-integration-lifecycle.integration.mjs`

**接口契约：**
- Consumes：`none`
- Produces：恢复后的 `createChildIntegrationLifecycle({ pi, coordinator, resolveBinding, key, managed })` 契约——`maxAdmissionPolls`/`pollDelayMs` 紧凑轮询，`agent_end` 同步驱动 `advance`，`schedule()` 为 durable unref 兜底，冲突走 `subagent-integration-conflict` followUp，`session_shutdown` 走 durable inspect。不含 `admissionWaitMs`/`prequeuedLiveness`/`rerunRequested`/`turn_end`/`trace`。

**验收标准：** 下列符号在生产代码与测试中清零：`admissionWaitMs`、`prequeuedLiveness`、`rerunRequested`、`admissionStartedAt`、`ADMISSION_PENDING`、`driveFromTerminalTurn`、`trace(`、`integration-lifecycle-trace`、`coordinator-timing`、`git-inspection-timing`；稳定测试集（见步骤 1 列表）全绿；typecheck 通过；单 child 真实验收可复核（在 T5 执行）。

- [x] **步骤 1：锁定稳定测试集为 RED 基线**

稳定测试为 `test/subagent-auto-integration-lifecycle.integration.mjs` 中下列用例：
- `awaited agent_end completes clean child and later agent_settled only records`
- `real conflict gets a bounded semantic continuation; next settled auto-continues`
- `duplicate settled is inert and a confirmed non-retryable failure preserves debt`
- `session shutdown leaves queued durable integration live for later completion`
- `shutdown with unavailable coordinator records explicit recovery debt`
- `retryable intermediate agent_end failure stays live and a later agent_end completes integration`
- `workspace not-ready does not consume terminal guard or block a later completed agent_end`

实验用例（`agent_end queues a liveness follow-up before slow coordinator prepare`、`prequeued liveness follow-up subsumes a later conflict result`、`a queued FIFO follower continues on bounded admission follow-ups until head`、`admission follow-ups stop once the admission wait budget is exhausted`）删除。

- [x] **步骤 2：运行稳定测试集确认当前实验代码下仍有 7/7**

运行：`node --test test/subagent-auto-integration-lifecycle.integration.mjs`

预期：当前实验代码下 11 用例通过；删除 4 个实验用例后应为 7。

- [x] **步骤 3：撤回 `child-integration-lifecycle.ts` 实验改动**

移除：`appendFileSync`/`mkdirSync`/`node:path`/`node:fs` 导入与 `trace` 函数；`admissionWaitMs` 选项与 `admissionStartedAt`/`rerunRequested` 字段；`ADMISSION_PENDING` 常量；`advance(binding, { prequeuedLiveness })` 第二参数与 `prequeuedLiveness`/`pending-covered-by-prequeued-followup`/`conflict-covered-by-prequeued-followup` 分支；`driveFromTerminalTurn` 与 `pi.on("turn_end", ...)` 注册；`agent_end` 中 `admissionWaitMs > 0` 预排分支，恢复为 `pi.on("agent_end", async () => { if (current()) await advance(await resolveBinding()); })`；`finally` 中 `rerunRequested` 重跑分支。保留：`maxAdmissionPolls`/`pollDelayMs` 紧凑轮询循环、`schedule(binding)`、冲突 `subagent-integration-conflict` followUp、`shutdown` durable inspect、`preserve`、`retryableFailure`。

- [x] **步骤 4：撤回 `child-extensions/integration-queue.ts` 两处 wiring**

将两处 `createChildIntegrationLifecycle({ ..., admissionWaitMs: 20 * 60 * 1000 })` 改回 `createChildIntegrationLifecycle({ pi, coordinator, resolveBinding: resolve, key, managed: true })`。

- [x] **步骤 5：撤回 `extensions/subagent-runtime.ts` 的 `coordinator-timing` stderr 块**

将 `broker.coordinatorRequest` 恢复为：

```ts
broker.coordinatorRequest = async (runId, operation, input) => {
  if (!COORDINATOR_OPERATIONS.includes(operation as any)) throw new Error("unsupported coordinator operation");
  const owned = await client.listOwned({ runId });
  if (!Array.isArray(owned) || owned.length !== 1) throw new Error("trusted run binding is unavailable");
  const entry = owned[0];
  const binding = { workspaceId: entry.workspaceId, leaseId: entry.leaseId, runId, ownerScope: { kind: "standalone-subagent", rootSessionId: broker.rootSessionId } };
  const method = operationMethods[operation as keyof typeof operationMethods];
  return method({ ...input, ...binding });
};
```

- [x] **步骤 6：撤回 `git-worktree.ts` 的 `git-inspection-timing` 打点**

将 `inspectManagedGitWorkspace` 恢复为无 `startedAt`/`identityAt`/`descendantAt`/`aheadAt`/`diffAt`/`statusAt`/`originAt` 计时与 `console.error(... git-inspection-timing ...)` 的原始实现（保留 canonical realpath 与其它既有稳定逻辑）。

- [x] **步骤 7：运行稳定测试集确认 GREEN**

运行：`node --test test/subagent-auto-integration-lifecycle.integration.mjs`

预期：7/7 PASS。

- [x] **步骤 8：运行相邻回归**

运行：
```
node --test test/subagent-auto-integration-recovery.integration.mjs
node --test test/subagent-auto-integration-real-git.integration.mjs
npm run typecheck:subagents-enhanced
git diff --check
```

预期：全 PASS、typecheck 无错、diff 无空白错误。

---

### Task 2：trusted run binding cache

**Deps：** `T1`（理由：T2 step5 接入 `extensions/subagent-runtime.ts` 的 `broker.coordinatorRequest`，与 T1 step5 撤回同一函数；T1 完成后才能在稳定形态上接入 resolver。T2 step1–4 的 resolver 实现与单测可提前产出，但 step5 必须串行在 T1 之后）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts`
- `test/run-binding-resolver.test.mjs`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`

**Resources：** `none`

**Files：**
- Create：`packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts`
- Create：`test/run-binding-resolver.test.mjs`
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`（`broker.coordinatorRequest` 内的 binding 解析替换为 resolver）

**接口契约：**
- Consumes：`client.listOwned({ runId }): Promise<{ workspaceId, leaseId, run }[]>`（coordinator-client 既有方法）。
- Produces：`createTrustedRunBindingResolver(client)` 返回 `{ resolve(runId): Promise<{ workspaceId, leaseId, runId, ownerScope }> }`；同一 `runId` 连续调用只调用一次 `client.listOwned`；解析失败（非唯一 record）不缓存；不同 `runId` 独立解析；`dispose()` 清空缓存。`ownerScope` 形态固定为 `{ kind: "standalone-subagent", rootSessionId }`，由调用方传入 `rootSessionId`。

**验收标准：** 同一 run 三次请求（prepare/inspect/advance）只触发一次 `listOwned`；失败不缓存；不同 run 各解析一次；resolver 接入后 `connectRuntimeCoordinator` 的 coordinator request 行为不变（binding 正确注入）；step5 必须在 T1 完成后执行（同函数串行）。

- [x] **步骤 1：编写失败测试**

`test/run-binding-resolver.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createTrustedRunBindingResolver } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts");

function fakeClient(records) {
  let calls = 0;
  return { calls: () => calls, async listOwned({ runId }) {
    calls++;
    return records[runId] ?? [];
  } };
}

test("caches a resolved binding per run across three operations", async () => {
  const client = fakeClient({ run1: [{ workspaceId: "ws1", leaseId: "l1", run: { runId: "run1" } }] });
  const r = createTrustedRunBindingResolver(client, { rootSessionId: "root" });
  const a = await r.resolve("run1"); const b = await r.resolve("run1"); const c = await r.resolve("run1");
  assert.deepEqual([a.workspaceId, a.leaseId, a.runId, a.ownerScope], ["ws1", "l1", "run1", { kind: "standalone-subagent", rootSessionId: "root" }]);
  assert.equal(client.calls(), 1);
});

test("does not cache a failed resolution", async () => {
  const client = fakeClient({});
  const r = createTrustedRunBindingResolver(client, { rootSessionId: "root" });
  await assert.rejects(() => r.resolve("missing"), /trusted run binding is unavailable/);
  await assert.rejects(() => r.resolve("missing"), /trusted run binding is unavailable/);
  assert.equal(client.calls(), 2);
});

test("different runs resolve independently", async () => {
  const client = fakeClient({ run1: [{ workspaceId: "ws1", leaseId: "l1", run: { runId: "run1" } }], run2: [{ workspaceId: "ws2", leaseId: "l2", run: { runId: "run2" } }] });
  const r = createTrustedRunBindingResolver(client, { rootSessionId: "root" });
  await r.resolve("run1"); const b = await r.resolve("run2");
  assert.equal(b.workspaceId, "ws2"); assert.equal(client.calls(), 2);
});
```

- [x] **步骤 2：运行确认 RED**

运行：`node --test test/run-binding-resolver.test.mjs`

预期：FAIL，错误为模块/导出不存在。

- [x] **步骤 3：实现 resolver**

`packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts`：

```ts
export interface TrustedRunBinding { workspaceId: string; leaseId: string; runId: string; ownerScope: { kind: "standalone-subagent"; rootSessionId: string } }
export interface TrustedRunBindingClient { listOwned(input: { runId: string }): Promise<{ workspaceId: string; leaseId: string; run: { runId: string } }[]> }
export function createTrustedRunBindingResolver(client: TrustedRunBindingClient, { rootSessionId }: { rootSessionId: string }) {
  const cache = new Map<string, TrustedRunBinding>();
  const resolve = async (runId: string): Promise<TrustedRunBinding> => {
    const cached = cache.get(runId); if (cached) return cached;
    const owned = await client.listOwned({ runId });
    if (!Array.isArray(owned) || owned.length !== 1) throw new Error("trusted run binding is unavailable");
    const entry = owned[0];
    const binding: TrustedRunBinding = { workspaceId: entry.workspaceId, leaseId: entry.leaseId, runId, ownerScope: { kind: "standalone-subagent", rootSessionId } };
    cache.set(runId, binding); return binding;
  };
  return Object.freeze({ resolve, dispose() { cache.clear(); } });
}
```

- [x] **步骤 4：运行确认 GREEN**

运行：`node --test test/run-binding-resolver.test.mjs`

预期：PASS。

- [x] **步骤 5：接入 `extensions/subagent-runtime.ts`**

在 `connectRuntimeCoordinator` 内创建 `const bindingResolver = createTrustedRunBindingResolver(client, { rootSessionId: broker.rootSessionId })`，`broker.coordinatorRequest` 改为 `const binding = await bindingResolver.resolve(runId); const method = operationMethods[operation]; return method({ ...input, ...binding });`；`close()` 中 `bindingResolver.dispose()`。

- [x] **步骤 6：运行接入回归**

运行：
```
node --test test/managed-workspace-coordinator.integration.mjs
node --test test/subagent-worktree-lifecycle.integration.mjs
npm run typecheck:subagents-enhanced
```

预期：PASS、typecheck 无错。

---

### Task 3：enqueue 去除同步 Git inspection，admission-flight 仅在 claimNext 执行且并发去重

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `test/managed-workspace-integration-queue.integration.mjs`

**Resources：** `none`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`（`enqueueIntegration` 不再调用 `integrationAdmissionFacts`；`claimNext` 的 admission 回调执行唯一一次 admission facts 并共享结果）
- Modify：`packages/pi-subagents-enhanced/src/workspace/service.ts`（新增 `admissionFactsForClaim` 与 `admissionProbe` 选项供 claim 路径复用与并发去重）
- Modify：`test/managed-workspace-integration-queue.integration.mjs`

**接口契约：**
- Consumes：`integrationQueue.enqueueIntegration`/`claimNext` 既有签名。
- Produces：`enqueueIntegration` 仅校验 trusted binding + workspace record 存在 + `git rev-parse HEAD`（单次 ~50ms）后写 queue item，不执行 `inspectManagedIntegrationAdmission`；`observedTargetHead` 设为 `null`（权威 target head 是 `admittedTargetHead`，claim 时才填入）；完整 admission facts 推迟到 `claimNext` 的 admission 回调，且对同一 `(workspaceId, authorizedWorkspaceHead, targetRef)` 的并发 claim 共享同一 inspection 结果；workspace HEAD、lease/revision 变化时结果失效；origin HEAD 漂移不由 claim 去重缓存覆盖，而由 `publishRebasedCandidate`→`prepareIntegrationIntent` 的 `targetHead` CAS 重新检查捕获。
- `createManagedWorkspaceService` 新增可选 `admissionProbe?: () => void`，`admissionFactsForClaim` 每次实际 `inspectManagedIntegrationAdmission` 前调用一次，供测试计数。

**验收标准：** dirty workspace 仍可 enqueue（state queued），但 claim 时抛 `MANAGED_WORKSPACE_INTEGRATE`；并发两次 `advanceAutoIntegration` 对同一 head 只触发一次 `inspectManagedIntegrationAdmission`；HEAD 变化后缓存失效；既有 `managed-workspace-integration-queue.integration.mjs` 全绿。

- [x] **步骤 1：编写失败测试**

在 `test/managed-workspace-integration-queue.integration.mjs` 新增。fixture 需支持 `admissionInspections()` 计数：通过 `fixture(t, { admissionProbe: true })` 在 `createManagedWorkspaceService({ ..., admissionProbe })` 注入计数器（probe 每次实际 inspection 前自增），并暴露 `f.admissionInspections()`。dirty 用例在 `allocateCandidate`（已提交）后追加未提交改动产生脏态：

```js
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("enqueue accepts a dirty workspace and admission facts run only at claim", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "dirty", "root-dirty", "dirty.txt");
  // allocateCandidate 已提交；追加未提交改动产生脏态
  await writeFile(join(candidate.path, "dirty.txt"), "uncommitted\n");
  const prepared = f.coordinator.internal.prepareAutoIntegration(candidate.binding);
  assert.equal(prepared.queueState, "queued");
  await assert.rejects(() => f.client.advanceAutoIntegration(candidate.binding), /workspace admission requires the authorized clean committed HEAD/);
});

test("concurrent advances for the same head share one admission inspection", async (t) => {
  const f = await fixture(t, { admissionProbe: true });
  const candidate = await allocateCandidate(f, "shared", "root-shared", "shared.txt");
  f.coordinator.internal.prepareAutoIntegration(candidate.binding);
  const before = f.admissionInspections();
  await Promise.all([f.client.advanceAutoIntegration(candidate.binding), f.client.advanceAutoIntegration(candidate.binding)]);
  assert.equal(f.admissionInspections() - before, 1);
});
```

- [x] **步骤 2：运行确认 RED**

运行：`node --test test/managed-workspace-integration-queue.integration.mjs`

预期：FAIL（dirty enqueue 当前抛 `MANAGED_WORKSPACE_INTEGRATE`；并发 inspection 当前为 2）。

- [x] **步骤 3：实现 enqueue 去重与 claim 共享**

`coordinator-server.ts` `enqueueIntegration`：移除 `workspaceService.integrationAdmissionFacts(...)` 调用，仅 `trustedWorkspace` + `git rev-parse HEAD` + 写 item；`observedTargetHead` 设为 `null`（claim 时由 `admissionFactsForClaim` 填入 `admittedTargetHead`）。`service.ts` 新增 `admissionFactsForClaim(input, binding)`：内部对同一 key 的并发调用返回同一 promise（`Map<key, Promise>` inflight 去重），key = `${workspaceId}:${authorizedWorkspaceHead}:${targetRef}:${revision}`，每次实际 `inspectManagedIntegrationAdmission` 前调用注入的 `admissionProbe`，结果缓存至该 key 任一字段变化；`createManagedWorkspaceService` 选项新增 `admissionProbe?: () => void`。origin HEAD 漂移不进 key，由 `publishRebasedCandidate` 的 `targetHead` CAS 重新检查捕获。

- [x] **步骤 4：运行确认 GREEN**

运行：`node --test test/managed-workspace-integration-queue.integration.mjs`

预期：PASS。

- [x] **步骤 5：运行回归**

运行：
```
node --test test/managed-workspace-service.integration.mjs
node --test test/subagent-auto-integration-real-git.integration.mjs
node --test test/managed-workspace-terminal-proof-handoff.integration.mjs
npm run typecheck:subagents-enhanced
```

预期：PASS、typecheck 无错。

---

### Task 4：FIFO follower 续轮可行性探索

**Deps：** `none`（与 T1/T2/T3 并行）

**WritePaths：**
- `docs/decisions/2026-09-16-fifo-follower-liveness.md`

**Resources：** `none`；禁止运行真实 LLM probe

**Files：**
- Create：`docs/decisions/2026-09-16-fifo-follower-liveness.md`

**接口契约：**
- Consumes：`pi-subagents@0.62.0` subagent-runner（只读）、Pi 0.85.1 `core/agent-session.js`（只读）、本计划 bug 记录。
- Produces：一份决策文档，从下列候选中选出**唯一**可证明机制，给出接口契约、共享样例与不可证明项的明确否决理由：
  1. child watchdog keepalive：能否在不全局启用 watchdog review 前提下，让 managed coding child 的 integration extension 发出被 runner 接受的 `subagent.watchdog.status` 事件（`settling`/`idle`）以取消 final drain；需说明如何注入 `PI_SUBAGENT_WATCHDOG_CHILD_CONFIG` 而不触发 upstream `register-child` 的模型 review 副作用，或证明该副作用可接受。
  2. Pi 续轮 API：是否存在可 await 且被 runner 识别为 `willRetry` 或 active 的公开 Extension API（非 fire-and-forget `sendMessage`）；若不存在，明确否决。
  3. durable coordinator recovery + resumed child：follower 退出后，coordinator 保留 queue item，由 root broker recovery event 触发 resumed/retried child run 继续 admission 与冲突续轮；需说明 acceptance harness 如何驱动 resume，以及冲突仍由 child 解决。
  4. 其它可证明机制。

**验收标准：** 文档含：选定的唯一机制；该机制被 runner 识别的可证明证据（引用 upstream 代码行号与事件契约）；否决其余候选的明确理由；下游 follow-up 计划需要的接口契约（函数签名或事件 schema）；任一“无法同时满足 trusted binding/child 解冲突/proof 门禁”的冲突点原样记录，不猜测。

- [x] **步骤 1：只读核对 runner final-drain 与 watchdog 接受条件**

阅读 `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/subagent-runner.ts`（`startFinalDrain`、`childWatchdogIsActive`、`acceptChildWatchdogEvent`、`projectChildLifecycle`）与 `watchdog/child-status.ts`、`watchdog/register-child.ts`，记录候选 1 的可注入性与副作用。

- [x] **步骤 2：只读核对 Pi 0.85.1 续轮 API**

阅读 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`（`sendCustomMessage`、`_willRetryAfterAgentEnd`、`_handlePostAgentRun`、`hasQueuedMessages`）与 `core/extensions/types.d.ts`，记录候选 2 的可 await 性与 willRetry 语义。

- [x] **步骤 3：核对 T11 recovery 现状与 acceptance harness 驱动点**

阅读 `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`（`reconcileIntegrations`、recovery event sink）、`scripts/probes/repository-merge-queue-acceptance.ts`（barrier/release/audit），记录候选 3 的 harness 驱动点与冲突仍由 child 解决的保证。

- [x] **步骤 4：写出决策文档**

`docs/decisions/2026-09-16-fifo-follower-liveness.md`，按验收标准与接口契约产出；若所有候选均不可证明，明确记录为 blocker 并列出需要用户决策的冲突点。

- [x] **步骤 5：自检**

确认文档不含 `TBD`/`TODO`/“以后实现”；每个候选都有明确采纳或否决；选定机制有 upstream 行号证据。

---

### Task 5：聚焦回归与单 child 真实验收复核

**Deps：** `T1`、`T2`、`T3`

**WritePaths：** `none`（只读验收，不写 production）

**Resources：** 真实 Pi 二进制 `/opt/homebrew/bin/pi`；单 child probe 一次

**Files：** `none`

**接口契约：**
- Consumes：T1 恢复的稳定 lifecycle、T2 的 binding resolver、T3 的 enqueue/admission 去重。
- Produces：聚焦测试全绿 + 单 child 真实验收再次 `status: accepted`。

**验收标准：** 下列聚焦测试全绿、typecheck 通过、`git diff --check` 通过；单 child probe `--roots 1 --subagents 1 --require-conflicts 0` exit 0 且 receipt `status: accepted`、queue completed、proof observed、workspace released、audit settled。

- [x] **步骤 1：聚焦回归**

运行：
```
node --test test/subagent-auto-integration-lifecycle.integration.mjs
node --test test/subagent-auto-integration-recovery.integration.mjs
node --test test/subagent-auto-integration-real-git.integration.mjs
node --test test/managed-workspace-integration-queue.integration.mjs
node --test test/managed-workspace-service.integration.mjs
node --test test/managed-workspace-repository-identity.integration.mjs
node --test test/repository-merge-queue-acceptance-probe.test.mjs
node --test test/run-binding-resolver.test.mjs
npm run typecheck:subagents-enhanced
git diff --check
```

预期：全 PASS、typecheck 无错、diff 无空白错误。

- [x] **步骤 2：单 child 真实验收复核**

运行：
```
PI_REAL_BIN=/opt/homebrew/bin/pi PI_ACCEPTANCE_MODEL=zai-coding-cn/glm-5.3 \
ACCEPTANCE_OVERALL_TIMEOUT_MS=1200000 timeout 1300s \
node scripts/probes/repository-merge-queue-acceptance.ts --roots 1 --subagents 1 --require-conflicts 0 --model zai-coding-cn/glm-5.3
```

预期：stdout 输出 receipt 路径；`status: accepted`；coordinator observed/debts 空；queue 1 completed；workspace released；proof observed conflict=false。

- [x] **步骤 3：记录结果并向用户交接**

报告聚焦回归与单 child receipt 结果；明确五 child 验收与 T13 依赖 T4 决策，需 follow-up 计划；不自行开始续轮实现。

---

## 计划自检

1. **规格覆盖：** reviewer 的 A–F 均有任务覆盖：A 根因→bug 记录（既有）+ T4；B 撤回→T1，保留→T1 注明；C child-owned→T1/T3 维持；D 最小 TDD→T1/T2/T3/T5；E 禁止→全局约束；F 证据不足→T4 产出 blocker 文档。
2. **占位扫描：** 无 TBD/TODO；T4 的候选枚举为决策项而非占位。
3. **类型一致性：** `createTrustedRunBindingResolver`/`TrustedRunBinding` 在 T2 定义；`admissionFactsForClaim`/`admissionProbe` 在 T3 定义；两者均被 T5 回归引用。
4. **DAG 审核：** T1 与 T3/TT4 WritePaths 不重叠、可并行；T2 依赖 T1（step5 与 T1 step5 同函数 `subagent-runtime.ts`，串行避免冲突）；T5 依赖 T2+T3；续轮实现属 follow-up，不引入未定义边。
