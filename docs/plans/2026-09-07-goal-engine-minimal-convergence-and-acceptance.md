# Goal Engine 最小收敛与验收实现计划

> **状态：已被替代。** 自 `2026-09-08`、基线 `24bce3844d6eb7a1df48dac615d9b010988b29e7` 起，本计划由 [`2026-09-08-goal-engine-final-convergence-and-r13.md`](./2026-09-08-goal-engine-final-convergence-and-r13.md) 替代。本文仅保留历史决策和证据，不再作为执行入口；既有测试结果不得自动结转为当前验收。

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 冻结 Goal generation 扩张，恢复 `planned.v1` / `goal-runtime.v1` 从创建、Host 授权、执行证明、settle、受管处置到 accept/finalize 的唯一公共闭环，并以可信静态检查、分层回归和两轮 fresh Host canary 完成 R13 验收。

**架构：** Goal ledger 继续以 v1 作为唯一新写 generation，历史 v2 仅保留 exact replay 并对 mutation fail closed；v1 Goal authority 在 composition boundary 适配到现有 Host-owned `RunAuthorization`，不得回退到按 agent 名称授权。Root Broker 只暴露一个 canonical async terminal-proof reader，managed workspace service 保持资源事实权威，Goal 只持久化完成业务闭环所需的 intent/receipt；生产终审通过 Pi 公开 SDK 能力从 `pi/extensions/goal-engine.ts` 注入。

**技术栈：** Node.js `>=22.19.0`、原生 TypeScript type stripping、TypeScript 7、Node test runner、Pi Extension API、`@earendil-works/pi-coding-agent` SDK、`pi-subagents-enhanced`、JSONL event ledger、managed workspace service。

## 全局约束

- 在 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R0–R13 全部完成并通过 R13 验收前，禁止使用 Goal Engine 执行、编排或验收本计划；执行只能由主 agent 按本计划 DAG 编排 subagent executor。
- production 代码、配置或 Skill 行为修改必须执行 TDD：先建立中文问题记录和精确 RED，观察正确失败，再写最小 GREEN；测试只验证行为，不镜像配置字面值。
- Root 主 agent 不直接编辑 production 或测试代码；仅维护计划、编排、证据核准和用户决策。
- 最低 Node 版本固定为 `>=22.19.0`；Node 原生 production/CLI 使用 `.ts`；type stripping 不等于类型检查。
- `scripts/` 只放 CLI、初始化脚本和诊断探针；不得新增或扩大 `scripts/lib/`，production 不得 import `scripts/**`。
- `pi/extensions/` 只做 Host API 绑定、依赖注入和资源注册；实现归 `src/goal-engine/` 或 `packages/pi-subagents-enhanced/src/`。
- 跨 feature 依赖只通过公开入口或 package `exports`；不得深引其他 feature 内部文件，也不得为少量复用新建通用 package。
- TUI 精简只能发生在 renderer；不得改写 agent 实际消息、tool result、event payload 或 session 内容。
- 对任何异常，先记录实际入口、权威身份、事件/资源顺序、首个偏离点并分类为 production 可达、测试制造或来源未证实；来源未证实时 fail closed，禁止增加预防性 production fallback。
- terminal proof 只能来自已授权、已绑定 run 的官方 `process-terminal.json` 或其已验证内存事件；`status.json`、日志、caller evidence 和模型自报不能升级为 proof。
- 禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`、强制删除、reset、restore、stash 和宽泛 stage；workspace 只走 typed managed lifecycle。
- 不执行 `git add` 或 commit，除非用户之后另行明确授权。
- `pi/settings.json.enabledModels` 是 per-machine 配置，禁止提交；`pi/models.json` 的本机 provider/model 定义禁止提交。
- 当前工作区已有 staged/untracked 变更；每项任务必须以进入任务时的 HEAD、index、worktree 和 untracked inventory 为基线，不能声称 clean baseline，也不能覆盖其他任务修改。
- 停止新增 Goal generation、事件、projection field、生命周期、自动 continuation、proof fallback 和 workspace/Git 私有实现；本计划只允许完成已批准语义所必需的有限协议例外。

## Definition of Done

1. 新 Goal 只写 `planned.v1` 或 `goal-runtime.v1`；public v2 init/mutation 在 append 和资源副作用前 fail closed，历史 v2 exact replay 保持通过。
2. `goal_init → goal_dispatch → Host RunAuthorization → workspace/run binding → official proof → goal_settle → managed disposition receipt → goal_accept → goal_finalize` 公共链闭合。
3. 匹配 Goal 却无法生成 Goal authorization 时明确拒绝，不降级为 standalone；generic 或同名 profile 不能获得 Goal/acceptance capability。
4. Root Broker 只有一个 canonical terminal-proof envelope 和 async reader；内存事件丢失可从安全官方 sidecar 恢复，所有非权威来源继续拒绝。
5. production entry 注入真实 final-review provider；测试不得通过调用者 stub 伪造 production readiness。
6. Goal Engine、生产入口与增强 package 均被静态检查覆盖；focused、integration、Doctor、package verify 和全量测试有当前基线证据。
7. 两轮 fresh Host canary 连续通过，覆盖正常完成、失败/修订/恢复、八工具和资源债务审计；仍处于 Manual Preview，未自动 cutover。

## DAG

```text
T0（冻结 generation 与基线）
 ├──> T1（v1 Goal → Host RunAuthorization）──┐
 ├──> T2（canonical terminal proof）─────────┼──> T4（v1 async settle）──> T5（managed disposition）──┐
 └──> T3（终审 provider 契约调查）──> T6（生产终审接线）──────────────────────────────────────────┤
                                                                                                      ├──> T7（静态检查与 Doctor）
T1 + T2 + T4 + T5 ────────────────────────────────────────────────────────────────────────────────────┘
T7 ──> T8（条件化删减与全量回归）──> T9（R13 与两轮 fresh Host 验收）
```

## Waves

- Wave 0：T0。
- Wave 1：T1、T2、T3；T1/T2 对 `root-broker-registry.ts` 有写冲突，必须使用隔离 workspace，先完成者合入后另一任务基于新 HEAD 重放 RED，不得并发改同一 checkout。
- Wave 2：T4、T6；二者无直接依赖且 WritePaths 可隔离。
- Wave 3：T5。
- Wave 4：T7。
- Wave 5：T8。
- Wave 6：T9。

**关键路径：** `T0 → T1/T2 → T4 → T5 → T7 → T8 → T9`。终审路径 `T0 → T3 → T6 → T7` 并行推进，但 T3 若证明没有受支持的生产模型入口，T6 与最终验收必须标记 BLOCKED，不得伪造 provider。

---

### Task 0：冻结 generation writer 并记录半迁移 provenance

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-07-goal-generation-half-migration.md`
- `src/goal-engine/events.ts`
- `src/goal-engine/extension.ts`
- `src/goal-engine/obligation-contract.ts`
- `test/goal-engine-generation-capabilities.integration.mjs`
- `test/goal-engine-generation-compatibility.integration.mjs`
- `test/goal-engine-obligation-contract.integration.mjs`

**Resources：** Goal state inventory 只读访问；不得清理或修改 `var/goals`。

**Files：**
- Create：`docs/bugs/2026-09-07-goal-generation-half-migration.md`
- Modify：`src/goal-engine/events.ts`、`src/goal-engine/extension.ts`、`src/goal-engine/obligation-contract.ts`
- Test：上述三个 generation/contract integration tests

**接口契约：**
- Consumes：`schemaVersionForMutation()`、`normalizeRuntimeGoalInit()`、`generationCapabilities()` 与现有 v2 decoder/replay fixtures。
- Produces：唯一 writer 规则——fresh writer 只产生 `planned.v1/goal-runtime.v1`；v2 codec 可 replay，但 public init、mutation、dispatch 和资源副作用返回稳定的 `GOAL_GENERATION_READ_ONLY`。

**验收标准：** v2 拒绝发生在 ledger append、workspace allocation 和 Broker registration 前；历史 v2 fixture exact replay 不变；问题记录包含 public 入口、身份、事件顺序、production/fixture inventory 与首个偏离点。

- [ ] **步骤 1：建立问题记录与 state provenance 表**

在问题记录中列出 `goal_init → schemaVersionForMutation → prepareRunBindingTicket` 调用链，并将当前 state 分为 production registry 引用、测试临时 root 和来源未证实三类；不得读取凭据或把测试 fixture 当 production state。

- [ ] **步骤 2：编写 writer-prohibition RED**

```js
await assert.rejects(
  () => callGoalInit({ execution: { schema: "goal-runtime.v2" }, tasks: [] }),
  /GOAL_GENERATION_READ_ONLY/,
);
assert.equal(readLedgerEvents().length, 0);
assert.equal(observedWorkspaceAllocations(), 0);
```

同时断言 fresh planned init 的 projection 是 `planned.v1`，且已有 v2 golden log 可 replay 但 mutation 被拒绝。

- [ ] **步骤 3：运行测试确认 RED**

运行：

```bash
node --test test/goal-engine-generation-capabilities.integration.mjs test/goal-engine-generation-compatibility.integration.mjs test/goal-engine-obligation-contract.integration.mjs
```

预期：v2 public writer 仍被接受或进入副作用，新增断言 FAIL；既有 replay 测试保持 PASS。

- [ ] **步骤 4：实现最小 generation gate**

在现有 init/mutation preflight 集中检查 generation；保留 decoder 与 `applyEvent` replay，不删除历史字段，不把 v2 回写为 v1，也不新增第三种 generation。

- [ ] **步骤 5：验证 GREEN 与差异边界**

重跑步骤 3，并运行 `git diff --check`。预期全部 PASS，diff 只包含本任务 WritePaths。

---

### Task 1：将 v1 Goal authority 适配到 Host-owned RunAuthorization

**Deps：** `T0`（理由：消费 T0 固定的唯一 Goal writer 与 v2 read-only gate）。

**WritePaths：**
- `src/goal-engine/extension.ts`
- `src/goal-engine/legacy-executor-compat.ts`
- `src/goal-engine/run-binding.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `test/goal-engine-executor-binding.integration.mjs`
- `test/goal-engine-extension.integration.mjs`
- `test/subagent-run-authorization.test.mjs`
- `test/subagent-broker-capabilities.integration.mjs`

**Resources：** managed workspace service；同一 checkout 不得与 T2 同时写 `root-broker-registry.ts`。

**Files：** Modify/Test 均为上述路径；不得新增 package 或恢复 legacy grant writer。

**接口契约：**
- Consumes：T0 的 v1-only writer；现有 `RunAuthorization`、`createRunAuthorization()`、`GoalRunAuthority`、`runCoordinator.prepareSpawn/bindSpawn`。
- Produces：`prepareRunBindingTicket()` 能从 v1 Goal 的 task/attempt/contract/workspace/session 权威事实生成 Host 可验证 ticket；ledger 仍写 v1 `task.executor_bound/executorBinding`，Broker 仍只注册 Host-owned authorization schema。

**验收标准：** custom profile 名称不影响授权；generic run、同名 executor 和 started event 都不能提权；任一 identity/revision/hash 漂移在 append 前拒绝；匹配 Goal 但 ticket 缺失时不得 fallback standalone。

- [ ] **步骤 1：编写 public dispatch RED**

```js
const goal = await publicGoalInit(v1GoalInput);
const dispatched = await publicGoalDispatch(goal.goalId, goal.actionToken);
assert.equal(dispatched.authorization.capabilities.includes("acceptance.submit"), true);
assert.equal(loadGoal(goal.goalId).tasks[0].executorBinding.state, "strict");
```

另加负例：ticket 缺失、task/attempt/contract/workspace/session 漂移、generic 同名 profile，均拒绝且没有 workspace/Broker/ledger 副作用。

- [ ] **步骤 2：运行 RED**

运行：

```bash
node --test test/subagent-run-authorization.test.mjs test/subagent-broker-capabilities.integration.mjs test/goal-engine-executor-binding.integration.mjs test/goal-engine-extension.integration.mjs
```

预期：默认 v1 无 ticket 而走 standalone 的断言 FAIL。

- [ ] **步骤 3：实现 v1 authority bridge**

扩展现有 `legacy-executor-compat.ts` 与 `prepareRunBindingTicket()`，只把 v1 Goal ledger 权威字段映射为现有 Host ticket；禁止检查 `agent === "executor"` 作为 capability 来源，禁止写回 v2 Goal event。

- [ ] **步骤 4：实现 fail-closed dispatch guard**

当 dispatch contract 明确属于 Goal task，而 ticket 无法生成或 Host 验证失败时，返回稳定错误并停止；仅真正 standalone coding 请求允许 standalone authorization。

- [ ] **步骤 5：验证 GREEN**

重跑步骤 2、`npm --prefix packages/pi-subagents-enhanced run verify:package` 和 `git diff --check`，预期全部 PASS。

---

### Task 2：统一 Root Broker canonical terminal-proof reader

**Deps：** `T0`（理由：proof reader 只需知道新写 Goal generation 已冻结，不依赖 v1 dispatch bridge 的实现）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/legacy-executor-compat.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `test/root-subagent-broker.test.mjs`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/root-subagent-broker-r10b-suspension.integration.mjs`

**Resources：** 临时 async run 目录；不得读取真实凭据。与 T1 的 registry 写入通过隔离 workspace 和顺序集成解决。

**Files：** Modify/Test 均为上述路径。

**接口契约：**
- Consumes：upstream 原生 `process-terminal.json` exact shape、已授权 owned run、Goal authority sidecar 与 `parseProcessTerminal()`。
- Produces：一个 canonical async inspector，返回单一 exact envelope：run identity、ownership/authorization 状态、terminal conflict 和由 runner/writer exit facts机械派生的 outcome；legacy v1 adapter 只在 registry 边界转换。

**验收标准：** 普通非 symlink、`nlink=1`、平台支持时 `uid===process.getuid()`、且 mode 为 `0600` 或 `0644` 的官方文件可读取；`0660/0666`、owner mismatch、foreign runId、non-observed、malformed、conflict、facade-only 或未绑定 run 拒绝。`status.json`、`status.processTerminal`、日志和 caller evidence 永不生成 proof。

- [ ] **步骤 1：捕获真实 writer fixture**

使用 upstream `writeAtomicJson`/process-terminal writer 在临时目录生成 fixture，记录字段和实际 mode；测试不得手写不存在于 writer 的 session/path/agent/pid 字段。

- [ ] **步骤 2：编写 canonical reader RED**

```js
const proof = await broker.inspectExecutionProofForSettlement(runId);
assert.equal(proof.terminal.outcome, "succeeded");
assert.equal(proof.authorization.state, "verified");
assert.deepEqual(Object.keys(proof).sort(), canonicalEnvelopeKeys);
```

为 `0600/0644`、`0660/0666`、owner mismatch（平台支持时）、symlink、hardlink、facade-only、status-only 和 conflict 分别建立行为断言。

- [ ] **步骤 3：运行 RED**

运行：

```bash
node --test test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/root-subagent-broker-r10b-suspension.integration.mjs
```

预期：当前 shape、0644、status fallback 或 facade identity 断言至少一项 FAIL，且失败原因与 reader 合同不一致相符。

- [ ] **步骤 4：实现单一 reader 与 envelope**

合并 `inspectExecutionProof`、`inspectExecutorProofAsync`、`executorProofSnapshot`、`recoverExactTerminalProof` 和 `pollTerminalArtifact` 的权威读取规则；stop/suspension/settlement 复用同一 parser 与身份检查。不得向原始 exact terminal proof 偷加字段；outcome 写在 canonical envelope。

- [ ] **步骤 5：移除 status authority fallback 并验证 GREEN**

删除从 `status.processTerminal` 调用 `acceptTerminalProof` 的路径；重跑步骤 3、package verify 与 `git diff --check`，预期全部 PASS。

---

### Task 3：确定 production final-review provider 的公开 SDK 契约

**Deps：** `T0`（理由：最终审查只面向固定的 v1 finalization manifest）。

**WritePaths：**
- `docs/investigations/2026-09-07-goal-final-review-production-provider.md`
- `test/goal-engine-final-review.integration.mjs`

**Resources：** Pi SDK 文档与本机模型 catalog 的非敏感 metadata；不得读取或输出 auth/key。

**Files：**
- Create：`docs/investigations/2026-09-07-goal-final-review-production-provider.md`
- Modify：`test/goal-engine-final-review.integration.mjs`

**接口契约：**
- Consumes：`runRecoverableFinalReview()` 当前 provider 调用、`FinalizationManifest`、Pi 公共 `ModelRuntime`、`createAgentSession()`、`SessionManager.inMemory()`。
- Produces：冻结的 `ProductionFinalReviewProvider` 契约，输入至少包含 immutable manifest、derived review/idempotency identity、user approval，输出 exact `{ severity, reportRef }`；调查文档明确 model resolution、timeout/abort、无工具 session、结构化输出验证、report 内容持久化位置、writer-lock 边界与失败恢复。

**验收标准：** 只能选择 Pi package exports 中的公开 API；不得 deep import、shell 调 `pi auth`、读取凭据或复用测试 stub。若公共 API 无法满足要求，文档必须给出可复现证据并将 T6/T9 标记 BLOCKED，不得私造 provider。

- [ ] **步骤 1：建立 provider 输入不足 RED**

```js
await runRecoverableFinalReview({ manifest, approval, reviewStore, provider: async input => {
  assert.equal(input.manifest.manifestHash, manifest.manifestHash);
  assert.equal(input.approval.entryId, approval.entryId);
  assert.equal(input.writerLockHeld, false);
  return validReviewResult;
}});
```

预期当前 provider 只收到 review identity，关于 manifest/approval 的断言 FAIL。

- [ ] **步骤 2：核对公开 SDK 并写决策记录**

完整核对 SDK 的 `ModelRuntime`、`createAgentSession`、模型选择、abort、in-memory session 和无工具配置；记录 API export 与版本证据，不执行凭据探测。

- [ ] **步骤 3：冻结 provider contract 测试**

把 provider invocation 的 exact keys、manifest hash、approval identity、`writerLockHeld:false` 和 fail-closed malformed output 写成契约测试；本任务不实现网络 provider。

- [ ] **步骤 4：运行契约 RED 并保存输出**

运行：`node --test test/goal-engine-final-review.integration.mjs`

预期：新增 production contract 断言 FAIL；既有 intent/result recovery 测试保持 PASS。

- [ ] **步骤 5：完成调查出口检查**

文档必须明确给出“公开 SDK 路径可实现”或“公开 SDK 缺失导致 BLOCKED”之一，以及 T6 可直接消费的函数签名和依赖；运行 `git diff --check`。

---

### Task 4：接通 v1 settle 的 persisted-proof 异步恢复

**Deps：** `T1`（理由：需要 v1 strict executor binding）、`T2`（理由：消费 canonical async proof envelope）。

**WritePaths：**
- `src/goal-engine/extension.ts`
- `src/goal-engine/events.ts`
- `src/goal-engine/legacy-executor-compat.ts`
- `test/goal-engine-executor-binding.integration.mjs`
- `test/goal-engine-settlement-evidence.integration.mjs`
- `test/goal-engine-extension.integration.mjs`

**Resources：** 临时 Goal state 与官方 writer fixture。

**Files：** Modify/Test 均为上述路径。

**接口契约：**
- Consumes：T1 的 v1 binding 与 T2 canonical inspector。
- Produces：`goal_settle` 唯一 await 的 proof inspector；registry envelope 经 `executionProofForLegacyTask()` 归一化成 reducer 接受的 v1 task proof。

**验收标准：** 内存 terminal event 缺失但安全 official sidecar 已落盘时 settle 成功；缺失、unsafe、malformed、foreign、pending、conflict 继续返回 `EXECUTOR_TERMINAL_PROOF_MISSING` 或现有严格冲突错误；双路径 evidence、workspace identity、observed 与 outcome 校验不放宽。

- [ ] **步骤 1：复跑 09-02 production RED**

用真实 writer fixture复现“事件丢失、sidecar observed、settle missing”，记录失败发生在同步 inspector，不接受 fixture schema 错误作为 RED。

- [ ] **步骤 2：增加 v1 settle RED**

```js
const settled = await goalSettleWithPersistedOfficialProof({ memoryProof: null, mode: 0o644 });
assert.equal(settled.task.status, "succeeded");
assert.equal(settled.task.executorProof.runId, boundRunId);
```

同时覆盖 conflict/foreign/pending/status-only 负例。

- [ ] **步骤 3：运行 RED**

运行：

```bash
node --test test/goal-engine-executor-binding.integration.mjs test/goal-engine-settlement-evidence.integration.mjs test/goal-engine-extension.integration.mjs
```

预期：persisted official proof 用例 FAIL，严格负例保持 PASS。

- [ ] **步骤 4：最小接线**

让 v1 settle 真正调用并 await T2 inspector，修正 `executorProof/executionHead` 命名断点；删除未使用 inspector option 或把它变为唯一注入点，不保留同步/异步平行 settlement 路径。

- [ ] **步骤 5：验证 GREEN**

重跑步骤 3、Root Broker focused suite 与 `git diff --check`，预期全部 PASS。

---

### Task 5：闭合 v1 managed disposition 公共链

**Deps：** `T4`（理由：只有合法 settled v1 task 才能进入受管处置）。

**WritePaths：**
- `src/goal-engine/events.ts`
- `src/goal-engine/extension.ts`
- `src/goal-engine/graph.ts`
- `src/goal-engine/managed-workspace.ts`
- `test/goal-engine-managed-disposition.integration.mjs`
- `test/goal-engine-managed-workspace.test.mjs`
- `test/helpers/goal-workspace-service-fixture.mjs`

**Resources：** managed workspace service，处置调用串行；禁止 raw worktree 命令。

**Files：** Modify/Test 均为上述路径。

**接口契约：**
- Consumes：T4 settled task、现有 workspace service `issueDisposition/dispose` 与 public receipt。
- Produces：v1 exact `managedWorkspaceDispositionIntent/Receipt` 闭环；service 是资源事实 authority，Goal receipt 只表达 task/attempt/revision/workspace/lease 与 terminal disposition 的业务事实。

**验收标准：** public `goal_integrate` 执行 intent→service→receipt，`goal_accept` 只接受已 released integration；service 已 terminal 而 Goal append 失败时重试只补 receipt、不重复 disposition；preserve→explicit release 保持 preserve 语义。

- [ ] **步骤 1：确认协议例外边界**

在现有 09-05 bug 记录中核对新增两个事件是修复已证实 public gap 的最小例外；不得新增第三个状态或复制 service ledger。

- [ ] **步骤 2：编写完整 public-chain RED**

```js
await goalIntegrate(goalId, taskId, token);
const projection = loadGoal(goalId);
assert.equal(projection.tasks[taskId].managedDisposition.receipt.disposition, "integrate");
assert.equal(projection.tasks[taskId].managedDisposition.receipt.released, true);
await assert.doesNotReject(() => goalAccept(goalId, taskId, nextToken));
```

增加 append-failure retry、identity/hash/revision 漂移、无 receipt accept、preserve release 负例。

- [ ] **步骤 3：运行 RED**

运行：

```bash
node --test test/goal-engine-managed-disposition.integration.mjs test/goal-engine-managed-workspace.test.mjs test/subagent-managed-worktree.integration.mjs
```

预期：现有 3 个 reducer 测试可 PASS，但 public service/receipt/accept 链新增测试 FAIL。

- [ ] **步骤 4：实现最小 v1 闭环**

统一 proof 字段读取到 v1 `executorBinding/lastExecutorProof`，在 service terminal 后持久化 exact receipt；重试先 inspect service 状态再决定只补 receipt。不得恢复 legacy Git/leasePath fallback，也不得为 v2 增加 writer。

- [ ] **步骤 5：验证 GREEN**

重跑步骤 3、T4 suite 和 `git diff --check`，预期全部 PASS。

---

### Task 6：实现并注入 production final-review provider

**Deps：** `T3`（理由：消费已冻结的公开 SDK、provider 输入输出和持久化契约）。

**WritePaths：**
- `src/goal-engine/final-review.ts`
- `src/goal-engine/production-final-review-provider.ts`
- `src/goal-engine/extension.ts`
- `pi/extensions/goal-engine.ts`
- `test/goal-engine-final-review.integration.mjs`
- `test/goal-engine-finalize-extension.integration.mjs`
- `test/goal-engine-settings-gate.integration.mjs`
- `test/goal-runtime-real-canary.integration.mjs`

**Resources：** provider API；单并发，固定 timeout；不得输出或读取凭据。

**Files：**
- Create：`src/goal-engine/production-final-review-provider.ts`
- Modify：其余上述路径

**接口契约：**
- Consumes：T3 的 `ProductionFinalReviewProvider` 决策、`ModelRuntime`、`createAgentSession()`、`SessionManager.inMemory()` 与 immutable finalization manifest。
- Produces：`createProductionFinalReviewProvider(options)`，由 `pi/extensions/goal-engine.ts` composition root 创建并传给 `createGoalEngineExtension()`；provider 使用无工具、无持久会话的模型调用，返回 exact severity/report reference，失败可由现有 review store 重试。

**验收标准：** provider 在 writer lock 外调用；timeout/abort/malformed model output fail closed；配置或模型不可用时不签 finalize offer、不伪造结果；真实 production entry 测试不得手动传成功 stub。

- [ ] **步骤 1：复跑 T3 RED**

运行：`node --test test/goal-engine-final-review.integration.mjs test/goal-engine-finalize-extension.integration.mjs`

预期：provider 输入与 production composition root 断言 FAIL。

- [ ] **步骤 2：扩展 recoverable provider 输入**

将 immutable manifest、approval 与 derived identity 一并传给 provider；保持 review idempotency 和 exact result validation，不把模型文本直接当 ledger event。

- [ ] **步骤 3：实现 SDK adapter**

按 T3 决策使用公开 SDK 创建 in-memory、无工具 session，设置 deadline/abort，要求结构化 `{severity, report}` 输出；report 内容按 T3 确定的 feature-owned store 落盘并以 SHA-256 形成 `reportRef`，不得写入 session 或日志作为 authority。

- [ ] **步骤 4：在 production entry 注入**

仅在 `pi/extensions/goal-engine.ts` 创建 provider；测试 loader 必须验证传入的是 production adapter。缺配置时返回明确 readiness blocker，而非测试默认成功。

- [ ] **步骤 5：验证 GREEN**

运行：

```bash
node --test test/goal-engine-final-review.integration.mjs test/goal-engine-finalization.integration.mjs test/goal-engine-finalize-extension.integration.mjs test/goal-engine-settings-gate.integration.mjs
```

预期全部 PASS；随后运行 `git diff --check`。

---

### Task 7：补齐静态检查、Doctor 与可信测试入口

**Deps：** `T1`、`T2`、`T4`、`T5`、`T6`（理由：只在接口稳定后固化类型检查与 readiness assertions）。

**WritePaths：**
- `tsconfig.json`
- `package.json`
- `packages/pi-subagents-enhanced/tsconfig.json`
- `packages/pi-subagents-enhanced/package.json`
- `scripts/doctor.ts`
- `test/doctor.test.mjs`
- `test/goal-engine-settings-gate.integration.mjs`
- `test/pi-runtime.integration.mjs`

**Resources：** TypeScript compiler；Doctor 只做只读检查。

**Files：** Modify/Test 均为上述路径；优先 feature/package tsconfig，不把所有仓库历史 TS 债务一次纳入。

**接口契约：**
- Consumes：T1–T6 稳定 public interfaces。
- Produces：`typecheck:goal-engine` 与 package typecheck/verify scripts；Doctor readiness 检查覆盖 v1 writer、exact-eight、Host authorization、canonical proof、managed disposition、production final review。

**验收标准：** 在 Goal/Broker/entry 任一路径注入类型错误都会令对应 typecheck 失败；`npm test`、Goal integration 与 fresh canary 的覆盖边界被显式区分；Doctor 不以函数存在代替 production 注入。

- [ ] **步骤 1：编写覆盖 RED**

测试读取 TypeScript `--listFilesOnly` 或执行独立 tsconfig，断言包含 `src/goal-engine/extension.ts`、`pi/extensions/goal-engine.ts` 和 package Root Broker；当前应 FAIL。

- [ ] **步骤 2：运行 RED**

运行：`node --test test/doctor.test.mjs test/goal-engine-settings-gate.integration.mjs test/pi-runtime.integration.mjs`

预期：静态覆盖或 production final-review readiness 断言 FAIL。

- [ ] **步骤 3：建立聚焦 tsconfig/scripts**

新增或调整 feature/package tsconfig，使关键 production TypeScript 被检查；不要借机修复不相关仓库类型债务，也不要让 `npm test` 名义上代表 integration。

- [ ] **步骤 4：强化 Doctor**

Doctor 机械检查当前 production entry 与公共契约，不扫描私有实现文本来猜测接线；任何 provider/ABI/schema 缺失返回非零和稳定诊断。

- [ ] **步骤 5：验证 GREEN**

运行：

```bash
npm run typecheck
npm --prefix packages/pi-subagents-enhanced run verify:package
npm run doctor
node --test test/doctor.test.mjs test/goal-engine-settings-gate.integration.mjs test/pi-runtime.integration.mjs
```

并核对 `--listFilesOnly` 确实包含三条关键路径；最后运行 `git diff --check`。

---

### Task 8：条件化删除平行路径并执行全量回归

**Deps：** `T7`（理由：删除前必须有可信静态引用和完整 focused tests）。

**WritePaths：**
- `src/goal-engine/**`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/**`
- `test/goal-engine-*.integration.mjs`
- `test/root-subagent-broker*.mjs`
- `test/fixtures/**`

**Resources：** 无外部服务；不得删除真实 state 或 managed workspace。

**Files：** 只删除 T1–T7 已证明无调用方的实现；不得预先承诺删除 decoder 文件。

**接口契约：**
- Consumes：T7 静态检查与公共链测试。
- Produces：一个 writer、一个 settlement reader、一个 canonical proof envelope、一个 managed disposition 公共链；历史 replay decoder 保留。

**验收标准：** 每个删除候选均有 `rg` 无生产调用、public canary 覆盖替代路径和 golden replay 不变三类证据；无法满足任一前置条件的候选保留并记录原因。

- [ ] **步骤 1：建立候选证据表**

逐项核查未消费 inspector、重复 proof shape、facade authority 注册、旧抛错 workspace 分支、v2 writer 和旧 `.mjs` fixture；区分 writer、reader、decoder，decoder 最后删除。

- [ ] **步骤 2：先写 prohibition/replay 测试**

```js
assert.equal(freshLedger.some(event => event.schemaVersion.endsWith("v2")), false);
assert.deepEqual(replayHistoricalV2(goldenLog), expectedProjection);
```

预期测试在删除前 PASS，作为删减护栏；若不能 PASS，不执行对应删除。

- [ ] **步骤 3：执行最小删除/合并**

只删除证据完整的死路径；禁止新建 facade、common/utils package 或“临时”兼容层。

- [ ] **步骤 4：运行分层全量回归**

运行：

```bash
npm run typecheck
npm --prefix packages/pi-subagents-enhanced run verify:package
node --test test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/root-subagent-broker-r10b-suspension.integration.mjs
node --test test/subagent-run-authorization.test.mjs test/goal-engine-executor-binding.integration.mjs test/goal-engine-extension.integration.mjs
node --test test/goal-engine-managed-disposition.integration.mjs test/goal-engine-managed-workspace.test.mjs test/subagent-managed-worktree.integration.mjs
node --test test/goal-engine-final-review.integration.mjs test/goal-engine-finalization.integration.mjs test/goal-engine-finalize-extension.integration.mjs
npm run test:goal-engine
npm test
npm run doctor
git diff --check
```

预期全部 PASS；任何 fixture/schema/环境失败先按 provenance 分类，不增加 production fallback。

- [ ] **步骤 5：连续复跑关键矩阵**

重新运行 typecheck、Root Broker、executor binding、managed disposition、finalization 和 Doctor；预期结果与步骤 4 一致，无 flaky 或残留资源。

---

### Task 9：R13 与两轮 fresh Host 验收

**Deps：** `T8`（理由：fresh Host 只验已收口且全量回归通过的基线）。

**WritePaths：**
- `docs/summaries/2026-09-07-goal-engine-minimal-convergence-verification.md`
- `test/goal-runtime-real-canary.integration.mjs`

**Resources：** fresh Pi Host、`openai-codex` provider、managed workspace service；每轮串行，长耗时执行由 subagent/scheduler 承担，Root 不轮询。

**Files：**
- Create：`docs/summaries/2026-09-07-goal-engine-minimal-convergence-verification.md`
- Modify：`test/goal-runtime-real-canary.integration.mjs`（仅修正真实 entry/path/tasks，不注入 stub）

**接口契约：**
- Consumes：T8 完整公共链和可信验收命令。
- Produces：R13 当前基线证据包，包括每轮 Host/session/run identity、八工具调用、失败/修订/恢复路径、正常完成、资源 inventory、历史债务分类和 Manual Preview 结论。

**验收标准：** canary 从真实 `pi/extensions/goal-engine.ts` 加载，至少包含一个多阶段非空 DAG，不手动注入 `finalReviewProvider`；控制输入来自 RPC user message，trace 仅观测；两轮 fresh Host 连续通过且不新增 workspace/lease/runner 债务。

- [ ] **步骤 1：修正 real canary 的真实入口**

将旧 `.mjs` production import 改为真实 `.ts` entry，移除固定成功 provider，使用至少三个有依赖关系的任务，覆盖 dispatch、settle、integrate、accept 和 finalize。

- [ ] **步骤 2：运行 canary RED/环境门禁**

运行：`node --test test/goal-runtime-real-canary.integration.mjs`

若 provider、Host 或环境不可用，必须记录 BLOCKED 及具体缺口，不得计为 RED/GREEN；若可用但公共链断裂，记录首个偏离点并回流对应 T1–T7，而不是在本任务修 production。

- [ ] **步骤 3：执行 R13 第一轮**

在 fresh Host 使用 `openai-codex`，验证 exact-eight、正常完成、失败→settle failed→repair/amend→redispatch、reload/恢复、managed disposition 和 final review；保存原始命令与结果引用。

- [ ] **步骤 4：执行 R13 第二轮**

重新启动另一个 fresh Host，重复同一验收矩阵；不得复用第一轮 session、action token、workspace 或 approval。

- [ ] **步骤 5：资源与债务审计**

通过 typed inventory/audit 确认 fresh Goal 没有新增孤儿 workspace、lease、runner 或未处置 receipt；历史资源只分类并报告，不擅自清理。

- [ ] **步骤 6：写验证总结并保持 Manual Preview**

总结逐项映射 Definition of Done，明确两轮结果、阻塞项、残余风险和 `no staged files` 的真实值；即使全部通过，也只声明 R13 验收完成和可供用户决定后续 cutover，不自动启用 Goal Engine、不自动提交。

## 计划自检

- **规格覆盖：** reviewer 的六项 Important 分别映射到 T0/T1、T2/T4、T2、T5、T3/T6、T7；R13/fresh Host 映射到 T9。
- **范围控制：** 没有新增 Goal generation、通用 package、私有 workspace/Git 实现或自动 continuation；v2 只读 replay 与 Host-owned authorization 被明确区分。
- **DAG 一致：** T1/T2/T3 在 T0 后可推进；T4 只依赖 binding+proof；T5 只依赖 settled task；T6 只依赖 provider contract；T7 汇合稳定接口；T8/T9 顺序验收。
- **资源冲突：** T1/T2 的 registry 写冲突由隔离 workspace 与集成顺序处理，不伪装成业务依赖；provider 与 fresh Host 均限定串行。
- **删除安全：** writer 先冻结、调用方再迁移、decoder 最后删除；没有授权清理真实资源。
- **提交边界：** 计划没有 `git add` 或 commit 步骤。
