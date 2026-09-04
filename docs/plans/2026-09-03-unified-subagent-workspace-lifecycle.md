# Subagent 与 Goal Workspace 生命周期收敛实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 让普通 subagent 与 Goal executor 通过同一个 `subagent` tool、同一个 managed workspace service 和同一份 durable receipt 完成 worktree 分配、run 绑定、检查、合入、保留、释放与崩溃恢复，删除 Goal 与 subagent 两套并行 workspace 状态机。

**架构：** `pi-subagents-enhanced` 继续作为单一 package，不新增独立 workspace package；其内部新增中性的 `src/workspace/` 子系统，并成为所有 subagent worktree 资源的唯一 owner。Goal Engine 只生成同一份 `dispatch-ir.v1`、持久化 workspace request/receipt 业务事件，并通过进程内受认证 registry 使用 workspace service；不再直接执行 Git worktree 操作或维护第二份资源 ledger。canonical dispatch IR codec 同时供 typed facade 和 Goal 使用，upstream `pi-subagents` 仍只负责实际 child workflow/run，保持 `worktree:false` 以避免二次分配。

**技术栈：** Node.js 22.19+、ESM/TypeScript、`node:test`、Pi ExtensionAPI、`pi-subagents@0.62.0`、Git linked worktree、JSONL Goal event store、原子 JSON workspace ledger。

## 全局约束

- `managed-workspace` 不拆成新 package；统一实现位于 `packages/pi-subagents-enhanced/src/workspace/`。
- 所有 subagent worktree，包括 Goal executor 和 Goal validation worktree，都必须通过同一个 managed workspace service 分配和处置。
- Goal Engine 继续通过项目 typed `subagent` tool 启动 executor；不得绕过该 tool 直接启动 child。
- Goal Engine 只拥有 Goal 业务事件和 projection；workspace service 是 Git workspace 资源状态、lease 与 disposition receipt 的唯一权威。
- canonical coding contract 保持 `dispatch-ir.v1`；普通任务与 Goal task 都使用 `execution.worktree: true` 请求隔离，不再用“`cwd` 已指向 Goal worktree”表达隐含所有权。
- upstream `pi-subagents` 的 workflow 与 leaf 必须继续使用 `worktree:false`；统一 service 分配完成后只把 `dispatchCwd` 交给 upstream，禁止形成嵌套 worktree。
- `pi-subagents` 版本固定为 `0.62.0`；所有 upstream 深层 import 继续只允许出现在 `src/compat/pi-subagents-0.62.ts`。
- 新 workspace ledger 和 worktree 根目录不得写入目标仓库的 `.pi-subagents/`、`.pi/subagents/`、`.state/subagent-dispatch/` 或 `.state/worktree-lifecycle/`；默认使用 `PI_CODING_WORKSPACE_DIR`，本仓 shell 配置固定到 `<pi-config>/var/workspaces`。
- 新 runtime 不读取、迁移、执行或信任遗留 `.pi-subagents/**`、`.state/subagent-dispatch/**` 与 `.state/worktree-lifecycle/**` 内容；历史 Goal projection 只允许通过显式 legacy recovery 分支只读识别。
- 所有 workspace 破坏性动作必须先有 Root Broker terminal proof、稳定 inspection snapshot 和一次性 action token；Goal 事件 intent 必须先于 Git 副作用，receipt 事件必须晚于 service durable receipt。
- 所有面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层；本计划不得为了 workspace 展示改写 agent 消息、tool result、event payload 或 session 内容。
- 本计划不修改 `pi/settings.json.enabledModels`、`pi/models.json` 或本机 Goal Engine 开关。
- 本地不启动真实 Goal canary；Goal 改造使用临时 Git 仓库中的 deterministic `node:test` 和静态模块加载验证，不写入现有 `var/goals`。
- 测试出现异常数据时，先记录实际入口、权威身份、事件/资源顺序和首个偏离点，再按 production 可达、fixture 污染或来源未证实分类；分类前不得增加 production fallback。
- 不创建 Git commit；提交动作需要用户另行明确授权。

## 目标文件结构

```text
packages/pi-subagents-enhanced/
  src/contracts/
    dispatch-ir.mjs            # 唯一 dispatch-ir.v1 codec 与 canonical hash
  src/workspace/
    contract.mjs               # request、owner、receipt、状态与公开投影校验
    ledger.mjs                 # 全局 state root 下的 durable intent/receipt store
    git-worktree.mjs           # Git linked worktree、inspection、integration、release
    service.mjs                # reserve/allocate/bind/status/dispose/reconcile 状态机
    registry.ts                # 按 ExtensionAPI/rootSessionId 绑定 service
    administration.mjs         # Doctor 与 CLI 的只读 inventory/reconcile API
  src/subagent-dispatch/
    extension.ts               # typed tool 与统一 service 的调用边界
    root-broker-registry.ts    # Goal coordinator 与 Root Broker，不再承载 workspace 实现

scripts/lib/goal-engine/
  dispatch.mjs                 # 生成 worktree:true 的 canonical dispatch contract
  executor-binding.mjs         # Goal ticket、workspace receipt 与 run binding 校验
  events.mjs                   # request/allocated/disposition receipt 事件与 replay
  extension.mjs                # Goal tools，只编排 service 与持久化业务事件
  managed-validation.mjs       # 使用统一 service 的 goal-validation owner
```

最终删除的旧实现和 facade：

```text
packages/pi-subagents-enhanced/src/subagent-dispatch/workspace.mjs
packages/pi-subagents-enhanced/src/subagent-dispatch/workspace-controller.mjs
packages/pi-subagents-enhanced/src/subagent-dispatch/workspace-ledger.mjs
packages/pi-subagents-enhanced/src/goal-support/workspace.mjs
packages/pi-subagents-enhanced/src/worktree-lifecycle/inventory.mjs
packages/pi-subagents-enhanced/src/worktree-lifecycle/managed-worktree.mjs
packages/pi-subagents-enhanced/src/worktree-lifecycle/registry.mjs
scripts/lib/goal-engine/workspace.mjs
scripts/lib/worktree-lifecycle/inventory.mjs
scripts/lib/worktree-lifecycle/managed-worktree.mjs
scripts/lib/worktree-lifecycle/registry.mjs
scripts/lib/goal-engine/dispatch-ir.mjs
```

## DAG

```text
T1 (canonical IR 与 workspace 契约)
  └──> T2 (统一 workspace service)
         ├──> T3 (typed subagent 接入)
         ├──> T4 (Goal request/allocation/binding 接入)
         └──> T5 (Doctor 与 CLI 接入)

T3 ───────────────┐
T4 ──> T6 (Goal settle/disposition/validation 接入)
T5 ───────────────┤
T6 ───────────────┴──> T7 (删除旧层并收紧发行闭包)
                           └──> T8 (完整回归与静态验收)
```

依赖边说明：

- `T1 -> T2`：T2 消费 T1 的 `ManagedWorkspaceRequest`、`ManagedWorkspaceReceipt` 与 canonical IR codec。
- `T2 -> T3`：T3 只能在 service 的 allocation/binding/disposition API 稳定后替换 typed facade。
- `T2 -> T4`：T4 需要稳定 receipt 结构才能定义 Goal 事件与 projection。
- `T2 -> T5`：Doctor/CLI 必须消费统一 inventory，而不是复制 Git 资源识别。
- `T4 -> T6`：Goal settle/disposition 依赖 request、allocated、bound 三阶段 projection。
- `T3,T5,T6 -> T7`：只有全部调用方切换后才能删除旧 workspace、lifecycle 与 facade 文件。
- `T7 -> T8`：最终验证必须针对已经删除兼容层的真实发行闭包。

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3、T4、T5（可并行；分别修改 subagent、Goal dispatch、管理入口）
- Wave 4：T6（等待 T4 的 Goal workspace 事件契约）
- Wave 5：T7（等待所有调用方完成迁移）
- Wave 6：T8

**关键路径：** T1 → T2 → T4 → T6 → T7 → T8。T3、T5 可在 Wave 3 并行，不得因 Wave 分组等待同组无关任务。

---

### Task 1：建立 canonical dispatch IR 与统一 workspace 契约

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-03-goal-subagent-workspace-lifecycle-fork.md`
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.mjs`
- `packages/pi-subagents-enhanced/src/workspace/contract.mjs`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `test/managed-workspace-contract.test.mjs`
- `test/goal-subagent-dispatch-parity.test.mjs`

**Resources：** `none`

**Files：**
- Create：`docs/bugs/2026-09-03-goal-subagent-workspace-lifecycle-fork.md`
- Create：`packages/pi-subagents-enhanced/src/contracts/dispatch-ir.mjs`
- Create：`packages/pi-subagents-enhanced/src/workspace/contract.mjs`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- Create：`test/managed-workspace-contract.test.mjs`
- Modify：`test/goal-subagent-dispatch-parity.test.mjs`

**接口契约：**
- Consumes：现有 `dispatch-ir.v1` 字段、Goal `prepareSpawn/bindSpawn` ticket、Root Broker 的 `rootSessionId/runId/asyncDir` 身份。
- Produces：

```js
createManagedWorkspaceRequest({
  workspaceId,
  owner, // standalone-subagent | goal-task | goal-validation
  originRoot,
  requestedCwd,
  originRef,
  baseCommit,
  contractHash,
  mode, // coding | generic | validation
  writePaths,
})

validateManagedWorkspaceReceipt(value)
publicManagedWorkspaceReceipt(value)
deterministicGoalWorkspaceId({ goalId, taskId, attempt, executionRevision, contractHash, baseCommit })
```

`ManagedWorkspaceReceipt` 固定包含：

```js
{
  schemaVersion: "managed-workspace.v1",
  workspaceId,
  leaseId,
  owner,
  originRoot,
  requestedCwd,
  originRef,
  baseCommit,
  path,
  dispatchCwd,
  branchRef,
  state,
  run,
  disposition,
  cleanupDebt
}
```

Goal coordinator 接口扩展为：

```ts
prepareSpawn(request): GoalSpawnTicket | null
workspaceAllocated(ticket, receipt): Promise<void> | void
confirmSpawn(ticket, receipt): Promise<void> | void
bindSpawn(ticket, binding): Promise<void> | void
```

**验收标准：** 普通任务与 Goal task 通过同一 codec 得到一致 canonical hash；workspace owner 是严格判别联合；绝对路径、owner 字段、状态和 receipt 字段均 fail closed；Goal workspace ID 对相同事实稳定、对 attempt/hash/base 变化敏感。

- [x] **步骤 1：记录当前分叉的数据来源与首个偏离点**

在中文问题记录中写明：合法入口分别是普通 `subagent(execution.worktree=true)` 与 `goal_dispatch -> subagent(contract)`；首个偏离点是 Goal 在 `goal_dispatch` 内调用 `allocateExecutorWorkspace`，普通调用则在 typed tool execute 内调用 `allocateManagedSubagentWorkspace`；两条链最终都调用 `createManagedWorktree`，但 ledger、owner 和 disposition 分叉。

- [x] **步骤 2：编写 workspace contract RED**

```js
const request = createManagedWorkspaceRequest({
  workspaceId: "goal-abc",
  owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "g", taskId: "t1", attempt: 1, executionRevision: 1 },
  originRoot,
  requestedCwd: originRoot,
  originRef: "refs/heads/main",
  baseCommit,
  contractHash: "a".repeat(64),
  mode: "coding",
  writePaths: ["src/**"],
});
assert.equal(request.owner.kind, "goal-task");
assert.throws(() => createManagedWorkspaceRequest({ ...request, owner: { kind: "goal-task", taskId: "t1" } }), /owner/i);
```

- [x] **步骤 3：运行 contract 测试确认 RED**

运行：`node --test test/managed-workspace-contract.test.mjs`

预期：FAIL，错误指向缺失的 `src/workspace/contract.mjs` 或导出函数。

- [x] **步骤 4：迁入 canonical dispatch IR codec 并实现 workspace contract**

从现有 typed codec 迁入纯 ESM 实现；`execution.worktree` 继续是可选 boolean，canonical IR 不携带运行时生成的 `dispatchCwd` 或 lease secret。实现严格 owner/receipt 校验和 SHA-256 deterministic Goal workspace ID。

- [x] **步骤 5：扩展 coordinator 类型与行为校验**

`assertGoalExecutorCoordinator` 必须要求四个方法；registry 仍以 ExtensionAPI events identity 和 `rootSessionId` 双重绑定，旧两方法 coordinator 直接拒绝，禁止静默降级。

- [x] **步骤 6：运行聚焦测试确认 GREEN**

运行：`node --test test/managed-workspace-contract.test.mjs test/goal-subagent-dispatch-parity.test.mjs test/root-subagent-broker-protocol.test.mjs`

预期：PASS；两个合法入口的 contract hash 相同，owner/receipt 负例均拒绝。

### Task 2：实现统一 managed workspace service 与全局 durable ledger

**Deps：** `T1`（理由：消费 `ManagedWorkspaceRequest`、`ManagedWorkspaceReceipt` 和 owner 判别联合）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/ledger.mjs`
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.mjs`
- `packages/pi-subagents-enhanced/src/workspace/service.mjs`
- `packages/pi-subagents-enhanced/src/workspace/administration.mjs`
- `scripts/pi-shell.zsh`
- `test/managed-workspace-ledger.integration.mjs`
- `test/managed-workspace-service.integration.mjs`
- `test/pi-shell.test.mjs`

**Resources：** 临时 Git 仓库；测试全部使用独立 `mkdtemp`，不得访问现有 worktree 或 `var/goals`。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/ledger.mjs`
- Create：`packages/pi-subagents-enhanced/src/workspace/git-worktree.mjs`
- Create：`packages/pi-subagents-enhanced/src/workspace/service.mjs`
- Create：`packages/pi-subagents-enhanced/src/workspace/administration.mjs`
- Modify：`scripts/pi-shell.zsh:4-8`
- Create：`test/managed-workspace-ledger.integration.mjs`
- Create：`test/managed-workspace-service.integration.mjs`
- Modify：`test/pi-shell.test.mjs`

**接口契约：**
- Consumes：T1 的 request/receipt validator；现有 owner-token CAS、Git identity、inspection、writePaths 与 integration 算法。
- Produces：

```js
createManagedWorkspaceService({ stateRoot, terminalProofProvider, fault })

service.reserve(request)
service.ensureAllocated(request)
service.bindRun({ workspaceId, run })
service.status({ workspaceId, terminalProof })
service.issueDisposition({ workspaceId, terminalProof })
service.dispose({ workspaceId, terminalProof, disposition, strategy, actionToken })
service.release({ workspaceId })
service.reconcile({ originRoot })
```

状态机固定为：

```text
reserved -> allocating -> active -> disposing -> released
                                \-> preserved -> released
任何有副作用但无法证明完成的边界 -> cleanup-debt
```

**验收标准：** 三种 owner 使用同一 record schema 和状态机；相同 request 幂等返回同一 receipt；冲突 request、lease 替换、路径别名、HEAD/ref 漂移、未观察 terminal、action token 重放全部拒绝；service 不读取目标仓库内旧 runtime 目录。

- [x] **步骤 1：编写 ledger 身份与幂等 RED**

覆盖 intent-before-side-effect、`0600` regular file、no-follow read、原子 rename、目录 fsync、同 ID 同 request 幂等、同 ID 不同 request 冲突、进程出生身份锁和崩溃后重放。

- [x] **步骤 2：运行 ledger 测试确认 RED**

运行：`node --test test/managed-workspace-ledger.integration.mjs`

预期：FAIL，错误指向缺失的 unified ledger API。

- [x] **步骤 3：实现全局 state root 与 ledger**

`PI_CODING_WORKSPACE_DIR` 必须是绝对路径；本仓 shell 默认导出 `$_PI_CONFIG_ROOT/var/workspaces`。record 位于 `<stateRoot>/repositories/<sha256(real originRoot)>/records/<workspaceId>.json`，worktree 位于同一 repository scope 的 `worktrees/<workspaceId>`；公开 receipt 只包含 `leaseId=sha256(ownerToken)`，不暴露 owner token。

- [x] **步骤 4：编写真实 Git 生命周期 RED**

覆盖 primary worktree 限制、clean origin、子目录 cwd 映射、并行 workspace、clean forward origin、writePaths rename source、integrate/discard/preserve/release、partial cleanup 与重复 disposition。

- [x] **步骤 5：运行 service 测试确认 RED**

运行：`node --test test/managed-workspace-service.integration.mjs`

预期：FAIL，错误指向缺失的 allocation/disposition 实现。

- [x] **步骤 6：迁入最小 Git 与 service 实现**

以当前 Goal workspace 的 identity、recovery 和 disposition 门禁为强语义基线，吸收 standalone controller 的 run binding 与 action token；不得保留按 owner 分派到不同实现的条件分支。

- [x] **步骤 7：增加 hostile legacy tree 回归**

在目标仓库预置不可读或内容冲突的 `.pi-subagents/`、`.state/subagent-dispatch/`、`.state/worktree-lifecycle/`，快照 inode、mode、mtime 和 bytes；完成 allocate/status/dispose 后断言旧目录完全未被访问或修改。

- [x] **步骤 8：运行本任务回归确认 GREEN**

运行：`node --test test/managed-workspace-ledger.integration.mjs test/managed-workspace-service.integration.mjs test/pi-shell.test.mjs`

预期：PASS，且所有测试 worktree 在 teardown 后解除注册。

### Task 3：让 typed subagent 成为统一 workspace 分配入口

**Deps：** `T2`（理由：消费统一 service 的 reserve/allocate/bind/status/dispose API）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/registry.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-managed-worktree.integration.mjs`
- `test/subagent-runtime-root-upstream.test.mjs`
- `test/subagent-runtime-membrane.test.mjs`

**Resources：** 临时 Git 仓库和 fake Pi event bus；每个测试使用独立 workspace state root。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/registry.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:330-540,680-790`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts:35-85`
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Modify：`test/subagent-dispatch-extension.test.ts`
- Modify：`test/subagent-managed-worktree.integration.mjs`
- Modify：`test/subagent-runtime-root-upstream.test.mjs`
- Modify：`test/subagent-runtime-membrane.test.mjs`

**接口契约：**
- Consumes：T2 `ManagedWorkspaceService`；T1 四阶段 Goal coordinator；Root Broker facade terminal proof。
- Produces：按 ExtensionAPI/rootSessionId 注册的 workspace service；`subagent` spawn handle 中稳定的 `workspace_id/workspace_state/dispatch_cwd/lease_id`；现有 `workspace_status/workspace_disposition` public ABI 由统一 service 提供。

**验收标准：** standalone 与 Goal fake coordinator 都从 typed tool 进入同一个 `ensureAllocated`；Goal 不再触发 `WORKSPACE_GOAL_BOUND_FORBIDDEN`；任何 spawn 前失败保留可恢复 receipt；upstream workflow 和 leaf 仍明确 `worktree:false`。

- [x] **步骤 1：编写唯一 allocation owner RED**

构造一个 standalone contract 和一个返回 `goal-task` workspace request 的 fake coordinator，记录 service 调用；断言两者都调用一次 `ensureAllocated`，且 upstream RPC 只看到统一 service 返回的 `dispatchCwd`。

- [x] **步骤 2：运行 typed facade 测试确认 RED**

运行：`node --test test/subagent-dispatch-extension.test.ts test/subagent-managed-worktree.integration.mjs`

预期：FAIL；Goal case 当前命中 `WORKSPACE_GOAL_BOUND_FORBIDDEN` 或没有 `workspaceAllocated` 回调。

- [x] **步骤 3：绑定 workspace service 生命周期**

在 root extension 初始化时创建并注册 service，在 reload 时复用 durable state、替换 live registry binding，在 shutdown 时只释放进程资源，不隐式删除 active/preserved worktree。

- [x] **步骤 4：重写 `executeCoding` workspace 顺序**

严格执行：compile source IR → coordinator `prepareSpawn` → service `ensureAllocated` → coordinator `workspaceAllocated` → coordinator `confirmSpawn` → 生成 runtime IR/prompt → upstream spawn → service `bindRun` → coordinator `bindSpawn`。standalone 使用相同顺序但无 coordinator callbacks。

- [x] **步骤 5：统一 generic worktree 与控制动作**

generic `worktree:true` 使用 `standalone-subagent` owner；`workspace_status`、`workspace_disposition`、preserved release 全部只调用 service，不读取旧 origin map 或旧 ledger。

- [x] **步骤 6：固定 upstream 非所有权**

断言 `buildWorkflowSpawn` 的 workflow root 和 leaf 始终为 `worktree:false`，且没有把 source contract 的 `worktree:true` 透传给 upstream。

- [x] **步骤 7：运行本任务回归确认 GREEN**

运行：`node --test test/subagent-dispatch-extension.test.ts test/subagent-managed-worktree.integration.mjs test/subagent-runtime-root-upstream.test.mjs test/subagent-runtime-membrane.test.mjs`

预期：PASS；两种 owner 只有 receipt metadata 不同，allocation 与 disposition 调用路径相同。

### Task 4：把 Goal dispatch 与 executor binding 改为 request/receipt 协议

**Deps：** `T2`（理由：需要稳定 workspace receipt）；`T1`（理由：需要 canonical IR codec 和 coordinator 接口）

**WritePaths：**
- `scripts/lib/goal-engine/dispatch.mjs`
- `scripts/lib/goal-engine/executor-binding.mjs`
- `scripts/lib/goal-engine/events.mjs`
- `scripts/lib/goal-engine/graph.mjs`
- `scripts/lib/goal-engine/extension.mjs`
- `test/goal-engine-dispatch.integration.mjs`
- `test/goal-engine-events.integration.mjs`
- `test/goal-engine-executor-binding.integration.mjs`
- `test/goal-engine-extension.integration.mjs`

**Resources：** 临时 Git 仓库；只运行 deterministic Goal tests，不启动现有 Goal 或真实 model run。

**Files：**
- Modify：`scripts/lib/goal-engine/dispatch.mjs`
- Modify：`scripts/lib/goal-engine/executor-binding.mjs`
- Modify：`scripts/lib/goal-engine/events.mjs`
- Modify：`scripts/lib/goal-engine/graph.mjs`
- Modify：`scripts/lib/goal-engine/extension.mjs:1040-1110,1790-1910`
- Modify：`test/goal-engine-dispatch.integration.mjs`
- Modify：`test/goal-engine-events.integration.mjs`
- Modify：`test/goal-engine-executor-binding.integration.mjs`
- Modify：`test/goal-engine-extension.integration.mjs`

**接口契约：**
- Consumes：T1 canonical `compileCodingDispatchIR`；T1 deterministic Goal workspace ID；T2 receipt validator。
- Produces：当前 Goal event generation 的 `task.dispatch_requested` 与 `task.workspace_allocated` 事件；四阶段 coordinator 的真实实现；`goal_dispatch` 返回 `execution.cwd=<origin requested cwd>` 且 `execution.worktree=true` 的 contract。

事件数据固定为：

```js
task.dispatch_requested: {
  taskId, attempt, contractHash, workspaceId,
  originRoot, requestedCwd, originRef, baseCommit
}

task.workspace_allocated: {
  taskId, attempt, contractHash,
  workspace: publicManagedWorkspaceReceipt(receipt)
}
```

**验收标准：** `goal_dispatch` 在返回 contract 前只追加 request event，不创建 Git worktree；subagent tool 分配后 coordinator 原子追加 allocated event；只有当前 request 的精确 receipt 才能进入 executor spawn/bind；历史 `task.dispatched` 事件继续可重放。

- [x] **步骤 1：编写 Goal 无副作用 dispatch RED**

调用 `goal_dispatch` 后断言 projection 为 `dispatch_requested`、contract 使用 origin cwd 与 `worktree:true`，同时 `git worktree list`、workspace state root 和 origin HEAD 均未变化。

- [x] **步骤 2：运行 Goal dispatch 测试确认 RED**

运行：`node --test test/goal-engine-dispatch.integration.mjs test/goal-engine-extension.integration.mjs --test-name-pattern='dispatch|workspace request'`

预期：FAIL；当前 `goal_dispatch` 会立即创建 Goal worktree。

- [x] **步骤 3：增加 request/allocated reducer 与 replay 兼容**

新 generation 使用两阶段事件；旧 generation 的 `task.dispatched` 保持原 reducer，不把缺失 receipt 的历史记录升级为新资源事实。projection 必须区分 `dispatch_requested` 与 `dispatched`，status 为未完成 request 返回精确重试动作。

- [x] **步骤 4：让 Goal 使用 canonical codec**

`compileTaskContract` 从 package canonical codec 导入；移除对 workspace path 的编译依赖，以 origin requested cwd 生成 `worktree:true` source contract。contract hash 在 allocation 前稳定，runtime `dispatchCwd` 不进入 source hash。

- [x] **步骤 5：实现 Goal coordinator workspace callbacks**

`prepareSpawn` 只匹配当前 `dispatch_requested` contract 并产生 `goal-task` request；`workspaceAllocated` 校验 receipt 后追加事件；`confirmSpawn` 重新加载 projection 并校验 receipt/leaseId/base/ref；`bindSpawn` 只允许同一 receipt 上的 run binding。

- [x] **步骤 6：覆盖崩溃边界**

测试 request append 失败、allocation durable 后 callback 失败、allocated event durable-then-throw、receipt 冲突、重复 exact callback、allocation 后 spawn 失败以及 reload 重试；每个 case 都断言 Goal projection与 service ledger 各自的权威边界。

- [x] **步骤 7：运行本任务回归确认 GREEN**

运行：`node --test test/goal-engine-dispatch.integration.mjs test/goal-engine-events.integration.mjs test/goal-engine-executor-binding.integration.mjs test/goal-engine-extension.integration.mjs --test-name-pattern='dispatch|workspace|executor binding'`

预期：PASS，且测试只访问临时 state root。

### Task 5：迁移 Doctor 与 worktree CLI 到统一 administration API

> **2026-09-03 用户决策：** 退役通用 mutation CLI；只保留 `audit/reconcile`。`create/adopt/release/preserve/reanchor/prune-stale-registrations` 不迁移到 unified service，必须从 CLI schema、AGENTS/Skill 承诺和 shell-policy 例外中删除，并由行为测试确认拒绝。

**Deps：** `T2`（理由：消费统一 inventory/reconcile 和 receipt schema）

**WritePaths：**
- `scripts/doctor.mjs`
- `scripts/worktree-lifecycle.mjs`
- `scripts/lib/shell-policy.mjs`
- `pi/AGENTS_APPEND.md`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `skill-overrides/using-goal-engine/SKILL.md`
- `test/doctor.test.mjs`
- `test/shell-policy.test.mjs`
- `test/worktree-lifecycle-inventory.integration.mjs`
- `test/worktree-lifecycle-managed.integration.mjs`
- `test/worktree-lifecycle-recovery.integration.mjs`
- `test/worktree-lifecycle-registry.integration.mjs`

**Resources：** 临时 Git 仓库；CLI apply case 仅操作测试 worktree。

**Files：**
- Modify：`scripts/doctor.mjs`
- Modify：`scripts/worktree-lifecycle.mjs`
- Modify：`scripts/lib/shell-policy.mjs`
- Modify：`pi/AGENTS_APPEND.md`
- Modify：`skill-overrides/subagent-dispatch/SKILL.md`
- Modify：`skill-overrides/using-goal-engine/SKILL.md`
- Modify：`test/doctor.test.mjs`
- Modify：`test/shell-policy.test.mjs`
- Modify：`test/worktree-lifecycle-inventory.integration.mjs`
- Modify：`test/worktree-lifecycle-managed.integration.mjs`
- Modify：`test/worktree-lifecycle-recovery.integration.mjs`
- Modify：`test/worktree-lifecycle-registry.integration.mjs`

**接口契约：**
- Consumes：T2 `administration.mjs` 的 `inventoryManagedWorkspaces`、`planManagedWorkspaceCleanup`、`applyManagedWorkspaceCleanup`。
- Produces：保留现有 `npm run worktree`、`npm run worktree:audit` CLI 行为；Doctor 只读报告 active、preserved、cleanup-debt、orphan registration 和 identity mismatch。

**验收标准：** Doctor/CLI 不再 import `scripts/lib/worktree-lifecycle/*`；只支持 `audit/reconcile`；已退役 mutation 命令在资源访问前以 usage error 拒绝；dry-run 无副作用；apply 只接受 service 生成的 owner receipt 和显式授权；legacy workspace-local manifest 只报告为 untrusted legacy，不参与自动清理。

- [x] **步骤 1：编写管理入口 RED**

将测试 import 指向 unified administration API，覆盖空 inventory、active/preserved/debt、未知 manifest、Git registration orphan、dry-run 和 owner-CAS apply。

- [x] **步骤 2：运行管理测试确认 RED**

运行：`node --test test/doctor.test.mjs test/worktree-lifecycle-inventory.integration.mjs test/worktree-lifecycle-managed.integration.mjs test/worktree-lifecycle-recovery.integration.mjs test/worktree-lifecycle-registry.integration.mjs`

预期：FAIL，错误指向旧 facade import、缺失 administration API 或仍可调用的退役 mutation 命令。严格过程记录：旧基线已证明 mutation CLI 可用，但统一六命令拒绝测试未在删除 production 分支前单独运行，存在一次 TDD 顺序缺口。

- [x] **步骤 3：切换 Doctor 与 CLI**

根级 CLI 作为唯一人工入口保留，但直接引用 package `src/workspace/administration.mjs`；Doctor 使用相同 inventory，不再自行推断旧 lease 的资源所有权。

- [x] **步骤 4：固定 legacy fail-closed 行为**

存在 `.state/subagent-dispatch` 或 `.state/worktree-lifecycle` 时只输出 legacy/untrusted 诊断；没有 unified receipt 时禁止 destructive apply，且不得读取其中 owner token 作为授权。

- [x] **步骤 5：运行本任务回归确认 GREEN**

运行：`node --test test/doctor.test.mjs test/worktree-lifecycle-inventory.integration.mjs test/worktree-lifecycle-managed.integration.mjs test/worktree-lifecycle-recovery.integration.mjs test/worktree-lifecycle-registry.integration.mjs`

预期：PASS；CLI JSON schema 保持稳定，敏感 owner token 不出现在 stdout/stderr。

### Task 6：让 Goal settle、disposition 与 validation 使用统一 service

> **2026-09-03 用户调整：** Goal Engine 仍在构建且本机不启用；本任务验收缩减为当前 `managed-workspace.v1` 路径的最小接口迁移、`node --check`、静态 import closure 和旧顶层依赖扫描。无需运行或修复 Goal 行为测试，不执行真实 Goal。

**Deps：** `T4`（理由：消费 Goal request/allocated projection 与 receipt identity）；`T2`（理由：消费 status/dispose/release API）

**WritePaths：**
- `scripts/lib/goal-engine/extension.mjs`
- `scripts/lib/goal-engine/managed-validation.mjs`
- `scripts/lib/goal-engine/production-runtime-host.mjs`
- `scripts/lib/goal-engine/finalization.mjs`
- `test/goal-engine-workspace.integration.mjs`
- `test/goal-engine-extension.integration.mjs`
- `test/goal-engine-managed-validation.integration.mjs`
- `test/goal-engine-managed-validation-owned-stop.integration.mjs`
- `test/goal-engine-production-runtime-host.integration.mjs`
- `test/goal-engine-finalization-hardening.integration.mjs`

**Resources：** 临时 Git 仓库和受控 child process fixture；同一测试文件中的 process-capacity case 串行运行。

**Files：**
- Modify：`scripts/lib/goal-engine/extension.mjs:1920-2120,2530-3120`
- Modify：`scripts/lib/goal-engine/managed-validation.mjs`
- Modify：`scripts/lib/goal-engine/production-runtime-host.mjs`
- Modify：`scripts/lib/goal-engine/finalization.mjs`
- Modify：`test/goal-engine-workspace.integration.mjs`
- Modify：`test/goal-engine-extension.integration.mjs`
- Modify：`test/goal-engine-managed-validation.integration.mjs`
- Modify：`test/goal-engine-managed-validation-owned-stop.integration.mjs`
- Modify：`test/goal-engine-production-runtime-host.integration.mjs`
- Modify：`test/goal-engine-finalization-hardening.integration.mjs`

**接口契约：**
- Consumes：projection 中的 public workspace receipt；service `status/issueDisposition/dispose/release`；Root Broker executor proof。
- Produces：Goal disposition intent/applied/disposed 事件引用 `workspaceId/leaseId/serviceReceiptHash`；validation 使用 `goal-validation` owner 的同一 workspace record。

**验收标准：** `goal_settle`、`goal_integrate`、suspension closure 和 validation 不再调用 Goal 私有 Git workspace 函数；Goal 事件先记录 disposition intent，service 完成后再记录 receipt；retry 从 service receipt 恢复，不根据 projection 猜测物理资源已删除。

- [x] **步骤 1：按用户调整取消 Goal disposition 行为 RED**

原计划要求用 fake service 覆盖完整 disposition 行为；用户明确 Goal Engine 只需静态编译后，本步骤不再执行。

- [x] **步骤 2：按用户调整取消 Goal disposition 行为测试**

不运行 Goal 行为测试；以 production 源码 `node --check`、静态 import closure 和旧顶层 import 扫描代替。

- [x] **步骤 3：替换 settle 与 disposition 编排**

settle 从 service status 获取稳定 snapshot；Goal 只校验 task/attempt/contract/run/receipt 对应关系。integrate/discard/preserve 使用 service action token，先 append intent，再调用 service，最后 append receipt event；durable-then-throw 通过 receipt hash 幂等确认。

- [x] **步骤 4：迁移 suspension 与 orphan recovery**

suspension closure 从 service 获取 workspace closure receipt；旧 Goal projection 的 workspace 仅进入显式 legacy/manual recovery，不将缺失 unified receipt 推断为已释放或可接管。

- [x] **步骤 5：隔离 legacy managed validation 并保持静态可加载**

validation request 使用 `owner.kind="goal-validation"`，复用同一 allocation、run binding、terminal proof、preserve/release 和 cleanup-debt 状态；validation plan/resource claims 留在 Goal 领域，workspace service 只持有 opaque owner metadata 与 Git 资源事实。

- [x] **步骤 6：按用户调整暂不覆盖 Goal 恢复与并发行为**

这些 Goal 行为矩阵留待 Goal Engine 启用前完成，本次只保证当前 production 模块静态可加载。

- [x] **步骤 7：按用户调整运行静态编译与加载验收**

运行：`node --check scripts/lib/goal-engine/extension.mjs && node --check scripts/lib/goal-engine/managed-validation.mjs && node --check scripts/lib/goal-engine/production-runtime-host.mjs && node --check scripts/lib/goal-engine/finalization.mjs`

预期：PASS；四模块静态 import closure 通过；不启动真实 Goal、不写现有 Goal state。步骤 1、2、6 的行为 RED/恢复矩阵按用户调整不再属于本次验收，保持未勾选。

### Task 7：删除旧 workspace 层并收紧 package 发行闭包

**Deps：** `T3`（理由：subagent 已切到统一 service）；`T5`（理由：Doctor/CLI 已切换）；`T6`（理由：Goal 与 validation 已切换）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workspace.mjs`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workspace-controller.mjs`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workspace-ledger.mjs`
- `packages/pi-subagents-enhanced/src/goal-support/workspace.mjs`
- `packages/pi-subagents-enhanced/src/worktree-lifecycle/`
- `scripts/lib/goal-engine/workspace.mjs`
- `scripts/lib/goal-engine/dispatch-ir.mjs`
- `scripts/lib/worktree-lifecycle/`
- `packages/pi-subagents-enhanced/package.json`
- `packages/pi-subagents-enhanced/scripts/verify-package.mjs`
- `packages/pi-subagents-enhanced/README.md`
- `packages/pi-subagents-enhanced/AGENTS.md`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `test/pi-subagents-enhanced-package.test.mjs`
- `test/subagent-dispatch-workspace.integration.mjs`
- `test/subagent-workspace-controller.integration.mjs`
- `test/subagent-workspace-ledger.integration.mjs`
- `test/subagent-managed-worktree-facade.test.mjs`
- `test/worktree-lifecycle-inventory.integration.mjs`
- `test/worktree-lifecycle-managed.integration.mjs`
- `test/worktree-lifecycle-recovery.integration.mjs`
- `test/worktree-lifecycle-registry.integration.mjs`
- `package.json`

**Resources：** `none`

**Files：**
- Delete：`packages/pi-subagents-enhanced/src/subagent-dispatch/workspace.mjs`
- Delete：`packages/pi-subagents-enhanced/src/subagent-dispatch/workspace-controller.mjs`
- Delete：`packages/pi-subagents-enhanced/src/subagent-dispatch/workspace-ledger.mjs`
- Delete：`packages/pi-subagents-enhanced/src/goal-support/workspace.mjs`
- Delete：`packages/pi-subagents-enhanced/src/worktree-lifecycle/inventory.mjs`
- Delete：`packages/pi-subagents-enhanced/src/worktree-lifecycle/managed-worktree.mjs`
- Delete：`packages/pi-subagents-enhanced/src/worktree-lifecycle/registry.mjs`
- Delete：`scripts/lib/goal-engine/workspace.mjs`
- Delete：`scripts/lib/goal-engine/dispatch-ir.mjs`
- Delete：`scripts/lib/worktree-lifecycle/inventory.mjs`
- Delete：`scripts/lib/worktree-lifecycle/managed-worktree.mjs`
- Delete：`scripts/lib/worktree-lifecycle/registry.mjs`
- Delete：`test/subagent-dispatch-workspace.integration.mjs`
- Delete：`test/subagent-workspace-controller.integration.mjs`
- Delete：`test/subagent-workspace-ledger.integration.mjs`
- Delete：`test/subagent-managed-worktree-facade.test.mjs`
- Delete：`test/worktree-lifecycle-inventory.integration.mjs`
- Delete：`test/worktree-lifecycle-managed.integration.mjs`
- Delete：`test/worktree-lifecycle-recovery.integration.mjs`
- Delete：`test/worktree-lifecycle-registry.integration.mjs`
- Modify：`package.json`
- Modify：`packages/pi-subagents-enhanced/package.json`
- Modify：`packages/pi-subagents-enhanced/scripts/verify-package.mjs`
- Modify：`packages/pi-subagents-enhanced/README.md`
- Modify：`packages/pi-subagents-enhanced/AGENTS.md`
- Modify：`skill-overrides/subagent-dispatch/SKILL.md`
- Modify：`test/pi-subagents-enhanced-package.test.mjs`

**接口契约：**
- Consumes：T2–T6 已迁移完成的调用图与测试覆盖。
- Produces：package exports `./dispatch-ir`、`./workspace`、`./workspace/admin`；发行 tarball 只包含 canonical codec、统一 workspace 子系统、typed runtime、broker、child extensions 与 TUI。

**验收标准：** 仓库中不存在旧 workspace implementation 或一行 re-export facade；所有 workspace 相关生产 import 指向 `packages/pi-subagents-enhanced/src/workspace/`；npm dry-run tarball 包含完整 service，且不包含仓库私有 runtime data。

- [x] **步骤 1：增加 package closure RED**

更新 package 测试和 verifier，要求 tarball 包含 `src/contracts/dispatch-ir.mjs`、`src/workspace/contract.mjs`、`ledger.mjs`、`git-worktree.mjs`、`service.mjs`、`registry.ts`、`administration.mjs`，并拒绝旧目录路径。

- [x] **步骤 2：运行 package 测试确认 RED**

运行：`node --test test/pi-subagents-enhanced-package.test.mjs`

预期：FAIL，报告 required tarball paths 与旧路径清单不一致。

- [x] **步骤 3：更新 package exports、verifier、README 与 package 约束**

README 描述一套 workspace owner/service；AGENTS 增加“任何 subagent/Goal workspace 不得在 `src/workspace/` 外直接执行 Git worktree mutation”的硬边界；Skill 保留用户可见的 `worktree:true`、status 和 disposition 用法，不暴露 Goal 内部 ticket。

- [x] **步骤 4：删除旧实现、facade 与被替代测试**

删除清单中的文件；其行为覆盖必须已经迁入 `managed-workspace-*`、Goal 和 administration 测试。不得保留转发文件维持不存在的内部 API。

- [x] **步骤 5：扫描残留 import 与 legacy 消费**

运行：

```bash
rg -n 'subagent-dispatch/workspace|goal-support/workspace|scripts/lib/worktree-lifecycle|src/worktree-lifecycle|scripts/lib/goal-engine/dispatch-ir' packages scripts pi test
rg -n 'readFile.*\.pi-subagents|readFile.*\.state/subagent-dispatch|readFile.*\.state/worktree-lifecycle' packages scripts pi
```

预期：两条命令都无生产命中；测试仅可出现 hostile legacy fixture 的字面路径。

- [x] **步骤 6：运行 package 验证确认 GREEN**

运行：`npm run test:subagents-enhanced && npm run verify:subagents-enhanced`

预期：PASS，dry-run tarball 无 `.state/`、session、log、auth、settings 或本机配置。

### Task 8：完整回归与最终架构验收

> **2026-09-03 用户调整：** Goal Engine 只执行 production 源码 `node --check` 与静态 import closure；不要求 Goal 行为测试或 `npm test` 中的 Goal 测试通过。最终全量回归改为完整非 Goal 测试集合。

**Deps：** `T7`（理由：必须验证删除旧层后的最终代码与发行闭包）

**WritePaths：** `none`

**Resources：** Pi offline integration；不得使用网络 provider，不启动真实 Goal，不修改现有 session/Goal/worktree。

**Files：**
- Test：`test/**/*.test.mjs`
- Test：`test/pi-runtime.integration.mjs`
- Test：`packages/pi-subagents-enhanced/scripts/verify-package.mjs`

**接口契约：**
- Consumes：T1–T7 的最终代码和测试。
- Produces：一份通过命令输出、静态调用图和 Git 状态证明的最终验收结果。

**验收标准：** 全量测试、Doctor、Pi offline integration、package verifier 与 diff hygiene 全部通过；静态调用图只有一个 workspace service；目标仓库遗留 runtime 树不影响新分配；工作树中没有测试遗留 worktree 或临时 branch。

- [x] **步骤 1：运行 workspace 与 subagent 聚焦回归**

运行：

```bash
node --test test/managed-workspace-contract.test.mjs test/managed-workspace-ledger.integration.mjs test/managed-workspace-service.integration.mjs
node --test test/subagent-*.test.mjs test/subagent-*.integration.mjs
```

预期：PASS。

- [x] **步骤 2：按用户调整运行 Goal production 静态验收**

运行：对 `dispatch.mjs`、`executor-binding.mjs`、`events.mjs`、`extension.mjs`、`managed-validation.mjs`、`production-runtime-host.mjs`、`finalization.mjs` 执行 `node --check` 和顺序静态 import。

预期：PASS；不运行 Goal 行为测试，不访问现有 Goal state。

- [x] **步骤 3：运行 package 与 Host 验证**

运行：

```bash
npm run test:subagents-enhanced
npm run verify:subagents-enhanced
npm run doctor
npm run test:integration
```

预期：PASS；Pi integration 使用 offline/no-session，不发送模型请求。

- [x] **步骤 4：运行默认非 Goal 全量测试与 diff 检查**

运行：

```bash
npm test
git diff --check
```

预期：PASS，且 `pi/settings.json.enabledModels` 与 `pi/models.json` 没有本计划产生的 diff。

- [x] **步骤 5：验证唯一 workspace 调用图**

运行：

```bash
rg -n 'git.*worktree|worktree.*add|worktree.*remove' packages/pi-subagents-enhanced/src scripts/lib/goal-engine scripts/doctor.mjs scripts/worktree-lifecycle.mjs
rg -n 'createManagedWorkspaceService|ensureAllocated|issueDisposition|serviceReceiptHash' packages scripts pi test
```

预期：Git worktree mutation 只存在于 `src/workspace/git-worktree.mjs`；Goal 只出现 service 调用和 receipt/event 编排。

- [x] **步骤 6：验证无测试资源遗留**

对测试开始前后的 `git worktree list --porcelain` 和 `refs/heads/pi-managed/*` 做快照比较。

预期：完全一致；`var/workspaces` 中没有测试 fixture，现有 `var/goals` 和用户工作树未改变。
