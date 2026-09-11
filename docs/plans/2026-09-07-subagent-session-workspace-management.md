# Subagent 当前 Session Workspace 管理实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 新增独立的 `subagent_worktree` 管理工具；它只能列出、检查和处置当前 Pi session 通过 `subagent(...worktree:true)` 创建的 standalone worktree，并在对应 subagent 终止时向主 agent 发出可执行的合入/回收提醒。

**架构：** 保留 `packages/pi-subagents-enhanced/src/workspace/` 作为唯一 workspace ledger、Git mutation 和 disposition 状态机，在 service 方法内部增加不可绕过的 owner scope CAS 校验与按当前 session 查询能力。`subagent` 工具只负责派发，原有 workspace action 从其联合 schema 和执行分支移除；新的 `subagent_worktree` 工具在每次调用时由 live `ExtensionContext.sessionManager` 解析 `rootSessionId`，仅传入 `{kind:"standalone-subagent", rootSessionId}` scope。完成通知监听 authoritative `subagent:async-complete`，按 terminal `runId` 查询同 session 的 standalone receipt，并向主 agent注入独立、原始、可持久化的管理提醒；TUI renderer 仅生成紧凑显示，不改写消息、event 或 details。

**技术栈：** Node.js `>=22.19.0`、原生 TypeScript type stripping、`node:test`、Pi ExtensionAPI、`pi-subagents@0.62.0`、统一 managed workspace service、Root Broker terminal proof。

## 全局约束

- 管理工具只能处置当前 session 派生、通过 `subagent` tool 的 `worktree:true` 创建且 owner 为 `standalone-subagent` 的 workspace。
- `goal-task`、`goal-validation`、其他 session 的 standalone workspace、未知 workspace 和 legacy/unmanaged worktree 均必须 fail closed，且在任何 Git、challenge 或 ledger mutation 前拒绝。
- 主 agent 继续禁止使用 raw `git worktree add/remove/prune/move/repair/lock/unlock`；所有回收、合入、保留和 release 只能经过 typed workspace service。
- 所有 subagent worktree 继续共用 `packages/pi-subagents-enhanced/src/workspace/` 中的唯一 service、ledger 和 Git lifecycle；不得建立第二套 ledger、owner token 或 disposition 状态机。
- 只有 Root Broker 的 official terminal proof 和稳定 workspace inspection 才能签发一次性 action token；completion/status 文案不能替代 terminal proof。
- `integrate` 仅用于满足 `writePaths`、clean、descendant、origin clean 等既有门禁的 coding workspace；generic workspace 不得 integrate。
- `preserve` 保留现场；`release` 只释放同 session 已 preserved 的 standalone workspace；不得用 release 绕过 active workspace 的 terminal proof。
- session 身份只由 Host 的 `resolveRootSessionId(ctx.sessionManager)` 提供；不得信任模型参数、workspace ID、title、agent profile、event 文案或路径推断所有权。
- 完成提醒必须进入主 agent 的原始消息上下文，并包含 `workspace_id` 与下一步 typed tool 操作；TUI 精简只能发生在 renderer，不能改写实际消息、tool result、event payload、session 内容或结构化 details。
- `pi-subagents` 版本固定为 `0.62.0`；所有 upstream 深层 import 继续只允许出现在 `src/compat/pi-subagents-0.62.ts`。
- production/CLI 新实现使用 `.ts`；Node type stripping 不替代 `tsc --noEmit`。
- 测试使用独立临时 Git 仓库和 state root，不访问或回收现有 `var/workspaces`、Goal workspace、session 文件或用户 worktree。
- 先创建中文问题记录，写明 production 数据来源、首个偏离点和完整调用链，再观察精确 RED；不得为测试手工制造的不可达 owner/state 增加 production fallback。
- 不修改 `pi/settings.json.enabledModels`、`pi/models.json` 或 Goal Engine 开关。
- 不创建 Git commit；提交需要用户另行明确授权。

## 目标文件结构

```text
packages/pi-subagents-enhanced/src/workspace/
  service.ts                 # owner scope 校验、当前 session owned-list/status/disposition
  tool.ts                    # 独立 subagent_worktree schema、tool 执行和原始结果
packages/pi-subagents-enhanced/src/subagent-dispatch/
  extension.ts               # subagent 仅派发；注册独立 workspace tool 和 completion hook
packages/pi-subagents-enhanced/extensions/
  subagent-runtime.ts        # live session identity、提醒消息与 renderer 的 Host 绑定
packages/pi-subagents-enhanced/src/tui/
  compact-rendering.ts       # workspace tool/result 与 reminder 的纯显示 renderer
```

## 已核实的问题来源与边界

当前合法 production 调用链有两个首个偏离点：

```text
处置入口：
Host subagent({action:"workspace_status"|"workspace_disposition", workspace_id})
  -> createTypedSubagentExtension.execute
  -> requireWorkspaceService(pi, ..., currentRootSessionId)
  -> executeWorkspaceAction(input, service)
  -> service.status/issueDisposition/dispose/release({workspaceId})
  -> ledger.load(workspaceId)
```

`requireWorkspaceService` 只用当前 session 选择 service 实例，但 service 共用全局 `PI_CODING_WORKSPACE_DIR`，而 `ledger.load(workspaceId)` 会跨 repository scope 定位记录；调用链没有比较 receipt 的 `owner.rootSessionId`，也没有拒绝 `goal-task/goal-validation`。因此，只要 workspace ID 可见，现有 public action 入口就可能触达非当前 session 记录。首个偏离点是 facade 到 service 的 disposition 合同没有携带 owner scope；最终修复必须在 service 读取记录后、inspection/challenge/Git mutation 前原子校验，不能只在 TUI、tool description 或调用前做提示性检查。

```text
完成通知入口：
upstream official subagent:async-complete
  -> RootBrokerServer.observeTerminal
  -> project completionNotifierFactory/registerSubagentNotify
  -> pi.sendMessage(customType="subagent-notify")
  -> 主 agent 新 turn / TUI renderer
```

spawn 时 workspace 已由 `service.bindRun({workspaceId, run})` 持久化，但 completion 链没有按 `event.runId` 反查当前 session 的 standalone receipt，也没有生成 typed disposition 提醒。首个偏离点是 completion event 与 workspace binding 之间缺少只读关联 adapter。该现象和 owner scope 缺失均由合法 public Host/tool/event 路径可达，按“预期 production 数据未被正确处理”记录；不放宽 terminal proof 或 record codec。

## DAG

```text
T1（owner-scoped service 契约）
  └──> T2（独立 subagent_worktree 工具）
         └──> T3（terminal completion 回收提醒与 TUI）
                └──> T4（文档、发行闭包与完整回归）
```

依赖边说明：

- `T1 -> T2`：工具必须消费 service 内部强制执行的 `WorkspaceOwnerScope`，不能自行先读后验造成 TOCTOU 或留下旧绕过入口。
- `T2 -> T3`：completion reminder 必须引用 T2 已稳定的 tool 名、action schema 和公开结果字段。
- `T3 -> T4`：Skill、README 和最终验收必须描述最终 reminder 与独立 tool 的真实行为。

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3
- Wave 4：T4

**关键路径：** T1 → T2 → T3 → T4。所有任务修改相邻运行时或测试调用面，不制造伪并行。

---

### Task 1：在统一 service 内建立当前 Session owner scope 门禁

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-07-subagent-workspace-session-owner-and-completion-reminder.md`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/registry.ts`
- `test/managed-workspace-service.integration.mjs`

**Resources：** 临时 Git 仓库与独立 `PI_CODING_WORKSPACE_DIR` fixture；每个测试独占 state root。

**Files：**
- Create：`docs/bugs/2026-09-07-subagent-workspace-session-owner-and-completion-reminder.md`
- Modify：`packages/pi-subagents-enhanced/src/workspace/service.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/registry.ts`
- Modify：`test/managed-workspace-service.integration.mjs`

**接口契约：**
- Consumes：现有严格 `ManagedWorkspaceReceipt.owner` 判别联合、ledger `load/list/mutate`、Root Broker terminal proof、Git inspection/disposition。
- Produces：

```ts
type WorkspaceOwnerScope = Readonly<{
  kind: "standalone-subagent";
  rootSessionId: string;
}>;

type ScopedWorkspaceIdentity = {
  workspaceId: string;
  ownerScope: WorkspaceOwnerScope;
};

service.listOwned({ ownerScope, runId? }): ManagedWorkspaceReceipt[];
service.status({ workspaceId, ownerScope, terminalProof? }): WorkspaceStatus;
service.issueDisposition({ workspaceId, ownerScope, terminalProof? }): WorkspaceChallenge;
service.dispose({ workspaceId, ownerScope, disposition, strategy?, reason?, actionToken, terminalProof? }): ManagedWorkspaceReceipt;
service.release({ workspaceId, ownerScope }): ManagedWorkspaceReceipt;
```

Goal 内部现有可信调用若仍需要无 scope 的 service API，可以保留为 package-internal overload；面向 standalone 工具的每个调用必须使用 scoped 入口。更优先的最小实现是把 `ownerScope` 设为上述 public 方法必填，并同步所有 Goal 调用显式传入精确 Goal owner；不得用 optional scope 让新工具安全性依赖调用方自律。

**验收标准：** service 在 inspection、challenge 签发、pending intent 和 Git mutation之前校验 owner kind 与 `rootSessionId`；list 只返回当前 session 的 standalone receipt；外 session、Goal owner、validation owner 和未知 ID 均无资源副作用地拒绝；合法当前 session 的 active/preserved 流程保持原行为。

- [ ] **步骤 1：创建中文问题记录并固定 provenance**

记录本计划“已核实的问题来源与边界”中的两条 production 调用链，明确 owner scope 缺失发生在 facade→service 合同，提醒缺失发生在 completion event→bound receipt adapter；注明 workspace ID、title 和 profile 都不是授权，Goal owner 不能被 standalone 管理工具接管。

- [ ] **步骤 2：编写 owner scope RED**

在两个 session 和一个 Goal owner 共用同一 state root 的 fixture 中分配三条记录：

```js
const own = { kind: "standalone-subagent", rootSessionId: "session-a" };
assert.deepEqual(
  service.listOwned({ ownerScope: own }).map(({ workspaceId }) => workspaceId),
  ["workspace-a"],
);
assert.throws(
  () => service.issueDisposition({ workspaceId: "workspace-b", ownerScope: own, terminalProof }),
  { code: "MANAGED_WORKSPACE_OWNER_SCOPE" },
);
assert.throws(
  () => service.release({ workspaceId: "goal-workspace", ownerScope: own }),
  { code: "MANAGED_WORKSPACE_OWNER_SCOPE" },
);
```

同时快照 foreign/Goal record revision、actionChallenge、pendingAction、Git registration 和 origin HEAD，断言拒绝前后完全一致。

- [ ] **步骤 3：运行测试确认 RED**

运行：

```bash
node --test test/managed-workspace-service.integration.mjs --test-name-pattern='owner scope|listOwned'
```

预期：FAIL，原因是 `listOwned` 缺失或 status/disposition 尚未强制 owner scope；不能因 fixture 无效、terminal proof 缺失或 Git setup 错误而失败。

- [ ] **步骤 4：实现严格 scope codec 与 service 内门禁**

增加只接受 exact keys `{kind,rootSessionId}` 的 scope validator；`kind` 只接受 `standalone-subagent`。`listOwned` 从 ledger 的 validated records/receipts 过滤 `owner.kind/rootSessionId`，可选 `runId` 必须精确匹配 persisted `receipt.run.runId`。每个 scoped status/disposition/release 方法在读取记录后立即调用同一 `assertOwnerScope(record.request.owner, ownerScope)`；禁止根据路径、branch、toolCallId 或 run title 推断归属。

- [ ] **步骤 5：覆盖并发与状态边界**

测试 action token 由 session A 签发后，用 session B scope dispose 必须在 token 校验和 mutation 前拒绝；session A 仍能使用原 token。测试 released/cleanup-debt 可列出但没有 disposition，preserved 只能由同 session release；同 session 多 worktree 按 `workspaceId` 稳定排序。

- [ ] **步骤 6：运行聚焦回归确认 GREEN**

运行：

```bash
node --test test/managed-workspace-contract.test.mjs test/managed-workspace-ledger.integration.mjs test/managed-workspace-service.integration.mjs
npm run typecheck:subagents-enhanced
```

预期：PASS；现有 terminal proof、writePaths、integrate/discard/preserve/release 和 recovery 测试保持通过。

### Task 2：新增独立 `subagent_worktree` tool 并移除旧绕过入口

**Deps：** `T1`（理由：消费 service 强制执行的 `WorkspaceOwnerScope` 与 `listOwned`）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/subagent-workspace-tool.test.mjs`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-managed-worktree.integration.mjs`

**Resources：** fake Pi event bus/service；集成测试使用临时 Git 仓库与独立 state root。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/tool.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- Create：`test/subagent-workspace-tool.test.mjs`
- Modify：`test/subagent-dispatch-extension.test.ts`
- Modify：`test/subagent-runtime-membrane.test.mjs`
- Modify：`test/subagent-managed-worktree.integration.mjs`

**接口契约：**
- Consumes：T1 scoped service；Host `resolveRootSessionId(ctx.sessionManager)`；现有 `workspacePublic` 投影语义。
- Produces：独立工具 `subagent_worktree`：

```ts
{ action: "list" }
{ action: "status", workspace_id: string }
{ action: "dispose", workspace_id: string,
  disposition: "integrate" | "discard" | "preserve",
  strategy?: "cherry-pick" | "merge", action_token: string }
{ action: "release", workspace_id: string }
```

`list` 返回当前 session standalone receipts 的安全摘要；`status` 对 active workspace 执行 status + challenge 签发并返回 `action_token/allowed_dispositions/integrate_blocked_reasons`；`dispose` 和 `release` 复用统一 service。工具参数不接受 `rootSessionId`、owner kind、路径、lease token 或 terminal proof。

**验收标准：** Host 注册 `subagent`、`subagent_worktree`、可选 `subagent_supervisor`；`subagent` schema 不再接受任何 workspace action；新工具每次调用从 live context 解析 session；伪造 workspace ID 无法跨 session 或触达 Goal；合法 coding 能 integrate/discard/preserve，generic 不能 integrate，preserved 能 release。

- [ ] **步骤 1：编写独立工具 schema/注册 RED**

```js
assert.deepEqual(pi.tools.map(({ name }) => name), ["subagent", "subagent_worktree", "subagent_supervisor"]);
assert.equal(subagent.parameters.anyOf.some((branch) => branch.properties?.action?.const === "workspace_status"), false);
assert.deepEqual(workspaceTool.parameters.anyOf.map((branch) => branch.properties.action.const), ["list", "status", "dispose", "release"]);
```

验证 `rootSessionId` 不在 public schema 中；`strategy` 只允许用于 `dispose+integrate`，其他组合在 service 调用前拒绝。

- [ ] **步骤 2：运行工具测试确认 RED**

运行：

```bash
node --test test/subagent-workspace-tool.test.mjs test/subagent-runtime-membrane.test.mjs --test-name-pattern='subagent_worktree|workspace tool registration'
```

预期：FAIL，因为独立工具尚不存在，workspace actions 仍混在 `subagent` schema 中。

- [ ] **步骤 3：实现 feature-owned tool**

在 `src/workspace/tool.ts` 导出 schema、description 和 `createSubagentWorkspaceTool({service, resolveRootSessionId, renderCall?, renderResult?})`。`execute` 内从当前 `ctx.sessionManager` 计算：

```ts
const ownerScope = Object.freeze({
  kind: "standalone-subagent" as const,
  rootSessionId: resolveRootSessionId(ctx.sessionManager),
});
```

随后只调用 T1 scoped API；错误沿用结构化 `code/detail/keypath` 结果。`list` 不返回 `dispatch_cwd` 之外的私有 ledger 路径，不暴露 owner token；action token 只由 `status` 返回。

- [ ] **步骤 4：从 `subagent` 移除 workspace action**

删除 `WORKSPACE_STATUS_SCHEMA`、`WORKSPACE_DISPOSITION_SCHEMA`、`executeWorkspaceAction` 及主 execute 的 action 分支；`TYPED_SUBAGENT_DESCRIPTION` 改为只描述派发/control，并明确 worktree 终止后使用 `subagent_worktree`。不得保留兼容 facade，否则旧入口仍可绕过独立工具的 capability 边界。

- [ ] **步骤 5：绑定 live service 与 session identity**

`createTypedSubagentExtension` 接收 workspace tool factory/renderer，并与 `subagent` 同 generation 注册；service 可在 runtime startup 后解析，但每次 execute 必须使用 live session context，不能捕获 startup session ID。reload/new/resume/fork 后旧 ExtensionContext 不得处置新旧 session workspace。

- [ ] **步骤 6：编写真实 Git 正反集成测试**

把现有 `test/subagent-managed-worktree.integration.mjs` 的 status/disposition 调用迁到 `subagent_worktree`；新增同 state root 下 session B 与 Goal workspace，证明 `list/status/dispose/release` 都不能跨 owner。合法 session A coding commit 经 `status -> dispose(integrate)` 合入并回收；generic 经 `status -> dispose(preserve) -> release` 回收。

- [ ] **步骤 7：运行本任务回归确认 GREEN**

运行：

```bash
node --test test/subagent-workspace-tool.test.mjs test/subagent-dispatch-extension.test.ts test/subagent-runtime-membrane.test.mjs test/subagent-managed-worktree.integration.mjs
npm run typecheck:subagents-enhanced
```

预期：PASS；测试中所有临时 worktree 均由 service disposition/release 回收，无 raw lifecycle 命令泄漏到 production 调用方。

### Task 3：在 terminal completion 时向主 agent 注入 workspace 回收提醒

**Deps：** `T2`（理由：提醒必须引用已稳定的 `subagent_worktree` action 与结果字段）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/tui/compact-rendering.ts`
- `test/subagent-workspace-completion-reminder.test.mjs`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-compact-rendering.test.mjs`

**Resources：** fake completion event bus、fake Pi message sink、fake scoped service；不启动真实模型或 background runner。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Modify：`packages/pi-subagents-enhanced/src/tui/compact-rendering.ts`
- Create：`test/subagent-workspace-completion-reminder.test.mjs`
- Modify：`test/subagent-runtime-membrane.test.mjs`
- Modify：`test/subagent-compact-rendering.test.mjs`

**接口契约：**
- Consumes：official `subagent:async-complete` 的 `runId/sessionId/state`；T1 `service.listOwned({ownerScope,runId})`；T2 tool 名与 action schema；现有 generation-safe captured event subscriptions。
- Produces：`customType: "subagent-workspace-reminder"` 的原始消息：

```ts
{
  customType: "subagent-workspace-reminder",
  content: "Subagent workspace awaiting disposition: <workspace_id>. Call subagent_worktree({action:\"status\",workspace_id:\"...\"}), then integrate, discard, or preserve according to the returned allowed_dispositions. After preserve, use release when the workspace is no longer needed.",
  display: true,
  details: {
    schemaVersion: "subagent-workspace-reminder.v1",
    rootSessionId,
    runId,
    workspaceId,
    workspaceState,
    mode,
  },
}
```

消息必须通过 `deliverAs:"followUp"` 排入当前 completion turn，`triggerTurn:false`，由既有 completion notifier 负责唤醒主 agent；若既有 notifier 因 batching 尚未触发，reminder 必须先进入队列，不能自己制造第二个并发 turn。

**验收标准：** 每个 same-session standalone terminal run 最多生成一次 reminder；Goal/validation、foreign session、无 workspace、未 bind run、workflow wrapper completion 和重复 completion 不生成；active/preserved workspace 给出正确下一步；released workspace 不提醒；消息原文和 details 持久化进入主 agent context，TUI renderer 只显示紧凑摘要且不修改源对象。

- [ ] **步骤 1：编写 completion→workspace RED**

用合法 spawn/bind 形状构造 service receipt，再触发 official completion：

```js
events.emit("subagent:async-complete", {
  runId: "leaf-run",
  sessionId: "lifecycle-session",
  agent: "executor",
  state: "complete",
});
assert.equal(messages[0].customType, "subagent-workspace-reminder");
assert.match(messages[0].content, /subagent_worktree\(\{action:"status"/);
assert.equal(messages[0].details.workspaceId, "workspace-a");
```

测试 source event、receipt 和输出消息互不修改。

- [ ] **步骤 2：运行提醒测试确认 RED**

运行：

```bash
node --test test/subagent-workspace-completion-reminder.test.mjs test/subagent-runtime-membrane.test.mjs --test-name-pattern='workspace reminder|terminal completion'
```

预期：FAIL，因为现有 notifier 只发送 `subagent-notify`，没有 run→workspace adapter 或管理提示。

- [ ] **步骤 3：实现 generation-safe completion reminder adapter**

创建纯 adapter 校验 event 具有非空 `runId`，使用 runtime closure 中的当前 `rootSessionId` 构造 standalone scope，再调用 `listOwned({ownerScope,runId})`。只接受唯一匹配；0 条静默跳过，多条以结构化诊断 fail closed，不猜测。按 `(rootSessionId,runId,workspaceId,receipt.state)` 去重；去重状态绑定 extension generation，并在 `session_shutdown` 清理，durable ledger 仍是 reload 后恢复查询的权威。

- [ ] **步骤 4：保证事件顺序和 turn 语义**

通过 `installHeadlessTypedSubagentRuntime` 的 captured event subscription 在 completion notifier 订阅前注册 reminder listener，使 reminder 先 `sendMessage(...,{deliverAs:"followUp",triggerTurn:false})`，随后 upstream notifier 批处理/触发 turn。不得轮询 status、sleep 或从 completion 文案推断终态；Root Broker listener仍负责 official terminal proof。

- [ ] **步骤 5：覆盖排除和生命周期边界**

覆盖：workflow root event、Goal receipt、foreign root session、event `sessionId` 不匹配、active/preserved/released、重复 event、reload 后旧 listener 已取消、新 listener仅管理新 live session。foreign/Goal case 要断言没有 `listOwned` 越权结果、没有 challenge、没有 Git/ledger mutation。

- [ ] **步骤 6：增加纯 TUI renderer**

新增 `formatCompactSubagentWorkspaceReminder(message)`，默认显示 `↳ workspace <id> · awaiting disposition` 或 preserved/release 提示；renderer 从 `details` 读结构化字段，只生成独立显示文本。测试深拷贝前后消息相等，并确认原始 `content` 仍包含完整 typed tool 指令供主 agent 使用。

- [ ] **步骤 7：运行本任务回归确认 GREEN**

运行：

```bash
node --test test/subagent-workspace-completion-reminder.test.mjs test/subagent-runtime-membrane.test.mjs test/subagent-compact-rendering.test.mjs
npm run typecheck:subagents-enhanced
```

预期：PASS；一次 completion turn 同时包含正常任务完成通知和一条对应 workspace disposition 提醒，不出现额外自动轮询或第二次唤醒。

### Task 4：更新公开契约、Skill、发行闭包并执行完整回归

**Deps：** `T3`（理由：文档和最终验收必须基于真实 tool 与 reminder 行为）

**WritePaths：**
- `packages/pi-subagents-enhanced/README.md`
- `packages/pi-subagents-enhanced/AGENTS.md`
- `packages/pi-subagents-enhanced/scripts/verify-package.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `test/pi-subagents-enhanced-package.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`

**Resources：** Pi offline integration；不得发送模型请求，不启动真实 Goal，不处置当前机器已有 worktree。

**Files：**
- Modify：`packages/pi-subagents-enhanced/README.md`
- Modify：`packages/pi-subagents-enhanced/AGENTS.md`
- Modify：`packages/pi-subagents-enhanced/scripts/verify-package.ts`
- Modify：`skill-overrides/subagent-dispatch/SKILL.md`
- Modify：`test/pi-subagents-enhanced-package.test.mjs`
- Modify：`test/subagent-dispatch-skill.test.mjs`

**接口契约：**
- Consumes：T1–T3 的最终 service、tool schema、completion reminder 与 renderer。
- Produces：README/Skill 中唯一、准确的管理流程：spawn handle 保存 `workspace_id`；terminal reminder 后 `subagent_worktree status`；根据 `allowed_dispositions` 选择 integrate/discard/preserve；preserved 现场结束后 release；`list` 只显示当前 session standalone workspace。

**验收标准：** package tarball 包含新 workspace tool/reminder 模块；Skill 不再指导 `subagent({action:"workspace_status"|"workspace_disposition"})`；静态扫描不存在旧 action schema/执行入口；类型检查、workspace/subagent/package/默认测试和 offline Host 集成通过；现有 worktree inventory 前后不变。

- [ ] **步骤 1：编写契约与发行闭包 RED**

更新 package verifier/test，要求 tarball 包含：

```text
src/workspace/tool.ts
src/workspace/completion-reminder.ts
```

更新 Skill 行为测试，要求出现 `subagent_worktree` 的 list/status/dispose/release 流程，并拒绝旧 `subagent({action:"workspace_` 示例。

- [ ] **步骤 2：运行文档/package 测试确认 RED**

运行：

```bash
node --test test/pi-subagents-enhanced-package.test.mjs test/subagent-dispatch-skill.test.mjs
```

预期：FAIL，报告新模块或新工具文档缺失；测试只验证工具契约与操作流程，不镜像 README/Skill 的无关字面值。

- [ ] **步骤 3：更新 README、AGENTS 与 Skill**

README 解释 session owner scope、Goal 排除和 reminder；package AGENTS 增加“任何 agent-callable workspace 工具必须在 service 内校验当前 root session 与 owner kind”的边界；Skill 用以下调用顺序替换旧例：

```js
subagent_worktree({ action: "list" })
subagent_worktree({ action: "status", workspace_id: workspaceId })
subagent_worktree({ action: "dispose", workspace_id: workspaceId, disposition: "integrate", action_token: actionToken })
subagent_worktree({ action: "release", workspace_id: workspaceId })
```

明确 completion/status 不等于 terminal proof，必须信任 status 返回的 dispositions；禁止 raw Git worktree lifecycle。

- [ ] **步骤 4：执行静态残留扫描**

运行：

```bash
rg -n 'workspace_status|workspace_disposition' packages/pi-subagents-enhanced/src packages/pi-subagents-enhanced/extensions skill-overrides/subagent-dispatch test
rg -n 'subagent_worktree|WorkspaceOwnerScope|listOwned|subagent-workspace-reminder' packages/pi-subagents-enhanced skill-overrides/subagent-dispatch test
```

预期：第一条在 production/Skill 无旧 public action 命中（测试只可保留明确拒绝旧 ABI 的负例）；第二条覆盖 tool、service、runtime、renderer、Skill 和行为测试。Git worktree mutation 仍只位于 `src/workspace/git-worktree.ts`。

- [ ] **步骤 5：运行聚焦与静态验收**

运行：

```bash
npm run test:subagent-workspace
node --test test/subagent-workspace-tool.test.mjs test/subagent-workspace-completion-reminder.test.mjs test/subagent-runtime-membrane.test.mjs test/subagent-compact-rendering.test.mjs
npm run typecheck
npm run test:subagents-enhanced
npm run verify:subagents-enhanced
```

预期：全部 PASS，stdout/stderr 不包含 owner token、凭据或现有 workspace 私有路径。

- [ ] **步骤 6：运行默认与 Host 集成回归**

运行：

```bash
npm test
npm run test:integration
git diff --check
```

预期：全部 PASS；Host integration 使用 offline/no-session，不发模型请求。若 background runner 依赖仍缺失，先运行仓库公开的 `npm run setup:subagent-runtime` 进行受控依赖修复，再重跑；该安装属于长耗时操作，必须交由 subagent 执行，不由主 agent 阻塞等待。

- [ ] **步骤 7：核对无真实资源副作用**

通过只读统一 administration inventory 或只读 `git worktree list` 对测试前后做快照比较。

预期：现有用户/Goal/standalone worktree、branch registration 和 `var/workspaces` 记录完全不变；只有测试临时目录中的 workspace 被 scoped service 回收。不得调用 raw worktree cleanup 或猜测性清理。
