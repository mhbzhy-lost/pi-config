# Goal Runtime 暂停恢复与 Smoke 收尾实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。按根 `AGENTS.md`，本改造只能采用 Subagent-Driven 执行，禁止使用 Goal Engine 编排本计划本身。

**目标：** 修复 `goal-runtime.v1` 在 `suspended / ready` 且 closure 未完成时既不签发 `resume_runtime`、也不返回明确阻断的恢复死区，并在 fresh Host 中以 typed 工具完成当前 binding smoke 的失败 attempt 清理、合同修订和重试验收。

**架构：** 将“closure 是否完整、缺哪些权威证明”收敛为一个纯函数，由 obligation policy 决定“签发 resume”或“返回明确 closure debt”，避免 Extension 事后静默过滤。Root Broker 仅在 exact binding、持久 asyncDir 与 official terminal proof 一致时恢复跨重启的 Goal-owned terminal run；Extension 对每个已完成 closure 阶段立即持久化单调进展，使 stop、workspace preserve、resource quarantine 可恢复且不重复副作用。

**技术栈：** Node.js ESM、Pi Extension typed tools、Goal append-only Store、Root Broker、managed worktree lifecycle、`node:test`。

## 全局约束

- `goal-runtime.v1` 继续保持 Manual Preview；不得实现 auto-continuation。
- 每次 Goal mutation 前后均调用 fresh `goal_status`，只消费最新 `action_token`。
- 不 transfer、reset、settle、resume 或修改旧 Goal `doctor-managed-worktree-goal-runtime`。
- 当前 Goal 的历史 unbound/failed 数据不得被宽松兼容；只处理 exact persisted binding `77c124bb-d889-4752-ba51-ca8b6610d731`。
- provenance 未分类前不得增加 production fallback；测试手工 projection/非法事件不得推动 production 兼容。
- coding subagent 只使用 Terra，不使用 Qwen。
- 不读取、输出或提交凭据、cookie、token、证书和 provider secret。
- 不使用 raw `git worktree add/remove/prune/move/repair/lock/unlock`；只使用 typed disposition 或 managed lifecycle。
- `planned.v1`、旧 generation、dispatch-ir.v1 与 exact-eight Goal tool ABI 保持不变。
- 当前 Goal Engine 实现任务不得用 Goal Engine 编排；按本计划 DAG 使用 Subagent-Driven。
- 本计划不默认创建 commit；实现、测试和评审通过后，须再次取得用户明确提交授权，提交并启动 fresh Host 后才能执行当前 Goal 的 typed 恢复。
- Goal finalization/provider 终审不属于本次 smoke 的完成条件；本次 operational DoD 到 `binding-smoke` accepted 为止。

## 已确认的 production 现场

只读 Store API 当前观察到：

- runtime：`suspended`；readiness：`ready`；无 pending decision、无 action offer。
- suspension reason：`execution_amendment`；`resourcesQuarantined=false`。
- affected Task：`binding-smoke`；affected run：`77c124bb-d889-4752-ba51-ca8b6610d731`。
- terminal/workspace/resource closure refs 均为空。
- Task 状态：`dispatched`；attempt `1`；workspace `active`；没有 `lastExecutorProof`。
- public `goal_status` 连续返回空 machine action，未显示 closure debt。

该现场证明问题不在用户未输入 `resume runtime`，而在 suspension closure 没有取得/持久化 exact terminal、workspace、resource 三类证明，且 policy/adapter 将 resume 候选静默过滤。

## DAG

```text
T1（closure 状态合同与显式阻断） ──┐
                                      ├──> T3（单调 closure 恢复接线） ──> T4（真实重启回归） ──> T5（当前 smoke typed 收尾）
T2（Root Broker 跨重启 terminal 恢复）┘
```

## Waves

- Wave 1：T1、T2（可并行）
- Wave 2：T3（等待 T1 的 closure 合同与 T2 的 exact terminal recovery）
- Wave 3：T4（等待 T3 的完整恢复链）
- Wave 4：T5（等待实现提交、fresh Host 与 clean main）

**关键路径：** T2 → T3 → T4 → T5。T1 可与 T2 并行，但 T3 必须同时消费两者产物。

---

### Task 1：建立 suspension closure 状态合同并消除静默无动作

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-08-24-goal-runtime-suspended-ready-without-resume-action.md`
- `scripts/lib/goal-engine/suspension.mjs`
- `scripts/lib/goal-engine/obligation-policy.mjs`
- `scripts/lib/goal-engine/extension.mjs`
- `test/goal-engine-obligation-policy.integration.mjs`
- `test/goal-engine-r10b-extension-resume.integration.mjs`

**Resources：** `none`

**Files：**
- Create：`docs/bugs/2026-08-24-goal-runtime-suspended-ready-without-resume-action.md`
- Modify：`scripts/lib/goal-engine/suspension.mjs`
- Modify：`scripts/lib/goal-engine/obligation-policy.mjs`
- Modify：`scripts/lib/goal-engine/extension.mjs`
- Test：`test/goal-engine-obligation-policy.integration.mjs`
- Test：`test/goal-engine-r10b-extension-resume.integration.mjs`

**接口契约：**
- Produces：

```js
suspensionClosureStatus(projection) => Object.freeze({
  complete: boolean,
  missingTerminalRunIds: string[],
  missingWorkspaceTaskIds: string[],
  missingResourceOwnerIds: string[],
})
```

- 数组按 canonical ID 排序、去重，只包含 projection 已批准的 affected IDs；不含路径、错误原文或 secret。
- `actionableFrontier()` 仅在 `complete === true` 时加入 `{ tool: "goal_amend", params: { operation: "resume_runtime" } }`。
- closure 未完成时不签 token，并返回稳定阻断码：
  - `SUSPENSION_TERMINAL_PROOF_PENDING`
  - `SUSPENSION_WORKSPACE_CLOSURE_PENDING`
  - `SUSPENSION_RESOURCE_CLOSURE_PENDING`
- Extension 不再通过私有 `fullSuspensionClosure` 条件静默删除 policy 已选中的 resume action；handler 仍保留最终 defense-in-depth 校验。

**验收标准：** suspended + incomplete closure 必须有明确 blocker 且无 resume token；full closure 必须唯一签发 resume action。

- [ ] **步骤 1：记录中文 provenance**

记录真实 public 入口、owner/binding、事件顺序、当前三类空 refs、首个偏离点（policy 无条件产生 resume，而 Extension 静默过滤）及第 1 类 production 分类。

- [ ] **步骤 2：编写 policy RED**

新增两个独立行为测试：

```js
assert.equal(frontier(incomplete).actions.some(a => a.params.operation === "resume_runtime"), false);
assert.deepEqual(frontier(incomplete).blocking.map(x => x.code).sort(), [
  "SUSPENSION_RESOURCE_CLOSURE_PENDING",
  "SUSPENSION_TERMINAL_PROOF_PENDING",
  "SUSPENSION_WORKSPACE_CLOSURE_PENDING",
]);
assert.equal(frontier(complete).actions.filter(a => a.params.operation === "resume_runtime").length, 1);
```

- [ ] **步骤 3：运行测试确认 RED**

运行：

```bash
node --test test/goal-engine-obligation-policy.integration.mjs test/goal-engine-r10b-extension-resume.integration.mjs
```

预期：FAIL；当前 incomplete closure 仍被当作 resume action，且 status 没有 closure blocker。

- [ ] **步骤 4：实现最小 closure 状态纯函数与 policy 分支**

只从 projection 的 suspension/refs 计算状态；不访问 Git、Root Broker、文件系统或网络。

- [ ] **步骤 5：删除 Extension 的静默过滤重复逻辑**

Extension 消费 policy 结果；只有 defense-in-depth 断言可以重复验证 complete，不得将被拒绝 resume 变成空响应。

- [ ] **步骤 6：运行 GREEN 与邻近回归**

运行：

```bash
node --test test/goal-engine-obligation-policy.integration.mjs test/goal-engine-r10b-extension-resume.integration.mjs test/goal-engine-r10b-suspension-ledger.integration.mjs
```

预期：全部 PASS。

---

### Task 2：恢复跨 Host 重启的 exact failed terminal proof

**Deps：** `none`

**WritePaths：**
- `scripts/lib/subagent-dispatch/root-broker-server.ts`
- `scripts/lib/subagent-dispatch/root-broker-registry.ts`
- `scripts/lib/goal-engine/production-runtime-host.mjs`
- `test/root-subagent-broker-r10b-suspension.integration.mjs`
- `test/root-subagent-broker.test.mjs`
- `test/goal-engine-production-runtime-host.integration.mjs`
- `test/goal-engine-production-runtime-host-hardening.integration.mjs`

**Resources：** 一个临时 Root Broker socket；测试必须串行管理自身临时目录

**Files：**
- Modify：`scripts/lib/subagent-dispatch/root-broker-server.ts`
- Modify：`scripts/lib/subagent-dispatch/root-broker-registry.ts`
- Modify：`scripts/lib/goal-engine/production-runtime-host.mjs`
- Test：`test/root-subagent-broker-r10b-suspension.integration.mjs`
- Test：`test/root-subagent-broker.test.mjs`
- Test：`test/goal-engine-production-runtime-host.integration.mjs`
- Test：`test/goal-engine-production-runtime-host-hardening.integration.mjs`

**接口契约：**
- `stopGoalOwnedRun({runId, asyncDir, sessionId})` 在内存 `ownedRuns` 缺失时，只可从 exact persisted async run authority 恢复。
- 恢复必须验证 runId、绝对 asyncDir、sessionId、agent=`executor`、official terminal proof 完整一致。
- failed/rejected Executor 终态仍是 suspension closure 可接受的 `state:"observed"` proof；“failed”只影响后续 `goal_settle` outcome，不影响“进程已终止”事实。
- active/pending、identity mismatch、terminal conflict、缺 official artifact 一律返回稳定 attention，不注册伪 owner、不停止其他进程。
- 不为旧 unbound run 增加兼容；必须已有 exact `task.executor_bound`。

**验收标准：** fresh Root Broker 可从 exact terminal async artifact 恢复已绑定 failed run 的 observed proof；任何单字段漂移均 fail closed。

- [ ] **步骤 1：编写 Root Broker restart RED**

测试先在 Broker A 注册/终止 failed Executor，持久化 official terminal artifact；关闭 Broker A 后启动 Broker B，仅向 Broker B 提供 exact binding，调用 Goal-owned stop/recover。

- [ ] **步骤 2：运行 RED**

运行：

```bash
node --test test/root-subagent-broker-r10b-suspension.integration.mjs test/root-subagent-broker.test.mjs
```

预期：FAIL；当前 Broker B 因 `ownedRuns` 内存 Map 为空返回 identity mismatch/attention。

- [ ] **步骤 3：实现 exact terminal-only 恢复**

恢复逻辑复用 official async run reader与 `parseProcessTerminal()`；不得把 generic subagent status 文本当 proof，不得把成功 outcome 作为 terminal existence 的前提。

- [ ] **步骤 4：增加 identity matrix**

逐项覆盖 runId、asyncDir、sessionId、agent、terminal state、conflict 漂移；每项断言没有 stop 其他 PID、没有注册错误 owner。

- [ ] **步骤 5：验证 production Host facade**

运行：

```bash
node --test test/goal-engine-production-runtime-host.integration.mjs test/goal-engine-production-runtime-host-hardening.integration.mjs test/root-subagent-broker-r10b-suspension.integration.mjs test/root-subagent-broker.test.mjs
```

预期：全部 PASS。

---

### Task 3：单调持久化 closure 进展并完成 workspace/resource quarantine

**Deps：** `T1`（消费 `suspensionClosureStatus`）；`T2`（消费 exact observed terminal recovery）

**WritePaths：**
- `scripts/lib/goal-engine/extension.mjs`
- `scripts/lib/goal-engine/production-runtime-host.mjs`
- `scripts/lib/goal-engine/suspension.mjs`
- `test/goal-engine-r10b-extension-quarantine.integration.mjs`
- `test/goal-engine-r10b-extension-resume.integration.mjs`
- `test/goal-engine-production-runtime-host.integration.mjs`
- `test/goal-engine-production-runtime-host-hardening.integration.mjs`

**Resources：** managed temporary Goal workspace；不得操作真实当前 Goal

**Files：**
- Modify：`scripts/lib/goal-engine/extension.mjs`
- Modify：`scripts/lib/goal-engine/production-runtime-host.mjs`
- Modify：`scripts/lib/goal-engine/suspension.mjs`
- Test：`test/goal-engine-r10b-extension-quarantine.integration.mjs`
- Test：`test/goal-engine-r10b-extension-resume.integration.mjs`
- Test：`test/goal-engine-production-runtime-host.integration.mjs`
- Test：`test/goal-engine-production-runtime-host-hardening.integration.mjs`

**接口契约：**
- `closeSuspendedRuntime(ctx, projection)` 每取得一种新 proof 就 append 一条 monotonic partial `goal.runtime_suspended` closure event，再 reload authoritative projection。
- 顺序固定为 terminal observed → workspace preserved → resource quarantined；没有 terminal proof 时不得 preserve workspace。
- 每次 retry 从已持久 refs 继续；不得重复 stop、重复变更 disposition 或丢失已完成 proof。
- `resourcesQuarantined=true` 只在三类 refs 全部覆盖 affected IDs 时写入。
- production Host 的 workspace/resource quarantine 对同一 exact preserved receipt 必须幂等；第二阶段不得要求已被第一阶段销毁的 active lease。

**验收标准：** 在 terminal、workspace、resource 任一阶段 pre-append/durable-then-throw/restart 后，下一次 status 都能从最后 durable proof 继续，最终签发唯一 resume token。

- [ ] **步骤 1：编写三阶段 crash matrix RED**

分别注入 terminal 后、workspace 后、resource 后的 pre-append 与 durable-then-throw；断言当前实现因只在 complete 时 append 而重复副作用或永远无 action。

- [ ] **步骤 2：运行 RED**

运行：

```bash
node --test test/goal-engine-r10b-extension-quarantine.integration.mjs test/goal-engine-r10b-extension-resume.integration.mjs
```

预期：FAIL，且失败点是 closure 进展未持久或第二阶段 identity 不可恢复。

- [ ] **步骤 3：实现单调 partial closure append**

每次 append 后用 Store reload 作为下一阶段 authority；append ambiguity 仅在 recovered projection 与 expected 完全一致时视为成功。

- [ ] **步骤 4：实现 preserved receipt 幂等证明**

`quarantineResource` 应证明同一 owner/workspace 已处于 exact preserved 状态，而不是再次执行 destructive disposition；proof hash 绑定 request、lease/receipt identity、executor HEAD 与 disposition。

- [ ] **步骤 5：验证 incomplete 与 complete status**

incomplete 时返回具体 closure blocker；complete 时只签一次 `goal_amend(resume_runtime)` token。

- [ ] **步骤 6：运行 GREEN**

```bash
node --test test/goal-engine-r10b-extension-quarantine.integration.mjs test/goal-engine-r10b-extension-resume.integration.mjs test/goal-engine-production-runtime-host.integration.mjs test/goal-engine-production-runtime-host-hardening.integration.mjs
```

预期：全部 PASS。

---

### Task 4：真实 Host restart canary 与全量回归

**Deps：** `T3`（需要完整 closure/recovery 实现）

**WritePaths：**
- `test/goal-runtime-real-canary.integration.mjs`
- `test/pi-runtime.integration.mjs`
- `test/goal-engine-r10b-extension-resume.integration.mjs`

**Resources：** 一个真实临时 Pi Host/Root Broker socket；串行运行

**Files：**
- Modify：`test/goal-runtime-real-canary.integration.mjs`
- Modify：`test/pi-runtime.integration.mjs`
- Modify：`test/goal-engine-r10b-extension-resume.integration.mjs`

**接口契约：**
- 测试使用公开 typed init/status/dispatch 与真实 Root Broker binding。
- Executor 产生 official failed terminal proof和 clean committed workspace；随后使用真实 `followUp` suspension。
- Host restart 后首个 status 完成 closure recovery；若 closure 尚未完成，返回明确 debt；最终 status 签发 exact resume action/token。
- 调用 `goal_amend(resume_runtime)` 后 runtime 回 active，旧 failed proof仍留给 `goal_settle(outcome:"failed")`，不得改写成 success。

**验收标准：** 真实 restart canary 无内存 Map authority，且全量 Goal Engine 测试通过。

- [ ] **步骤 1：增加真实 restart canary**
- [ ] **步骤 2：运行 canary 定向测试**

```bash
node --test test/goal-runtime-real-canary.integration.mjs test/pi-runtime.integration.mjs test/goal-engine-r10b-extension-resume.integration.mjs
```

预期：PASS。

- [ ] **步骤 3：运行全量 Goal Engine 回归**

```bash
npm run test:goal-engine
```

预期：全部 PASS；任何失败先按 provenance 三分类，不得统一增加兼容。

- [ ] **步骤 4：运行差异机械检查**

```bash
git diff --check
git diff --cached --name-only
```

预期：无 whitespace 错误、无 staged 文件。

- [ ] **步骤 5：执行最终 Terra 只读评审**

只评本计划改动；Critical/Important 必须修复并最多复审一轮。外部 Anthropic provider 不可用时记录受限原因，不回退 Qwen。

---

### Task 5：当前 binding smoke 的 typed 恢复与验收

**Deps：** `T4`（实现与回归完成）；另需用户明确授权提交、`main` clean、启动 fresh Host

**WritePaths：**
- `docs/audits/2026-08-24-goal-subagent-binding-smoke.md`（仅由重试后的 Goal Executor workspace 写入）

**Resources：** 当前 Goal 的 managed workspace、Root Broker run、typed Goal action tokens；单线程执行

**Files：**
- Create/Update：`docs/audits/2026-08-24-goal-subagent-binding-smoke.md`

**接口契约：**
- 只使用 `goal_status`、`goal_amend`、`goal_settle`、`goal_integrate`、`goal_dispatch`、`goal_accept` 与 exact `dispatch-ir.v1` Subagent spawn。
- 每次 mutation 后立即 fresh `goal_status`。
- attempt 1 的 official proof outcome 保持 failed；不得主会话 override 为 success。
- 更新后的 acceptance：
  - `audit-file`：`evaluator:"executor"`。
  - `executor-binding`：`evaluator:"coordinator"`, `predicate:"executor-bound"`。
  - `terminal-proof`：`evaluator:"coordinator"`, `predicate:"executor-terminal-proof"`。
  - `workspace-lifecycle`：`evaluator:"coordinator"`, `predicate:"workspace-integrated-released"`。
  - `task-accept`：`evaluator:"coordinator"`, `predicate:"task-accepted"`。

**验收标准：** attempt 1 以 failed terminal proof 结算并 typed discard；合同经用户批准后 attempt 2 只下发 executor criterion，最终 typed integrate/release 与 accept 成功。

- [ ] **步骤 1：提交实现并启动 fresh Host（独立授权门禁）**

没有用户明确提交授权时停止；不得用 dirty main 继续 runtime。

- [ ] **步骤 2：恢复 runtime**

调用 `goal_status`；预期得到：

```json
{
  "machineAction": {
    "tool": "goal_amend",
    "params": {
      "goal_id": "goal-dispatch-subagent-spawn-handle-task.executor_bound-settle-integrate-accept",
      "operation": "resume_runtime"
    }
  }
}
```

同一 status 响应还必须包含非空、未消费的 `goal-action.v1` action token。将该响应参数与 token 原样调用 `goal_amend(resume_runtime)`，随后 fresh status。

- [ ] **步骤 3：结算并释放 attempt 1**

按 status offer 调用 `goal_settle(outcome:"failed")`，`next_action` 明确写“丢弃失败 attempt 的隔离工作区并修订验收主体后重新派发”。fresh status 后只按 typed `goal_integrate(discard)` 释放。

- [ ] **步骤 4：提议 runtime acceptance amendment**

使用 `goal_amend(propose_execution_change)` 仅更新 `binding-smoke.acceptance` 的 evaluator/predicate；不改 objective、write policy、conditions 或 budgets。等待用户真实 approve/reject；批准后 fresh status 驱动 apply/resume。

- [ ] **步骤 5：重新派发 attempt 2**

调用 `goal_dispatch`，将返回的完整 `dispatch-ir.v1` 原样交给 Terra Executor。断言 child requirements/acceptance 只含 `audit-file` executor criterion；四个 coordinator criteria 仅留在 Goal projection。

- [ ] **步骤 6：完成标准闭环**

official Root broker terminal proof observed 后：

```text
goal_status
→ goal_settle(succeeded, exact subagent evidence + independent main verification)
→ goal_status
→ goal_integrate(integrate)
→ goal_status
→ goal_accept
→ goal_status
```

- [ ] **步骤 7：最终验收**

确认：

- main 只新增/更新声明 audit 文件；
- workspace disposed、integrated、released；
- Task status `accepted`；
- 四个 coordinator predicates 在 finalization manifest 中均 satisfied；
- 旧 Goal `doctor-managed-worktree-goal-runtime` 未发生任何事件、资源或 owner 变化。

---

## 计划自检

- **规格覆盖：**包含 silent status、Root Broker restart、closure 单调持久化、真实 canary、旧 failed attempt 和 evaluator 修订。
- **数据来源门禁：**每个 production 修复都有 public/Store/Root Broker 可达入口；手工 projection 不能单独推动兼容。
- **DAG 一致性：**T1/T2 可并行；T3 需要二者；T4 需要 T3；T5 需要 T4 与 fresh Host。
- **写入隔离：**并行 T1/T2 无重叠 WritePaths；T3 统一整合 Extension/Host；T5 仅写 audit 文件。
- **禁止项：**无 raw worktree、无 secret、无 Qwen、无 Goal Engine 自举编排、无默认 commit。
- **无占位：**所有接口、路径、命令、状态码和恢复顺序均已明确。
